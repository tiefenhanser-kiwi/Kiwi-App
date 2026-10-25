// THX-3d round 5 (BUG-521) — a side kept warm is plated at serving, its keep-warm is the
// lid and the knob as its pot comes off the heat, and no two steps take the cook's hands
// at once.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { feastRoastDish, feastWarmSteps, isUnattended, KEEP_WARM_STEP, KEEP_WARM_TEXT, OVEN_OFF_STEP, scheduleCookingSequence, type ScheduleResult, type SchedulerDish } from "../cookingScheduler";

const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as Record<string, SchedulerDish[]>;
// Production's Classic after patch.ts (5B), and New Twist at 4 servings (5A's fixture).
const CLASSIC = load("thx3dRound5B.feasts.json")["classic"];
const NEW_TWIST_4 = load("thx3dRound5.feasts.json")["new-twist@4"];

type Placed = { dishId: string; title: string; stepIndex: number; text: string; from: number; to: number; attended: boolean };
function placed(r: ScheduleResult, ds: SchedulerDish[]): Placed[] {
  return r.steps.map((e) => {
    const d = ds.find((x) => x.dishId === e.dishId)!;
    const s = d.steps.find((x) => x.stepIndex === e.originalStepIndex)!;
    const text = s.text ?? "";
    // (The lid, the knob and a side's own rest take no hands, as in carveLate.)
    const attended = !isUnattended(s) && !KEEP_WARM_STEP.test(text) && !OVEN_OFF_STEP.test(text) && !/^\s*Let (?:the [^.;]+?|it|them) rest \d+/i.test(text);
    return { dishId: d.dishId, title: d.title, stepIndex: s.stepIndex, text, from: e.startOffsetMinutes, to: e.startOffsetMinutes + s.estimatedMinutes, attended };
  });
}
const overlaps = (ps: Placed[]) => ps.flatMap((a, i) => ps.slice(i + 1).filter((b) => a.attended && b.attended && a.to > a.from && b.to > b.from && a.from < b.to && b.from < a.to).map((b) => `${a.title} #${a.stepIndex} × ${b.title} #${b.stepIndex}`));
const serveOf = (ps: Placed[]) => ps.find((p) => /^Serve the .+ with the /.test(p.text))!;
const carveWait = (ps: Placed[], ds: SchedulerDish[]) => {
  const bird = feastRoastDish(ds)!;
  const carve = ps.find((p) => p.dishId === bird.dishId && /^Carve\b/.test(p.text))!;
  return serveOf(ps).from - carve.to;
};

describe("THX-3d round 5 (BUG-521) — Classic's potatoes and gravy", () => {
  const r = scheduleCookingSequence(CLASSIC, { feastOven: true });
  const ps = placed(r, CLASSIC);
  const serve = serveOf(ps);
  const step = (title: RegExp, text: RegExp) => ps.find((p) => title.test(p.title) && text.test(p.text))!;

  it("the potatoes are covered over the lowest heat as they are mashed, and go into the serving bowl within 15 minutes of serving", () => {
    const warm = step(/Mashed Potatoes/, KEEP_WARM_STEP);
    const season = step(/Mashed Potatoes/, /^Stir in the warm milk/);
    const bowl = step(/Mashed Potatoes/, /serving bowl/);
    assert.ok(warm, "the keep-warm is kept");
    assert.equal(warm.from, season.to, "covered as the seasoning ends");
    assert.ok(serve.from - bowl.from <= 15, `into the bowl at T${bowl.from}, serving at T${serve.from}`);
  });

  it("the gravy is covered as its simmer ends, though the carve moved the simmer", () => {
    const simmer = step(/Pan Gravy/, /^Gradually whisk in the stock/);
    const warm = step(/Pan Gravy/, KEEP_WARM_STEP);
    assert.ok(warm, "the keep-warm is kept: the simmer ends more than 15 minutes before serving");
    assert.equal(warm.from, simmer.to);
  });

  it("no two steps take the cook's hands at once; the carved bird waits no more than 10", () => {
    assert.deepEqual(overlaps(ps), []);
    assert.ok(carveWait(ps, CLASSIC) <= 10, `carve waits ${carveWait(ps, CLASSIC)}`);
  });
});

describe("THX-3d round 5 (BUG-521, D-WS9-322 (1)) — New Twist at 4: twelve minutes of plating after the carve", () => {
  it("serving moves later rather than the carve waiting or two platings sharing the hands", () => {
    const r = scheduleCookingSequence(NEW_TWIST_4, { feastOven: true });
    const ps = placed(r, NEW_TWIST_4);
    assert.deepEqual(overlaps(ps), []);
    assert.ok(carveWait(ps, NEW_TWIST_4) <= 10, `carve waits ${carveWait(ps, NEW_TWIST_4)}`);
    assert.ok(r.totalEstimatedMinutes <= 185, `total ${r.totalEstimatedMinutes} (dump5: 185)`);
  });
});

describe("THX-3d round 5 (BUG-521) — a side's own rest takes no hands", () => {
  it("Vegetarian at 4: the mac and cheese rests beside the potatoes' and the sprouts' plating (it had pushed both six minutes earlier)", () => {
    const ds = load("thx3dRound5B.feasts.json")["vegetarian@4"];
    const ps = placed(scheduleCookingSequence(ds, { feastOven: true }), ds);
    const serve = serveOf(ps);
    const bowl = ps.find((p) => /Mashed Potatoes/.test(p.title) && /serving bowl/.test(p.text))!;
    const platter = ps.find((p) => /Brussels/.test(p.title) && /serving platter/.test(p.text))!;
    assert.ok(serve.from - bowl.from <= 4 && serve.from - platter.from <= 4, `bowl T${bowl.from}, platter T${platter.from}, serving T${serve.from}`);
    assert.deepEqual(overlaps(ps), []);
  });
  it("Vegetarian at 10: the mac's rest, moved late, still takes no hands (the potatoes went into the bowl at T−17)", () => {
    const ds = load("thx3dRound5.feasts.json")["vegetarian"];
    const ps = placed(scheduleCookingSequence(ds, { feastOven: true }), ds);
    const serve = serveOf(ps);
    const bowl = ps.find((p) => /Mashed Potatoes/.test(p.title) && /serving bowl/.test(p.text))!;
    assert.ok(serve.from - bowl.from <= 4, `bowl T${bowl.from}, serving T${serve.from}`);
    assert.deepEqual(overlaps(ps), []);
  });
});

describe("THX-3d round 5 (BUG-521) — feastWarmSteps plates a kept side at serving", () => {
  const d = (dishId: string, steps: [number, string, number, string][]): SchedulerDish => ({ dishId, title: dishId, positionIndex: 0, roleLabel: null, steps: steps.map(([stepIndex, phaseType, estimatedMinutes, text]) => ({ stepIndex, phaseType: phaseType as never, estimatedMinutes, text, isTimingSensitive: false, parallelGroup: null, componentKey: null, pathKey: null })) });
  const at = (dishId: string, i: number, t: number) => ({ dishId, originalStepIndex: i, sequenceIndex: 0, startOffsetMinutes: t });
  const mash = d("mash", [[0, "cook", 20, "Boil the potatoes."], [1, "assemble", 1, KEEP_WARM_TEXT], [2, "assemble", 2, "Transfer the potatoes to a warm serving bowl."]]);
  // The cook's work before serving: `minutes` of it, ending as serving starts (T−2).
  const turkey = (minutes: number) => d("turkey", [[0, "assemble", minutes, "Carve the turkey and finish the gravy."], [1, "assemble", 2, "Serve the Turkey with the mash."]]);
  const res = (minutes: number) => ({ steps: [at("mash", 0, -60), at("mash", 1, -40), at("mash", 2, -39), at("turkey", 0, -2 - minutes), at("turkey", 1, -2)], totalEstimatedMinutes: 60, activeEstimatedMinutes: 30, dishDurations: {}, ignoredTags: [] }) as ScheduleResult;
  const start = (r: ScheduleResult, dishId: string, i: number) => r.steps.find((s) => s.dishId === dishId && s.originalStepIndex === i)!.startOffsetMinutes;

  it("into the latest moment the hands are free within 15 minutes of serving: the day keeps its length", () => {
    const w = feastWarmSteps(res(10), [mash, turkey(10)]).result;
    assert.equal(start(w, "mash", 2), -14);
    assert.equal(w.totalEstimatedMinutes, 60);
  });
  it("only the plating moves: a keep-warm written before the drain (a dev copy older than round 3) leaves the drain and mash where they are", () => {
    const early = d("mash", [[0, "cook", 20, "Boil the potatoes."], [1, "assemble", 1, KEEP_WARM_TEXT], [2, "assemble", 5, "Drain the potatoes and mash them."], [3, "assemble", 2, "Transfer the potatoes to a warm serving bowl."]]);
    const r = { steps: [at("mash", 0, -60), at("mash", 1, -40), at("mash", 2, -39), at("mash", 3, -34), at("turkey", 0, -18), at("turkey", 1, -2)], totalEstimatedMinutes: 60, activeEstimatedMinutes: 30, dishDurations: {}, ignoredTags: [] } as ScheduleResult;
    const w = feastWarmSteps(r, [early, turkey(16)]).result;
    assert.equal(start(w, "mash", 2), -41, "the drain stays (everything before serving moved earlier by the plating's 2)");
    assert.equal(start(w, "mash", 3), -4);
    assert.equal(w.totalEstimatedMinutes, 62);
  });
  it("hands never free there: right before the serve step, which moves later by its minutes", () => {
    const w = feastWarmSteps(res(16), [mash, turkey(16)]).result;
    assert.equal(start(w, "mash", 2), -4);
    assert.equal(start(w, "turkey", 1), -2);
    assert.equal(start(w, "turkey", 0), -20, "the work before serving moves earlier with everything else");
    assert.equal(w.totalEstimatedMinutes, 62);
  });
});
