// The idea card: "Copy note", the reason as the hero line, and the wording rules for labels that claim something.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { MEMORY, noteFor } from '../public/note.js';
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
  for (const line of css.split('\n').filter((l) => /^\.(because\.named|note-row|note-status|note-box|principle|own-link)\b/.test(l))) assert.doesNotMatch(line, /#[0-9a-f]{3,8}\b/i, line);
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
