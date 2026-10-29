// The favourites field: a text box with a type hint, the chips added so far, a count and an error line.
// The first screen and the /ask page both build it here, so they behave the same. The words come from the caller.
import { h, icon } from './dom.js';
import { MAX, MIN, TYPES } from './loves.js';

const TYPE_LABEL = Object.fromEntries(TYPES.map(([v, l]) => [v, l.replace(/ \(.*\)/, '').replace(/ or .*/, '')]));

/**
 * initial: [{ text, type }]. label, hint, tooFew: the words. after: a node shown under the hint. onChange: called after every add or remove.
 * Returns the field to put in a form, the list it edits, and what the form's submit handler needs.
 */
export function favouritesField({ initial, label, hint, tooFew, after, onChange }) {
  const favs = initial.map((f) => ({ ...f }));

  const input = h('input', { id: 'fav-input', type: 'text', maxlength: '80', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'For example: Nujabes', 'aria-describedby': 'fav-hint fav-count fav-error' });
  const type = h('select', { id: 'fav-type' }, TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const chips = h('ul', { class: 'chips', 'aria-label': label });
  const count = h('p', { class: 'count', id: 'fav-count', role: 'status' });
  const err = h('p', { class: 'error', id: 'fav-error', role: 'alert' });

  const setError = (msg, focus) => {
    err.textContent = msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    syncCount();
    if (msg && focus) input.focus();
  };

  // The count line gives the "add N more" hint only while the too-few error is not already saying it.
  function syncCount() {
    const n = favs.length;
    count.textContent = n >= MIN || err.textContent === tooFew ? `${n} of ${MAX} added.` : `${n} of ${MAX} added. Add ${MIN - n} more to continue.`;
    count.dataset.ok = String(n >= MIN);
  }

  function renderChips() {
    chips.replaceChildren(
      ...favs.map((f, i) =>
        h(
          'li',
          { class: 'chip' },
          h('span', { class: 'chip-text' }, f.text),
          f.type ? h('span', { class: 'chip-type' }, TYPE_LABEL[f.type] || f.type) : null,
          h('button', { type: 'button', class: 'chip-x', 'aria-label': `Remove ${f.text}`, onclick: () => { favs.splice(i, 1); setError(''); renderChips(); input.focus(); } }, icon('x', 14)),
        ),
      ),
    );
    syncCount();
    if (onChange) onChange();
  }

  function add(raw) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text) return true;
    if (favs.some((f) => f.text.toLowerCase() === text.toLowerCase())) {
      setError(`You already added ${text}.`, true);
      return false;
    }
    if (favs.length >= MAX) {
      setError(`You can add up to ${MAX}. Remove one to add another.`, true);
      return false;
    }
    favs.push({ text, type: type.value });
    setError('');
    return true;
  }

  function addFromInput() {
    // a pasted list ("A, B, C") adds each part
    const parts = input.value.split(',');
    for (const p of parts) if (!add(p)) break;
    if (!err.textContent) {
      input.value = '';
      type.value = ''; // the type hint belongs to the item just added; the next one starts as "Any type"
    }
    renderChips();
    input.focus();
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addFromInput();
    }
  });

  const field = h(
    'div',
    { class: 'field' },
    h('label', { for: 'fav-input', class: 'label' }, label),
    h('p', { class: 'hint', id: 'fav-hint' }, hint),
    after,
    h('div', { class: 'add-row' }, input, h('label', { class: 'sr-only', for: 'fav-type' }, 'Type of thing'), type, h('button', { type: 'button', class: 'btn', onclick: addFromInput }, icon('plus', 16), 'Add')),
    chips,
    count,
    err,
  );
  renderChips();
  return { field, favs, input, err, setError, addFromInput };
}
