// Tavily: runtime web search. Used for experience gift ideas (places and destinations) and for an informational price check of a
// product on its shop page. It never creates purchasable cards: only structured catalog prices can be bought.
// Request shape from the 2026-10-16 spike: POST /search { query, search_depth:'fast', include_domains, max_results, include_raw_content:'markdown' }.
import { TAVILY_BASE } from '../config.ts';
import { cached, callJson, type Svc } from '../lib/http.ts';
import { asObject } from '../lib/json.ts';
import { clip, fnv, hostOf, httpsUrl, nameTokens } from '../lib/util.ts';
import type { Card } from '../types.ts';

export interface WebResult {
  title: string;
  url: string;
  content: string;
  raw?: string;
}

/** "# Gift tickets\n\nTreat someone" must not collapse into "Gift tickets Treat someone": a heading becomes a short sentence. */
const headingsAsSentences = (s: string) => s.replace(/^#+[ \t]*(.+?)[ \t]*$/gm, '$1. ');

export function parseTavily(json: unknown): WebResult[] {
  const results = asObject(json)?.results;
  if (!Array.isArray(results)) return [];
  const out: WebResult[] = [];
  for (const r of results) {
    const o = asObject(r);
    const url = httpsUrl(o?.url);
    if (!o || !url || typeof o.title !== 'string') continue;
    out.push({
      title: clip(o.title, 140),
      url,
      content: clip(typeof o.content === 'string' ? headingsAsSentences(o.content) : '', 300),
      raw: typeof o.raw_content === 'string' ? o.raw_content.slice(0, 6000) : undefined,
    });
  }
  return out;
}

export async function searchWeb(svc: Svc, q: { query: string; domains?: string[]; max?: number; raw?: boolean }): Promise<{ results: WebResult[]; hit: boolean }> {
  if (svc.cfg.tavily !== 'live' || !svc.cfg.keys.tavily) return { results: [], hit: false };
  const body = {
    query: clip(q.query, 200),
    search_depth: 'fast',
    max_results: q.max ?? 5,
    include_images: false,
    ...(q.raw ? { include_raw_content: 'markdown' } : {}),
    ...(q.domains?.length ? { include_domains: q.domains } : {}),
  };
  const { value, hit } = await cached(svc, 'tavily', body, 12 * 3600, async () => {
    const r = await callJson(svc, 'tavily', `${TAVILY_BASE}/search`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + svc.cfg.keys.tavily, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, 25000);
    return parseTavily(r.json);
  });
  return { results: value, hit };
}

const NOT_GIFT_HOSTS = /(^|\.)(youtube|youtu|facebook|instagram|pinterest|reddit|tiktok|x|twitter|linkedin|wikipedia|quora)\.(com|be|org)$/i;

const plain = (s: string) =>
  s
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#*_`>|]+/g, ' ');

/** Search snippets arrive as markdown-ish text; the card shows plain words. */
export function cleanSnippet(s: string, max = 180): string {
  return clip(plain(s), max);
}

/**
 * Blurb for an experience card: whole sentences that name the place, up to `max` characters. Empty when no sentence does,
 * because no blurb is better than a line about another page (aggregator sites list many unrelated tours).
 */
export function blurb(content: string, need: string[], max = 180): string {
  const sentences = plain(content)
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 2 && nameTokens(s).some((t) => need.includes(t)));
  const out: string[] = [];
  for (const s of sentences) {
    if ([...out, s].join(' ').length > max) break;
    out.push(s);
  }
  return out.length ? out.join(' ') : sentences[0] ? clip(sentences[0], max) : '';
}

const PROMO = /^(book now|buy now|shop now|order now|official (web)?site|home( page)?|reviews?)$/i;
/** Page titles end in "| Site name" or "- Book now"; the card shows the page's own words (at most two parts, joined by a dot). */
export function cleanTitle(title: string, host: string): string {
  const flat = host.toLowerCase().replace(/[^a-z0-9]/g, '');
  const labels = host.toLowerCase().split('.');
  const parts = title.split(/\s+[|\-–—·]\s+/).map((p) => p.trim()).filter(Boolean);
  const keep = parts.filter((p) => {
    const t = nameTokens(p);
    const compact = p.toLowerCase().replace(/[^a-z0-9]/g, '');
    return !PROMO.test(p) && !(t.length > 0 && t.every((x) => labels.includes(x))) && !(compact.length >= 4 && flat.includes(compact));
  });
  return clip((keep.length ? keep : parts.slice(0, 1)).slice(0, 2).join(' · ') || title, 140);
}

/** Experience ideas (tickets, classes, tours) for a place or destination. Link cards only, never purchasable here. */
export async function experienceCards(svc: Svc, a: { name: string; ideaId: string; max?: number }): Promise<{ cards: Card[]; hit: boolean }> {
  const { results, hit } = await searchWeb(svc, { query: `${a.name} experience gift tickets tour class`, max: 8 });
  const cards: Card[] = [];
  const need = nameTokens(a.name);
  const seen = new Set<string>();
  for (const r of results) {
    const host = hostOf(r.url).replace(/^www\./, '');
    if (!host || NOT_GIFT_HOSTS.test(host)) continue;
    // about this place, and one card per distinct page title (sites often return the same page under several URLs)
    const hay = ' ' + nameTokens(`${r.title} ${r.url} ${r.content}`).join(' ') + ' ';
    const dup = `${host}|${r.title.toLowerCase()}`;
    if (!need.every((t) => hay.includes(` ${t} `) || hay.includes(` ${t}s `)) || seen.has(dup)) continue;
    seen.add(dup);
    cards.push({
      id: 'x' + fnv(r.url).toString(16).padStart(8, '0'),
      ideaId: a.ideaId,
      title: cleanTitle(r.title, host),
      price_cents: 0,
      currency: 'USD',
      shop: host,
      url: r.url,
      purchasable: false,
      source: 'tavily',
      snippet: blurb(r.content, need) || undefined,
    });
    if (cards.length >= (a.max ?? 3)) break;
  }
  return { cards, hit };
}

/** USD amounts in cents found in text ("$12", "$1,299.00"); order of appearance, duplicates removed. */
export function extractUsdPrices(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{2}))?/g)) {
    const c = Math.round(Number(m[1]!.replace(/,/g, '') + '.' + (m[2] ?? '00')) * 100);
    if (c > 0 && c < 5_000_000 && !out.includes(c)) out.push(c);
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'set', 'of', 'a', 'in', 'to']);
const tokens = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2 && !STOP.has(t));

/**
 * Informational check of a catalog price against the shop's own page via Tavily (restricted to that shop's domain).
 * Only an exact price match on a page about the same product counts as "confirmed"; anything else is "unknown" (page prices are too
 * noisy to call a mismatch). Never changes the price that is charged: PayPal totals always come from the stored card.
 */
export async function priceCheck(svc: Svc, card: Card, hint = ''): Promise<{ check: NonNullable<Card['priceCheck']>; hit: boolean }> {
  const { results, hit } = await searchWeb(svc, { query: clip(`${card.title} ${hint}`.trim(), 160), domains: [card.shop], max: 3, raw: true });
  const want = new Set(tokens(card.title));
  for (const r of results) {
    const h = hostOf(r.url);
    if (h !== card.shop && !h.endsWith('.' + card.shop)) continue; // include_domains should guarantee this; never trust a price from another site
    const have = tokens(r.title + ' ' + r.url);
    const overlap = have.filter((t) => want.has(t)).length;
    if (want.size === 0 || overlap / Math.min(want.size, 6) < 0.5) continue;
    const prices = extractUsdPrices((r.raw ?? r.content).slice(0, 6000));
    if (!prices.length) continue;
    if (prices.includes(card.price_cents)) return { check: { state: 'confirmed', url: r.url }, hit };
  }
  return { check: { state: 'unknown' }, hit };
}
