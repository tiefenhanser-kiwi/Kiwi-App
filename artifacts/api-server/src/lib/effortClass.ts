// WS9 D-WS9-242 — the EFFORT CLASS of a swappable component, derived from the
// phase tags already on its scratch-path steps. $0: no model call, a pure
// function over persisted rows.
//
// Hans (September 15): "THE DEFAULT PATH OF A COMPONENT = f(the user's level,
// the component's EFFORT CLASS). Classes assembly / cooking / craft, derived
// from the phase tags already on the scratch-path steps and stamped once per
// component into componentRegistry by a $0 derivation pass."
//
//   assembly — mix, measure, cut, shred work: dressings, spice blends, slaw,
//              guacamole, marinades. Every scratch step is prep-type, OR the
//              only heat on the path is a ≤2-minute stir-in (see below).
//   cooking  — the scratch path carries REAL heat: ≥ HEAT_MIN_MINUTES of
//              cook / preheat / hold time (caramelized onions, simmered sauce,
//              stock, beans from dry, oven fries, croutons).
//   craft    — a staple a home cook buys, MADE here: dough-craft work in the
//              scratch text (knead / rise / proof / roll out the dough / pasta
//              sheets / tortilla press / cut butter into) or a strict staple
//              name (dough, crust, pastry, wrappers, masa, gnocchi, ravioli,
//              pierogi, dumplings — not "tortilla", which also names fried
//              strips; a pressed tortilla is caught by its text), on a path that has heat or a
//              rest. Shaping alone (form patties, roll meatballs) and boiling
//              dried pasta are NOT craft — the boundary carries vocabulary, not
//              a default (levels 2 and 3 buy both), so ambiguity → cooking.
//
// Two refinements of the ruling's literal words, made against the data on the
// September 15 dry run (scripts/output/ws9-242/probe_rest.txt), both reported:
//   • `rest` alone is NOT cooking. All 11 rest-only components were dressings,
//     tzatziki, olive salad and a buttermilk marinade chilling in the fridge —
//     the ruling's own assembly examples. A rest still counts toward craft
//     (a dough that rises).
//   • a heat phase of ≤ 2 minutes is NOT cooking. All 79 such components were
//     "stir in the spice blend / dried herbs / the can of tomatoes / the
//     broth" steps tagged `cook` because they happen in the pot — spice blends
//     by the ruling's own list. None was a simmered, caramelized, roasted or
//     braised sub-recipe.
//
// The grid the class feeds (D-WS9-242): level 1 → scratch for all three ·
// level 2 → scratch for assembly, bought for cooking and craft · level 3 →
// bought wherever a bought path exists. Nothing here reads the level.
//
// The stamp lives on the registry entry: `effortClass` + `effortClassSource`
// ("derived-v1"). key/label/order are untouched; so is every step and every
// stored time — the class does not move the stored default path.

export type EffortClass = "assembly" | "cooking" | "craft";
export const EFFORT_CLASS_SOURCE = "derived-v1";

export type StepPhaseName = "prep" | "cook" | "rest" | "preheat" | "assemble" | "hold";

/**
 * The explicit phase → kind map. `prep` and `assemble` are hands-on, no-heat
 * work; `cook`, `preheat`, `hold` apply or keep heat; `rest` is passive time
 * (a proof, a chill, a marinade that sits) — never cooking on its own, but a
 * craft signal when the component is a staple.
 */
export const PHASE_KIND: Record<StepPhaseName, "prep" | "heat" | "rest"> = {
  prep: "prep",
  assemble: "prep",
  cook: "heat",
  preheat: "heat",
  hold: "heat",
  rest: "rest",
};

/** Heat-phase minutes on the scratch path at or above which a component is cooking. */
export const HEAT_MIN_MINUTES = 3;

/** Strict staple names (registry key or label) a home cook buys and this path MAKES. */
export const CRAFT_STAPLES = /\b(dough|crust|pastry|wrappers?|masa|gnocchi|ravioli|pierogi|dumplings?)\b/i;

/** Scratch-step text that is dough-craft work (not mere shaping). */
export const CRAFT_TEXT =
  /\b(knead|let (the )?dough (rise|rest|proof)|let (it|them) rise|proof(ing)? (the )?dough|(rapid-rise|instant|active dry) yeast|roll (out )?(the )?(dough|pasta|sheets?)|pasta (machine|roller|sheets?)|tortilla press|pie (dough|crust)|(cut|work|rub) (the )?(cold |chilled )?butter into)\b/i;

export interface ScratchStepLike {
  phaseType: StepPhaseName;
  estimatedMinutes: number;
  text: string;
}

export interface EffortClassResult {
  effortClass: EffortClass;
  /** Σ estimatedMinutes over cook / preheat / hold steps on the scratch path */
  heatMinutes: number;
  /** distinct heat/rest phases seen (empty when every step is prep-type) */
  cookPhases: StepPhaseName[];
  /** what made it craft (empty for assembly / cooking) */
  craftBy: ("name" | "text")[];
}

/**
 * Classify one component from its SCRATCH-path steps (the steps the bought
 * path replaces). Pure; throws on an empty scratch path — an unresolvable
 * component is the caller's finding, not a class.
 */
export function classifyEffort(
  component: { key: string; label?: string | null },
  scratchSteps: ScratchStepLike[],
): EffortClassResult {
  if (scratchSteps.length === 0) {
    throw new Error(`classifyEffort: component "${component.key}" has no scratch-path steps`);
  }
  const cookPhases: StepPhaseName[] = [];
  let heatMinutes = 0;
  let hasRest = false;
  for (const s of scratchSteps) {
    const kind = PHASE_KIND[s.phaseType];
    if (kind === undefined) throw new Error(`classifyEffort: unknown phaseType "${String(s.phaseType)}"`);
    if (kind === "prep") continue;
    if (!cookPhases.includes(s.phaseType)) cookPhases.push(s.phaseType);
    if (kind === "heat") heatMinutes += s.estimatedMinutes;
    else hasRest = true;
  }
  const cooking = heatMinutes >= HEAT_MIN_MINUTES;

  const craftBy: ("name" | "text")[] = [];
  if (cooking || hasRest) {
    if (CRAFT_STAPLES.test(`${component.key} ${component.label ?? ""}`)) craftBy.push("name");
    if (scratchSteps.some((s) => CRAFT_TEXT.test(s.text))) craftBy.push("text");
  }
  const effortClass: EffortClass = craftBy.length > 0 ? "craft" : cooking ? "cooking" : "assembly";
  return { effortClass, heatMinutes, cookPhases, craftBy };
}
