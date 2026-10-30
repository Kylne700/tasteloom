// The idea card: "Copy note", the reason as the hero line, and the wording rules for labels that claim something.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MEMORY, noteFor } from '../public/note.js';
import { parseIdeasInput } from '../src/agent/ideas.ts';
import { EXAMPLE } from '../public/example.js';
import { MAX, MIN, TYPES, cleanText } from '../public/loves.js';
import { mockNote } from '../public/state.js';

const read = (p: string) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

test('noteFor: the favourites the card names, then a blank line to write in; nothing for a card that names none', () => {
  assert.equal(noteFor(['Nujabes']), 'I picked this because you love Nujabes.\n\n');
  assert.equal(noteFor(['Nujabes', 'Muji']), 'I picked this because you love Nujabes and Muji.\n\n');
  assert.equal(noteFor(['A', 'B', 'C']), 'I picked this because you love A, B and C.\n\n');
  assert.equal(noteFor([]), '');
  assert.equal(noteFor(['', '  ']), '');
  assert.equal(MEMORY, 'Add one memory only you can write.');
  assert.ok(!noteFor(['Muji']).includes(MEMORY), 'the memory line is shown, not copied');
});

test('a card leads with its reason: "Because they love X" is set larger than the idea title at every width, with no new colour', () => {
  const css = read('public/styles.css');
  const size = (sel: string) => {
    const m = css.match(new RegExp(`^${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{[^}]*font-size: ([0-9.]+)rem`, 'm'));
    assert.ok(m, sel);
    return Number(m![1]);
  };
  const title = size('.idea h2');
  assert.ok(size('.because.named .because-lbl') > title && size('.because.named .pill-soft') > title, 'the reason line outranks the title');
  assert.equal(css.match(/\.idea h2 \{[^}]*font-size/g)?.length, 1, 'no other width resizes the title');
  for (const line of css.split('\n').filter((l) => /^\.(because\.named|note-row|note-status|note-box|principle|own-link|ask-link|ask-row|ask-text|ask-panel|hint\.replay)\b/.test(l))) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b/i, line);
  assert.match(read('public/ideas.js'), /class: 'because named'/);
});

test('Qloo’s evidence on a card is text from the idea, quieter than the reason, in the existing colours, and never worded as a match', () => {
  const css = read('public/styles.css');
  const rule = (sel: string) => css.split('\n').find((l) => l.startsWith(`${sel} {`)) ?? '';
  const rem = (sel: string) => Number(rule(sel).match(/font-size: ([0-9.]+)rem/)?.[1]);
  assert.ok(rem('.evidence') > 0 && rem('.evidence') < rem('.reason'), 'quieter than the reason');
  assert.match(rule('.evidence'), /color: var\(--ink-2\)/);
  assert.match(rule('.ev-val'), /color: var\(--ink\)/);
  for (const sel of ['.evidence', '.ev-val']) assert.doesNotMatch(rule(sel), /#[0-9a-f]{3,8}\b/i, sel);
  const js = read('public/ideas.js');
  const code = js.slice(js.indexOf('function evidenceRows'), js.indexOf('// A link card whose page gave no blurb'));
  assert.match(code, /'How Qloo splits its link to this idea \(adds up to 100%\): '/);
  assert.match(code, /`Tags Qloo gives to both \$\{names\[0\]\} and \$\{idea\.entity\.name\}: `/);
  assert.match(code, /parts\.length > 1/, 'a split of one favourite is not shown');
  assert.doesNotMatch(code, /match|affinity|innerHTML/i);
});

test('"What is sent where" names what the code does: Qloo’s tags go to the model, and shop and web answers are cached 12 hours under a hash', () => {
  const sent = read('public/taste.js').split('\n').find((l) => l.includes('What is sent where. '))!;
  assert.match(sent, /AI model on Cloudflare Workers AI, which also gets what Qloo answers: the names it suggests and the tags it gives both a suggestion and the favourite it links most strongly/);
  assert.match(sent, /their answers are kept for 12 hours under a hash of the search/);
  const readme = read('README.md');
  assert.match(readme, /the tags Qloo gives both an idea and the favourite it links most strongly \(up to four per idea\)/);
  assert.match(readme, /stored for 12 hours under a hash of the search/);
  // the claims above are what the adapters do: both searches go through cached(), for 12 hours, and cached() keys on a SHA-256 hash
  for (const [file, service] of [['src/adapters/channel3.ts', 'channel3'], ['src/adapters/tavily.ts', 'tavily']]) assert.match(read(file!), new RegExp(`cached\\(svc, '${service}', .*, 12 \\* 3600,`), file);
  assert.match(read('src/lib/http.ts'), /\(await sha256Hex\(JSON\.stringify\(keyParts\)\)\)\.slice\(0, 32\)/);
  // up to four shared tags per idea (sharedTags' default) and only the strongest favourite's: what the model is given as "in_common"
  assert.match(read('src/agent/evidence.ts'), /export function sharedTags\(favourite: string\[\] \| undefined, idea: string\[\] \| undefined, max = 4\)/);
});

test('the live example set is an input the server accepts as it is: 3 to 5 favourites with known types, clean text, a budget within the limits', () => {
  const r = parseIdeasInput({ favorites: EXAMPLE.favorites, budget_usd: EXAMPLE.budget }, { minBudgetCents: 1000, maxBudgetCents: 50000 });
  assert.ok(r.ok, JSON.stringify(r));
  if (!r.ok) return;
  assert.deepEqual(r.value.favorites, EXAMPLE.favorites, 'nothing is cut, merged or dropped on the way in');
  assert.equal(r.value.budget_cents, EXAMPLE.budget * 100);
  assert.ok(EXAMPLE.favorites.length >= MIN && EXAMPLE.favorites.length <= MAX);
  const known = new Set(TYPES.map(([value]) => value));
  for (const f of EXAMPLE.favorites) assert.ok(f.type && known.has(f.type) && cleanText(f.text) === f.text, f.text);
});

test('the first screen: two ways to start (type, or Ask them), a live example and a labelled saved replay; the Ask them box uses the existing colours only', () => {
  const taste = read('public/taste.js');
  for (const label of ['Find gift ideas', 'Run a live example', 'Replay the saved example', 'Ask them']) assert.ok(taste.includes(`'${label}'`), label);
  assert.match(taste, /three to five things they love, or send them a link and let them tell you/);
  assert.match(taste, /id: 'ask-btn', class: 'btn small', 'aria-expanded': 'false', 'aria-controls': 'ask-panel'/);
  assert.match(taste, /state\.pending = \{ mode: 'live', example: true \}/, 'the example is a live run of the normal kind, flagged only so the next screen can label it');
  assert.match(taste, /state\.pending = \{ mode: 'example' \}/, 'the saved replay stays reachable');
  assert.doesNotMatch(taste, /Try an example/, 'one name for the saved replay everywhere');
  // the screen after it says what the set is, and what is offered when the run cannot go on
  const ideas = read('public/ideas.js');
  assert.match(ideas, /Example set\. The favourites and the budget above were picked for this demo, not typed by you\./);
  assert.equal(ideas.match(/'Replay the saved example'/g)?.length, 2, 'offered after an error and when nothing was found');
  assert.match(ideas, /mode === 'live' && run\.liveExample \? \{ mode, example: true \}/, '"Try again" keeps the example set');
  const css = read('public/styles.css');
  for (const l of css.split('\n').filter((l) => /^\.ask-(link|row|text|panel)\b/.test(l))) assert.doesNotMatch(l, /#[0-9a-f]{3,8}\b|rgb\(/i, l);
  assert.match(css, /\.linkrow \.link-box \{[^}]*width: 100%/, 'an input keeps its own width unless told otherwise, and that pushed the nested Ask them boxes past a 320 px screen');
  assert.doesNotMatch(css, /\.hint \.link-btn/, 'the replay button keeps its tap size (the audit wants 24 px)');
});

test('mockNote says "live" only when the server status backs it', () => {
  assert.match(mockNote(['qloo', 'ai'], { channel3: 'live', paypal: 'live' }), /^Demo data: Qloo and the AI model run on built-in stand-ins .* Products, prices and PayPal are live\.$/);
  for (const modes of [null, undefined, { channel3: 'off', paypal: 'live' }, { channel3: 'live', paypal: 'off' }, {}]) assert.doesNotMatch(mockNote(['qloo'], modes as never), /live/, JSON.stringify(modes));
});

test('README: the taste-link note sits in the Ask them section, and nothing in it claims what the code cannot back', () => {
  const readme = read('README.md');
  const section = readme.split('## Ask them without spoiling it')[1]!.split('\n## ')[0]!;
  assert.match(section, /\*\*Your own taste link\.\*\*/);
  assert.ok(section.includes('/ask?for=me'));
  assert.doesNotMatch(readme, /hidden gems?|beats chatgpt|chatbot (?:can(?:not|'t)|could not) reach|no rival/i);
});

test('the first screen: "Run a live example" sits once, directly after the lead and above the form, with a hint that keeps the demo label; the saved replay stays in the form', () => {
  const taste = read('public/taste.js');
  assert.equal(taste.match(/'Run a live example'/g)?.length, 1, 'one button of that name: the old one in the form is gone');
  const at = (s: string) => {
    const i = taste.indexOf(s);
    assert.ok(i >= 0, s);
    return i;
  };
  const lead = at("h('p', { class: 'lead' }");
  const example = at("h('div', { class: 'live-example' }");
  assert.ok(lead < example && example < at('        form,\n'), 'lead, then the example block, then the form');
  assert.ok(example < at("'Run a live example'") && at("'Run a live example'") < at("'Fills in favourites and a budget picked for this demo, then searches within the daily limits.'"), 'button, then its hint');
  const form = taste.slice(at('const form = h('), at('budget.addEventListener'));
  assert.ok(form.includes("'Replay the saved example'") && !form.includes('Run a live example'), 'the form keeps the replay and no longer holds the live example');
  assert.match(read('public/styles.css'), /\.live-example \{[^}]*flex-wrap: wrap/, 'the block wraps, so the hint drops under the button on a phone');
});
