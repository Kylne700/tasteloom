# Tasteloom

Taste + loom: Tasteloom weaves the things someone loves into gifts you can actually buy, and says why each one fits.

Type three to five things a person loves (a book, a band, a shop, a place) and a budget. An agent reads their taste, finds real products with real prices, explains every idea with "Because they love X", and lets you pay in the PayPal sandbox as a guest. No account, nothing stored about what you type.

Built for three Devpost contests: the Qloo agentic contest, the Nebius x NVIDIA contest (with the Tavily prize), and the PayPal AI contest (Agentic Commerce, with the Channel3 prize). The whole flow takes about a minute.

## The flow

1. **Loves and budget.** Add 3 to 5 favourites (an optional type hint such as book or artist sharpens the match) and a budget from $10 to $500. Or press **Try an example**: a saved run replays without any key.
2. **Gift ideas.** A live list shows what the agent is doing (reading taste, finding products, writing reasons, checking prices) while idea cards arrive. Each idea says which favourite it comes from. Product cards show title, price, shop and a link. A product image switch keeps the page free of third-party pictures (`?images=off` turns it off by default).
3. **Pick and pay.** Pick up to 6 items within the budget, review, and press **Pay with PayPal**. The page shows PayPal's documented sandbox test card with copy buttons; you pay as a guest on PayPal's own page, no PayPal account needed.
4. **Receipt.** After PayPal approves, the server captures once and shows the order id, the final status and the items. Everything is labelled "sandbox, no real money".

## How each sponsor technology is used

| Technology | What it does here | Where |
| --- | --- | --- |
| **Qloo** | Taste graph. Favourites become entity seeds (`/search`), then `/v2/insights` with `feature.explainability=true` returns gift candidates and which seeds drove each one. That explanation is the "Because they love X" line; a reason that names nobody Qloo linked is thrown away. | `src/adapters/qloo.ts`, `src/agent/ideas.ts` |
| **Nebius Token Factory + NVIDIA Nemotron** | The agent. Nemotron (OpenAI-compatible API) runs a tool-calling loop with six tools: `qloo_search`, `qloo_insights`, `find_products`, `create_order`, `get_order`, `capture_order`. If tool calling fails, a fixed pipeline calls the same tools in order and the model only fills JSON-only slots (which entities, which queries, the reasons); with no model at all, template picks and reasons keep the page working. | `src/adapters/nebius.ts`, `src/agent/loop.ts`, `src/agent/ideas.ts`, `src/agent/orders.ts` |
| **Tavily** | Live web search at runtime: experience ideas (places, destinations) as link cards, and an informational price check of a product on its shop page. It never creates a buyable card. | `src/adapters/tavily.ts` |
| **Channel3** | The product catalog: structured titles, brands, images and prices (`offers[].price`) with shop links. Only Channel3 results become buyable cards. | `src/adapters/channel3.ts` |
| **PayPal (sandbox)** | Orders v2: create with a `PayPal-Request-Id` and `GUEST_CHECKOUT`, the buyer approves on PayPal's page, then a fresh read must show `APPROVED` with the same amount before one capture. The host is a constant: this code cannot reach live PayPal. | `src/adapters/paypal.ts`, `src/commerce.ts` |

The model chooses which tool to call; the server decides whether a call is allowed. Every tool validates its arguments against server state, so a manipulated model cannot invent an id, a price or a charge. A model outage can never block or change a payment: the same guarded server functions run directly.

## Live versus demo data

| Service | Mode in this build | Switches to live |
| --- | --- | --- |
| Qloo | **demo data**: a stand-in that returns the documented response shape through the same parser | automatically when `QLOO_API_KEY` is set |
| Nebius / Nemotron | **demo data**: a stand-in speaking the OpenAI-compatible tool-calling format | automatically when `NEBIUS_API_KEY` is set |
| Tavily | live (needs `TAVILY_API_KEY`) | |
| Channel3 | live (needs `CHANNEL3_API_KEY`) | |
| PayPal | live, sandbox only (needs `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`) | |

While any stand-in is active the page shows a **Demo data** badge and a note naming it. Products, prices and PayPal are live either way. `FORCE_MOCK=qloo,nebius` forces the stand-ins even with keys. `npm run contract:qloo` and `npm run contract:nebius` check the real APIs against the shapes the code expects (at most 5 calls each); with no key they stop with "KEY MISSING" and exit code 2.

## Setup

Needs Node 22.18 or newer.

```sh
npm install
# keys go in ../.env.local (tasteagent/.env.local), one KEY=value per line:
#   QLOO_API_KEY  NEBIUS_API_KEY  TAVILY_API_KEY  CHANNEL3_API_KEY  PAYPAL_CLIENT_ID  PAYPAL_CLIENT_SECRET
npm run dev        # http://localhost:8791
```

`npm run dev` first runs `scripts/dev-vars.mjs`, which copies only those six keys from `../.env.local` into `.dev.vars` (the file `wrangler dev` reads). `.dev.vars` is git-ignored and written with mode 600, and the script prints key names, never values. Keys are used only on the server: they are never sent to the browser, never logged, and error messages are redacted. `npm run dev` also sets `DEV_CACHE=1`, which caches Qloo and Nebius answers while developing (Channel3 and Tavily answers are always cached for 12 hours).

Optional settings (plain environment variables): `NEBIUS_AGENT_MODEL`, `NEBIUS_WRITER_MODEL`, `FORCE_MOCK`, `LIMIT_IP_*` / `LIMIT_GLOBAL_*` (`IDEAS`, `NEBIUS`, `TAVILY`, `CHANNEL3`, `ORDERS`), `LIMIT_DAILY_CAP_USD`, `LIMIT_MAX_ITEMS`, `LIMIT_MAX_BUDGET_USD`, `PUBLIC_BASE_URL`.

Deploying is not part of this repository's checks. A deployment would need the keys as Worker secrets (`wrangler secret put`) and a real KV namespace id in `wrangler.jsonc`.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | local Worker with static assets on port 8791 |
| `npm test` | unit tests (money rules, adapters on documented fixtures, malformed model JSON, spend counters, contrast of the stylesheet, static checks) |
| `npm run typecheck` | `tsc --noEmit` on `src/` |
| `npm run build` | `wrangler deploy --dry-run`: bundles the Worker without deploying |
| `npm run e2e` | real Chromium against `wrangler dev`: the full flow with a PayPal sandbox guest payment to COMPLETED, then a tour of every screen and error state at 1280, 768 and 390 px; writes `evidence/e2e.txt` and `evidence/screens/` |
| `npm run contract:qloo`, `npm run contract:nebius` | cheap live checks of the two APIs that still run on stand-ins |
| `npm run scan` | secret and privacy scan of the tracked files, built assets and git history |

## Rules the server enforces

- **Prices come only from the cards the server stored for the session.** The browser sends a session id and card ids; any price it sends is ignored.
- **Caps.** A total above the buyer's budget, or above the global daily cap, is refused before PayPal is called.
- **One capture, only after approval.** Capture needs a fresh PayPal read showing `APPROVED` with the same amount and currency; the request id makes a repeat harmless, and opening the return link twice does not capture twice.
- **Sandbox only.** The PayPal host is a constant; the UI says "sandbox, no real money" next to every payment step.
- **Spend limits.** Per-IP and global daily counters for Nebius, Tavily, Channel3 and orders; a per-request subrequest budget; hard timeouts. When a limit is reached the page says so and offers the example.
- **Untrusted text.** Model output is parsed tolerantly and then checked; shop text is clipped, links must be https, and the page has no HTML-injection sinks and a strict Content Security Policy.

## Privacy

No accounts, no cookies. What you type is sent to the server to build your ideas and is not stored; the server keeps only the saved product cards (for server-side pricing, 2 hours), orders (7 days) and counters keyed by a hash of the IP. The browser keeps your inputs, finished run and picks in `sessionStorage` (this tab only) so the return from PayPal's cancel page restores them. The page ships no third-party logos or fonts; product images load from the shops' CDNs and can be switched off.

## Design

Plain HTML, CSS and ES modules in `public/` (no framework, no build step). One warm palette with a single accent, three screens with a step indicator, every state designed (loading, empty, errors, limits, cancelled, failed capture, receipt), visible focus rings, keyboard use end to end, responsive from 320 to 1440 px, and a stylesheet whose colours are tested for WCAG contrast. `npm run e2e` checks accessibility basics, focus rings, layout shift and horizontal overflow in a real browser.

## Known limits

- Qloo's real response (especially the explainability fields) and Nemotron's real tool-calling behaviour are not verified until keys exist; the contract scripts do that check.
- Channel3's catalog is thin for niche items (a specific book may return nothing buyable); such ideas show as links or are skipped.
- Tavily price checks rarely confirm a price; they are informational.
- PayPal's hosted sandbox page is outside this app's control. In testing it sometimes offered only "create account" on the first load; reloading the same PayPal page showed the guest card form (the checkout screen says so).
- Workers Free CPU limits were not measured; the request pipeline stays under the 50-subrequest limit by design (stops at 40).

## Why "Tasteloom"

A loom weaves separate threads into one cloth. Tasteloom takes separate threads of taste (a book, a band, a shop, a city) and weaves them into gifts, keeping each thread visible in the "because" line.

## License

MIT, see `LICENSE`.
