// Screen 2: the agent works (live step list), gift ideas arrive as sections with product cards, the buyer picks items.
import { h, icon, money, safeUrl, shopImage, announce, spinner, copyText } from './dom.js';
import { MEMORY, noteFor } from './note.js';
import { ApiError, streamNdjson } from './api.js';
import { budgetCents, lookupCount, mockNote, newRun, save, selectedCards, state, totalCents } from './state.js';
import { mountCompare } from './compare.js';

// Product images come from the shops' servers, which see the visitor's IP, so none loads until the switch (or ?images=on) turns
// them on; ?images=off keeps them off. Cards stay complete without them.
{
  const q = new URLSearchParams(location.search).get('images');
  let on = q === 'on';
  try {
    on = q ? q === 'on' : sessionStorage.getItem('tasteloom.images') === 'on';
  } catch {
    // no storage: the address alone decides
  }
  document.documentElement.dataset.images = on ? 'on' : 'off';
}

const MAX_ITEMS = 6;
const SKELETONS = 3;

// A shop host breaks after a dot, not in the middle of a word, when a narrow card is too small for it.
const hostWords = (host) => host.split('.').flatMap((part, i, all) => (i < all.length - 1 ? [`${part}.`, document.createElement('wbr')] : [part]));

// "Copy note": the line a giver can send along with an idea, built from the favourites its card already names (note.js). The memory
// prompt shows after the press, so it is clear what is left to write. If the browser refuses the clipboard, the note shows in a box to copy by hand.
function noteRow(idea) {
  const note = noteFor(idea.because);
  if (!note) return null; // an idea that names no favourite has no true "I picked this because you love..." to send
  const status = h('p', { class: 'note-status', hidden: true });
  const box = h('textarea', { class: 'note-box', readonly: true, rows: '3', hidden: true, 'aria-label': `Note for ${idea.title}`, onfocus: (e) => e.target.select() });
  box.value = note;
  const copy = h('button', { type: 'button', class: 'btn small copy', 'aria-label': `Copy note: ${idea.title}`, onclick: async () => {
    const ok = await copyText(note);
    status.textContent = ok ? `Copied. ${MEMORY}` : `Could not copy by itself. Press Ctrl+C to copy the note below. ${MEMORY}`;
    status.hidden = false;
    box.hidden = ok;
    if (!ok) {
      box.focus();
      box.select();
    }
    announce(status.textContent);
  } }, icon('copy', 14), 'Copy note');
  return h('div', { class: 'note-row' }, copy, status, box);
}

// What Qloo's data says behind the reason, as text from the idea event: Qloo's split of its link by favourite (zero shares are left out, and
// nothing shows unless two remain, so it never reads as a single "match") and the tags it gives both the strongest favourite and the idea.
const evidenceRow = (label, value) => h('p', { class: 'evidence' }, h('span', { class: 'ev-lbl' }, label), h('span', { class: 'ev-val' }, value));
function evidenceRows(idea) {
  const names = idea.because ?? [];
  const parts = (Array.isArray(idea.shares) ? idea.shares : []).map((share, i) => [share, names[i]]).filter(([share, name]) => share > 0 && name);
  const tags = Array.isArray(idea.shared) ? idea.shared : [];
  return [
    parts.length > 1 && evidenceRow('How Qloo splits its link to this idea (adds up to 100%): ', parts.map(([share, name]) => `${share}% ${name}`).join(' · ')),
    tags.length > 0 && names[0] && evidenceRow(`Tags Qloo gives to both ${names[0]} and ${idea.entity.name}: `, tags.join(' · ')),
  ];
}

// A link card whose page gave no blurb shows where the link goes, built only from its own address (path words, no query or fragment).
// It never describes the product: the page itself is the only source for that.
function addressWords(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    const words = u.pathname
      .split('/')
      .filter((s) => s && !/^index\.\w+$/i.test(s))
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    const text = words.join(' › ');
    return text.length > 90 ? `${text.slice(0, 89)}…` : text;
  } catch {
    return '';
  }
}
const VIA = { live: 'live', mock: 'demo', cache: 'cached' };
// What an idea says when the search that would fill it was over its daily cap (the idea itself still comes from Qloo).
const PAUSED_NOTE = {
  channel3: 'No buy button: shop search is paused until 00:00 UTC.',
  tavily: 'No links: web search is paused until 00:00 UTC.',
};
// What the header says about the services that ran out during a run.
const LIMITED_NOTE = {
  qloo: 'Qloo’s allowance for today ran out during this run, so the result can be smaller than usual.',
  channel3: 'Shop search is paused until 00:00 UTC, so some ideas come from Qloo alone, without a buy button.',
  tavily: 'Web search is paused until 00:00 UTC, so prices were not checked against shop pages and place links are missing.',
};
const wide = window.matchMedia('(min-width: 1000px)');

const ERROR_TITLES = {
  limit: 'Live lookups are used up for now',
  upstream: 'A service we depend on is not answering',
  bad_input: 'Nothing to suggest yet',
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
        if (on) for (const i of document.querySelectorAll('img[data-src]')) i.src = i.dataset.src;
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
  const compare = mountCompare(() => run);
  const agentStatus = h('span', { class: 'agent-status' });
  const phasesEl = h('ol', { class: 'phases' });
  const demoNote = h('p', { class: 'demo-note', hidden: true });
  const agentTitle = h('span', { class: 'agent-title' }, 'The agent at work');
  const agentH = h('h2', { class: 'agent-h' });
  const agentBody = h('div', { class: 'agent-body', id: 'agent-body' }, phasesEl, demoNote);
  const agent = h('aside', { class: 'agent', 'aria-label': 'Agent steps', tabindex: '0', 'data-open': String(wide.matches) }, agentH, agentBody);
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

  // On wide screens the step list scrolls inside its own panel. While the run is live it follows the newest step, so the reader never has to
  // chase it; scrolling up stops the following, scrolling back to the end resumes it. Only the panel moves, never the page.
  let follow = true;
  agent.addEventListener('scroll', () => { follow = agent.scrollHeight - agent.scrollTop - agent.clientHeight < 48; }, { passive: true });
  const followRun = () => { if (follow && run && run.status === 'running') agent.scrollTop = agent.scrollHeight; };
  const settleAgent = () => { if (follow) agent.scrollTop = 0; }; // a finished run shows its summary line first

  root.append(
    h(
      'div',
      { class: 'screen ideas' },
      h('div', { class: 'screen-head' }, h('div', {}, h('h1', { tabindex: '-1' }, 'Gift ideas'), lovesEl), h('div', { class: 'head-actions' }, h('a', { class: 'btn small', href: '#/' }, icon('back', 16), 'Edit favourites'), imagesSwitch)),
      h('div', { class: 'ideas-layout' }, agent, h('div', { class: 'col-main' }, notices, list, compare.el, barRoot)),
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
    if (c.tool === 'model') return /write/i.test(c.arg) ? 'write' : /choose/i.test(c.arg) ? 'products' : phaseNow();
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
    delete agentStatus.dataset.state;
    if (run.status === 'running') {
      const p = run.phases.find((x) => x.state === 'running');
      agentStatus.append(spinner(), h('span', {}, p ? p.label : 'Starting'));
    } else if (run.status === 'done' && !run.ideas.length) {
      agentStatus.dataset.state = 'empty';
      agentStatus.append(icon('info', 14), h('span', {}, 'Finished without ideas'));
    } else if (run.status === 'done') {
      const n = lookupCount(run.calls);
      agentStatus.append(icon('check', 14), h('span', {}, `Done in ${(run.ms / 1000).toFixed(1)} s · ${n} lookup${n === 1 ? '' : 's'}`));
    } else {
      agentStatus.dataset.state = 'error';
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

  // The price line shows only what is known: a confirmed match, or that the check was paused (an unknown result stays silent).
  function showCheck(el, c) {
    if (!c || (c.state !== 'confirmed' && c.state !== 'paused')) return;
    const paused = c.state === 'paused';
    el.dataset.state = c.state;
    el.replaceChildren(icon(paused ? 'info' : 'check', 14), h('span', {}, paused ? 'Price check paused until 00:00 UTC' : 'Price matches the shop’s page'));
    el.hidden = false;
  }

  function cardEl(card, idea) {
    const shopUrl = safeUrl(card.url);
    const img = card.image && safeUrl(card.image);
    const media = h('div', { class: 'media' }, img ? h('img', { ...shopImage(img), alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', width: '320', height: '240', onload: (e) => { e.target.dataset.ok = '1'; }, onerror: (e) => e.target.remove() }) : null, h('span', { class: 'ph', 'aria-hidden': 'true' }, card.title.trim().charAt(0).toUpperCase()), card.purchasable ? h('span', { class: 'sel-tag', 'aria-hidden': 'true' }, icon('check', 12), 'In your gift') : null);
    const el = h('li', { class: 'card', 'data-kind': card.purchasable ? 'product' : 'link', 'data-selected': 'false' });
    const link = shopUrl
      ? h('a', { class: 'shop-link', href: shopUrl, target: '_blank', rel: 'noopener noreferrer sponsored' }, card.purchasable ? 'View product' : 'Open page', icon('external', 14), h('span', { class: 'sr-only' }, ' (opens in a new tab)'))
      : null;
    const check = h('p', { class: 'check', hidden: true, 'data-id': card.id }, icon('check', 14), h('span', {}, 'Price matches the shop’s page'));
    const where = card.purchasable || card.snippet ? '' : addressWords(card.url);
    el.append(
      media,
      h(
        'div',
        { class: 'card-body' },
        h('h3', { class: 'card-title' }, card.title),
        h('p', { class: 'card-meta' }, card.purchasable ? h('span', { class: 'price' }, money(card.price_cents)) : null, h('span', { class: 'shop' }, hostWords(card.shop))),
        card.purchasable ? check : card.snippet ? h('p', { class: 'snippet' }, card.snippet) : where ? h('p', { class: 'snippet trail' }, where) : null,
        h('div', { class: 'card-actions' }, link, card.purchasable ? null : h('span', { class: 'hint-inline' }, 'Price is on the venue’s site')),
      ),
    );
    if (card.purchasable) {
      const btn = h('button', { type: 'button', class: 'pick', onclick: () => toggleCard(card) });
      el.querySelector('.card-actions').append(btn);
      const entry = { card, btn, root: el, check };
      cardEls.set(card.id, entry);
      refreshCard(entry);
      showCheck(check, run.checks[card.id]);
    }
    return el;
  }

  function addIdea({ idea, cards }) {
    const because = idea.because.length
      ? h('p', { class: 'because named' }, h('span', { class: 'because-lbl' }, 'Because they love'), h('ul', { class: 'pills' }, idea.because.map((b) => h('li', { class: 'pill-soft' }, b))))
      : h('p', { class: 'because' }, h('span', { class: 'because-lbl' }, 'Fits their overall taste'));
    const reasonText = run.reasons[idea.id];
    const reason = h('div', { class: 'reason', 'data-state': reasonText ? 'ready' : 'pending' }, reasonText ? reasonText : [h('span', { class: 'sk-line w100' }), h('span', { class: 'sk-line w60' })]);
    const section = h(
      'article',
      { class: 'idea', 'aria-labelledby': `idea-${idea.id}` },
      h('header', { class: 'idea-head' }, h('p', { class: 'kind' }, idea.kind === 'experience' ? 'Experience' : 'Gift'), h('h2', { id: `idea-${idea.id}` }, idea.title), because, reason, evidenceRows(idea), noteRow(idea)),
      idea.paused ? h('p', { class: 'note info paused', role: 'status' }, icon('info', 18), h('span', {}, PAUSED_NOTE[idea.paused])) : h('ul', { class: 'cards' }, cards.map((c) => cardEl(c, idea))),
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
    if (entry) showCheck(entry.check, c);
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
        h('button', { type: 'button', class: 'btn primary', disabled: sel.length === 0 || run.status !== 'done', onclick: () => (location.hash = '#/checkout') }, 'Review and pay', icon('arrow', 16)),
      ),
    );
    barRoot.hidden = !run.ideas.some(({ cards }) => cards.some((c) => c.purchasable)); // no buy buttons (all shop search paused): nothing to pick
  }

  // ---- notices ----------------------------------------------------------------------------------------------------------
  function showError(err) {
    const partial = run.ideas.some((i) => i.cards.some((c) => c.purchasable)); // only buyable ideas count as a usable partial result
    const code = err.code || 'internal';
    const title = partial ? 'The agent stopped early' : ERROR_TITLES[code] || 'Something went wrong';
    const live = !run.example && code !== 'bad_input' && code !== 'limit'; // asking again can work
    const actions = [];
    if (code === 'bad_input') actions.push(h('a', { class: 'btn', href: '#/' }, icon('back', 16), 'Change favourites'));
    if (live) actions.push(h('button', { type: 'button', class: 'btn', onclick: () => restart('live') }, 'Try again'));
    actions.push(h('button', { type: 'button', class: 'btn', onclick: () => restart('example') }, 'Replay the saved example'));
    if (code === 'upstream') actions.reverse(); // a service is down (or a contest key has ended): the saved example is the sure way on
    if (!partial) actions[0].classList.add('primary'); // one filled button; with ideas on screen the "Review and pay" bar is the main action
    const text = partial ? 'Some ideas arrived before it stopped.' : err.message + (code === 'upstream' ? ' The saved example always works.' : '');
    notices.append(
      h(
        'section',
        { class: 'panel ' + (partial ? 'warn' : 'bad'), role: 'alert' },
        h('div', { class: 'panel-icon' }, icon('alert', 22)),
        h('div', { class: 'panel-body' }, h('h2', {}, title), h('p', {}, text), h('div', { class: 'panel-actions' }, actions)),
      ),
    );
  }

  function restart(mode) {
    state.pending = mode === 'live' && run.liveExample ? { mode, example: true } : { mode };
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
        followRun();
        if (e.state === 'running') announce(e.label);
        break;
      }
      case 'call':
        run.calls.push(e);
        addCall(e);
        followRun();
        break;
      case 'taste':
        run.seeds = e.seeds;
        setSeeds(e.seeds);
        followRun();
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
        run.limited = e.limited || [];
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
    settleAgent();
    showHeader();
    renderBar(); // the bar was drawn while running: enable "Review and pay" now (the server saves the session only at the end)
    save();
    compare.update();
    announce(run.ideas.length ? `Done. ${run.ideas.length} gift ideas. ${run.ideas.some(({ cards }) => cards.some((c) => c.purchasable)) ? 'Pick the items you like.' : 'None has a buy button right now.'}` : 'Finished without any gift ideas.');
    if (!run.ideas.length) showEmpty();
  }

  function showEmpty() {
    notices.append(
      h('section', { class: 'panel', role: 'status' }, h('div', { class: 'panel-body' }, h('h2', {}, 'No ideas to show'), h('p', {}, 'Try a higher budget or different favourites, or look at the saved example.'), h('div', { class: 'panel-actions' }, h('a', { class: 'btn primary', href: '#/' }, 'Change favourites'), h('button', { type: 'button', class: 'btn', onclick: () => restart('example') }, 'Replay the saved example')))),
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
    settleAgent();
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
    notices.querySelectorAll('.example-note, .tier-note').forEach((n) => n.remove());
    if (run.tier === 'template') {
      notices.prepend(h('p', { class: 'note info tier-note' }, icon('info', 18), h('span', {}, 'The AI model did not take part in this run (its daily allowance is used up, or it did not answer), so the steps were fixed and the reasons are plain templates.')));
    }
    const cut = run.limited.map((k) => LIMITED_NOTE[k]).filter(Boolean);
    if (cut.length) {
      notices.prepend(h('p', { class: 'note info tier-note' }, icon('info', 18), h('span', {}, `${cut.join(' ')} The saved example always works.`)));
    }
    if (run.example) {
      notices.prepend(h('p', { class: 'note info example-note' }, icon('info', 18), h('span', {}, `Saved example${run.asOf ? `, recorded ${run.asOf}` : ''}. Its products and prices were live that day; its taste matches and reasons are stand-ins, not live Qloo or model output. The checkout is a live PayPal sandbox order.`)));
    }
    if (run.liveExample) {
      notices.prepend(h('p', { class: 'note info example-note' }, icon('info', 18), h('span', {}, 'Example set. The favourites and the budget above were picked for this demo, not typed by you. The search is a normal one, within the same daily limits as any other.')));
    }
    if (run.mocks.length) {
      demoNote.hidden = false;
      demoNote.textContent = mockNote(run.mocks, run.example ? null : state.status && state.status.modes); // the saved example's products were recorded, so no "live" claim there
    }
  }

  // ---- start ------------------------------------------------------------------------------------------------------------
  async function start(mode) {
    ctl = new AbortController();
    const body = mode === 'example' ? {} : { favorites: run.favorites.map((f) => ({ text: f.text, ...(f.type ? { type: f.type } : {}) })), budget_usd: state.budget };
    for (let i = 0; i < SKELETONS; i++) list.append(skeletonIdea());
    try {
      await streamNdjson(mode === 'example' ? '/api/sample' : '/api/ideas', body, onEvent, ctl.signal);
      if (run.status === 'running') fail(new ApiError('network', 'The connection closed before the agent finished.'));
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
    compare.update();
    cardEls.forEach(refreshCard);
  }

  if (state.pending) {
    const { mode, example: fixedSet } = state.pending;
    state.pending = null;
    state.selected = [];
    run = newRun(mode === 'example' ? { favorites: [], budget_cents: 0, example: true } : { favorites: state.favorites, budget_cents: Math.round(state.budget * 100), example: false, liveExample: !!fixedSet });
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
