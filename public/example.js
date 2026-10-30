// The fixed set "Run a live example" fills in: favourites and budget picked for the demo, not typed by the visitor.
// The run itself is the normal one (POST /api/ideas, the same daily limits, the same cache), so it is as live as any run is.
// No DOM in here, so the unit tests import it directly.
export const EXAMPLE = {
  favorites: [
    { text: "One Flew Over the Cuckoo's Nest", type: 'book' },
    { text: 'The Catcher in the Rye', type: 'book' },
    { text: 'Bob Dylan', type: 'artist' },
    { text: 'The Velvet Underground', type: 'artist' },
    { text: 'Polaroid', type: 'brand' },
  ],
  budget: 120,
};
