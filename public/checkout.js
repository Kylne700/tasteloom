// Screen 3: review the picks, then pay as a guest in the PayPal sandbox. The server prices the order from its own saved cards;
// the page only sends the session id and the picked card ids.
import { h, icon, money, safeUrl, announce, copyText, spinner } from './dom.js';
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
  limit: 'Sandbox orders are paused for today',
  upstream: 'PayPal is not answering',
  network: 'We could not reach the server',
};
const RETRY = new Set(['upstream', 'network', 'internal', 'http']);

export function mountCheckout(root, { cancelled }) {
  let busy = false;
  let ready = null; // the server's answer, held back when its total differs from what the page shows

  const notices = h('div', { class: 'notices' });
  const lines = h('ul', { class: 'lines' });
  const totals = h('dl', { class: 'totals' });
  const payLabel = h('span', {});
  const payBtn = h('button', { type: 'button', class: 'btn primary big pay-btn', onclick: pay }, payLabel);
  const payStatus = h('p', { class: 'pay-status', role: 'status' });

  // ---- order summary ----------------------------------------------------------------------------------------------------
  function thumb(card) {
    const img = card.image && safeUrl(card.image);
    return h('div', { class: 'thumb' }, img ? h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', width: '64', height: '64', onload: (e) => { e.target.dataset.ok = '1'; }, onerror: (e) => e.target.remove() }) : null, h('span', { class: 'ph', 'aria-hidden': 'true' }, card.title.trim().charAt(0).toUpperCase()));
  }

  function remove(card) {
    const i = state.selected.indexOf(card.id);
    if (i >= 0) state.selected.splice(i, 1);
    ready = null;
    save();
    announce(`Removed ${card.title}.`);
    if (!state.selected.length) {
      location.hash = '#/ideas';
      return;
    }
    renderSummary();
  }

  function renderSummary() {
    const cards = selectedCards();
    const total = totalCents();
    const budget = budgetCents();
    lines.replaceChildren(
      ...cards.map((c) =>
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
      h('div', { class: 'row' }, h('dt', {}, 'Left over'), h('dd', {}, money(Math.max(0, budget - total)))),
    );
    setPayLabel();
  }

  function setPayLabel() {
    const total = ready ? ready.total_cents : totalCents();
    payBtn.disabled = busy;
    payBtn.replaceChildren(busy ? spinner() : icon('lock', 18), h('span', {}, busy ? 'Opening PayPal' : ready ? `Continue to PayPal for ${money(total)}` : `Pay ${money(total)} with PayPal`));
    payBtn.setAttribute('aria-busy', String(busy));
  }

  // ---- paying -----------------------------------------------------------------------------------------------------------
  function showError(err) {
    const code = err.code || 'internal';
    const expired = code === 'session_expired';
    const actions = [];
    if (RETRY.has(code)) actions.push(h('button', { type: 'button', class: 'btn primary', onclick: pay }, 'Try again'));
    if (expired) {
      actions.push(h('button', { type: 'button', class: 'btn primary', onclick: () => { startOver(); location.hash = '#/'; } }, 'Start over'));
      actions.push(h('button', { type: 'button', class: 'btn', onclick: () => { startOver(); state.pending = { mode: 'example' }; location.hash = '#/ideas'; } }, 'Try an example'));
    } else {
      actions.push(h('a', { class: 'btn' + (RETRY.has(code) ? ' ghost' : ' primary'), href: '#/ideas' }, icon('back', 16), 'Back to ideas'));
    }
    notices.replaceChildren(
      h('section', { class: 'panel bad', role: 'alert' }, h('div', { class: 'panel-icon' }, icon('alert', 22)), h('div', { class: 'panel-body' }, h('h2', {}, TITLES[code] || 'We could not create the order'), h('p', {}, err.message), h('div', { class: 'panel-actions' }, actions))),
    );
    announce(`${TITLES[code] || 'We could not create the order'}. ${err.message}`);
  }

  function go(approveUrl) {
    if (typeof approveUrl !== 'string' || !approveUrl.startsWith(PAYPAL_HOST)) {
      throw new ApiError('upstream', 'PayPal did not give us a sandbox page to open. Please try again.');
    }
    payStatus.textContent = 'Opening PayPal’s sandbox page';
    location.assign(approveUrl);
  }

  async function pay() {
    if (busy) return;
    notices.querySelectorAll('.panel.bad').forEach((n) => n.remove());
    if (ready) {
      busy = true;
      setPayLabel();
      try {
        go(ready.approveUrl);
      } catch (e) {
        busy = false;
        ready = null;
        setPayLabel();
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
        // The server priced it from its own saved cards and got another total: show that and let the buyer decide.
        ready = res;
        busy = false;
        payStatus.textContent = '';
        setPayLabel();
        notices.replaceChildren(
          h('p', { class: 'note warn', role: 'status' }, icon('info', 18), h('span', {}, `Our server priced this gift at ${money(res.total_cents)}, not ${money(totalCents())}. The server’s price is the one PayPal will charge. Continue only if that is fine.`)),
        );
        announce(`The server price is ${money(res.total_cents)}. Press continue to go to PayPal.`);
        return;
      }
      go(res.approveUrl);
    } catch (e) {
      busy = false;
      payStatus.textContent = '';
      setPayLabel();
      showError(e instanceof ApiError ? e : new ApiError('internal', 'Something went wrong. Please try again.'));
    }
  }

  // ---- screen -----------------------------------------------------------------------------------------------------------
  const copyBtn = (label, value) => {
    const text = h('span', {}, 'Copy');
    const b = h('button', { type: 'button', class: 'btn small copy', 'aria-label': `Copy ${label.toLowerCase()}`, onclick: async () => {
      const ok = await copyText(value);
      text.textContent = ok ? 'Copied' : 'Press Ctrl+C';
      announce(ok ? `${label} copied` : `Could not copy ${label}`);
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
      h('div', { class: 'screen-head' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Checkout'), h('p', { class: 'lead' }, 'Review your gift, then pay as a guest in PayPal’s sandbox.')), h('div', { class: 'head-actions' }, h('a', { class: 'btn ghost small', href: '#/ideas' }, icon('back', 16), 'Back to ideas'))),
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
          h('p', { class: 'tip' }, icon('info', 16), h('span', {}, 'Turn off ', h('strong', {}, 'Save info & create your PayPal account'), ', then press ', h('strong', {}, 'Pay Now'), '. You come back here to a receipt. If PayPal only offers to create an account, reload its page.')),
          payBtn,
          payStatus,
        ),
      ),
    ),
  );
  renderSummary();
  return () => {};
}
