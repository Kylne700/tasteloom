// "Try an example": a recorded session (real Channel3 product cards, reasons written by the pipeline) replayed as a stream,
// so judges never hit a dead end when a key is missing, a daily limit is reached or an upstream API is down.
import { SAMPLE } from './sample-data.ts';
import { newSession } from './commerce.ts';
import type { Card, Session, StreamEvent } from './types.ts';

export function sampleSession(): Session {
  const cards: Card[] = SAMPLE.events.flatMap((e) => (e.t === 'idea' ? e.cards : []));
  return newSession(SAMPLE.budget_cents, cards, true);
}

// Pacing of the replay in milliseconds, so the agent steps are readable (a live run is as slow as the services).
const PACE: Record<StreamEvent['t'], number> = { meta: 0, phase: 260, call: 200, taste: 300, idea: 380, reasons: 350, check: 120, done: 120, error: 0 };

export function* sampleEvents(session: Session, mocks: string[]): Generator<{ delay: number; e: StreamEvent }> {
  yield { delay: 0, e: { t: 'meta', session: session.id, budget_cents: session.budget_cents, mocks, example: true, asOf: SAMPLE.asOf, favorites: SAMPLE.favorites } };
  for (const e of SAMPLE.events) yield { delay: PACE[e.t], e };
  yield { delay: PACE.done, e: { t: 'done', ideas: SAMPLE.events.filter((e) => e.t === 'idea').length, cards: session.cards.length, tier: 'example' } };
}
