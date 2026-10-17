# Tasteloom design review and polish (stage 2)

Start HEAD f24f118. Commits: 93b03aa, 7d0fd62, cec3674, a493528 (this file and the evidence) and one later correction of this file. Local only, nothing pushed. Light theme only: the app has no dark theme and none was added. Only CSS, markup, client rendering and copy changed; no payment, pricing, caps, adapter, agent-loop or server-route code (`git diff f24f118 --stat -- src` is empty).

## How it was reviewed

- What the committed tour (`npm run e2e`) renders: every state (35 plus the new `checkout-images-off`) at 1280 and 390 px, and only the key screens at 768 and 320 px. Before (f24f118: `evidence/screens-before/`, 97 files = 40 at 1280, 36 at 390, 11 at 768, 10 at 320) and after (`evidence/screens-after/`, 99 files = 41 / 37 / 11 / 10) are those sets. Both folders are git-ignored because they show shop product photos. The four tracked pictures below use product images off.
- Every state at 768 and 320 px, which the brief asks for and the committed tour does not do: run once as a one-off after the official e2e (the `tablet` and `narrow` rounds temporarily set to every state in `scripts/e2e.mjs`, tour only on mocks, then reverted; nothing committed). Result: PASS, 504 checks, 0 failed, exit 0, 138 s; 36 shots at each width, every one with the no-sideways-scroll check passing; 0 console errors; layout shift at most 0.007; 0 billed calls. The 26 extra shots per width have no "before" picture, so they were reviewed from scratch, not compared: all 26 at 320 px (top 1500 px of each) on contact sheets, and 12 of the 26 at 768 px (top 1100 px): home-error-favs, ideas-error-partial, ideas-error-bad-input, ideas-empty, checkout-mismatch, checkout-error-upstream, checkout-error-over-budget, checkout-cancelled, receipt-capture-failed, receipt-created, receipt-not-found, receipt-error. Nothing needed a change; two judgement items are under "left as is". The other 14 states at 768 px, and the lower part of the long pages, had the automated checks only. The shots are in `evidence/screens/` (git-ignored) and were not copied into `screens-after/`.
- Looked at on contact sheets and crops, plus the tour's own per-screen checks: no sideways scroll, one h1 and no skipped heading level, landmarks and live region, touch targets of 24 px or more, a focus ring on every Tab stop, one filled button per state, AA contrast.
- Brief criteria walked through: one primary action per screen, spacing grid, radii 18/14/10 and two shadows from the tokens, taste-link chips, live agent steps without layout jump, loading/empty/error/limit states, PayPal test-card panel with copy buttons, receipt.
- Result: the earlier design stages had left the app consistent; this pass found the five leftovers named in the brief plus four more (rows 6 to 9), all fixed.

## What changed (file:line at HEAD)

| # | Finding | Change | Where |
|---|---|---|---|
| 1 | Coda card: shop name wrapped above the price | card meta is a column: price first, then the shop, so a long shop name never moves the price | public/ideas.js:261, public/styles.css:267-268 |
| 2 | tinggly Kew card with no blurb | one muted line from the card's own address (path words, no query or fragment), only when the card has no price and no snippet; it never describes the product | public/ideas.js:24-45 (`addressWords`), 254, 262, public/styles.css:273 |
| 3 | Home: count line and error repeated each other | the count line drops "Add N more to continue" while the too-few error already says it, and follows every change of the error | public/taste.js:22, 41, 45-50, 68, 125 |
| 4 | Receipt said "sandbox" three times | completed subtitle no longer says it; the Mode row is the one clear disclosure next to the header badge; the footer sentence is hidden on receipt routes; README line updated | public/receipt.js:7, public/index.html:35, public/app.js:80, public/styles.css:354, README.md:14 |
| 5 | Remove (X) button below the price on narrow checkout lines | up to 760 px a line has four columns; up to 560 px it is a grid: photo and name on top, price and X side by side under the name | public/styles.css:394, 421-426 |
| 6 | Agent steps: reader chases the newest step | on wide screens the step panel follows the newest step while the run is live, stops when the reader scrolls up, resumes at the end; the scrollbar gutter is reserved so steps do not re-wrap; only the panel moves, never the page (CLS 0) | public/ideas.js:116-120, 381, 388, 393, 435, 461, public/styles.css:361 |
| 7 | 320 px: test card number wrapped | Copy button moves beside the label, the number gets the full width at 1rem | public/styles.css:432-435 |
| 8 | 320 px: shop host broke mid-word on link cards | host breaks after a dot | public/ideas.js:22, 261 |
| 9 | Header: two "Back to ideas" without CSS `:has()` | `@supports not selector(:has(*))` hides the banner's twin, so one button remains | public/styles.css:152-154 |

Harness (not product code), `scripts/`: Firefox option `TOUR_BROWSER=firefox` (lib/browser.mjs:7-8, e2e.mjs launch branch); Tab walk with a start and an end marker (lib/browser.mjs:196-233); `sandboxMentions` counts (receipt: 2, or 3 only where the server's own error text says it); step-panel follow and CLS checks while streaming; "exactly one Back to ideas without :has()" on every checkout error state; new state 36 `checkout-images-off` (lib/tour.mjs, end of `states`).

## Before and after pictures (tracked, product images off)

| File | Shows | Size |
|---|---|---|
| evidence/before-after-home.png | home at 1280 with the too-few error: count line no longer repeats it | 56 KB |
| evidence/before-after-ideas.png | ideas with the agent steps at 1280 (top 1500 px): price row above the shop on every card | 104 KB |
| evidence/before-after-checkout.png | checkout at 390 px, photos hidden: price and remove button side by side | 61 KB |
| evidence/before-after-receipt.png | completed receipt at 1280: one disclosure, no repeat in the subtitle or footer | 28 KB |

The home (empty) and the checkout at 1280 are visually unchanged (23 pixels differ), so the pictures use the states where the change shows. The "before" half of the checkout picture was made by running the same tour state against the f24f118 `public/` files (put back afterwards).

## AA contrast ratios (WCAG formula, same as test/contrast.test.ts, which checks every colour rule in public/styles.css)

Text, 4.5:1 needed:

| Pair | Ratio |
|---|---|
| ink on bg / surface / sand | 14.64 / 15.52 / 13.33 |
| ink-2 (secondary text) on bg / surface / sand | 7.56 / 8.02 / 6.88 |
| accent (links, eyebrow) on bg / surface / sand | 5.46 / 5.79 / 4.98 |
| accent-strong on accent-soft | 6.49 |
| white on accent (primary button) / on accent-hover | 5.88 / 7.82 |
| ok on ok-soft, warn on warn-soft, bad on bad-soft | 5.56, 6.18, 6.09 |
| ink on ok-soft / warn-soft / bad-soft | 13.48 / 13.67 / 12.87 |
| bad on bg / surface (inline errors) | 6.92 / 7.34 |
| input placeholder (ink-2 at 0.85 opacity) on surface | 5.39 |

Controls and focus, 3:1 needed:

| Pair | Ratio |
|---|---|
| edge (input, select, outline button, switch off-track, test-card dashes) on bg / surface / sand | 3.85 / 4.08 / 3.51 |
| white switch knob on the edge track / on the accent track | 4.15 / 5.88 |
| focus ring (3 px accent) on bg / surface / sand / accent-soft | 5.46 / 5.79 / 4.98 / 4.78 |
| white focus ring on the dark skip bar | 15.76 |
| primary button fill and switch on-track (accent) on bg | 5.46 |

Lowest text ratio: 4.98 (accent on sand). Lowest control ratio: 3.51 (edge on sand). All pass.

## Check results (real)

- `npm test`: 115 pass, 0 fail. `npm run typecheck`: exit 0. `npm run build`: exit 0. `npm run scan`: exit 0 (secret hits 0, denylist lines 0; `evidence/scan.txt` is from the run before the last commit and goes stale by a few bytes with every commit).
- `npm run e2e` (at cec3674): RESULT PASS, 758 checks, 0 failed, 229 s, exit 0. Live PayPal sandbox capture COMPLETED and the server record agrees (one capture); the live phase used 4 Channel3 and 4 Tavily calls, the tour 0. 0 console errors or uncaught exceptions across all pages and states. No sideways scroll from 320 to 1440 px on home, ideas, checkout and receipt, and on all 99 screenshots. Layout shift: 0 while steps stream in, at most 0.02 while the example loads (limit 0.1). Keyboard: Tab stops all show a ring (home 12, ideas 27, checkout 11, receipt 8 in each of 4 rounds); the keyboard-only journey (type, Enter, ideas, pick a card with Tab and Enter, Review and pay, focus on the checkout heading) passes at 1280 and 390.
- Billed calls for the whole stage (caps 30 Channel3, 30 Tavily): 8 Channel3 and 8 Tavily. Two live phases ran, the two full e2e runs described here, 4 Channel3 and 4 Tavily each (the harness prints the counter deltas as `billed calls this live phase`; for the passing run see `evidence/e2e.txt` line 60; the first run's log is not kept in the repo). Nebius 0. PayPal sandbox orders created: 3 per live phase, no real money. Every tour-only run (Chromium, Firefox, the one-off 768/320 run) asserted deltas 0/0/0. A live-only run from stage 1 (before f24f118) is not counted here.
- An earlier full run (7d0fd62) failed 1 of 758 checks: the checkout Tab walk found 0 stops because Chromium continues sequential focus from the last click. Harness bug, fixed in cec3674 with a start marker; the run above is the second.

## Firefox

`TOUR_BROWSER=firefox node scripts/e2e.mjs tour --keep`, Firefox ESR 153.4.0 (`/usr/bin/firefox`) over WebDriver BiDi, no downloads: 697 checks, 0 failed, 314 s, 0 console errors. The first Firefox run had 18 failed focus and Tab checks. Cause (harness, not app): after the last control Firefox moves Tab focus into its own UI and the page never gets keyboard focus back, so later rings were not drawn (`document.hasFocus()` was false) and Tab then Enter did nothing. Standalone probes showed the 3 px ring. Fixed with the two markers in the Tab walk. Not measured in Firefox: layout shift (Firefox has no layout-shift entries; those checks are skipped there) and the clipboard (permission cannot be granted over BiDi; the Copy label and layout checks still run).

## The :has() fallback

The header "Back to ideas" is hidden by `.checkout:has(.notices a[href='#/ideas']) .head-actions` when a banner offers the same link. A browser without `:has()` drops that rule, keeps the header button and, through `@supports not selector(:has(*))` (public/styles.css:152-154), hides the banner's twin: one button. Both browsers in the tour support `:has()`, so the tour emulates a browser without it (deletes every rule with `:has(`, applies the `@supports` body unconditionally) on every checkout error state, at 1280 and 390: exactly 1 visible. Mutation test: with the fallback selector broken the check fails with 2 visible; intact it passes with 1. Limit: a browser lacking both `:has()` and `@supports selector()` (Chrome before 83, Safari before 14.1, Firefox before 69) ignores the fallback and shows two buttons; emulation is not a real old browser (NOT VERIFIED on one).

## What is left

Fixes that need server code (listed, not changed):
- src/adapters/paypal.ts:154: the declined-card message says "use the sandbox test card", so the capture-failed receipt names the sandbox a third time when that text is shown (the tour expects 3 there and 2 on every other receipt).
- Link cards that arrive without a blurb: a one-line page description from the adapter would replace the address line (public/ideas.js:254), which reads like a breadcrumb.

Left as is, by judgement:
- Receipt "Mode" row stacks under its label at 390 and 320 px (long value; same rule as the order id row).
- Button labels wrap to two lines at 320 px: Pay (the exact total stays on screen), Change favourites (ideas, bad-input state) and I approved it, check again (receipt, created and not approved states). Found in the 320 px review of every state.
- Receipt header at 320 px: the icon sits beside the title, which leaves a narrow text column (title up to 3 lines, subtitle up to 5). Readable; stacking the icon above the title below 360 px would be the polish.
- Receipt not-found and error states show the sandbox only in the header badge (no order, no Mode row; the footer sentence is hidden on every receipt route).
- Preset budget chips wrap to a second row at 320 px.

NOT VERIFIED: Safari/WebKit, real phones, screen readers, forced-colors mode, the look of reduced-motion (the rule exists, no capture), print. Layout shift and clipboard in Firefox (see above). In Firefox only every state at 1280 and 390 px and the key screens at 768 and 320 px ran, not every state at 768 and 320. Seen by eye: all 26 extra states at 320 px and 12 of 26 at 768 px; the other 14 at 768 px and the lower part of the long pages are covered by the automated checks only.

## Reproduce

`npm run e2e` (Chromium, live PayPal sandbox, tour at 1280/390 with key screens at 768/320; writes `evidence/e2e.txt`, `evidence/screens/`). `TOUR_BROWSER=firefox node scripts/e2e.mjs tour` for Firefox (shots in `evidence/debug/firefox/`). `TOUR_ROUNDS=desktop,mobile,tablet,narrow` and `TOUR_STATES=key1,key2` narrow a tour run. For every state at 768 and 320 px, set `full: true` on the `tablet` and `narrow` rounds in `scripts/e2e.mjs` (one-off, `git checkout scripts/e2e.mjs` afterwards) and run `TOUR_ROUNDS=tablet,narrow nice -n 10 node scripts/e2e.mjs tour --keep` (about 140 s, mocks only, 0 billed calls).
