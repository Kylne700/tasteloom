// "Compare: same AI, no Qloo". The model Tasteloom uses gets only the favourites the visitor typed (and the budget) and answers like a plain
// chat: no Qloo, no shop search, no web search. The prompt follows the plain arm of the measured comparison (scratch/why-us/proof/prompts.json), with
// labels for the types its profiles did not use; the name rule is that comparison's M1 ("the gift names a favourite"), ported with its test cases (test/plain.test.ts).
import { chat } from '../adapters/ai.ts';
import type { InsightType } from '../adapters/qloo.ts';
import { HttpError, type Svc } from '../lib/http.ts';
import type { Favorite, IdeasInput } from './ideas.ts';

export const PLAIN_ITEMS = 4;
const SYSTEM = 'You are a helpful assistant.';
// A plain string, not a template literal: {favorites} and ${budget} are slots that plainPrompt fills.
const USER = 'I need gift ideas for someone. They love: {favorites}. My budget per gift is ${budget}. Suggest 4 different gift ideas. Reply with JSON only, no other text: [{"gift": "<the item itself>", "reason": "<why they would like it>"}]';
// The comparison's labels, plus the three types its profiles did not use (person, place, podcast).
const LABEL: Record<InsightType, string> = { artist: 'artist', book: 'book', brand: 'brand', destination: 'place', movie: 'film', person: 'person', place: 'place', podcast: 'podcast', tv_show: 'TV show', video_game: 'video game' };

/** The user message. A favourite typed without a type has no label (the comparison's profiles always had one). The replacement functions keep `$&` and the like in a typed name literal. */
export function plainPrompt(input: IdeasInput): string {
  const favs = input.favorites
    .map((f) => {
      const label = f.type ? LABEL[f.type as InsightType] : undefined;
      return typeof label === 'string' ? `${f.text} (${label})` : f.text;
    })
    .join(', ');
  const usd = input.budget_cents % 100 ? (input.budget_cents / 100).toFixed(2) : String(input.budget_cents / 100);
  return USER.replace('${budget}', () => '$' + usd).replace('{favorites}', () => favs); // budget first: a typed name cannot hold a slot that is still open
}

type Gift = { gift: string; reason: string };
const THINK = /<think>[\s\S]*?<\/think>/g;

/** Up to n ideas of a reply: the comparison's reader first, and only when it finds nothing the looser one below (a reply the comparison could read gives exactly its result). */
export function parseGifts(text: string, n = PLAIN_ITEMS): Gift[] {
  const strict = strictGifts(text, n);
  return strict.length ? strict : looseGifts(text, n);
}

/** First JSON array of objects in a reply -> up to n { gift, reason }. Bad JSON or no array gives []. Port of the comparison's parseGifts. */
function strictGifts(text: string, n: number): Gift[] {
  const t = String(text ?? '').replace(THINK, '');
  const m = t.match(/\[\s*\{/);
  if (!m) return [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = m.index!; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) {
      try {
        const a = JSON.parse(t.slice(m.index!, i + 1)) as Record<string, unknown>[];
        return a.filter((x) => x && typeof x.gift === 'string' && x.gift.trim()).slice(0, n).map((x) => ({ gift: (x.gift as string).trim(), reason: String(x.reason ?? '').trim() }));
      } catch {
        return [];
      }
    }
  }
  return [];
}

/** For JSON the model broke, most often a title in quotes inside a string (live: "gift": "Nujabes - "Modal Soul" Vinyl"), which the reader above refuses.
 *  Reads the two keys the prompt asks for, in that order, one object at a time (shortcut: a different key order or name is not read, a reason that holds "} ends early). */
function looseGifts(text: string, n: number): Gift[] {
  const out: Gift[] = [];
  for (const chunk of String(text ?? '').replace(THINK, '').split(/"gift"\s*:\s*"/).slice(1)) {
    const m = chunk.match(/^([\s\S]*?)"\s*,\s*"reason"\s*:\s*"([\s\S]*?)"\s*\}/);
    if (m && m[1]!.trim()) out.push({ gift: unquote(m[1]!), reason: unquote(m[2]!) });
  }
  return out.slice(0, n);
}
/** A JSON string body read as text: inner quotes allowed, escapes (\n, é) honoured when the rest is valid, else the text as it is. */
const unquote = (s: string): string => {
  try {
    return (JSON.parse('"' + s.replace(/\\?"/g, '\\"') + '"') as string).trim();
  } catch {
    return s.trim();
  }
};

// ---- M1: "the gift names a favourite" ------------------------------------------------------------------------------------
// Port of the comparison's frozen rule. Text and names are normalised (accents off, lower case, apostrophes dropped, & = and, other symbols = space);
// a favourite counts as named when one of its needles appears as whole words. Needles: the full name, the name without a leading "the", and for kind
// "person" also the last word when it has 4+ letters.
// shortcut: albums or characters of a favourite ("Kind of Blue") are not detected and a common-word name ("Dune") can match inside an unrelated gift, so
// the count is only a hint; upgrade only with a new measurement. A name without a Latin letter or digit has no needle (the rule is Latin-only) and is never matched.
export const norm = (s: string): string =>
  String(s)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

export interface Fav {
  name: string;
  kind?: string;
}

export function needles(fav: Fav): string[] {
  const full = norm(fav.name);
  const out = new Set([full]);
  if (full.startsWith('the ')) out.add(full.slice(4));
  if (fav.kind === 'person') {
    const last = full.split(' ').pop()!;
    if (last.length >= 4) out.add(last);
  }
  return [...out];
}

export const names = (text: string, fav: Fav): boolean => {
  const t = ' ' + norm(text) + ' ';
  return needles(fav).some((n) => n !== '' && t.includes(' ' + n + ' ')); // n !== '': a name with no Latin letter would match any text that has none
};

export const namesAny = (text: string, favs: Fav[]): boolean => favs.some((f) => names(text, f));

/** The app has a type, not the comparison's kind: only a favourite typed as "person" gets the last-name needle. shortcut: a solo artist typed as "artist" is matched by full name only (fewer tags, never more than the comparison's rule). */
const favOf = (f: Favorite): Fav => ({ name: f.text, kind: f.type === 'person' ? 'person' : undefined });

export interface PlainIdea {
  gift: string;
  reason: string;
  /** the gift text names one of the favourites the visitor typed (rule M1) */
  named: boolean;
}
export interface PlainAnswer {
  ideas: PlainIdea[];
  /** the answer comes from the built-in stand-in, not a model */
  mock: boolean;
}

/** One model call with the comparison's prompt. An answer without a readable idea is an upstream failure and is not asked again, as in the comparison. */
export async function runPlain(svc: Svc, input: IdeasInput): Promise<PlainAnswer> {
  const res = await chat(svc, { model: svc.cfg.models.writer, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: plainPrompt(input) }] });
  const gifts = parseGifts(res.content);
  if (!gifts.length) throw new HttpError('ai', 502, 'ai answer held no readable idea');
  const favs = input.favorites.map(favOf);
  return { ideas: gifts.map((g) => ({ ...g, named: namesAny(g.gift, favs) })), mock: res.via === 'mock' };
}
