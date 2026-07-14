// WS9 L2b — image-treatment wrapper (net-new, §3 · ImageTreatment token).
// A fixed-slot image with: a warm-gradient placeholder that shows through when
// the photo is absent/failed, and the spec'd terracotta overlay.
//
// Blend note (UNVERIFIED HYPOTHESIS): the spec is rgba(194,79,37,.06) *multiply*
// (ImageTreatment.overlay). RN has no reliable cross-platform mix-blend-mode, so
// this is a NORMAL-alpha approximation. At α=0.06 the multiply-vs-normal delta is
// negligible on warm mid-tone food imagery; flagged for an on-device eyeball when
// 3a first renders real photos. We do NOT pull a blend-mode lib for a 6% overlay.
//
// Sourcing is out of scope (§3): this wrapper renders whatever `source` it's given.

import React from "react";
import {
  Image,
  ImageSourcePropType,
  StyleProp,
  StyleSheet,
  View,
  ViewStyle,
} from "react-native";
import { LinearGradient } from "expo-linear-gradient";

import { ImageTreatment } from "@/constants/tokens";

type Props = {
  source?: ImageSourcePropType | null;
  /** Fixed aspect for the slot, e.g. ImageTreatment.aspect.railCard. Used only
   *  when neither width nor height is given. */
  aspectRatio?: number;
  width?: number;
  height?: number;
  /** match-container: the caller passes its container radius (ImageTreatment.radiusRule). */
  radius?: number;
  gradient?: readonly [string, string];
  style?: StyleProp<ViewStyle>;
};

export function TreatedImage({
  source,
  aspectRatio,
  width,
  height,
  radius = 0,
  gradient = ImageTreatment.placeholder.gradient,
  style,
}: Props) {
  const hasFixedDim = width != null || height != null;
  return (
    <View
      style={[
        styles.wrap,
        { borderRadius: radius },
        width != null ? { width } : null,
        height != null ? { height } : null,
        !hasFixedDim && aspectRatio != null ? { aspectRatio } : null,
        style,
      ]}
    >
      <LinearGradient
        colors={gradient as [string, string]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {source ? (
        <Image
          source={source}
          style={StyleSheet.absoluteFill}
          resizeMode="cover"
        />
      ) : null}
      <View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: ImageTreatment.overlay.color },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    overflow: "hidden",
    backgroundColor: ImageTreatment.placeholder.base,
  },
});
