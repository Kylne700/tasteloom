// Nebius Token Factory, OpenAI-compatible Chat Completions with tool calling, serving Nemotron models.
// Base URL https://api.tokenfactory.nebius.com/v1/ (docs: docs.tokenfactory.nebius.com). Request: POST /chat/completions with
// { model, messages, tools:[{type:'function',function:{name,description,parameters}}], tool_choice }. Response:
// choices[0].message = { content, tool_calls:[{ id, type:'function', function:{ name, arguments: '<JSON string>' } }] }.
// NOT VERIFIED without a key: whether Nemotron emits clean tool calls and whether it prefixes <think> blocks.
// `npm run contract:nebius` checks that once NEBIUS_API_KEY exists. While the key is missing src/mocks/nebius-fake.ts answers
// with the same shapes and the UI shows a "demo data" badge.
import { NEBIUS_BASE } from '../config.ts';
import { cached, callJson, HttpError, type Svc } from '../lib/http.ts';
import { asObject, parseLooseJson, stripThinking } from '../lib/json.ts';
import { sleep } from '../lib/util.ts';

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}
export interface ToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}
export interface ParsedCall {
  id: string;
  name: string;
  /** undefined when the model's arguments were not valid JSON */
  args: Record<string, unknown> | undefined;
  raw: string;
}
export interface ChatResult {
  content: string;
  calls: ParsedCall[];
  finish: string;
  usage?: { prompt: number; completion: number };
  via: 'live' | 'mock' | 'cache';
}

/** Some servers hand tool calls back as text (<tool_call>{...}</tool_call> or <TOOLCALL>[...]</TOOLCALL>); accept that too. */
function callsFromText(text: string): ParsedCall[] {
  const out: ParsedCall[] = [];
  for (const m of text.matchAll(/<(tool_call|TOOLCALL)>([\s\S]*?)<\/\1>/g)) {
    const v = parseLooseJson(m[2]!);
    for (const item of Array.isArray(v) ? v : [v]) {
      const o = asObject(item);
      const fn = asObject(o?.function) ?? o;
      const name = fn?.name;
      if (typeof name !== 'string') continue;
      const a = fn?.arguments ?? fn?.parameters;
      const args = typeof a === 'string' ? asObject(parseLooseJson(a)) : asObject(a);
      out.push({ id: `text_${out.length}`, name, args, raw: typeof a === 'string' ? a : JSON.stringify(a ?? {}) });
    }
  }
  return out;
}

export function parseChat(json: unknown, via: ChatResult['via'] = 'live'): ChatResult {
  const choice = asObject(Array.isArray(asObject(json)?.choices) ? (asObject(json)!.choices as unknown[])[0] : undefined);
  const msg = asObject(choice?.message);
  const rawContent = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? (msg!.content as unknown[]).map((p) => asObject(p)?.text ?? '').join('') : '';
  const calls: ParsedCall[] = [];
  for (const tc of Array.isArray(msg?.tool_calls) ? (msg!.tool_calls as unknown[]) : []) {
    const f = asObject(asObject(tc)?.function);
    if (typeof f?.name !== 'string') continue;
    const raw = typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments ?? {});
    calls.push({ id: String(asObject(tc)?.id ?? `call_${calls.length}`), name: f.name, args: asObject(parseLooseJson(raw)), raw });
  }
  const content = stripThinking(String(rawContent));
  if (!calls.length) calls.push(...callsFromText(String(rawContent)));
  const u = asObject(asObject(json)?.usage);
  return {
    content: content.replace(/<(tool_call|TOOLCALL)>[\s\S]*?<\/\1>/g, '').trim(),
    calls,
    finish: String(choice?.finish_reason ?? ''),
    usage: u ? { prompt: Number(u.prompt_tokens) || 0, completion: Number(u.completion_tokens) || 0 } : undefined,
    via,
  };
}

export interface ChatOpts {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/** One chat call; a single retry on 429/5xx/timeout. The per-IP and global Nebius counters are charged inside callJson. */
export async function chat(svc: Svc, o: ChatOpts): Promise<ChatResult> {
  const body: Record<string, unknown> = {
    model: o.model,
    messages: o.messages,
    temperature: o.temperature ?? 0.2,
    max_tokens: o.maxTokens ?? 1500,
  };
  if (o.tools?.length) {
    body.tools = o.tools;
    body.tool_choice = typeof o.toolChoice === 'object' ? { type: 'function', function: { name: o.toolChoice.name } } : (o.toolChoice ?? 'auto');
  }
  const run = async (): Promise<ChatResult> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await callJson(svc, 'nebius', `${NEBIUS_BASE}/chat/completions`, {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + (svc.cfg.keys.nebius ?? 'mock'), 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, o.timeoutMs ?? 60000);
        return parseChat(r.json, r.via);
      } catch (e) {
        lastErr = e;
        const retry = e instanceof HttpError && (e.status === 0 || e.status === 429 || e.status >= 500);
        if (!retry || attempt === 1) throw e;
        await sleep(700);
      }
    }
    throw lastErr;
  };
  // development cache only (identical prompts during UI work); never in production
  const { value, hit } = await cached(svc, 'nebius', body, 24 * 3600, run);
  return hit ? { ...value, via: 'cache' } : value;
}
