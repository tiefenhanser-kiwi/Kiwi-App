// THX-3d round 2 (M, as Hans ruled Oct 22) — A CUT HELD FOR COOK DAY IS DONE IN THE
// MORNING, AND SAYS HOW IT WAITS.
//
// Prep holds a cut that would not keep ("cut the Russet potatoes that morning"). On the
// cook day that cut is a step, done early — in the first free window, not timed to the
// pot (the scheduler moves it: `HELD_MORNING_STEP`) — and its words say how the food
// waits, by what comes next. Hans: "mashed potatoes (peeled and cut) and roasted
// potatoes (washed and possibly cut) can get prepped 'in the morning' a few hours ahead
// of cooking and sit in a fridge without turning brown if they're in water or have oil
// applied. For mashed potatoes it's common practice to peel and cut them, put them in a
// pot on the stove, and wait until you're ready to turn on the burner… the oil stops the
// air from turning them brown."
//
//   boiled    the cut puts them in the recipe's own pot and water, and leaves the pot on
//             the stove, off; the recipe's "Place the potatoes in a pot, cover with cold
//             water" becomes "Turn the burner on under the pot of potatoes".
//   tossed    the recipe's oil-and-seasoning toss joins the morning ("…; they can sit,
//             covered, in the fridge for a few hours"); the spread onto the pan stays
//             with the oven.
//   browns    anything else that browns waits in cold water.
//   garnish   a herb for the top waits covered in a small container.
//   other     waits covered in the fridge.
//
// Pure text, no AI: scripts/thx2/patch.ts writes it into the catalog feasts (item 16),
// and the weeknight read path (heldCookDaySteps) words a plan's held cuts with it.

// The words that end a morning step, and the scheduler's marker for "do this early"
// (HELD_MORNING_STEP), live in the dependency-free scheduler.
import { HOLD_BOILED, HOLD_BROWNS, HOLD_GARNISH, HOLD_OTHER, HOLD_OTHER_PLURAL, HOLD_TOSSED } from "./cookingScheduler";
import { formatMeasure } from "./prepWeekAssembly";

export { HELD_MORNING_STEP } from "./cookingScheduler";

/** A run prefix the steps carry ("Make ahead (Wednesday): ", "On Thursday: "). */
export const RUN_PREFIX = /^\s*(?:Make ahead \([A-Za-z]+(?: night)?\)|On [A-Za-z]+day)\s*:\s*/i;

const BROWNS = /\b(?:potato(?:es)?|apples?|pears?)\b/i;
/**
 * PREP-3 (R8) — never a morning cut: an avocado is cut at its own step. Held in cold
 * water it is waterlogged and still brown by the mash (hh4-mixed Tuesday scooped three
 * at T−64 for a guacamole mashed at T−20).
 */
export const CUT_AT_THE_STEP = /\bavocados?\b/i;
/** PREP-3 (R8) — a weeknight cut the dish uses within its first minutes is just a step of it. */
export const MORNING_MIN_LEAD = 10;
const HERB = /\b(?:parsley|cilantro|chives|basil|mint|dill|scallions?|green onions?|tarragon|chervil)\b/i;

export const splitPrefix = (text: string): { prefix: string; body: string } => {
  const prefix = RUN_PREFIX.exec(text)?.[0] ?? "";
  return { prefix, body: text.slice(prefix.length) };
};

const PARTICIPLES: Record<string, string> = {
  peeled: "peel", cut: "cut", sliced: "slice", diced: "dice", chopped: "chop", minced: "mince", cubed: "cube",
  halved: "halve", quartered: "quarter", trimmed: "trim", grated: "grate", scrubbed: "scrub", cored: "core", seeded: "seed",
  juiced: "juice", zested: "zest",
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "5 pound russet potatoes, peeled and cut into 2-inch chunks" → "Peel and cut 5 lb russet potatoes into 2-inch chunks." Null when there is nothing to cut. How the cut waits is the hold's, by what comes next. */
export function cutSentence(row: { quantity: number; unit: string; name: string; note: string | null }): string | null {
  const note = (row.note ?? "").split(/,\s*(?:for|to)\b|\(/i)[0].trim().toLowerCase();
  const m = /^((?:(?:finely|thinly|roughly|coarsely)\s+)?[a-z]+(?:(?:,\s*|\s+and\s+)(?:(?:finely|thinly|roughly|coarsely)\s+)?[a-z]+)*)(.*)$/.exec(note);
  if (!m) return null;
  const words = m[1].split(/(?:,\s*|\s+and\s+)/);
  const verbs = words.map((w) => {
    const [adv, part] = /\s/.test(w) ? w.split(/\s+/) : ["", w];
    const v = PARTICIPLES[part];
    return v ? `${adv ? `${adv} ` : ""}${v}` : null;
  });
  if (verbs.length === 0 || verbs.some((v) => v === null)) return null;
  const list = verbs.length === 1 ? verbs[0]! : `${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]}`;
  const amount = formatMeasure(row.quantity, row.unit, row.name, { asWritten: true });
  const name = row.name.toLowerCase().split(/[,(]/)[0].trim();
  const rest = m[2].trim();
  return `${cap(list)} ${amount} ${name}${rest ? ` ${rest}` : ""}.`;
}

/** True when a step already cuts this food (a cut verb, then its head word, in one clause). */
export function alreadyCut(texts: readonly string[], name: string): boolean {
  const head = name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop()!.replace(/(?:es|s)$/, "");
  return texts.some((t) => new RegExp(`\\b(?:peel|cut|slice|dice|chop|mince|grate|core|scrub|halve|quarter|trim|cube|juice|zest)\\b[^.;]{0,80}\\b${head}`, "i").test(t));
}

/** The food's head word, singular ("Russet potatoes" → "potato"). */
export const headOf = (name: string): string =>
  name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop()!.replace(/(?:es|s)$/, "");

/** What the pot holds, said after "the pot of": "potatoes", "sweet potatoes". */
export function potNoun(name: string): string {
  const n = name.toLowerCase();
  if (/\bsweet potato/.test(n)) return "sweet potatoes";
  if (/\bpotato/.test(n)) return "potatoes";
  return n.split(/[,(]/)[0].trim();
}

/**
 * "Place 5 lb peeled, 2-inch potato chunks in a large pot (at least 8-quart); cover
 * with cold water by 2 inches and add 1 tablespoon kosher salt." — the recipe's pot,
 * its water, what it adds, and what follows ("bring to a boil over high heat").
 */
const PLACE_IN_POT =
  /^(?:Place|Put) (.+?) in (an? (?:large |medium |big |heavy )?(?:pot|saucepan|stockpot|Dutch oven)\b[^,;]*?)(?:,|;| and) (cover (?:them |it )?with cold (?:salted )?water[^,;.]*?)(?:(?:,| and|;) (add [^,;.]+?))?(?:,? and (.+?))?\.\s*$/i;

export function boilPlace(placeBody: string): { food: string; vessel: string; cover: string; add: string | null; rest: string | null } | null {
  const m = PLACE_IN_POT.exec(placeBody.trim());
  return m ? { food: m[1], vessel: m[2], cover: m[3], add: m[4] ?? null, rest: m[5] ?? null } : null;
}

/** The cut's own words, without its period or an older hold ("; keep them in cold water"). */
export const cutBody = (cut: string): string =>
  cut.trim().replace(/\.\s*$/, "").replace(/;\s*keep them in cold water$/i, "");

/** Boiled: the morning step and the step that now only turns the burner on. */
export function boilHold(cut: string | null, placeBody: string, name: string): { held: string; later: string } | null {
  const p = boilPlace(placeBody);
  if (!p) return null;
  const into = `${p.vessel}, ${p.cover}${p.add ? `, ${p.add}` : ""}, ${HOLD_BOILED}.`;
  const held = cut ? `${cutBody(cut)}; put them in ${into}` : `Put ${p.food} in ${into}`;
  const later = `Turn the burner on under the pot of ${potNoun(name)}${p.rest ? ` and ${p.rest}` : ""}.`;
  return { held, later };
}

/** A toss that coats the food ("toss until evenly coated", "toss … with 3 tablespoons olive oil"). */
export const TOSS = /\btoss(?:es|ed)?\b/i;
const OILS = /\b(?:oil|butter)\b/i;

/**
 * Tossed: "Add the cubes to the bowl and toss until evenly coated; spread in a single
 * layer on a rimmed sheet pan." → the toss with its hold, and the spread as its own
 * step; "Toss the chunks on a large rimmed sheet pan with …" → in a large bowl, the pan
 * moving to the spread. `coated` says the bowl or the toss holds oil or butter.
 */
export function tossHold(tossBody: string, name: string): { toss: string; spread: string | null; pan: string | null } | null {
  const body = tossBody.trim().replace(/\.\s*$/, "");
  const [first, ...more] = body.split(/;\s*/);
  if (!TOSS.test(first)) return null;
  const onPan = /\b(?:on|onto) (an? (?:large |big )?(?:rimmed )?(?:sheet pan|baking sheet|roasting pan))\b/i.exec(first);
  const toss = onPan ? first.replace(onPan[0], "in a large bowl") : first;
  const spreadClause = more.find((c) => /^spread\b/i.test(c));
  const others = more.filter((c) => c !== spreadClause);
  const spread = spreadClause ? `Spread the ${potNoun(name)} ${spreadClause.replace(/^spread\s+(?:them\s+|it\s+)?/i, "")}.` : null;
  return { toss: `${[toss, ...others].join("; ")}; ${HOLD_TOSSED}.`, spread, pan: onPan ? onPan[1] : null };
}

/** "Spread [the sweet potatoes] into a single layer; dot…" → on the pan the toss left. */
export function spreadOnPan(spreadBody: string, pan: string, name: string): string {
  if (/\b(?:pan|sheet)\b/i.test(spreadBody.split(";")[0])) return spreadBody;
  return spreadBody.replace(/^Spread(?: (the .+?|them|it))? (?:into|in) a single layer/i, (_m, obj?: string) =>
    `Spread ${obj && /^the /i.test(obj) ? obj : `the ${potNoun(name)}`} on ${pan} in a single layer`);
}

/** Does the toss coat the food — oil or butter in it, or in the bowl a step before it made. */
export const coats = (texts: readonly string[]): boolean => texts.some((t) => OILS.test(t));

/** The hold for a cut that is neither boiled nor tossed next. */
export function plainHold(cut: string, name: string, note: string | null): string {
  const body = cutBody(cut);
  if (BROWNS.test(name)) return `${body}; ${HOLD_BROWNS}.`;
  if (HERB.test(name) || /\bgarnish\b/i.test(note ?? "")) return `${body}; ${HOLD_GARNISH}.`;
  const plural = /s$/i.test(name.toLowerCase().split(/[,(]/)[0].trim());
  return `${body}; ${plural ? HOLD_OTHER_PLURAL : HOLD_OTHER}.`;
}

/** True when the hold for this row is a garnish's (a herb, or a row "for garnish"). */
export const isGarnish = (name: string, note: string | null): boolean => !BROWNS.test(name) && (HERB.test(name) || /\bgarnish\b/i.test(note ?? ""));

/**
 * THX-3d round 3 (U) — a garnish cut in the morning is named, not measured again, where
 * it goes on: "garnish with 2 tablespoons thinly sliced fresh chives" → "garnish with
 * the chives you sliced this morning". The participle is the row's own ("thinly sliced,
 * for garnish" → sliced). Unchanged when the step does not measure the herb.
 */
export function referBack(text: string, name: string, note: string | null): string {
  const head = name.toLowerCase().split(/[,(]/)[0].trim().split(/\s+/).pop() ?? "";
  const verb = /\b(sliced|minced|chopped|diced|snipped|torn)\b/i.exec(note ?? "")?.[1]?.toLowerCase();
  if (!head || !verb) return text;
  const amount = String.raw`(?:[\d½¼¾⅓⅔⅛⅜⅝⅞]+(?:[\s-]*[\d½¼¾⅓⅔⅛⅜⅝⅞/]+)?\s+(?:cups?|tablespoons?|teaspoons?|tbsp|tsp)\s+)?`;
  const cut = String.raw`(?:(?:thinly|finely|roughly|coarsely)\s+)?(?:sliced|minced|chopped|diced|snipped|torn)\s+(?:fresh\s+)?`;
  return text.replace(new RegExp(String.raw`(?<![\w½¼¾⅓⅔⅛⅜⅝⅞])${amount}${cut}${head}\b`, "gi"), `the ${head} you ${verb} this morning`);
}

/** A citrus juiced in the morning is poured where the recipe squeezed it: "squeeze over the juice of ½ lemon" → "pour over the lemon juice". */
export function pourJuice(text: string): string {
  return text.replace(/\bsqueeze (over |in |into )?the juice (?:of|from) (?:an? |a half |½ |¼ |\d+(?:\.\d+)? )?(lemon|lime|orange)s?\b/gi, (m, where: string | undefined, fruit: string) =>
    `${m.charAt(0) === "S" ? "Pour" : "pour"} ${where ?? "in "}the ${fruit.toLowerCase()} juice`);
}
