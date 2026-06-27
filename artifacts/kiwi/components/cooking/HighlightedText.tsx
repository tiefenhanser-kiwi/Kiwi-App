// WS7-8b Block 4 (Block 1) — shared quantity-highlighted text renderer.
//
// Lifted from the regex branch of CookSessionView's StepText so the Week Prep
// screen can render combined-prep step prose with quantities bolded terracotta.
// This is the highlightQuantities (regex) branch ONLY — the structured-amountRef
// branch is a Meal/Dish concept that stays in the Cook screen's StepText (prep-
// week steps carry no amountRefs). The segments losslessly rejoin to the
// original string, so the full step text always renders intact (8a guarantee).

import React from "react";
import { StyleSheet, Text } from "react-native";

import { Palette, Typography } from "@/constants/tokens";
import { highlightQuantities } from "@/lib/cooking/quantityHighlight";

export function HighlightedText({
  text,
  style,
}: {
  text: string;
  style: object;
}) {
  const segments = highlightQuantities(text);
  return (
    <Text style={style}>
      {segments.map((seg, i) =>
        seg.isQuantity ? (
          <Text key={i} style={s.quantity}>
            {seg.text}
          </Text>
        ) : (
          <Text key={i}>{seg.text}</Text>
        ),
      )}
    </Text>
  );
}

const s = StyleSheet.create({
  quantity: {
    color: Palette.cookMode.quantity.color,
    fontWeight: Palette.cookMode.quantity.fontWeight,
    fontFamily: Typography.face.sans[700],
  },
});
