// ─────────────────────────────────────────────────────────────────────────────
// THE CORPUS — 5 runs × 5 catalog meals, written out as literal ids.
//
// WHY LITERALS AND NOT A QUERY. A harness that picks its own meals each time
// measures a different thing each time, and a rule that regressed would be
// indistinguishable from a corpus that moved. These ids are frozen; a later
// block that wants more coverage ADDS a run rather than reshuffling these.
// (The grocery census learned this the hard way — see its README on the 21st
// plan: "a corpus that cannot see a fix is evidence of no collateral, not
// evidence of no effect".)
//
// HOW THEY WERE CHOSEN. Run 1 is the flow the prompt names: it must contain a
// two-dish meal and a meal needing limes and eggs, so the R3 recurring forms
// appear against the test account's own recurring list
// (Milk · Eggs · Lemons · Limes · Bananas · Paper towels · Pet treats · Coffee).
// Tofu Pad Thai satisfies both at once, and a second lime+egg meal backs it up.
// Runs 2–5 are a deterministic stride over the id-sorted public catalog with
// one meal per cuisine, ≥ 8 ingredients each, and a guarantee of at least one
// multi-dish meal and at least one recurring-overlap meal per run. Variety with
// a seed, not randomness.
//
// ⚠️ These are PUBLIC catalog meals. /plans/from-meals forks each one into the
// test account (D-WS7-139 fork-on-acquire), so a run leaves forked Meal rows
// behind as well as a plan. See README.md § Residue.
// ─────────────────────────────────────────────────────────────────────────────

export interface CorpusRun {
  run: number;
  /** Why this set exists — printed into results.json so a reader need not dig. */
  note: string;
  mealIds: string[];
}

export const CORPUS: CorpusRun[] = [
  {
    run: 1,
    note:
      "the named flow: a two-dish meal AND a lime+egg meal (Pad Thai is both), " +
      "a second lime+egg meal, a lime meal, an egg+lemon meal, and a plain stew",
    mealIds: [
      // 2 dishes, 29 ingredients, lime, egg — Tofu Pad Thai with Fresh Spring Rolls
      "3424eefa-423c-4be1-a987-8a55c8811576",
      // 3 dishes, 29 ingredients, lime, egg — Beef Empanadas with Avocado Crema and Pickled Jalapeño Slaw
      "80ecaf30-f1de-4e37-8cf2-a5f9e5a0de8d",
      // 3 dishes, 27 ingredients, lime — Al Pastor Tacos with Refried Beans and Radish Slaw
      "00e3a8ec-d909-466b-9c20-8f3cf5f7e544",
      // 2 dishes, 14 ingredients, egg, lemon — Classic Spaghetti Carbonara
      "085c6353-756e-43e3-a99f-4058c5a6ef9b",
      // 1 dish, 18 ingredients — Classic Beef Stew with Potatoes and Carrots
      "0314d364-b8af-46c9-8f34-a73e21630470",
    ],
  },
  {
    run: 2,
    note: "stride 211 — Mediterranean / Cajun / Argentine / Japanese / Italian-American",
    mealIds: [
      // 3 dishes, 22 ingredients, lemon — Mediterranean Chicken Skewers with Lemon-Herb Marinade and Tzatziki
      "26e64c90-3c7b-492c-b50d-0747f5bccb9c",
      // 2 dishes, 19 ingredients, lime, lemon — Cajun Grilled Salmon with Corn and Tomato Salad
      "4b7a54f6-eb31-43b7-a85c-5e763cc1e40c",
      // 3 dishes, 14 ingredients — Grilled Skirt Steak with Chimichurri and Roasted Potatoes
      "75284c02-7610-4b5f-b476-9f1b447d4caf",
      // 1 dish, 23 ingredients, milk — Tonkotsu-Style Pork Ramen
      "a154567b-eb6b-4a4a-9880-f551e76efdc5",
      // 3 dishes, 18 ingredients, lemon — Chicken Marsala with Roasted Asparagus and Crusty Bread
      "c7d9c97c-5960-4ed9-8ba1-bdad871f0d54",
    ],
  },
  {
    run: 3,
    note: "stride 373 — Thai / American / Italian-American / American BBQ / Greek",
    mealIds: [
      // 1 dish, 16 ingredients — Beef Pad See Ew with Chinese Broccoli
      "40b342c0-65bb-44ec-9749-dd8bb681724a",
      // 3 dishes, 17 ingredients, lemon — Garlic-Herb Marinated Grilled Flank Steak with Roasted Potatoes and Grilled Asparagus
      "8b24ebc5-0644-42eb-b61d-68df84cdc5a0",
      // 1 dish, 17 ingredients, milk — Grilled Chicken and Broccoli Alfredo
      "d4c421b3-9092-43d5-98f4-65727148f349",
      // 3 dishes, 23 ingredients — Pulled Pork Sliders with Vinegar Slaw and Baked Beans
      "aeb89b37-6803-4370-9354-ca72c1804574",
      // 3 dishes, 22 ingredients — Lamb Gyro Plate with Greek Salad and Warm Pita
      "f8fceba0-02b3-42c6-8c50-7105ad221fdd",
    ],
  },
  {
    run: 4,
    note: "stride 557 — Thai / Chinese-American / Indian / Tex-Mex / American",
    mealIds: [
      // 1 dish, 17 ingredients, lime — Beef Drunken Noodles
      "662c99a9-77ce-4808-9660-381fd998f4bb",
      // 2 dishes, 17 ingredients, egg, lemon, milk — Honey Walnut Shrimp with Steamed Jasmine Rice
      "d48ac1f7-9728-4333-9b55-9c582ab752fb",
      // 3 dishes, 24 ingredients — North Indian Chicken Curry with Basmati Rice and Cucumber Raita
      "3c16e148-2500-4a48-9659-8b7cff0983c4",
      // 2 dishes, 22 ingredients, lime — Black Bean and Cheese Enchilada Casserole
      "ad59bc43-4a85-4fc1-803b-b39515f0de8d",
      // 1 dish, 15 ingredients — Classic Cream of Mushroom Cheesy Chicken and Rice Casserole
      "189092fc-2ea8-4410-984f-2c985b08c478",
    ],
  },
  {
    run: 5,
    note: "stride 733 — Chinese-American / Italian-American / American / Chinese / Cajun",
    mealIds: [
      // 3 dishes, 20 ingredients — Baked Sweet and Sour Chicken with Steamed Broccoli and Carrots
      "88bea97f-ab9a-4176-b364-679fa9f2faa9",
      // 3 dishes, 26 ingredients, lemon, milk — Baked Ziti with Garlic Bread and Caesar Salad
      "19b23bd6-9c2d-4c87-8675-d1da8feb056d",
      // 1 dish, 14 ingredients, milk — Detroit-Style Pizza
      "a81aded6-2387-4d1a-8c75-533a4b23e2b7",
      // 3 dishes, 15 ingredients — Mapo Tofu with Steamed Rice and Bok Choy
      "3239d946-d76a-4297-a3c8-0ac68d46ed0a",
      // 2 dishes, 21 ingredients — Crawfish Étouffée over Steamed White Rice
      "c02088d5-f6fe-487a-a2e0-0ac71846e946",
    ],
  },
];

/** `--runs 1` / `--runs 1,3` via KIWI_E2E_RUNS; default all five. */
export function selectedRuns(): CorpusRun[] {
  const raw = process.env.KIWI_E2E_RUNS;
  if (!raw) return CORPUS;
  const want = new Set(
    raw
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n)),
  );
  const picked = CORPUS.filter((c) => want.has(c.run));
  if (picked.length === 0) throw new Error(`KIWI_E2E_RUNS=${raw} selected no run`);
  return picked;
}
