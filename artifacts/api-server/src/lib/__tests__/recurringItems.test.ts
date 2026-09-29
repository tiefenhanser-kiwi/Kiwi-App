// [grocery] B3 · Part D (D-WS9-284) — the recurring resolver and R3's branches.
//
// The census measured the defect these pin: 0 of 96 recurring rows across 20
// lists carried a plan source, because the match was an exact name equality
// against catalog canonicals and there is no catalog row called `milk`.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { PrismaClient } from "@prisma/client";

import {
  RECURRING_GRADE_MAP,
  matchResolution,
  recurringComparable,
  recurringFacetsFor,
  resolveRecurringItems,
} from "../recurringItems";
import { inferCategory } from "../ingredientResolve";
import { lookupPurchaseDefault } from "../ingredientConversions";

// ── a catalog, as small as the assertions need ──────────────────────────────

interface Row {
  id: string;
  canonicalName: string;
  displayName: string;
  category: string;
  purchaseUnit?: string | null;
  purchaseQuantity?: number | null;
  purchaseDisplay?: string | null;
}

const CATALOG: Row[] = [
  { id: "ing-whole-milk", canonicalName: "whole milk", displayName: "whole milk", category: "Dairy", purchaseUnit: "bottle", purchaseQuantity: 1, purchaseDisplay: "1 bottle (1 quart / 32 oz)" },
  { id: "ing-large-eggs", canonicalName: "large eggs", displayName: "large eggs", category: "Dairy", purchaseUnit: "dozen", purchaseQuantity: 1, purchaseDisplay: "1 dozen" },
  { id: "ing-egg", canonicalName: "egg", displayName: "egg", category: "Dairy", purchaseUnit: "dozen", purchaseQuantity: 1, purchaseDisplay: "1 dozen" },
  { id: "ing-lemon", canonicalName: "lemon", displayName: "lemon", category: "Produce", purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 lemons" },
  { id: "ing-lime", canonicalName: "lime", displayName: "lime", category: "Produce", purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 limes" },
  { id: "ing-bananas", canonicalName: "bananas", displayName: "bananas", category: "Produce", purchaseUnit: "each", purchaseQuantity: 1, purchaseDisplay: "1 banana" },
  { id: "ing-sandwich-bread", canonicalName: "sandwich bread", displayName: "sandwich bread", category: "Bakery", purchaseUnit: "loaf", purchaseQuantity: 1, purchaseDisplay: "1 loaf (20 oz, 22 slices)" },
];

// The live alias table's shape, including the contradiction D-WS9-284 ruling 4
// works around: `egg` is an alias on `large eggs` AND a canonical row of its own,
// and `eggs` is an alias on the MINORITY row.
const ALIASES: Record<string, string> = {
  milk: "whole milk",
  bread: "sandwich bread",
  lemons: "lemon",
  limes: "lime",
  egg: "large eggs",
  eggs: "egg",
};

function makeDb(): PrismaClient {
  const byName = new Map(CATALOG.map((r) => [r.canonicalName, r]));
  const byId = new Map(CATALOG.map((r) => [r.id, r]));
  return {
    ingredient: {
      findMany: async (args: {
        where?: { canonicalName?: { in: string[] }; id?: { in: string[] } };
      }) => {
        const names = args?.where?.canonicalName?.in;
        const ids = args?.where?.id?.in;
        const rows = names
          ? names.map((n) => byName.get(n))
          : (ids ?? []).map((i) => byId.get(i));
        return rows.filter((r): r is Row => !!r).map((r) => ({ ...r }));
      },
    },
    ingredientAlias: {
      findMany: async (args: { where: { aliasKey: { in: string[] } } }) =>
        args.where.aliasKey.in
          .map((aliasKey) => {
            const canonical = ALIASES[aliasKey];
            const row = canonical ? byName.get(canonical) : undefined;
            return row ? { aliasKey, ingredient: { id: row.id, canonicalName: row.canonicalName } } : null;
          })
          .filter((r): r is NonNullable<typeof r> => r !== null),
    },
  } as unknown as PrismaClient;
}

async function resolveOne(text: string) {
  const [r] = await resolveRecurringItems(makeDb(), [text]);
  return r;
}

// ────────────────────────────────────────────────────────────────────────────

describe("[grocery] B3 — the resolver reaches the plan's row", () => {
  it("free-text `milk` resolves to `whole milk` through the EXISTING alias index", async () => {
    const r = await resolveOne("Milk");
    assert.equal(r.canonicalName, "whole milk");
    assert.equal(r.ingredientId, "ing-whole-milk");
    assert.equal(r.matchedVia, "alias");
  });

  it("`bread` → `sandwich bread`, `lemons` → `lemon`, `limes` → `lime`", async () => {
    for (const [text, want] of [["bread", "sandwich bread"], ["Lemons", "lemon"], ["Limes", "lime"]] as const) {
      const r = await resolveOne(text);
      assert.equal(r.canonicalName, want, `${text} → ${want}`);
    }
  });

  it("a text naming no catalog food resolves to nothing, and nothing is created", async () => {
    const r = await resolveOne("Paper towels");
    assert.equal(r.ingredientId, null);
    assert.equal(r.canonicalName, null);
    assert.equal(r.matchedVia, null);
  });

  it("dedupes on the normalized text, order-stable on first appearance", async () => {
    const out = await resolveRecurringItems(makeDb(), ["Milk", "milk", "Lemons", "MILK"]);
    assert.deepEqual(out.map((r) => r.text), ["Milk", "Lemons"]);
  });
});

// ── D-WS9-284 ruling 4 — the grade map ──────────────────────────────────────

describe("[grocery] B3 — ruling 4: the recurring grade map", () => {
  it("recurring `eggs` resolves to `large eggs`, not to the 39-recipe `egg` row", async () => {
    const r = await resolveOne("Eggs");
    assert.equal(r.canonicalName, "large eggs");
    assert.equal(r.ingredientId, "ing-large-eggs");
    assert.equal(r.matchedVia, "grade");
  });

  it("recurring `egg` (singular) does too — canonical-beats-alias is overridden HERE only", async () => {
    // Without the map this lands on `egg`: the canonical row wins over the
    // `egg → large eggs` alias by the ruled precedence in ingredientLookup.
    const r = await resolveOne("Egg");
    assert.equal(r.canonicalName, "large eggs");
  });

  it("the map is TWO entries, and the admission test is D-WS9-228's both halves", () => {
    // A guard against the "standard size for everything" table this must not
    // become. Widening it is a ruling, not a refactor.
    assert.deepEqual(Object.keys(RECURRING_GRADE_MAP).sort(), ["egg", "eggs"]);
  });
});

// ── D-WS9-284 ruling 2 — the default quantity's precedence ──────────────────

describe("[grocery] B3 — ruling 2: the table first, then the row, then nothing", () => {
  it("bananas takes `1 bunch` from the TABLE, not `1 banana` from the catalog row", async () => {
    // D-WS9-221 makes the catalog row `1 each`: a recipe needing 2 bananas buys
    // 2. A person who "always gets bananas" means a bunch. Two questions.
    const r = await resolveOne("Bananas");
    assert.equal(r.canonicalName, "bananas");
    assert.deepEqual(r.purchase, lookupPurchaseDefault("bananas"));
    assert.equal(r.purchase!.purchaseDisplay, "1 bunch");
  });

  it("milk takes `1 gallon` from the table — Hans's words, not the quart the row sells", async () => {
    const r = await resolveOne("Milk");
    assert.equal(r.purchase!.purchaseDisplay, "1 gallon");
    assert.equal(r.purchase!.purchaseUnit, "gallon");
  });

  it("limes has no table entry, so it falls to the resolved row's pack", async () => {
    const r = await resolveOne("Limes");
    assert.equal(lookupPurchaseDefault("limes"), null, "the table really has no plural entry");
    assert.equal(r.purchase!.purchaseDisplay, "2 limes");
    assert.equal(r.purchase!.purchaseQuantity, 2);
  });

  it("a text both miss gets NO pack at all — step 3, and no AI call to invent one", async () => {
    const r = await resolveOne("dryer sheets");
    assert.equal(r.ingredientId, null);
    assert.equal(r.purchase, null);
  });

  it("the four hand-set entries are in the table and do not move", () => {
    assert.equal(lookupPurchaseDefault("paper towels")!.purchaseDisplay, "1 pack (6 rolls)");
    assert.equal(lookupPurchaseDefault("toilet paper")!.purchaseDisplay, "1 pack (12 rolls)");
    assert.equal(lookupPurchaseDefault("pet treats")!.purchaseDisplay, "1 bag");
    assert.equal(lookupPurchaseDefault("coffee")!.purchaseDisplay, "1 bag (1 lb)");
  });
});

// ── D-WS9-284 ruling 5 — household ──────────────────────────────────────────

describe("[grocery] B3 — ruling 5: household is a category, never a lookup failure", () => {
  it("coffee resolves to NO catalog row and is still a FOOD", async () => {
    const r = await resolveOne("Coffee");
    assert.equal(r.ingredientId, null, "no catalog row");
    assert.equal(r.household, false, "and still not household");
    assert.equal(r.category, "Pantry");
  });

  it("paper towels, toilet paper and the four pet phrases are household", async () => {
    for (const t of ["Paper towels", "Toilet paper", "pet treats", "dog food", "dog treats", "cat food", "cat litter"]) {
      const r = await resolveOne(t);
      assert.equal(r.household, true, `${t} is household`);
    }
  });

  it("the five food negatives stay food", () => {
    // `pet` is word-bounded, so "petite" and "trumpet" cannot reach it; `cat` is
    // not a keyword at all, only `cat food` / `cat litter`, so "catfish" is safe.
    for (const n of ["hot dogs", "hot dog buns", "catfish", "petite diced tomatoes", "trumpet mushrooms"]) {
      assert.notEqual(inferCategory(n), "Household", `${n} must stay food`);
    }
    for (const n of ["carpet", "trumpet", "crumpet"]) {
      assert.notEqual(inferCategory(n), "Household", `${n} must not trip the bare "pet" keyword`);
    }
  });
});

// ── R3's branch — D-WS9-188 ─────────────────────────────────────────────────

describe("[grocery] B3 — R3: comparable is not convertible", () => {
  it("the same count unit is comparable", () => {
    assert.equal(recurringComparable("each", "each"), true);
  });

  it("a PACK noun is not a count unit, so a head is never summed into a head", () => {
    // `isCountUnit` admits `each`/`whole`/`piece`/`ct` — the units that resolve
    // grams through gramsPerEach — and not `head`, `bunch` or `dozen`, which are
    // pack nouns. That narrowness is exactly right for R3: two lemons and three
    // lemons are five lemons, but "1 head of garlic, recurring" beside "3 cloves
    // for meals" is two different statements and belongs in display-both.
    assert.equal(recurringComparable("head", "head"), false);
    assert.equal(recurringComparable("bunch", "bunch"), false);
  });

  it("a gallon and a cup are NOT — they convert perfectly and Hans ruled them apart", () => {
    assert.equal(recurringComparable("gallon", "cup"), false);
    assert.equal(recurringComparable("bottle", "cup"), false);
  });

  it("dozen against each is NOT comparable either (ruling 4: sum only the same unit)", () => {
    assert.equal(recurringComparable("dozen", "each"), false);
  });

  it("two different count units are not comparable", () => {
    assert.equal(recurringComparable("bunch", "each"), false);
  });

  it("a missing unit on either side is not comparable", () => {
    assert.equal(recurringComparable(null, "each"), false);
    assert.equal(recurringComparable("each", ""), false);
  });
});

describe("[grocery] B3 — R3: the facets the client renders", () => {
  it("SAME UNIT: one summed line, and the split is recoverable", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Lemons"]);
    // The plan needed 5; the recurring pack adds 2; the row carries 7.
    const f = recurringFacetsFor(
      { ingredientId: "ing-lemon", canonicalName: "lemon", unit: "each", quantity: 7, hasPlanSources: true },
      res,
    )!;
    assert.equal(f.comparable, true);
    assert.equal(f.recurringQuantity, 2);
    assert.equal(f.mealQuantity, 5, "5 lemons — 2 recurring + 5 for meals");
    assert.equal(f.mealUnit, "each");
  });

  it("INCOMPARABLE: the recurring quantity is the purchase, the meal need rides beside it", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Milk"]);
    const f = recurringFacetsFor(
      { ingredientId: "ing-whole-milk", canonicalName: "whole milk", unit: "cup", quantity: 0.5, hasPlanSources: true },
      res,
    )!;
    assert.equal(f.comparable, false);
    assert.equal(f.recurringQuantity, 1);
    assert.equal(f.recurringUnit, "gallon");
    // ⛔ NOT subtracted, NOT summed, NOT converted. "1 gallon whole milk —
    // recurring; ½ cup for meals."
    assert.equal(f.mealQuantity, 0.5);
    assert.equal(f.mealUnit, "cup");
  });

  it("a recurring row with NO plan source has no meal quantity to show", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Paper towels"]);
    const f = recurringFacetsFor(
      { ingredientId: null, canonicalName: "paper towels", unit: "pack", quantity: 1, hasPlanSources: false },
      res,
    )!;
    assert.equal(f.mealQuantity, null);
    assert.equal(f.mealUnit, null);
    assert.equal(f.household, true);
  });

  it("recurring bananas sits beside a recipe's 2 rather than summing into it", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Bananas"]);
    const f = recurringFacetsFor(
      { ingredientId: "ing-bananas", canonicalName: "bananas", unit: "each", quantity: 2, hasPlanSources: true },
      res,
    )!;
    // bunch ≠ each, so display-both — "1 bunch bananas — recurring; 2 for meals".
    assert.equal(f.comparable, false);
    assert.equal(f.recurringUnit, "bunch");
    assert.equal(f.recurringQuantity, 1);
    assert.equal(f.mealQuantity, 2);
  });

  it("a recurring `1 dozen` against a recipe's `each` renders display-both, never converted", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Eggs"]);
    const f = recurringFacetsFor(
      { ingredientId: "ing-large-eggs", canonicalName: "large eggs", unit: "each", quantity: 3, hasPlanSources: true },
      res,
    )!;
    assert.equal(f.comparable, false);
    assert.equal(f.recurringUnit, "dozen");
    assert.equal(f.mealQuantity, 3, "the 3 the recipes wanted, not 3 minus a dozen");
  });

  it("a row no recurring text claims gets no facets at all", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Milk"]);
    assert.equal(
      recurringFacetsFor(
        { ingredientId: "ing-lemon", canonicalName: "lemon", unit: "each", quantity: 2, hasPlanSources: true },
        res,
      ),
      null,
    );
  });
});

describe("[grocery] B3 — matchResolution: identity first, then the name", () => {
  it("matches on ingredientId — the whole point of the block", async () => {
    const res = await resolveRecurringItems(makeDb(), ["Milk"]);
    const hit = matchResolution({ ingredientId: "ing-whole-milk", canonicalName: "anything at all" }, res);
    assert.equal(hit!.text, "Milk");
  });

  it("falls back to the normalized name, which is what a PRE-B3 list's synthetic carries", async () => {
    // D-WS9-230: nothing is backfilled. A list generated before this block holds
    // a row named `milk` with a null FK, and it still gets its facets.
    const res = await resolveRecurringItems(makeDb(), ["Milk"]);
    const hit = matchResolution({ ingredientId: null, canonicalName: "Milk" }, res);
    assert.equal(hit!.canonicalName, "whole milk");
  });
});

// ── [grocery] B4 · N11 — A POOLED NEED IS STILL A PLAN NEED ─────────────────
//
// The recurring pass runs BEFORE poolComponentNeeds (D-WS9-195's ordering, which
// stands), so a recurring item whose food is a POOLING PARENT finds no bucket to
// meet: it appends one, and pooling tops that row up without moving any sources
// onto it. On `56b03a57` and `c404a3cf` the plan demands `lime juice` and the row
// came out `lime 4 each` — 2 recurring plus 2 pooled — while `hasPlanSources`
// said the plan needed none of it.

describe("[grocery] B4 — N11: a comparable row infers the plan's share", () => {
  const RES = [
    {
      text: "Limes",
      norm: "limes",
      ingredientId: "ing-lime",
      canonicalName: "lime",
      displayName: "lime",
      category: "Produce",
      matchedVia: "alias" as const,
      purchase: { purchaseUnit: "each", purchaseQuantity: 2, purchaseDisplay: "2 limes" },
      household: false,
    },
  ];

  it("no sources, but more than the recurring pack: the excess IS the plan's", () => {
    const f = recurringFacetsFor(
      { ingredientId: "ing-lime", canonicalName: "lime", unit: "each", quantity: 4, hasPlanSources: false },
      RES,
    )!;
    assert.equal(f.comparable, true);
    assert.equal(f.recurringQuantity, 2);
    assert.equal(f.mealQuantity, 2, "4 limes — 2 recurring + 2 for meals");
  });

  it("no sources and exactly the recurring pack: the plan contributed nothing", () => {
    const f = recurringFacetsFor(
      { ingredientId: "ing-lime", canonicalName: "lime", unit: "each", quantity: 2, hasPlanSources: false },
      RES,
    )!;
    assert.equal(f.mealQuantity, null, "nothing above the pack means nothing from the plan");
  });

  it("sources present: unchanged — the arithmetic and the provenance agree", () => {
    const f = recurringFacetsFor(
      { ingredientId: "ing-lime", canonicalName: "lime", unit: "each", quantity: 7, hasPlanSources: true },
      RES,
    )!;
    assert.equal(f.mealQuantity, 5);
  });

  it("the INCOMPARABLE branch still keys on sources, because nothing can be inferred", () => {
    // An appended incomparable row's quantity IS the recurring quantity, so
    // there is no excess to read a plan need out of.
    const milk = [
      {
        text: "Milk", norm: "milk", ingredientId: "ing-milk", canonicalName: "whole milk",
        displayName: "whole milk", category: "Dairy", matchedVia: "alias" as const,
        purchase: { purchaseUnit: "gallon", purchaseQuantity: 1, purchaseDisplay: "1 gallon" },
        household: false,
      },
    ];
    const appended = recurringFacetsFor(
      { ingredientId: "ing-milk", canonicalName: "whole milk", unit: "gallon", quantity: 1, hasPlanSources: false },
      milk,
    )!;
    assert.equal(appended.mealQuantity, null);
    const met = recurringFacetsFor(
      { ingredientId: "ing-milk", canonicalName: "whole milk", unit: "cup", quantity: 0.5, hasPlanSources: true },
      milk,
    )!;
    assert.equal(met.comparable, false);
    assert.equal(met.mealQuantity, 0.5);
  });
});
