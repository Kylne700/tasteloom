// Screen 3: review the picks, then pay as a guest in the PayPal sandbox. The server prices the order from its own saved cards;
// the page only sends the session id and the picked card ids.
import { h, icon, money, safeUrl, shopImage, announce, copyText, spinner } from './dom.js';
import { ApiError, postJson } from './api.js';
import { budgetCents, save, selectedCards, startOver, state, totalCents } from './state.js';

const PAYPAL_HOST = 'https://www.sandbox.paypal.com/';
// PayPal's documented sandbox test card (it only works in the sandbox).
const TEST_CARD = [
  ['Card number', '4005 5192 0000 0004', '4005519200000004'],
  ['Expiry', '12/30', '12/30'],
  ['Security code', '123', '123'],
];
const TITLES = {
  session_expired: 'Your session expired',
  over_budget: 'That is over your budget',
  too_many: 'That is too many items',
  limit: 'No more sandbox orders today',
  upstream: 'PayPal is not answering',
  network: 'We could not reach the server',
};
const RETRY = new Set(['upstream', 'network', 'internal', 'http']); // paying again can work
const FIXABLE = new Set(['over_budget', 'too_many', 'empty', 'bad_request', 'unknown_item', 'not_purchasable']); // removing an item can clear these
const OFF = {
  session_expired: 'Paying is off until you start over.',
  limit: 'Paying is off while sandbox orders are paused.',
  over_budget: 'Paying is off until the gift fits your budget.',
};
const banner = (kind, title, text, actions) =>
  h('section', { class: 'panel bad', role: 'alert', 'data-kind': kind }, h('div', { class: 'panel-icon' }, icon('alert', 22)), h('div', { class: 'panel-body' }, h('h2', {}, title), h('p', {}, text), h('div', { class: 'panel-actions' }, actions)));

export function mountCheckout(root, { cancelled }) {
  let busy = false;
  let ready = null; // the server's answer, held back when its total differs from what the page shows
  let blockedBy = ''; // error code of a server answer that paying again cannot fix
  const shownTotal = () => (ready ? ready.total_cents : totalCents());
  const guard = () => blockedBy || (shownTotal() > budgetCents() ? 'over_budget' : ''); // why Pay is switched off, if it is

  const notices = h('div', { class: 'notices' });
  const lines = h('ul', { class: 'lines' });
  const totals = h('dl', { class: 'totals' });
  const payLabel = h('span', {});
  const payBtn = h('button', { type: 'button', class: 'btn primary big pay-btn', onclick: pay }, payLabel);
  const payStatus = h('p', { class: 'pay-status', role: 'status' });

  // ---- order summary ----------------------------------------------------------------------------------------------------
  function thumb(card) {
    const img = card.image && safeUrl(card.image);
    return h('div', { class: 'thumb' }, img ? h('img', { ...shopImage(img), alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', width: '64', height: '64', onload: (e) => { e.target.dataset.ok = '1'; }, onerror: (e) => e.target.remove() }) : null, h('span', { class: 'ph', 'aria-hidden': 'true' }, card.title.trim().charAt(0).toUpperCase()));
  }

  function remove(card) {
    const i = state.selected.indexOf(card.id);
    if (i >= 0) state.selected.splice(i, 1);
    ready = null;
    if (FIXABLE.has(blockedBy)) blockedBy = '';
    if (!blockedBy) notices.replaceChildren(); // a price note or a fixable error no longer applies to this gift
    save();
    announce(`Removed ${card.title}.`);
    if (!state.selected.length) {
      location.hash = '#/ideas';
      return;
    }
    renderSummary();
  }

  function renderSummary() {
    const picked = selectedCards();
    // while the server's answer is held back, show what the server priced (its lines and total) with the pictures of the matching cards
    const items = ready ? ready.lines.map((l) => ({ ...(picked.find((c) => c.id === l.id) || {}), ...l })) : picked;
    const total = shownTotal();
    const budget = budgetCents();
    lines.replaceChildren(
      ...items.map((c) =>
        h(
          'li',
          { class: 'line' },
          thumb(c),
          h('div', { class: 'line-body' }, h('p', { class: 'line-title' }, c.title), h('p', { class: 'line-shop' }, c.shop)),
          h('span', { class: 'line-price' }, money(c.price_cents)),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': `Remove ${c.title} from your gift`, onclick: () => remove(c) }, icon('x', 16)),
        ),
      ),
    );
    totals.replaceChildren(
      h('div', { class: 'row total' }, h('dt', {}, 'Total'), h('dd', {}, money(total))),
      h('div', { class: 'row' }, h('dt', {}, 'Your budget'), h('dd', {}, money(budget))),
      total > budget ? h('div', { class: 'row over' }, h('dt', {}, 'Over budget by'), h('dd', {}, money(total - budget))) : h('div', { class: 'row' }, h('dt', {}, 'Left over'), h('dd', {}, money(budget - total))),
    );
    const shown = notices.querySelector('[data-kind="budget"]');
    if (total > budget && !blockedBy && !notices.children.length) {
      notices.append(banner('budget', TITLES.over_budget, `This gift costs ${money(total - budget)} more than your ${money(budget)} budget. Remove an item below, or go back and pick cheaper ones.`, [h('a', { class: 'btn primary', href: '#/ideas' }, icon('back', 16), 'Back to ideas')]));
    } else if (total <= budget && shown) shown.remove();
    setPayLabel();
  }

  function setPayLabel() {
    const off = busy ? '' : guard();
    payBtn.disabled = busy || !!off;
    payBtn.replaceChildren(busy ? spinner() : icon('lock', 18), h('span', {}, busy ? 'Opening PayPal' : `Pay ${money(shownTotal())} with PayPal`));
    payBtn.setAttribute('aria-busy', String(busy));
    if (!busy) payStatus.textContent = off ? OFF[off] || 'Paying is off until the gift is fixed.' : '';
  }

  // ---- paying -----------------------------------------------------------------------------------------------------------
  function showError(err) {
    const code = err.code || 'internal';
    const retry = RETRY.has(code);
    blockedBy = retry ? '' : code; // paying again cannot fix the rest, so Pay stays off until the buyer acts
    const actions = [];
    if (code === 'session_expired') {
      actions.push(h('button', { type: 'button', class: 'btn primary', onclick: () => { startOver(); location.hash = '#/'; } }, 'Start over'));
      actions.push(h('button', { type: 'button', class: 'btn', onclick: () => { startOver(); state.pending = { mode: 'example' }; location.hash = '#/ideas'; } }, 'Try an example'));
    } else {
      // one main action per state: the Pay button itself when trying again can work, otherwise the way back
      if (retry) actions.push(h('button', { type: 'button', class: 'btn', onclick: pay }, 'Try again'));
      actions.push(h('a', { class: retry ? 'btn' : 'btn primary', href: '#/ideas' }, icon('back', 16), 'Back to ideas'));
    }
    notices.replaceChildren(banner(code, TITLES[code] || 'We could not create the order', err.message, actions));
    setPayLabel();
  }

  function go(approveUrl) {
    if (typeof approveUrl !== 'string' || !approveUrl.startsWith(PAYPAL_HOST)) {
      throw new ApiError('upstream', 'PayPal did not give us a sandbox page to open.');
    }
    payStatus.textContent = 'Opening PayPal’s sandbox page';
    location.assign(approveUrl);
  }

  async function pay() {
    if (busy || guard()) return;
    notices.querySelectorAll('.panel.bad').forEach((n) => n.remove());
    if (ready) {
      busy = true;
      setPayLabel();
      try {
        go(ready.approveUrl);
      } catch (e) {
        busy = false;
        ready = null;
        renderSummary();
        showError(e);
      }
      return;
    }
    const picked = selectedCards();
    if (!picked.length || !state.run || !state.run.sessionId) return;
    busy = true;
    payStatus.textContent = 'Creating your order';
    setPayLabel();
    try {
      const res = await postJson('/api/checkout', { sessionId: state.run.sessionId, itemIds: picked.map((c) => c.id) });
      if (res.total_cents !== totalCents()) {
        // The server priced it from its own saved cards and got another total: show its lines and total, and let the buyer decide.
        ready = res;
        busy = false;
        payStatus.textContent = '';
        notices.replaceChildren(
          h('p', { class: 'note warn', role: 'status' }, icon('info', 18), h('span', {}, `Our server priced this gift at ${money(res.total_cents)}, not ${money(totalCents())}. The server’s price is the one PayPal will charge. Continue only if that is fine.`)),
        );
        renderSummary();
        announce(`The server price is ${money(res.total_cents)}. Press pay to go to PayPal.`);
        return;
      }
      go(res.approveUrl);
    } catch (e) {
      busy = false;
      payStatus.textContent = '';
      showError(e instanceof ApiError ? e : new ApiError('internal', 'Something went wrong. Please try again.'));
    }
  }

  // ---- screen -----------------------------------------------------------------------------------------------------------
  const copyBtn = (label, value) => {
    const text = h('span', {}, 'Copy');
    const b = h('button', { type: 'button', class: 'btn small copy', 'aria-label': `Copy ${label.toLowerCase()}`, onclick: async () => {
      const ok = await copyText(value);
      text.textContent = ok ? 'Copied' : 'Ctrl+C'; // as short as "Copied", so the row keeps its size
      announce(ok ? `${label} copied` : `Could not copy ${label}. Select it and press Ctrl+C.`);
      setTimeout(() => (text.textContent = 'Copy'), 1800);
    } }, icon('copy', 14), text);
    return b;
  };

  const card = h(
    'dl',
    { class: 'testcard' },
    TEST_CARD.map(([label, shown, value]) => h('div', { class: 'tc-row' }, h('dt', {}, label), h('dd', {}, h('code', {}, shown)), copyBtn(label, value))),
  );

  root.append(
    h(
      'div',
      { class: 'screen checkout' },
      h('div', { class: 'screen-head' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Checkout'), h('p', { class: 'lead' }, 'Review your gift, then pay as a guest in PayPal’s sandbox.')), h('div', { class: 'head-actions' }, h('a', { class: 'btn small', href: '#/ideas' }, icon('back', 16), 'Back to ideas'))),
      cancelled ? h('p', { class: 'note info', role: 'status' }, icon('info', 18), h('span', {}, 'You cancelled on PayPal’s page, so nothing was charged. Your gift is still here.')) : null,
      notices,
      h(
        'div',
        { class: 'checkout-layout' },
        h('section', { class: 'panel summary', 'aria-labelledby': 'sum-h' }, h('h2', { id: 'sum-h' }, 'Your gift'), lines, totals, h('p', { class: 'assure' }, icon('lock', 16), h('span', {}, 'The server sets the price from the product cards it saved, not from this page, and refuses any order above your budget.'))),
        h(
          'section',
          { class: 'panel pay', 'aria-labelledby': 'pay-h' },
          h('p', { class: 'sandbox-note' }, icon('lock', 16), h('span', {}, h('strong', {}, 'Sandbox, no real money.'), ' This is PayPal’s test environment.')),
          h('h2', { id: 'pay-h' }, 'Pay with PayPal'),
          h('ol', { class: 'pay-steps' },
            h('li', {}, 'Press the button. You go to PayPal’s sandbox page.'),
            h('li', {}, 'Choose ', h('strong', {}, 'Pay with Debit or Credit Card'), ' to check out as a guest. No PayPal account is needed.'),
            h('li', {}, 'Enter this test card. Name, email, phone and address can be made up.'),
          ),
          card,
          h('p', { class: 'tip' }, icon('info', 16), h('span', {}, 'Do not create an account: press ', h('strong', {}, 'Pay now as guest'), ', or turn off ', h('strong', {}, 'Save info & create your PayPal account'), ' and press ', h('strong', {}, 'Pay Now'), '. You come back here to a receipt. If neither shows, reload PayPal’s page.')),
          payBtn,
          payStatus,
        ),
      ),
    ),
  );
  renderSummary();
  return () => {};
}
