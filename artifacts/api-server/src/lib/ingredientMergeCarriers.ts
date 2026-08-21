// WS9 BUG-096 (D-WS9-174) — pure carrier detectors + rewriters.
//
// WHY THIS IS A MODULE AND NOT INLINE IN THE MERGE SCRIPT: three of the five
// id-carriers have NO foreign key. Nothing in Postgres will stop the merge from
// deleting a loser row that `amountRefs`, `PrepStepCompletion.stepKey` or
// `PrepWeekStructure.structureJson` still points at — they just orphan, in
// silence. The pre-delete verification gate is the ONLY thing standing between
// a missed carrier and silent data loss, so the per-carrier detectors have to
// be independently breakable: a gate that catches `amountRefs` and misses
// `structureJson` produces output identical to one that catches both.
//
// Every function here is pure — no Prisma, no I/O — so each carrier can be
// mutated on its own and the corresponding test watched go red.
//
// GroceryListItem's FK deserves its own note: it is ON DELETE **SET NULL**, not
// RESTRICT. It will not block a bad delete; it will quietly null the column.
// 80 of 1,292 rows are already null, so a fresh batch would blend straight into
// existing noise and never be noticed. Only DishIngredient (ON DELETE RESTRICT)
// is actually defended by the database.

/** One element of `RecipeInstructionStep.amountRefs`. */
type AmountRefLike = { ingredientId?: unknown };

// ── carrier 3: RecipeInstructionStep.amountRefs ─────────────────────────────

/** How many refs in this step point at one of `ids`. 0 = the step is clean. */
export function countAmountRefHits(amountRefs: unknown, ids: ReadonlySet<string>): number {
  if (!Array.isArray(amountRefs)) return 0;
  let n = 0;
  for (const ref of amountRefs) {
    const iid = (ref as AmountRefLike)?.ingredientId;
    if (typeof iid === "string" && ids.has(iid)) n++;
  }
  return n;
}

/**
 * Rewrite every loser ingredientId to its survivor, preserving each ref's other
 * fields (quantity / unit / charStart / charEnd) exactly. Returns null when
 * nothing changed, so the caller writes only the steps that actually move.
 */
export function rewriteAmountRefs(
  amountRefs: unknown,
  survivorByLoser: ReadonlyMap<string, string>,
): { refs: unknown[]; changed: number } | null {
  if (!Array.isArray(amountRefs)) return null;
  let changed = 0;
  const refs = amountRefs.map((ref) => {
    const o = ref as Record<string, unknown>;
    const iid = o?.ingredientId;
    if (typeof iid === "string" && survivorByLoser.has(iid)) {
      changed++;
      return { ...o, ingredientId: survivorByLoser.get(iid) };
    }
    return ref;
  });
  return changed > 0 ? { refs, changed } : null;
}

// ── carrier 4: PrepStepCompletion.stepKey ───────────────────────────────────
// `${phase}#${ingredientId}` for a normal step, `${phase}#dish#${dishId}` for a
// grouped one. Only the segment after the LAST '#' is an ingredient id, and a
// `#dish#` key must never be treated as one.

/** The ingredient id a stepKey refers to, or null for a `#dish#` grouped key. */
export function ingredientIdFromStepKey(stepKey: string): string | null {
  const idx = stepKey.lastIndexOf("#");
  if (idx < 0) return null;
  const head = stepKey.slice(0, idx);
  if (head.endsWith("#dish")) return null;
  const tail = stepKey.slice(idx + 1);
  return tail.length > 0 ? tail : null;
}

export function stepKeyTouches(stepKey: string, ids: ReadonlySet<string>): boolean {
  const id = ingredientIdFromStepKey(stepKey);
  return id !== null && ids.has(id);
}

/** null when this key does not reference a loser. */
export function rewriteStepKey(
  stepKey: string,
  survivorByLoser: ReadonlyMap<string, string>,
): string | null {
  const id = ingredientIdFromStepKey(stepKey);
  if (id === null) return null;
  const survivor = survivorByLoser.get(id);
  if (!survivor) return null;
  return `${stepKey.slice(0, stepKey.lastIndexOf("#"))}#${survivor}`;
}

// ── carrier 5: PrepWeekStructure.structureJson ──────────────────────────────
// Loser ids are embedded inside persisted `stepKey` strings in the blob. Ids
// are uuids, so a whole-blob string replace cannot collide with anything else.

export function countStructureJsonHits(structureJson: unknown, ids: ReadonlySet<string>): number {
  const blob = JSON.stringify(structureJson ?? {});
  let n = 0;
  for (const id of ids) n += blob.split(id).length - 1;
  return n;
}

export function rewriteStructureJson(
  structureJson: unknown,
  survivorByLoser: ReadonlyMap<string, string>,
): { json: unknown; hits: number } | null {
  let blob = JSON.stringify(structureJson ?? {});
  let hits = 0;
  for (const [loser, survivor] of survivorByLoser) {
    if (!blob.includes(loser)) continue;
    hits += blob.split(loser).length - 1;
    blob = blob.split(loser).join(survivor);
  }
  return hits > 0 ? { json: JSON.parse(blob), hits } : null;
}

// ── name carrier: Dish.substitutions ────────────────────────────────────────
// Shape: [{ product, quantity, unit, replaces: string[] }]. Only the NAME
// strings move; the validated shape is otherwise untouched (1,447 live rows).

export function countSubstitutionHits(substitutions: unknown, names: ReadonlySet<string>): number {
  if (!Array.isArray(substitutions)) return 0;
  let n = 0;
  for (const s of substitutions) {
    const o = s as Record<string, unknown>;
    for (const rp of Array.isArray(o?.replaces) ? o.replaces : []) {
      if (typeof rp === "string" && names.has(rp.toLowerCase().trim())) n++;
    }
    if (typeof o?.product === "string" && names.has(o.product.toLowerCase().trim())) n++;
  }
  return n;
}

export function rewriteSubstitutions(
  substitutions: unknown,
  survivorByLoserName: ReadonlyMap<string, string>,
): { json: unknown; hits: number } | null {
  if (!Array.isArray(substitutions)) return null;
  let hits = 0;
  const json = substitutions.map((s) => {
    const o = { ...(s as Record<string, unknown>) };
    if (Array.isArray(o.replaces)) {
      o.replaces = o.replaces.map((rp) => {
        if (typeof rp !== "string") return rp;
        const survivor = survivorByLoserName.get(rp.toLowerCase().trim());
        if (!survivor) return rp;
        hits++;
        return survivor;
      });
    }
    if (typeof o.product === "string") {
      const survivor = survivorByLoserName.get(o.product.toLowerCase().trim());
      if (survivor) { hits++; o.product = survivor; }
    }
    return o;
  });
  return hits > 0 ? { json, hits } : null;
}

// ── name carrier: MealPlanItem.recipeOverrideJson ───────────────────────────

export function countOverrideNameHits(overrideJson: unknown, names: ReadonlySet<string>): number {
  const o = overrideJson as Record<string, unknown> | null;
  if (!o || !Array.isArray(o.dishes)) return 0;
  let n = 0;
  for (const dish of o.dishes) {
    const dd = dish as Record<string, unknown>;
    for (const ing of Array.isArray(dd?.ingredients) ? dd.ingredients : []) {
      const name = (ing as Record<string, unknown>)?.name;
      if (typeof name === "string" && names.has(name.toLowerCase().trim())) n++;
    }
  }
  return n;
}

export function rewriteOverrideNames(
  overrideJson: unknown,
  displayByLoserName: ReadonlyMap<string, string>,
): { json: unknown; hits: number } | null {
  const o = overrideJson as Record<string, unknown> | null;
  if (!o || !Array.isArray(o.dishes)) return null;
  let hits = 0;
  const dishes = o.dishes.map((dish) => {
    const dd = { ...(dish as Record<string, unknown>) };
    if (Array.isArray(dd.ingredients)) {
      dd.ingredients = dd.ingredients.map((ing) => {
        const ii = { ...(ing as Record<string, unknown>) };
        if (typeof ii.name === "string") {
          const display = displayByLoserName.get(ii.name.toLowerCase().trim());
          if (display) { hits++; ii.name = display; }
        }
        return ii;
      });
    }
    return dd;
  });
  return hits > 0 ? { json: { ...o, dishes }, hits } : null;
}

// ── name carrier: UserPreferences.recurringGroceryItems ─────────────────────

/**
 * Preserves the user's capitalization pattern — "Eggs" becomes "Egg", not
 * "egg". This list is rendered verbatim in the preferences screen.
 */
export function rewriteRecurringItems(
  items: readonly string[],
  survivorByLoserName: ReadonlyMap<string, string>,
): { items: string[]; hits: number } | null {
  let hits = 0;
  const next = items.map((v) => {
    const survivor = survivorByLoserName.get(v.toLowerCase().trim());
    if (!survivor) return v;
    hits++;
    return /^[A-Z]/.test(v.trim())
      ? survivor.charAt(0).toUpperCase() + survivor.slice(1)
      : survivor;
  });
  return hits > 0 ? { items: next, hits } : null;
}
