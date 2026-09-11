// WS9 D-WS9-189 Block A2 — guards for the synonym + component readers.
//
// Every assertion here READS A LIVE VALUE and compares it to a literal. Where a
// literal appears on both sides the test is worthless (a guard once asserted
// Colors.neutral[300] === "#E4DCCB" with the expected side declared as the same
// literal — true forever, never touching the thing under test), so each block
// below names which expression would change if the defect shipped.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildRelationIndex,
  handMapSynonymCollisions,
  unexpectedHandMapCollisions,
  poolComponentNeeds,
  poolComponentNeedsUngated,
  pairKey,
  COMPONENT_POOLING_ENABLED,
  HAND_MAP_VARIANTS,
  KNOWN_HAND_MAP_COLLISIONS,
  type RelationRow,
  type PoolableItem,
} from "../ingredientRelations";
import { mergeGroupBaseName } from "../groceryStaples";
import { roundNeedQuantity } from "../needQuantity";

function syn(
  from: string,
  to: string,
  confidence: RelationRow["confidence"] = "high",
  reviewedByHuman = false,
): RelationRow {
  return {
    label: "synonym",
    fromCanonicalName: from,
    toCanonicalName: to,
    yieldQuantity: null,
    yieldUnit: null,
    coHarvestable: null,
    confidence,
    reviewedByHuman,
    fromDefaultUnit: "each",
  };
}

function comp(
  from: string,
  to: string,
  yieldQuantity: number,
  yieldUnit: string,
  coHarvestable: boolean,
  fromDefaultUnit = "each",
): RelationRow {
  return {
    label: "component",
    fromCanonicalName: from,
    toCanonicalName: to,
    yieldQuantity,
    yieldUnit,
    coHarvestable,
    confidence: "high",
    reviewedByHuman: false,
    fromDefaultUnit,
  };
}

function item(
  canonicalName: string,
  quantity: number,
  unit: string,
): PoolableItem {
  return { canonicalName, displayName: canonicalName, quantity, unit };
}

// ── the scope fence ────────────────────────────────────────────────────────
describe("D-WS9-189 A2 — subsumes and distinct are refused, not merely unread", () => {
  it("declines every subsumes and distinct row and folds nothing from them", () => {
    const rows: RelationRow[] = [
      { ...syn("olive oil", "extra virgin olive oil"), label: "subsumes" },
      { ...syn("black pepper", "white pepper"), label: "distinct" },
    ];
    const idx = buildRelationIndex(rows);

    // Which expression changes if the defect ships: admittedSynonymCount would
    // become 2 and the folds below would collapse onto one representative.
    assert.equal(idx.admittedSynonymCount, 0);
    assert.equal(idx.clusters.length, 0);
    assert.equal(idx.groupKey("extra virgin olive oil"), "olive oil");
    assert.equal(idx.groupKey("white pepper"), "white pepper");
    assert.equal(idx.declined.length, 2);
    assert.deepEqual(
      idx.declined.map((d) => d.reason),
      ["wrong-label", "wrong-label"],
    );
  });
});

// ── the confidence gate ────────────────────────────────────────────────────
describe("D-WS9-189 A2 — the synonym admission gate", () => {
  it("admits high, admits reviewedByHuman at any confidence, refuses bare medium", () => {
    const idx = buildRelationIndex([
      syn("aa high one", "aa high two", "high"),
      syn("bb human one", "bb human two", "medium", true),
      syn("cc medium one", "cc medium two", "medium"),
    ]);
    assert.equal(idx.admittedSynonymCount, 2);
    // high folds
    assert.equal(idx.groupKey("aa high two"), "aa high one");
    // reviewedByHuman folds even at medium
    assert.equal(idx.groupKey("bb human two"), "bb human one");
    // bare medium does NOT fold — the live value is the fold result, the
    // literal is the unfolded name.
    assert.equal(idx.groupKey("cc medium two"), "cc medium two");
    assert.deepEqual(
      idx.declined.map((d) => d.reason),
      ["confidence-below-gate"],
    );
  });

  it("promotes only the two ruled neutral-oil pairs past the medium gate", () => {
    const idx = buildRelationIndex([
      syn("neutral oil", "neutral vegetable oil", "medium"),
      syn("neutral vegetable oil", "vegetable oil", "medium"),
      syn("anchovy fillets", "anchovy fillets in oil", "medium"),
    ]);
    // Hans: "neutral oil can be considered vegetable oil."
    assert.equal(idx.groupKey("neutral vegetable oil"), "neutral oil");
    assert.equal(idx.groupKey("vegetable oil"), "neutral oil");
    // Not ruled -> still held.
    assert.equal(idx.groupKey("anchovy fillets in oil"), "anchovy fillets in oil");
  });
});

// ── the permanent salt ruling ──────────────────────────────────────────────
describe("D-WS9-189 A2 — coarse kosher salt NEVER folds with kosher salt", () => {
  // Hans, 2026-09-05: "unfolded, we can leave that as coarse and regular as
  // separate items. if the user wants to sub regular for coarse it's up to
  // them." THE SUBSTITUTION IS THE USER'S CALL, NOT KIWI'S.
  //
  // This is a RULING, not a threshold. The three cases below are the three ways
  // a future change could lift it by accident.
  it("stays unfolded at high confidence", () => {
    const idx = buildRelationIndex([
      syn("coarse kosher salt", "kosher salt", "high"),
    ]);
    assert.equal(idx.groupKey("coarse kosher salt"), "coarse kosher salt");
    assert.equal(idx.groupKey("kosher salt"), "kosher salt");
    assert.notEqual(
      idx.groupKey("coarse kosher salt"),
      idx.groupKey("kosher salt"),
    );
    assert.equal(idx.admittedSynonymCount, 0);
    assert.equal(idx.declined[0].reason, "never-fold-ruling");
  });

  it("stays unfolded even when marked reviewedByHuman", () => {
    const idx = buildRelationIndex([
      syn("coarse kosher salt", "kosher salt", "high", true),
    ]);
    assert.notEqual(
      idx.groupKey("coarse kosher salt"),
      idx.groupKey("kosher salt"),
    );
    assert.equal(idx.declined[0].reason, "never-fold-ruling");
  });

  it("stays unfolded when a WIDENED CLUSTER would otherwise sweep it up", () => {
    // The failure mode the ruling names explicitly: not a direct edge, but a
    // transitive path A-B-C that lands the two salts in one cluster anyway.
    const idx = buildRelationIndex([
      syn("coarse kosher salt", "coarse salt", "high"),
      syn("coarse salt", "kosher salt", "high"),
    ]);
    assert.notEqual(
      idx.groupKey("coarse kosher salt"),
      idx.groupKey("kosher salt"),
      "a transitive path must not land the two salts in one fold",
    );
  });
});

// ── the disjointness invariant ─────────────────────────────────────────────
describe("D-WS9-189 A2 — the hand map and the synonym label stay disjoint", () => {
  it("restates MERGE_GROUP_VARIANT_TO_BASE's keys accurately", () => {
    // HAND_MAP_VARIANTS is a copy of a module-private map. Assert every entry
    // against the LIVE function so the copy cannot drift silently: a variant
    // that stopped folding would return itself.
    assert.equal(HAND_MAP_VARIANTS.length, 11);
    for (const v of HAND_MAP_VARIANTS) {
      assert.notEqual(
        mergeGroupBaseName(v),
        v,
        `${v} is listed as a hand-map variant but mergeGroupBaseName leaves it unchanged`,
      );
    }
  });

  it("reports NO collision on a table with no hand-map synonym edge", () => {
    const idx = buildRelationIndex([syn("yellow onion", "yellow onion, diced")]);
    assert.deepEqual(handMapSynonymCollisions(idx), []);
  });

  it("treats the KNOWN live collision as expected, not as a failure", () => {
    // ⚠️ THE EXPECTATION IS "EXACTLY THE KNOWN COLLISIONS", NOT ZERO. A
    // must-be-zero assertion would have failed the first time this ran against
    // real data and been "fixed" by deletion: `extra virgin olive oil <->
    // extra-virgin olive oil` is a genuine synonym edge joining two hand-map
    // keys. It is REDUNDANT — the hand map folds both onto `olive oil` anyway,
    // so the composed key is identical — not contradictory.
    const idx = buildRelationIndex([
      syn("extra virgin olive oil", "extra-virgin olive oil"),
    ]);
    const all = handMapSynonymCollisions(idx);
    // TWO, not one: the edge joins two hand-map keys, so each is a collision.
    // The first version of this guard saw only one because it tested "did the
    // fold change the name" and the cluster representative folds to itself.
    assert.equal(all.length, 2, "both endpoints of the live edge are hand-map keys");
    for (const c of all) {
      assert.ok(
        KNOWN_HAND_MAP_COLLISIONS.includes(c.variant),
        `${c.variant} should be on the reviewed allowlist`,
      );
    }
    // Redundant, not contradictory: both spellings still key to `olive oil`.
    assert.equal(idx.groupKey("extra virgin olive oil"), "olive oil");
    assert.equal(idx.groupKey("extra-virgin olive oil"), "olive oil");
    // And the guard that must stay empty is empty.
    assert.deepEqual(unexpectedHandMapCollisions(idx), []);
  });

  it("still fires on an UNKNOWN collision", () => {
    // The allowlist must not blanket the whole check. `light olive oil` is a
    // hand-map key that carries no synonym edge in the live table.
    const idx = buildRelationIndex([
      syn("extra virgin olive oil", "extra-virgin olive oil"),
      syn("light olive oil", "olio leggero"),
    ]);
    const unexpected = unexpectedHandMapCollisions(idx);
    assert.equal(unexpected.length, 1);
    assert.equal(unexpected[0].variant, "light olive oil");
    assert.equal(unexpected[0].handMapBase, "olive oil");
  });

  it("every allowlisted collision is REDUNDANT — both paths reach one key", () => {
    // ⚠️ The allowlist is not a mute button. An entry earns its place only by
    // being redundant: every member of its cluster must compose to the SAME key
    // the hand map alone would produce. This asserts that property on the live
    // table's four collisions, so allowlisting a CONTRADICTORY one later fails
    // here rather than passing silently.
    const idx = buildRelationIndex([
      syn("extra virgin olive oil", "extra-virgin olive oil"),
      syn("black pepper, ground", "ground black pepper"),
      syn("black pepper, freshly ground", "freshly ground black pepper"),
    ]);
    const collisions = handMapSynonymCollisions(idx);
    assert.equal(collisions.length, 4, "the live table's four collisions");
    for (const c of collisions) {
      assert.ok(KNOWN_HAND_MAP_COLLISIONS.includes(c.variant), `${c.variant} unreviewed`);
      const cluster = idx.clusters.find((x) => x.members.includes(c.variant));
      assert.ok(cluster);
      const keys = new Set(cluster!.members.map((m) => idx.groupKey(m)));
      assert.equal(keys.size, 1, `${c.variant}'s cluster does not compose to one key`);
      assert.equal(
        [...keys][0],
        mergeGroupBaseName(c.variant),
        `${c.variant} composes to a DIFFERENT key than the hand map alone — contradictory, not redundant`,
      );
    }
    assert.deepEqual(unexpectedHandMapCollisions(idx), []);
  });

  it("REPORTS a collision the moment a hand-map variant gains a synonym edge", () => {
    // The guard's whole purpose: overlap is 0 today and the table grows.
    const idx = buildRelationIndex([
      syn("extra virgin olive oil", "evoo oil blend"),
    ]);
    const collisions = handMapSynonymCollisions(idx);
    assert.equal(collisions.length, 1);
    assert.equal(collisions[0].variant, "extra virgin olive oil");
    assert.equal(collisions[0].handMapBase, "olive oil");
    assert.equal(collisions[0].synonymRepresentative, "evoo oil blend");
  });
});

// ── composition order ──────────────────────────────────────────────────────
describe("D-WS9-189 A2 — synonym folds FIRST, the hand map keeps the last word", () => {
  it("chains a synonym fold into a hand-map fold", () => {
    // "black pepper, ground" is NOT in the hand map; "ground black pepper" is.
    // Only synonym-then-map reaches "black pepper".
    const idx = buildRelationIndex([
      syn("black pepper, ground", "ground black pepper"),
    ]);
    // "ground black pepper" (19 chars) is shorter than "black pepper, ground"
    // (20), so it is the representative and the fold points that way.
    assert.equal(idx.clusters.length, 1);
    assert.equal(idx.clusters[0].representative, "ground black pepper");
    assert.equal(idx.synonymFold("black pepper, ground"), "ground black pepper");

    // THE COMPOSED RESULT — this is the expression that changes if the order
    // is reversed or the second pass is dropped.
    assert.equal(idx.groupKey("black pepper, ground"), "black pepper");
    assert.equal(idx.groupKey("ground black pepper"), "black pepper");
  });

  it("reaches a FIXPOINT — both mechanisms get their last look", () => {
    // ⚠️ THIS GUARD REPLACED AN ORDER ASSERTION, and the reason is a deliberate
    // break that stayed GREEN. Swapping the two steps to
    // `synonymFold(mergeGroupBaseName(cur))` changed nothing: with the loop
    // present both orders converge on the same fixpoint, the reversed one
    // simply taking an extra round. Order is therefore NOT the invariant. The
    // iteration is — so that is what this asserts.
    //
    // The fixture needs TWO rounds under the shipped order, which a one-pass
    // implementation cannot reach:
    //   "black pepper, ground" --syn--> "ground black pepper"
    //                          --map--> "black pepper"        (round 1)
    //                          --syn--> "bp"                  (round 2)
    const idx = buildRelationIndex([
      syn("black pepper, ground", "ground black pepper"),
      syn("black pepper", "bp"),
    ]);
    const k = idx.groupKey("black pepper, ground");
    assert.equal(k, "bp", "a single pass stops at 'black pepper'");
    // The property itself: applying the key to its own output is a no-op.
    assert.equal(
      idx.groupKey(k),
      k,
      "groupKey is not a fixpoint — one mechanism never got its last look",
    );
    // And every hand-map variant must also be stable under it.
    for (const v of HAND_MAP_VARIANTS) {
      const kv = idx.groupKey(v);
      assert.equal(idx.groupKey(kv), kv, `groupKey unstable on ${v}`);
    }
  });

  it("terminates on a cyclic fold rather than spinning", () => {
    const idx = buildRelationIndex([syn("aa", "bb"), syn("bb", "aa")]);
    assert.equal(idx.groupKey("aa"), "aa");
    assert.equal(idx.groupKey("bb"), "aa");
  });
});

// ── representative choice ──────────────────────────────────────────────────
describe("D-WS9-189 A2 — shortest normalized name wins, ties alphabetical", () => {
  it("picks the short name over a long baked-pack name", () => {
    const idx = buildRelationIndex([
      syn("parmesan cheese", "1 block (8 oz) parmesan cheese"),
    ]);
    assert.equal(idx.clusters[0].representative, "parmesan cheese");
    assert.equal(
      idx.groupKey("1 block (8 oz) parmesan cheese"),
      "parmesan cheese",
    );
  });

  it("breaks an equal-length tie alphabetically", () => {
    const idx = buildRelationIndex([syn("bbbb", "aaaa")]);
    assert.equal(idx.clusters[0].representative, "aaaa");
  });
});

// ── inertness of the water family ──────────────────────────────────────────
describe("D-WS9-189 A2 — the water relations are inert by construction", () => {
  it("keeps every never-ordered water name out of the reader's reach", async () => {
    // BUG-169 drops these at the consolidator BEFORE bucketing, so no water row
    // can ever be handed to a reader. Assert the inertness rather than relying
    // on it: isNeverOrdered is the live value, the name list is the literal.
    const { isNeverOrdered } = await import("../groceryStaples");
    for (const n of [
      "water",
      "warm water",
      "cold water",
      "ice water",
      "ice-cold water",
      "boiling water",
      "pasta cooking water",
      "reserved pasta cooking water",
    ]) {
      assert.equal(isNeverOrdered(n), true, `${n} must be never-ordered`);
    }
  });
});

// ── the component basis gate ───────────────────────────────────────────────
describe("D-WS9-189 A2 — the component basis gate (D-WS9-218)", () => {
  it("admits each / head / bunch and declines every other basis, with a reason", () => {
    const idx = buildRelationIndex([
      comp("lemon", "lemon juice", 3, "tbsp", true, "each"),
      comp("broccoli", "broccoli florets", 3, "cup", true, "head"),
      comp("cilantro", "fresh cilantro leaves", 1, "cup", true, "bunch"),
      comp("large eggs", "egg whites", 1, "each", true, "dozen"),
      comp("parmesan", "parmesan rind", 1, "each", true, "cup"),
      comp("celery", "celery stalks", 8, "each", false, "stalks"),
    ]);
    assert.equal(idx.admittedComponentCount, 3);
    assert.deepEqual(
      idx.componentParents.map((p) => p.parent).sort(),
      ["broccoli", "cilantro", "lemon"],
    );
    const declinedBasis = idx.declined.filter(
      (d) => d.reason === "basis-unit-not-countable",
    );
    assert.equal(declinedBasis.length, 3);
    // A declined edge must be VISIBLY declined, not silently skipped.
    for (const d of declinedBasis) {
      assert.match(String(d.detail), /is not a countable whole purchase/);
    }
  });

  it("is SINGLE-HOP: a parent that is itself a child is not followed", () => {
    // WS9 D-WS9-189 A3 — this used to be written on the garlic chain. It no
    // longer can be: the A3 hand map routes every garlic spelling to one group
    // key, so both garlic edges are now self-slots and are dropped before this
    // property can be observed on them. The PROPERTY is unchanged and is what
    // is under test here, so it moved to a synthetic two-hop chain that no fold
    // touches. The garlic behaviour has its own test below.
    const idx = buildRelationIndex([
      comp("crate", "melon", 6, "each", false, "each"),
      comp("melon", "melon flesh", 4, "cup", false, "each"),
    ]);
    assert.equal(idx.admittedComponentCount, 2);
    assert.deepEqual(idx.componentParents.map((p) => p.parent), ["crate", "melon"]);
    // "melon flesh" pools onto "melon" — ONE hop. The pass must not then carry
    // that melon on to "crate". If it ever followed the chain, a crate would
    // appear in the output and items.length would change.
    const pooled = poolComponentNeedsUngated([item("melon flesh", 8, "cup")], idx);
    assert.equal(pooled.folds.length, 1);
    assert.equal(pooled.folds[0].parent, "melon");
    assert.deepEqual(
      pooled.items.map((i) => `${i.quantity} ${i.unit} ${i.canonicalName}`),
      ["2 each melon"],
      "one hop only — a crate must never appear",
    );
  });

  // ── WS9 D-WS9-189 A3 — the garlic ruling, encoded ────────────────────────
  //
  // §3: the subUnit ladder wins for garlic, and the component pool must not
  // restate a row the ladder already handles. The hand map folds every garlic
  // spelling to one group key, which turns `garlic head -> garlic` into a slot
  // whose child IS its parent. buildRelationIndex drops those.
  it("drops a component slot whose child folds onto its own parent", () => {
    const idx = buildRelationIndex([
      comp("garlic head", "garlic", 10, "clove", false, "head"),
    ]);
    // The edge is admitted — it is a real, high-confidence component edge —
    // but it yields NO slot, because both endpoints key to "garlic".
    assert.equal(idx.groupKey("garlic head"), idx.groupKey("garlic"));
    assert.deepEqual(idx.componentParents, [], "a parent may not list itself as a child");

    // The consequence that matters: garlic rows pass through the pool
    // untouched, so mergeGroup's subUnit branch is the only thing that acts on
    // them. If the self-slot ever came back, these two rows would be absorbed
    // and replaced by a pooled parent, which is the regression D-WS9-189 A2
    // measured on 40 of 42 lists.
    const pooled = poolComponentNeedsUngated(
      [item("garlic", 30, "clove"), item("head of garlic", 2, "head")],
      idx,
    );
    assert.equal(pooled.folds.length, 0);
    assert.equal(pooled.items.length, 2);
  });
});

// ── the pooling arithmetic ─────────────────────────────────────────────────
describe("D-WS9-189 A2 — coHarvestable decides max vs sum", () => {
  const limeRows: RelationRow[] = [
    comp("lime", "lime juice", 2, "tbsp", true),
    comp("lime", "lime zest", 2, "tsp", true),
    comp("lime", "lime wedges", 6, "each", false),
  ];

  it("takes max across co-harvestable slots and adds the exclusive one", () => {
    const idx = buildRelationIndex(limeRows);
    const pooled = poolComponentNeedsUngated(
      [
        item("lime juice", 4, "tbsp"), // 2 limes
        item("lime zest", 2, "tsp"), // 1 lime
        item("lime wedges", 6, "each"), // 1 lime, exclusive
      ],
      idx,
    );
    assert.equal(pooled.folds.length, 1);
    const f = pooled.folds[0];
    // max(2, 1) + 1 = 3.  A `sum` would give 4; a bare `max` would give 2.
    assert.equal(f.rawPool, 3);
    assert.equal(f.wholeParents, 3);
    assert.equal(pooled.items.length, 1);
    assert.equal(pooled.items[0].canonicalName, "lime");
    assert.equal(pooled.items[0].quantity, 3);
    assert.equal(pooled.items[0].unit, "each");
  });

  it("SUMS demand across synonym spellings of one child before pooling", () => {
    // The under-buy the ordering rule exists to prevent: 2 tbsp + 2 tbsp on two
    // differently-spelled rows is FOUR tbsp and needs TWO limes, not max(1,1).
    const idx = buildRelationIndex([
      ...limeRows,
      comp("lime", "fresh lime juice", 2, "tbsp", true),
      syn("lime juice", "fresh lime juice"),
    ]);
    const pooled = poolComponentNeedsUngated(
      [item("lime juice", 2, "tbsp"), item("fresh lime juice", 2, "tbsp")],
      idx,
    );
    assert.equal(pooled.folds.length, 1);
    assert.equal(pooled.folds[0].slots.length, 1, "the two spellings are ONE slot");
    assert.equal(pooled.folds[0].slots[0].demand, 4);
    assert.equal(pooled.folds[0].wholeParents, 2);
  });

  it("adds the parent's own demand on top of the pooled demand", () => {
    const idx = buildRelationIndex(limeRows);
    const pooled = poolComponentNeedsUngated(
      [item("lime", 2, "each"), item("lime juice", 2, "tbsp")],
      idx,
    );
    // 2 whole limes for the recipe + 1 for the juice = 3.
    assert.equal(pooled.items.length, 1);
    assert.equal(pooled.items[0].quantity, 3);
    assert.equal(pooled.folds[0].toppedUpExisting, true);
  });

  it("declines a slot whose unit needs a density, and PRINTS it", () => {
    const idx = buildRelationIndex(limeRows);
    const pooled = poolComponentNeedsUngated([item("lime juice", 3, "ounce")], idx);
    assert.equal(pooled.folds.length, 0);
    assert.equal(pooled.declines.length, 1);
    assert.match(pooled.declines[0].reason, /does not convert to yield unit/);
    // The row survives untouched rather than being silently dropped.
    assert.equal(pooled.items.length, 1);
    assert.equal(pooled.items[0].canonicalName, "lime juice");
  });
});

// ── the whole-unit rule vs step 5 ──────────────────────────────────────────
describe("D-WS9-189 A2 — the pool ceils, and step 5 never re-rounds it", () => {
  it("ceils a fractional pool to a whole purchase", () => {
    const idx = buildRelationIndex([comp("lemon", "lemon juice", 3, "tbsp", true)]);
    const pooled = poolComponentNeedsUngated([item("lemon juice", 4, "tbsp")], idx);
    // 4/3 = 1.33 lemons -> 2.
    assert.ok(Math.abs(pooled.folds[0].rawPool - 4 / 3) < 1e-9);
    assert.equal(pooled.folds[0].wholeParents, 2);
    assert.equal(pooled.items[0].quantity, 2);
  });

  it("survives roundNeedQuantity unchanged — no double round", () => {
    // Which expression changes if the defect ships: roundNeedQuantity's output.
    // If the pass ever emitted a fraction, or if step 5 gained a ceil, these
    // would diverge.
    const idx = buildRelationIndex([comp("lemon", "lemon juice", 3, "tbsp", true)]);
    for (const demand of [1, 2, 3, 4, 7, 10]) {
      const pooled = poolComponentNeedsUngated([item("lemon juice", demand, "tbsp")], idx);
      const q = pooled.items[0].quantity;
      assert.equal(Number.isInteger(q), true, `pool emitted a non-integer: ${q}`);
      assert.equal(
        roundNeedQuantity(q, pooled.items[0].unit),
        q,
        `step 5 re-rounded a value the pool already rounded: ${q}`,
      );
    }
  });
});

// ── pairKey ────────────────────────────────────────────────────────────────
describe("D-WS9-189 A2 — pairKey is symmetric and normalizing", () => {
  it("gives one key for both orderings and for case variants", () => {
    assert.equal(pairKey("a b", "c d"), pairKey("c d", "a b"));
    assert.equal(pairKey("Kosher Salt", "coarse kosher salt"), pairKey("coarse kosher salt", "kosher salt"));
    assert.notEqual(pairKey("a", "b"), pairKey("a", "c"));
  });
});

// -- WS9 D-WS9-189 A2 -- THE COMPONENT PASS IS HELD, AND "OFF" IS A CLAIM -----
//
// A pass that is off because nobody happens to call it is one refactor from
// being on. These assert the gate itself, on the SHIPPED entry point, using the
// fixture that produces the largest change when the gate is open (3 limes from
// juice + zest + wedges).
describe("D-WS9-189 A2 -- the component pass is HELD and mutates nothing", () => {
  const limeRows: RelationRow[] = [
    comp("lime", "lime juice", 2, "tbsp", true),
    comp("lime", "lime zest", 2, "tsp", true),
    comp("lime", "lime wedges", 6, "each", false),
  ];

  // WS9 D-WS9-189 A3 — this block used to assert the gate was SHUT. A3 opens
  // it, so the assertions are INVERTED rather than deleted: the flag is read
  // live and compared to `true`, and the SHIPPED entry point must now actually
  // pool. That is strictly stronger than the old pair — "returns its input
  // unchanged" also passes for a pass that is simply broken, whereas this
  // fails unless the arithmetic runs and lands on the right number.
  it("declares itself LIVE", () => {
    assert.equal(COMPONENT_POOLING_ENABLED, true);
  });

  it("pools through the SHIPPED entry point, not just the ungated one", () => {
    const idx = buildRelationIndex(limeRows);
    const input = [
      item("lime juice", 4, "tbsp"),
      item("lime zest", 2, "tsp"),
      item("lime wedges", 6, "each"),
      item("lime", 2, "each"),
    ];
    const out = poolComponentNeeds(input, idx);
    assert.equal(out.folds.length, 1, "the gate must route to the real pass");
    assert.equal(out.items.length, 1, "4 rows collapse to 1");
    assert.equal(out.items[0].canonicalName, "lime");
    // max(2 limes for juice, 1 for zest) + 1 for wedges = 3, on top of the 2
    // the recipe already wants whole.
    assert.equal(out.items[0].quantity, 5);
  });

  // ── WS9 BUG-207 — the appended parent must not wear a child's identity ────
  it("appends a parent row carrying NO child pack and NO child ingredientId", () => {
    const idx = buildRelationIndex([comp("orange", "orange juice", 0.25, "cup", true)]);
    // The only row on the list is the CHILD, and it carries a bottle. Before
    // the fix the appended parent spread this row wholesale and the shopper
    // read "1 bottle (64 oz) orange (1 each)".
    const child = {
      canonicalName: "orange juice",
      displayName: "orange juice",
      quantity: 3,
      unit: "tablespoon",
      ingredientId: "ing-orange-juice",
      purchaseUnit: "bottle",
      purchaseQuantity: 1,
      purchaseDisplay: "1 bottle (64 oz)",
      conversionRef: null,
    };
    const out = poolComponentNeeds([child], idx);
    assert.equal(out.items.length, 1);
    const parent = out.items[0];
    assert.equal(parent.canonicalName, "orange");
    assert.notEqual(parent.purchaseDisplay, "1 bottle (64 oz)", "the parent wore the child's pack");
    // ⚠️ THE DURABLE HALF. A null pack on a row that still carries an
    // ingredientId is a fillPurchaseSizesWithWriteBack cache MISS, and that
    // helper writes Haiku's guess onto Ingredient.purchaseUnit/Quantity/Display
    // for that id — here, onto ORANGE JUICE's catalog row. The write-back skips
    // rows whose ingredientId is null, so this is the field that decides
    // whether a bad pack outlives the list.
    assert.equal(parent.ingredientId, null, "the parent inherited the child's catalog identity");
  });

  // ── WS9 BUG-208 — decline, never a twin ──────────────────────────────────
  it("declines when a parent row exists in a unit the basis cannot reach", () => {
    const idx = buildRelationIndex([comp("cilantro", "fresh cilantro stems", 0.75, "cup", true, "bunch")]);
    // The live shape from bd29f91a: a `cilantro` row authored in CUPS against a
    // basis of `bunch`. The top-up matched nothing and the pass appended, so
    // the shopper read two rows both called "fresh cilantro".
    const rows = [
      item("cilantro", 1.3333, "cup"),
      item("fresh cilantro stems", 0.25, "cup"),
    ];
    const out = poolComponentNeeds(rows, idx);
    assert.equal(out.folds.length, 0, "it must not pool into a second row");
    assert.equal(out.items.length, 2, "both rows pass through untouched");
    assert.equal(out.declines.length, 1);
    assert.match(out.declines[0].reason, /does not reconcile with the basis unit/);
    // The property in the shopper's terms: no name appears twice.
    assert.equal(new Set(out.items.map((i) => i.canonicalName)).size, out.items.length);
  });

  it("still tops up a parent row whose unit DOES match the basis", () => {
    // The control for the decline above. If this ever declines too, the guard
    // has stopped discriminating and is refusing everything.
    const idx = buildRelationIndex([comp("cilantro", "fresh cilantro stems", 0.75, "cup", true, "bunch")]);
    const out = poolComponentNeeds(
      [item("cilantro", 1, "bunch"), item("fresh cilantro stems", 0.75, "cup")],
      idx,
    );
    assert.equal(out.folds.length, 1);
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].quantity, 2, "1 bunch already wanted + 1 bunch of stems");
  });

  // ── WS9 D-WS9-189 A3 — the density that already existed, now threaded ────
  it("converts a WEIGHT demand onto a VOLUME yield when the density is there", () => {
    const idx = buildRelationIndex([comp("broccoli", "broccoli florets", 4, "cup", true, "head")]);
    const florets = {
      canonicalName: "broccoli florets",
      displayName: "broccoli florets",
      quantity: 1.25,
      unit: "pound",
      // The live catalog value on `broccoli florets`.
      conversionRef: { gramsPerCup: 71, source: "usda_derived" },
    };
    const out = poolComponentNeeds([florets], idx);
    // 1.25 lb = 567.0 g; / 71 g per cup = 7.99 cups; / 4 cups per head = 2.0 heads.
    assert.equal(out.declines.length, 0, "it declined a conversion the data supports");
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].canonicalName, "broccoli");
    assert.equal(out.items[0].quantity, 2);
  });

  it("still REFUSES when no density exists, rather than guessing", () => {
    // `fresh basil leaves` carries conversionRef null in the live catalog, and
    // "16 each" of leaves cannot become cups without a grams-per-leaf nobody
    // has. Inventing one is the failure mode A1 shipped; declining is correct.
    const idx = buildRelationIndex([comp("fresh basil", "fresh basil leaves", 2, "cup", true, "bunch")]);
    const out = poolComponentNeeds([item("fresh basil leaves", 16, "each")], idx);
    assert.equal(out.folds.length, 0);
    assert.equal(out.declines.length, 1);
    assert.match(out.declines[0].reason, /does not convert to yield unit/);
    assert.equal(out.items.length, 1);
  });

  it("gated and ungated agree, so the flag is the only difference", () => {
    // The control. If these ever diverge, the gate is doing something other
    // than gating.
    const idx = buildRelationIndex(limeRows);
    const mk = () => [
      item("lime juice", 4, "tbsp"),
      item("lime zest", 2, "tsp"),
      item("lime wedges", 6, "each"),
      item("lime", 2, "each"),
    ];
    const gated = poolComponentNeeds(mk(), idx);
    const ungated = poolComponentNeedsUngated(mk(), idx);
    assert.deepEqual(
      gated.items.map((i) => ({ ...i })),
      ungated.items.map((i) => ({ ...i })),
    );
    assert.equal(gated.folds.length, ungated.folds.length);
  });
});

// ── WS9 BUG-251 — the pool prefers a parent already on the list ────────────
describe("BUG-251 — a child under two parents goes to the one already on the list", () => {
  // The live shape from list 65eac724: `adobo sauce` has a component parent in
  // more than one synonym cluster, the index walks parents alphabetically, and
  // the alphabetically-first parent was not on the list. The dish asked for
  // `chipotle peppers in adobo sauce`; the pool appended `chipotle chile in
  // adobo` beside it. Two cans for one 1 tbsp of sauce.
  const A = "chipotle chile in adobo"; // alphabetically first
  const B = "chipotle peppers in adobo sauce"; // what the dish asked for
  const rows: RelationRow[] = [
    comp(A, "adobo sauce", 1, "tbsp", true),
    comp(B, "adobo sauce", 1, "tbsp", true),
  ];

  it("tops up the parent that is on the list and appends nothing", () => {
    const idx = buildRelationIndex(rows);
    // Precondition the test depends on: the index really does hand A first.
    assert.deepEqual(
      idx.componentParents.map((p) => p.parent),
      [A, B],
    );
    const out = poolComponentNeeds(
      [item(B, 2, "each"), item("adobo sauce", 1, "tablespoon")],
      idx,
    );
    // Asserted on the ROWS: one row, it is B, and it carries the top-up.
    assert.equal(out.items.length, 1, "the sauce must fold into B, not append A");
    assert.equal(out.items[0].canonicalName, B);
    assert.equal(out.items[0].quantity, 3, "2 peppers wanted whole + 1 for the tbsp of sauce");
    assert.equal(out.items.some((i) => i.canonicalName === A), false, "A was appended");
    assert.equal(out.folds.length, 1);
    assert.equal(out.folds[0].parent, B);
    assert.equal(out.folds[0].toppedUpExisting, true);
  });

  it("falls back to the index order when neither parent is on the list", () => {
    const idx = buildRelationIndex(rows);
    const out = poolComponentNeeds([item("adobo sauce", 1, "tablespoon")], idx);
    // Today's behaviour, unchanged: the alphabetically-first parent is appended.
    assert.equal(out.items.length, 1);
    assert.equal(out.items[0].canonicalName, A);
    assert.equal(out.items[0].quantity, 1);
    assert.equal(out.folds.length, 1);
    assert.equal(out.folds[0].toppedUpExisting, false);
  });
});
