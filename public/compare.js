// "Same AI, without Qloo": one button under the results. A click asks the same model for gift ideas from the favourites alone (POST /api/plain:
// the favourites and the budget, nothing else) and lists them, tagging the ideas that name one of the favourites. The answer is kept on the run
// (run.plain) so coming back to the screen costs no second call. Server text is only ever inserted as text.
import { announce, fill, h, spinner } from './dom.js';
import { ApiError, postJson } from './api.js';
import { save } from './state.js';

const PROOF_URL = 'https://github.com/Kylne700/tasteloom#compare-in-the-app';

const link = (text) => h('a', { href: PROOF_URL, target: '_blank', rel: 'noopener noreferrer' }, text, h('span', { class: 'sr-only' }, ' (opens in a new tab)'));

/** getRun() returns the current run of the ideas screen. Returns { el, update }: put el in the page, call update() when the run finishes or is restored. */
export function mountCompare(getRun) {
  const title = h('h2', { id: 'compare-h', tabindex: '-1' }, 'Same AI, without Qloo');
  const body = h('div', { class: 'compare-body' });
  const el = h('section', { class: 'compare', 'aria-labelledby': 'compare-h', hidden: true }, title, body);
  let busy = false;
  let problem = null; // { run, code, message } of the last failed ask; shown until the next one, not saved

  const favs = (run) => (run.example ? 'the example’s favourites' : 'the favourites you typed');

  function idle(run) {
    fill(
      body,
      h('p', { class: 'compare-lead' }, `Ask the same AI model for gift ideas from ${favs(run)}, with no Qloo data. The click sends only the favourites and the budget.`),
      h('button', { type: 'button', class: 'btn', onclick: ask }, 'Compare: same AI, no Qloo'),
    );
  }

  /** Returns the count line, which is also what gets announced. */
  function result(run) {
    const { ideas, mock } = run.plain;
    const count = `${ideas.filter((i) => i.named).length} of ${ideas.length} name ${run.example ? 'one of the example’s favourites' : 'a favourite you typed'}.`;
    fill(
      body,
      mock && h('p', { class: 'demo-note' }, 'Demo data: no AI model is connected on this server, so this is a fixed example answer, not model output.'),
      h('p', { class: 'compare-count' }, count),
      h('ol', { class: 'compare-list' }, ideas.map((i) => h('li', {}, h('p', { class: 'compare-gift' }, i.gift, i.named && h('span', { class: 'compare-tag' }, run.example ? 'names a favourite' : 'names your favourite')), i.reason && h('p', { class: 'compare-why' }, i.reason)))),
      h('p', { class: 'compare-note' }, `Same model, only ${favs(run)}, no taste data.${run.example ? ' The ideas above are a saved recording; these were asked just now.' : ''} Part of the difference is by design: Tasteloom does not offer the favourites themselves as ideas. `, link('How this was measured')),
    );
    return count;
  }

  /** Returns the sentence shown, which is also what gets announced. */
  function failed() {
    const limit = problem.code === 'limit';
    const text = limit ? 'The daily allowance for this comparison is used up. It starts again at 00:00 UTC.' : `The plain ideas could not be fetched. ${problem.message}`;
    fill(
      body,
      h('p', { class: 'compare-problem' }, text),
      !limit && h('button', { type: 'button', class: 'btn small', onclick: ask }, 'Try again'),
      h('p', { class: 'compare-note' }, 'The measured comparison is in the README. ', link('Read how it was measured')),
    );
    return text;
  }

  // Shown only for a finished run that has ideas; the wait line stays while a request is out.
  function render() {
    const run = getRun();
    el.hidden = !(run && run.status === 'done' && run.ideas.length && run.favorites.length);
    if (el.hidden || busy) return null;
    if (run.plain) return result(run);
    if (problem && problem.run === run) return failed();
    idle(run);
    return null;
  }

  async function ask() {
    const run = getRun();
    if (busy || !run) return;
    busy = true;
    problem = null;
    fill(body, h('p', { class: 'compare-wait' }, spinner(), 'Asking the AI model…'));
    title.focus(); // the button is gone: keep the place in the page
    announce('Asking the AI model for gift ideas without Qloo.');
    try {
      const out = await postJson('/api/plain', { favorites: run.favorites.map((f) => ({ text: f.text, ...(f.type ? { type: f.type } : {}) })), budget_usd: run.budget_cents / 100 });
      run.plain = { ideas: out.ideas, mock: !!out.mock };
      save();
    } catch (e) {
      problem = { run, code: e instanceof ApiError ? e.code : 'internal', message: e instanceof ApiError ? e.message : 'Something went wrong. Please try again.' };
    }
    busy = false;
    if (getRun() !== run || !el.isConnected) return; // the screen moved on while the model was answering
    const said = render();
    const a = document.activeElement;
    if (!a || a === document.body || el.contains(a)) title.focus();
    if (said) announce(said);
  }

  return { el, update: render };
}
