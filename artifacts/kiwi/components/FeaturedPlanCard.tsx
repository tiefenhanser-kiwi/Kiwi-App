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
      <View style={styles.body}>
        <DisplayTitle source={title} variant="railCard" style={styles.title} />
        {meta ? (
          <Text style={styles.meta} numberOfLines={1}>
            {meta}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

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
  title: {
    fontSize: Typography.fontSize.base,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.serif[500],
    lineHeight: Typography.fontSize.base * 1.22,
  },
  meta: {
    fontSize: Typography.fontSize.xxs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 4,
  },
});
