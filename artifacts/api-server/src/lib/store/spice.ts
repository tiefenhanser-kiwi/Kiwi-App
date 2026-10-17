// FIX-2 (Part D) — "nothing too spicy": keep clearly hot meals off a shelf.
//
// THE SIGNAL. The catalog has no heat column and no heat tag (Meal.tags is the
// cuisine and the difficulty only; 0 of 1,325 dinners tagged "spicy", measured
// on dev October 17). What it has is words: the catalog spine names its hot
// versions ("Spicy Arrabbiata Spaghetti and Meatballs", "Spicy Szechuan Beef and
// Broccoli"), and hot dishes carry their names ("Kung Pao", "Vindaloo",
// "Nashville Hot"). So the filter reads the TITLE and the DESCRIPTION for the
// words of unmistakable heat. It is a word list, so it is a floor, not a
// guarantee: a hot dish whose title and description name no heat passes. The
// FIX-2 report measures how many it catches and what a sample of the misses
// looks like.
//
// "Too spicy" is the bar, not "any chili": chipotle, jalapeño and Cajun read as
// moderate in this catalog ("Smoky Chipotle Chicken Burrito Bowl", "Pickled
// Jalapeños" on a side) and are NOT excluded; that is a choice the report
// names, not an accident.

import type { Prisma } from "@prisma/client";

/** Words that mean real heat wherever they appear in a title or description. */
export const HOT_WORDS: readonly string[] = [
  "spicy",
  "fiery",
  "arrabbiata",
  "diablo",
  "diavolo",
  "kung pao",
  "szechuan",
  "sichuan",
  "vindaloo",
  "buffalo",
  "sriracha",
  "habanero",
  "firecracker",
  "gochujang",
  "chili crisp",
  "nashville hot",
  "hot chicken",
  "jerk",
  "ghost pepper",
  "scotch bonnet",
  "mapo",
  "dan dan",
  "hot and sour",
  "hot & sour",
  "chili oil",
  "tom yum",
  "red curry",
  "green curry",
  "jungle curry",
  "piri piri",
  "peri peri",
  "harissa",
  "nduja",
  "'nduja",
];

const HOT_RE = new RegExp(`\\b(?:${HOT_WORDS.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i");

/** True when a title or description names unmistakable heat. */
export function isTooSpicy(title: string, description?: string | null): boolean {
  return HOT_RE.test(title) || (description ? HOT_RE.test(description) : false);
}

/**
 * The Prisma condition that keeps those meals out of a query. Returned as ONE
 * entry for an `AND` array (the shelf's where already carries a NOT).
 */
export function notTooSpicyWhere(): Prisma.MealWhereInput {
  return {
    NOT: {
      OR: HOT_WORDS.flatMap((w) => [
        { title: { contains: w, mode: "insensitive" as const } },
        { description: { contains: w, mode: "insensitive" as const } },
      ]),
    },
  };
}
