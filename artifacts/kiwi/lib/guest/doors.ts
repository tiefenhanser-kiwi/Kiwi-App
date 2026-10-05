// Row 13 "Test Kitchen" · Block 2 Part D (R4, R5, R6) — THE DOOR.
//
// Hans's ruling, and the whole shape of the guest experience: "free to read;
// every action is a door." A guest may open candidates, the plan, meals and full
// recipes. Every write-shaped action — the grocery list, Order Online, save /
// edit / swap / add meals, Prep & Cook, a second generation, the playlist,
// anything under Profile — opens ONE shared sheet INSTEAD of acting.
//
// 🔴 THE GUARD IS A TABLE, NOT A CALLSITE HABIT. The failure mode this file
// exists to prevent is the twentieth CTA — the one someone adds in Block 4 and
// forgets to wrap. Every guest-reachable action is named here with its shape, so
// a new action is a row in this table and a compile error at the callsite if it
// is not. And because it is a table, the test can assert the invariant over ALL
// of it: for a guest, every write is a door, with no exceptions.
//
// Reads are `write: false` and listed too, so the table doubles as the answer to
// "what is a guest actually allowed to do?" — which is otherwise spread over
// four screens.

export const GUEST_ACTIONS = {
  // ── reads (R4: "I think it's fine to read the full recipe in the plan") ──
  open_plan: { write: false, label: "Open the plan" },
  open_recipe: { write: false, label: "Open the recipe" },
  open_candidate: { write: false, label: "Open a plan option" },

  // ── writes: every one a door ─────────────────────────────────────────────
  grocery_list: { write: true, label: "Grocery list" },
  order_online: { write: true, label: "Order online" },
  save_plan: { write: true, label: "Save this plan" },
  edit_plan: { write: true, label: "Edit this plan" },
  swap_meal: { write: true, label: "Swap a meal" },
  add_meal: { write: true, label: "Add meals" },
  prep_cook: { write: true, label: "Prep & Cook" },
  second_generation: { write: true, label: "Another plan" },
  playlist: { write: true, label: "Playlist" },
  profile: { write: true, label: "Profile" },
  favorite: { write: true, label: "Favourite" },
  /** R6 — the thin shelf. A refusal, and a door, not a failure. */
  thin_shelf: { write: true, label: "The full meal library" },
} as const;

export type GuestAction = keyof typeof GUEST_ACTIONS;

export type GuestGuardVerdict = "allow" | "door";

/**
 * The one decision. `isGuest` false is always "allow" — this guard adds nothing
 * to the member path and must never be able to block it.
 */
export function guestGuard(opts: {
  isGuest: boolean;
  action: GuestAction;
}): GuestGuardVerdict {
  if (!opts.isGuest) return "allow";
  return GUEST_ACTIONS[opts.action].write ? "door" : "allow";
}

/** Every action a guest is refused. Used by the invariant test. */
export function guestDoorActions(): GuestAction[] {
  return (Object.keys(GUEST_ACTIONS) as GuestAction[]).filter(
    (a) => GUEST_ACTIONS[a].write,
  );
}

// ── the door's copy (R5, §8.2–8.3), verbatim where ruled ────────────────────
//
// 🔴 ACCOUNT FIRST, THEN THE APP, and the reason is mechanical rather than
// stylistic: a trip to the App Store loses the guest session (a different
// browser context, and on iOS a different app entirely) and with it the plan the
// visitor just spent ten minutes building. So the primary action creates the
// account — the claim keeps the plan — and the app is a note underneath.
//
// NO PRICE AND NO "TRIAL" WORDING. Payments do not exist yet; a sheet that says
// "start your free trial" promises a thing with no implementation behind it.

export const DOOR_TITLE = "Here's the plan you made";
export const DOOR_INTRO = "Create a free account to keep it. An account gets you:";
export const DOOR_UNLOCKS = [
  "Save, edit and re-use this plan",
  "Unlimited plans",
  "The grocery list and online ordering",
  "Your own meals",
  "Prep & Cook — the order to cook things in",
  "Find and share recipes",
] as const;
export const DOOR_PRIMARY = "Create my free account — save my plan";
export const DOOR_APP_NOTE = "The app comes right after — your plan will be waiting in it.";
export const DOOR_SECONDARY = "Keep looking";
export const DOOR_SIGN_IN = "Already have an account? Sign in";

// ── Resub C1 — the same door, IN the app ────────────────────────────────────
//
// On iOS and Android the visitor is already in the app, and the account is made
// right here — there is no store trip to lose the session on, so "the app comes
// right after" would be untrue. Two lines change; the title, the unlocks, both
// buttons and the sign-in link are the web door's, word for word. Same rule as
// above: no price, no trial wording.
export const DOOR_NATIVE_INTRO =
  "Create a free account to save this plan and keep going. An account gets you:";
export const DOOR_NATIVE_NOTE = "Your plan comes with you — nothing to build again.";

export interface DoorCopy {
  title: string;
  intro: string;
  unlocks: readonly string[];
  primary: string;
  /** The line under the primary button. */
  note: string;
  secondary: string;
  signIn: string;
}

/** The door's copy for this platform: `Platform.OS` in, strings out. */
export function doorCopy(platform: string): DoorCopy {
  const native = platform !== "web";
  return {
    title: DOOR_TITLE,
    intro: native ? DOOR_NATIVE_INTRO : DOOR_INTRO,
    unlocks: DOOR_UNLOCKS,
    primary: DOOR_PRIMARY,
    note: native ? DOOR_NATIVE_NOTE : DOOR_APP_NOTE,
    secondary: DOOR_SECONDARY,
    signIn: DOOR_SIGN_IN,
  };
}

// R6 — the thin shelf reuses ExhaustedCard (its third consumer) with Hans's
// copy, and a SIGN-UP exit rather than the Tell Kiwi exit.
export const THIN_SHELF_TITLE =
  "Access to the full Kiwi meal library and meals that meet unique dietary needs and preferences is available in the app — sign up here.";
export const THIN_SHELF_CTA = "Sign up";
