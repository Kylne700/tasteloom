// Screen 1: what do they love, and what is the budget? Also the "Try an example" entry.
import { h, icon } from './dom.js';
import { mockNote, save, state } from './state.js';

const TYPES = [
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
const TYPE_LABEL = Object.fromEntries(TYPES.map(([v, l]) => [v, l.replace(/ \(.*\)/, '').replace(/ or .*/, '')]));
const PRESETS = [25, 50, 100, 200];
const MIN = 3;
const MAX = 5;
const TOO_FEW = `Add at least ${MIN} things they love, so the taste reading has something to work with.`;

export function mountTaste(root) {
  const favs = state.favorites.map((f) => ({ ...f }));

  const input = h('input', { id: 'fav-input', type: 'text', maxlength: '80', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', placeholder: 'For example: Nujabes', 'aria-describedby': 'fav-hint fav-count fav-error' });
  const type = h('select', { id: 'fav-type' }, TYPES.map(([v, l]) => h('option', { value: v }, l)));
  const chips = h('ul', { class: 'chips', 'aria-label': 'Things they love' });
  const count = h('p', { class: 'count', id: 'fav-count', role: 'status' });
  const err = h('p', { class: 'error', id: 'fav-error', role: 'alert' });
  const budget = h('input', { id: 'budget', type: 'number', inputmode: 'numeric', min: '10', max: '500', step: '5', value: String(state.budget || 100), 'aria-describedby': 'budget-hint budget-error' });
  const budgetErr = h('p', { class: 'error', id: 'budget-error', role: 'alert' });
  const presetBtns = PRESETS.map((n) =>
    h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': 'false', onclick: () => { budget.value = String(n); syncPresets(); budgetErr.textContent = ''; } }, `$${n}`),
  );

  const setError = (msg, focus) => {
    err.textContent = msg;
    input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    syncCount();
    if (msg && focus) input.focus();
  };

  // The count line gives the "add N more" hint only while the too-few error is not already saying it.
  function syncCount() {
    const n = favs.length;
    count.textContent = n >= MIN || err.textContent === TOO_FEW ? `${n} of ${MAX} added.` : `${n} of ${MAX} added. Add ${MIN - n} more to continue.`;
    count.dataset.ok = String(n >= MIN);
  }

  function syncPresets() {
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Number(budget.value) === PRESETS[i])));
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

  function readBudget() {
    const lim = (state.status && state.status.budget) || { min_cents: 1000, max_cents: 50000 };
    const v = Number(budget.value);
    if (!Number.isFinite(v) || budget.value === '') return { error: 'Enter a budget in dollars.' };
    if (v * 100 < lim.min_cents) return { error: `The budget must be at least $${lim.min_cents / 100}.` };
    if (v * 100 > lim.max_cents) return { error: `The budget can be at most $${lim.max_cents / 100}.` };
    return { value: Math.round(v) };
  }

  const form = h(
    'form',
    {
      class: 'panel form',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        if (input.value.trim()) addFromInput();
        if (err.textContent) return;
        if (favs.length < MIN) {
          setError(TOO_FEW, true);
          return;
        }
        const b = readBudget();
        if (b.error) {
          budgetErr.textContent = b.error;
          budget.setAttribute('aria-invalid', 'true');
          budget.focus();
          return;
        }
        state.favorites = favs.map((f) => ({ ...f }));
        state.budget = b.value;
        state.pending = { mode: 'live' };
        save();
        location.hash = '#/ideas';
      },
    },
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'fav-input', class: 'label' }, 'Things they love'),
      h('p', { class: 'hint', id: 'fav-hint' }, 'An artist, a book, a brand, a place, a game. Press Enter to add each one, and pick a type when a name could mean several things.'),
      h('div', { class: 'add-row' }, input, h('label', { class: 'sr-only', for: 'fav-type' }, 'Type of thing'), type, h('button', { type: 'button', class: 'btn', onclick: addFromInput }, icon('plus', 16), 'Add')),
      chips,
      count,
      err,
    ),
    h(
      'div',
      { class: 'field' },
      h('label', { for: 'budget', class: 'label' }, 'Budget in US dollars'),
      h('div', { class: 'budget-row' }, h('div', { class: 'money-input' }, h('span', { 'aria-hidden': 'true' }, '$'), budget), h('div', { class: 'presets', role: 'group', 'aria-label': 'Budget presets' }, presetBtns)),
      h('p', { class: 'hint', id: 'budget-hint' }, 'The whole gift stays within this total.'),
      budgetErr,
    ),
    h(
      'div',
      { class: 'actions' },
      h('button', { type: 'submit', class: 'btn primary big' }, 'Find gift ideas', icon('arrow', 18)),
      h('button', { type: 'button', class: 'btn big', onclick: () => { state.pending = { mode: 'example' }; location.hash = '#/ideas'; } }, 'Try an example'),
    ),
    h('p', { class: 'hint tight' }, 'The example replays a saved run, so you can see the whole flow without typing.'),
  );

  budget.addEventListener('input', () => {
    syncPresets();
    budgetErr.textContent = '';
    budget.removeAttribute('aria-invalid');
  });

  const demo = h('p', { class: 'demo-note', hidden: true });
  const syncDemo = () => {
    const m = (state.status && state.status.mocks) || [];
    demo.hidden = m.length === 0;
    if (m.length) demo.textContent = mockNote(m);
  };
  window.addEventListener('tasteloom:status', syncDemo);

  root.append(
    h(
      'div',
      { class: 'screen taste' },
      h('div', { class: 'taste-main' }, h('p', { class: 'eyebrow' }, 'Gift agent'), h('h1', { tabindex: '-1' }, 'Gifts that understand them'), h('p', { class: 'lead' }, 'Tell us three to five things they love. We read their taste, find real products that fit your budget, and you pay in the PayPal sandbox.'), form),
      h(
        'aside',
        { class: 'how', 'aria-labelledby': 'how-h' },
        h('h2', { id: 'how-h' }, 'How it works'),
        h(
          'ol',
          {},
          h('li', {}, h('strong', {}, 'Qloo reads their taste.'), h('span', {}, 'Your favourites become taste signals. Qloo explainability tells us which favourite links to each idea, so every suggestion says “because they love…”.')),
          h('li', {}, h('strong', {}, 'An agent finds real products.'), h('span', {}, 'Nemotron on Nebius calls tools: Qloo for taste, Channel3 for products and prices, Tavily for experiences and price checks.')),
          h('li', {}, h('strong', {}, 'You pay in the PayPal sandbox.'), h('span', {}, 'The server prices the order from its own saved cards. You approve as a guest on PayPal’s page, and the agent captures it. No real money moves.')),
        ),
        demo,
      ),
    ),
  );
  renderChips();
  syncPresets();
  syncDemo();
  return () => window.removeEventListener('tasteloom:status', syncDemo);
}
