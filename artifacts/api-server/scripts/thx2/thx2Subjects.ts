// THX-3d round 2 (K) — EVERY STEP NAMES ITS SUBJECT (content, patch.ts, no AI).
//
// Thursday's Cook Mode interleaves the dishes, so the step on the screen before "Toss
// them with ¼ cup flour" is another dish's. On the day, a step that opens with a pronoun
// ("them", "it", "the mixture") or with no object at all ("Transfer to a platter",
// "Remove from heat") names its dish: "Transfer the mashed potatoes to a large warmed
// serving bowl", "Return the Herb Stuffing, uncovered, to the 425°F oven …". The
// make-ahead days are not interleaved (the Hub opens one dish), so they are left as
// written. Idempotent: a named step no longer matches.

import { isReheatStep, ovenTempOfText, reheatText } from "../../src/lib/cookingScheduler";
import { onTheDaySteps } from "../../src/lib/mealTiming";
import type { OvenDish, OvenStepRow } from "./thx2Oven";
import type { ThursdayEdits } from "./thx2Thursday";

const DAY_PREFIX = /^(\s*On [A-Za-z]+day:\s*)/;

/** The dish as a cook calls it on the day: "the mashed potatoes", "the green beans", "the mac and cheese". */
export function dayNoun(title: string): string {
  // No cut word: "the smashed potatoes" is a cut food to THX-3c's naming (it would add
  // "3 lb" on the next run); "the potatoes" on the platter is the dish.
  let words = title.split(/\s+with\s+/i)[0].split(/\s+/).filter((w) => !/-/.test(w) && !/ed$/i.test(w));
  if (words.length > 2 && /^(?:balsamic)$/i.test(words[0])) words = words.slice(1);
  if (words.length > 3) words = words.slice(-1);
  return `the ${words.join(" ").toLowerCase().replace(/\bbrussels\b/, "Brussels")}`;
}

export function subjectEdits(dishes: readonly OvenDish[], steps: readonly OvenStepRow[]): ThursdayEdits {
  const out: ThursdayEdits = { updates: [], deletes: [], creates: [], renumber: [] };
  for (const d of dishes) {
    const rows = steps.filter((s) => s.ownerId === d.dishId).sort((a, b) => a.stepIndex - b.stepIndex);
    const day = onTheDaySteps(rows.map((r) => ({ ...r, text: r.stepTextTranslated })));
    const noun = dayNoun(d.title);
    for (const r of day) {
      let text = r.text;
      // The code-written reheat: THX-3c wrote "Return it, uncovered, …".
      if (isReheatStep({ text }) && /^\s*Return it\b/i.test(text.replace(DAY_PREFIX, ""))) {
        const t = ovenTempOfText(text);
        if (t !== null) text = `${DAY_PREFIX.exec(text)?.[1] ?? ""}${reheatText(d.title, t)}`;
      } else {
        const prefix = DAY_PREFIX.exec(text)?.[1] ?? "";
        const body = text.slice(prefix.length);
        const named = body
          .replace(/^(\w+)\s+(?:them|it)\b/i, `$1 ${noun}`)
          .replace(/^(\w+)\s+the mixture\b/i, `$1 ${noun}`)
          .replace(/^(Transfer|Pour|Spoon|Scrape|Return|Remove)\s+(?=(?:to|into|onto|from)\b)/i, `$1 ${noun} `)
          // THX-3d 3b — "Let rest 5 minutes" (production's mac and cheese, its serve clause gone).
          .replace(/^Let\s+(?=(?:rest|cool|stand|sit)\b)/i, `Let ${noun} `);
        text = `${prefix}${named}`;
      }
      if (text !== r.text) out.updates.push({ dishId: d.dishId, stepIndex: r.stepIndex, text });
    }
  }
  return out;
}
