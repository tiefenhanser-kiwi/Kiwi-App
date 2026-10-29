// QA-COOK-1 — patterns, not instances.
//
// Every finding (the simulator's K-flags and the AI cooks' issues) is mapped to
// one pattern of a fixed taxonomy, deterministically: a simulator finding by its
// signature, an AI issue by its type and words. A pattern then counts the MEALS
// it touches (a meal is its catalog id, across servings and prep), ranks by
// meals × severity, and keeps three example meals with the quote.
//
// Cause, per hit, from the session itself:
//   sequencer    the steps involved come from different dishes of a sequenced
//                meal, or the step sits where the Sequencer moved it (its dish
//                differs from the step before it) — the order is the app's;
//   recipe text  one dish, or a single-dish meal (naive order) — the order and
//                words are the recipe's.
// The pattern's own entry says what the fix is; the split says where the hits
// actually came from.
import { KNIFE } from "./lexicon";
import type { CookView, KFinding, PersonaIssue, PersonaRun, Severity } from "./types";

export type Cause = "sequencer" | "recipe text";

export interface PatternDef {
  id: string;
  title: string;
  /** The fix's home. */
  cause: Cause | "both";
  /** The sequencer (or content) rule this pattern asks for. */
  rule: string;
}

export const PATTERNS: PatternDef[] = [
  { id: "P1", title: "A warm bread or tortilla is finished early and held", cause: "sequencer",
    rule: "Finish-align bread: a dish whose title or steps warm/toast a bread (tortilla, pita, naan, toast, garlic bread, rolls) is a SERVE-TIME dish — schedule its warm step to end at serve (≤3 min before), never into an early passive window, and keep its own wrap/keep-warm step adjacent to it." },
  { id: "P2", title: "A knife or board task interrupts a pan that can't be left", cause: "both",
    rule: "No board work inside live pan work: after a stove step whose prose is constant/frequent (sear, shimmering oil, one at a time, stirring) and that does not take the food off the heat, the next step must be on that pan (or take it off the heat). Move the knife/prep step before the pan goes on, or into a passive window; the generator should write 'Meanwhile' only for passive windows." },
  { id: "P3", title: "The Sequencer overlaps a step it thinks is hands-free but the text needs the cook", cause: "sequencer",
    rule: "isUnattended must read the prose, not just phase+isTimingSensitive: a cook step with 'one at a time', 'in batches', 'per side', 'stirring constantly', 'sear', 'flip', 'until shimmering' is ATTENDED. (Or re-stamp isTimingSensitive on those steps — the catalog fix.)" },
  { id: "P4", title: "A hot dish is finished early and waits with nothing keeping it warm", cause: "sequencer",
    rule: "Finish-align hot dishes to serve (the latest finish), and when a dish must finish early, emit its keep-warm step (KEEP_WARM_TEXT / OVEN_OFF_TEXT) right after its last heat step — not later in the flow." },
  { id: "P5", title: "The keep-warm step comes long after the food came off the heat", cause: "sequencer",
    rule: "A dish's hold/keep-warm step rides immediately after its last heat step (same dish, sequence-adjacent); it is never parked in another dish's window." },
  { id: "P6", title: "A cold component (avocado, dressed greens) is made long before serving", cause: "sequencer",
    rule: "Served-cold dishes that brown or wilt (avocado, guacamole, dressed greens) are pulled forward only to dress/cut-at-the-end: split 'make' from 'dress/cut' and align the second to serve, or add a cover-and-chill step." },
  { id: "P7", title: "The cook stands idle in a long wait while prep could be done", cause: "sequencer",
    rule: "Fill passive windows ≥10 min with the earliest independent prep step from any dish (already done for served-cold dishes; extend to every knife/prep step that uses nothing in progress)." },
  { id: "P8", title: "The oven is needed at two temperatures at once", cause: "sequencer", rule: "One oven, one temperature: serialize oven steps whose temperatures differ by >25°F, or rewrite one to the other's temperature with a time change." },
  { id: "P9", title: "Burners, skillets or 'the same pan' are double-booked", cause: "sequencer", rule: "Track vessels: a step that names 'the same skillet' (or a dish's only skillet) cannot start while another dish's step holds it; cap concurrent stove vessels at 4 and skillets at 2." },
  { id: "P10", title: "A step uses something not made yet, or never made", cause: "both", rule: "A step that uses another dish's food starts after that dish is done (dishUses) — and a recipe that says 'the X you made' must have a step that makes X (generator check)." },
  { id: "P11", title: "Something set aside is never picked up again", cause: "recipe text", rule: "Content check: every 'set aside / transfer to a plate / reserve' object must be named again by a later step of the meal." },
  { id: "P12", title: "A cue says a dish is doing something it isn't", cause: "sequencer", rule: "Cue wording from the window step's own state: 'resting' only for a rest after heat; a marinade is 'marinating', a raw dish is not 'resting'; a dish already finished is not 'cooking'." },
  { id: "P13", title: "Raw protein left out at room temperature", cause: "recipe text", rule: "Content: a marinade or brine over ~10 min says 'in the fridge'." },
  { id: "P14", title: "A step names a chopped/sliced food no step prepared", cause: "recipe text", rule: "Content: every 'chopped X' used in a step needs a step (or prep) that chops X, or the ingredient line says it." },
  { id: "P15", title: "A step is fragile to a short interruption and gives no warning", cause: "recipe text", rule: "Content: steps that cannot be left (shimmering oil, one at a time, caramel, garlic) say 'don't walk away' or have everything at hand first." },
  { id: "P16", title: "Food overcooks or dries out because of the flow", cause: "both", rule: "See P2/P4: what's cooked must leave the heat (or be held correctly) before the next unrelated step." },
  { id: "P17", title: "The order makes no sense to the cook", cause: "both", rule: "Review case by case." },
  { id: "P18", title: "Unclear wording or amounts", cause: "recipe text", rule: "Content pass (including scaled-amount grammar: '1 limes', '1 chipotle chiles')." },
  { id: "P19", title: "Kitchen can't do it as written (equipment)", cause: "recipe text", rule: "Content: name a fallback for single-skillet / 2-burner kitchens when a step needs two pans at once." },
  { id: "P0", title: "Other", cause: "both", rule: "—" },
];

const BREAD = /\b(tortillas?|flatbreads?|naan|pitas?|bread|toast|crostini|garlic bread|rolls?|buns?|biscuits?|focaccia|chapatis?|rotis?|arepas?|baguette|ciabatta|cornbread)\b/i;

export function patternOfFinding(f: KFinding): string {
  const s = f.signature;
  if (/^K1:(held-uncovered|keep-warm-late):bread/.test(s) || /^K2:.*:bread$/.test(s)) return "P1";
  if (s.startsWith("K3:")) return "P2";
  if (s.startsWith("K2:")) return "P3";
  if (s.startsWith("K1:held-uncovered")) return "P4";
  if (s.startsWith("K1:keep-warm-late")) return "P5";
  if (s.startsWith("K1:cold-held")) return "P6";
  if (s.startsWith("K5:")) return "P7";
  if (s.startsWith("K4:oven")) return "P8";
  if (s.startsWith("K4:")) return "P9";
  if (s.startsWith("K6:")) return "P10";
  if (s.startsWith("K7:")) return "P11";
  return "P0";
}

export function patternOfIssue(i: PersonaIssue, persona: string): string {
  const t = `${i.quote} ${i.whatWentWrong}`.toLowerCase();
  const what = i.whatWentWrong.toLowerCase();
  if (BREAD.test(t) && !/bread ?crumbs?/.test(t) && (i.type === "held-too-long" || /\b(cold|stiff|cool|cooling|sat|sitting|early|too soon|keep (?:them |it )?warm|wrap|dried|dry|hard)\b/.test(what))) return "P1";
  if (/\btip\b|\bcue\b/.test(t) && /\b(says?|wrong|misleading|isn't|is not|not actually|hasn't|but)\b/.test(what) && /\b(resting|cooking|rest|marinat|simmer|bak)/.test(what)) return "P12";
  if (i.type === "two-at-once" || (KNIFE.test(what) && /\b(pan|skillet|heat|stove|burn|burning|oil|wok)\b/.test(what) && /\b(while|same time|unattended|behind|leave|left)\b/.test(what))) return "P2";
  if (persona === "interrupted" && /\b(called away|2 minutes|two minutes|interrupt|without me|while i was away|unattended)\b/.test(what)) return "P15";
  if (/\b(room temperature|food safety|food-safety|on the counter)\b/.test(what) && /\b(raw|chicken|meat|pork|beef|fish|shrimp|marinat)/.test(t)) return "P13";
  if (i.type === "held-too-long") return /\b(salad|avocado|guacamole|greens|dressed|wilt)/.test(t) ? "P6" : "P4";
  if (/\b(idle|standing around|nothing to do|wasted|could have (?:done|started|been)|just waiting)\b/.test(what)) return "P7";
  if (/\boven\b/.test(t) && /(°|degrees|temperature|two temp|different temp)/.test(what)) return "P8";
  if (i.type === "equipment" || i.type === "impossible") return /\b(burner|skillet|pan|pot|sheet)\b/.test(what) && /\b(only|one|both|busy|occupied|in use|another|second|still)\b/.test(what) ? "P9" : "P19";
  if (i.type === "missing") return /\b(chopped|sliced|minced|diced|grated|zest|torn|shredded|cut)\b/.test(t) && /\b(no step|never|nothing told|wasn't told|not told)\b/.test(what) ? "P14" : "P10";
  if (i.type === "bad-for-food") return /\b(overcook|burn|scorch|dry|dried|tough|mushy|soggy|char)\w*/.test(what) ? "P16" : "P17";
  if (i.type === "order") return "P17";
  if (i.type === "unclear") return "P18";
  return "P0";
}

const RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export interface Hit {
  pattern: string;
  source: "sim" | "persona";
  who: string;
  meal: string;
  mealId: string;
  servings: number;
  prepped: boolean;
  steps: number[];
  quote: string;
  detail: string;
  severity: Severity;
  cause: Cause;
  rewrite?: string;
  signature?: string;
}

function causeOf(v: CookView, steps: number[]): Cause {
  if (!v.multiDish) return "recipe text";
  const ss = steps.map((n) => v.steps[n - 1]).filter(Boolean);
  if (new Set(ss.map((s) => s.dishId)).size > 1) return "sequencer";
  // One step: where the Sequencer put it — its dish differs from the step before it.
  const s = ss[0];
  const prev = s ? v.steps[s.n - 2] : undefined;
  return s && prev && prev.dishId !== s.dishId ? "sequencer" : "recipe text";
}

const viewKey = (x: { sourceMealId: string; servings: number; prepped: boolean }) => `${x.sourceMealId}|${x.servings}|${x.prepped}`;

export function collectHits(sims: { view: CookView; findings: KFinding[] }[], runs: PersonaRun[], views: CookView[]): Hit[] {
  const hits: Hit[] = [];
  const byKey = new Map(views.map((v) => [viewKey(v), v]));
  for (const { view: v, findings } of sims) {
    for (const f of findings) {
      hits.push({ pattern: patternOfFinding(f), source: "sim", who: f.flag, meal: v.title, mealId: v.sourceMealId, servings: v.servings, prepped: v.prepped, steps: f.steps, quote: f.quote, detail: f.detail, severity: f.severity, cause: causeOf(v, f.steps), signature: f.signature });
    }
  }
  for (const r of runs) {
    const v = byKey.get(viewKey(r.view));
    if (!v) continue;
    for (const i of r.issues) {
      const step = Math.min(Math.max(1, i.step || 1), v.steps.length);
      hits.push({ pattern: patternOfIssue(i, r.persona), source: "persona", who: `${r.persona}/${r.model.replace("claude-", "")}`, meal: v.title, mealId: v.sourceMealId, servings: v.servings, prepped: v.prepped, steps: [step], quote: i.quote, detail: i.whatWentWrong, severity: i.severity, cause: causeOf(v, [step]), rewrite: i.suggestedRewrite });
    }
  }
  return hits;
}

export interface PatternRow {
  def: PatternDef;
  /**
   * Meals where the pattern is CORROBORATED: the simulator flags it, or at least
   * two of the three cooks report it at the same step (±1) of the same session.
   * One cook alone is not enough: a cook that lacks a Dutch oven reports every
   * later step as "never made", and those cascades are its kitchen, not the app.
   */
  meals: number;
  /** Every meal any source touched, corroborated or not. */
  mealsRaw: number;
  mealsBySim: number;
  mealsByPersona: number;
  hits: number;
  /** Σ over meals of the worst severity there (high 3, medium 2, low 1). */
  score: number;
  worst: Severity;
  cause: Record<Cause, number>;
  examples: Hit[];
  /** Signatures (sim) and personas that reported it. */
  sources: Record<string, number>;
}

/** A simulator hit stands alone; a cook's needs a second cook at the same step (±1) of the same session. */
export function corroborated(h: Hit, samePattern: Hit[]): boolean {
  if (h.source === "sim") return true;
  const persona = h.who.split("/")[0];
  return samePattern.some((o) => o.source === "persona" && o.who.split("/")[0] !== persona && o.mealId === h.mealId && o.servings === h.servings && o.prepped === h.prepped && Math.abs(o.steps[0] - h.steps[0]) <= 1);
}

export function rankPatterns(hits: Hit[]): PatternRow[] {
  const rows: PatternRow[] = [];
  for (const def of PATTERNS) {
    const all = hits.filter((h) => h.pattern === def.id);
    if (all.length === 0) continue;
    const hs = all.filter((h) => corroborated(h, all));
    const worstByMeal = new Map<string, Severity>();
    for (const h of hs) {
      const w = worstByMeal.get(h.mealId);
      if (!w || RANK[h.severity] > RANK[w]) worstByMeal.set(h.mealId, h.severity);
    }
    const score = [...worstByMeal.values()].reduce((n, s) => n + RANK[s], 0);
    const worst = [...worstByMeal.values()].sort((a, b) => RANK[b] - RANK[a])[0];
    const cause = { sequencer: 0, "recipe text": 0 } as Record<Cause, number>;
    for (const h of hs) cause[h.cause]++;
    const sources: Record<string, number> = {};
    for (const h of hs) sources[h.source === "sim" ? h.signature!.split(":").slice(0, 2).join(":") : h.who.split("/")[0]] = (sources[h.source === "sim" ? h.signature!.split(":").slice(0, 2).join(":") : h.who.split("/")[0]] ?? 0) + 1;
    // Three example MEALS: the worst hit of each, sim first when it has one (its quote is the step itself).
    const examples: Hit[] = [];
    const ordered = [...hs].sort((a, b) => RANK[b.severity] - RANK[a.severity] || (a.source === "sim" ? -1 : 1) - (b.source === "sim" ? -1 : 1));
    for (const h of ordered) {
      if (examples.length >= 3) break;
      if (!examples.some((e) => e.mealId === h.mealId)) examples.push(h);
    }
    if (hs.length === 0) continue;
    rows.push({
      def, meals: worstByMeal.size, mealsRaw: new Set(all.map((h) => h.mealId)).size,
      mealsBySim: new Set(hs.filter((h) => h.source === "sim").map((h) => h.mealId)).size,
      mealsByPersona: new Set(hs.filter((h) => h.source === "persona").map((h) => h.mealId)).size,
      hits: hs.length, score, worst, cause, examples, sources,
    });
  }
  return rows.sort((a, b) => b.score - a.score || b.meals - a.meals);
}
