# QA-NIGHT-1: the overnight run

Simulated households use Kiwi through the real API (and one through the real
web app). Every grocery list, prep session and Cook Mode they produce is
reconciled against the recipes. The morning summary lists what does not
reconcile. **Dev only.**

```bash
# from artifacts/kiwi
pnpm run qa:night                                  # all ten households + the browser pass
KIWI_QA_HOUSEHOLDS=1,6,10 pnpm run qa:night        # some of them
KIWI_QA_BUDGET_USD=8 KIWI_QA_UI=0 pnpm run qa:night
```

Output goes to `artifacts/kiwi/e2e/out/night-<date>/` (gitignored):

| file | contents |
|---|---|
| `summary.md` | The paste-into-chat summary. |
| `findings.json` | Every finding, plus the run facts. |
| `household-N.json` | Each household's paths, ticks and evidence. |
| `calls.json` | Every HTTP call, with its status and time. |
| `server.log` | The api-server child's own log. |
| `ui.log`, `ui-result.json` | The browser pass. |

The exit code is 1 when a **new** high-severity finding exists, and 2 when the
run could not start.

## The fences

1. **The dev database.** `assertDevDatabase()` runs first. It requires the
   ep-broad-haze host and refuses the production override.
2. **Its own server.** The run starts `src/index.ts` on **:3100** with
   `node --import tsx`, not a watcher. It never touches Hans's `:3000`.
   - The child gets `.env` parsed and passed explicitly, with no `--env-file`.
     The overrides are `RESEND_API_KEY=""`, `SIGNUP_ALERT_TO=""`,
     `LIFECYCLE_EMAIL_ENABLED=false`, plus `FEEDBACK_TO=""` and
     `TURNSTILE_SECRET_KEY=""`.
   - There is no request until two lines in the child's own output prove those
     values. The first comes from `bootProof.ts`, a preload that reads the
     switches through `lifecycle/run.ts`'s own reader. The second is the
     server's own `lifecycle email: off`.
   - The run kills the child at the end.
3. **A cost cap.** `KIWI_QA_BUDGET_USD` defaults to 15.
   - Spend is read from `LLMCallLog` by the run's own user ids and guest
     session ids, and before each account is deleted (`DELETE /me` nulls
     `userId`).
   - A household starts only when spent + max(its `estimateUsd`, the largest
     household spend so far) ≤ the cap.
4. **Every account goes.** Each household ends with `DELETE /me`, then proves
   the account is gone: `GET /auth/me` with the old token returns 401, and the
   row is gone. A final sweep reports any `qa-night-<runTag>-…@example.com`
   account still present.

## The households (`households.json`)

There are ten of them, fixed. Between them, every path runs every night:
- sign-up, how-heard and onboarding;
- the plan, then the grocery list, with a third of it checked off;
- edits (swap, servings 10, a saved dish through Edit meal, the bird weight);
- Cook Mode unprepped;
- Prep the Week full and partial (half ticked, leave and return, a few more);
- Prep selected meals (2 of N) and one meal;
- Recipes → "Yes, I prepped";
- the feast (the Hub's make-ahead schedule, Prep the feast, Cook Mode for the day);
- a finished cook;
- account deletion.

> **Feast meals on dev are a fixture.** Dev has no public Thanksgiving
> template or meal: the THX meals are private prod-copies. So households 6 and
> 7 fork the meal for the new account with `forkMealForUser` (QA-7's fixture).
> Everything after the fork goes through the routes: `from-meals`, the date
> edit to Nov 23–29, the feast's day and the weight.

## The reconcilers

The reconcilers are pure, in `reconcileGrocery.ts` and `reconcilePrepCook.ts`.
They are tested on hand-made fixtures:
`node --import tsx --test scripts/qa-night/reconcile.test.ts` (from
`artifacts/api-server`).

| ID | What it checks | What the wire limits |
|---|---|---|
| R1 | Every recipe line, scaled by the server's rule, is on the list in at least the summed need. | Amounts are compared only when units convert. The bird's dish is checked for presence only; the bird itself against the chosen weight. |
| R2 | Every row traces to a plan meal. Staples, recurring rows and user-added rows are labeled. | An optional line that is bought anyway is its own (low) finding. |
| R3 | R1 and R2 hold again after each edit. The removed meal's rows are gone, and the edited meal's rows moved. | — |
| R4 | Prep amounts (read from the narrated prose) stay within the scaled recipes and within the list. Keys are unique. Covers point at the step's own meals. | A prep step has no structured amounts, so a step's total line or its destination lines are read. |
| R5 | A subset or one-meal session touches only its meals. Other meals' Cook Mode is read before the request, after it, and after the ticks. | — |
| R6 | `labelCount` = the card's N = the distinct containers filled. Every chip names a container the session made. | — |
| R7 | A ticked step no longer tells the cook to do it (chip, dropped clause, or the client's "Done in prep" fold). Partial prep mutes nothing unticked. "Yes, I prepped" words the covered steps. | Most week steps carry no `coversCookSteps`; the chip and the dropped clause are read-time. |
| R8 | Every ingredient is named in a step. A dish's non-prep steps keep their order. No oven runs at two temperatures at once. The card is within 10% of the sequence. | — |
| R9 | Every make-ahead row is before the feast and on its date and weekday, inside its keep window. The thaw is ⌈lb ÷ 4⌉ days before the brine (or the feast). Prep the feast is the day before. | — |
| R10 | One `plan_prep_started` per ticked plan; one `cook_finished` per finish. | — |
| R11 | No 5xx, no unexpected 4xx, nothing slower than 20 s, no console errors in the browser pass. | — |

Findings carry a stable signature (rule, kind, food or step kind, never an id).
`known.json` maps signatures to open bug ids. The summary lists those apart
from the new ones.

## The cook simulation (`--cook-sim`, QA-COOK-1)

`pnpm run qa:night --cook-sim` (or `KIWI_QA_COOK_SIM=1`) adds `cookSim.ts`:
- **The simulator** runs on every household's Cook Mode sessions: right after
  "Cook Mode unprepped", and again after the household's prep paths. It reads
  through the household's own account and is free.
- **The AI home cooks** take 5 meals a night, rotating by date, with all three
  cooks on each meal. Their spend counts against `KIWI_QA_BUDGET_USD`.
- **The results** get their own section of `summary.md`, plus `cook-sim.json`.
  They never change the exit code.

See `scripts/qa-cook/README.md`. `KIWI_QA_PORT=<n> KIWI_QA_UI=0` starts the
child on another port, for a second run beside one on :3100. That mode is API
only.
