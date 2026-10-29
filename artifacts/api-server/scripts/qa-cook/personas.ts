// QA-COOK-1 — the AI home cooks.
//
// Three personas follow ONE Cook Mode session one step at a time, the way the
// app shows it: each turn is the next step's card (appView.ts stepCard: the
// dish label, the minutes, the cue, the text, the "You prepped this" chips), and
// the cook cannot see ahead. Each reply is a short log of the kitchen (what's on,
// what's in hand, what's waiting) and any problem a real cook would hit at that
// step, as JSON (structured output). After the last step the cook is told to
// serve and says what the food is like.
//
// The conversation is append-only (thinking blocks are passed back unchanged)
// and auto-cached, so a turn pays full price only for its own step. The price of
// every call is read from its own usage (cache writes ×1.25, reads ×0.1).
import Anthropic from "@anthropic-ai/sdk";

import { stepCard } from "./appView";
import { rng } from "./sample";
import type { CookView, PersonaId, PersonaIssue, PersonaRun, Severity } from "./types";

/** $ per million tokens: input, output (Claude API list prices). */
export const PRICES: Record<string, { in: number; out: number }> = {
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-opus-5-5": { in: 4, out: 20 },
};

export function priceOf(model: string, u: Anthropic.Usage): number {
  const p = PRICES[model];
  if (!p) throw new Error(`no price for ${model}`);
  const input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) * 1.25 + (u.cache_read_input_tokens ?? 0) * 0.1;
  return (input * p.in + (u.output_tokens ?? 0) * p.out) / 1e6;
}

const ISSUE_TYPES = ["unclear", "impossible", "bad-for-food", "held-too-long", "two-at-once", "missing", "order", "equipment"] as const;

const TURN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["state", "issues"],
  properties: {
    state: { type: "string", description: "One line: what's on the burners and in the oven, what's in your hands, what's finished and waiting (and for how many minutes)." },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["step", "quote", "type", "what_went_wrong", "severity", "suggested_rewrite"],
        properties: {
          step: { type: "integer", description: "The step number the problem is about." },
          quote: { type: "string", description: "The step's own words, exactly." },
          type: { type: "string", enum: [...ISSUE_TYPES] },
          what_went_wrong: { type: "string" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          suggested_rewrite: { type: "string", description: "The step (or steps) as the app should have written them." },
        },
      },
    },
  },
} as const;

const COMMON = `You are a home cook making dinner with a recipe app called Kiwi, in its Cook Mode. The app shows you ONE step at a time and you cannot see the steps ahead. Each turn you get the next step, exactly as the screen shows it: "Step N of M", the dish it belongs to, the app's time estimate, sometimes a tip, the instruction, and sometimes a "You prepped this" note for something you made earlier in the week.

Do what each step says, in the order shown, as soon as you reach it. Keep your own clock from the time estimates. When a step is started and left on its own (a simmer, a bake, a marinade, a rest), you move on to the next step while it runs. When a step needs you at the stove, you stay with it until it is done. Nobody else is cooking.

After each step, reply with:
- state: one short line about your kitchen right now: what is on each burner and in the oven, what is in your hands, and what is finished and waiting (and for how many minutes).
- issues: the problems a real cook would have at THIS point. Most steps have none, and then the list is empty.

Report a problem when:
- the step is unclear, or you cannot tell how to do it (unclear);
- it is impossible with your kitchen, your burners, or your two hands (impossible, equipment);
- doing it as written hurts the food: burned, overcooked, cold, soggy, dried out (bad-for-food);
- something you finished earlier has been sitting and is cold, soggy or dry, or will be by the time you serve (held-too-long);
- the app has you doing two hands-on things at once, or doing knife or board work while a pan on the heat needs you (two-at-once);
- the step uses something you never made, or never made that way (missing). Things a recipe can call for ready-made (guacamole, salsa, pico de gallo, shredded cheese, sour cream, a bottled sauce) you bought: they are not missing. A food a step calls "chopped" or "sliced" when no step chopped or sliced it is worth a low note;
- the order makes no sense: something should have come earlier or later (order).

Report what changes the food or what you would do. Skip wording nitpicks and taste preferences. Put the step's exact words in "quote", and in "suggested_rewrite" write the step, or steps, as the app should have said them. When you are told to serve, check everything that is waiting and report anything that is no longer as it should be.`;

export const PERSONAS: Record<PersonaId, { label: string; prompt: string }> = {
  beginner: {
    label: "a nervous beginner",
    prompt: `${COMMON}

Who you are: a nervous beginner. Your kitchen has ONE big skillet, one saucepan, one sheet pan, an oven, and only 2 working burners. You read each step literally and do only what it says, nothing more. You don't know cooking tricks: if no step tells you to keep something warm, you leave it where it is. When you are at the stove and the next step asks you to chop or measure, you worry about what is on the heat behind you, and you say so.`,
  },
  weeknight: {
    label: "a confident weeknight cook",
    prompt: `${COMMON}

Who you are: a confident weeknight cook. Your kitchen is a normal one: 4 burners, one oven, two skillets, two saucepans, a big pot and two sheet pans. You multitask when the app tells you to and you know the usual tricks, but you notice when the app's order wastes your time, leaves you standing idle, or hurts the food, and you say how it should go.`,
  },
  interrupted: {
    label: "a parent who gets interrupted",
    prompt: `${COMMON}

Who you are: a parent cooking while the kids need you. Your kitchen is a normal one: 4 burners, one oven, two skillets, saucepans, a big pot. Sometimes a turn tells you that you were called away for 2 minutes: whatever was cooking kept cooking without you, nobody stirred or flipped it, and nothing was turned down. Say what those 2 minutes did to the food. Also point out steps where even a short interruption would ruin something and the app gave no warning.`,
  },
};

export interface PersonaOptions {
  model: string;
  effort?: "low" | "medium" | "high";
  /** Hard ceiling per run: stop the run when it is passed. */
  maxRunUsd?: number;
  seed?: number;
}

/** Steps after which the interrupted parent is called away (about one in six, never step 1). */
export function interruptionsFor(v: CookView, seed: number): Set<number> {
  const key = `${v.sourceMealId}|${v.servings}|${v.prepped}`;
  let h = seed >>> 0;
  for (const ch of key) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  const rand = rng(h);
  const live = v.steps.filter((s) => !s.doneInPrep && s.n > 1).map((s) => s.n);
  const k = Math.max(1, Math.round(live.length / 6));
  const out = new Set<number>();
  while (out.size < Math.min(k, live.length)) out.add(live[Math.floor(rand() * live.length)]);
  return out;
}

function header(v: CookView, persona: PersonaId): string {
  return `You are making "${v.title}" for ${v.servings}. ${v.prepped ? "You did Prep the Week earlier this week: some steps are folded as \"Done in prep\" and some say what you prepped." : "You did no prep ahead: everything is done tonight."} There are ${v.steps.length} steps.${persona === "beginner" ? " Remember: one big skillet, 2 burners." : ""} Here is step 1.`;
}

export async function runPersona(client: Anthropic, v: CookView, persona: PersonaId, opts: PersonaOptions): Promise<PersonaRun> {
  const t0 = Date.now();
  const out: PersonaRun = {
    persona, model: opts.model,
    view: { sourceMealId: v.sourceMealId, title: v.title, servings: v.servings, prepped: v.prepped },
    issues: [], log: [], usd: 0, calls: 0, ms: 0,
  };
  const away = persona === "interrupted" ? interruptionsFor(v, opts.seed ?? 1028) : new Set<number>();
  const messages: Anthropic.MessageParam[] = [];
  const turns: string[] = v.steps.map((s, i) => {
    const pre = i === 0 ? `${header(v, persona)}\n\n` : "";
    const awayNote = away.has(s.n) ? "\n\n(Right after you started this step you were called away for 2 minutes. Everything on the heat kept going without you.)" : "";
    return `${pre}${stepCard(v, s)}${awayNote}`;
  });
  turns.push("That was the last step. You are serving now. Look at everything that is finished and waiting: is anything cold, soggy, overcooked, dried out or forgotten? Report it (use the step number where the problem started).");

  try {
    for (const turn of turns) {
      messages.push({ role: "user", content: turn });
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: 4000,
        system: PERSONAS[persona].prompt,
        cache_control: { type: "ephemeral" },
        output_config: { effort: opts.effort ?? "low", format: { type: "json_schema", schema: TURN_SCHEMA as never } },
        messages,
      });
      out.calls++;
      out.usd += priceOf(opts.model, res.usage);
      messages.push({ role: "assistant", content: res.content });
      if (res.stop_reason === "refusal") throw new Error(`refusal: ${JSON.stringify(res.stop_details ?? null)}`);
      const text = res.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("");
      let parsed: { state: string; issues: { step: number; quote: string; type: string; what_went_wrong: string; severity: Severity; suggested_rewrite: string }[] };
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`unparsable turn (${res.stop_reason}): ${text.slice(0, 200)}`);
      }
      out.log.push(parsed.state);
      for (const i of parsed.issues ?? []) {
        out.issues.push({ step: i.step, quote: i.quote, type: i.type, whatWentWrong: i.what_went_wrong, severity: i.severity, suggestedRewrite: i.suggested_rewrite });
      }
      if (opts.maxRunUsd && out.usd > opts.maxRunUsd) throw new Error(`run ceiling $${opts.maxRunUsd} passed`);
    }
  } catch (e) {
    out.error = String((e as Error).message ?? e).slice(0, 400);
  }
  out.ms = Date.now() - t0;
  return out;
}

/** Did a run catch the fajita case: the tortillas left out early, or the lime cut amid the stove work? */
export function caughtFajita(run: PersonaRun): PersonaIssue[] {
  return run.issues.filter((i) => {
    const t = `${i.quote} ${i.whatWentWrong}`.toLowerCase();
    const tortilla = /tortilla/.test(t) && /\b(cold|cool|cooled|cooling|stiff|sit|sitting|waiting|wait|held|towel|wrap|warm|early|long)\b/.test(t);
    const lime = /\blime/.test(t) && /\b(stove|heat|pan|skillet|burn|while|oil|tortilla|attention|two)\b/.test(t);
    return tortilla || lime;
  });
}

/** Run `fn` over `xs` with at most `n` in flight; results in input order. */
export async function pool<T, R>(xs: T[], n: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await fn(xs[i], i);
    }
  }));
  return out;
}
