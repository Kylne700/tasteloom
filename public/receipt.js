// Last step: the receipt. Everything shown here is read back from the server (order id, final status, amounts), not from the URL.
import { h, icon, money, announce, copyText, spinner } from './dom.js';
import { ApiError, getJson } from './api.js';
import { startOver, state } from './state.js';

const HEAD = {
  COMPLETED: ['Order confirmed', 'ok', 'Paid in the PayPal sandbox. Sandbox, no real money moved.'],
  CAPTURE_FAILED: ['Payment not completed', 'bad', ''],
  NOT_APPROVED: ['Payment not approved yet', 'warn', ''],
  CREATED: ['Waiting for your approval on PayPal', 'warn', ''],
  CANCELLED: ['Payment cancelled', 'warn', ''],
};
const STATUS_TEXT = {
  CAPTURE_FAILED: 'PayPal did not finish the payment. Nothing was charged.',
  NOT_APPROVED: 'PayPal does not show this order as approved. Nothing was charged.',
  CREATED: 'The order exists, but it has not been approved on PayPal’s page yet. Nothing was charged.',
  CANCELLED: 'You cancelled on PayPal’s page. Nothing was charged.',
};

export function mountReceipt(root, { orderId }) {
  let alive = true;
  const title = h('h1', { tabindex: '-1' }, 'Getting your receipt');
  const sub = h('p', { class: 'lead' });
  const hero = h('div', { class: 'hero' }, h('span', { class: 'hero-icon', 'data-tone': 'wait', 'aria-hidden': 'true' }, spinner()), h('div', {}, title, sub));
  const body = h('div', { class: 'receipt-body' }, h('div', { class: 'sk-card tall', 'aria-hidden': 'true' }));
  root.append(h('div', { class: 'screen receipt' }, h('section', { class: 'panel receipt-card', 'aria-live': 'polite' }, hero, body)));

  function head(text, tone, ico, subtitle = '') {
    title.textContent = text;
    sub.textContent = subtitle;
    hero.querySelector('.hero-icon').dataset.tone = tone;
    hero.querySelector('.hero-icon').replaceChildren(icon(ico, 26));
    announce(`${text}. ${subtitle}`);
  }

  function fact(label, value, copy) {
    const copied = h('span', {}, 'Copy');
    return h(
      'div',
      { class: 'fact' },
      h('dt', {}, label),
      h('dd', {}, value, copy ? h('button', { type: 'button', class: 'btn small copy', 'aria-label': `Copy ${label.toLowerCase()}`, onclick: async () => {
        const ok = await copyText(copy);
        copied.textContent = ok ? 'Copied' : 'Press Ctrl+C';
        announce(ok ? `${label} copied` : `Could not copy ${label}`);
        setTimeout(() => (copied.textContent = 'Copy'), 1800);
      } }, icon('copy', 14), copied) : null),
    );
  }

  const again = () => {
    startOver();
    location.hash = '#/';
  };

  function showOrder(o) {
    const [text, tone, subtitle] = HEAD[o.status] || ['Order status', 'warn', ''];
    const done = o.status === 'COMPLETED';
    head(text, tone, done ? 'check' : o.status === 'CAPTURE_FAILED' ? 'alert' : 'info', subtitle || STATUS_TEXT[o.status] || '');
    const canRetry = o.status === 'CAPTURE_FAILED' || o.status === 'NOT_APPROVED' || o.status === 'CREATED';
    const haveGift = !!(state.run && state.selected.length);
    const actions = [];
    if (done) actions.push(h('button', { type: 'button', class: 'btn primary big', onclick: again }, 'Start a new gift', icon('arrow', 18)));
    else {
      if (o.status === 'CAPTURE_FAILED') actions.push(h('a', { class: 'btn primary big', href: `/api/return?token=${encodeURIComponent(o.id)}` }, 'Check and try again'));
      actions.push(haveGift ? h('a', { class: 'btn big' + (o.status === 'CAPTURE_FAILED' ? '' : ' primary'), href: '#/checkout' }, icon('back', 16), 'Back to checkout') : h('button', { type: 'button', class: 'btn big primary', onclick: again }, 'Start a new gift'));
      if (canRetry && o.status !== 'CAPTURE_FAILED') actions.push(h('a', { class: 'btn big ghost', href: `/api/return?token=${encodeURIComponent(o.id)}` }, 'I approved it, check again'));
    }
    body.replaceChildren(
      o.error && !done ? h('p', { class: 'note ' + (tone === 'bad' ? 'bad' : 'warn'), role: 'status' }, icon('alert', 18), h('span', {}, o.error)) : null,
      h(
        'dl',
        { class: 'facts' },
        fact('Order id', h('code', {}, o.id), o.id),
        fact('Status', h('span', { class: 'status-pill', 'data-status': o.status }, o.status)),
        done && o.captureId ? fact('Payment id', h('code', {}, o.captureId), o.captureId) : null,
        fact('Total', h('strong', {}, `${money(o.total_cents)} ${o.currency}`)),
        fact('Mode', 'PayPal sandbox, no real money'),
      ),
      h('h2', { class: 'small-h' }, 'Items'),
      h('ul', { class: 'lines plain' }, o.lines.map((l) => h('li', { class: 'line' }, h('div', { class: 'line-body' }, h('p', { class: 'line-title' }, l.title), h('p', { class: 'line-shop' }, l.shop)), h('span', { class: 'line-price' }, money(l.price_cents))))),
      o.trace && o.trace.length ? h('details', { class: 'trace' }, h('summary', {}, 'What the agent did for this order'), h('ul', {}, o.trace.map((t) => h('li', {}, t)))) : null,
      h('div', { class: 'receipt-actions' }, actions),
    );
  }

  function showProblem(err) {
    const missing = err.code === 'not_found';
    head(missing ? 'We could not find that order' : 'We could not load your receipt', 'bad', 'alert', missing ? 'It may be older than a week, or the link is wrong.' : err.message);
    body.replaceChildren(h('div', { class: 'receipt-actions' }, missing ? null : h('button', { type: 'button', class: 'btn primary big', onclick: load }, 'Try again'), h('button', { type: 'button', class: 'btn big' + (missing ? ' primary' : ''), onclick: again }, 'Start a new gift')));
  }

  async function load() {
    try {
      const o = await getJson(`/api/orders/${encodeURIComponent(orderId)}`);
      if (alive) showOrder(o);
    } catch (e) {
      if (alive) showProblem(e instanceof ApiError ? e : new ApiError('internal', 'Something went wrong. Please try again.'));
    }
  }

  load();
  return () => {
    alive = false;
  };
}
