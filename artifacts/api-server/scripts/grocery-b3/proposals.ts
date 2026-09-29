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
