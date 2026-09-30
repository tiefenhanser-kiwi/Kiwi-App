// ─────────────────────────────────────────────────────────────────────────────
// THE FLOW — sign in → build a plan → grocery list → Cook Mode → Prep the Week,
// once per corpus run, with a screenshot and a rule verdict at every screen.
//
// ONE test() per corpus run, in order, in a single worker: every flow mutates
// the same dev account (a new plan, a new grocery list, the this-week winner),
// so parallel flows would race on that one user's state and the failures would
// be the harness's rather than the app's.
//
// A flow never throws on a RULE FAILURE — a failed rule is the output, not a
// crash. It throws only when the app did not get far enough to be measured
// (no plan, no list, a screen that never rendered), because a rule scored
// against a blank page is worse than no rule at all.
// ─────────────────────────────────────────────────────────────────────────────
import { expect, test } from "@playwright/test";

import { Api } from "../src/api";
import { CORPUS, selectedRuns } from "../src/corpus";
import { buildGroceryCorpus, runGroceryChecker, runPrepCookChecker } from "../src/censusBridge";
import { RUN_ID, ensureRunDir } from "../src/env";
import { buildPlanRecord } from "../src/prepCookCorpus";
import {
  bR1_everyRowRendered,
  bR2_recurringFormsRender,
  bR3_glyphsAndEach,
  screenReached,
  type RuleResult,
} from "../src/renderRules";
import {
  type FlowResult,
  snapshotApiLog,
  totalsOf,
  writeResults,
} from "../src/results";
import {
  allShots,
  capture,
  gotoCookMode,
  gotoGroceryList,
  gotoPrepWeek,
  signInThroughUi,
} from "../src/screen";
import { measured, type SurfaceSpend } from "../src/spend";
import { preflight, teardown, type Preflight } from "../src/stack";

const flows: FlowResult[] = [];
let pf: Preflight | null = null;
let preflightNotes: { name: string; ok: boolean; note: string }[] = [];
const suiteStart = Date.now();
const suiteStartIso = new Date().toISOString();

test.beforeAll(async () => {
  ensureRunDir();
  pf = await preflight();
  preflightNotes = pf.checks;
  for (const c of pf.checks) console.log(`[preflight] ${c.ok ? "PASS" : "FAIL"}  ${c.name} — ${c.note}`);
  // A failed preflight stops the suite. Running anyway would produce a table of
  // rule failures that are really one missing server.
  expect(pf.ok, `preflight failed:\n${pf.checks.filter((c) => !c.ok).map((c) => `  · ${c.name}: ${c.note}`).join("\n")}`).toBe(true);
});

test.afterAll(async () => {
  const file = {
    runId: RUN_ID,
    startedAt: suiteStartIso,
    finishedAt: new Date().toISOString(),
    wallMs: Date.now() - suiteStart,
    preflight: preflightNotes,
    flows,
    totals: totalsOf(flows),
    apiCalls: snapshotApiLog(),
  };
  const path = writeResults(file);
  console.log(`\n→ ${path}`);
  console.log(`→ ${allShots().length} screenshot(s) under the same folder`);
  if (pf) teardown(pf);
});

for (const corpus of selectedRuns()) {
  test(`run ${corpus.run} of ${CORPUS.length} — ${corpus.note}`, async ({ page }) => {
    const label = `run-${String(corpus.run).padStart(2, "0")}`;
    const t0 = Date.now();
    const browserRules: RuleResult[] = [];
    const spend: SurfaceSpend[] = [];
    const frictions: string[] = [];
    const gaps: string[] = [];
    const flow: FlowResult = {
      run: corpus.run,
      note: corpus.note,
      mealIds: corpus.mealIds,
      planId: null,
      planName: null,
      listId: null,
      ok: false,
      error: null,
      wallMs: 0,
      screens: [],
      browserRules,
      grocery: null,
      prepCook: null,
      spend,
      frictions,
    };
    flows.push(flow);

    // Surface a page error rather than letting it vanish into the console.
    page.on("pageerror", (e) => frictions.push(`pageerror: ${String(e.message).slice(0, 300)}`));
    page.on("console", (m) => {
      if (m.type() === "error") frictions.push(`console.error: ${m.text().slice(0, 300)}`);
    });

    try {
      const api = new Api();

      // ── 1 — sign in, through the real form ────────────────────────────────
      const { token } = await signInThroughUi(page);
      await capture(page, label, "01-signed-in");
      // The harness's own calls now run as the session the browser holds.
      await api.login();
      expect(token.length, "the browser stored a token").toBeGreaterThan(20);
      const userId = api.userId!;

      // ── 2 — build the plan from the named catalog meals (no AI, no cost) ──
      const built = await api.planFromMeals({
        mealIds: corpus.mealIds,
        planDurationDays: 5,
        localDate: new Date().toISOString().slice(0, 10),
      });
      flow.planId = built.planId;
      const planRead = await api.plan(built.planId);
      flow.planName = planRead.plan.name;
      expect(planRead.plan.items.length, "the plan holds the meals it was built from").toBe(
        corpus.mealIds.length,
      );

      // ── 3 — the grocery list ──────────────────────────────────────────────
      const gen = await measured(userId, "grocery-generate", () =>
        api.generateGroceryList(built.planId),
      );
      spend.push(gen.spend);
      flow.listId = gen.value.listId;
      if (gen.value.recovered) {
        frictions.push(
          "generate-grocery-list was interrupted by a dev-server watch restart; the list was " +
            "recovered by asking which list the plan has rather than re-posting, so the spend " +
            "figure for this run may under-count a partially-charged generation",
        );
      }

      const groceryText = await gotoGroceryList(page, gen.value.listId);
      const { shot: groceryShot } = await capture(page, label, "02-grocery-list");
      flow.screens.push(groceryShot);

      browserRules.push(
        screenReached("grocery-list", groceryText, [
          // Chrome only — never generated content.
          /produce|pantry|dairy|meat|frozen|household|extras/,
        ]),
      );

      // The structured rows the screen just rendered, from the same GET it made.
      const listRead = await api.groceryList(gen.value.listId);
      const items = listRead.list.items;

      browserRules.push(bR1_everyRowRendered(items, groceryText));
      const r2 = await bR2_recurringFormsRender(items, groceryText);
      browserRules.push(r2);
      // The recurring sentences are the ONLY text "each" is scanned in — see
      // the narrowing note in renderRules.ts.
      browserRules.push(bR3_glyphsAndEach(groceryText, r2.sentences));

      // ── the grocery census checker, unmodified ───────────────────────────
      const corpusFile = await buildGroceryCorpus({
        planId: built.planId,
        planTitle: planRead.plan.name ?? "(unnamed)",
        listId: gen.value.listId,
        items,
      });
      gaps.push(...corpusFile.gaps);
      flow.grocery = runGroceryChecker(
        `qa-${RUN_ID}-r${corpus.run}`,
        [
          {
            planId: built.planId,
            planTitle: planRead.plan.name ?? "(unnamed)",
            final: corpusFile.final,
            rendered: corpusFile.rendered,
            consolidated: corpusFile.consolidated,
          },
        ],
        corpusFile.gaps,
      );

      // ── 4 — Cook Mode, for one meal ──────────────────────────────────────
      // The FIRST multi-dish plan item, because a single-dish meal never calls
      // the sequencer (§7.13) and K-R1/2/3 would have no candidates at all.
      let cookItem = planRead.plan.items[0];
      for (const it of planRead.plan.items) {
        const d = (await api.meal(it.mealId, it.id)) as { meal?: { dishes?: unknown[] } };
        const n = (d.meal?.dishes ?? []).length;
        if (n > 1) {
          cookItem = it;
          break;
        }
      }
      const cookText = await gotoCookMode(page, {
        mealId: cookItem.mealId,
        planId: built.planId,
        planItemId: cookItem.id,
      });
      const { shot: cookShot } = await capture(page, label, "03-cook-mode");
      flow.screens.push(cookShot);
      browserRules.push(
        screenReached("cook-mode", cookText, [/step|next|start cooking|min/i]),
      );
      browserRules.push({ ...bR3_glyphsAndEach(cookText), rule: "B-R3/cook" });

      // ── 5 — Prep the Week (this one spends) ──────────────────────────────
      //
      // ⚠️ SOFT-FAILING, ON PURPOSE. The prep-week pipeline is another lane's
      // active build surface, and a 502 from it is that lane's state rather
      // than a finding of this one. Aborting the flow here would throw away the
      // grocery and Cook Mode verdicts that already passed, and Part A needs
      // the per-rule table for all five runs. So the error is RECORDED — into
      // the PlanRecord's own `prepError` field, which exists for exactly this —
      // the screen is still visited and photographed, and the P-rules then
      // score 0-of-0 instead of a fabricated pass.
      let prepResult: unknown = null;
      let prepError: string | null = null;
      const prep = await measured(userId, "prep-week", async () => {
        try {
          return await api.prepWeek(built.planId, {});
        } catch (e) {
          prepError = String((e as Error).message).slice(0, 300);
          return null;
        }
      });
      spend.push(prep.spend);
      if (prep.value) {
        prepResult = prep.value.result;
        if (prep.value.cacheHit) {
          frictions.push(
            "prep-week answered cacheHit — this plan's structure was already stored, so the " +
              "spend figure for this run is $0 and does NOT represent a cold generation",
          );
        }
      } else {
        // WHICH failure it was decides what the spend figure means, so say so
        // rather than asserting one of them. An app-level refusal
        // (assembly_invalid / narration_incomplete) happens AFTER the narration
        // call, so it is charged; a transport reset may have cost nothing.
        const appLevel = /"reason"\s*:/.test(String(prepError));
        frictions.push(
          `prep-week FAILED: ${prepError} — recorded, not fixed. The P-rules below score ` +
            `0-of-0 because there is no prep structure to score. ` +
            (appLevel
              ? "This is the APP refusing (a `reason` in the body): the narration ran before " +
                "the validation that rejected it, so the spend below IS charged work."
              : "This is a TRANSPORT failure (the proxy, not the app): the spend below may be " +
                "$0 because the request never reached the model."),
        );
      }

      const prepText = await gotoPrepWeek(page, built.planId);
      const { shot: prepShot } = await capture(page, label, "04-prep-the-week");
      flow.screens.push(prepShot);
      // When the server refused, the screen is EXPECTED to show an error — so
      // the reached-gate is only asserted on the path where a result exists.
      if (prepResult) {
        browserRules.push(
          screenReached("prep-the-week", prepText, [/prep|chop|store|fridge|min/i]),
        );
      } else {
        browserRules.push({
          rule: "SCREEN:prep-the-week",
          title: "prep-the-week rendered",
          pass: null,
          candidates: 0,
          violations: [],
          note: `not scored — the server refused to build the structure (${prepError})`,
        });
      }
      browserRules.push({ ...bR3_glyphsAndEach(prepText), rule: "B-R3/prep" });

      // ── the prep-cook census checker, unmodified ─────────────────────────
      const planRecord = await buildPlanRecord(
        api,
        { planId: built.planId, prepResult, prepError },
        gaps,
      );
      flow.prepCook = runPrepCookChecker(`qa-${RUN_ID}-r${corpus.run}`, [planRecord], gaps);

      flow.ok = true;
    } catch (err) {
      flow.error = String((err as Error)?.stack ?? err).slice(0, 4000);
      // Capture whatever the screen was showing when it broke — the most
      // useful artefact a failed flow can leave behind.
      try {
        await capture(page, label, "99-at-failure");
      } catch {
        /* the page may already be gone */
      }
      throw err;
    } finally {
      flow.wallMs = Date.now() - t0;
      flow.frictions = [...new Set([...frictions, ...gaps])];
    }
  });
}
