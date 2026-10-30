// App state, kept in memory and mirrored to sessionStorage (this tab only) so a return from PayPal's cancel page restores the picks.
// Only the finished gift ideas, the picks and the draft inputs are saved; nothing is sent anywhere.
const KEY = 'tasteloom.v1';

export const state = {
  /** draft inputs of the first screen: [{ text, type }] */
  favorites: [],
  budget: 100,
  /** the current or last finished run, see newRun() */
  run: null,
  /** card ids picked for the gift */
  selected: [],
  /** set by the first screen, consumed by the ideas screen: { mode: 'live' | 'example', example?: true } (example: the fixed set of example.js was filled in) */
  pending: null,
  /** /api/status */
  status: null,
};

export const PHASES = [
  { id: 'taste', label: 'Reading their taste with Qloo' },
  { id: 'products', label: 'Finding real products' },
  { id: 'write', label: 'Writing the reasons' },
  { id: 'prices', label: 'Checking prices on the shops’ pages' },
];

/** Qloo, shop and web lookups of a run: `calls` also holds the model's own steps, which are not lookups. */
export const lookupCount = (calls) => calls.filter((c) => c.tool !== 'model').length;

export function newRun({ favorites, budget_cents, example, liveExample }) {
  return {
    status: 'running',
    example: !!example, // the saved replay
    liveExample: !!liveExample, // a live run of the fixed example set (example.js), not typed by the visitor
    favorites,
    budget_cents,
    sessionId: '',
    mocks: [],
    asOf: '',
    phases: PHASES.map((p) => ({ ...p, state: 'pending', note: '' })),
    calls: [],
    seeds: [],
    ideas: [],
    reasons: {},
    checks: {},
    tier: '',
    limited: [],
    error: null,
    startedAt: Date.now(),
    ms: 0,
  };
}

export function save() {
  try {
    const run = state.run && state.run.status === 'done' ? state.run : null;
    sessionStorage.setItem(KEY, JSON.stringify({ favorites: state.favorites, budget: state.budget, run, selected: run ? state.selected : [] }));
  } catch {
    // storage blocked or full: the app works without it
  }
}

export function load() {
  try {
    const s = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s.favorites)) state.favorites = s.favorites.filter((f) => f && typeof f.text === 'string').slice(0, 5);
    if (Number.isFinite(s.budget)) state.budget = s.budget;
    if (s.run && s.run.status === 'done' && Array.isArray(s.run.ideas)) state.run = s.run;
    if (state.run && Array.isArray(s.selected)) state.selected = s.selected.filter((id) => typeof id === 'string');
  } catch {
    // damaged storage is ignored
  }
}

export function startOver() {
  state.run = null;
  state.selected = [];
  state.pending = null;
  save();
}

/** All cards of the current run by id. */
export function cardsById() {
  const m = new Map();
  if (state.run) for (const { cards } of state.run.ideas) for (const c of cards) m.set(c.id, c);
  return m;
}

export function selectedCards() {
  const all = cardsById();
  return state.selected.map((id) => all.get(id)).filter((c) => c && c.purchasable);
}

export const totalCents = () => selectedCards().reduce((a, c) => a + c.price_cents, 0);
export const budgetCents = () => (state.run ? state.run.budget_cents : Math.round(state.budget * 100));

const MOCK_NAMES = { qloo: 'Qloo', ai: 'the AI model' };
/** The sentence explaining the "Demo data" badge. `modes` is /api/status's modes: the "live" half is said only when those modes back it (null says nothing about the rest). */
export function mockNote(mocks, modes = null) {
  const names = mocks.map((m) => MOCK_NAMES[m] || m).join(' and ');
  const rest = modes && modes.channel3 === 'live' && modes.paypal === 'live' ? ' Products, prices and PayPal are live.' : '';
  return `Demo data: ${names} ${mocks.length > 1 ? 'run' : 'runs'} on built-in stand-ins with the same response formats until they are connected.${rest}`;
}
