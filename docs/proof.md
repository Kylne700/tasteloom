# The measured comparison: the same model on its own and inside Tasteloom

The in-app **Compare** panel points here. This page gives the method, every count and the limits of the two runs we made. It holds counts and categories only: the lists of gift ideas are not published (see [What is not published](#what-is-not-published)).

**Read this first.** The result is mixed, and it is small: 20 made-up people, one run per condition.

- Tasteloom gives far fewer "merch of something they already love" ideas than a model on its own (3 of 80, against 73 of 76 and 66 of 80), partly by design: the app drops anything you typed.
- On "the same gift for different people", the measure we froze in advance shows no clear difference (0 of 76, 2 of 80 and 0 of 80 at its 0.85 cut-off). But it also reads the reasons, and Tasteloom's reasons name each person's favourites, which hides repeats. On the gift text alone at 0.85, Tasteloom repeats more often than either model on its own (17 of 80, against 5 of 76 and 9 of 80; at 0.80 the three are about level: 17 of 80, 16 of 76 and 21 of 80), and only Tasteloom gave identical gift text to two or more people (17 of 80; none for the models). With favourite names masked the order reverses (19 of 80 for Tasteloom, 56 of 76 and 22 of 80 for the models, at 0.85). That is not a win for Tasteloom.
- After a change designed after we saw those repeats, on the same 20 people, one re-run gave 4 of 80. The change costs 42% more model compute per person and makes a run slower. Because it was designed on the people it was measured on, this does not show that it works for other people.

## In short

n = 20 made-up people with 4 gift ideas each. The model on its own has 76 ideas, not 80 (see [Notes on run 1](#notes-on-run-1)). A count is written k of n. "Frozen" means written down, with the hash of every script, before any scored data existed.

| What we counted | Model on its own | Bigger model on its own | Tasteloom, run 1 | Tasteloom after a change, run 2 |
| --- | --- | --- | --- | --- |
| Idea is merch of a favourite they already love (partly by design in Tasteloom) | 73 of 76 (96%) | 66 of 80 (83%) | 3 of 80 (4%) | 2 of 80 (3%) |
| Same gift also given to another person: the frozen measure, gift and reason text at least 0.85 similar | 0 of 76 (0%) | 2 of 80 (3%) | 0 of 80 (0%) | 0 of 80 (0%) |
| Same gift text given to another person: gift text alone at least 0.85 similar (a frozen check, not the main measure) | 5 of 76 (7%) | 9 of 80 (11%) | 17 of 80 (21%) | 4 of 80 (5%) |
| Reason names one of their favourites (by construction in Tasteloom) | 39 of 76 (51%) | 35 of 80 (44%) | 80 of 80 (100%) | 80 of 80 (100%) |

Counted after we saw the run 1 data (not frozen): gifts with identical text for two or more people. Model on its own 0 of 76, bigger model 0 of 80, Tasteloom 17 of 80 (21%) in run 1 (8 different things, one of them given to 3 people). For run 2 the matching count is the "same entity" count, defined before run 2 and after run 1: 4 of 80 (5%), 2 different things, each given to 2 people.

![Bar chart, 20 made-up people, 4 gift ideas each, one run per condition. Idea is merch of something they already love: model on its own 73 of 76 (96%), bigger model on its own 66 of 80 (83%), Tasteloom before the fix 3 of 80 (4%), after the fix 2 of 80 (3%). Same gift also given to another person, gift and reason text at least 0.85 similar: 0 of 76, 2 of 80 (3%), 0 of 80 before the fix, 0 of 80 after the fix. A caveat box says those orange bars also read the reasons, which hides repeats; on gift text only, 17 of Tasteloom's 80 gifts (21%) also went to another person before the fix and 4 of 80 (5%) after it, in one re-run on the same 20 people the fix was designed on; the models on their own gave no identical gifts to two people, and near-identical (0.85) 5 of 76 and 9 of 80.](proof-chart.png)

Reading the chart. Its orange bars are the frozen same-gift measure, which also reads the first 12 words of each reason. Tasteloom's reasons name each person's own favourites, which hides repeated gifts, so its 0% there must not be read alone. The box in the chart gives the gift-text-alone check. It was added to the design after the pilot runs on two other made-up people and before any scored data, as a check next to the main measure; the count of gifts with identical text, and its split by kind, were made after we saw the run 1 data. The box's 17 of 80 is both things: at 0.85 it is the gift-text row, and it is also the identical-text count.

## What we asked

One question: does Qloo matter? For the same 20 made-up people, how do the gift ideas of a language model on its own differ from the ideas of the same model inside Tasteloom (Qloo's taste links plus our rules)? We counted three things: whether an idea is merch of a favourite the person already loves, whether the same gift goes to different people, and whether the reason names one of their favourites.

- **Run 1**, frozen on 29 Oct 2026 at 17:46:47 UTC: three conditions, one run each, no re-runs.
- **Run 2**, on 30 Oct 2026: Tasteloom only, once more, after a change to its idea step (see [Run 2](#run-2-tasteloom-again-after-a-change)).

## Conditions and models

| Condition | What it is |
| --- | --- |
| Model on its own | `@cf/qwen/qwen3-30b-a3b-fp8` (Qwen3-30B-A3B), the model Tasteloom's agent uses, asked directly with a plain prompt: no Qloo, no rules, no lookups |
| Bigger model on its own | `@cf/openai/gpt-oss-120b`, the same prompt (it was available and used as it is; reasoning effort medium, at most 4000 output tokens) |
| Tasteloom | the app's own idea step (`POST /api/ideas`: Qloo plus the agent), ideas only, from the app at commit 75bb9a0 (run 1) and 0aaa605 (run 2). Its model is the same Qwen3-30B-A3B |

**The prompt for the two models on their own** (the same text for both, with the same budget wording). System message: `You are a helpful assistant.` User message:

```text
I need gift ideas for someone. They love: {favorites}. My budget per gift is ${budget}. Suggest 4 different gift ideas. Reply with JSON only, no other text: [{"gift": "<the item itself>", "reason": "<why they would like it>"}]
```

The favourites were shown with a plain type word (artist, book, brand, place, film, TV show, video game). The budget says "per gift" because the app treats the budget as a price ceiling for each gift card. The prompt did not tell the models to avoid naming the favourites. Both ran at temperature 0.2, the app's default for its agent loop and its picks; the smaller model had at most 1500 output tokens and the app's own `/no_think` suffix on the system message. The first 4 gifts parsed from each reply are the scored gifts; fewer are recorded as they are. A network error, an HTTP 429 or 5xx, or a Workers AI error was retried with the identical input at most 2 more times; nothing else was retried, and there was never a second sample. Retries in the final runs: 0 for the model on its own and 0 for the bigger model.

**How Tasteloom ran.** On a local development server with its own copy of the app's config: live Qloo and live Workers AI, no answer cache, and the shop (Channel3) and web-search (Tavily) steps paused by setting their caps to 0, so the ideas stay (marked "paused") and no shop or web call is made. The per-visitor and global caps were raised so that the meter never changed a run. The app's code was not edited: its commit was unchanged and its working tree clean before and after, and the server log shows no reload. A gift is the idea's entity name (its title when there is none) and its reason is the text of the separate reasons event for that idea; the first 4 ideas in arrival order are scored. This measures Tasteloom's choice of ideas, not what it can put on a shelf.

## How the people were made

We made up 20 people. Each has 3 real, well-known favourites (mixed domains, countries and eras) and a budget of $25, $50 or $100 (6, 8 and 6 people). No age, gender or name is given. The 60 favourites by kind: artist 17, destination 16, book 10, brand 6, movie 5, TV show 4, video game 2. The list was written down before the run and its hash was checked before every script ran; run 2 used the identical list (same hash). Two more made-up people were used only for debugging before the freeze and are never scored. The favourites are not listed here.

## The measures, frozen before run 1

- **M1, "already theirs".** The share of gifts whose gift text names one of that person's favourites. Text and names are normalised (accents off, lower case, apostrophes dropped, "&" read as "and", other symbols read as spaces). A favourite counts as named when one of its needles appears as whole words. The needles are the full name, the name without a leading "the", and, for people, the last word if it has 4 or more letters; titles, groups, places and brands use the full name only. Known limits: works of a favourite (an album title) are not detected, and a common-word name can match inside an unrelated gift. The cases are pinned in a test file that ran just before the freeze (6 pass, 0 fail).
- **M2, "same gift for different people", the main same-gift measure.** Every gift is embedded as its gift text plus the first 12 words of its reason, with `@cf/baai/bge-base-en-v1.5`. A gift is a cross-person repeat when its cosine similarity to any gift of another person (same condition) is at or above the cut-off. Reported at 0.80, 0.85 and 0.90; the chart shows 0.85.
- **M3, "reason names their favourite".** The M1 rule applied to the reason text. Context only.
- **Two checks next to M2, never replacing it:** (1) the gift text alone, without the reason words; (2) the gift text alone with the person's favourite names replaced by "x". We added them to the design after the pilot runs and before the freeze, so before any scored data, because Tasteloom's reasons share a template that names the favourite, and the models' gifts often carry the favourite's name: the two effects can pull M2 in different directions, so we assumed no direction.
- **A written commitment:** the chart shows M1 and M2 at 0.85 for all three conditions, whatever the result, and if Tasteloom came out worse than a model on its own on a measure, it goes into the chart and the reading unchanged.

## Run 1: results

### Frozen measures (k of n gifts or people)

| Measure | Model on its own | Bigger model on its own | Tasteloom |
| --- | --- | --- | --- |
| People / gifts | 20 / 76 | 20 / 80 | 20 / 80 |
| M1 gift is merch of a favourite they already love | 73 of 76 (96%) | 66 of 80 (83%) | 3 of 80 (4%) |
| M2 gift repeats for another person, similarity at least 0.80 | 11 of 76 (14%) | 15 of 80 (19%) | 4 of 80 (5%) |
| M2 gift repeats for another person, similarity at least 0.85 | 0 of 76 (0%) | 2 of 80 (3%) | 0 of 80 (0%) |
| M2 gift repeats for another person, similarity at least 0.90 | 0 of 76 (0%) | 0 of 80 (0%) | 0 of 80 (0%) |
| M3 reason names one of their favourites (context) | 39 of 76 (51%) | 35 of 80 (44%) | 80 of 80 (100%) |
| People with at least one M1 gift | 19 of 20 (95%) | 20 of 20 (100%) | 3 of 20 (15%) |
| People with at least one M2 repeat (at least 0.85) | 0 of 20 (0%) | 2 of 20 (10%) | 0 of 20 (0%) |

### Frozen checks next to M2 (not the main measure)

| Check | Model on its own | Bigger model on its own | Tasteloom |
| --- | --- | --- | --- |
| Gift text alone (no reason words), similarity at least 0.80 | 16 of 76 (21%) | 21 of 80 (26%) | 17 of 80 (21%) |
| Gift text alone, similarity at least 0.85 | 5 of 76 (7%) | 9 of 80 (11%) | 17 of 80 (21%) |
| Gift text alone, similarity at least 0.90 | 0 of 76 (0%) | 4 of 80 (5%) | 17 of 80 (21%) |
| Gift text alone, favourite names masked, similarity at least 0.80 | 69 of 76 (91%) | 42 of 80 (53%) | 19 of 80 (24%) |
| Gift text alone, favourite names masked, similarity at least 0.85 | 56 of 76 (74%) | 22 of 80 (28%) | 19 of 80 (24%) |
| Gift text alone, favourite names masked, similarity at least 0.90 | 44 of 76 (58%) | 11 of 80 (14%) | 17 of 80 (21%) |

### Counted after we saw the data (descriptive, not frozen measures)

- **Gifts with identical gift text for two or more people:** model on its own 0 of 76, bigger model 0 of 80, Tasteloom 17 of 80 gifts (8 different things; one of them given to 3 people). Identical gift text counts as a repeat at every cut-off, which is why Tasteloom's gift-text rows above read 17 of 80 at 0.80, 0.85 and 0.90.
- **Those 17 Tasteloom gifts by kind of thing:** brand 8, book 4, place 3, destination 2.

### Reading

The models on their own turn the favourite itself into the gift (M1: 73 of 76 and 66 of 80 gifts, against 3 of 80 for Tasteloom, partly by design). On the frozen same-gift measure almost no gift repeats across people at 0.85 (model on its own 0 of 76, bigger model 2 of 80, Tasteloom 0 of 80). The gift-text checks cut both ways: the same Qloo entity recurs for different people in Tasteloom (17 of 80 at 0.85, against 5 of 76 and 9 of 80), while with favourite names masked the models repeat the same kind of gift (56 of 76 and 22 of 80, against 19 of 80). So Qloo clearly changes the "already theirs" result, and the "same gift for different people" result is mixed and not a win for Tasteloom.

### Limits of the measures

- M3 is nearly guaranteed for Tasteloom: its reason writer must name the strongest-linked favourite, or a template that does replaces it. M3 is context only.
- M1 is low for Tasteloom partly by design: the app drops any Qloo result equal to a typed favourite. M1 only catches the favourite's name in the gift text, so it undercounts (a vinyl of an album by a favourite is not caught) and a common-word name can match inside an unrelated gift.
- When a gift names the favourite (merch), the name pushes it away from other people's gifts, so M1 and M2 can pull against each other. Tasteloom's reasons share a template that also names the favourite: the template can pull its texts together while the names push them apart, so we claim no direction for its M2. The two checks (gift text alone; names masked) are the cross-check.
- The similarity cut-offs are not strictly comparable between Tasteloom's short entity names and the models' longer product descriptions.
- With shop and web search paused, Tasteloom keeps ideas that a live product search would have dropped.

### What Tasteloom produced (counts and categories only)

- Gifts: 80 from 20 people; people with fewer than 4 ideas: none; runs with an error: none.
- How the ideas were made: tools 11, pipeline 9 (tools = the model's own tool loop made at least 4 ideas; pipeline = the app's built-in step-by-step pipeline topped the run up; see "The agent" in the [README](../README.md#the-agent)). Reasons kept by the server's grounding check: 96 of 104.
- Kinds of thing among the 80 gifts: brand 26, book 25, destination 12, artist 9, place 8. Idea kinds: product 60, experience 20. Gifts marked paused (shop or web search off): 80 of 80.
- Favourites resolved by Qloo: 57 of 60. Qloo calls in the final run: 157.

### Compute (run 1)

Workers AI neurons, Cloudflare's unit for Workers AI compute, as reported by the models for the final run: model on its own 107, bigger model 493, Tasteloom 1241, embeddings about 102 (from token counts). In all about 1943 neurons (the pilot added a little), of the 10,000 free neurons a day.

### Notes on run 1

- One reply from the model on its own was not valid JSON (a ")" where "}" belongs), so the frozen parser counted 0 gifts for that person, who stays in with 0 gifts: 76 gifts, not 80. There was no re-ask. The raw reply still holds 4 gift values; the M1 rule applied to them flags 4 of 4, so recovering them would make the model's M1 77 of 80 (96%) instead of 73 of 76 (96%). That is not in the tables, and M2 was not computed for them.
- Of Tasteloom's 20 runs, 11 let the model drive the Qloo tools and 9 fell back to the built-in pipeline after the model's loop. The run 1 notes guessed that the paused shop step, which makes every product search fail by design, might push some runs to the fallback; that was not verified, and the later replays described under Run 2 point to a different cause. Ideas come from Qloo entities in both tiers.
- The server log has no reload or rebuild line during the run, and the app's commit was unchanged before and after.

## Run 2: Tasteloom again, after a change

**Independence, read this first.** The fix was designed after seeing run 1's repeats on these same 20 people (the same entity given to different people: 17 of 80 gifts, 8 things), and after pilot runs on two other made-up people that were never scored. So run 2 does not show that the fix works for other people. It shows what the fix does where the repeats were seen. It is one run.

**What was run.** Tasteloom's idea step only, once, on 30 Oct 2026 from 00:07:23 to 00:10:52 UTC. No re-run and no pilots in between. All 20 people answered (HTTP 200) with no errors, and no shop or web-search unit was counted (caps 0, as in run 1). The code was engine commit 0aaa605 (merged into main as 853a5f8), run 1's method and scripts, and the 20 frozen people. 18 frozen files were checked before the run and again after the server start. There were four documented edits to the scripts (three to point at the copy of the app with the change, one to lower the stop for Qloo calls), and no pass or fail threshold was written in advance: if run 2 was worse on a measure, it is reported unchanged. The design was written down on 29 Oct 2026, before the run: first at 19:00:11 UTC, then stamped at 19:15:44 UTC after a review (nothing was measured between the two). One more line, about the run's budget and a lock, was added at 19:30 UTC with no change to the method.

**What the change does** (one commit, one run: the five parts below cannot be told apart in these results):

1. A popularity cut-off at 0.999 on Qloo's popularity percentile (0 to 1, higher means more popular): inside one list of suggestions, results at or above it are dropped only when a less popular result with a usable Qloo link remains. Typed favourites are removed first, and a list with nothing else stays whole.
2. Refusals that are not mistakes (a duplicate entity, a limit, ideas too alike, "no seeds yet") no longer count as strikes toward the 3 that end the model-driven tier.
3. The insights call waits for the searches that the model started in the same turn.
4. Place and destination count as one kind, so a run offers at most one place or trip.
5. The "too alike" refusal names three entities that would fit, and the model's prompt says so.

**Why that cut-off.** We chose 0.999 from run 1's repeated and non-repeated entities and from the two pilot people only. At 0.999, 5 of run 1's 8 repeated entities (covering 11 of its 17 repeated gifts) sit at or above the cut-off, and so do 2 of 20 sampled entities that were not repeated. So the cut-off alone could remove at most about 11 of the 17 repeated gifts. Run 1's recorded steps show that 8 of its 9 early stops (the loop ending after 3 strikes) came after the model's third turn and 1 after its first. Before run 2 we found two likely causes by replaying the code before the change with the live model and run 1's caps of 0: Qloo "insights" calls that run in the same turn as the searches they depend on (so they find no taste seeds yet), and several parallel product searches refused as "too alike". Both are refusals the model should not be punished for, and they fire before any shop call, so the paused shop is not the cause. This is NOT VERIFIED on run 1's own runs, whose tool answers were not recorded.

Three kinds of figure appear below, and we label them so: **frozen in run 1's design** (M1, M2, M3 and the two gift-text checks, unchanged scripts); **defined in run 2's design before the run, after we had seen run 1** (the same-entity counts, ideas per person, how the ideas were made, cost); and **post hoc** (counted by a script written after the run).

### Frozen measures, before and after (n = 80 gifts or 20 people)

| Measure | Run 1 | Run 2 |
| --- | --- | --- |
| M1 gift names a favourite they already love (for Tasteloom: the favourite itself or a near copy) | 3 of 80 (4%) | 2 of 80 (3%) |
| M2 gift and reason repeat for another person, similarity at least 0.80 | 4 of 80 (5%) | 0 of 80 (0%) |
| M2 similarity at least 0.85 | 0 of 80 (0%) | 0 of 80 (0%) |
| M2 similarity at least 0.90 | 0 of 80 (0%) | 0 of 80 (0%) |
| M3 reason names one of their favourites (context) | 80 of 80 (100%) | 80 of 80 (100%) |
| People with at least one M1 gift | 3 of 20 (15%) | 2 of 20 (10%) |
| People with at least one M2 repeat (at least 0.85) | 0 of 20 (0%) | 0 of 20 (0%) |

M1 went from 3 to 2 of 80, which is one gift: no change worth saying. M3 did not move.

### Frozen gift-text checks, before and after (n = 80 gifts)

| Check | Run 1 | Run 2 |
| --- | --- | --- |
| Gift text alone, similarity at least 0.80 | 17 of 80 (21%) | 4 of 80 (5%) |
| Gift text alone, similarity at least 0.85 | 17 of 80 (21%) | 4 of 80 (5%) |
| Gift text alone, similarity at least 0.90 | 17 of 80 (21%) | 4 of 80 (5%) |
| Gift text alone, favourite names masked, at least 0.80 | 19 of 80 (24%) | 4 of 80 (5%) |
| Gift text alone, favourite names masked, at least 0.85 | 19 of 80 (24%) | 4 of 80 (5%) |
| Gift text alone, favourite names masked, at least 0.90 | 17 of 80 (21%) | 4 of 80 (5%) |

### The same entity given to two or more people (type plus normalised name)

Defined before run 2, after seeing run 1.

| Count | Run 1 | Run 2 |
| --- | --- | --- |
| First 4 ideas (the scored gifts): different entities | 8 | 2 |
| First 4 ideas: gifts they cover | 17 of 80 (21%) | 4 of 80 (5%) |
| First 4 ideas: by kind | brand 4, book 2, destination 1, place 1 | book 1, brand 1 |
| First 4 ideas: most people sharing one entity | 3 | 2 |
| All ideas: different entities | 10 | 3 |
| All ideas: ideas of different people they cover | 21 | 7 |
| All ideas: by kind | brand 5, book 2, destination 2, place 1 | book 2, brand 1 |
| People who got at least one such gift among the first 4 ideas (post hoc) | 12 of 20 | 4 of 20 |

### Ideas per person and how the ideas were made (n = 20 people)

| Count | Run 1 | Run 2 |
| --- | --- | --- |
| Ideas per person: min / median / mean / max | 4 / 5 / 5.2 / 6 | 4 / 6 / 5.5 / 6 |
| People with fewer than 4 ideas | 0 | 0 |
| People by number of ideas | 5 ideas 14, 6 ideas 5, 4 ideas 1 | 6 ideas 12, 5 ideas 6, 4 ideas 2 |
| Tier (tools = the model's own loop made at least 4 ideas; pipeline = the built-in pipeline topped the run up) | tools 11, pipeline 9 | tools 18, pipeline 2 |
| Why a run was pipeline | the loop stopped early (3 mistakes, or an error) 9 | the loop stopped early (3 mistakes, or an error) 1, the model said DONE with fewer than 4 ideas of its own 1 |
| Model turns per run (number of runs) | 4-turn 11, 3-turn 8, 1-turn 1 | 5-turn 13, 4-turn 4, 6-turn 2, 3-turn 1 |
| Runs with an error | 0 | 0 |

Runs finished by the built-in pipeline instead of the model's own loop: 9 of 20 before, 2 of 20 after.

### Cost and context (n = 20 people, one run each)

| Count | Run 1 | Run 2 |
| --- | --- | --- |
| Workers AI neurons, all 20 runs | 1241 | 1760 |
| Neurons per person | 62 | 88 (+42%) |
| Model calls | 98 | 118 |
| Qloo calls | 157 | 159 |
| Median time per person (from the per-person time the run script records; not a measure written down in advance) | 8.5 s | 9.8 s |
| Slowest person (same source) | 11.5 s | 17.8 s |
| Reasons kept, of the model-written reasons | 96 of 104 | 106 of 110 |
| Ideas whose shop step was paused (cap 0) | 104 | 110 |
| Runs that were told a service was limited | 20 | 20 |

The neuron count is the server's own and does not include the embedding of the 80 gifts (4,680 tokens).

### Reading run 2

1. On these 20 people the repeats went down a lot, and the gift-text check says the same (17 of 80 to 4 of 80 at every cut-off). The frozen M2 had little to show in run 1 (4 of 80 at 0.80, then 0 of 80 at 0.85 and 0.90) and now shows nothing. M1 and M3 did not move. The 4 remaining shared gifts are 2 entities (a book and a brand), each given to 2 people.
2. The cut-off is not the whole story. 11 of run 1's 17 repeated gifts were at or above the cut-off, so the cut-off alone could remove about 11; the drop is 13 gifts. The change has five parts, one run cannot separate them, and the model chose again from scratch (a fresh sample).
3. Post hoc: of run 1's 5 repeated entities at or above the cut-off, none is shared by two people now; 3 of the 5 still show up, for one person each. Of the 3 repeated entities below the cut-off, 1 is still shared. Of the 2 shared entities now, 1 was shared in run 1 too and 1 was not an idea of anyone in run 1 (its popularity was not checked).
4. The tools tier went up from 11 to 18 of 20 runs, the opposite of the "expect fewer" warning in the written design, which came from 3 pilot runs. All 9 of run 1's fallbacks were "the loop stopped early". In run 2, 1 run stopped early after 3 of its 5 Qloo searches found no match (it found 2 of its 3 favourites; "no match" is an error the model should get, so each one is a strike, and three end the tier), and 1 run said DONE after 2 own ideas (7 of the tool calls it asked for were refused or rejected before reaching any service; the reasons were not recorded).
5. Mechanism check (post hoc): from the recorded model steps, at least 115 tool calls that the model asked for were refused or rejected before reaching any service (19 of 20 runs had 3 or more). Run 1's recorded steps show 7 in all, and none in a run with 3, but that count leaves out each run's last model step, which is where run 1's 9 early stops happened, so it is a floor. Under the old counting three such refusals ended the model-driven tier, which fits the cause we found (refusals counted as strikes). The reasons of these refusals were not recorded, so we cannot say how many were "too alike", duplicates or "enough ideas".
6. Noise: the code before the change gave the tools tier in 11 of 12 pilot runs on two other people, but in 11 of 20 in run 1, so tier counts vary between samples. A shift of 7 of 20 is more than "a few", but it is one run against one run: read it as supported by point 5, not as a measured size.
7. Trips (post hoc; place and destination count as one kind; the idea mix and distinct-entity counts here are post hoc too): people with two or more place or destination ideas went from 11 of 20 to 1 of 20; such ideas from 30 of 104 to 20 of 110. The one exception is the "2-seed" run (only 2 of that person's favourites resolved) that went to the pipeline (the rule is soft when nothing else fits; its pool was not inspected). The mix of idea kinds is now brand 34, book 32, artist 24, place 15, destination 5 (before: book 28, brand 27, destination 20, artist 19, place 10). Different entities among all ideas: 93 of 104 before, 106 of 110 after.

### What got worse or cost more, reported unchanged

- Workers AI neurons +42% (1241 to 1760 for 20 people; 62 to 88 a person), and 118 model calls instead of 98.
- 5 or 6 model turns in 15 of 20 runs (run 1: at most 4). The extra turns and calls fit the longer tool loop that refusals no longer cut short; this was not measured separately.
- Slower per person: median 8.5 s to 9.8 s, slowest 11.5 s to 17.8 s.
- 2 more Qloo calls (157 to 159).
- 2 people with exactly 4 ideas (run 1: 1).

## Builds measured and the deployed build

The two measured builds are commit 75bb9a0 (run 1) and engine commit 0aaa605 (run 2, merged into main as 853a5f8). The main branch of this repository contains other commits that are in neither measured build and were not re-measured. Two change the idea step:

- evidence on each card, reasons written from the tags Qloo gives both the favourite and the idea, and artist ideas titled "Music by ..." (1fbd4b3);
- fallback picks that prefer a favourite that has no idea yet (1361659); the fallback was used for 2 of the 20 people in run 2.

Others add interface features: the "Same AI, without Qloo" compare panel (416df6d, 1525d24, 50c5771), the evidence display (c953047), the "Run a live example" button (c596246), and the ask link, taste link and copy note (af4071b, 5cd90c1, 471cbf9).

Which commit is deployed at the demo address, and whether it matches a measured build, is NOT VERIFIED (see below).

## What is not published

The raw lists of gift ideas, the reasons and the entity names are kept out of this repository. Tasteloom's lists contain Qloo-derived names, and Qloo's developer guide asks developers not to store Qloo response data in a public repository, so we publish the method and the counts, not the lists. The 20 made-up people's favourites are not listed either. The run notes and the raw outputs are not published.

## NOT VERIFIED

Run 1:

- Account-level Workers AI neurons: only the usage the models reported was summed; the dashboard figure was not read.
- Whether Qloo resolved each typed favourite to the intended entity: only the count of resolved favourites is known (57 of 60).
- M1 undercounts works of a favourite and can match a common-word name inside an unrelated gift; M1 for Tasteloom is low partly by design.
- The similarity cut-offs are not strictly comparable between Tasteloom's short entity names and the models' longer descriptions; the frozen M2 text includes reason words (see the chart note), and the two checks are reported beside it.
- Run-to-run variance: 20 made-up people, one run per condition, no repeats.
- That the measured Tasteloom (local server, own config copy, live Qloo and no cache, shop and web search paused) is equivalent to the deployed product: this measures its choice of ideas, not what it can put on a shelf.
- Whether the models' gifts exist or fit the budget.
- Whether the 20 made-up people are representative of real users.

Run 2:

- Other people and other days: this is one run on the 20 people the fix was designed on.
- Which part of the change did what: one commit, no ablation run.
- Production with real shop tools: the shop and web steps were capped at 0, so the strike source "a shop search with too few matches" was not exercised.
- Why each of the 115 refused calls was refused; the code before the change was not re-run on these people with the same model answers; the tool answers of run 1's own early stops were not recorded (the cause was found by replay).
- The popularity of the one shared entity that was not in run 1, and why the run with 2 resolved favourites kept 2 trips.
- What Workers AI does past 10,000 neurons a day (a hard stop or billing).
- The live end-to-end test phase for the changed engine (billed) was not run. Its tour phase ran: 700 pass, 6 fail, the same 6 as on main.

Builds:

- Which commit is deployed at the demo address, and whether it matches a measured build.
