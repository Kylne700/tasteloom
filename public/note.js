// The note a giver can send along with an idea ("Copy note" on each idea). Plain text and no DOM, so the unit tests can read it.
export const MEMORY = 'Add one memory only you can write.';

/** "I picked this because you love X." for the favourites an idea names ("X and Y", "X, Y and Z"), then a blank line to write in. '' when the idea names none. */
export function noteFor(names) {
  const list = (names || []).filter((n) => typeof n === 'string' && n.trim());
  if (!list.length) return '';
  const who = list.length === 1 ? list[0] : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
  return `I picked this because you love ${who}.\n\n`;
}
