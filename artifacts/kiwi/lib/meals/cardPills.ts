// WS9 Redesign Arc Block 2c Part F — BUG-284, the pill list a meal card
// renders and keys on.
//
// The Pick card showed [cuisineType, difficulty, ...tags] as pills keyed on
// the text. The catalog's AI-authored `tags` REPEAT the row's difficulty and a
// lower-cased copy of its cuisine (1,392 of 1,773 meals on Sept 16: tags
// ["american","medium"] beside cuisineType "American" / difficulty "medium"),
// so nearly every shelf logged React's "two children with the same key" —
// and rendered "American" next to "american", "medium" next to "medium".
//
// One rule for every card surface: case-insensitive de-dupe, FIRST WINS (the
// title-cased cuisine beats the lower-cased tag), blanks dropped. The pills
// are unique so the text IS a safe key — no index keys.

export interface CardPillSource {
  cuisineType?: string | null;
  difficulty?: string | null;
  tags?: readonly string[] | null;
}

export function cardPills(meal: CardPillSource): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [meal.cuisineType, meal.difficulty, ...(meal.tags ?? [])]) {
    const t = raw?.trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}
