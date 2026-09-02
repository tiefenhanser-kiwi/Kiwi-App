// WS9 L2b — Featured-plans rail card (net-new, §3 · Components.featuredRail).
// A 150-wide card: image slot (via TreatedImage) with an occasion pill floated
// top-left over the photo, title + meta below on the white card. Presentational —
// ordering is the consuming screen's job, not the card's.
//
// WS9-2 2c Commit 8 (D-WS9-130, Option A) — RENAMED from TriedTrueCard, and the
// rail's eyebrow from "tried & true" to "Featured plans".
//
// The old mixed-rail name rested on the rail being all `top_rated` with
// `featured` empty. BOTH halves measured false: `featured` holds two live rows,
// and `top_rated` is ungated so it swept the whole public pool rather than
// being a distinct tier. "Featured plans" is an OBJECT noun, which also keeps
// it distinct from D-WS9-120's Featured — a MEAL-level shelf for publishing
// creators. Different objects, no collision.
//
// ⚠️ The per-card "Top Rated" BADGE is a separate, known overclaim
// (topRatedScore is null on 72/72 rows and the scorer has never run). It is NOT
// this rename's to fix and was deliberately left alone.
//
// Type-scale: mockup authors nm 13.5 / meta 10.5; rendered on the token scale
// (base / xxs) per FLAG 1. The occasion pill is a near-opaque cream chip that
// needs no scrim (mockup .cat = paper @92%) — so there is no text-on-image
// legibility token to add.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Colors,
  Components,
  ImageTreatment,
  Palette,
  Typography,
} from "@/constants/tokens";
import { DisplayTitle } from "./DisplayTitle";
import { TreatedImage } from "./TreatedImage";

type Props = {
  image?: { uri: string } | null;
  /** Occasion tag shown over the image, e.g. "Hosting". */
  occasion: string;
  title: string;
  meta?: string;
  onPress?: () => void;
};

export function FeaturedPlanCard({
  image,
  occasion,
  title,
  meta,
  onPress,
}: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.9 }]}
    >
      <View>
        <TreatedImage
          source={image ?? null}
          height={Components.featuredRail.imageHeight}
        />
        <View style={styles.cat} pointerEvents="none">
          <Text style={styles.catText} numberOfLines={1}>
            {occasion}
          </Text>
        </View>
      </View>
      {/* BUG-086 — RESERVED SLOTS. The rail had TWO independent height inputs
          and fixing either alone leaves it ragged:
            (1) the meta line is suppressed when tags[0] merely restates the
                occasion badge — true on 3 of the 6 live cards, not the 2 the
                bug report named;
            (2) railCard titles wrap to TWO lines, so a long title makes a card
                taller whether or not it has meta.
          Both slots are now fixed-height and ALWAYS present, so every card is
          identical regardless of its content. The dead band is not removed by
          shrinking the short cards — that is what made the rail ragged — it is
          removed by making the reservation uniform and deliberate.

          ⚠️ Do NOT re-derive this as "3 short, 3 tall". Rail membership is
          hand-curated railPosition integers in the database; the mix changes
          without a deploy. The fix has to hold for any mix, which is why it is
          expressed as fixed slots rather than as a conditional. */}
      <View style={styles.body}>
        <View style={styles.titleSlot}>
          <DisplayTitle source={title} variant="railCard" style={styles.title} />
        </View>
        <View style={styles.metaSlot}>
          {meta ? (
            <Text style={styles.meta} numberOfLines={1}>
              {meta}
            </Text>
          ) : null}
        </View>
      </View>
    </Pressable>
  );
}

// BUG-086 — the reserved-slot metrics. Exported so the rail's own test can
// assert card-height uniformity against the same numbers the card renders with,
// rather than re-deriving them (a re-derived constant is one that drifts).
export const RAIL_TITLE_LINE_HEIGHT = Typography.fontSize.base * 1.22;
/** railCard titles wrap to 2 lines (DisplayTitle VARIANT_LINES.railCard). */
export const RAIL_TITLE_SLOT_HEIGHT = RAIL_TITLE_LINE_HEIGHT * 2;
export const RAIL_META_LINE_HEIGHT = 13;

const styles = StyleSheet.create({
  card: {
    width: Components.featuredRail.cardWidth,
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Components.featuredRail.cardRadius,
    overflow: "hidden",
  },
  cat: {
    position: "absolute",
    top: 7,
    left: 7,
    backgroundColor: ImageTreatment.overlayPill,
    borderRadius: Components.featuredRail.pillRadius,
    paddingHorizontal: 9,
    paddingVertical: 3,
  },
  catText: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.sans[700],
  },
  body: {
    paddingTop: 9,
    paddingHorizontal: 11,
    paddingBottom: 11,
  },
  // Always two lines' worth, whether the title uses one or two. A 1-line title
  // sits top-aligned with space below it — consistent across the rail, which is
  // the point.
  titleSlot: {
    height: RAIL_TITLE_SLOT_HEIGHT,
  },
  title: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.serif[500],
    lineHeight: RAIL_TITLE_LINE_HEIGHT,
  },
  // Always one line's worth, whether meta is present or suppressed. This is the
  // slot that used to collapse and leave the card short — and then get stretched
  // back to the tallest sibling by the rail's default alignItems, which is
  // where the dead white band came from.
  metaSlot: {
    height: RAIL_META_LINE_HEIGHT,
    marginTop: 4,
  },
  meta: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    // Explicit, so the reserved slot and the rendered line are the same number.
    lineHeight: RAIL_META_LINE_HEIGHT,
  },
});
