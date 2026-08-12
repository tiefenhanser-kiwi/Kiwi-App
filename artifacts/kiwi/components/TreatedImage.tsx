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

// WS9-2 2c Commit 2 — best-effort URI extraction for the failure signal only.
// ImageSourcePropType is a union: a bundled asset (number), a {uri} object, or
// an array of those. Returns null for anything without a URI — a bundled asset
// cannot 404 over the network, so there is nothing to report for it.
function uriOf(source: ImageSourcePropType | null | undefined): string | null {
  if (!source || typeof source === "number") return null;
  const first = Array.isArray(source) ? source[0] : source;
  const uri = (first as { uri?: unknown } | undefined)?.uri;
  return typeof uri === "string" ? uri : null;
}

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
  /**
   * WS9-2 2c Commit 2 — fired when a REMOTE photo fails to load. Additive
   * signal ONLY: the rendering is unchanged in every case, including failure
   * (the warm gradient underneath keeps showing through, exactly as before).
   *
   * This exists because plan-template images are now hand-curated by pasting an
   * HTTPS URL straight into MealPlanTemplate.imageUrl (D-WS9-149), and a typo'd
   * or dead URL was previously indistinguishable from a plan that simply has no
   * photo — both render as the identical gradient, with nothing logged. That is
   * a debugging trap for a data-entry workflow.
   *
   * Omitting the prop still logs a console warning, so the signal exists even
   * where no caller opts in.
   */
  onError?: (uri: string | null) => void;
};

export function TreatedImage({
  source,
  aspectRatio,
  width,
  height,
  radius = 0,
  gradient = ImageTreatment.placeholder.gradient,
  style,
  onError,
}: Props) {
  const hasFixedDim = width != null || height != null;
  // ⚠️ Declared unconditionally (hooks rule) but only ever WIRED to the <Image>
  // below, which is itself only rendered when `source` is non-null. The
  // null-source path therefore does not change by construction — see §0.2.
  const handleError = React.useCallback(() => {
    const uri = uriOf(source);
    console.warn("[TreatedImage] image failed to load", { uri });
    onError?.(uri);
  }, [source, onError]);
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
          onError={handleError}
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
