
### Part J.0 D3 — wizard.set_preferences.generate adherence, 4.6 vs 5.5 (thinking off)

10 runs per model per set, inputs built once per set and replayed through `streamPlanCandidates`
with an explicit `model` (rows: `out/p8-adherence.jsonl`). Spend $1.205.

Set facts: family4picky — N playlist 2, 3 playlist rows on a 43-row shelf, the user's stored 45-min cap.
gf30 — N playlist 2, but the gluten-free + 30-min shelf has ONE row (itself a playlist row), so the
reachable target is 1; "exactly N" cannot be met as written.

| rule | family4picky 4.6 | family4picky 5.5 | gf30 4.6 | gf30 5.5 |
|---|---|---|---|---|
| runs ok | 10/10 | 10/10 | 10/10 | 10/10 |
| candidate count = 3 | 10/10 | 10/10 | 10/10 | 10/10 |
| playlist exact per candidate | 12/30 | 8/30 | 26/30 | 10/30 |
| — candidate 1 / 2 / 3 | 5 · 3 · 4 | 8 · 0 · 0 | 9 · 8 · 9 | 8 · 1 · 1 |
| over target (a playlist meal used twice) | 0 | 2 | 3 | 0 |
| non-playlist store slot over the cap | 0/30 | 0/30 | 0/30 | 0/30 |
| store / live slots of 150 | 133 / 17 | 93 / 57 | 32 / 118 | 10 / 140 |

5.5 is clearly worse on the playlist rule, and the miss has one shape: it places the playlist meals in
candidate 1 and drops them from candidates 2 and 3 — distinctness across candidates wins over the count.
The cap cannot be checked on LIVE slots (no time until expand, BUG-245); 5.5 fills more slots live.

Proposed wording for both models (not bumped this part), replacing the first sentence of the Playlist
paragraph in WIZARD_SET_PREFERENCES_GENERATE_BODY:

> Playlist — `preferencesContext.playlistMealsPerWeek` (N, 0 or more): when N is above 0, EVERY candidate
> plan carries exactly min(N, number of `"isPlaylist": true` entries) playlist meals — plan 1, plan 2 and
> plan 3 each. The same playlist meal may appear in more than one plan; that is expected and is not the
> repetition the distinctness rule forbids. Never place one playlist meal twice in the same plan. Before
> you finish, count the `isPlaylist` entries in each candidate's `storeSlots`.
