import React, { useRef, useState } from "react";
import {
  Dimensions,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

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
};

export function SortDropdown({
  value,
  onChange,
  labelOverrides,
  disabledKeys,
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
        right: Math.max(KSpacing.md, screen.width - (anchor.x + anchor.width)),
      }
    : { top: KSpacing.xxl, right: KSpacing.md };

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
            {SORT_OPTIONS.map((opt) => {
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
    paddingHorizontal: KSpacing.md,
    paddingVertical: 8,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    backgroundColor: KPalette.bg.card,
    gap: 4,
  },
  triggerLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  triggerValue: {
    fontSize: KType.size.xs,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  chev: {
    fontSize: 12,
    color: KColors.sage[700],
    fontWeight: "700",
    marginLeft: 2,
  },
  // Full-screen transparent layer behind the floating menu; tap to dismiss.
  backdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  menu: {
    minWidth: 160,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingVertical: 4,
    elevation: 4,
    shadowColor: "#000",
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
    paddingHorizontal: KSpacing.md,
    paddingVertical: 8,
  },
  itemOn: {
    backgroundColor: KColors.sage[50],
  },
  itemText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
  },
  itemTextOn: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  itemTextDisabled: {
    fontSize: KType.size.sm,
    color: KColors.neutral[400],
    fontFamily: "Inter_400Regular",
  },
});
