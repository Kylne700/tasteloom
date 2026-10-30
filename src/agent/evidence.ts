// What Qloo's data says about the link between a favourite and an idea, kept apart from ideas.ts: the share each named favourite gets,
// the tags both carry (parseTags in adapters/qloo.ts decides which kinds of tag count) and the fixed sentences that state them.
// A model's wording of "what they have in common" is kept only when it also uses one of the shared tags (writeReasons in ideas.ts);
// with no shared tag the server writes plainReason and the model is not asked.

/** Whole percents that add up to 100 (largest remainder first, the earlier on ties), in the order of the scores; [] when no score is usable. */
export function sharesOf(scores: number[]): number[] {
  const s = scores.map((x) => (Number.isFinite(x) && x > 0 ? x : 0));
  const total = s.reduce((a, b) => a + b, 0);
  if (!total) return [];
  const exact = s.map((x) => (x / total) * 100);
  const whole = exact.map(Math.floor);
  const order = exact.map((_, i) => i).sort((a, b) => exact[b]! - whole[b]! - (exact[a]! - whole[a]!) || a - b);
  for (let left = 100 - whole.reduce((a, b) => a + b, 0), k = 0; left > 0; left--, k++) whole[order[k % order.length]!]!++;
  return whole;
}

/** Tags both lists hold (ignoring case), in the order and spelling of the first list, at most `max`. */
export function sharedTags(favourite: string[] | undefined, idea: string[] | undefined, max = 4): string[] {
  const theirs = new Set((idea ?? []).map((t) => t.toLowerCase()));
  return (favourite ?? []).filter((t) => theirs.has(t.toLowerCase())).slice(0, max);
}

/** "a", "a and b", "a, b and c" */
export const andList = (xs: string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The two sentences the server writes for a link: all Qloo's data gives, or the tags Qloo gives both. Neither adds anything the data does not say. */
export const plainReason = (favourite: string, idea: string) => `Qloo links ${favourite} to ${idea}.`;
export const sharedReason = (favourite: string, idea: string, tags: string[]) => `Qloo tags both ${favourite} and ${idea} as ${andList(tags)}.`;
