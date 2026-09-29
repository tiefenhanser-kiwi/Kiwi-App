// [grocery] B3 · Part B — THE REVIEWED SHEET. Data only; `apply.ts` writes it.
//
// Every figure here is human-ruled (D-WS9-284, September 29 2026) and lands with
// `reviewedByHuman: true`, which is the OVERWRITE GUARD on both tables: a later
// AI pass skips a row a human signed.
//
// The three CODE-table entries D-WS9-284 ruling 3 also adds (paper towels,
// toilet paper, pet treats, coffee, and milk's gallon) are NOT here — they are in
// `src/lib/ingredientConversions.ts`, because that table is code, not per-user
// data, and ruling 1 chose option (c): nothing is persisted per user.

export interface PackFix {
  canonical: string;
  purchaseUnit: string;
  purchaseQuantity: number;
  purchaseDisplay: string;
  why: string;
}

export interface YieldFix {
  canonical: string;
  unit: string;
  perPack: number;
  source: string;
  why: string;
}

export interface EdgePromotion {
  from: string;
  to: string;
  label: "subsumes";
  why: string;
}

// ── D-WS9-284 ruling 6 — the sandwich-bread pack, hand-seeded ───────────────
//
// `sandwich bread` is the row the alias `bread` resolves to. It carries NO pack
// (all three columns null) and ZERO DishIngredient rows, so it is a permanent
// gap-fill miss — and the moment a recurring row carries its ingredientId, the
// write-back that used to be skipped fires and a model's answer is persisted to
// the SHARED catalog. Ruling 6: no model-authored write reaches the catalog from
// a recurring resolution. So the figure is set by hand, here, first.
export const PACK_FIXES: PackFix[] = [
  {
    canonical: "sandwich bread",
    purchaseUnit: "loaf",
    purchaseQuantity: 1,
    purchaseDisplay: "1 loaf (20 oz, 22 slices)",
    why:
      "The standard US supermarket sandwich loaf is 20 oz / 22 slices — the size " +
      "Nature's Own, Sara Lee and Wonder all sell as their default white and " +
      "wheat sandwich loaf. 24 oz 'giant' and 16 oz 'small' loaves both exist; " +
      "20 oz is the shelf default and the one a shopper reaches for unprompted.",
  },
];

// ── D-WS9-284 ruling 7 — romaine, the pack yield rather than the unit ───────
//
// `romaine lettuce` (head, pack 1 head, yield 6 cup, human-reviewed) and
// `romaine lettuce hearts` (each, pack 2 each) ALREADY share a group key — a
// human-reviewed `synonym` edge joins them — so the merge is reached and refuses
// on head vs each. Two repairs were available and the unit is the wrong one: 87
// DishIngredient rows say `each`, and rewriting what 87 recipes wrote to fix a
// pack arithmetic problem is the tail wagging the dog. The yield converts
// instead, and lands on the head row's own 6 cups by construction.
export const YIELD_FIXES: YieldFix[] = [
  {
    canonical: "romaine lettuce hearts",
    unit: "cup",
    perPack: 6,
    source: "D-WS9-284",
    why:
      "The pack is 2 hearts. A romaine heart yields ~3 cups chopped, so a pack " +
      "yields 6 — the same 6 cups the `romaine lettuce` head row already carries " +
      "as a human-reviewed yield. The two agree on purpose: they are one food.",
  },
  // ── AMENDMENT, AND IT IS A STEP THE RULINGS DID NOT NAME ──────────────────
  //
  // Ruling 8 says the promoted broth edges make "a plain broth demand may carry
  // 'at least 1 low-sodium'" reachable, on the grounds that "cans are counts".
  // MEASURED ON THE CORPUS, THAT PREMISE DOES NOT HOLD, and the first Part E run
  // is the evidence: the fold lands (96a94410's chicken broth went 4½ → 6 cup,
  // d47d18aa's beef broth 1½ → 7) and the rider does NOT appear on either line.
  //
  // The pack is a can; the SHARE is 1.5 cup and 5.5 cup. `buyUnitsForNeed` has to
  // state the share in the buy unit, nothing relates `cup` to `can` for broth, so
  // it returns null and `applyVarietyRider` states no rider at all. Shipping the
  // promotion without this would REMOVE the word "low-sodium" from a list that
  // used to carry it on its own line — a regression, dressed as a fold.
  //
  // The same missing conversion is also a live under-buy that predates this
  // block entirely: a plan needing 8 cups of broth ordered ONE 14.5 oz can,
  // because the pack count could not be derived either. 19 broth rows across the
  // 20 lists are in that state, and Gate 1 cannot see any of them — they are the
  // largest single class in ruling 11's "unit family with no conversion" residue.
  //
  // The figure is arithmetic, not judgement: 14.5 fl oz ÷ 8 = 1.8125 cups.
  // Revert = delete these four entries.
  ...(["chicken broth", "low-sodium chicken broth", "beef broth", "low-sodium beef broth"].map(
    (canonical): YieldFix => ({
      canonical,
      unit: "cup",
      perPack: 1.8125,
      source: "D-WS9-284 (ruling 8 amendment)",
      why:
        "The pack is 1 can (14.5 fl oz) and every recipe need is in cups. " +
        "14.5 ÷ 8 = 1.8125 cups per can. Without it the H3 rider ruling 8 asked " +
        "for cannot be stated, and the pack count for a cup-denominated need " +
        "falls back to one whole can however many cups the recipes want.",
    }),
  )),
];

// ── D-WS9-284 ruling 8 — the broth promotions ──────────────────────────────
//
// All four edges classify H3 under B2's rules ("low-sodium" is a store product
// the generic can stand in for) and all four sit at `confidence: medium,
// reviewedByHuman: false`, which is exactly why the reader — which admits only
// `reviewedByHuman || confidence === "high"` — does not fold them. Promoting
// them IS the change; no label, no confidence and no direction moves.
//
// `X broth, low-sodium` is a high-confidence synonym of `low-sodium X broth`, so
// the group key collapses the pair and the four edges are two effective folds.
// Weight/volume packs never carry H3 shares, but these are CANS — counts — so a
// plain-broth demand may legitimately carry "at least 1 low-sodium".
export const EDGE_PROMOTIONS: EdgePromotion[] = [
  { from: "chicken broth", to: "low-sodium chicken broth", label: "subsumes", why: "H3; cans are counts" },
  { from: "chicken broth", to: "chicken broth, low-sodium", label: "subsumes", why: "H3; the synonym spelling of the same specific" },
  { from: "beef broth", to: "low-sodium beef broth", label: "subsumes", why: "H3; cans are counts" },
  { from: "beef broth", to: "beef broth, low-sodium", label: "subsumes", why: "H3; the synonym spelling of the same specific" },
];
