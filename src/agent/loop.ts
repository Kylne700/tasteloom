// Generic tool-calling loop for the Workers AI model (OpenAI-style tools). One loop serves three jobs: gift ideas,
// checkout and the return from PayPal. The model only chooses which tool to call and with what arguments; every handler
// validates its arguments against server state, so a wrong or manipulated call can never invent an id, a price or a charge.
import { chat, type ChatMessage, type ToolSpec } from '../adapters/ai.ts';
import type { Svc } from '../lib/http.ts';

/** Thrown by a handler for a bad call; the message goes back to the model so it can correct itself. */
export class ToolError extends Error {}

/** A ToolError for a call that was not wrong but is not possible now (a duplicate, a limit, something not ready): told to the model, but not counted as one of its mistakes. */
export class Refusal extends ToolError {}

export interface Tool {
  spec: ToolSpec;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

export const toolSpec = (name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolSpec => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } },
});

export interface LoopOpts {
  model: string;
  /** must carry a [task:...] marker; the mock server scripts its behaviour from it */
  system: string;
  user: unknown;
  tools: Tool[];
  maxTurns: number;
  /** stop right after a turn that called one of these tools */
  stopAfter?: string[];
  timeoutMs?: number;
  /** called after every model turn (the UI shows these as agent steps) */
  onTurn?: (t: { turn: number; ms: number; calls: number; via: 'live' | 'mock' | 'cache' }) => void;
}

export interface LoopResult {
  turns: number;
  calls: number;
  bad: number;
  stopped: 'done' | 'stop_after' | 'max_turns' | 'bad_calls';
}

const clipResult = (v: unknown) => {
  const s = JSON.stringify(v ?? null);
  return s.length > 4000 ? s.slice(0, 4000) + '…' : s;
};

/** Tool calls run from one model turn; a turn asking for more gets only the first ones. */
const MAX_CALLS_PER_TURN = 8;

export async function runLoop(svc: Svc, o: LoopOpts): Promise<LoopResult> {
  const messages: ChatMessage[] = [
    { role: 'system', content: o.system },
    { role: 'user', content: JSON.stringify(o.user) },
  ];
  const byName = new Map(o.tools.map((t) => [t.spec.function.name, t]));
  const specs = o.tools.map((t) => t.spec);
  let calls = 0;
  let bad = 0;
  for (let turn = 1; turn <= o.maxTurns; turn++) {
    const t0 = Date.now();
    const r = await chat(svc, { model: o.model, messages, tools: specs, toolChoice: 'auto', maxTokens: 2000, timeoutMs: o.timeoutMs });
    o.onTurn?.({ turn, ms: Date.now() - t0, calls: r.calls.length, via: r.via });
    if (!r.calls.length) return { turns: turn, calls, bad, stopped: 'done' };
    const turnCalls = r.calls.slice(0, MAX_CALLS_PER_TURN); // the rest are dropped from the history too, so every call has its result
    messages.push({
      role: 'assistant',
      content: r.content || null,
      tool_calls: turnCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.raw || '{}' } })),
    });
    const results = await Promise.all(
      turnCalls.map(async (c) => {
        const tool = byName.get(c.name);
        if (!tool) {
          bad++;
          return { id: c.id, content: clipResult({ error: `unknown tool ${c.name}` }) };
        }
        if (!c.args) {
          bad++;
          return { id: c.id, content: clipResult({ error: 'arguments must be a JSON object' }) };
        }
        try {
          calls++;
          return { id: c.id, content: clipResult(await tool.run(c.args)) };
        } catch (e) {
          if (!(e instanceof ToolError)) throw e;
          if (!(e instanceof Refusal)) bad++;
          return { id: c.id, content: clipResult({ error: e.message }) };
        }
      }),
    );
    for (const x of results) messages.push({ role: 'tool', tool_call_id: x.id, content: x.content });
    if (bad >= 3) return { turns: turn, calls, bad, stopped: 'bad_calls' };
    if (o.stopAfter && turnCalls.some((c) => o.stopAfter!.includes(c.name))) return { turns: turn, calls, bad, stopped: 'stop_after' };
  }
  return { turns: o.maxTurns, calls, bad, stopped: 'max_turns' };
}
