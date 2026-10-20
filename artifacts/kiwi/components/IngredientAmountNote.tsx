// WEB-4 — the small grey line under an egg on an ingredient list: the true
// scaled amount when the list shows a rounded whole ("1 large egg" over "recipe
// calls for ¾ at 2 servings"). The words come from lib/format/ingredientLine.ts's
// ingredientAmountNote; this only draws them. Ingredient lists only — steps and
// Cook Mode print the whole number alone.
import React from "react";
import { StyleSheet, Text } from "react-native";

import { Colors, Typography } from "@/constants/tokens";

export function IngredientAmountNote({ note }: { note: string | null }) {
  if (!note) return null;
  return <Text style={s.note}>{note}</Text>;
}

const s = StyleSheet.create({
  // neutral[700], not [600]: on the paper background [600] is 3.11:1 (BUG-157)
  // and this is text; [700] is 5.26:1.
  note: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 1,
  },
});
