// Prep the Week loading screen — the six "how to dice an onion" panels.
//
// Ported PATH FOR PATH from the approved mockup's inline SVG: same 160×120
// viewBox, same `d` strings in the same paint order, same stroke widths, dash
// arrays and opacities. Colours come from the design tokens where one matches
// the mockup's hex exactly; the three that have no token (board, blade, blade
// edge) stay as the mockup's literals rather than snapping to a near neighbour.
//
// The knives in panels 4–6 deliberately run past the viewBox (x up to 198,
// y up to 160) — the mockup crops them at the frame, and so does the clipping
// wrapper in PrepWeekLoadingView.
//
// Decorative only: every panel's meaning is in its caption, so the view hides
// these from screen readers.

import React from "react";
import Svg, { G, Path, Rect, Text as SvgText } from "react-native-svg";

import { Colors, Typography } from "@/constants/tokens";

export const ONION_ART_VIEWBOX = "0 0 160 120";
export const ONION_ART_ASPECT = 160 / 120;

const INK = Colors.neutral[900]; //        #2D2A24
const PAPER = Colors.neutral[100]; //      #FBF7EF
const RING = Colors.neutral[500]; //       #B3A282
const TERRA = Colors.terracotta[400]; //   #C24F25
const SKIN = Colors.terracotta[100]; //    #F5DAC0
const FLESH = Colors.neutral[200]; //      #F1EADC
const SHINE = Colors.neutral[0]; //        #fff
const HANDLE = Colors.neutral[800]; //     #4A3F30
const BOARD = "#EADFC9"; // no token
const BLADE = "#ECEAE4"; // no token
const BLADE_EDGE = "#9A948A"; // no token

/** The mockup's root <svg> attributes, carried on one wrapping group. */
function Art({ children }: { children: React.ReactNode }) {
  return (
    <Svg width="100%" height="100%" viewBox={ONION_ART_VIEWBOX}>
      <G
        fill="none"
        stroke={INK}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </G>
    </Svg>
  );
}

/** Panels 3–6 — the cutting board. */
function Board() {
  return (
    <>
      <Path d="M8 114 L152 114 L140 46 L20 46 Z" fill={BOARD} strokeWidth={1.6} />
      <Path d="M24 54 L136 54" stroke={RING} strokeWidth={1} />
    </>
  );
}

/** Panels 3–6 — the half onion, cut side down, root end left. */
function HalfOnion() {
  return (
    <>
      <Path
        d="M100 68 C78 62 50 72 38 88 C34 93 34 97 34 100 L124 100 Z"
        fill={FLESH}
      />
      <Path
        d="M46 86 C60 74 80 68 96 70"
        stroke={SHINE}
        strokeWidth={2}
        opacity={0.85}
      />
      <Path d="M34 100 L34 94" strokeWidth={2} />
      <Path d="M76.0 100 A24.0 32.0 0 0 1 124.0 100 Z" fill={PAPER} />
      <Path
        d="M82.7 100 A17.3 23.0 0 0 1 117.3 100 Z"
        stroke={RING}
        strokeWidth={1.1}
      />
      <Path
        d="M89.0 100 A11.0 14.7 0 0 1 111.0 100 Z"
        stroke={RING}
        strokeWidth={1.1}
      />
      <Path
        d="M95.2 100 A4.8 6.4 0 0 1 104.8 100 Z"
        stroke={RING}
        strokeWidth={1.1}
      />
      <Path d="M34 100 L124 100" strokeWidth={2.4} />
    </>
  );
}

// 1 — trim
export function OnionTrimArt() {
  return (
    <Art>
      <Path d="M44 98 C20 88 18 46 46 28 C58 20 64 12 68 6 M80 98 C110 90 112 46 84 28 C72 20 66 12 62 6" />
      <Path d="M44 98 Q62 106 80 98" fill={PAPER} />
      <Path
        d="M50 32 Q62 26 76 32 M48 54 Q62 48 80 54"
        stroke={RING}
        strokeWidth={1.4}
      />
      <Path d="M56 100 l-5 9 M62 101 v10 M68 100 l5 9" strokeWidth={1.6} />
      <Path
        d="M30 24 L98 24 M30 96 L96 96"
        stroke={TERRA}
        strokeDasharray="5 4"
      />
      <SvgText
        x={104}
        y={27}
        fontFamily={Typography.face.sans[400]}
        fontSize={8}
        fill={TERRA}
        stroke="none"
      >
        stem end
      </SvgText>
      <SvgText
        x={102}
        y={99}
        fontFamily={Typography.face.sans[400]}
        fontSize={8}
        fill={TERRA}
        stroke="none"
      >
        root end
      </SvgText>
    </Art>
  );
}

// 2 — peel
export function OnionPeelArt() {
  return (
    <Art>
      <Path
        d="M48 100 C22 90 20 50 48 30 Q66 20 84 30 C112 50 110 90 84 100 Q66 108 48 100 Z"
        fill={PAPER}
      />
      <Path
        d="M84 30 C112 50 110 90 84 100 Q78 103 70 104 C78 90 80 60 72 32 Q78 29 84 30 Z"
        fill={SKIN}
        stroke={TERRA}
      />
      <Path
        d="M112 36 C130 30 140 48 136 66 C134 76 124 82 118 78"
        stroke={TERRA}
        strokeDasharray="4 4"
      />
      <Path d="M121 74 l-6 6 8 2" stroke={TERRA} />
      <Path d="M56 100 l-5 9 M66 102 v10 M76 101 l5 9" strokeWidth={1.6} />
    </Art>
  );
}

// 3 — halve
export function OnionHalveArt() {
  return (
    <Art>
      <Board />
      <HalfOnion />
    </Art>
  );
}

// 4 — horizontal cuts (the knife lies under the onion in paint order)
export function OnionHorizontalArt() {
  return (
    <Art>
      <Board />
      <Path
        d="M168.4 79.0 L92.0 82.0 Q120.4 92.2 167.6 93.0 Z"
        fill={BLADE}
        strokeWidth={1.6}
      />
      <Path d="M168.4 79.0 L92.0 82.0" stroke={BLADE_EDGE} strokeWidth={1} />
      <Path
        d="M170.2 82.3 L198.2 83.7 L197.8 91.4 L169.8 89.9 Z"
        fill={HANDLE}
        strokeWidth={1.4}
      />
      <Path d="M170.2 82.3 L169.8 89.9" stroke={RING} strokeWidth={2.4} />
      <HalfOnion />
      <Path
        d="M80 92 H120 M78 82 H122 M83 72 H117"
        stroke={TERRA}
        strokeDasharray="4 3"
      />
    </Art>
  );
}

// 5 — lengthwise cuts
export function OnionLengthwiseArt() {
  return (
    <Art>
      <Board />
      <HalfOnion />
      <Path
        d="M88 100 V74 M100 100 V68 M112 100 V74"
        stroke={TERRA}
        strokeDasharray="4 3"
      />
      <Path
        d="M88 74 C74 66 56 68 42 86 M100 68 C84 62 62 64 46 80 M112 74 C100 72 80 76 60 92"
        stroke={TERRA}
        strokeDasharray="4 3"
        opacity={0.7}
      />
      <Path
        d="M164.1 110.4 L58.0 78.0 Q95.0 99.4 159.9 121.6 Z"
        fill={BLADE}
        strokeWidth={1.6}
      />
      <Path d="M164.1 110.4 L58.0 78.0" stroke={BLADE_EDGE} strokeWidth={1} />
      <Path
        d="M165.0 113.6 L191.3 123.2 L189.0 129.4 L162.7 119.8 Z"
        fill={HANDLE}
        strokeWidth={1.4}
      />
      <Path d="M165.0 113.6 L162.7 119.8" stroke={RING} strokeWidth={2.4} />
    </Art>
  );
}

// 6 — cross cuts, and the dice falling away
export function OnionCrossArt() {
  return (
    <Art>
      <Board />
      <HalfOnion />
      <Path
        d="M80 92 H120 M78 82 H122 M83 72 H117"
        stroke={RING}
        strokeDasharray="3 3"
        strokeWidth={1.4}
      />
      <Path
        d="M88 100 V74 M100 100 V68 M112 100 V74"
        stroke={RING}
        strokeDasharray="3 3"
        strokeWidth={1.4}
      />
      <Path
        d="M88 74 C74 66 56 68 42 86 M100 68 C84 62 62 64 46 80 M112 74 C100 72 80 76 60 92"
        stroke={RING}
        strokeDasharray="3 3"
        strokeWidth={1.4}
        opacity={0.8}
      />
      <Path
        d="M52 100 C50 90 54 80 64 74 M66 100 C64 88 68 76 80 70 M82 100 C80 88 84 74 96 68"
        stroke={TERRA}
        strokeDasharray="4 3"
      />
      <Path
        d="M105.4 128.8 L84.0 56.0 Q83.4 85.6 94.6 131.2 Z"
        fill={BLADE}
        strokeWidth={1.6}
      />
      <Path d="M105.4 128.8 L84.0 56.0" stroke={BLADE_EDGE} strokeWidth={1} />
      <Path
        d="M103.4 131.3 L109.3 158.7 L103.4 160.0 L97.5 132.6 Z"
        fill={HANDLE}
        strokeWidth={1.4}
      />
      <Path d="M103.4 131.3 L97.5 132.6" stroke={RING} strokeWidth={2.4} />
      <G stroke={TERRA} strokeWidth={1.3} fill={SKIN}>
        <Rect x={128} y={88} width={7} height={7} rx={1.2} />
        <Rect x={138} y={94} width={7} height={7} rx={1.2} />
        <Rect x={130} y={101} width={7} height={7} rx={1.2} />
        <Rect x={142} y={84} width={7} height={7} rx={1.2} />
      </G>
    </Art>
  );
}
