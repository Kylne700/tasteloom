# Security review: payments, agent, spend, web, secrets, privacy

> First-build file (written 2026-10-16 to 2026-10-17, when the model ran on Nebius; the model is now Cloudflare Workers AI). Its hosting dates and costs are the first plan. Kept as history.

Stage 2 of the pre-launch work, 2026-10-17, starting from HEAD 2ce0d5a (design review, no src changes). Scope: README.md,
src/, public/, scripts/, test/, evidence/first-build/design-review.md, wrangler.jsonc. Method: read every request path; write a test for
every finding I fix and run it against the untouched code first (`evidence/first-build/security-tests-before.txt`: 14 unit tests, 14 fail; one browser check, fails);
fix; then run the full check set. Deployment target: Cloudflare Workers Free, public until about Dec 15; PayPal sandbox;
Nebius ($25 credit), Tavily, Channel3 (1,000 searches a month) and Qloo (hackathon key) are real.

## Findings by severity

| Id | Severity | Finding | Where (before the fix) | Status |
| --- | --- | --- | --- | --- |
| H1 | High | Spend caps fail open: a failed counter write is swallowed, the next request reloads the stale count, so once KV writes fail (Free: 1,000 writes a day, also used by sessions, the 12 h cache and the unmetered `/api/sample`) no cap holds for the rest of the day | src/lib/limits.ts:77-85, src/app.ts:51,61,181 | fixed |
| H2 | High | Lost updates: counters are read once per request, checked in memory and written at the end, so N parallel requests each get the full allowance; KV adds up to 60 s of cross-location staleness. Measured before the fix: 4 parallel runs with a cap of 2 made 8 Channel3 calls | src/lib/limits.ts:42-58 | fixed |
| M1 | Medium | Qloo calls are not metered at all (no per-client or global cap on the hackathon key). Measured: cap 0, 3 live Qloo calls | src/lib/http.ts:40-44, src/types.ts:27 | fixed |
| M2 | Medium | Nebius is capped in requests only; the $25 credit is spent in tokens and nothing bounds tokens per client or per day | src/adapters/nebius.ts:96-101, src/types.ts:27 | fixed |
| M3 | Medium | Global defaults exceed the free quotas they claim to sit under: Channel3 60 a day is 1,860 a month (quota 1,000), Tavily 100 a day is 3,100 a month (1,000) | src/config.ts:45-47 | fixed |
| M4 | Medium | Per-client caps are per IPv6 address; one /64 gives a visitor 2^64 fresh allowances, so for IPv6 only the global cap applies | src/app.ts:48-50 | fixed |
| M5 | Medium (privacy rule) | Product images load by default, so every shop's image server gets the visitor's IP (and, from which products it serves, a hint of what they typed) before any choice; the brief allows third-party images only behind the toggle. Measured before the fix: 9 third-party image requests on the ideas page before any click | public/ideas.js:6-15, public/ideas.js:248, public/checkout.js:49 | fixed |
| L1 | Low | Upstream bodies are read whole, with no size bound | src/lib/http.ts:75 | fixed |
| L2 | Low | One model turn may request any number of tool calls; all run in parallel | src/agent/loop.ts:65 | fixed |
| L3 | Low (privacy rule) | Logs carry up to 200 characters of upstream error bodies, which can echo what the visitor typed (seen: Qloo errors naming the query) | src/app.ts:134,163,178 with src/lib/http.ts:83 | fixed |
| L4 | Low | POST endpoints accept any content type, so any web page can make its visitors' browsers start billed runs with `text/plain` or form posts (no CORS preflight); this spreads one attacker over many visitor IPs and writes sessions | src/app.ts:141-150 | fixed |
| L5 | Low | The NDJSON stream has no `nosniff` or `Referrer-Policy`; no API answer has a CSP or `frame-ancestors` | src/app.ts:57-59,190 | fixed |
| L6 | Low | `/api/sample` and `/api/status` are unmetered: a script can spend the KV write quota (one session per sample) and Durable Object requests (one per status read). Availability only, no paid call; the Workers Free limit of 100,000 requests a day is the same ceiling for any endpoint | src/app.ts:64-77 | documented |
| L7 | Low | `createOrder` sends a fresh `PayPal-Request-Id` each call; double submits are folded by our own pointer (same session and selection reuse the order), but two tabs racing can create two sandbox orders. Each is captured only after its own approval | src/adapters/paypal.ts:100-101, src/commerce.ts:95-100 | documented |
| L8 | Low | `readJson` reads the whole request body before its 8 KB check; Cloudflare accepts bodies up to 100 MB on Free, so one large post can use a lot of a Worker's 128 MB (availability only, nothing is stored) | src/app.ts:152-154 | fixed |
| I1 | Info | The IP hash is sha256(day + IP) cut to 16 hex: pseudonymous, not anonymous (IPv4 can be enumerated per day). The meter deletes all counters at its first reservation of the next UTC day | src/app.ts:65, src/lib/limits.ts:41-47 | documented |
| I2 | Info | `x-forwarded-for` is read only when `cf-connecting-ip` is missing, which on Cloudflare never happens (the edge sets it); it matters only for `wrangler dev` | src/app.ts:48 | documented |

## Threat model verdicts

### 1. Money integrity: OK (no finding)
- Amounts come only from stored cards: `priceOrder` reads the session's cards by id (src/commerce.ts:50-70); the checkout route reads only `sessionId` and `itemIds` (src/app.ts:102-117). Test: money.test.ts "a tampered client price, title and total are ignored".
- Currency and totals: integer cents throughout; `buildOrderBody` builds item_total and the breakdown from cents and refuses a total that is not the sum of its lines (src/adapters/paypal.ts:56-90). USD is a constant (src/commerce.ts:116). Quantity is not an input (repeated ids count once, src/commerce.ts:52).
- Tampering: unknown, link-only, malformed or over-budget selections are refused before PayPal (src/commerce.ts:50-70; money.test.ts:101-125).
- One capture, only after APPROVED for this session's order: `finishOrder` reads PayPal fresh, needs APPROVED with the stored amount and USD, then captures with the stable request id `cap-<id>` (src/commerce.ts:149-166, src/adapters/paypal.ts:144-147). The return loop's tools only accept the order being returned (src/agent/orders.ts:63-80). Tests: money.test.ts:191-245, agent.test.ts:227-262.
- Order ids are validated before they reach a URL (src/adapters/paypal.ts:11-12, src/app.ts:121,128,135).
- Sandbox only: `PAYPAL_BASE` and the approve host are constants (src/config.ts:4-5); there is no switch. An approve link from PayPal on another host is replaced (src/adapters/paypal.ts:107-108). Live credentials would fail OAuth against the sandbox host, so they can never move money.

### 2. Agent safety under prompt injection: OK; one Low (L2, tool calls per turn), fixed
- The ideas loop has only qloo_search, qloo_insights and find_products (src/agent/ideas.ts:273,280,292); no tool there can create or capture an order. find_products accepts only entity ids that Qloo returned and clamps the model's price cap to the buyer's budget (src/agent/ideas.ts:217-224).
- create_order runs in a separate loop that sees only the buyer's selected ids, and the server creates exactly that selection whatever the model asks (src/agent/orders.ts:23-55; agent.test.ts:209).
- Out-of-order calls: capture_order always goes through the guarded `finishOrder` (fresh read, APPROVED, same amount), so calling it first does nothing (agent.test.ts:227). Unknown tools and bad arguments count as bad calls; three end the loop (src/agent/loop.ts:73-91).
- Keys: no prompt contains a key; the model sees only clipped tool results (src/agent/loop.ts:41-44). Reasons from the model are checked for prices and links before display (agent.test.ts:71).
- Arbitrary URLs: no tool fetches a URL; every server fetch goes to a constant host (src/config.ts:4-9).
- Bounds: after L2, at most 8 tool calls per turn; 6 turns for ideas, 2 for checkout, 4 for the return; 40 subrequests per request (src/app.ts:27).

### 3. Spend: was High (H1, H2) and Medium (M1-M4); fixed
See "Spend design after the fix" below for the caps, the worst case in calls and the Nebius arithmetic.
- `max_tokens` is always sent: 2,000 for agent turns (src/agent/loop.ts:60), 1,200 and 1,500 for the other Nemotron calls
  (src/agent/ideas.ts:353,396), 1,500 by default (src/adapters/nebius.ts:101). Upstream answers stop at 2 MB (L1); loops
  are bounded (item 2).

### 4. Web: Low findings only (L4, L5, L8); fixed
- XSS: every server or third-party string reaches the DOM through `h()` as text or a `setAttribute` value (public/dom.js:5-15); links and images pass `safeUrl`, which keeps https only (public/dom.js:62-69); there is no innerHTML, insertAdjacentHTML, document.write or eval in public/ (searched). Static assets carry a strict CSP: `script-src 'self'`, `frame-ancestors 'none'`, `form-action 'self'`, `base-uri 'none'`, `object-src 'none'` (public/_headers:2).
- CORS: the Worker sends no CORS headers, so other origins cannot read API answers or send JSON (a JSON POST needs a preflight that fails). After L4, the simple-request cases (text/plain, forms) get 415.
- Clickjacking: `frame-ancestors 'none'` on assets (public/_headers:2) and, after L5, on API answers.
- Open redirects: `/api/return` and `/api/cancel` redirect only to fixed relative paths with a validated id (src/app.ts:126-137). PayPal return and cancel URLs come from `PUBLIC_BASE_URL` or the request origin (src/app.ts:111).
- SSRF: none; no server fetch uses a URL from a model, Qloo, Channel3 or Tavily. Product images are loaded by the browser.
- Error leaks: the browser gets fixed messages per error kind (src/app.ts:164-170, src/adapters/paypal.ts:150-157); upstream text and keys never reach it, and keys are redacted from error messages (src/lib/http.ts:76,86; adapters.test.ts:303). Logs: see L3.

### 5. Secrets: OK (no finding)
- Client assets: keys are read only from the Worker env (src/config.ts:33-42); `/api/status` returns modes, budget bounds and the global usage counts only (src/config.ts:90-98, src/app.ts:75; limits.test.ts "never a key"). `npm run scan` checks tracked files, the built bundle and git history.
- Logs and error bodies: keys are redacted (src/lib/http.ts:76,86); after L3, logs carry no upstream text at all.
- `.dev.vars` and `.env*` are git-ignored (.gitignore:2-3); `scripts/dev-vars.mjs` writes `.dev.vars` with mode 600 and prints key names only.
- Deploy path: documented in README "Setup" and "Deploy notes" below (secrets via `wrangler secret put NAME`, which reads the value from a prompt or stdin, so it never appears in shell history or output).

### 6. Privacy: one Medium (M5) and one Low (L3), fixed
- Nothing typed is stored: sessions hold cards and the budget, cache keys are hashes, and KV holds no counters any more; the meter (one Durable Object) stores only `i:<visitor hash>` counters, the global counters and the day, and gets no typed text or IP (limits.test.ts "privacy: KV holds the session and cache entries, the meter hashed counters...").
- Logs: after L3 a failure logs its kind, service and status only (security.test.ts "privacy: logs ...").
- Third-party images: after M5 they load only after the visitor turns the image switch on; see "Images" below.

## Spend design after the fix

One meter for every billed call. `callJson` reserves each call before the subrequest leaves (src/lib/http.ts:40-45,65-66):
Qloo, Nebius (one request plus estimated tokens, src/adapters/nebius.ts:109), Tavily and Channel3. A run reserves `ideas`
(src/app.ts:95); a sandbox order reserves `orders` and its total in `cents`, and gives the cents back only when PayPal refuses
the order (src/commerce.ts:101-106). The meter is one Durable Object, `MeterDO` (src/index.ts:7-18; binding and SQLite
migration in wrangler.jsonc:13-14). Its methods are synchronous over `ctx.storage.kv`, so each check-and-add runs alone; a
reservation that would pass either cap is refused whole and writes nothing (src/lib/limits.ts:34-88). A count that is not a finite number of 0 or more is refused (src/lib/limits.ts:56), so a bad
estimate cannot switch a cap off. KV holds no counters.

| Counter | Per visitor a day | Global a day | Why the global number |
| --- | --- | --- | --- |
| ideas (runs) | 8 | 100 | |
| qloo (calls) | 60 | 600 | bounds the hackathon key; no quota number is known for it |
| nebius (calls) | 80 | 600 | |
| tokens (estimated) | 150,000 | 400,000 | the $25 credit, below |
| tavily (calls) | 10 | 30 | 30 x 31 = 930, under 1,000 credits a month (a `fast` search cost 1 credit in the spike) |
| channel3 (calls) | 10 | 30 | 30 x 31 = 930, under 1,000 searches a month |
| orders (sandbox) | 8 | 100 | |
| cents (sandbox totals) | none | $2,000 | `LIMIT_DAILY_CAP_USD` |

Defaults in src/config.ts:44-69; each is a plain var (`LIMIT_IP_<NAME>`, `LIMIT_GLOBAL_<NAME>`). A visitor is an IPv4
address or an IPv6 /64 (src/lib/limits.ts:154-161), hashed with the day (src/app.ts:65).

Capacity. One live-mode run against the test harness's fake upstreams made 7 Qloo, 6 Nebius (19,359 estimated tokens),
5 Channel3 and 4 Tavily calls. So a visitor gets about 2 runs with live products a day (Channel3 10/5), and all visitors
together about 6 (Channel3 30/5; Nebius tokens would allow about 20). The 12 h response cache serves repeated searches
without a call. What the page shows at a cap is unchanged (the limit message and the example). Lead: about 6 full live runs
a day is the price of staying inside Channel3's and Tavily's free month.

Worst case in calls, under any concurrency:
- Per counter, at most the cap, per visitor and globally, per UTC day. Reservations are serialized in the Durable Object
  and made before the call. Unit test: 4 parallel runs with cap 2 make 2 Channel3 calls (8 before the fix). Real Durable
  Object in workerd (`node scripts/meter-race.mjs`, wrangler dev): 10 parallel runs with `LIMIT_IP_IDEAS=3` gave 3 started,
  7 refused with 429, meter usage `{ ideas: 3 }`.
- Every attempt counts: failed calls, timeouts and the one Nebius retry (src/adapters/nebius.ts:112-123), so upstream
  errors cannot multiply spend.
- A reservation not followed by a call (the 40-subrequest budget ran out, src/lib/http.ts:67) is not given back: it errs
  toward fewer calls.
- Meter unreachable or binding missing: 0 billed calls, checkout included (src/lib/limits.ts:121-132). The example and
  `/api/status` still work; the log line says "meter unreachable, call refused" with the error name only.
- Midnight UTC: the meter only rolls forward (src/lib/limits.ts:41-47). A request stamped with the old day that reaches it
  after the roll is charged to the new day's global count, so the global cap still holds.
- Ceiling for one day, all visitors together: 100 runs, 600 Qloo, 600 Nebius calls and 400,000 estimated tokens, 30 Tavily,
  30 Channel3, 100 sandbox orders, $2,000 sandbox.

Nebius credit. 400,000 estimated tokens a day for 60 days (Oct 17 to Dec 15) is 24M tokens. Billed at $0.90 per 1M, the
output price of the dearest model we call (`nvidia/nemotron-3-super-120b-a12b`; input is $0.30; Token Factory catalog as
recorded in the 2026-10-16 spike), that is at most $21.60 of the $25. Assumptions: the estimate is prompt characters / 3 +
`max_tokens` (src/adapters/nebius.ts:109); `max_tokens` bounds the output, but a prompt under 3 characters a token is
under-counted; prices unchanged since 2026-10-16. Credit left on the account: NOT VERIFIED (needs the Nebius console).

Durable Object limits on Workers Free (100,000 requests and 100,000 rows written a day): a day at every global cap is about
1,460 accepted reservations, two keys written each. Every billed call, refused reservation and `/api/status` read is one
Durable Object request. Running out makes the meter unreachable, which refuses billed calls (L6): availability, never spend.

## Images (M5)

Before: the ideas and checkout pages set `src` on every product image as soon as cards arrived; images were on unless the
visitor turned them off. Tour check `ideas-images-default` on the old code: FAIL, 9 third-party image requests and 9
image sources before any click. After: images start off unless the visitor turned them on in this tab (`sessionStorage`)
or the URL says `?images=on`; while off, cards carry `data-src` only, so the browser asks the shops for nothing
(public/dom.js:60, public/ideas.js:6-16, public/ideas.js:250, public/checkout.js:49). Turning the switch on copies
`data-src` into `src` (public/ideas.js:77). Same check after: PASS, 0 requests and 0 sources before the switch, 9 after
(desktop tour round 261 pass, 0 fail). Product change: the ideas page now opens in the existing images-off look.

## Fixes (file:line after the fix)

- H1, H2: src/lib/limits.ts:34-88 (Counter; bad counts refused at 56), 108-151 (Meter, fail closed at 121-132); src/index.ts:7-18 (MeterDO);
  wrangler.jsonc:13-14; callers src/lib/http.ts:65-66, src/app.ts:66,95, src/commerce.ts:101-106.
- M1: src/lib/http.ts:40-45 (Qloo is billed). M2: src/adapters/nebius.ts:109, src/config.ts:50,60.
- M3: src/config.ts:55-64. M4: src/lib/limits.ts:154-161, src/app.ts:65. M5: see "Images".
- L1: src/lib/http.ts:74-78, 91-109 (2 MB, streamed, cancelled when over). L2: src/agent/loop.ts:47,63.
- L8: src/app.ts:153 (reads at most 8 KB through the shared `readText`, src/lib/http.ts:94).
- L3: src/app.ts:173-176 (`logOf`), used at 145, 180, 195. L4: src/app.ts:57-59 (415). L5: src/app.ts:46-53 (set after
  `next()`, so streams, redirects, 404s and errors carry them).

## Tests added

- `test/security.test.ts`, 14 tests: all 14 failed on the code before their fixes (`evidence/first-build/security-tests-before.txt`;
  the last two were added after commit 0dcdc7b) and pass after (`evidence/first-build/security-tests-after.txt`).
- `test/limits.test.ts`, rewritten for the meter: per visitor then global; a reservation refused whole (tokens included);
  cents given back; per visitor and per day; fail closed with no or a dead meter; `visitorOf`; privacy (the meter gets a
  16-hex hash, no typed text, no IP).
- `test/static.test.ts`: the METER binding, the `new_sqlite_classes` migration and the MeterDO export.
- Browser: `ideas-images-default` in scripts/lib/tour.mjs (FAIL before, PASS after). `scripts/meter-race.mjs`: the real
  Durable Object under 10 parallel runs (run by hand; not in `npm run e2e`). scripts/e2e.mjs now also checks that the meter
  counted the live run, Qloo and tokens included.

## Deploy notes

- Keys as Worker secrets: `wrangler secret put NAME` reads the value from a prompt or stdin.
- The first deploy applies migration `v1` (`new_sqlite_classes`); Workers Free runs only SQLite-backed Durable Objects.
- `wrangler.jsonc` needs a real KV namespace id (sessions, orders, cache).
- Without the METER binding every billed call is refused; the example still works.

## Left open

- No deploy in this stage: the meter is verified in unit tests and in workerd under wrangler dev; on Cloudflare's edge:
  NOT VERIFIED. Nebius credit left and current prices: NOT VERIFIED. Qloo's quota for the hackathon key: unknown.
- Qloo and Nebius ran as mocks in the e2e run (no keys in this environment), so their metering is covered by unit tests
  only; the live run counted ideas, Tavily, Channel3 and orders.
- Documented, not fixed: L6, L7.
- src/adapters/paypal.ts:154 still says "sandbox" in the declined-card text: this stage did not touch that file.

## Checks run (2026-10-17)

- `npm test`: exit 0, 130 pass, 0 fail. `npm run typecheck`: exit 0. `npm run build`: exit 0; the bundle lists
  `env.METER (MeterDO) Durable Object`.
- `nice -n 10 npm run e2e`, run twice (before and after the last two fixes): exit 0 both times, RESULT PASS, 762 checks,
  0 failed, 231 s; each live sandbox order reached COMPLETED with one capture, and reopening the return link did not
  capture twice. Billed calls this stage: Channel3 8, Tavily 8 (4 and 4 a run).
- `npm run scan`: exit 0, PASS (secret hits 0, denylist lines 0).
- `node scripts/meter-race.mjs`: 3 runs started, 7 refused with 429; a text/plain POST got 415.
