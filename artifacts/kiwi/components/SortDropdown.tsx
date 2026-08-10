import React, { useRef, useState } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { Colors, Palette, Radius, Shadow, Spacing, Typography } from "@/constants/tokens";

export type SortKey =
  | "last_cooked"
  | "times_cooked"
  | "date_created"
  | "alpha"
  | "cook_time";

type SortOption = { key: SortKey; label: string };

export const SORT_OPTIONS: SortOption[] = [
  { key: "last_cooked", label: "Last cooked" },
  { key: "times_cooked", label: "Times cooked" },
  { key: "date_created", label: "Date added" },
  { key: "alpha", label: "A–Z" },
  { key: "cook_time", label: "Cook time" },
];

type Props = {
  value: SortKey;
  onChange: (key: SortKey) => void;
  /** Per-context label overrides. Dishes view passes
   *  `{ times_cooked: "Most used" }` since the underlying field is
   *  `mealUseCount` (number of meals using the dish), not literal
   *  cook count. */
  labelOverrides?: Partial<Record<SortKey, string>>;
  /** WS7-6 B-fix Block 3 — keys rendered greyed/muted and non-selectable.
   *  Dish contexts pass `["last_cooked"]` (no Dish.lastUsedAt write path,
   *  D-WS7-111). The option stays visible in the list, just disabled. */
  disabledKeys?: readonly SortKey[];
  /** WS9-2 BUG-075 — keys removed from the menu entirely (not just greyed).
   *  The Plans context passes `["cook_time"]` — a plan has no cook time and no
   *  server aggregate for one, so the option is dropped rather than disabled.
   *  `value` must never be a hidden key. */
  hiddenKeys?: readonly SortKey[];
};

export function SortDropdown({
  value,
  onChange,
  labelOverrides,
  disabledKeys,
  hiddenKeys,
}: Props) {
  const [open, setOpen] = useState(false);
  // WS7-6 B-fix Block 3-fix: the open menu renders in a Modal (portal) anchored
  // to the trigger's measured window position. Inside a FlatList header, an
  // absolutely-positioned sibling z-fights with row cells (and zIndex/elevation
  // across VirtualizedList cells is unreliable on Android), so the menu lived
  // BEHIND the dish rows. A Modal escapes the list's stacking context entirely.
  const triggerRef = useRef<View>(null);
  const [anchor, setAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);

  const labelFor = (key: SortKey, fallback: string) =>
    labelOverrides?.[key] ?? fallback;
  const isDisabled = (key: SortKey) => disabledKeys?.includes(key) ?? false;
  const visibleOptions = hiddenKeys
    ? SORT_OPTIONS.filter((o) => !hiddenKeys.includes(o.key))
    : SORT_OPTIONS;
  const current = SORT_OPTIONS.find((o) => o.key === value) ?? SORT_OPTIONS[0];

  const openMenu = () => {
    const node = triggerRef.current as
      | (View & {
          measureInWindow?: (
            cb: (x: number, y: number, w: number, h: number) => void,
          ) => void;
        })
      | null;
    if (node && typeof node.measureInWindow === "function") {
      node.measureInWindow((x, y, width, height) => {
        setAnchor({ x, y, width, height });
        setOpen(true);
      });
    } else {
      // No native measure (e.g. react-test-renderer) — open with no anchor;
      // the menu falls back to a top-right placement.
      setAnchor(null);
      setOpen(true);
    }
  };

  // Right-align the menu to the trigger's right edge, dropped just below it.
  const screen = Dimensions.get("window");
  const menuPosition = anchor
    ? {
        top: anchor.y + anchor.height + 4,
        right: Math.max(Spacing[3], screen.width - (anchor.x + anchor.width)),
      }
    : { top: Spacing[6], right: Spacing[3] };

  return (
    <View style={styles.wrap}>
      <Pressable
        ref={triggerRef}
        onPress={() => (open ? setOpen(false) : openMenu())}
        style={({ pressed }) => [styles.trigger, pressed && { opacity: 0.7 }]}
      >
        <Text style={styles.triggerLabel}>Sort: </Text>
        <Text style={styles.triggerValue}>
          {labelFor(current.key, current.label)}
        </Text>
        <Text style={styles.chev}>{open ? "▴" : "▾"}</Text>
      </Pressable>
      {open && (
        <Modal
          transparent
          visible
          animationType="none"
          onRequestClose={() => setOpen(false)}
        >
          {/* Full-screen backdrop: tap outside the menu closes it. */}
          <Pressable
            style={styles.backdrop}
            onPress={() => setOpen(false)}
            accessibilityLabel="Close sort menu"
          />
          <View style={[styles.menu, styles.menuFloating, menuPosition]}>
            {visibleOptions.map((opt) => {
              const isOn = opt.key === value;
              const disabled = isDisabled(opt.key);
              return (
                <Pressable
                  key={opt.key}
                  disabled={disabled}
                  accessibilityState={{ disabled, selected: isOn }}
                  onPress={() => {
                    if (disabled) return;
                    onChange(opt.key);
                    setOpen(false);
                  }}
                  style={({ pressed }) => [
                    styles.item,
                    isOn && !disabled && styles.itemOn,
                    !disabled && pressed && { opacity: 0.7 },
                  ]}
                >
                  <Text
                    style={
                      disabled
                        ? styles.itemTextDisabled
                        : isOn
                          ? styles.itemTextOn
                          : styles.itemText
                    }
                  >
                    {labelFor(opt.key, opt.label)}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Modal>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "relative" },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: Spacing[3],
    paddingVertical: 8,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
    gap: 4,
  },
  triggerLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  triggerValue: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  chev: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.bold,
    marginLeft: 2,
  },
  // Full-screen transparent layer behind the floating menu; tap to dismiss.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menu: {
    minWidth: 160,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingVertical: 4,
    elevation: 4,
    shadowColor: Shadow.card.shadowColor,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 6,
  },
  // Absolute placement inside the Modal — top/right are supplied dynamically
  // from the trigger's measured window position.
  menuFloating: {
    position: "absolute",
  },
  item: {
    paddingHorizontal: Spacing[3],
    paddingVertical: 8,
  },
  itemOn: {
    backgroundColor: Colors.sage[50],
  },
  itemText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  itemTextOn: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  itemTextDisabled: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[400],
    fontFamily: Typography.face.sans[400],
  },
});
