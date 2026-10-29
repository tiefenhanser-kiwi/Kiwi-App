# QA-COOK-1: simulated home cooks

Simulated home cooks follow Cook Mode one step at a time, exactly as the app
shows it, and report where a real cook would struggle. **Dev only.**

It was built for the fajita tortillas (Oct 28, production). Cook Mode warms the
tortillas first, then has the cook cut a lime and heat the oil, and only four
steps later wraps the tortillas in a towel. Each step reads fine, but the flow
doesn't.

```bash
# from artifacts/api-server
node --import tsx scripts/qa-cook/run.ts                    # capture + simulator + AI cooks + patterns
node --import tsx scripts/qa-cook/run.ts --capture-only     # just the Cook Mode sessions
node --import tsx scripts/qa-cook/run.ts --from <dir>       # re-analyse <dir>/views.json (no server, no account)
node --import tsx scripts/qa-cook/run.ts --from <dir> --no-personas   # simulator only (free)
node --import tsx --test scripts/qa-cook/sim.test.ts        # the K-flag tests
npx tsc -p scripts/qa-cook/tsconfig.json                    # type-check (kiwi files under server settings are noisy)
```

| env | default | |
|---|---|---|
| `KIWI_COOKSIM_BUDGET_USD` | 10 | Every model call: the server's own (LLMCallLog by the run's account) plus the AI cooks' (priced from each response). |
| `KIWI_COOKSIM_SIZE` / `_SEED` | 30 / 1028 | The sample (`sample.ts`). |
| `KIWI_COOKSIM_SERVINGS` | `2,6` | |
| `KIWI_COOKSIM_MODEL` | `claude-haiku-5-5` | The AI cooks. |
| `KIWI_COOKSIM_COMPARE_MODEL` / `_COMPARE` | `claude-sonnet-5-5` / 5 | The model comparison: same sessions, a stronger model. |
| `KIWI_COOKSIM_OUT` | `artifacts/kiwi/e2e/out/cooksim-<UTC date>` | gitignored |

The output folder holds:
- `views.json`: every session as shown;
- `capture.json`: the sample, spend and failures;
- `sim.json`, `personas.json` and `patterns.json`;
- `summary.md`: the report.

The capture writes every session as it arrives. A run that dies, for example
on a dropped connection, resumes in the same folder: a plan whose meals are
all there is skipped.

## The fences (QA-NIGHT-1's, reused)

- `assertDev` runs first and allows the dev branch only.
- The run starts its own api-server child through `scripts/qa-night/server.ts`
  on **:3110**, not the night run's :3100, so the two never share a server.
  Every mail switch is off, proven from the child's own boot output.
- One account does the whole capture. Its spend is read before it is deleted,
  and the deletion is proven.
- Before and after the capture, the run sweeps any `qa-cook-…@example.com`
  account a dead run left behind. It deletes each one through the routes
  (QA-7's reset-token path) on its own server.

## What it captures (`capture.ts`, `appView.ts`)

The sample is 30 meals from dev, chosen by the seed:
- 6 bread, always including the fajita meal `24c07e6d`;
- 6 one-pan;
- 6 stove plus oven;
- 7 multi-dish;
- the 5 Thanksgiving feasts, forked like QA-NIGHT-1's.

Each meal is captured at 2 and at 6 servings, unprepped and after a full Prep
the Week ("Mark all complete"). A feast is prepped with Prep the feast.

Cook Mode's reads are the real routes:
- `GET /meals/:id?planItemId`;
- `POST …/cooking-sequence` for a multi-dish meal;
- the completions and the week's prep-week payload, which the fold reads.

The step list is built by the app's own functions, imported from
`kiwi/lib/cooking`: `sequenceMealSteps` / `flattenMealSteps`, `onTheDayMeal`,
`buildAmountRefSegments` and `doneInPrepStepKeys`.

## The kitchen simulator (`simulator.ts`, `lexicon.ts`)

The simulator is deterministic. The kitchen has 4 burners, one oven at one
temperature, two skillets, one pair of hands and one cook's attention.

The cook walks the steps in the screen's order on their own clock:
- A step that needs the cook takes the cook. "One at a time" and "in batches"
  grow with the servings.
- A step that is started and left (a simmer, a bake, a marinade) runs in the
  background.
- A step waits for what it needs.

The cook's reading of a step comes from its words (`lexicon.ts`). The
Sequencer's reading comes from two flags (`isUnattended`). The two disagree,
and the disagreement is the point.

| ID | Flag |
|---|---|
| K1 | A component is finished hot and held more than 10 min before serving with nothing keeping it warm, or its keep-warm step comes late. A browning or wilting cold component is flagged after 20 min. |
| K2 | On the Sequencer's own clock, two hands-on tasks run at once with no "while…" cue. |
| K3 | Knife or board work sits between steps of stove work that can't be left. |
| K4 | Burners or skillets are over the kitchen's count, "the same skillet" is still in use, or the oven is needed at two temperatures. |
| K5 | The cook waits 10 to 60 min while a later prep step could have filled the wait. |
| K6 | A step uses another dish before it is made (the Sequencer's `dishUses`), or says "the X you made" when no step makes X. |
| K7 | Something is set aside and never picked up again. |

## The AI home cooks (`personas.ts`)

There are three cooks:
- a nervous beginner (one big skillet, 2 burners, reads literally);
- a confident weeknight cook;
- a parent who gets interrupted (away for 2 minutes at seeded steps).

Each one is shown one step per turn and cannot see ahead. Each reply is
structured JSON: a one-line kitchen state and the issues
`{step, quote, type, what_went_wrong, severity, suggested_rewrite}`.

The conversation is append-only and auto-cached. The model defaults to Haiku
5.5 at low effort, the smallest model that catches the fajita case.

## Patterns (`patterns.ts`, `report.ts`)

Every K-flag and every AI-cook issue maps to one pattern in a fixed taxonomy
(P1–P19). Patterns are ranked by meals affected × worst severity. Each one
shows:
- three example meals with quotes;
- the cause split: sequencer (the Sequencer interleaved dishes there) versus
  recipe text;
- the rule to add.

## In the night run (item E)

`pnpm run qa:night --cook-sim` (or `KIWI_QA_COOK_SIM=1`), from `artifacts/kiwi`:
- **Simulator:** runs on every household's Cook Mode sessions twice, once
  unprepped and once after its prep paths. This is free.
- **AI cooks:** run on 5 meals that rotate by date (all three cooks each). They
  are counted against `KIWI_QA_BUDGET_USD`.
- **Summary:** the findings form their own section of `summary.md` and never
  change the exit code.

`KIWI_QA_PORT=<n> KIWI_QA_UI=0` runs the night beside another one on :3100.
