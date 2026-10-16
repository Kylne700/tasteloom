// "Try an example": a recorded session (real Channel3 product cards, reasons written by the pipeline) replayed as a stream,
// so judges never hit a dead end when a key is missing, a daily limit is reached or an upstream API is down.
import { SAMPLE } from './sample-data.ts';
import { newSession } from './commerce.ts';
import type { Session, StreamEvent } from './types.ts';

export function sampleSession(): Session {
  return newSession(SAMPLE.budget_cents, SAMPLE.cards, true);
}

export function* sampleEvents(session: Session, mocks: string[]): Generator<{ delay: number; e: StreamEvent }> {
  const note = `from the saved example (recorded ${SAMPLE.asOf})`;
  const phase = (id: string, label: string, state: 'running' | 'done', d = 260): { delay: number; e: StreamEvent } => ({ delay: d, e: { t: 'phase', id, label, state, note: state === 'done' ? note : undefined } });
  yield { delay: 0, e: { t: 'meta', session: session.id, budget_cents: session.budget_cents, mocks, example: true, asOf: SAMPLE.asOf } };
  yield phase('qloo', 'Reading their taste with Qloo', 'running', 120);
  yield { delay: 320, e: { t: 'taste', seeds: SAMPLE.seeds } };
  yield phase('qloo', 'Reading their taste with Qloo', 'done');
  yield phase('plan', 'Nemotron is planning', 'running');
  yield phase('plan', 'Nemotron is planning', 'done', 420);
  yield phase('products', 'Finding real products', 'running');
  for (const idea of SAMPLE.ideas) {
    const cards = idea.cardIds.map((id) => session.cards.find((c) => c.id === id)!).filter(Boolean);
    yield { delay: 380, e: { t: 'idea', idea, cards } };
  }
  yield phase('products', 'Finding real products', 'done');
  yield phase('prices', 'Checking prices', 'running');
  yield phase('prices', 'Checking prices', 'done', 300);
  yield { delay: 120, e: { t: 'done', ideas: SAMPLE.ideas.length, cards: session.cards.length, tier: 'example' } };
}
