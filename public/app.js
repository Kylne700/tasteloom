// Tasteloom front end: hash routes, step indicator and the four screens. No framework, no build step.
import { h, icon } from './dom.js';
import { getJson } from './api.js';
import { load, state } from './state.js';
import { mountTaste } from './taste.js';
import { mountIdeas } from './ideas.js';
import { mountCheckout } from './checkout.js';
import { mountReceipt } from './receipt.js';

const view = document.getElementById('view');
const stepsEl = document.getElementById('steps');
const demoBadge = document.getElementById('demo-badge');
let unmount = null;

const STEPS = [
  { label: 'Their taste', href: '#/' },
  { label: 'Gift ideas', href: '#/ideas' },
  { label: 'Checkout', href: '#/checkout' },
];

function renderSteps(current, finished = false) {
  const canGo = [true, !!state.run, !!state.run && state.selected.length > 0];
  stepsEl.replaceChildren(
    ...STEPS.map((s, i) => {
      const n = i + 1;
      const isCurrent = n === current && !finished;
      const done = n < current || (finished && n === current);
      const body = [h('span', { class: 'dot' }, done ? icon('check', 14) : String(n)), h('span', { class: 'label' }, s.label)];
      const inner = !isCurrent && canGo[i] && n < current ? h('a', { href: s.href }, body) : h('span', { class: 'step-text' }, body);
      return h('li', { class: 'step' + (isCurrent ? ' current' : '') + (done ? ' done' : ''), 'aria-current': isCurrent ? 'step' : null }, inner);
    }),
  );
}

function updateBadges() {
  const mocks = (state.run && state.run.mocks.length ? state.run.mocks : state.status && state.status.mocks) || [];
  demoBadge.hidden = mocks.length === 0;
}

function parse() {
  const raw = location.hash || '#/';
  const [path, query = ''] = raw.split('?');
  return { path, params: new URLSearchParams(query) };
}

function go(hash) {
  location.replace(hash);
}

function route() {
  if (unmount) {
    unmount();
    unmount = null;
  }
  const { path, params } = parse();
  let title = 'Gifts that understand them';
  let step = 1;
  let mount = mountTaste;
  let arg = {};
  const receipt = path.match(/^#\/receipt\/([A-Za-z0-9]+)$/);
  if (path === '#/ideas') {
    if (!state.pending && !state.run) return go('#/');
    mount = mountIdeas;
    step = 2;
    title = 'Gift ideas';
  } else if (path === '#/checkout') {
    if (!state.run) return go('#/');
    if (!state.selected.length) return go('#/ideas');
    mount = mountCheckout;
    step = 3;
    title = 'Checkout';
    arg = { cancelled: params.get('cancelled') === '1' };
  } else if (receipt) {
    mount = mountReceipt;
    step = 3;
    title = 'Receipt';
    arg = { orderId: receipt[1] };
  }
  document.title = `${title} · Tasteloom`;
  renderSteps(step);
  view.replaceChildren();
  window.scrollTo(0, 0);
  try {
    unmount = mount(view, arg) || null;
  } catch (e) {
    console.error(e);
    view.replaceChildren(
      h('section', { class: 'panel bad' }, h('h1', { tabindex: '-1' }, 'Something broke on this page'), h('p', {}, 'Please reload, or start again.'), h('a', { class: 'btn primary', href: '#/' }, 'Start again')),
    );
  }
  updateBadges();
  const heading = view.querySelector('h1');
  if (heading) heading.focus({ preventScroll: true });
}

load();
window.addEventListener('tasteloom:badges', updateBadges);
window.addEventListener('tasteloom:receipt', (e) => renderSteps(3, !!(e.detail && e.detail.completed))); // only a captured payment ticks the last step
window.addEventListener('tasteloom:reroute', route); // the ideas screen asks for a fresh run (try again, try an example)
window.addEventListener('hashchange', route);
window.addEventListener('pageshow', (e) => {
  if (e.persisted) route(); // back from PayPal's page: rebuild instead of showing a frozen "creating your order"
});
route();
getJson('/api/status')
  .then((s) => {
    state.status = s;
    updateBadges();
    window.dispatchEvent(new Event('tasteloom:status'));
  })
  .catch(() => {
    // the screens report their own errors; the badge simply stays hidden
  });
