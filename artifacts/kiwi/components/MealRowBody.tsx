// WS9 Redesign Arc Block 2c Part D — the My-Meals list-row BODY, shared.
//
// Hans (item 23): the Playlist row should "mirror the 'my meals' listview
// convention". That convention lived inline in MealRow (thumb · serif title
// on up to three lines · two-line description · meta line · sage tag pills).
// This is that body, lifted out so MealRow renders it unchanged and the
// Playlist row renders the SAME shape — one component, not a restyle.
//
// Deliberately owns only the body: the host decides the row surface, what is
// pressable, and what sits to the right (MealRow's Cook Now / Add to Plan
// stack, the Playlist row's "⋯" menu). Typography and the pill style are
// MealRow's verbatim so the Meals tab renders pixel-identically.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { DisplayTitle, type TitleSource } from "@/components/DisplayTitle";
import { TreatedImage } from "@/components/TreatedImage";
import { Colors, ImageTreatment, Radius, Typography } from "@/constants/tokens";

export interface MealRowBodyProps {
  /** The entity DisplayTitle reads (displayTitle ?? title). */
  title: TitleSource;
  /** Omitted entirely when null/empty (no gap, no placeholder). */
  description?: string | null;
  /** The one-line meta under the description ("30 min · serves 4"). */
  meta: string;
  /**
   * The meal's image url. WS9 row 5 Block 2 — rendered through TreatedImage:
   * the photo when there is one, the warm placeholder ramp when there is not
   * (a user-authored meal never has one, D-WS9-230, and the ramp is its ruled
   * terminal state, D-WS9-246 — not a loading state, not an error). This
   * replaced the D-WS9-191 `thumbSlot` escape hatch, which existed only so the
   * Playlist row could get the treated slot while MealRow kept a flat sage
   * fallback; every host now renders the same slot.
   */
  image?: string | null;
  /** Tag pills, already de-duped by the host (lib/meals/cardPills). */
  tags?: readonly string[];
  /** Extra lines between the meta and the pills (a sort hint, a macros line). */
  children?: React.ReactNode;
}

export function MealRowBody({
  title,
  description,
  meta,
  image,
  tags = [],
  children,
}: MealRowBodyProps) {
  return (
    <>
      <TreatedImage
        source={image ? { uri: image } : null}
        width={ImageTreatment.thumb.row}
        height={ImageTreatment.thumb.row}
        radius={Radius.sm}
      />
      <View style={styles.body}>
        <DisplayTitle source={title} variant="row" style={styles.title} />
        {/* WS9 3f-4d Part 1c (D-WS9-124) + BUG-158 amendment — TWO lines, ruled
            on device ("maybe 3, but it's a lot of text on the card" — three
            named and declined in the same breath). */}
        {description ? (
          <Text style={styles.description} numberOfLines={2}>
            {description}
          </Text>
        ) : null}
        <Text style={styles.meta} numberOfLines={1}>
          {meta}
        </Text>
        {children}
        {tags.length > 0 && (
          <View style={styles.tagRow}>
            {tags.map((t) => (
              <View key={t} style={styles.tag}>
                <Text style={styles.tagText}>{t}</Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, gap: 2 },
  title: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  meta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  description: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  tagRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, marginTop: 4 },
  tag: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    backgroundColor: Colors.sage[50],
    borderRadius: 4,
  },
  tagText: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
  },
});
