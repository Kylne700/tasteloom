// Screen 1: what do they love, and what is the budget? Also the "Try an example" entry.
import { announce, h, icon } from './dom.js';
import { favouritesField } from './favs.js';
import { linkRow } from './linkrow.js';
import { MIN } from './loves.js';
import { mockNote, save, state } from './state.js';

const PRESETS = [25, 50, 100, 200];
const TOO_FEW = `Add at least ${MIN} things they love, so the taste reading has something to work with.`;

// "Not sure what they love?": a link to send. Their answer comes back inside the reply link (loves.js), so no server holds it.
function askLink() {
  const panel = h('div', { id: 'ask-panel', class: 'ask-panel', hidden: true },
    h('p', {}, 'Send them this link. They name what they love and send you a reply link. When you open it here, their answer fills in below.'),
    linkRow({ url: `${location.origin}/ask`, label: 'Link to send', text: 'What do you love lately? Tell me here.' }),
  );
  const btn = h('button', { type: 'button', class: 'link-btn', 'aria-expanded': 'false', 'aria-controls': 'ask-panel', onclick: () => {
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', String(!panel.hidden));
  } }, 'Not sure what they love? Ask them');
  return h('div', { class: 'ask-link' }, btn, panel);
}

export function mountTaste(root, { reply } = {}) {
  const { field, favs, input, err, setError, addFromInput } = favouritesField({
    initial: state.favorites,
    label: 'Things they love',
    hint: 'An artist, a book, a brand, a place, a game. Press Enter to add each one, and pick a type when a name could mean several things.',
    tooFew: TOO_FEW,
    after: askLink(),
  });
  // app.js hands over what became of a reply link (#loves=…) that was opened: filled in, or not readable
  const replyLine = reply && (reply.ok ? 'Filled from their reply' : 'That reply link could not be read, so nothing was filled in.');
  const budget = h('input', { id: 'budget', type: 'number', inputmode: 'numeric', min: '10', max: '500', step: '5', value: String(state.budget || 100), 'aria-describedby': 'budget-hint budget-error' });
  const budgetErr = h('p', { class: 'error', id: 'budget-error', role: 'alert' });
  const presetBtns = PRESETS.map((n) =>
    h('button', { type: 'button', class: 'chip-btn', 'aria-pressed': 'false', onclick: () => { budget.value = String(n); syncPresets(); budgetErr.textContent = ''; } }, `$${n}`),
  );

  function syncPresets() {
    presetBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Number(budget.value) === PRESETS[i])));
  }

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
    replyLine ? h('p', { class: `note ${reply.ok ? 'info' : 'warn'}` }, icon(reply.ok ? 'info' : 'alert', 18), h('span', {}, replyLine)) : null,
    field,
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
    if (m.length) demo.textContent = mockNote(m, state.status.modes);
  };
  window.addEventListener('tasteloom:status', syncDemo);

  root.append(
    h(
      'div',
      { class: 'screen taste' },
      h(
        'div',
        { class: 'taste-main' },
        h('p', { class: 'eyebrow' }, 'Gift agent'),
        h('h1', { tabindex: '-1' }, 'Gifts that understand them'),
        h('p', { class: 'principle' }, 'No age, no gender, no account: only what they love.'), // true of the form: favourites (with an optional type) and the giver's budget, nothing else about the person
        h('p', { class: 'lead' }, 'Tell us three to five things they love. We read their taste, find real products that fit your budget, and you pay in the PayPal sandbox.'),
        form,
        h('p', { class: 'own-link' }, h('a', { class: 'link-btn', href: '/ask?for=me' }, 'Make your own taste link')), // the same page a friend gets, set up for sending to whoever buys you gifts
      ),
      h(
        'aside',
        { class: 'how', 'aria-labelledby': 'how-h' },
        h('h2', { id: 'how-h' }, 'How it works'),
        h(
          'ol',
          {},
          h('li', {}, h('strong', {}, 'Qloo reads their taste.'), h('span', {}, 'Your favourites become taste signals. Qloo explainability tells us which favourite links to each idea, and the card names it: “because they love…”. If Qloo links none, the card says the idea fits their overall taste.')),
          h('li', {}, h('strong', {}, 'An agent finds real products.'), h('span', {}, 'An AI model on Cloudflare Workers AI calls tools: Qloo for taste, Channel3 for products and prices, Tavily for experiences and price checks.')),
          h('li', {}, h('strong', {}, 'You pay in the PayPal sandbox.'), h('span', {}, 'The server prices the order from its own saved cards. You approve as a guest on PayPal’s page, and the agent captures it. No real money moves.')),
        ),
        h('p', { class: 'sent' }, h('strong', {}, 'What is sent where. '), 'What you type goes to Qloo (to read taste) and to the AI model on Cloudflare Workers AI, which also gets what Qloo answers: the names it suggests and the tags it gives both a suggestion and the favourite it links most strongly. Searches built from it go to Channel3 (products) and Tavily (experiences and price checks); their answers are kept for 12 hours under a hash of the search, so a repeated search is answered without asking the shop or the web again. PayPal gets only the order, in its sandbox. Tasteloom does not store the favourites you type. It keeps the product cards of a run and your budget for 2 hours, so the server can price your order, and sandbox orders for 7 days. The other services keep what they receive under their own terms.'),
        h('p', { class: 'sent' }, h('strong', {}, 'Daily limits. '), 'The demo is free, with daily caps on live lookups, on shop and web search, and on the AI model. When shop search is used up, ideas still come from Qloo but without buy buttons; when web search is, prices are not checked and place links are missing; without the model the steps are fixed. The page says so each time, and the saved example always works.'),
        demo,
      ),
    ),
  );
  if (replyLine) announce(replyLine);
  syncPresets();
  syncDemo();
  return () => window.removeEventListener('tasteloom:status', syncDemo);
}
