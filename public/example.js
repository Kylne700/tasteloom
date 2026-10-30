// The fixed set "Run a live example" fills in: favourites and budget picked for the demo, not typed by the visitor.
// The run itself is the normal one (POST /api/ideas, the same daily limits, the same cache), so it is as live as any run is.
// No DOM in here, so the unit tests import it directly.
export const EXAMPLE = {
  favorites: [
    { text: 'The Hobbit', type: 'book' },
    { text: 'A Game of Thrones', type: 'book' },
    { text: 'Howard Shore', type: 'artist' },
    { text: 'Hans Zimmer', type: 'artist' },
    { text: 'Lego', type: 'brand' },
  ],
  budget: 120,
};
