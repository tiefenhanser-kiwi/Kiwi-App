// QA-COOK-1 — the shapes the cook simulator, the AI cooks and the pattern pass share.
//
// A CookView is ONE Cook Mode session exactly as the app shows it: the steps in
// the order the screen steps through them (app/cook-session.tsx: the Sequencer's
// order for a multi-dish meal, the flattened order otherwise), each step's text
// with its amounts scaled the way the screen scales them, the parallel cue, the
// "You prepped this" chips, and whether the step is folded as "Done in prep".
// capture.ts builds it from the real routes; the simulator and the personas read
// nothing else, so a hand-made CookView is a complete test fixture.

export type SampleCategory = "one-pan" | "stove+oven" | "multi-dish" | "bread" | "feast";

export interface ShownStep {
  /** 1-based position on the screen ("Step 3 of 14"). */
  n: number;
  /** dishId#stepIndex, or meal#i for meal-owned steps. */
  key: string;
  dishId?: string;
  stepIndex?: number;
  /** Set only on a multi-dish meal (the screen labels the dish). */
  dishTitle?: string;
  /** As rendered: amounts scaled to the servings. */
  text: string;
  phaseType: string;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
  parallelGroup?: string | null;
  /** The Sequencer's parallel cue ("While the chicken rests, …"). */
  cue?: string;
  /** Serve-anchored (0 = serve), multi-dish only. */
  startOffsetMinutes?: number | null;
  /** Folded "Done in prep" (the screen skips it). */
  doneInPrep: boolean;
  /** "You prepped this" chip labels. */
  preppedLabels: string[];
}

export interface CookView {
  /** The sample meal (the catalog or source id), not the account's fork. */
  sourceMealId: string;
  title: string;
  category: SampleCategory;
  servings: number;
  /** The servings the recipe is written for (authoredServingsDefault). */
  authoredServings: number;
  prepped: boolean;
  multiDish: boolean;
  isFeast: boolean;
  /** Dish titles in meal order, and which are served cold. */
  dishes: { dishId: string; title: string; servedCold: boolean; ingredientNames?: string[] }[];
  steps: ShownStep[];
  /** The Sequencer's total, else the serial sum. */
  totalMinutes: number | null;
  /** "Prepped on …" recap lines (the plan's prep steps for this meal). */
  recap: string[];
}

export type KFlag = "K1" | "K2" | "K3" | "K4" | "K5" | "K6" | "K7";

export type Severity = "high" | "medium" | "low";

export interface KFinding {
  flag: KFlag;
  severity: Severity;
  /** Stable across meals: the flag, a kind, a normalised subject — never an id. */
  signature: string;
  /** Screen step numbers involved. */
  steps: number[];
  /** The step text the finding is about (the fajita-style quote). */
  quote: string;
  detail: string;
  numbers?: Record<string, number | string>;
}

export const K_TITLES: Record<KFlag, string> = {
  K1: "finished early and held, not kept warm/cold",
  K2: "two hands-on tasks at once, no cue",
  K3: "knife task inside stovetop work that can't be left",
  K4: "pan/burner double-booked, or oven at two temperatures",
  K5: "a long wait a later prep step could fill",
  K6: "uses something not made (yet)",
  K7: "set aside / kept warm, never picked up",
};

/** One problem an AI home cook reported. */
export interface PersonaIssue {
  step: number;
  quote: string;
  type: string;
  whatWentWrong: string;
  severity: Severity;
  suggestedRewrite: string;
}

export type PersonaId = "beginner" | "weeknight" | "interrupted";

export interface PersonaRun {
  persona: PersonaId;
  model: string;
  view: { sourceMealId: string; title: string; servings: number; prepped: boolean };
  issues: PersonaIssue[];
  /** The cook's own kitchen-state log, one line per step. */
  log: string[];
  usd: number;
  calls: number;
  ms: number;
  error?: string;
}
