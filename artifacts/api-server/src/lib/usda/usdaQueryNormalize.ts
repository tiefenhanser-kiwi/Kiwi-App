// D-WS9-050 Phase 3 — USDA RETRIEVAL-query normalizer (BUG-044).
//
// Runs BEFORE the FDC search to turn a recipe ingredient name into a query that
// surfaces the plain, generic SR-Legacy base food instead of letting
// brand/variety/prep tokens outrank it. Root cause it addresses: the shared
// sanitizeUsdaQuery (fdcClient.ts:184) only maps punctuation → space; it does
// NOT drop prep/variety tokens, so "yukon gold potatoes, cut into chunks"
// reached USDA nearly intact and the variety token outranked the base food,
// producing a genuine 0-result SR-Legacy response.
//
// LAYERED, NOT PATCHED: this module is additive. sanitizeUsdaQuery is UNCHANGED
// and still runs inside searchFoods() after this normalizer — so the shared
// USDA path (reactive enrichment + the ws7-8b backfill harness) is untouched.
// Callers who want normalization opt in by normalizing the name themselves
// before calling searchFoods (see ws9-macro-curate-judge.ts).
//
// RETRIEVAL ONLY. The AI judge always evaluates candidates against the FULL
// original ingredient name — nothing produced here is shown to the judge.
//
// ── The general rule (S1.2) ────────────────────────────────────────────────
// Qualifiers split into two macro classes for the four TRACKED macros
// (kcal / protein / carbs / fat):
//   • MACRO-NEUTRAL  → dropped from the query. Prep (chopped/diced/…), grade &
//     sourcing (store-bought/extra-virgin/fresh/baby), anatomical parts
//     (hearts/spears/florets/…), and SODIUM-only qualifiers (unsalted/salted/
//     low-sodium — sodium is not one of the four tracked macros; this is the
//     accepted "Butter, salted" trade in D-WS7-201). The judge still sees them.
//   • MACRO-RELEVANT → RETAINED in the tier-1 query because they select a
//     different USDA analytical record with a different macro profile for the
//     same base food: skin (skin-on/skinless), bone (bone-in/boneless — carried
//     alongside skin), and milk-fat level (whole-milk/part-skim/low-fat).
//     Retained qualifiers are dropped only when we fall back to the base noun.
//
// Base-noun extraction is POSITIONAL/general (peel qualifier & variety-adjective
// tokens, keep the remaining head-noun phrase). A SMALL exception map handles
// only the single-token varieties the positional rule cannot decompose
// (orzo/linguine/panko/…) — never the primary mechanism.

/** Strip diacritics so accented recipe spellings match ASCII USDA descriptions
 * ("jalapeño" → "jalapeno", "gruyère" → "gruyere"). Fully general — this alone
 * rescued the two accented 0-result misses in the prior run. */
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");
function deaccent(s: string): string {
  return s.normalize("NFD").replace(COMBINING_MARKS, "");
}

// Prep phrases (S1.1) — removed wherever they appear, including after a comma
// (the trailing ", <prep>" pattern). Multi-word phrases first so their pieces
// don't get orphaned.
const PREP_RE =
  /\bcut into [a-z0-9. -]*?(chunks?|cubes?|pieces?|wedges?|strips?|rounds?|coins?|matchsticks?|half-moons?|florets?)\b|\bpeeled and (sliced|diced|chopped|cubed)\b|\b(thinly|thickly) sliced\b|\b(finely|coarsely|roughly) (chopped|diced|minced|grated|shredded)\b|\b(chopped|minced|diced|shredded|sliced|grated|cubed|peeled|halved|quartered|julienned|deseeded|seeded|pitted|drained|rinsed|trimmed)\b/g;

// Macro-neutral qualifiers (S1.2) — dropped from the query, retained for the
// judge (which always sees the full original name). NB: "ground" is NOT here —
// "ground beef" selects a real USDA record; dropping it would lose the match.
const DROP_QUAL_RE =
  /\b(store[- ]?bought|homemade|extra[- ]?virgin|virgin|freshly ground|freshly|fresh|baby|hearts?|spears?|stalks?|florets?|leaves|leaf|fillets?|sprigs?|unsalted|salted|no[- ]?salt[- ]?added|low[- ]?sodium)\b/g;

// Macro-relevant qualifiers (S1.2) — KEPT in tier-1, stripped only at the
// base-noun tier. Skin/bone change fat; milk-fat level changes fat.
const RETAIN_QUAL_RE =
  /\b(bone[- ]?in|boneless|skin[- ]?on|skinless|whole[- ]?milk|part[- ]?skim|low[- ]?fat|non[- ]?fat|full[- ]?fat|reduced[- ]?fat)\b/g;

// Variety / brand adjectives (S1.3) — stripped ONLY at the base-noun tier so the
// remaining head noun surfaces the generic record. Small, documented exception
// set; the positional peel is the primary mechanism.
const VARIETY_RE =
  /\b(yukon|gold|roma|beefsteak|cherry|grape|plum|vine|heirloom|basmati|jasmine|arborio|long[- ]?grain|short[- ]?grain|cremini|crimini|dijon|kalamata|castelvetrano|sharp|mild|san marzano|fire[- ]?roasted)\b/g;

// Single-token varieties the positional rule cannot decompose (S1.3) → base
// food. Applied at tier-1 because each of these tokens returns 0 SR-Legacy on
// its own. This IS the sanctioned "small exception list where the rule fails".
// Pasta shapes are NOT here — they go through the general PASTA_SHAPE_RE rule.
const SINGLE_TOKEN_VARIETY: Record<string, string> = {
  panko: "", // drop — leaves the "bread crumbs" head noun
  brioche: "bread",
  parmigiano: "parmesan",
  "parmigiano-reggiano": "parmesan",
  pecorino: "romano",
  breadcrumbs: "bread crumbs", // USDA spells it two words
};

// R2 (P3-REBUILD-2) — GENERAL shape→pasta rule. USDA files EVERY dry pasta
// shape under one generic record ("Pasta, dry, enriched", 169736); the shape
// never changes the four tracked macros. So any recognized shape collapses to
// the base noun "pasta" — a closed-vocabulary CLASS rule, not a per-miss list.
// This subsumes the old orzo/linguine/rigatoni/… map entries and adds the
// shapes the scale run will surface (macaroni, penne, ziti, shells-as-pasta…).
// Guard: "spaghetti squash" is a vegetable, not pasta (handled at the call site).
const PASTA_SHAPE_RE =
  /\b(macaroni|elbows?|penne|rigatoni|fusilli|farfalle|bow[- ]?ties?|ziti|rotini|cavatappi|cavatelli|gemelli|orecchiette|campanelle|conchiglie|ditalini|linguine|fettuccine|tagliatelle|pappardelle|bucatini|spaghetti|vermicelli|capellini|angel hair|orzo|lasagn[ae])\b/i;

// R3 (P3-REBUILD-2) — GENERAL bun→rolls rule. USDA files hamburger/hot-dog/
// dinner buns under "Rolls" (e.g. 172796 "Rolls, hamburger or hotdog, plain"),
// NEVER under "Bread" — so a bread-mapped query ("bread burger buns") misses.
// Map "bun(s)" → the USDA head noun "rolls", carry the burger/hot-dog qualifier
// (it selects a distinct roll record), and drop bread-variety adjectives
// (brioche/potato/sesame/pretzel) that USDA roll records never carry.
const BUN_RE = /\bbuns?\b/i;
const BUN_BREAD_VARIETY_RE =
  /\b(brioche|potato|sesame|pretzel|whole[- ]?wheat|wheat|white|sourdough|multigrain)\b/gi;

// R1 (P3-REBUILD-2) — PANTRY DRY-GOODS form token. USDA files uncooked whole
// grains, rice, and pulses as "…, raw", but the bare head noun ("rice") collides
// with snack products (rice cakes/crackers/mixes) and never surfaces the grain.
// Appending the "raw" form token disambiguates. Scope is dry SEEDS/GRAINS/PULSES
// that HAVE a USDA raw state — NOT pasta (its base record is "dry"; the shape
// rule already wins without a token) and NOT milled flours (no raw state; a
// "raw" token would mismatch). "long-grain" stays a rice-specific VARIETY token
// (peeled at the base tier), NOT part of this general rule (R1.2 — no over-fit).
const PANTRY_RAW_DRY_GOOD_RE =
  /\b(rice|quinoa|couscous|bulgur|barley|farro|freekeh|millet|oats?|polenta|grits|cornmeal|lentils?|chickpeas?|garbanzos?|beans?|split peas?|black[- ]?eyed peas?)\b/i;

// USDA descriptions are "Food, qualifier, STATE". Nudge the query toward the raw
// / canned state the recipe implies (S1.4). Skipped when the name already names
// a cooked/processed state so we don't fight it.
const COOKED_STATE_RE =
  /\b(roasted|grilled|smoked|cooked|baked|fried|toasted|dried|braised|boiled|steamed|sauteed|sautéed|caramelized)\b/i;

// USDA has no "raw" state for oils / vinegars / sauces / broths / syrups /
// extracts — adding it pulls in raw produce and buries the fat/condiment record
// (e.g. a Produce-miscategorized "neutral oil" matched avocado oil literally but
// missed as "neutral oil raw"). Never a "raw" candidate for these classes.
const NON_RAW_FOOD_RE =
  /\b(oil|vinegar|sauce|broth|stock|syrup|extract|juice|milk|cream)\b/i;

function formToken(name: string, category: string | undefined): string {
  if (/\bcanned\b/i.test(name) || category === "Canned") return "canned";
  if (COOKED_STATE_RE.test(name)) return "";
  if (NON_RAW_FOOD_RE.test(name)) return ""; // oils/vinegars/broths/… never "raw"
  if (category === "Produce" || category === "Protein") return "raw";
  // R1 — Pantry dry seeds/grains/pulses carry a USDA "raw" state too.
  if (category === "Pantry" && PANTRY_RAW_DRY_GOOD_RE.test(name)) return "raw";
  return "";
}

// R2/R3 — wholesale CLASS overrides. When a pasta shape or a bun is present the
// entire name collapses to its USDA head noun; there is nothing further to peel
// (single tier). Returns null when neither class applies.
function classOverride(core: string): string | null {
  if (PASTA_SHAPE_RE.test(core) && !/\bsquash\b/i.test(core)) return "pasta";
  if (BUN_RE.test(core)) {
    const s = core.replace(BUN_BREAD_VARIETY_RE, " ");
    if (/\b(hamburger|burger|slider)s?\b/i.test(s)) return "rolls hamburger";
    if (/\bhot ?dogs?\b/i.test(s)) return "rolls hot dog";
    if (/\bdinner\b/i.test(s)) return "rolls dinner";
    return "rolls";
  }
  return null;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function applySingleTokenVariety(core: string): string {
  const out = core
    .split(" ")
    .map((t) => (t in SINGLE_TOKEN_VARIETY ? SINGLE_TOKEN_VARIETY[t] : t))
    .filter((t) => t.length > 0);
  return collapse(out.join(" "));
}

export interface NormalizedUsdaQuery {
  /** tier-1 query: prep + macro-neutral qualifiers stripped, variety &
   * macro-relevant qualifiers kept, form token appended. */
  normalized: string;
  /** tier-2 fallback: variety adjectives + macro-relevant qualifiers stripped,
   * leaving the head-noun phrase + form token. Equals `normalized` when there
   * was nothing further to strip (then only one tier is tried). */
  baseNoun: string;
  /** true when baseNoun is a strictly shorter fallback worth a second attempt. */
  hasFallback: boolean;
  /** macro-relevant qualifiers kept in tier-1 (reported so the trade is auditable). */
  retained: string[];
}

/**
 * Normalize an ingredient name into tiered USDA retrieval queries. Pure and
 * deterministic; no I/O. `category` (when known) only tweaks the form token.
 */
export function normalizeUsdaQuery(
  name: string,
  category?: string,
): NormalizedUsdaQuery {
  const form = formToken(name, category);
  const retained: string[] = [];

  // Working string: lowercase, deaccent, commas/slashes → spaces so prep
  // fragments and variety tokens tokenize cleanly (sanitizeUsdaQuery will also
  // do punctuation later, but we need clean tokens NOW for base-noun peeling).
  let core = deaccent(name.toLowerCase()).replace(/\([^)]*\)/g, " "); // drop "(such as …)" asides
  core = core.replace(/[/,]/g, " ");
  core = collapse(core.replace(PREP_RE, " "));
  core = collapse(core.replace(DROP_QUAL_RE, " "));

  const withForm = (q: string): string => {
    if (!form || new RegExp(`\\b${form}\\b`).test(q)) return q;
    return collapse(`${q} ${form}`);
  };

  // R2/R3 — a matched pasta shape or bun maps the whole name to its USDA head
  // noun; nothing further to peel, so both tiers are the same (single tier).
  const override = classOverride(core);
  if (override) {
    const q = withForm(override) || name;
    return { normalized: q, baseNoun: q, hasFallback: false, retained };
  }

  // Record (do not strip) macro-relevant qualifiers for the tier-1 audit.
  for (const m of core.matchAll(RETAIN_QUAL_RE)) retained.push(m[0]);

  const coreMapped = applySingleTokenVariety(core);

  const normalized = withForm(coreMapped) || name;

  // Base-noun tier: strip variety adjectives AND macro-relevant qualifiers.
  let base = collapse(coreMapped.replace(RETAIN_QUAL_RE, " "));
  base = collapse(base.replace(VARIETY_RE, " "));
  const baseNoun = withForm(base) || normalized;

  const hasFallback = baseNoun.length > 0 && baseNoun !== normalized;
  return { normalized, baseNoun, hasFallback, retained };
}
