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
