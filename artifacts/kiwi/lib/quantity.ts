/**
 * Parse a quantity string supporting fractions and decimals.
 * Returns null for invalid input.
 * Examples: "1.5" → 1.5, "1/2" → 0.5, "1 1/2" → 1.5, "abc" → null
 *
 * Shared by meal-builder, dish-builder edit flows, and grocery-list
 * inline quantity editing — keeps the "what counts as a valid qty"
 * rule in one place.
 */
export function parseQuantity(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Plain decimal: "1.5", "0.25", "2"
  const decimal = Number(trimmed);
  if (!isNaN(decimal) && isFinite(decimal)) return decimal;

  // Mixed fraction: "1 1/2", "2 3/4"
  const mixedMatch = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) {
    const [, whole, num, den] = mixedMatch;
    const denN = Number(den);
    if (denN === 0) return null;
    return Number(whole) + Number(num) / denN;
  }

  // Pure fraction: "1/2", "3/4", "1/8"
  const fracMatch = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    const [, num, den] = fracMatch;
    const denN = Number(den);
    if (denN === 0) return null;
    return Number(num) / denN;
  }

  return null;
}
