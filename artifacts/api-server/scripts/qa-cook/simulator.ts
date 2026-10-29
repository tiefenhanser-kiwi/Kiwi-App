// QA-COOK-1 — the kitchen simulator. Deterministic, no AI.
//
// A home kitchen: 4 burners, one oven at one temperature, two skillets, one
// pair of hands, one cook's attention. The cook follows Cook Mode as the app
// shows it — the steps in the screen's order, one after another, skipping the
// ones folded "Done in prep" — and goes as fast as the steps allow:
//
//   • a step the cook must attend (hands work, or stove work the prose says
//     can't be left) takes the cook for its minutes;
//   • a step that is started and left (a simmer, a bake, a boil, a marinade, a
//     rest) takes the cook a minute or two to set going and then runs on its
//     own clock, holding its burner or the oven;
//   • a step waits for what it needs: the dish's previous started-and-left step
//     (unless the author tagged the two to overlap, or it is knife work that does
//     not touch it), and another dish it uses (the Sequencer's own reading,
//     dishUses).
//
// "One at a time" and "in batches" grow with the servings. Nothing else does:
// the authored minutes are what the screen says.
//
// It walks that clock and reports K1–K7 (types.ts K_TITLES). K2 is read on the
// SEQUENCER's clock (startOffsetMinutes): it is the app that put two hands-on
// tasks side by side, which a cook walking one step at a time never would.
import { dishUses, type SchedulerDish } from "../../src/lib/cookingScheduler";
import {
  contentWords,
  KEEP_ALL_WARM,
  KEEP_WARM,
  KNIFE,
  MADE_THING,
  makesMixture,
  mentions,
  readStep,
  refsOf,
  setAsideOf,
  type StepRead,
  stepMinutes,
  subjectClass,
} from "./lexicon";
import type { CookView, KFinding, ShownStep } from "./types";

export interface Kitchen {
  burners: number;
  skillets: number;
  /** K1: minutes a finished component may wait uncovered. */
  holdMin: number;
  /** K5: minutes of waiting worth filling. */
  idleMin: number;
}

export const HOME_KITCHEN: Kitchen = { burners: 4, skillets: 2, holdMin: 10, idleMin: 10 };

export interface SimStep {
  s: ShownStep;
  r: StepRead;
  dish: string;
  start: number;
  handsEnd: number;
  end: number;
  /** Minutes the cook stood waiting before it. */
  waited: number;
}

export interface SimResult {
  steps: SimStep[];
  serveAt: number;
  idleMinutes: number;
  findings: KFinding[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const quote = (s: ShownStep) => s.text.length > 220 ? `${s.text.slice(0, 217)}…` : s.text;
const CUE = /\b(while|meanwhile|as soon as|in the meantime)\b/i;
const REHEAT = /\b(return|add (?:them |it |the [a-z ]+ )?back|back (?:in)?to the|toss|heat through|rewarm|re-warm|warm through|stir (?:in|together))\b/i;
/** Served cold or at room temperature though its brine is heated (the Sequencer's cold list has no pickles). */
/** A step that changes the one oven's temperature with food in it ("Raise the oven to 350°F and put in …"). */
const OVEN_CHANGE = /\b(?:raise|lower|reduce|increase|turn (?:up|down))\b[^.]{0,30}\boven\b|\boven\b[^.]{0,20}\b(?:up|down) to\b/i;
const PICKLED = /\b(pickled|pickles|quick-pickled|pickle)\b/i;
const SENSITIVE_COLD = /\b(avocado|guacamole|lettuce|greens|arugula|romaine|dressed|whipped|ice cream|sliced apple)\b/i;

function shareGroup(a: ShownStep, b: ShownStep): boolean {
  return !!a.parallelGroup && a.parallelGroup === b.parallelGroup && a.dishId === b.dishId;
}

/** The view's dishes as the Sequencer's input, steps in recipe order, for dishUses. */
function schedulerDishes(v: CookView): { dishes: SchedulerDish[]; keyOf: Map<string, string[]> } {
  const keyOf = new Map<string, string[]>();
  const dishes: SchedulerDish[] = v.dishes.map((d, i) => {
    const steps = v.steps.filter((s) => s.dishId === d.dishId).sort((a, b) => (a.stepIndex ?? 0) - (b.stepIndex ?? 0));
    keyOf.set(d.dishId, steps.map((s) => s.key));
    return {
      dishId: d.dishId,
      title: d.title,
      ...(d.ingredientNames ? { ingredientNames: d.ingredientNames } : {}),
      positionIndex: i,
      steps: steps.map((s) => ({ stepIndex: s.stepIndex ?? 0, estimatedMinutes: Math.max(1, s.estimatedMinutes), phaseType: s.phaseType as never, isTimingSensitive: s.isTimingSensitive, text: s.text })),
    };
  });
  return { dishes, keyOf };
}

export function simulate(v: CookView, k: Kitchen = HOME_KITCHEN): SimResult {
  const findings: KFinding[] = [];
  const add = (f: KFinding) => {
    if (!findings.some((x) => x.signature === f.signature && x.steps.join() === f.steps.join())) findings.push(f);
  };
  const ratio = v.servings / Math.max(1, v.authoredServings);
  const shown = v.steps;
  const live = shown.filter((s) => !s.doneInPrep);
  const posOf = new Map(shown.map((s, i) => [s.key, i]));

  // The Sequencer's own cross-dish uses: a step that uses another dish waits for it.
  const { dishes, keyOf } = schedulerDishes(v);
  const usesByKey = new Map<string, { doneKey: string; food: string; usesDishId: string }[]>();
  for (const u of dishUses(dishes)) {
    const useKey = keyOf.get(u.dishId)?.[u.stepIdx];
    const doneKey = keyOf.get(u.usesDishId)?.[u.doneIdx];
    if (!useKey || !doneKey) continue;
    const list = usesByKey.get(useKey) ?? [];
    list.push({ doneKey, food: u.food, usesDishId: u.usesDishId });
    usesByKey.set(useKey, list);
  }

  const sim: SimStep[] = [];
  const done = new Map<string, SimStep>();
  /** Stove pans with food on the heat that needs the cook (constant/frequent, not taken off). */
  const livePan = new Map<string, SimStep>();
  const ovenUses: { dish: string; temp: number | null; start: number; end: number; n: number }[] = [];
  const dishOvenTemp = new Map<string, number>();
  let ovenSet: number | null = null;
  let t = 0;
  let idle = 0;

  for (let i = 0; i < live.length; i++) {
    const s = live[i];
    const r = readStep(s);
    const dish = s.dishId ?? "meal";
    const mins = stepMinutes(s, r, ratio);

    // ── what it waits for ──
    let ready = t;
    for (const b of sim) {
      if (b.end <= t || b.r.attention !== "background") continue;
      if (b.dish !== dish) continue;
      if (shareGroup(b.s, s)) continue;
      if (r.attention === "hands" && !r.serve && !mentions(s.text, contentWords(b.s.text))) continue;
      ready = Math.max(ready, b.end);
    }
    for (const u of usesByKey.get(s.key) ?? []) {
      const d = done.get(u.doneKey);
      if (d) ready = Math.max(ready, d.end);
      else {
        const doneStep = shown[posOf.get(u.doneKey) ?? -1];
        if (doneStep && !doneStep.doneInPrep) {
          add({
            flag: "K6", severity: "high", signature: `K6:uses-before-made:${subjectClass(u.food)}`,
            steps: [s.n, doneStep.n], quote: quote(s),
            detail: `Step ${s.n} uses the ${u.food} (${v.dishes.find((d2) => d2.dishId === u.usesDishId)?.title}), but that dish is finished only at step ${doneStep.n}.`,
          });
        }
      }
    }
    const start = ready;
    const waited = start - t;

    // ── K5: a long wait a later prep step could fill ──
    // Over an hour (a slow cooker, a long braise) the cook is not standing there: not idle.
    if (waited >= k.idleMin && waited <= 60) {
      const movable = live.slice(i + 1).find((x) => {
        const xr = readStep(x);
        return xr.heat === null && xr.attention === "hands" && (x.phaseType === "prep" || KNIFE.test(x.text)) && !(usesByKey.get(x.key)?.length);
      });
      if (movable) {
        add({
          flag: "K5", severity: waited >= 20 ? "medium" : "low", signature: `K5:idle-wait:${subjectClass(movable.text)}`,
          steps: [s.n, movable.n], quote: quote(movable),
          detail: `The cook waits ${r1(waited)} min before step ${s.n} with nothing to do; step ${movable.n} (prep) could be done in that time.`,
          numbers: { waitMin: r1(waited) },
        });
      }
    }

    // ── K3: knife or board work while a pan on the heat needs the cook ──
    if (r.heat === null && r.attention === "hands" && (r.knife || s.phaseType === "prep")) {
      for (const p of livePan.values()) {
        if (p.r.attention === "frequent" && !p.r.proseAttention) continue;
        if (p.end > start + 0.01 && p.r.attention === "background") continue;
        const cued = CUE.test(s.cue ?? "") || /^\s*(while|meanwhile)\b/i.test(s.text);
        const sev = p.r.attention === "constant" ? (cued ? "medium" : "high") : cued ? "low" : "medium";
        add({
          flag: "K3", severity: sev, signature: `K3:knife-inside-${p.r.attention}:${subjectClass(p.s.text)}`,
          steps: [p.s.n, s.n], quote: quote(s),
          detail: `Step ${s.n} is board work (${r1(mins.hands)} min) while step ${p.s.n}'s pan is still on the heat and needs the cook (${p.r.attention}): "${p.s.text.slice(0, 90)}…"`,
          numbers: { boardMin: r1(mins.hands) },
        });
      }
    }

    // ── K4: burners, skillets, the same pan, the oven ──
    if (r.heat === "stove") {
      const busy = new Set<string>();
      for (const b of sim) if (b.r.heat === "stove" && b.r.attention === "background" && b.end > start && b.dish !== dish) busy.add(`${b.dish}:${b.r.vessel ?? "pan"}`);
      for (const [key, p] of livePan) if (p.dish !== dish) busy.add(key);
      if (busy.size + 1 > k.burners) {
        add({ flag: "K4", severity: "medium", signature: "K4:burners", steps: [s.n], quote: quote(s), detail: `Step ${s.n} needs a ${busy.size + 1}th burner (the kitchen has ${k.burners}).`, numbers: { burners: busy.size + 1 } });
      }
      if (r.vessel === "skillet") {
        const skillets = [...busy].filter((x) => x.endsWith(":skillet")).length + 1;
        if (skillets > k.skillets) add({ flag: "K4", severity: "low", signature: "K4:skillets", steps: [s.n], quote: quote(s), detail: `Step ${s.n} needs skillet #${skillets} at once (a home kitchen has ${k.skillets}).` });
      }
      if (r.sameVessel) {
        const other = [...busy].find((x) => x.endsWith(`:${r.vessel}`));
        if (other) add({ flag: "K4", severity: "high", signature: `K4:same-pan-busy:${r.vessel}`, steps: [s.n], quote: quote(s), detail: `Step ${s.n} asks for "the same ${r.vessel}", which another dish is still using.` });
      }
    }
    if (r.heat === "oven") {
      const temp: number | null = r.ovenTempF ?? dishOvenTemp.get(dish) ?? ovenSet;
      if (OVEN_CHANGE.test(s.text) && temp !== null) {
        // "Raise the oven to 350°F and put in …" (the feast's own step): the one oven changes, and so does all that is in it.
        for (const o of ovenUses) if (o.end > start) o.temp = temp;
        ovenSet = temp;
        dishOvenTemp.set(dish, temp);
        if (r.attention === "background" && !/^\s*(?:raise|lower|reduce|increase|turn)\b[^.]*\.?\s*$/i.test(s.text)) ovenUses.push({ dish, temp, start, end: start + mins.total, n: s.n });
      } else if (s.phaseType === "preheat" || /\bpreheat|heat the oven\b/i.test(s.text)) {
        const inside = ovenUses.find((o) => o.end > start && o.temp !== null && temp !== null && Math.abs(o.temp - temp) > 25);
        if (inside) add({ flag: "K4", severity: "high", signature: "K4:oven-two-temps", steps: [inside.n, s.n], quote: quote(s), detail: `Step ${s.n} sets the oven to ${temp}°F while step ${inside.n}'s food is in at ${inside.temp}°F.`, numbers: { tempA: inside.temp ?? "", tempB: temp ?? "" } });
        if (temp !== null) {
          ovenSet = temp;
          dishOvenTemp.set(dish, temp);
        }
      } else if (r.attention === "background") {
        const clash = ovenUses.find((o) => o.dish !== dish && o.end > start && o.temp !== null && temp !== null && Math.abs(o.temp - temp) > 25);
        if (clash) add({ flag: "K4", severity: "high", signature: "K4:oven-two-temps", steps: [clash.n, s.n], quote: quote(s), detail: `Step ${s.n} bakes at ${temp}°F while step ${clash.n} is in the oven at ${clash.temp}°F.`, numbers: { tempA: clash.temp ?? "", tempB: temp ?? "" } });
        ovenUses.push({ dish, temp, start, end: start + mins.total, n: s.n });
      }
    }

    // ── run it ──
    const step: SimStep = { s, r, dish, start, handsEnd: start + mins.hands, end: start + mins.total, waited };
    sim.push(step);
    done.set(s.key, step);
    idle += waited;
    t = step.handsEnd;

    // The pans: food on the heat that needs the cook stays "live" until a step takes it off.
    if (r.heat === "stove" || r.heat === "grill") {
      const key = `${dish}:${r.vessel ?? [...livePan.keys()].find((x) => x.startsWith(`${dish}:`))?.split(":")[1] ?? "pan"}`;
      if ((r.attention === "constant" || r.attention === "frequent") && !r.offHeat && !r.serve) livePan.set(key, step);
      else livePan.delete(key);
    } else if (r.offHeat || r.serve) {
      for (const key of [...livePan.keys()]) if (key.startsWith(`${dish}:`)) livePan.delete(key);
    }
  }

  const serveAt = sim.reduce((m, x) => Math.max(m, x.end, x.handsEnd), 0);

  // ── K1 (dish level): a dish finished hot and left to wait ──
  for (const d of v.dishes) {
    const ds = sim.filter((x) => x.dish === d.dishId);
    if (ds.length === 0) continue;
    if (d.servedCold || PICKLED.test(d.title) || ds.every((x) => x.r.heat === null)) {
      const last = ds[ds.length - 1];
      const text = ds.map((x) => x.s.text).join(" ");
      const hold = serveAt - last.end;
      // Cold food tolerates more than hot: a browning or wilting component is flagged past twice the hot limit.
      if (SENSITIVE_COLD.test(`${d.title} ${text}`) && hold > 2 * k.holdMin && !ds.some((x) => x.r.keepCold)) {
        add({ flag: "K1", severity: "medium", signature: `K1:cold-held:${subjectClass(`${d.title} ${text}`)}`, steps: [last.s.n], quote: quote(last.s), detail: `${d.title} is finished at minute ${r1(last.end)} and sits out ${r1(hold)} min before serving, with no step to cover or chill it.`, numbers: { holdMin: r1(hold) } });
      }
      continue;
    }
    let li = -1;
    ds.forEach((x, idx) => {
      if (x.r.heat !== null) li = idx;
    });
    if (li < 0) continue;
    let finish = ds[li].end;
    let j = li + 1;
    while (j < ds.length && ds[j].s.phaseType === "rest" && /\brest/i.test(ds[j].s.text) && !ds[j].r.keepWarm) finish = ds[j++].end;
    const warmIdx = ds.findIndex((x, idx) => idx >= li && x.r.keepWarm);
    let coveredAt = warmIdx < 0 ? serveAt : warmIdx === li ? finish : ds[warmIdx].start;
    // The feast's meal-wide keep-warm ("Turn the oven off and leave the sides inside") covers an oven dish done before it.
    const all = ds[li].r.heat === "oven" ? sim.find((x) => x.start >= finish && KEEP_ALL_WARM.test(x.s.text)) : undefined;
    if (all) coveredAt = Math.min(coveredAt, all.start);
    const hold = serveAt - finish;
    const uncovered = Math.max(0, coveredAt - finish);
    const what = subjectClass(`${d.title}`) === "other" ? subjectClass(ds[li].s.text) : subjectClass(d.title);
    const fragile = ["bread", "crisp", "eggs"].includes(what);
    const sev = fragile ? "high" : "medium";
    if (hold > k.holdMin && uncovered > k.holdMin) {
      add({
        flag: "K1", severity: sev, signature: `K1:held-uncovered:${what}`, steps: [ds[li].s.n], quote: quote(ds[li].s),
        detail: `${d.title} comes off the heat at minute ${r1(finish)} (step ${ds[li].s.n}) and waits ${r1(uncovered)} min${warmIdx < 0 ? " to serving with nothing keeping it warm" : ` before step ${ds[warmIdx].s.n} keeps it warm`}; served at minute ${r1(serveAt)}.`,
        numbers: { finishedAt: r1(finish), serveAt: r1(serveAt), uncoveredMin: r1(uncovered), holdMin: r1(hold) },
      });
    } else if (hold > k.holdMin && warmIdx > li && coveredAt === ds[warmIdx].start && uncovered > (fragile ? 3 : 8)) {
      // A warm tortilla stiffens in minutes; a roast or a pot of rice is fine for several.
      add({
        flag: "K1", severity: fragile && uncovered >= 5 ? "high" : "medium", signature: `K1:keep-warm-late:${what}`, steps: [ds[li].s.n, ds[warmIdx].s.n], quote: quote(ds[warmIdx].s),
        detail: `${d.title} comes off the heat at step ${ds[li].s.n}, but the step that keeps it warm is step ${ds[warmIdx].s.n}, ${r1(uncovered)} min (${ds[warmIdx].s.n - ds[li].s.n - 1} steps) later; it is held ${r1(hold)} min in all.`,
        numbers: { uncoveredMin: r1(uncovered), holdMin: r1(hold), stepsBetween: ds[warmIdx].s.n - ds[li].s.n - 1 },
      });
    }
  }

  // ── K1 (inside a dish) and K7: things set aside, and when (if) they are picked up ──
  for (let i = 0; i < sim.length; i++) {
    const a = sim[i];
    const aside = setAsideOf(a.s.text);
    const lastOfDish = !sim.slice(i + 1).some((x) => x.dish === a.dish);
    if (!aside || lastOfDish) continue;
    const pickup = sim.slice(i + 1).find((x) => mentions(x.s.text, aside.words) || /\b(everything|all the components|the components)\b/i.test(x.s.text));
    if (!pickup) {
      add({ flag: "K7", severity: subjectClass(aside.name) === "garnish" ? "low" : "medium", signature: `K7:never-picked-up:${subjectClass(aside.name)}`, steps: [a.s.n], quote: quote(a.s), detail: `Step ${a.s.n} sets aside ${aside.name}; no later step uses it again.` });
      continue;
    }
    const hot = a.r.heat !== null;
    if (hot && !(pickup.r.heat !== null && REHEAT.test(pickup.s.text))) {
      const hold = pickup.start - a.end;
      const kept = a.r.keepWarm || sim.slice(i + 1, sim.indexOf(pickup)).some((x) => x.r.keepWarm && mentions(x.s.text, aside.words));
      if (hold > k.holdMin && !kept) {
        const what = subjectClass(aside.name);
        add({ flag: "K1", severity: ["bread", "crisp", "eggs"].includes(what) ? "high" : "medium", signature: `K1:held-uncovered:${what}`, steps: [a.s.n, pickup.s.n], quote: quote(a.s), detail: `Step ${a.s.n} takes ${aside.name} off the heat; it waits ${r1(hold)} min until step ${pickup.s.n} with nothing keeping it warm.`, numbers: { holdMin: r1(hold) } });
      }
    }
  }

  // ── K6: "the X you made" for an X never made (or made later) ──
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    if (s.doneInPrep) continue;
    const before = shown.slice(0, i);
    const after = shown.slice(i + 1);
    const prepped = [...v.recap, ...shown.flatMap((x) => x.preppedLabels)].join(" ");
    for (const ref of refsOf(s.text)) {
      const madeBefore = before.some((x) => contentWords(x.text).includes(ref.head)) || contentWords(prepped).includes(ref.head) ||
        (MADE_THING.test(ref.head) && before.some((x) => x.dishId === s.dishId && makesMixture(x.text)));
      if (madeBefore) continue;
      const later = after.find((x) => contentWords(x.text).includes(ref.head));
      add({
        flag: "K6", severity: "high", signature: `K6:${later ? "ref-before-made" : "ref-never-made"}:${subjectClass(ref.head)}`,
        steps: later ? [s.n, later.n] : [s.n], quote: quote(s),
        detail: later ? `Step ${s.n} says "${ref.phrase}", but it is first made at step ${later.n}.` : `Step ${s.n} says "${ref.phrase}", but no step (or prep) makes it.`,
      });
    }
  }

  // ── K2: on the Sequencer's clock, two hands-on tasks at once ──
  const timed = sim.filter((x) => typeof x.s.startOffsetMinutes === "number");
  for (const a of timed) {
    if (a.r.attention === "background" || !a.r.proseAttention) continue;
    const aStart = a.s.startOffsetMinutes as number;
    const aEnd = aStart + (a.end - a.start);
    const over = timed.filter((b) => {
      if (b === a || b.r.attention === "background" || !b.r.proseAttention || (b.dish === a.dish && !shareGroup(a.s, b.s))) return false;
      const bStart = b.s.startOffsetMinutes as number;
      const bEnd = bStart + (b.end - b.start);
      return bStart >= aStart && bStart < aEnd - 0.5 && Math.min(aEnd, bEnd) - bStart > 1 && (bStart > aStart || a.s.n < b.s.n);
    });
    if (over.length === 0) continue;
    const uncued = over.filter((b) => !CUE.test(b.s.cue ?? "") && !CUE.test(b.s.text));
    const list = (uncued.length ? uncued : over).map((b) => b.s.n);
    if (uncued.length === 0 && a.r.attention !== "constant") continue;
    const why = a.r.serverHandsFree ? `the Sequencer treats it as hands-free (phase ${a.s.phaseType}${a.s.isTimingSensitive ? ", timing-sensitive" : ", not timing-sensitive"}), but the text needs the cook (${a.r.attention})` : `both need the cook`;
    add({
      flag: "K2", severity: a.r.attention === "constant" ? "high" : "medium",
      signature: `K2:${uncued.length ? "uncued" : "cued-over-constant"}:${a.r.serverHandsFree ? "flagged-hands-free" : "both-attended"}:${subjectClass(a.s.text)}`,
      steps: [a.s.n, ...list], quote: quote(a.s),
      detail: `On the Sequencer's clock step ${a.s.n} (${r1(a.end - a.start)} min) runs alongside step${list.length > 1 ? "s" : ""} ${list.join(", ")}: ${why}.`,
      numbers: { minutes: r1(a.end - a.start) },
    });
  }

  return { steps: sim, serveAt: r1(serveAt), idleMinutes: r1(idle), findings };
}

/** A one-line timeline per step, for the report's appendix and for debugging. */
export function timelineText(res: SimResult): string[] {
  return res.steps.map((x) => `${String(x.s.n).padStart(2)} ${r1(x.start).toString().padStart(5)}–${r1(x.end).toString().padEnd(5)} ${x.r.attention.padEnd(10)} ${(x.r.heat ?? "-").padEnd(9)} ${x.waited > 0 ? `wait ${r1(x.waited)} ` : ""}${x.s.dishTitle ? `[${x.s.dishTitle.slice(0, 18)}] ` : ""}${x.s.text.slice(0, 80)}`);
}

export { KEEP_WARM };
