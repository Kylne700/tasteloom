// Fake model for demos and tests while the Workers AI binding is missing. It speaks the chat shape Workers AI returns
// (message.tool_calls[].function.arguments as a JSON string, usage with neurons, finish_reason) and scripts a plausible agent:
//   task "ideas":    qloo_search per favourite -> qloo_insights per gift type -> find_products for a diverse pick -> DONE
//   task "picks":    JSON-only: choose entities and shopping queries
//   task "reasons":  JSON-only: one grounded sentence per idea
//   task "checkout": create_order for the buyer's selection -> DONE
//   task "return":   get_order -> capture_order when APPROVED -> DONE
// The task is read from a [task:...] marker in the system prompt. This is demo data, not model output.
import { asObject, parseLooseJson } from '../lib/json.ts';
import { sleep } from '../lib/util.ts';

interface Msg {
  role: string;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: { id?: string; function?: { name?: string } }[];
}

/** Tool results of one tool, found the way real servers pair them: tool_call_id -> the assistant's tool_calls entry. */
function toolResults(msgs: Msg[], name: string): unknown[] {
  const names = new Map<string, string>();
  for (const m of msgs) for (const tc of m.tool_calls ?? []) if (tc.id && tc.function?.name) names.set(tc.id, tc.function.name);
  return msgs
    .filter((m) => m.role === 'tool' && names.get(m.tool_call_id ?? '') === name)
    .map((m) => parseLooseJson(m.content ?? ''))
    .filter((v) => v !== undefined);
}

const QUERY: Record<string, (n: string) => string> = {
  brand: (n) => n,
  book: (n) => `${n} book`,
  artist: (n) => `${n} vinyl`,
  movie: (n) => `${n} poster`,
  place: (n) => `${n} experience`,
  destination: (n) => `${n} experience`,
};

function diversePicks(cands: { id: string; name: string; type: string }[], n: number) {
  const order = ['brand', 'book', 'artist', 'place', 'destination'];
  const byType = new Map<string, typeof cands>();
  for (const c of cands) byType.set(c.type, [...(byType.get(c.type) ?? []), c]);
  const out: typeof cands = [];
  for (let round = 0; out.length < n && round < 4; round++) {
    for (const t of order) {
      const c = byType.get(t)?.[round];
      if (c && out.length < n && !out.some((x) => x.id === c.id)) out.push(c);
    }
  }
  return out;
}

function reply(model: string, message: Record<string, unknown>, finish: string, promptLen: number) {
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      model,
      choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', ...message } }],
      usage: { prompt_tokens: Math.ceil(promptLen / 4), completion_tokens: 60, total_tokens: Math.ceil(promptLen / 4) + 60, neurons: 0 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

// ids must be unique across turns (real servers use random ids); the turn number is the count of assistant messages so far
let turnNo = 0;
const call = (i: number, name: string, args: unknown) => ({ id: `call_${turnNo}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });

export function makeAiFake(opts: { delayMs?: number } = {}) {
  return async function aiFake(_url: string, init?: RequestInit): Promise<Response> {
    if (opts.delayMs) await sleep(opts.delayMs);
    const body = asObject(JSON.parse(String(init?.body ?? '{}'))) ?? {};
    const model = String(body.model ?? 'mock');
    const msgs = (Array.isArray(body.messages) ? body.messages : []) as Msg[];
    const sys = msgs.find((m) => m.role === 'system')?.content ?? '';
    const task = /\[task:(\w+)\]/.exec(sys)?.[1] ?? 'ideas';
    const user = asObject(parseLooseJson(msgs.filter((m) => m.role === 'user').at(-1)?.content ?? '')) ?? {};
    const len = JSON.stringify(msgs).length;
    turnNo = msgs.filter((m) => m.role === 'assistant').length + 1;

    if (task === 'picks') {
      const cands = (Array.isArray(user.candidates) ? user.candidates : []).map(asObject).filter(Boolean) as Record<string, string>[];
      const picks = diversePicks(cands as { id: string; name: string; type: string }[], 5).map((c) => ({ entity_id: c.id, query: (QUERY[c.type] ?? QUERY.brand!)(c.name) }));
      return reply(model, { content: JSON.stringify({ picks }) }, 'stop', len);
    }
    if (task === 'reasons') {
      const ideas = (Array.isArray(user.ideas) ? user.ideas : []).map(asObject).filter(Boolean) as Record<string, unknown>[];
      const reasons: Record<string, string> = {};
      ideas.forEach((i, n) => {
        const because = (Array.isArray(i.because) ? i.because : []).map(String);
        const name = String(i.entity);
        const [a, b] = because;
        const loved = b ? `${a} and ${b}` : a;
        const tag = (Array.isArray(i.in_common) ? i.in_common : []).map(String)[0]; // a word Qloo gives both, which the real server insists a reason uses
        const both = tag ? ` Both are about ${tag.toLowerCase()}.` : '';
        // first product title, cut at a separator so it reads like a name ("Kew Gardens Tickets 2026 | Book Now" -> "Kew Gardens Tickets 2026")
        const prod = (Array.isArray(i.products) ? i.products : []).map(String).map((t) => t.split(/\s[|\u2013-]\s/)[0]!.trim()).find((t) => t.length >= 3 && t.length <= 52);
        reasons[String(i.id)] = !a
          ? `${name} matches the overall taste in what they love.`
          : [
              `Since they love ${loved}, ${name} is a safe bet${prod ? `: ${prod} is a good place to start` : ''}.${both}`,
              `${name} sits close to ${loved} in taste${prod ? `, and ${prod} shows why` : ', so it should land well'}.${both}`,
              `A gift in the spirit of ${loved}: ${prod ?? name} feels chosen, not generic.${both}`,
              `Fans of ${loved} tend to like ${name}${prod ? `, and ${prod} makes an easy first pick` : ', so start with the first product'}.${both}`,
            ][n % 4]!;
      });
      return reply(model, { content: '<think>writing short reasons</think>\n```json\n' + JSON.stringify({ reasons }) + '\n```' }, 'stop', len);
    }
    if (task === 'checkout') {
      if (toolResults(msgs, 'create_order').length) return reply(model, { content: 'DONE' }, 'stop', len);
      return reply(model, { content: null, tool_calls: [call(1, 'create_order', { item_ids: user.selected_item_ids ?? [] })] }, 'tool_calls', len);
    }
    if (task === 'return') {
      const got = toolResults(msgs, 'get_order').at(-1) as Record<string, unknown> | undefined;
      const cap = toolResults(msgs, 'capture_order').at(-1);
      if (cap) return reply(model, { content: 'DONE' }, 'stop', len);
      if (!got) return reply(model, { content: null, tool_calls: [call(1, 'get_order', { order_id: user.order_id })] }, 'tool_calls', len);
      if (got.status === 'APPROVED') return reply(model, { content: null, tool_calls: [call(2, 'capture_order', { order_id: user.order_id })] }, 'tool_calls', len);
      return reply(model, { content: 'DONE' }, 'stop', len);
    }

    // task "ideas"
    const searches = toolResults(msgs, 'qloo_search');
    const insightsRes = toolResults(msgs, 'qloo_insights');
    const productRes = toolResults(msgs, 'find_products');
    if (!searches.length) {
      const favs = (Array.isArray(user.favorites) ? user.favorites : []).map(asObject).filter(Boolean) as Record<string, unknown>[];
      const calls = favs.slice(0, 5).map((f, i) => call(i + 1, 'qloo_search', f.type ? { query: f.text, type: f.type } : { query: f.text }));
      return reply(model, { content: '<think>Resolve each favourite to a Qloo entity first.</think>', tool_calls: calls }, 'tool_calls', len);
    }
    if (!insightsRes.length) {
      const ids = searches.map((s) => asObject(s)?.id).filter((x): x is string => typeof x === 'string');
      const types = ['brand', 'book', 'artist', 'place'];
      return reply(model, { content: null, tool_calls: types.map((t, i) => call(i + 1, 'qloo_insights', { seed_ids: ids, target_type: t })) }, 'tool_calls', len);
    }
    if (!productRes.length) {
      const cands = insightsRes.flatMap((r) => (Array.isArray(asObject(r)?.candidates) ? (asObject(r)!.candidates as Record<string, string>[]) : []));
      const picks = diversePicks(cands as { id: string; name: string; type: string }[], 5);
      const budget = Number(user.budget_usd) || 100;
      return reply(model, { content: null, tool_calls: picks.map((c, i) => call(i + 1, 'find_products', { query: (QUERY[c.type] ?? QUERY.brand!)(c.name), entity_id: c.id, max_price_usd: Math.max(10, Math.round(budget * 0.7)) })) }, 'tool_calls', len);
    }
    return reply(model, { content: 'DONE' }, 'stop', len);
  };
}
