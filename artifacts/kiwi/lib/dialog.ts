// WEB-1 Part A (D-WS5-005) — one dialog, every platform.
//
// 🔴 react-native-web implements Alert as an EMPTY STUB: `Alert.alert(...)` on
// the web shows nothing and calls no button's onPress. Every confirm in the app
// was a silent no-op there ("Remove from plan" did nothing, BUG-384; the
// meal-edit "this time only / always" prompt did nothing; BUG-385).
//
// `dialog.alert` has EXACTLY Alert.alert's signature, so a call site swaps by
// name and nothing else. On native it is Alert.alert — the system dialog is
// still the right one there. On web it queues a request that DialogHost
// (mounted once in app/_layout.tsx) renders.
//
// ⚠️ THE STORE IS MODULE-LEVEL, NOT A CONTEXT. Several callers are plain
// functions (lib/orderOnline's sinks, mutation callbacks) with no hook in
// reach, and a provider would make every one of them thread a value through.
//
// ⚠️ QUEUE, NEVER STACK. A second alert while one is open waits until the
// first closes — Alert.alert's own behaviour on iOS. A button's onPress runs
// AFTER its dialog has closed, so an onPress that opens a follow-up dialog
// (meal-builder's save → "Saved") queues behind nothing and shows at once.
//
// The guard test (lib/__tests__/dialogGuard.test.ts) fails on any
// `Alert.alert(` / `Alert.prompt(` in app/, components/, lib/, hooks/ outside
// this file. There is no `Alert.prompt` in the client; if one is ever needed
// it belongs here, as a text-field variant of the same host.

import { Alert, Platform } from "react-native";
import type { AlertButton, AlertOptions } from "react-native";

export type DialogButton = AlertButton;
export type DialogOptions = AlertOptions;

export interface DialogRequest {
  id: number;
  title: string;
  message?: string;
  /** Never empty: a call with no buttons is given Alert's single "OK". */
  buttons: DialogButton[];
  options?: DialogOptions;
}

let nextId = 1;
let queue: DialogRequest[] = [];
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of [...listeners]) l();
}

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The dialog on screen (the head of the queue), or null. */
export function currentDialog(): DialogRequest | null {
  return queue[0] ?? null;
}

/**
 * Close dialog `id` and run `button`'s onPress, if any. Keyed on the id so a
 * double resolution (a scrim tap racing a key press, Escape reaching both the
 * Modal and the document) closes it once and never closes the NEXT dialog.
 */
export function resolveDialog(id: number, button?: DialogButton): void {
  if (queue[0]?.id !== id) return;
  queue = queue.slice(1);
  emit();
  button?.onPress?.();
}

/** The button a dismissal (scrim tap, Escape) resolves to, or undefined for a
 *  plain close. Undefined result + `dismissible: false` = do nothing. */
export function dismissTarget(req: DialogRequest): {
  dismissible: boolean;
  button?: DialogButton;
} {
  const cancel = req.buttons.find((b) => b.style === "cancel");
  // WEB-1 Part D — a dialog with no cancel button whose buttons carry an action
  // ("OK" → back to the plan) is NOT dismissible: a scrim tap would skip the
  // only way forward, which native never allows (iOS has no outside-tap on an
  // alert; Android's default is cancelable: false). That skip is the stranded-
  // on-the-builder half of BUG-385.
  const actionOnly = !cancel && req.buttons.some((b) => !!b.onPress);
  return {
    dismissible: req.options?.cancelable !== false && !actionOnly,
    button: cancel,
  };
}

/** Enter → the LAST non-cancel button (the dialog's action). */
export function enterTarget(req: DialogRequest): DialogButton | undefined {
  const actions = req.buttons.filter((b) => b.style !== "cancel");
  return actions[actions.length - 1];
}

/** Dismiss the head dialog the way a scrim tap / Escape does. */
export function dismissDialog(id: number): void {
  const req = queue[0];
  if (!req || req.id !== id) return;
  const { dismissible, button } = dismissTarget(req);
  if (!dismissible) return;
  // The cancel button's onPress when there is one; otherwise Alert's own
  // dismiss callback (Android's outside-tap hook). Never both.
  resolveDialog(id, button ?? { text: "", onPress: req.options?.onDismiss });
}

function alert(
  title: string,
  message?: string,
  buttons?: DialogButton[],
  options?: DialogOptions,
): void {
  if (Platform.OS !== "web") {
    Alert.alert(title, message, buttons, options);
    return;
  }
  queue = [
    ...queue,
    {
      id: nextId++,
      title,
      message,
      buttons: buttons && buttons.length > 0 ? buttons : [{ text: "OK" }],
      options,
    },
  ];
  emit();
}

export const dialog = { alert };

export function __resetDialogsForTests(): void {
  queue = [];
  emit();
}
