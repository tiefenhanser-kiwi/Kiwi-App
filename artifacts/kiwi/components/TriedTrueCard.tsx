// WS9 L2b — Tried & True rail card (net-new, §3 · Components.triedTrueRail).
// A 150-wide card: image slot (via TreatedImage) with an occasion pill floated
// top-left over the photo, title + meta below on the white card. Presentational —
// seasonal-lead ordering is the consuming screen's job, not the card's.
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

export function TriedTrueCard({
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
          height={Components.triedTrueRail.imageHeight}
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
    width: Components.triedTrueRail.cardWidth,
    backgroundColor: Palette.background.card,
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Components.triedTrueRail.cardRadius,
    overflow: "hidden",
  },
  cat: {
    position: "absolute",
    top: 7,
    left: 7,
    backgroundColor: ImageTreatment.overlayPill,
    borderRadius: Components.triedTrueRail.pillRadius,
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
