// What a friend loves, packed into a link. The answer lives only in the URL fragment (after the #), which a browser never sends to a server.
// No DOM in here, so the unit tests import it directly. Decoding is untrusted input: a fragment that is not exactly what encodeLoves makes is refused whole.
export const TYPES = [
  ['', 'Any type'],
  ['artist', 'Artist or band'],
  ['book', 'Book'],
  ['brand', 'Brand'],
  ['place', 'Place or venue'],
  ['destination', 'City or country'],
  ['movie', 'Movie'],
  ['tv_show', 'TV show'],
  ['video_game', 'Video game'],
  ['podcast', 'Podcast'],
  ['person', 'Person'],
];
export const MIN = 3; // what the first screen asks for; a reply with fewer is still filled in, and that screen asks for the rest
export const MAX = 5;
export const MAX_TEXT = 80; // UTF-16 units, like the input's maxlength and the server's cut
export const MAX_FRAGMENT = 2048; // everything after the #, "loves=" included
const KNOWN = new Set(TYPES.map(([value]) => value));
const BAD = Object.freeze({ ok: false });

/** One favourite the way the server reads it: control characters (and bidi marks and lone surrogates) become spaces, white space collapses, the ends are trimmed. */
export const cleanText = (s) => String(s).replace(/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/gu, ' ').replace(/\s+/g, ' ').trim();

/** items: [{ text, type }] -> "loves=" + base64url of the UTF-8 JSON. */
export function encodeLoves(items) {
  const list = items.map(({ text, type }) => (type ? { text: cleanText(text), type } : { text: cleanText(text) }));
  const bytes = new TextEncoder().encode(JSON.stringify(list));
  return 'loves=' + btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

/** fragment: location.hash without the "#". Returns { ok: true, items: [{ text, type }] }, or { ok: false } for anything else. */
export function decodeLoves(fragment) {
  try {
    if (typeof fragment !== 'string' || fragment.length > MAX_FRAGMENT || !/^loves=[A-Za-z0-9_-]+$/.test(fragment)) return BAD;
    const bytes = Uint8Array.from(atob(fragment.slice(6).replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0));
    const list = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!Array.isArray(list) || !list.length || list.length > MAX) return BAD;
    const items = [];
    for (const it of list) {
      if (!it || typeof it !== 'object' || typeof it.text !== 'string') return BAD;
      const type = it.type === undefined ? '' : it.type;
      if (typeof type !== 'string' || !KNOWN.has(type)) return BAD;
      const text = cleanText(it.text);
      if (!text || text.length > MAX_TEXT || items.some((x) => x.text.toLowerCase() === text.toLowerCase())) return BAD;
      items.push({ text, type });
    }
    return { ok: true, items };
  } catch {
    return BAD; // bad base64, bad UTF-8, bad JSON
  }
}
