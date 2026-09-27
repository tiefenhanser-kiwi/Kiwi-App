// Row 13 "Test Kitchen" · Block 2 Part F (R8 / D-WS9-263) — the personalize
// popup's gate.
//
// Two flags, and the asymmetry between them is the whole design:
//
//   SERVER (`showPersonalizeNudge` on GET /home) — per ACCOUNT. It is what makes
//     the nudge show ONCE, and it is what the primary button turns off, through
//     PATCH /me/ui-state { personalizeNudgeDismissed: true }.
//
//   DEVICE (a local-storage flag) — per DEVICE, and set only by "Later". Hans's
//     ruling: "Later" must not make it reappear on THIS device, while the server
//     flag stays unset "so the app shows it once too". A visitor who claims a
//     plan on the web and then installs the app should meet the question once in
//     the app, where answering it is the point.
//
// So the server flag is the account-level "has this been answered", the device
// flag is a per-device "not now", and either one hides it here.

export interface PersonalizeNudgeInputs {
  /** GET /home's `showPersonalizeNudge`. Absent/false ⇒ never show. */
  serverFlag: boolean | undefined;
  /** The local "Later" flag for THIS device. A storage read that threw is
   *  `false` — a nudge shown once too often is better than one never shown. */
  deviceDismissed: boolean;
  /** No nudge over a loading or signed-out Home. */
  hasUser: boolean;
}

export function shouldShowPersonalizeNudge(i: PersonalizeNudgeInputs): boolean {
  if (!i.hasUser) return false;
  if (i.serverFlag !== true) return false;
  return !i.deviceDismissed;
}

/** The device flag's key, through lib/storage.ts (which prefixes "kiwi:"). */
export const PERSONALIZE_NUDGE_DEVICE_KEY = "personalizeNudgeLater";

// ── copy, ruled word for word (R8) ─────────────────────────────────────────
// 🔴 DO NOT EDIT WITHOUT A RULING. These four strings are quoted verbatim in the
// block prompt and pinned by the test beside this file.
export const NUDGE_TITLE = "Your plan is saved. Welcome to Kiwi!";
export const NUDGE_BODY =
  "The Test Kitchen only asked the basics. Tell Kiwi how you really cook — your skill, your gear, who's at the table — and every plan after this one fits you better.";
export const NUDGE_PRIMARY = "Personalize my plans";
export const NUDGE_SECONDARY = "Later";
