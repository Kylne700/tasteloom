// The model: Cloudflare Workers AI through the Worker binding (wrangler.jsonc: "ai": { "binding": "AI" }), an open model with tool calling.
// Request: env.AI.run(model, { messages, tools:[{type:'function',function:{name,description,parameters}}], tool_choice, temperature, max_tokens }).
// Answer, seen live on 2026-10-22 for qwen3-30b-a3b-fp8, glm-4.7-flash and mistral-small-3.1-24b: the OpenAI chat shape,
// choices[0].message = { content, reasoning_content, tool_calls:[{ id, type:'function', function:{ name, arguments:'<JSON string>' } }] }, and
// usage = { prompt_tokens, completion_tokens, neurons } (the neurons this one call cost). Some older models answer { response, tool_calls:[{ name,
// arguments }] } instead; parseChat takes both. Reasoning models think inside max_tokens, so a small limit can leave nothing to read.
// Without a binding (unit tests, plain Node) src/mocks/ai-fake.ts answers with the same shape and the page shows "demo data".
import { cached, callJson, BudgetError, HttpError, type Svc } from '../lib/http.ts';
import { asObject, parseLooseJson, stripThinking } from '../lib/json.ts';
import { sleep } from '../lib/util.ts';
import type { AiBinding, FetchFn } from '../types.ts';

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
  usage?: { prompt: number; completion: number; neurons?: number };
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
  const root = asObject(json);
  const choice = asObject(Array.isArray(root?.choices) ? (root!.choices as unknown[])[0] : undefined);
  const msg = asObject(choice?.message) ?? { content: root?.response, tool_calls: root?.tool_calls }; // the older shape has no choices
  const rawContent = typeof msg?.content === 'string' ? msg.content : Array.isArray(msg?.content) ? (msg!.content as unknown[]).map((p) => asObject(p)?.text ?? '').join('') : '';
  const calls: ParsedCall[] = [];
  for (const tc of Array.isArray(msg?.tool_calls) ? (msg!.tool_calls as unknown[]) : []) {
    const f = asObject(asObject(tc)?.function) ?? asObject(tc);
    if (typeof f?.name !== 'string') continue;
    const raw = typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments ?? {});
    calls.push({ id: String(asObject(tc)?.id ?? `call_${calls.length}`), name: f.name, args: asObject(parseLooseJson(raw)), raw });
  }
  const content = stripThinking(String(rawContent));
  if (!calls.length) calls.push(...callsFromText(String(rawContent)));
  const u = asObject(root?.usage);
  const neurons = Number(u?.neurons);
  return {
    content: content.replace(/<(tool_call|TOOLCALL)>[\s\S]*?<\/\1>/g, '').trim(),
    calls,
    finish: String(choice?.finish_reason ?? ''),
    usage: u ? { prompt: Number(u.prompt_tokens) || 0, completion: Number(u.completion_tokens) || 0, ...(Number.isFinite(neurons) ? { neurons } : {}) } : undefined,
    via,
  };
}

/**
 * The AI binding as a fetch function, so a model call goes through callJson like every other service: counted, timed out, size-capped,
 * redacted. `run` throws instead of returning a status, so a refusal (daily free allocation used up, capacity, rate) becomes 429 and any
 * other failure 502.
 */
export function aiBindingFetch(ai: AiBinding): FetchFn {
  return async (_url, init) => {
    const { model, ...input } = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const gone = new Promise<never>((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason)));
    try {
      return Response.json(await Promise.race([ai.run(String(model), input), gone]));
    } catch (e) {
      if (init?.signal?.aborted) throw e; // our own timeout: callJson reports it as status 0
      const msg = e instanceof Error ? e.message : String(e);
      return Response.json({ error: msg.slice(0, 200) }, { status: /limit|quota|capacity|allocation|neurons|too many|rate/i.test(msg) ? 429 : 502 });
    }
  };
}

/**
 * Neurons per million tokens, [input, output], from developers.cloudflare.com/workers-ai/platform/pricing (read 2026-10-22). They only size the
 * reservation made before a call; the answer's own usage.neurons settles it. A model that is not listed is priced like the dearest one.
 */
const PRICE: Record<string, [number, number]> = {
  '@cf/qwen/qwen3-30b-a3b-fp8': [4625, 30475],
  '@cf/zai-org/glm-4.7-flash': [5500, 36400],
  '@cf/mistralai/mistral-small-3.1-24b-instruct': [31876, 50488],
};
const DEAREST: [number, number] = [45455, 290909];

export interface ChatOpts {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  toolChoice?: 'auto' | 'required' | { name: string };
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

/**
 * One chat call; a single retry on 429/5xx/timeout. Each attempt reserves one call and the neurons it could cost (the prompt at 3 characters
 * a token, JSON and English run near 4, plus the most the model may write); what the answer says it cost settles it, and a call that never
 * ran gives its reservation back.
 */
export async function chat(svc: Svc, o: ChatOpts): Promise<ChatResult> {
  const messages = o.messages.map((m) => (m.content === null ? { ...m, content: '' } : m)); // Workers AI rejects a null content (an assistant turn that only made tool calls)
  // Qwen3 writes hundreds of thinking tokens before every answer (about 8 s a call, and output tokens are most of its price); its /no_think switch skips that
  if (/qwen3/i.test(o.model) && messages[0]?.role === 'system') messages[0] = { ...messages[0], content: `${messages[0].content}\n/no_think` };
  const body: Record<string, unknown> = {
    model: o.model,
    messages,
    temperature: o.temperature ?? 0.2,
    max_tokens: o.maxTokens ?? 1500,
  };
  if (o.tools?.length) {
    body.tools = o.tools;
    body.tool_choice = typeof o.toolChoice === 'object' ? { type: 'function', function: { name: o.toolChoice.name } } : (o.toolChoice ?? 'auto');
  }
  const payload = JSON.stringify(body);
  const [pin, pout] = PRICE[o.model] ?? DEAREST;
  const neurons = Math.ceil(((payload.length / 3) * pin + Number(body.max_tokens) * pout) / 1e6);
  const metered = !svc.mocks.ai;
  const run = async (): Promise<ChatResult> => {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await callJson(svc, 'ai', 'workers-ai://chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload }, o.timeoutMs ?? 60000, { neurons });
        const res = parseChat(r.json, r.via);
        if (metered && res.usage?.neurons !== undefined) await svc.meter.give({ neurons: Math.max(0, neurons - Math.ceil(res.usage.neurons)) });
        return res;
      } catch (e) {
        lastErr = e;
        // the call never ran, or the service answered with an error: nothing was generated
        if (metered && (e instanceof BudgetError || (e instanceof HttpError && e.status >= 400))) await svc.meter.give({ neurons });
        const retry = e instanceof HttpError && (e.status === 0 || e.status === 429 || e.status >= 500);
        if (!retry || attempt === 1) throw e;
        await sleep(700);
      }
    }
    throw lastErr;
  };
  // development cache only (identical prompts during UI work); never in production
  const { value, hit } = await cached(svc, 'ai', body, 24 * 3600, run);
  return hit ? { ...value, via: 'cache' } : value;
}
