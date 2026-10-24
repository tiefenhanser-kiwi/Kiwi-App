// THX-3d round 2 (N) — CONTAINERS THE COOK CAN LABEL (Prep the feast only).
//
// Thirteen to seventeen containers named "the fresh thyme, fresh sage and fresh
// flat-leaf parsley container for the Sage and Onion Stuffing" cannot be written on
// tape. Each container gets a short label by rule, <dish short name> <role>:
//   "Stuffing herbs" · "Stuffing onion & celery" · "Gravy vegetables" · "Turkey aromatics"
//   "Cranberry mix" · "Pie spice mix" · "Crisp filling mix" / "Crisp topping mix"
//   a shared tub by its food: "Minced garlic", "Lemon juice".
// The label replaces the engine's name EVERYWHERE in the step plan — the steps, every
// portion's destination, the portion lines, the opening and closing clauses, the
// narration input, the keyed maps — so the prep card, the closing line and Cook Mode's
// "…you prepped" all say it. A dish's plate that holds part of one moment with its
// other container (Classic's turkey: the quartered onion on a "toppings plate", the
// halved lemon in its "vegetables", both for the cavity) is that one container. Prep
// the feast opens with a code-written step listing them: "Label N containers".

import type { PlannedStep, StepPlan } from "./prepWeekAssembly";

export type FeastLabelKind = "own" | "shared" | "plate" | "mix";
export interface FeastLabels { /** label → what it is (Cook Mode words it by this). */ kinds: Map<string, FeastLabelKind>; ordered: string[] }

export const FEAST_LABEL_STEP_KEY = "feast-labels";

export const HERB = /\b(sage|thyme|rosemary|parsley|chives?|dill|cilantro|basil|oregano|tarragon|mint|bay)\b/i;
export const AROMATIC = /\b(garlic|shallots?|onions?|ginger|lemons?|limes?|oranges?)\b/i;
const SPICE = /\b(cinnamon|nutmeg|ginger|cloves|allspice|cardamom|paprika|cumin|chili powder|cayenne|coriander|mace|star anise|pepper flakes)\b/i;
const TOPPING = /\b(oats?|pecans?|walnuts?|almonds?|nuts?|panko|breadcrumbs?|crumbs?)\b/i;
const FILLING = /\b(cornstarch|tapioca|arrowroot)\b/i;
const GENERIC = /^(?:fresh|whole|large|small|medium|yellow|white|red|sweet|dried|ground|kosher|granulated|packed|light|dark|unsalted|salted|baby|flat-leaf)$/i;

/** "Sage and Onion Stuffing" → "Stuffing", "Herb-Roasted Whole Turkey" → "Turkey", "Sweet Potato Casserole" → "Potato casserole". */
export function shortOf(title: string, long = false): string {
  const t = title.toLowerCase();
  if (/\bturkey\b/.test(t)) return "Turkey";
  if (/\bcranberr/.test(t)) return "Cranberry";
  if (/\bmac and cheese\b/.test(t)) return "Mac and cheese";
  if (/\bbrussels sprouts\b/.test(t)) return "Sprouts";
  const words = title.split(/\s+with\s+/i)[0].split(/\s+/).filter((w) => !/-/.test(w));
  const last = words[words.length - 1] ?? "";
  // "Sweet potato casserole" and "Green bean casserole" in one feast: a casserole says what it is.
  const pick = /^casserole$/i.test(last) ? words.slice(-3) : /^(?:potatoes|beans|bars)$/i.test(last) || long ? words.slice(-2) : words.slice(-1);
  const s = pick.join(" ").toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "yellow onion" → "onion", "celery stalks" → "celery", "fresh green beans" → "green beans". */
export function foodOf(name: string): string {
  const words = name.toLowerCase().replace(/\([^)]*\)/g, " ").split(/[,]/)[0].trim().split(/\s+/).filter((w) => !GENERIC.test(w));
  const out = words.filter((w) => !/^(?:stalks?|cloves?|sprigs?|leaves|heads?)$/.test(w));
  return (out.length ? out : words).join(" ");
}

interface Found { name: string; dishTitles: Set<string>; members: Set<string>; notes: string[]; fromStep: boolean }

const KIND = [
  [/ dry mix(?: (\d+))?$/, "mix"],
  [/ spice blend(?: \d+)?$/, "spice"],
  [/ sauce jar(?: \d+)?$/, "sauce"],
  [/ marinade bowl(?: \d+)?$/, "marinade"],
  [/ citrus jar(?: \d+)?$/, "citrus"],
  [/ juice jar(?: \d+)?$/, "juice"],
  [/ prep plate(?: \d+)?$/, "plate"],
  [/ (?:toppings )?plate(?: \d+)?$/, "toppings"],
  [/ (?:vegetables|aromatics|herbs|bowl)(?: \d+)?$/, "produce"],
] as const;

/** The labels for a feast step plan (old name → label), and what each is. */
export function feastLabelMap(plan: Pick<StepPlan, "steps">): { map: Map<string, string>; labels: FeastLabels } {
  const found = new Map<string, Found>();
  const see = (name: string | undefined, dish: string | undefined, member: string, note: string | undefined, fromStep: boolean) => {
    if (!name) return;
    const f = found.get(name) ?? { name, dishTitles: new Set<string>(), members: new Set<string>(), notes: [], fromStep };
    if (dish) f.dishTitles.add(dish);
    f.members.add(member);
    if (note) f.notes.push(note.toLowerCase());
    found.set(name, f);
  };
  for (const st of plan.steps) {
    if (st.demoted) continue;
    for (const c of st.components) {
      for (const m of c.measures) {
        if (st.bowlName) see(st.bowlName, m.forDish, c.ingredientName, m.preparationNote ?? c.preparationNote ?? undefined, true);
        if (m.destination) see(m.destination, m.forDish, c.ingredientName, m.preparationNote ?? c.preparationNote ?? undefined, false);
      }
    }
  }
  const titles = new Set([...found.values()].flatMap((f) => [...f.dishTitles]));
  const shortByTitle = new Map([...titles].map((t) => [t, shortOf(t)]));
  for (const [t, s] of shortByTitle) if ([...shortByTitle.values()].filter((x) => x === s).length > 1) shortByTitle.set(t, shortOf(t, true));
  const kinds = new Map<string, FeastLabelKind>();
  const map = new Map<string, string>();
  const kindOf = (name: string) => KIND.find(([re]) => re.test(name))?.[1] ?? null;
  // Mixes per dish, for the role word ("Crisp topping mix" / "Crisp filling mix").
  const mixesOf = new Map<string, number>();
  for (const f of found.values()) if (kindOf(f.name) === "mix") for (const t of f.dishTitles) mixesOf.set(t, (mixesOf.get(t) ?? 0) + 1);
  // One container per dish per moment: a plate whose members share a purpose ("for
  // cavity") with the dish's one produce container IS that container — its members join
  // it before it is labelled (Classic's turkey: garlic, sage, lemon and the onion).
  const isShared = (f: Found) => / — /.test(f.name) && ![...titles].some((t) => f.name.startsWith(`${t} — `));
  const isProduce = (f: Found) => !isShared(f) && (f.name.includes(" — ") || kindOf(f.name) === "produce");
  const purposes = (f: Found) => new Set(f.notes.flatMap((n) => [...n.matchAll(/\bfor (?:the )?([a-z]+(?: [a-z]+)?)/g)].map((m) => m[1])));
  const mergedInto = new Map<string, string>();
  for (const f of found.values()) {
    const k = kindOf(f.name);
    if (k !== "plate" && k !== "toppings") continue;
    const title = [...f.dishTitles][0];
    const others = [...found.values()].filter((o) => o !== f && o.dishTitles.has(title) && isProduce(o));
    if (others.length !== 1) continue;
    const mine = purposes(f);
    if (![...purposes(others[0])].some((p) => mine.has(p))) continue;
    mergedInto.set(f.name, others[0].name);
    for (const m of f.members) others[0].members.add(m);
  }
  for (const f of found.values()) {
    if (mergedInto.has(f.name)) continue;
    const shared = / — /.test(f.name) && ![...titles].some((t) => f.name.startsWith(`${t} — `));
    if (shared) {
      let food = f.name.split(" — ")[0].replace(/\([^)]*\)/g, "").replace(/\bfresh\s+/gi, "").replace(/\b(?:finely|thinly|roughly|coarsely)\s+/gi, "").replace(/\s+/g, " ").trim();
      food = food.replace(/^juiced (.+)$/i, "$1 juice").replace(/^zested (.+)$/i, "$1 zest");
      map.set(f.name, food.charAt(0).toUpperCase() + food.slice(1).toLowerCase());
      kinds.set(map.get(f.name)!, "shared");
      continue;
    }
    const title = [...f.dishTitles][0] ?? f.name;
    const short = shortByTitle.get(title) ?? shortOf(title);
    const k = f.name.includes(" — ") ? "produce" : kindOf(f.name);
    const foods = [...new Set([...f.members].map(foodOf))];
    let label: string;
    switch (k) {
      case "mix": {
        const members = [...f.members].join(" ");
        const role = (mixesOf.get(title) ?? 0) > 1 ? (TOPPING.test(members) ? "topping" : FILLING.test(members) ? "filling" : null) : null;
        const spices = [...f.members].filter((m) => SPICE.test(m)).length;
        label = role ? `${short} ${role} mix` : `${short} ${spices >= 2 ? "spice mix" : "mix"}`;
        break;
      }
      case "spice": label = `${short} spice mix`; break;
      case "sauce": label = `${short} sauce`; break;
      case "marinade": label = `${short} marinade`; break;
      case "citrus": label = `${short} citrus`; break;
      case "juice": label = `${short} juice`; break;
      case "plate": label = `${short} plate`; break;
      case "toppings": label = `${short} toppings`; break;
      default: {
        if (foods.every((x) => HERB.test(x))) label = `${short} herbs`;
        // A food that is the dish's own name says it ("Cranberries & orange", not "Cranberry cranberries").
        else if (foods.length <= 2 && foods.some((x) => x.includes(short.toLowerCase().slice(0, 6)))) label = foods.join(" & ").replace(/^./, (c) => c.toUpperCase()).replace(/\bbrussels\b/, "Brussels");
        else if (foods.length <= 2) label = `${short} ${foods.join(" & ")}`;
        else if (foods.every((x) => HERB.test(x) || AROMATIC.test(x))) label = `${short} aromatics`;
        else label = `${short} vegetables`;
      }
    }
    map.set(f.name, label);
    kinds.set(label, k === "mix" || k === "spice" || k === "sauce" || k === "marinade" ? "mix" : k === "plate" || k === "toppings" ? "plate" : "own");
  }
  for (const [plate, into] of mergedInto) map.set(plate, map.get(into)!);
  // Two containers, one label (not a merge): the longer dish name, then a number.
  const used = new Map<string, string>();
  for (const [old, label] of map) {
    const first = used.get(label);
    if (first === undefined) { used.set(label, old); continue; }
    const mergedHere = [...map.entries()].some(([o, l]) => o !== old && l === label && kinds.get(label) === "own");
    if (mergedHere && kindOf(old) !== "mix") continue;
    let n = 2;
    while (used.has(`${label} ${n}`)) n++;
    map.set(old, `${label} ${n}`);
    kinds.set(`${label} ${n}`, kinds.get(label) ?? "own");
    used.set(`${label} ${n}`, old);
  }
  const ordered: string[] = [];
  for (const st of plan.steps) {
    if (st.demoted) continue;
    for (const n of [st.bowlName, ...st.components.flatMap((c) => c.measures.map((m) => m.destination))]) {
      const l = n ? map.get(n) : undefined;
      if (l && !ordered.includes(l)) ordered.push(l);
    }
  }
  return { map, labels: { kinds, ordered } };
}

/** Every string in a value with each old name replaced (longest first); Maps re-keyed. */
export function renamed<T>(value: T, pairs: readonly [string, string][]): T {
  const fix = (s: string) => pairs.reduce((t, [a, b]) => (t.includes(a) ? t.split(a).join(b) : t), s);
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return fix(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [typeof k === "string" ? fix(k) : k, walk(x)]));
    if (v instanceof Set) return new Set([...v].map(walk));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** The feast step plan with its containers labelled, and its "Label N containers" step first. */
export function labelFeastContainers(plan: StepPlan): StepPlan & { feastLabels: FeastLabels } {
  const { map, labels } = feastLabelMap(plan);
  const pairs = [...map].filter(([a, b]) => a !== b).sort((x, y) => y[0].length - x[0].length);
  const out = renamed({ steps: plan.steps, narrationInput: plan.narrationInput, containerExtras: plan.containerExtras, labelKinds: plan.labelKinds }, pairs);
  const steps = [...out.steps];
  const first = steps.findIndex((s) => !s.demoted);
  if (labels.ordered.length > 0 && first >= 0) {
    const lead = steps[first];
    const label: PlannedStep = {
      stepId: `${lead.phase}#0`,
      stepKey: FEAST_LABEL_STEP_KEY,
      phase: lead.phase,
      number: 0,
      ingredientId: null,
      contributesToMealIds: [...new Set(steps.flatMap((s) => s.contributesToMealIds))],
      isBlend: false,
      estimatedMinutes: Math.max(1, Math.ceil(labels.ordered.length / 5)),
      components: [],
      relevantDishes: [],
      holdsNoContainer: true,
      fixedProse: {
        title: `Label ${labels.ordered.length} containers`,
        instructions: `Write these on tape, one per container: ${labels.ordered.join(" · ")}.`,
      },
    };
    // Numbers start at 1 (the wire's floor): the phase's own steps move up one; their
    // stepIds and stepKeys stay (the narration and the completions key on those).
    for (let i = 0; i < steps.length; i++) if (steps[i].phase === lead.phase) steps[i] = { ...steps[i], number: steps[i].number + 1 };
    steps.splice(first, 0, { ...label, number: 1 });
  }
  return { ...out, steps, feastLabels: labels };
}
