// SERVER-13 E (BUG-633) — an amountRef bound to a same-named sibling row. Pure.
//
// Classic Beef Lo Mein's step 0 says "1 tablespoon soy sauce" and its ref was bound to
// the dish's "dark soy sauce" row: the soy sauce row (3 tbsp) is said 1 + 2 across
// steps 0 and 1, and the dark soy (1 tbsp) once, in step 1. Read off the words: the
// food a ref's amount names is the longest row name in the phrase after it (up to the
// next comma, semicolon, colon, full stop, "and", "plus", "or", "then"); a ref is
// misbound when that row is not its own and the two names are one family. A
// candidate is CONFIRMED only when the amounts agree: the bound row's refs say more
// than the row holds, and moving this ref to the named row keeps that row within
// what it holds. Anything else is reported, never changed.

export interface RefLike { ingredientId: string; charStart: number; charEnd: number; quantity?: number; unit?: string }
export interface RowLike { ingredientId: string; name: string; quantity?: number; unit?: string }
export interface StepLike { stepIndex: number; text: string; amountRefs: readonly RefLike[] | null }
export interface Misbind { stepIndex: number; index: number; ref: RefLike; bound: string; named: string; from: string; to: string }

const norm = (s: string) => s.toLowerCase().split(/[,(]/)[0].replace(/[^a-z0-9à-ÿ' -]+/g, " ").replace(/\s+/g, " ").trim();
const esc = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The phrase holds the name as whole words, any word in its plural ("chipotle peppers in adobo sauce"). */
const holds = (hay: string, needle: string) => needle.length > 0 && new RegExp(`(?:^|\\s)${needle.split(" ").map((w) => `${esc(w)}(?:s|es)?`).join(" ")}(?:\\s|$)`).test(hay);
/**
 * One family: the same head noun, and one name is the other with modifiers in front
 * ("dark soy sauce" = dark + "soy sauce"). A food and what is made from it (lemon /
 * lemon juice, lime / lime leaves, garlic / chili garlic sauce) is not this shape.
 */
function oneFamily(a: string, b: string): boolean {
  const [long, short] = a.length >= b.length ? [a, b] : [b, a];
  return long !== short && long.endsWith(` ${short}`);
}

/** The phrase a ref's amount describes: the words after it, to the next clause break. */
export function refPhrase(text: string, ref: RefLike): string {
  const after = text.slice(ref.charEnd);
  const end = after.search(/[,;.:]|\s(?:and|plus|or|then)\s/);
  return norm(end < 0 ? after : after.slice(0, end));
}

/** One step's candidates: refs whose words name a sibling of their row's family. */
export function siblingMisbinds(step: StepLike, rows: readonly RowLike[]): Misbind[] {
  const out: Misbind[] = [];
  const names = rows.map((r) => ({ ...r, n: norm(r.name) })).filter((r) => r.n.length > 0);
  (step.amountRefs ?? []).forEach((ref, index) => {
    const bound = names.find((r) => r.ingredientId === ref.ingredientId);
    if (!bound) return;
    const phrase = refPhrase(step.text, ref);
    const named = names.filter((r) => holds(phrase, r.n)).sort((a, b) => b.n.length - a.n.length)[0];
    if (!named || named.ingredientId === bound.ingredientId) return;
    if (holds(phrase, bound.n) && bound.n.length >= named.n.length) return;
    if (!oneFamily(bound.n, named.n)) return;
    out.push({ stepIndex: step.stepIndex, index, ref, bound: bound.name, named: named.name, from: bound.ingredientId, to: named.ingredientId });
  });
  return out;
}

const unitKey = (u: string | undefined) => (u ?? "").toLowerCase().trim().replace(/e?s$/, "");

/** A dish's candidates, split by whether the rows' amounts confirm them. */
export function dishMisbinds(steps: readonly StepLike[], rows: readonly RowLike[]): { confirmed: Misbind[]; unconfirmed: Misbind[] } {
  const candidates = steps.flatMap((s) => siblingMisbinds(s, rows));
  // What the row's refs say in the row's own unit. A ref in another unit cannot be
  // summed and is left out (Szechuan Beef's "½ cup store-bought Szechuan sauce", a
  // bought path's ref on its soy row); the row is comparable when any ref counts.
  const said = (id: string) => {
    const row = rows.find((r) => r.ingredientId === id);
    let total = 0;
    let counted = 0;
    for (const s of steps) for (const r of s.amountRefs ?? []) {
      if (r.ingredientId !== id || unitKey(r.unit) !== unitKey(row?.unit) || typeof r.quantity !== "number") continue;
      total += r.quantity;
      counted++;
    }
    return { total, comparable: counted > 0, holds: row?.quantity };
  };
  const confirmed: Misbind[] = [];
  const unconfirmed: Misbind[] = [];
  for (const m of candidates) {
    const from = said(m.from);
    const to = said(m.to);
    const q = m.ref.quantity ?? NaN;
    const ok =
      from.comparable && from.holds !== undefined && to.holds !== undefined &&
      unitKey(m.ref.unit) === unitKey(rows.find((r) => r.ingredientId === m.to)?.unit) &&
      from.total > from.holds + 1e-9 && to.total + q <= to.holds + 1e-9;
    (ok ? confirmed : unconfirmed).push(m);
  }
  return { confirmed, unconfirmed };
}

/** The step's refs with each confirmed misbind moved to its named row; nothing else changes. */
export function rebind(refs: readonly RefLike[], fixes: readonly Misbind[]): RefLike[] {
  return refs.map((r, i) => {
    const f = fixes.find((x) => x.index === i);
    return f ? { ...r, ingredientId: f.to } : r;
  });
}
