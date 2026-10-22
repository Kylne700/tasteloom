# Tasteloom

Taste + loom: Tasteloom weaves the things someone loves into gifts you can actually buy, and says why each one fits.

Type three to five things a person loves (a book, a band, a shop, a place) and a budget. Qloo reads their taste, an AI agent finds real products with real prices, every idea says "Because they love X", and you can pay in the PayPal sandbox as a guest. No account, and Tasteloom stores nothing you type.

Try it: https://tasteloom.kylne700.workers.dev (free, no sign-in; "Try an example" costs no API calls).

This is an entry to the Qloo hackathon. It was built by AI agents (Claude Code), with a person setting the goals and owning the accounts the app uses.

## How Qloo is used

Qloo is the only thing in the app that decides what fits a person's taste.

1. **Search.** `GET /search` turns each favourite into a Qloo entity. A type hint (book, artist, brand, place and so on) is sent as `types=urn:entity:<type>`.
2. **Insights with explainability.** `GET /v2/insights` is called once per gift category (brand, book, artist, place, destination) with `signal.interests.entities` (the ids of every favourite from step 1, in every call), `filter.type` and `feature.explainability=true`. It returns entities the person is likely to like and, for each one, which of the favourites drove it (`query.explainability`), strongest first. Anything the person typed is dropped from the results.
3. **"Because they love X".** That explanation is the line on every idea card. The model writes the reason in its own words, but a reason that does not name the favourite Qloo links most strongly is replaced by a template sentence.
4. **From taste to things to buy.** A suggestion such as a brand or a book becomes a product search at Channel3, which returns real products with prices. A place or destination becomes experience links found with Tavily; those are links, never buyable cards.

One live run makes about 9 Qloo calls with four favourites (4 searches and 5 insight calls, one per gift category; measured 8 to 10 on 2026-10-22). The raw Qloo answers are used inside the request and not stored. `npm run contract:qloo` checks the real API against the shapes the code expects (5 calls).

## The agent

An AI model runs a loop in which it chooses tool calls; the server decides whether each call is allowed.

- **Model:** `@cf/qwen/qwen3-30b-a3b-fp8` on Cloudflare Workers AI, reached through a Worker binding (no API key). Set `AI_AGENT_MODEL` and `AI_WRITER_MODEL` to try another.
- **Tools while finding ideas:** `qloo_search`, `qloo_insights`, `find_products`.
- **Tools at checkout:** `create_order`, `get_order`, `capture_order`.
- **Three tiers, so a model problem never breaks the page.** First the model drives the tools in a loop (up to 6 turns). The server then fills in whatever it skipped by calling the same tools in a fixed order, and the model only fills JSON slots (which entities, which search words, the reasons). In every tier the server keeps the ideas of one run apart: at most two of one type, and not all led by the same favourite (a tool call that would break this is refused like any other bad call). If the model is unavailable, template choices and template reasons keep the page working, and the page says that the model did not take part.
- Every tool validates its arguments against server state, so a model cannot invent an id, a price or a charge. A model outage never blocks or changes a payment: the same guarded server functions run directly.

One live run makes 5 to 6 model calls and uses 85 to 100 neurons (Cloudflare's unit for Workers AI; measured on 2026-10-22). The checkout part of the live test (3 order creations and 1 capture) used 5 model calls and 15 neurons.

## The flow

1. **Loves and budget.** Add 3 to 5 favourites (an optional type hint such as book or artist sharpens the match) and a budget from $10 to $500. Or press **Try an example**: a saved run replays without any key.
2. **Gift ideas.** A live list shows what the agent is doing (reading taste, finding products, writing reasons, checking prices) while idea cards arrive. Each idea says which favourite it comes from. Product cards show title, price, shop and a link. Product images are off until you turn on the image switch (`?images=on` starts with them on), because a shop's image server sees your IP.
3. **Pick and pay.** Pick up to 6 items within the budget, review, and press **Pay with PayPal**. The page shows PayPal's documented sandbox test card with copy buttons; you pay as a guest on PayPal's own page, no PayPal account needed.
4. **Receipt.** After PayPal approves, the server captures once and shows the order id, the final status and the items. The receipt carries the sandbox badge and one "Mode: PayPal sandbox, no real money" row.

## What is sent where

| Service | What it receives | Why |
| --- | --- | --- |
| **Qloo** | the favourites as typed (and the type hint), then Qloo's own entity ids | to read taste |
| **Cloudflare Workers AI** | the favourites and budget, the entities Qloo returned, product titles and prices, and at checkout the ids of the picked items and the order's id, status and total | the model that drives the tools and writes the reasons |
| **Channel3** | product searches built from Qloo's suggestions and the model's wording, with a price ceiling | real products and prices |
| **Tavily** | searches for an experience idea (a place or destination Qloo suggested) and price checks of a product on its shop's domain | experience links, informational price checks |
| **PayPal sandbox** | the order (items, total) and the buyer's return | the test payment; no real money moves |

Tasteloom does not store what you type. The other services keep what they receive under their own terms, which this project does not control.

## Live versus demo data

| Service | Live when | Otherwise |
| --- | --- | --- |
| Qloo | `QLOO_API_KEY` is set | **demo data**: a stand-in that returns the documented response shape through the same parser |
| AI model | the `AI` binding exists (Cloudflare Workers) | **demo data**: a stand-in speaking the same tool-calling format (unit tests, plain Node) |
| Tavily | `TAVILY_API_KEY` is set | off: the experience and price-check steps are skipped |
| Channel3 | `CHANNEL3_API_KEY` is set | off: no products |
| PayPal | `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set | off: no checkout (sandbox only either way) |

While a stand-in is active the page shows a **Demo data** badge and a note naming it. With the Qloo key set and the AI binding present, as in the deployed demo, both are live and no badge shows. `FORCE_MOCK=qloo,ai` forces the stand-ins. With no Qloo key `npm run contract:qloo` stops with "KEY MISSING" and exit code 2.

## Limits

The demo is free and has no sign-in. Daily caps, counted per UTC day, keep it inside free plans. They are kept in one Durable Object so parallel requests cannot pass a cap; every billed call is reserved before it is made, and when the counters cannot be reached the call is refused.

| What is counted | Per visitor (IP, or IPv6 /64) | All visitors | One live run uses (measured) |
| --- | --- | --- | --- |
| Gift-idea runs | 8 | 100 | 1 |
| Qloo calls | 60 | 600 | about 9 (8 to 10) |
| Model calls | 80 | 600 | 5 to 6 (the checkout part of the live test, 3 order creations and 1 capture, used 5 more) |
| Model neurons | 1,500 | 8,000 | 85 to 110 (that checkout part used 15 more) |
| Channel3 searches | 24 | 25 | 4 to 6 (1 or 2 when the same search was made in the last 12 hours) |
| Tavily searches | 20 | 25 | 4 to 5 (1 when repeated within 12 hours) |
| Sandbox orders | 8 | 100 | 1 per payment |
| Returns from PayPal that still had work to do | 20 | 150 | 1 or 2 per payment |
| Sandbox spend | | $2,000 | |

The Channel3 and Tavily numbers are the small ones on purpose: each service gives 1,000 free credits a month (its docs, read 2026-10-22), the demo has to keep working until judging ends (Nov 16, 2026, 11:45 pm ET, which is Nov 17, 04:45 UTC), and a fifth of the credits is held back. One visitor can still make about four ordinary runs a day (4 to 6 shop searches and 4 to 5 web searches each, as measured). A run that tries more suggestions uses more: the caps then pause shop or web search for the rest of the day and the run still returns its Qloo ideas. The other caps keep a day inside the free plans of Cloudflare (Workers AI neurons, 1,000 KV writes a day: the caps above allow about 850 at the very most; the saved example and an unchanged order write nothing) and give each visitor several runs.

What the page shows when a cap is reached. The services that only add to a run (shop search, web search, the model) pause on their own and the run goes on; the ones a run cannot do without (a run, Qloo) refuse it before it starts, so a refused run has spent no Qloo or model call.

- **Gift-idea runs and Qloo (looked at before the run starts):** a run needs one Qloo call per favourite and five more (one per gift type), so 8 to 10; if the visitor's or the shared Qloo allowance left cannot cover that, nothing is spent and the page shows the panel "Live lookups are used up for now" with a plain message ("You have reached today's allowance for live lookups" for one visitor, "The demo has reached its daily budget for live data" for everyone) and a **Try an example** button. The saved example always works.
- **Channel3 (shop search):** the run still gives its Qloo ideas, each with its "Because they love X" reason, but without buy buttons. Every idea that lost its items says "No buy button: shop search is paused until 00:00 UTC", the note at the top of the page says the same, and when no idea has a buy button the Review and pay bar is not shown. If the cap is reached part-way, the ideas found before keep their buy buttons.
- **Tavily (web search):** the run goes on without it. Each price line says "Price check paused until 00:00 UTC", a place idea says "No links: web search is paused until 00:00 UTC", and the note at the top of the page says prices were not checked and place links are missing. Buy buttons are not affected.
- **The model (calls or neurons):** the run goes on without it, with fixed steps and template reasons, and a note says "The AI model did not take part in this run". Qloo, the catalog and prices are still live. The model never blocks a run.
- **Sandbox orders and spend:** the checkout screen says so and asks you to come back tomorrow.
- **Returns from PayPal:** past the allowance the receipt shows the order as it stands, and PayPal is not asked.

Cloudflare's own limit sits behind ours. The Workers AI pricing page (read 2026-10-22) says: "Our free allocation allows anyone to use a total of 10,000 Neurons per day at no charge" and "If you exceed any one of the above limits, further operations will fail with an error." Our neuron cap (8,000) stops first; if Cloudflare refuses a call anyway, the model tier is skipped in the same way.

The caps are settings, not code: `LIMIT_IP_*` and `LIMIT_GLOBAL_*` (`IDEAS`, `QLOO`, `AI`, `NEURONS`, `TAVILY`, `CHANNEL3`, `ORDERS`, `RETURNS`), `LIMIT_DAILY_CAP_USD`, `LIMIT_MAX_ITEMS` and `LIMIT_MAX_BUDGET_USD`. The deployed values are all written in the `vars` of `wrangler.jsonc` (a test keeps them equal to the defaults in `src/config.ts`), so changing one means editing that file and deploying again.

## Setup

Needs Node 22.18 or newer and a Cloudflare login (`npx wrangler login`): the Workers AI binding runs on Cloudflare even in local development. Cloudflare's configuration docs say: "Using Workers AI always accesses your Cloudflare account in order to run AI models and will incur usage charges even in local development."

```sh
npm install
# keys go in ../.env.local (tasteagent/.env.local), one KEY=value per line:
#   QLOO_API_KEY  TAVILY_API_KEY  CHANNEL3_API_KEY  PAYPAL_CLIENT_ID  PAYPAL_CLIENT_SECRET
npm run dev        # http://localhost:8791
```

`npm run dev` first runs `scripts/dev-vars.mjs`, which copies only those five keys from `../.env.local` into `.dev.vars` (the file `wrangler dev` reads). `.dev.vars` is git-ignored and written with mode 600, and the script prints key names, never values. Keys are used only on the server: they are never sent to the browser, never logged, and error messages are redacted. `npm run dev` also sets `DEV_CACHE=1`, which caches Qloo and model answers while developing (Channel3 and Tavily answers are always cached for 12 hours; Qloo answers are not cached in production).

Optional settings (plain environment variables): `AI_AGENT_MODEL`, `AI_WRITER_MODEL`, `FORCE_MOCK`, `PUBLIC_BASE_URL`, and the `LIMIT_*` settings above (already set in `wrangler.jsonc`).

Deploying is not part of this repository's checks. A deployment needs the five keys as Worker secrets (`wrangler secret put NAME` asks for the value at a prompt or reads it from stdin, so it never appears in the command line, shell history or output). `wrangler.jsonc` already holds the `AI` binding and the spend meter, a SQLite-backed Durable Object (migration `v1`; Workers Free runs only this kind). The KV binding has no id: Cloudflare's docs say Wrangler creates a KV namespace without one at deploy time and writes the id back to the config file.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | local Worker with static assets on port 8791 |
| `npm test` | unit tests (money rules, adapters on documented fixtures, malformed model JSON, spend counters, contrast of the stylesheet, static checks) |
| `npm run typecheck` | `tsc --noEmit` on `src/` |
| `npm run build` | `wrangler deploy --dry-run`: bundles the Worker without deploying |
| `npm run e2e` | real Chromium against `wrangler dev`: the full flow with a PayPal sandbox guest payment to COMPLETED, then a tour of every screen and error state at 1280 and 390 px (key screens also at 768 and 320 px); the screens go to `evidence/screens/` (git-ignored). Everything captured from live services (run data, live screenshots, the dev server's log and state) goes to a folder outside the repository, `tasteloom-live` in the temp folder or `TASTELOOM_LIVE_DIR`. No run rewrites a tracked file: `npm run e2e -- --evidence` (both phases) refreshes `evidence/e2e.txt`. `npm run e2e -- tour` runs the tour alone and makes no billed call. `TOUR_BROWSER=firefox node scripts/e2e.mjs tour` runs it in Firefox (`/usr/bin/firefox`, no downloads; shots go to `evidence/debug/firefox/`) |
| `npm run contract:qloo` | cheap live check of the Qloo API against the shapes the code expects |
| `npm run scan` | secret and privacy scan of the tracked files, built assets and git history; it only prints, and `npm run scan -- --write` also saves the report as `evidence/scan.txt` |

## Rules the server enforces

- **Prices come only from the cards the server stored for the session.** The browser sends a session id and card ids; any price it sends is ignored.
- **Caps.** A total above the buyer's budget, or above the global daily cap, is refused before PayPal is called.
- **One capture, only after approval.** Capture needs a fresh PayPal read showing `APPROVED` with the same amount and currency; the request id makes a repeat harmless, and opening the return link twice does not capture twice.
- **Sandbox only.** The PayPal host is a constant; the UI says "sandbox, no real money" next to every payment step.
- **Spend limits.** The caps in the Limits section, plus a per-request subrequest budget (the model calls count too), hard timeouts and a 2 MB cap on upstream answers. When a limit is reached the page says so and offers the example.
- **Untrusted text.** Model output is parsed tolerantly and then checked; shop text is clipped, links must be https, and the page has no HTML-injection sinks and a strict Content Security Policy.

## Privacy

No accounts, no cookies. What you type is sent to the server to build your ideas, and the favourites are not stored; the section "What is sent where" lists which services receive it. The server keeps only the saved product cards and the budget (for server-side pricing, 2 hours; the saved example is not stored at all), orders (7 days), cached Channel3 and Tavily answers (12 hours, keyed by a hash of the search) and daily counters keyed by a hash of the day and your IP (IPv6: its /64 network), cleared the next UTC day. The browser keeps your inputs, finished run and picks in `sessionStorage` (this tab only) so the return from PayPal's cancel page restores them. The page ships no third-party logos or fonts; product images load from the shops' CDNs only after you turn on the image switch.

## Design

Plain HTML, CSS and ES modules in `public/` (no framework, no build step). One warm palette with a single accent, three screens with a step indicator, every state designed (loading, empty, errors, limits, cancelled, failed capture, receipt), visible focus rings, keyboard use end to end, responsive from 320 px phones to desktop (every state is screenshot at 1280 and 390 px, the key screens also at 768 and 320 px), and a stylesheet whose colours are tested for WCAG contrast. `npm run e2e` checks accessibility basics, focus rings, layout shift and horizontal overflow in a real browser.

## Known limits

- Qloo's quota for this key is not known to this project; the Qloo caps above are our own, sized from measured use. The live API was checked on 2026-10-22 (`npm run contract:qloo`).
- Channel3's catalog is thin for niche items: many Qloo suggestions return nothing buyable, so a run often shows few product ideas and some experience links.
- Tavily price checks rarely confirm a price; they are informational.
- The model is small and free: its answers are checked by the server, and a run can finish on the fixed pipeline or on templates.
- PayPal's hosted sandbox page is outside this app's control and its layout varies. In testing it showed either a "Save info & create your PayPal account" switch with a "Pay Now" button, or two buttons, "Create Account & Pay Now" and "Pay now as guest"; the guest one is the right one (the checkout screen says so). If a load offers only account creation, reload the PayPal page.
- Workers Free allows 10 ms of CPU per request and 50 subrequests. The Node tests measure about 5 to 8 ms of this app's own work per run, mostly waiting on the network, but that was not measured on Cloudflare. A run makes about 25 outgoing calls (the budget stops at 40).
- Files in `evidence/` dated 2026-10-16 and 2026-10-17 (the two reviews, the security test runs, and the pictures `evidence/before-after-home.png` and `evidence/before-after-ideas.png`, which still show the Nebius steps) come from the first build, when the model ran on Nebius; the model is now Cloudflare Workers AI.

## Why "Tasteloom"

A loom weaves separate threads into one cloth. Tasteloom takes separate threads of taste (a book, a band, a shop, a city) and weaves them into gifts, keeping each thread visible in the "because" line.

## License

MIT, see `LICENSE`.
