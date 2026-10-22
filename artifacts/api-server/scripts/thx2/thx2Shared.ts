// THX-3d round 3 (T) — ONE OVEN TEMPERATURE WITH THE BIRD (Hans, Oct 22).
//
// New Twist's stuffing and smashed potatoes (350°F) baked hours before the spatchcock
// (425°F), sat covered and were reheated. Hans approved baking them WITH the bird, but a
// stuffing written for 350°F browns or dries on top at 425°F, so the shared temperature
// is 400°F, and each dish's time at 400°F is written in (his numbers, not the baker's
// rule): the bird about 10% longer, still to 165°F in the thigh; the stuffing covered
// 30 minutes (the foil protects the top), then uncovered 10–12 until golden; the
// potatoes 20 minutes, then the Parmesan 5 more; the sweet potatoes' hotter option read
// at 400°F, 35–40 minutes. A side's own preheat to another temperature goes: the bird's
// oven is at 400°F already (the potatoes keep their parchment, as a prep step).
//
// The post-pass then puts the sides in WITH the bird (thx2Thursday, "Put the … in the
// oven with the turkey."), so they finish just before its rest ends.
//
// Pure text on the THX-3c sentences; a sentence already rewritten matches nothing, so
// a second run changes nothing.

import { retimeForTemp } from "./thx2Oven";

export interface SharedEdit {
  text: string;
  minutes?: number;
  phaseType?: "prep" | "preheat" | "cook";
}

interface DishRule {
  title: RegExp;
  edit: (text: string, minutes: number) => SharedEdit | null;
}

interface SharedOven {
  temp: number;
  dishes: DishRule[];
}

/** "N–M minutes" → its upper bound. */
const upper = (text: string): number | null => {
  const m = /\b(\d+)(?:\s*(?:–|-|to)\s*(\d+))?\s*minutes?\b/.exec(text);
  return m ? Number(m[2] ?? m[1]) : null;
};

export const SHARED_OVEN: Readonly<Record<string, SharedOven>> = {
  "thx2-feast-new-twist": {
    temp: 400,
    dishes: [
      {
        // The bird: its preheat and its roast move to 400°F, the roast about 10% longer.
        title: /\bspatchcock turkey\b/i,
        edit: (text, minutes) => {
          if (!/\b425\s*°\s*F\b/.test(text)) return null;
          if (/^\s*(?:On [A-Za-z]+day:\s*)?Preheat\b/i.test(text)) return { text: text.replace(/\b425(\s*°\s*F)/, "400$1") };
          const r = retimeForTemp(text, 425, 400);
          return { text: r.text, minutes: Math.max(1, minutes + r.extraMinutes) };
        },
      },
      {
        // Covered 30 minutes, then uncovered 10–12 until golden.
        title: /\bstuffing\b/i,
        edit: (text) => {
          if (!/\b350\s*°\s*F oven for 30 minutes, then uncover and bake 15–20 minutes more\b/.test(text)) return null;
          const next = text.replace(/\b350(\s*°\s*F oven for 30 minutes, then uncover and bake )15–20( minutes more)/, "400$110–12$2");
          return { text: next, minutes: 42 };
        },
      },
      {
        // 20 minutes, then the Parmesan 5 more; the preheat goes (the bird's oven is hot).
        title: /\bsmashed potatoes\b/i,
        edit: (text) => {
          const pre = /^\s*Preheat the oven to 350\s*°\s*F(?:\s*\([^)]*\))? and (line .+)$/i.exec(text);
          if (pre) return { text: `${pre[1].charAt(0).toUpperCase()}${pre[1].slice(1)}`, minutes: 2, phaseType: "prep" };
          if (!/\bRoast at 350\s*°\s*F for 20 minutes\b/i.test(text)) return null;
          const next = text.replace(/\b350(\s*°\s*F for 20 minutes)/, "400$1").replace(/\broast 5–8 minutes more\b/i, "roast 5 minutes more");
          return { text: next, minutes: 25 };
        },
      },
      {
        // The hotter option, read at 400°F: 35–40 minutes.
        title: /\bsweet potatoes\b/i,
        edit: (text) => {
          if (/^\s*(?:On [A-Za-z]+day:\s*)?Preheat the oven to 425\s*°\s*F\b/i.test(text)) return { text: "Preheat the oven to 400°F." };
          const opt = /\bat 350\s*°\s*F for 45–50 minutes \(or 425\s*°\s*F for 30–35 minutes\)/i;
          if (!opt.test(text)) return null;
          const next = text.replace(opt, "at 400°F for 35–40 minutes");
          return { text: next, minutes: upper("35–40 minutes")! };
        },
      },
    ],
  },
};

/** The shared-oven rewrite of one step of one dish, or null (another feast, another dish, or done). */
export function sharedOvenEdit(feastKey: string, dishTitle: string, text: string, minutes: number): SharedEdit | null {
  const spec = SHARED_OVEN[feastKey];
  const rule = spec?.dishes.find((d) => d.title.test(dishTitle));
  return rule ? rule.edit(text, minutes) : null;
}
