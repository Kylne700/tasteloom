// WCAG contrast of the stylesheet: every rule that sets a text colour is checked against the surface it sits on.
// Colours must be plain hex (directly or through a :root token) so they can be evaluated; anything else needs a reason below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const tok: Record<string, string> = {};
for (const m of css.match(/:root\s*\{([^}]*)\}/)![1]!.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)) tok[m[1]!] = m[2]!;

function hexOf(v: string | null | undefined): string | null {
  const t = (v ?? '').trim();
  const ref = /^var\(--([\w-]+)\)$/.exec(t);
  if (ref) return tok[ref[1]!] ?? null;
  if (/^#[0-9a-f]{3}$/i.test(t)) return '#' + [...t.slice(1)].map((c) => c + c).join('');
  return /^#[0-9a-f]{6}$/i.test(t) ? t : null;
}
const lum = (h: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};

const PAGE = ['bg', 'surface', 'sand'].map((k) => tok[k]!);
/** Rules whose background is set by a parent rule: the surface to check against. */
const SITS_ON: Record<string, string> = { '.skip:focus': tok.ink!, '.bar-count .of': tok.ink! };
/** Not evaluated, with the reason. */
const EXEMPT: Record<string, string> = {
  '.media .ph, .thumb .ph': 'decorative initial letter, aria-hidden, replaced by the product image',
  '.bar .btn.primary:disabled': 'disabled control (WCAG 1.4.3 exempts it); the label stays readable at about 9:1 on the bar anyway',
};

interface Rule { sel: string; fg: string; bg: string | null; bgRaw: string | null }
const rules: Rule[] = [];
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = m[1]!.trim().replace(/\s+/g, ' ');
  if (sel.startsWith(':root')) continue;
  const fgRaw = /(?:^|[;\s])color:\s*([^;]+)/.exec(m[2]!)?.[1];
  const fg = hexOf(fgRaw);
  if (!fg) continue;
  const bgText = /background(?:-color)?:\s*([^;]+)/.exec(m[2]!)?.[1]?.trim() ?? null;
  const bgRaw = bgText === 'transparent' || bgText === 'none' ? null : bgText; // no own background: the text sits on the page surface
  rules.push({ sel, fg, bg: hexOf(bgRaw?.split(/\s+/)[0]), bgRaw });
}

test('contrast: the scan found the stylesheet colours (so the checks below are not vacuous)', () => {
  assert.ok(Object.keys(tok).length >= 15, `${Object.keys(tok).length} tokens`);
  assert.ok(rules.length >= 60, `${rules.length} rules with a text colour`);
});

test('contrast: all text is at least 4.5:1 on the surface it sits on', () => {
  const low: string[] = [];
  for (const r of rules) {
    if (EXEMPT[r.sel]) continue;
    const sits = SITS_ON[r.sel];
    const surfaces = r.bg ? [r.bg] : r.bgRaw && !sits ? null : sits ? [sits] : PAGE;
    if (!surfaces) {
      low.push(`${r.sel}: background "${r.bgRaw}" cannot be evaluated; use a hex colour or list it as exempt with a reason`);
      continue;
    }
    for (const s of surfaces) if (ratio(r.fg, s) < 4.5) low.push(`${r.sel}: ${r.fg} on ${s} is ${ratio(r.fg, s).toFixed(2)}:1`);
  }
  assert.deepEqual(low, []);
});

test('contrast: every exemption still matches a rule (no stale exemptions)', () => {
  const sels = new Set(rules.map((r) => r.sel));
  for (const k of [...Object.keys(EXEMPT), ...Object.keys(SITS_ON)]) assert.ok(sels.has(k), `no rule "${k}"`);
});

test('contrast: button labels, status panels and links on their own backgrounds', () => {
  const pairs: [string, string, string][] = [
    ['#ffffff', tok.accent!, 'primary button label'],
    ['#ffffff', tok['accent-hover']!, 'primary button label, hovered'],
    [tok.ink!, tok.bg!, 'body text'],
    [tok['ink-2']!, tok.surface!, 'secondary text on cards'],
    [tok['ink-2']!, tok.sand!, 'secondary text on sand'],
    [tok.accent!, tok.bg!, 'link'],
    [tok['accent-strong']!, tok['accent-soft']!, 'accent text on accent tint'],
    [tok.ok!, tok['ok-soft']!, 'success panel'],
    [tok.warn!, tok['warn-soft']!, 'warning panel'],
    [tok.bad!, tok['bad-soft']!, 'error panel'],
    [tok.ink!, tok['ok-soft']!, 'text in success panel'],
    [tok.ink!, tok['warn-soft']!, 'text in warning panel'],
    [tok.ink!, tok['bad-soft']!, 'text in error panel'],
  ];
  for (const [fg, bg, what] of pairs) assert.ok(ratio(fg, bg) >= 4.5, `${what}: ${fg} on ${bg} is ${ratio(fg, bg).toFixed(2)}:1`);
});

test('contrast: input borders and focus rings are at least 3:1 (WCAG 1.4.11)', () => {
  for (const s of PAGE) assert.ok(ratio(tok.edge!, s) >= 3, `input border on ${s}: ${ratio(tok.edge!, s).toFixed(2)}:1`);
  for (const s of [...PAGE, tok['accent-soft']!]) assert.ok(ratio(tok.accent!, s) >= 3, `focus ring on ${s}: ${ratio(tok.accent!, s).toFixed(2)}:1`);
  assert.ok(ratio('#ffffff', tok.ink!) >= 3, 'white focus ring on the dark bar');
  assert.match(css, /\.bar :focus-visible\s*\{\s*outline-color:\s*#fff/, 'the dark bar uses the white ring');
  assert.ok(ratio(tok.accent!, tok.ink!) < 3, 'if this fails the accent ring now works on the bar and the override can go');
});
