// Screen 2: the agent works (live step list), gift ideas arrive as sections with product cards, the buyer picks items.
import { h, icon, money, safeUrl, announce, spinner } from './dom.js';
import { ApiError, streamNdjson } from './api.js';
import { budgetCents, mockNote, newRun, save, selectedCards, state, totalCents } from './state.js';

// Product images are shown by default; ?images=off (used for the demo video) or the switch hides them. Cards stay complete without them.
{
  const q = new URLSearchParams(location.search).get('images');
  let on = true;
  try {
    on = q ? q !== 'off' : sessionStorage.getItem('tasteloom.images') !== 'off';
  } catch {
    on = q !== 'off';
  }
  document.documentElement.dataset.images = on ? 'on' : 'off';
}

const MAX_ITEMS = 6;
const SKELETONS = 3;
const VIA = { live: 'live', mock: 'demo', cache: 'cached' };
const wide = window.matchMedia('(min-width: 1000px)');

const ERROR_TITLES = {
  limit: 'Live lookups are used up for now',
  upstream: 'A service we depend on is not answering',
  bad_input: 'We could not find gifts for that',
  network: 'We could not reach the server',
};

export function mountIdeas(root) {
  let ctl = null;
  let run = null;
  const cardEls = new Map(); // card id -> { card, btn, root, check }
  const ideaEls = new Map(); // idea id -> { reason, section }
  const phaseEls = new Map(); // phase id -> { li, icon, note, calls }

  // ---- skeleton of the screen -------------------------------------------------------------------------------------------
  const lovesEl = h('p', { class: 'loves' });
  const imagesSwitch = h(
    'button',
    {
      type: 'button',
      class: 'switch',
      role: 'switch',
      'aria-checked': document.documentElement.dataset.images === 'on' ? 'true' : 'false',
      onclick: () => {
        const on = document.documentElement.dataset.images !== 'on';
        document.documentElement.dataset.images = on ? 'on' : 'off';
        imagesSwitch.setAttribute('aria-checked', String(on));
        try {
          sessionStorage.setItem('tasteloom.images', on ? 'on' : 'off');
        } catch {
          // preference is only a convenience
        }
      },
    },
    h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })),
    h('span', {}, 'Product images'),
  );
  const notices = h('div', { class: 'notices' });
  const list = h('div', { class: 'ideas-list' });
  const barRoot = h('div', { class: 'bar', hidden: true });
  const agentStatus = h('span', { class: 'agent-status' });
  const phasesEl = h('ol', { class: 'phases' });
  const demoNote = h('p', { class: 'demo-note', hidden: true });
  const agentTitle = h('span', { class: 'agent-title' }, 'The agent at work');
  const agentH = h('h2', { class: 'agent-h' });
  const agentBody = h('div', { class: 'agent-body', id: 'agent-body' }, phasesEl, demoNote);
  const agent = h('aside', { class: 'agent', 'aria-label': 'Agent steps', 'data-open': String(wide.matches) }, agentH, agentBody);
  // Wide screens show the step list as a side panel; narrow screens fold it into an accordion whose header still shows the live status.
  function agentHead() {
    if (wide.matches) {
      agent.dataset.open = 'true';
      agentH.replaceChildren(h('div', { class: 'agent-head' }, agentTitle, agentStatus));
      return;
    }
    const toggle = h('button', { type: 'button', class: 'agent-toggle', 'aria-expanded': agent.dataset.open, 'aria-controls': 'agent-body', onclick: () => {
      agent.dataset.open = String(agent.dataset.open !== 'true');
      toggle.setAttribute('aria-expanded', agent.dataset.open);
    } }, agentTitle, agentStatus);
    agentH.replaceChildren(toggle);
  }
  const onWide = () => {
    agent.dataset.open = String(wide.matches);
    agentHead();
  };
  wide.addEventListener('change', onWide);
  agentHead();

  root.append(
    h(
      'div',
      { class: 'screen ideas' },
      h('div', { class: 'screen-head' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Gift ideas'), lovesEl), h('div', { class: 'head-actions' }, h('a', { class: 'btn ghost small', href: '#/' }, icon('back', 16), 'Edit favourites'), imagesSwitch)),
      h('div', { class: 'ideas-layout' }, agent, h('div', { class: 'col-main' }, notices, list, barRoot)),
    ),
  );

  // ---- agent step list --------------------------------------------------------------------------------------------------
  function buildPhases() {
    phasesEl.replaceChildren();
    phaseEls.clear();
    for (const p of run.phases) {
      const ic = h('span', { class: 'ph-icon', 'aria-hidden': 'true' });
      const note = h('p', { class: 'ph-note' });
      const calls = h('ul', { class: 'calls' });
      const seeds = p.id === 'taste' ? h('ul', { class: 'seeds', 'aria-label': 'What Qloo understood' }) : null;
      const li = h('li', { class: 'phase', 'data-state': 'pending', id: `ph-${p.id}` }, ic, h('div', { class: 'ph-body' }, h('p', { class: 'ph-label' }, p.label), note, seeds, calls));
      phasesEl.append(li);
      phaseEls.set(p.id, { li, ic, note, calls, seeds, label: li.querySelector('.ph-label') });
      setPhase(p);
    }
  }

  function setPhase(p) {
    const el = phaseEls.get(p.id);
    if (!el) return;
    el.li.dataset.state = p.state;
    el.ic.replaceChildren(p.state === 'running' ? spinner() : p.state === 'done' ? icon('check', 14) : p.state === 'error' ? icon('x', 14) : p.state === 'skipped' ? icon('dash', 14) : '');
    el.note.textContent = p.note || '';
    el.note.hidden = !p.note;
  }

  function callPhase(c) {
    if (c.tool === 'tavily_search') return 'prices';
    if (c.tool === 'find_products') return 'products';
    if (c.tool === 'nemotron') return /write/i.test(c.arg) ? 'write' : /choose/i.test(c.arg) ? 'products' : phaseNow();
    return 'taste';
  }
  const phaseNow = () => (run.phases.find((p) => p.state === 'running' && (p.id === 'taste' || p.id === 'products')) || run.phases[0]).id;

  function addCall(c) {
    const el = phaseEls.get(callPhase(c));
    if (!el) return;
    el.calls.append(
      h(
        'li',
        { class: 'call', 'data-ok': String(c.ok) },
        h('code', { class: 'tool' }, c.tool),
        c.arg ? h('span', { class: 'arg' }, c.arg) : null,
        h('span', { class: 'out' }, c.ok ? c.out : `failed: ${c.out}`),
        h('span', { class: 'meta' }, `${c.ms} ms`, ' · ', h('span', { class: `via via-${c.via}` }, VIA[c.via] || c.via)),
      ),
    );
  }

  function setSeeds(seeds) {
    const el = phaseEls.get('taste');
    if (!el || !el.seeds) return;
    el.seeds.replaceChildren(...seeds.map((s) => h('li', { class: 'pill-soft' }, s.name, h('span', { class: 'pill-type' }, s.type.replace('_', ' ')))));
  }

  function setAgentStatus() {
    agentStatus.replaceChildren();
    if (run.status === 'running') {
      const p = run.phases.find((x) => x.state === 'running');
      agentStatus.append(spinner(), h('span', {}, p ? p.label : 'Starting'));
    } else if (run.status === 'done') {
      const n = run.calls.length;
      agentStatus.append(icon('check', 14), h('span', {}, `Done in ${(run.ms / 1000).toFixed(1)} s · ${n} tool call${n === 1 ? '' : 's'}`));
    } else {
      agentStatus.append(icon('alert', 14), h('span', {}, 'Stopped'));
    }
  }

  // ---- ideas and cards --------------------------------------------------------------------------------------------------
  function skeletonIdea() {
    return h('div', { class: 'idea skeleton', 'aria-hidden': 'true' }, h('div', { class: 'sk-line w40' }), h('div', { class: 'sk-line w70' }), h('div', { class: 'sk-line w55' }), h('div', { class: 'cards' }, [1, 2, 3].map(() => h('div', { class: 'sk-card' }))));
  }

  function remaining() {
    return budgetCents() - totalCents();
  }

  function refreshCard(entry) {
    const { card, btn, root: el } = entry;
    const picked = state.selected.includes(card.id);
    const full = !picked && state.selected.length >= MAX_ITEMS;
    const over = !picked && card.price_cents > remaining();
    el.dataset.selected = String(picked);
    btn.disabled = full || over;
    const text = picked ? 'Remove' : full ? 'Gift is full' : over ? 'Over budget' : 'Add to gift';
    btn.setAttribute('aria-label', `${text}: ${card.title}`); // starts with the visible text
    btn.replaceChildren(picked ? icon('x', 16) : over || full ? '' : icon('plus', 16), h('span', {}, text));
  }

  function toggleCard(card) {
    const i = state.selected.indexOf(card.id);
    if (i >= 0) {
      state.selected.splice(i, 1);
      announce(`Removed ${card.title}. ${selectionSummary()}`);
    } else {
      if (card.price_cents > remaining() || state.selected.length >= MAX_ITEMS) return;
      state.selected.push(card.id);
      announce(`Added ${card.title}. ${selectionSummary()}`);
    }
    save();
    renderBar();
    cardEls.forEach(refreshCard);
  }

  function selectionSummary() {
    const n = state.selected.length;
    return `${n} item${n === 1 ? '' : 's'}, ${money(totalCents())} of ${money(budgetCents())}.`;
  }

  function cardEl(card, idea) {
    const shopUrl = safeUrl(card.url);
    const img = card.image && safeUrl(card.image);
    const media = h('div', { class: 'media' }, img ? h('img', { src: img, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', width: '320', height: '240', onload: (e) => { e.target.dataset.ok = '1'; }, onerror: (e) => e.target.remove() }) : null, h('span', { class: 'ph', 'aria-hidden': 'true' }, card.title.trim().charAt(0).toUpperCase()), card.purchasable ? h('span', { class: 'sel-tag', 'aria-hidden': 'true' }, icon('check', 12), 'In your gift') : null);
    const el = h('li', { class: 'card', 'data-kind': card.purchasable ? 'product' : 'link', 'data-selected': 'false' });
    const link = shopUrl
      ? h('a', { class: 'shop-link', href: shopUrl, target: '_blank', rel: 'noopener noreferrer sponsored' }, card.purchasable ? 'View product' : 'Open page', icon('external', 14), h('span', { class: 'sr-only' }, ' (opens in a new tab)'))
      : null;
    const check = h('p', { class: 'check', hidden: true, 'data-id': card.id }, icon('check', 14), h('span', {}, 'Price matches the shop’s page'));
    el.append(
      media,
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'card-title' }, card.title),
        h('p', { class: 'card-meta' }, h('span', { class: 'shop' }, card.shop), card.purchasable ? h('span', { class: 'price' }, money(card.price_cents)) : null),
        card.purchasable ? check : card.snippet ? h('p', { class: 'snippet' }, card.snippet) : null,
        h('div', { class: 'card-actions' }, link, card.purchasable ? null : h('span', { class: 'hint-inline' }, 'Price is on the venue’s site')),
      ),
    );
    if (card.purchasable) {
      const btn = h('button', { type: 'button', class: 'pick', onclick: () => toggleCard(card) });
      el.querySelector('.card-actions').append(btn);
      const entry = { card, btn, root: el, check };
      cardEls.set(card.id, entry);
      refreshCard(entry);
      const c = run.checks[card.id];
      if (c && c.state === 'confirmed') check.hidden = false;
    }
    return el;
  }

  function addIdea({ idea, cards }) {
    const because = idea.because.length
      ? h('p', { class: 'because' }, h('span', { class: 'because-lbl' }, 'Because they love'), h('ul', { class: 'pills' }, idea.because.map((b) => h('li', { class: 'pill-soft' }, b))))
      : h('p', { class: 'because' }, h('span', { class: 'because-lbl' }, 'Fits their overall taste'));
    const reasonText = run.reasons[idea.id];
    const reason = h('div', { class: 'reason', 'data-state': reasonText ? 'ready' : 'pending' }, reasonText ? reasonText : [h('span', { class: 'sk-line w100' }), h('span', { class: 'sk-line w60' })]);
    const section = h(
      'article',
      { class: 'idea', 'aria-labelledby': `idea-${idea.id}` },
      h('header', { class: 'idea-head' }, h('p', { class: 'kind' }, idea.kind === 'experience' ? 'Experience' : 'Gift'), h('h2', { id: `idea-${idea.id}` }, idea.title), because, reason),
      h('ul', { class: 'cards' }, cards.map((c) => cardEl(c, idea))),
    );
    ideaEls.set(idea.id, { reason, section });
    const sk = list.querySelector('.idea.skeleton');
    if (sk) list.insertBefore(section, sk);
    else list.append(section);
    if (sk) sk.remove();
  }

  function setReasons(map) {
    for (const [id, text] of Object.entries(map)) {
      const el = ideaEls.get(id);
      if (!el || typeof text !== 'string') continue;
      el.reason.dataset.state = 'ready';
      el.reason.replaceChildren(text);
    }
  }

  function setCheck(c) {
    const entry = cardEls.get(c.cardId);
    if (entry && c.state === 'confirmed') entry.check.hidden = false;
  }

  // ---- bar --------------------------------------------------------------------------------------------------------------
  function renderBar() {
    const sel = selectedCards();
    const total = totalCents();
    const budget = budgetCents();
    const pct = budget > 0 ? Math.min(100, (total / budget) * 100) : 0;
    const meter = h('div', { class: 'meter', role: 'meter', 'aria-label': 'Budget used', 'aria-valuemin': '0', 'aria-valuemax': String(budget), 'aria-valuenow': String(total), 'aria-valuetext': `${money(total)} of ${money(budget)}`, 'data-level': pct > 90 ? 'high' : 'ok' }, h('span', { class: 'fill' }));
    meter.firstChild.style.setProperty('--p', pct.toFixed(1));
    barRoot.replaceChildren(
      h(
        'div',
        { class: 'bar-main' },
        h(
          'div',
          { class: 'bar-sum' },
          h('p', { class: 'bar-count' }, sel.length ? [h('strong', {}, `${sel.length} item${sel.length === 1 ? '' : 's'}`), ` · ${money(total)}`, h('span', { class: 'of' }, ` of ${money(budget)}`)] : [h('strong', {}, `Pick up to ${MAX_ITEMS} items`), h('span', { class: 'of' }, ` · ${money(budget)} budget`)]),
          meter,
        ),
        h('button', { type: 'button', class: 'btn primary', disabled: sel.length === 0, onclick: () => (location.hash = '#/checkout') }, 'Review and pay', icon('arrow', 16)),
      ),
    );
    barRoot.hidden = run.ideas.length === 0;
  }

  // ---- notices ----------------------------------------------------------------------------------------------------------
  function showError(err) {
    const partial = run.ideas.some((i) => i.cards.some((c) => c.purchasable)); // only buyable ideas count as a usable partial result
    const code = err.code || 'internal';
    const title = partial ? 'The agent stopped early' : ERROR_TITLES[code] || 'Something went wrong';
    const again = !run.example && code !== 'bad_input';
    const actions = [];
    if (again) actions.push(h('button', { type: 'button', class: 'btn' + (code === 'limit' ? '' : ' primary'), onclick: () => restart('live') }, 'Try again'));
    if (code === 'bad_input') actions.push(h('a', { class: 'btn primary', href: '#/' }, icon('back', 16), 'Change favourites or budget'));
    actions.push(h('button', { type: 'button', class: 'btn' + (code === 'limit' || code === 'upstream' ? ' primary' : ' ghost'), onclick: () => restart('example') }, 'Try an example'));
    notices.append(
      h(
        'section',
        { class: 'panel ' + (partial ? 'warn' : 'bad'), role: 'alert' },
        h('div', { class: 'panel-icon' }, icon('alert', 22)),
        h('div', { class: 'panel-body' }, h('h2', {}, title), h('p', {}, partial ? `${err.message} You can still pick from the ideas below, or try again.` : err.message), h('div', { class: 'panel-actions' }, actions)),
      ),
    );
    announce(`${title}. ${err.message}`);
  }

  function restart(mode) {
    state.pending = { mode };
    window.dispatchEvent(new Event('tasteloom:reroute'));
  }

  // ---- stream events ----------------------------------------------------------------------------------------------------
  function onEvent(e) {
    switch (e.t) {
      case 'meta':
        run.sessionId = e.session;
        run.budget_cents = e.budget_cents;
        run.mocks = e.mocks || [];
        run.example = !!e.example;
        run.asOf = e.asOf || '';
        if (e.favorites) run.favorites = e.favorites;
        showHeader();
        window.dispatchEvent(new Event('tasteloom:badges'));
        break;
      case 'phase': {
        const p = run.phases.find((x) => x.id === e.id);
        if (!p) break;
        p.state = e.state;
        p.note = e.note || '';
        setPhase(p);
        setAgentStatus();
        if (e.state === 'running') announce(e.label);
        break;
      }
      case 'call':
        run.calls.push(e);
        addCall(e);
        break;
      case 'taste':
        run.seeds = e.seeds;
        setSeeds(e.seeds);
        break;
      case 'idea':
        run.ideas.push({ idea: e.idea, cards: e.cards });
        addIdea({ idea: e.idea, cards: e.cards });
        renderBar();
        announce(`Idea ${run.ideas.length}: ${e.idea.title}`);
        break;
      case 'reasons':
        Object.assign(run.reasons, e.reasons);
        setReasons(e.reasons);
        break;
      case 'check':
        run.checks[e.cardId] = e;
        setCheck(e);
        break;
      case 'done':
        run.tier = e.tier;
        finish();
        break;
      case 'error':
        run.status = 'error';
        run.error = e;
        fail(new ApiError(e.code, e.message));
        break;
    }
  }

  function finish() {
    run.status = 'done';
    run.ms = Date.now() - run.startedAt;
    list.querySelectorAll('.idea.skeleton').forEach((n) => n.remove());
    ideaEls.forEach((el) => {
      if (el.reason.dataset.state === 'pending') el.reason.hidden = true;
    });
    run.phases.forEach((p) => {
      if (p.state === 'running' || p.state === 'pending') {
        p.state = 'skipped';
        setPhase(p);
      }
    });
    setAgentStatus();
    save();
    announce(`Done. ${run.ideas.length} gift ideas. Pick the items you like.`);
    if (!run.ideas.length) showEmpty();
  }

  function showEmpty() {
    notices.append(
      h('section', { class: 'panel', role: 'status' }, h('div', { class: 'panel-body' }, h('h2', {}, 'No ideas to show'), h('p', {}, 'Try a higher budget or different favourites, or look at the example.'), h('div', { class: 'panel-actions' }, h('a', { class: 'btn primary', href: '#/' }, 'Change favourites'), h('button', { type: 'button', class: 'btn', onclick: () => restart('example') }, 'Try an example')))),
    );
  }

  function fail(err) {
    run.status = 'error';
    run.ms = Date.now() - run.startedAt;
    list.querySelectorAll('.idea.skeleton').forEach((n) => n.remove());
    ideaEls.forEach((el) => {
      if (el.reason.dataset.state === 'pending') el.reason.hidden = true;
    });
    run.phases.forEach((p) => {
      if (p.state === 'running') {
        p.state = 'error';
        setPhase(p);
      }
    });
    setAgentStatus();
    agent.dataset.open = 'true';
    agentHead();
    showError(err);
    if (run.ideas.length) save();
  }

  function showHeader() {
    const names = run.favorites.map((f) => f.text);
    lovesEl.replaceChildren(
      h('span', { class: 'loves-lbl' }, 'Based on'),
      h('ul', { class: 'pills' }, names.map((n) => h('li', { class: 'pill-soft' }, n))),
      h('span', { class: 'budget' }, `Budget ${money(run.budget_cents)}`),
    );
    notices.querySelectorAll('.example-note').forEach((n) => n.remove());
    if (run.example) {
      notices.prepend(h('p', { class: 'note info example-note' }, icon('info', 18), h('span', {}, `Saved example${run.asOf ? `, recorded ${run.asOf}` : ''}. Prices are from that day. The checkout is a live PayPal sandbox order.`)));
    }
    if (run.mocks.length) {
      demoNote.hidden = false;
      demoNote.textContent = mockNote(run.mocks);
    }
  }

  // ---- start ------------------------------------------------------------------------------------------------------------
  async function start(mode) {
    ctl = new AbortController();
    const body = mode === 'example' ? {} : { favorites: run.favorites.map((f) => ({ text: f.text, ...(f.type ? { type: f.type } : {}) })), budget_usd: state.budget };
    for (let i = 0; i < SKELETONS; i++) list.append(skeletonIdea());
    try {
      await streamNdjson(mode === 'example' ? '/api/sample' : '/api/ideas', body, onEvent, ctl.signal);
      if (run.status === 'running') fail(new ApiError('network', 'The connection closed before the agent finished. Try again, or try the example.'));
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      if (run.status === 'running') fail(e instanceof ApiError ? e : new ApiError('internal', 'Something went wrong. Please try again.'));
    }
  }

  function restore() {
    run = state.run;
    buildPhases();
    showHeader();
    run.calls.forEach(addCall);
    setSeeds(run.seeds);
    run.ideas.forEach(addIdea);
    setReasons(run.reasons);
    run.ideas.forEach(({ idea }) => {
      const el = ideaEls.get(idea.id);
      if (el && el.reason.dataset.state === 'pending') el.reason.hidden = true;
    });
    setAgentStatus();
    renderBar();
    cardEls.forEach(refreshCard);
  }

  if (state.pending) {
    const mode = state.pending.mode;
    state.pending = null;
    state.selected = [];
    run = newRun(mode === 'example' ? { favorites: [], budget_cents: 0, example: true } : { favorites: state.favorites, budget_cents: Math.round(state.budget * 100), example: false });
    state.run = run;
    buildPhases();
    showHeader();
    setAgentStatus();
    if (mode === 'example') lovesEl.replaceChildren(h('span', { class: 'loves-lbl' }, 'Loading the saved example'));
    start(mode);
  } else {
    restore();
  }

  return () => {
    if (ctl) ctl.abort();
    wide.removeEventListener('change', onWide);
    if (state.run && state.run.status !== 'done') state.run = null; // an unfinished run cannot be resumed
  };
}
