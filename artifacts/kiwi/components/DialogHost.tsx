// WEB-1 Part A — the web half of lib/dialog.ts. Mounted ONCE, in
// app/_layout.tsx, after the root navigator so it overlays every screen.
//
// Renders nothing on native: there dialog.alert is Alert.alert and the store
// never fills. On web it shows the head of the queue as a paper card on a
// scrim — the PersonalizeNudgeModal shape (centred card, Radius.lg, serif
// title, sans body, max 420 wide), which is the app's one centred modal.
//
// Buttons, in the caller's order: style "cancel" → secondary, "destructive" →
// terracotta fill (Button `primary`), anything else → sage fill. Two buttons
// sit side by side; one or three stack.
//
// Dismissal (cancelable !== false): scrim tap and Escape resolve to the cancel
// button's onPress if there is one, else close — except a dialog with no cancel
// button whose OK carries an action, which only its button closes (see
// dismissTarget in lib/dialog.ts). Enter → the last non-cancel
// button. All three route through resolveDialog, which is id-keyed, so a key
// press that reaches both the Modal and the document closes the dialog once.

import React, { useEffect, useRef, useSyncExternalStore } from "react";
import { Modal, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  currentDialog,
  dismissDialog,
  enterTarget,
  resolveDialog,
  subscribeDialogs,
  type DialogButton,
} from "@/lib/dialog";

function variantFor(b: DialogButton): "secondary" | "primary" | "sage" {
  if (b.style === "cancel") return "secondary";
  if (b.style === "destructive") return "primary";
  return "sage";
}

export function DialogHost() {
  const req = useSyncExternalStore(subscribeDialogs, currentDialog, currentDialog);
  const cardRef = useRef<View>(null);

  // Keyboard (web only — native never fills the store). Escape is also handled
  // by react-native-web's Modal via onRequestClose; the id-keyed resolve makes
  // the overlap harmless.
  useEffect(() => {
    if (!req || Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismissDialog(req.id);
      } else if (e.key === "Enter") {
        const target = enterTarget(req);
        if (!target) return;
        e.preventDefault();
        resolveDialog(req.id, target);
      }
    };
    document.addEventListener("keydown", onKey);
    // Focus into the card so a keyboard / screen-reader user lands in the
    // dialog rather than on the control that opened it.
    (cardRef.current as unknown as { focus?: () => void } | null)?.focus?.();
    return () => document.removeEventListener("keydown", onKey);
  }, [req]);

  if (!req) return null;
  const sideBySide = req.buttons.length === 2;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      statusBarTranslucent
      onRequestClose={() => dismissDialog(req.id)}
    >
      <View style={s.backdrop}>
        <Pressable
          style={StyleSheet.absoluteFill}
          onPress={() => dismissDialog(req.id)}
          accessibilityLabel="Dismiss"
          testID="dialog-scrim"
        />
        <View
          ref={cardRef}
          style={s.card}
          accessibilityRole="alert"
          accessibilityViewIsModal
          focusable
          testID="dialog-card"
        >
          <Text style={s.title}>{req.title}</Text>
          {req.message ? <Text style={s.body}>{req.message}</Text> : null}
          <View style={[s.actions, sideBySide && s.actionsRow]}>
            {req.buttons.map((b, i) => (
              <Button
                key={`${req.id}-${i}`}
                label={b.text ?? "OK"}
                variant={variantFor(b)}
                size="sm"
                wrapLabel
                style={sideBySide ? s.rowCell : undefined}
                onPress={() => resolveDialog(req.id, b)}
                testID={`dialog-button-${i}`}
              />
            ))}
          </View>
        </View>
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: Palette.background.overlay,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[4],
  },
  card: {
    width: "100%",
    maxWidth: 420,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    padding: Spacing[4],
    gap: Spacing[3],
  },
  title: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  body: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
    lineHeight: 22,
  },
  actions: {
    gap: Spacing[2],
    marginTop: Spacing[1],
  },
  actionsRow: {
    flexDirection: "row",
  },
  rowCell: {
    flex: 1,
  },
});
