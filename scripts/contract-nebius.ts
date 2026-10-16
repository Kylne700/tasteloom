// Contract check for Nebius Token Factory: at most 5 live requests through the app's own chat adapter, to confirm the models
// exist and that tool calling and JSON-only answers parse. Prints structure only, never keys or model text.
// Exit code: 0 pass, 1 mismatch or error, 2 key missing (nothing was called).
import { chat } from '../src/adapters/nebius.ts';
import { toolSpec } from '../src/agent/loop.ts';
import { NEBIUS_BASE } from '../src/config.ts';
import { callJson, type Svc } from '../src/lib/http.ts';
import { asObject, parseLooseJson } from '../src/lib/json.ts';
import { loadEnvLocal } from './lib/env.mjs';
import { recordingFetch } from './lib/shape.mjs';
import { makeSvc } from './contract-qloo.ts';

export const MAX_CALLS = 5; // 1 model list + 3 chat requests, one spare for a retry

/** The checks, as [name, passed] pairs, plus notes and the error text if a call threw. */
export async function nebiusContract(svc: Svc): Promise<{ checks: [string, boolean][]; notes: string[]; failure: string }> {
  const checks: [string, boolean][] = [];
  const notes: string[] = [];
  let ids: string[] = [];
  try {
    const list = await callJson(svc, 'nebius', `${NEBIUS_BASE}/models`, { headers: { Authorization: 'Bearer ' + svc.cfg.keys.nebius } });
    ids = ((asObject(list.json)?.data as unknown[]) ?? []).map((m) => String(asObject(m)?.id ?? ''));
    checks.push(['the models list is an array of ids', ids.length > 0 && ids.every(Boolean)]);
    for (const [role, id] of Object.entries(svc.cfg.models)) checks.push([`model for "${role}" is listed (${id})`, ids.includes(id)]);
  } catch (e) {
    notes.push('could not list models (' + (e instanceof Error ? e.message : String(e)).slice(0, 120) + '); the chat requests below decide');
  }
  try {
    const tool = await chat(svc, {
      model: svc.cfg.models.agent,
      messages: [{ role: 'system', content: 'Call the echo tool exactly once with v set to the word ping.' }, { role: 'user', content: 'go' }],
      tools: [toolSpec('echo', 'Echo a word.', { v: { type: 'string' } }, ['v'])],
      toolChoice: 'auto',
      maxTokens: 200,
    });
    checks.push(['tool calling: one echo call with a string argument', tool.calls.length >= 1 && tool.calls[0]!.name === 'echo' && typeof tool.calls[0]!.args?.v === 'string']);
    const picks = await chat(svc, {
      model: svc.cfg.models.agent,
      messages: [{ role: 'system', content: 'Reply with JSON only, no prose: {"picks":[{"entity_id":"E1","query":"two words"}]}' }, { role: 'user', content: 'go' }],
      maxTokens: 200,
    });
    checks.push(['JSON-only answer parses into picks', Array.isArray(asObject(parseLooseJson(picks.content))?.picks)]);
    const reasons = await chat(svc, {
      model: svc.cfg.models.writer,
      messages: [{ role: 'system', content: 'Reply with JSON only, no prose: {"reasons":{"i1":"one short sentence"}}' }, { role: 'user', content: 'go' }],
      maxTokens: 200,
    });
    checks.push(['writer model answers JSON-only', !!asObject(asObject(parseLooseJson(reasons.content))?.reasons)]);
  } catch (e) {
    const nemo = ids.filter((i) => /nemotron/i.test(i)).slice(0, 10).join(', ');
    if (nemo) notes.push('Nemotron models the account lists: ' + nemo);
    return { checks, notes, failure: e instanceof Error ? e.message : String(e) };
  }
  return { checks, notes, failure: '' };
}

if (import.meta.main) {
  const env = loadEnvLocal(['NEBIUS_API_KEY']);
  if (!env.NEBIUS_API_KEY) {
    console.log('contract:nebius: KEY MISSING. NEBIUS_API_KEY is not set in tasteagent/.env.local, so no request was made.');
    console.log('The app runs on a documented-shape fake of the OpenAI-compatible API until the key appears; add the key and run this again.');
    process.exit(2);
  }
  const seen: string[] = [];
  const { checks, notes, failure } = await nebiusContract(await makeSvc({ NEBIUS_API_KEY: env.NEBIUS_API_KEY }, recordingFetch(seen, 2), MAX_CALLS));
  console.log(`contract:nebius: ${seen.length} request(s) of at most ${MAX_CALLS}`);
  for (const s of seen) console.log('  ' + s);
  for (const [name, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  for (const n of notes) console.log('  note  ' + n);
  if (failure) console.log('  ERROR  ' + failure.slice(0, 300));
  const pass = !failure && checks.length >= 6 && checks.every(([, ok]) => ok);
  console.log(`contract:nebius: ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
}
