// [grocery] B2 Part D — guards for H1–H7, the names and the rider.
//
// Every assertion READS A LIVE VALUE and compares it to a literal. Where a
// literal appears on both sides the test is worthless, so each block below names
// which expression would change if the defect shipped — and eleven of them were
// confirmed by breaking the source and watching them go red.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRelationIndex,
  poolComponentNeeds,
  type RelationRow,
  type SubsumesOverlay,
  type PoolableItem,
} from "../ingredientRelations";
import { classifyEdge, distinguishingTokens } from "../subsumesClasses";
import { lowercaseLead, PROPER_NOUN_LEADS } from "../ingredientNameCase";
import {
  appendVarietyRider,
  composeVarietyRider,
  parseVarietyRider,
  splitRiderForRetailer,
} from "../groceryVarietyRider";
import { instacartSearchName } from "../retailers/instacartName";
import { composeInstacartPayload, type InstacartRowInput } from "../retailers/instacartPayload";
import { isNeverOrdered } from "../groceryStaples";

// ── fixtures ────────────────────────────────────────────────────────────────

function sub(
  generic: string,
  specific: string,
  confidence: RelationRow["confidence"] = "high",
  reviewedByHuman = false,
): RelationRow {
  return {
    label: "subsumes",
    fromCanonicalName: generic,
    toCanonicalName: specific,
    yieldQuantity: null,
    yieldUnit: null,
    coHarvestable: null,
    confidence,
    reviewedByHuman,
    fromDefaultUnit: "each",
  };
}

function syn(from: string, to: string): RelationRow {
  return {
    label: "synonym",
    fromCanonicalName: from,
    toCanonicalName: to,
    yieldQuantity: null,
    yieldUnit: null,
    coHarvestable: null,
    confidence: "high",
    reviewedByHuman: false,
    fromDefaultUnit: "each",
  };
}

function comp(
  from: string,
  to: string,
  yieldQuantity: number,
  yieldUnit: string,
  coHarvestable: boolean,
): RelationRow {
  return {
    label: "component",
    fromCanonicalName: from,
    toCanonicalName: to,
    yieldQuantity,
    yieldUnit,
    coHarvestable,
    confidence: "high",
    reviewedByHuman: true,
    fromDefaultUnit: "each",
  };
}

/** An overlay that says "every one of these names is on the list, sold by each". */
function overlay(
  demanded: string[],
  packUnits: Record<string, string> = {},
): SubsumesOverlay {
  return {
    demanded: new Set(demanded),
    packUnitOf: (n) => packUnits[n] ?? "each",
  };
}

// ── 1 — H3: the generic line carries the called-out variety ─────────────────

describe("H3 — a generic line carries its called-out varieties", () => {
  const rows = [sub("bell peppers", "red bell pepper"), sub("bell peppers", "green bell pepper")];

  it("folds the specifics onto the generic when a recipe demanded the generic", () => {
    const idx = buildRelationIndex(rows, {
      subsumes: overlay(["bell peppers", "red bell pepper", "green bell pepper"]),
    });
    // The LIVE value: all three names resolve to one group key, and it is the
    // GENERIC. If the line ever took a specific's name this flips to
    // "green bell pepper" (shortest of the three).
    assert.equal(idx.groupKey("bell peppers"), "bell peppers");
    assert.equal(idx.groupKey("red bell pepper"), "bell peppers");
    assert.equal(idx.groupKey("green bell pepper"), "bell peppers");
  });

  it("names the varieties the line owes, by their distinguishing words only", () => {
    const idx = buildRelationIndex(rows, {
      subsumes: overlay(["bell peppers", "red bell pepper", "green bell pepper"]),
    });
    const owed = idx.varietiesByKey.get("bell peppers") ?? [];
    // "red", not "red bell pepper": the generic is already the subject of the line.
    assert.deepEqual([...owed].sort(), ["green", "red"]);
  });

  it("renders Hans's shape", () => {
    const line = appendVarietyRider("bell peppers", [
      { variety: "red", count: 2 },
      { variety: "yellow", count: 2 },
    ]);
    assert.equal(line, "bell peppers, at least 2 red and at least 2 yellow");
  });

  it("does NOT fold when only the specifics are demanded (H1 stands)", () => {
    // The f5556c19 onion case: yellow + red + white, no plain onion.
    const onions = [
      sub("onion", "red onion"),
      sub("onion", "white onion"),
      sub("onion", "yellow onion"),
    ];
    const idx = buildRelationIndex(onions, {
      subsumes: overlay(["red onion", "white onion", "yellow onion"]),
    });
    assert.equal(idx.groupKey("red onion"), "red onion");
    assert.equal(idx.groupKey("white onion"), "white onion");
    assert.equal(idx.groupKey("yellow onion"), "yellow onion");
    assert.equal(idx.varietiesByKey.size, 0);
    const why = idx.declined.find((d) => d.to === "red onion");
    assert.equal(why?.reason, "h3-generic-not-demanded");
  });

  it("H5 — a weight-sold generic carries no shares at all", () => {
    const idx = buildRelationIndex([sub("shredded cheddar cheese", "shredded sharp cheddar cheese")], {
      subsumes: overlay(
        ["shredded cheddar cheese", "shredded sharp cheddar cheese"],
        { "shredded cheddar cheese": "lb" },
      ),
    });
    assert.equal(idx.groupKey("shredded sharp cheddar cheese"), "shredded sharp cheddar cheese");
    assert.equal(
      idx.declined.find((d) => d.to === "shredded sharp cheddar cheese")?.reason,
      "h5-not-count-sold",
    );
  });
});

// ── 2 — H1: a keep-separate pair stays two lines ────────────────────────────

describe("H1 — a different product is two lines", () => {
  it("classifies the families Hans ruled apart", () => {
    for (const [g, s] of [
      ["lettuce", "romaine lettuce"],
      ["salsa", "salsa verde"],
      ["chili powder", "ancho chili powder"],
      ["diced tomatoes", "canned fire-roasted diced tomatoes"],
      ["tomato", "cherry tomatoes"],
      ["chicken thighs", "boneless skinless chicken thighs"],
      ["ground beef", "ground beef (80/20 chuck)"],
    ] as [string, string][]) {
      assert.equal(classifyEdge(g, s).hClass, "H1", `${g} over ${s}`);
    }
  });

  it("refuses the fold even when both names are on the list", () => {
    const idx = buildRelationIndex([sub("tomato", "cherry tomatoes")], {
      subsumes: overlay(["tomato", "cherry tomatoes"]),
    });
    assert.equal(idx.groupKey("cherry tomatoes"), "cherry tomatoes");
    assert.equal(
      idx.declined.find((d) => d.to === "cherry tomatoes")?.reason,
      "h1-different-product",
    );
  });

  it("a lean ratio is the product, not a size — H1 is tested before hedges", () => {
    // "80/20" is spelled exactly like a shrimp count. A hedge strip that ran
    // first would delete it and make this a GENERIC fold.
    assert.equal(classifyEdge("ground beef", "ground beef (80/20 chuck)").hClass, "H1");
    // …and a real count size still reads as a hedge.
    assert.equal(
      classifyEdge("large shrimp, peeled and deveined", "large shrimp, peeled and deveined (16/20 count)").hClass,
      "GENERIC",
    );
  });
});

// ── 3 — GENERIC: crusty bread + sourdough, one line, no rider ──────────────

describe("GENERIC — a hedge folds with no rider", () => {
  it("crusty bread absorbs sourdough and owes nothing", () => {
    const idx = buildRelationIndex([sub("crusty bread", "crusty sourdough bread")], {
      subsumes: overlay(["crusty bread", "crusty sourdough bread"]),
    });
    assert.equal(idx.groupKey("crusty sourdough bread"), "crusty bread");
    assert.equal(idx.varietiesByKey.size, 0, "a GENERIC fold states no variety");
  });

  it("folds even when the generic was NOT demanded — there is no second product", () => {
    const idx = buildRelationIndex([sub("roma tomatoes", "ripe roma tomatoes")], {
      subsumes: overlay(["ripe roma tomatoes"]),
    });
    assert.equal(idx.groupKey("ripe roma tomatoes"), "roma tomatoes");
  });
});

// ── 4 — the veto reaches the subsumes folds ────────────────────────────────

describe("the never-fold veto governs subsumes too", () => {
  // The cluster is built so that the ONLY thing joining the two forbidden names
  // is the SUBSUMES fold. Without it these are two separate clusters and nothing
  // is vetoed; with it they are one, and the veto has to catch a bridge it was
  // never written for. `fine` is an H3 token, so the subsumes edge is admitted on
  // its own merits rather than forced.
  const bridge: RelationRow[] = [
    syn("coarse salt", "coarse kosher salt"),
    sub("coarse salt", "fine coarse salt"),
    syn("fine coarse salt", "kosher salt"),
  ];
  const demandAll = overlay([
    "coarse salt", "coarse kosher salt", "fine coarse salt", "kosher salt",
  ]);

  it("the bridge really does exist — without the subsumes fold these are two clusters", () => {
    // The precondition this test depends on. If the synonym edges alone already
    // merged them, the veto below would prove nothing about subsumes.
    const idx = buildRelationIndex(bridge.filter((r) => r.label === "synonym"));
    assert.notEqual(idx.groupKey("coarse kosher salt"), idx.groupKey("kosher salt"));
    assert.equal(idx.declined.some((d) => d.reason === "never-fold-ruling"), false);
  });

  it("coarse kosher salt and kosher salt stay two lines through a subsumes cluster", () => {
    const idx = buildRelationIndex(bridge, { subsumes: demandAll });
    // The LIVE value: they are NOT one group, and the whole cluster was refused.
    assert.notEqual(idx.groupKey("coarse kosher salt"), idx.groupKey("kosher salt"));
    const veto = idx.declined.find((d) => d.reason === "never-fold-ruling");
    assert.ok(veto, "the cluster veto must fire on the subsumes bridge");
    assert.match(veto.detail ?? "", /coarse kosher salt \/ kosher salt/);
  });
});

// ── 5 — H2: the ruled defaults ─────────────────────────────────────────────

describe("H2 — a plain name joins its ruled default", () => {
  const rows = [
    sub("chicken thighs", "bone-in skin-on chicken thighs", "medium"),
    sub("chicken thighs", "boneless skinless chicken thighs", "medium"),
  ];

  it("the generic folds onto the default and the line takes the DEFAULT's name", () => {
    const idx = buildRelationIndex(rows, { subsumes: overlay(["chicken thighs"]) });
    // The LIVE value. Shortest-wins would give "chicken thighs" (14 chars) over
    // "bone-in skin-on chicken thighs" (30), so this asserts the pin.
    assert.equal(idx.groupKey("chicken thighs"), "bone-in skin-on chicken thighs");
    assert.equal(
      idx.pinnedNameByKey.get("bone-in skin-on chicken thighs"),
      "bone-in skin-on chicken thighs",
    );
  });

  it("a MEDIUM row is promoted by the ruling, not by its confidence", () => {
    // Both default rows are `medium` and unreviewed in the live table. Without
    // RULED_DEFAULT_PAIRS the confidence gate refuses them and H2 never fires.
    const idx = buildRelationIndex(rows, { subsumes: overlay(["chicken thighs"]) });
    assert.equal(idx.groupKey("chicken thighs"), "bone-in skin-on chicken thighs");
    // …and the OTHER medium row on the same generic is still refused.
    assert.equal(idx.groupKey("boneless skinless chicken thighs"), "boneless skinless chicken thighs");
  });

  it("does nothing when the plain name is not on the list", () => {
    const idx = buildRelationIndex(rows, { subsumes: overlay(["bone-in skin-on chicken thighs"]) });
    assert.equal(idx.groupKey("bone-in skin-on chicken thighs"), "bone-in skin-on chicken thighs");
    assert.equal(idx.pinnedNameByKey.size, 0);
  });
});

// ── 6 — no overlay means no subsumes reading, byte for byte ────────────────

describe("the reader is opt-in", () => {
  it("without an overlay every subsumes row declines as wrong-label", () => {
    const rows = [sub("bell peppers", "red bell pepper")];
    const idx = buildRelationIndex(rows);
    assert.equal(idx.groupKey("red bell pepper"), "red bell pepper");
    assert.equal(idx.declined[0]?.reason, "wrong-label");
    assert.equal(idx.varietiesByKey.size, 0);
    assert.equal(idx.pinnedNameByKey.size, 0);
  });
});

// ── 7 — the rider grammar, both directions ────────────────────────────────

describe("the rider grammar round-trips", () => {
  it("composes and parses the same shares", () => {
    const shares = [{ variety: "red", count: 2 }, { variety: "san marzano", count: 1 }];
    const name = appendVarietyRider("crushed tomatoes", shares);
    const back = parseVarietyRider(name);
    assert.equal(back.base, "crushed tomatoes");
    assert.deepEqual(back.shares, shares);
  });

  it("leaves a real comma in a name alone", () => {
    // "parmesan cheese, finely grated" is a catalog row. A loose parse would eat it.
    const back = parseVarietyRider("parmesan cheese, finely grated");
    assert.equal(back.base, "parmesan cheese, finely grated");
    assert.deepEqual(back.shares, []);
  });

  it("an empty share list composes nothing", () => {
    assert.equal(composeVarietyRider([]), "");
    assert.equal(appendVarietyRider("parsley", []), "parsley");
  });

  it("H7 — the split sends the varieties separately and the remainder generic", () => {
    const split = splitRiderForRetailer("bell peppers, at least 2 red and at least 2 yellow", 5);
    assert.deepEqual(split, [
      { name: "red bell peppers", quantity: 2 },
      { name: "yellow bell peppers", quantity: 2 },
      { name: "bell peppers", quantity: 1 },
    ]);
  });

  it("H7 — no remainder when the shares cover the whole count", () => {
    const split = splitRiderForRetailer("bell peppers, at least 2 red and at least 2 yellow", 4);
    assert.equal(split.length, 2);
    assert.equal(split.some((s) => s.name === "bell peppers"), false);
  });

  it("a line with no rider is one item", () => {
    assert.deepEqual(splitRiderForRetailer("bell peppers", 3), [
      { name: "bell peppers", quantity: 3 },
    ]);
  });
});

// ── 8 — the Instacart search term ─────────────────────────────────────────

describe("H7 — the search term keeps the product and drops the rest", () => {
  it("the rider never reaches the search term", () => {
    // NOT a new mechanism: "at" is already in instacartName.PREP_WORDS, so the
    // trailing clause is stripped by the rule that strips ", roughly chopped".
    // Asserted here so the day somebody prunes PREP_WORDS this goes red.
    assert.equal(instacartSearchName("bell peppers, at least 2 green"), "bell peppers");
    assert.equal(
      instacartSearchName("crushed tomatoes, at least 1 san marzano and at least 2 red"),
      "crushed tomatoes",
    );
  });

  it("a CUT is part of the product and survives", () => {
    assert.equal(
      instacartSearchName("boneless skinless chicken thighs"),
      "boneless skinless chicken thighs",
    );
    assert.equal(instacartSearchName("bone-in chicken thighs"), "bone-in chicken thighs");
  });

  it("a size or a prep note does not", () => {
    assert.equal(instacartSearchName("flour tortillas (large, 10-inch)"), "flour tortillas");
    assert.equal(instacartSearchName("long-grain white rice (day-old, cooked)"), "long-grain white rice");
  });
});

// ── 9 — BUG-160's containment, on the Instacart human line ────────────────

describe("BUG-160 — the pack's words are not repeated", () => {
  const row = (over: Partial<InstacartRowInput>): InstacartRowInput => ({
    id: "r1",
    displayName: "x",
    userResolvedTo: null,
    quantity: 1,
    unit: "each",
    deletedAt: null,
    purchaseQuantity: 1,
    purchaseUnit: "each",
    purchaseDisplay: null,
    purchaseUnitOverride: null,
    purchaseQuantityOverride: null,
    purchaseDisplayOverride: null,
    ...over,
  });

  const lineFor = (displayName: string, packSizeText: string, packUnit: string, packCount = 1) => {
    const r = composeInstacartPayload(
      [row({ displayName, purchaseUnit: packUnit, purchaseQuantity: 1 })],
      [{ groceryListItemId: "r1", packCount, packUnit, packSizeText }],
      { title: "t" },
    );
    return r.payload.line_items[0]?.display_text ?? "";
  };

  it("residue ⊇ name — the name is dropped", () => {
    // "3 medium white onion" + "white onion". The shipped rule's endsWith() half
    // caught this one; the census's other two it did not.
    assert.equal(lineFor("white onion", "medium white onion", "each", 3), "3 each medium white onion");
  });

  it("name OPENS with the residue — the count and the fuller name, once", () => {
    // The census's D5: "1 rotisserie chicken rotisserie chicken, meat shredded".
    assert.equal(
      lineFor("rotisserie chicken, meat shredded", "", "rotisserie chicken", 1),
      "1 rotisserie chicken, meat shredded",
    );
  });

  it("neither — the name is appended, and 'bell' is not thrown away", () => {
    // The defect a symmetric containment predicate shipped: "3 Bell peppers"
    // became "3 ". The pack says "peppers"; the NAME says which.
    const out = lineFor("bell peppers", "peppers", "each", 3);
    assert.match(out, /bell peppers/);
  });

  it("the plural stem does not over-stem — '6 limes' still elides 'Lime'", () => {
    // `endsWith("es") -> drop two` makes "limes" into "lim" and this regresses.
    assert.equal(lineFor("Lime", "limes", "each", 6), "6 each limes");
  });
});

// ── 10 — BUG-323, the casing rule ────────────────────────────────────────

describe("BUG-323 — the casing rule", () => {
  it("lowercases the leading character of a common noun", () => {
    assert.equal(lowercaseLead("Bell peppers"), "bell peppers");
    assert.equal(lowercaseLead("Chicken thighs"), "chicken thighs");
    assert.equal(lowercaseLead("Salt"), "salt");
  });

  it("keeps a proper noun's capital", () => {
    assert.equal(lowercaseLead("Frank's RedHot sauce"), "Frank's RedHot sauce");
    assert.equal(lowercaseLead("San Marzano tomatoes"), "San Marzano tomatoes");
    assert.equal(lowercaseLead("Italian seasoning"), "Italian seasoning");
    assert.equal(lowercaseLead("Thai basil"), "Thai basil");
  });

  it("touches the FIRST CHARACTER ONLY — an interior proper noun survives", () => {
    assert.equal(lowercaseLead("Plain Greek yogurt"), "plain Greek yogurt");
  });

  it("is idempotent and a no-op on a lowercase name", () => {
    assert.equal(lowercaseLead(lowercaseLead("Bell peppers")), "bell peppers");
    assert.equal(lowercaseLead("olive oil"), "olive oil");
  });

  it("basmati is NOT on the exception list (go-ahead #419)", () => {
    assert.equal(PROPER_NOUN_LEADS.includes("Basmati"), false);
    assert.equal(lowercaseLead("Basmati rice"), "basmati rice");
  });
});

// ── 11 — the multi-parent rule, in all three orders ──────────────────────

describe("the multi-parent rule", () => {
  const item = (canonicalName: string, quantity: number, unit: string): PoolableItem => ({
    canonicalName,
    displayName: canonicalName,
    quantity,
    unit,
    conversionRef: null,
    packYieldUnit: null,
    packYieldPerPack: null,
    purchaseUnit: null,
    purchaseQuantity: null,
    packFloor: null,
  });

  it("rule 1 — a parent already on the list wins over a more specific one", () => {
    // `parsley` is on the list; `flat-leaf parsley` is more specific. Rule 1
    // outranks rule 2, so the leaves top up the row the shopper is already buying.
    const rows = [
      comp("flat-leaf parsley", "fresh flat-leaf parsley leaves", 2, "cup", true),
      comp("parsley", "fresh flat-leaf parsley leaves", 2, "cup", true),
    ];
    const idx = buildRelationIndex(rows);
    // The parent row must be in the BASIS unit for "on the list" to mean
    // anything — that is what the top-up matches on (BUG-208). `comp()` above
    // authors fromDefaultUnit "each", so the row is in `each`.
    const out = poolComponentNeeds(
      [item("parsley", 1, "each"), item("fresh flat-leaf parsley leaves", 1, "cup")],
      idx,
    );
    assert.equal(out.folds.length, 1);
    assert.equal(out.folds[0].parent, "parsley");
    assert.equal(out.folds[0].toppedUpExisting, true);
  });

  it("rule 2 — with neither on the list, the MOST SPECIFIC parent takes it", () => {
    // `a leaf` contains "specific a" but not "zzz"; alphabetical alone would give
    // it to "a" (sorted first), so this asserts containment beats the sort.
    const rows = [
      comp("a", "specific a leaf", 2, "cup", true),
      comp("specific a", "specific a leaf", 2, "cup", true),
    ];
    const idx = buildRelationIndex(rows);
    const out = poolComponentNeeds([item("specific a leaf", 1, "cup")], idx);
    assert.equal(out.folds.length, 1);
    assert.equal(out.folds[0].parent, "specific a", "the more specific parent must win");
  });

  it("rule 3 — with neither on the list and neither contained, alphabetical", () => {
    const rows = [
      comp("chipotle chile in adobo", "adobo sauce", 1, "tbsp", true),
      comp("chipotle peppers in adobo sauce", "adobo sauce", 1, "tbsp", true),
    ];
    const idx = buildRelationIndex(rows);
    const out = poolComponentNeeds([item("adobo sauce", 1, "tablespoon")], idx);
    assert.equal(out.folds[0].parent, "chipotle chile in adobo");
  });
});

// ── 12 — the never-order by-products ────────────────────────────────────

describe("cooking by-products are never ordered", () => {
  it("the six reachable ones are refused", () => {
    for (const n of [
      "reserved birria braising liquid",
      "reserved braising liquid from chicken birria",
      "reserved braising liquid from goat birria",
      "reserved frying oil",
      "reserved pineapple juice",
      "reserved zucchini flesh",
    ]) {
      assert.equal(isNeverOrdered(n), true, n);
    }
  });

  it("the third pasta-water spelling is covered now", () => {
    assert.equal(isNeverOrdered("reserved pasta water"), true);
    assert.equal(isNeverOrdered("pasta cooking water"), true);
  });

  it("a real purchase containing the same words is NOT refused", () => {
    // The reason the set lists names and not a "contains reserved" pattern.
    assert.equal(isNeverOrdered("reserve cabernet"), false);
    assert.equal(isNeverOrdered("frying oil"), false);
    assert.equal(isNeverOrdered("pineapple juice"), false);
  });
});

// ── 13 — the classifier's own seams ─────────────────────────────────────

describe("the classifier", () => {
  it("names the distinguishing words plural-insensitively", () => {
    // Without the stem this reads ["red", "pepper"] and the rider says
    // "at least 2 red pepper".
    assert.deepEqual(distinguishingTokens("bell peppers", "red bell pepper"), ["red"]);
  });

  it("a colour on a pepper is H3, not H1 — H1's colour clause is about siblings", () => {
    assert.equal(classifyEdge("bell peppers", "red bell pepper").hClass, "H3");
    assert.equal(classifyEdge("onion", "white onion").hClass, "H3");
  });

  it("a synonym cluster still folds with no overlay in sight", () => {
    const idx = buildRelationIndex([syn("fresh parsley", "parsley")]);
    assert.equal(idx.groupKey("fresh parsley"), "parsley");
  });
});
