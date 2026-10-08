// /test-kitchen/pick — Resub C4. The guest's "Meals to choose from".
//
// The member Pick screen (components/PickMealsScreen.tsx) with `guest`: a set
// of gates on the existing screen, not a second screen (the WizardScreen
// pattern). The guest wizard posts the guest shelf and routes here with the
// member path's own params (lib/wizard/pickMeals.ts pickMealsRouteParams) plus
// `guestForm`, the visitor's answers — "Build my week" sends them as the plan's
// `preferences` (POST /guest/plan-from-picks, G1b).
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURNS.

import React, { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
import { Redirect, useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { PickMealsScreen } from "@/components/PickMealsScreen";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { useGuest } from "@/contexts/GuestContext";
import { parsePickMealsParams, type PickMealsRouteParams } from "@/lib/wizard/pickMeals";
import { GUEST_FORM_DEFAULTS, parseGuestFormParam } from "@/lib/wizard/guestPayload";

export default function GuestPickRoute() {
  return <GuestPickEntry />;
}

function GuestPickEntry() {
  const router = useRouter();
  const { session } = useGuest();
  const raw = useLocalSearchParams<PickMealsRouteParams & { guestForm?: string }>();
  const parsed = useMemo(() => parsePickMealsParams(raw), [raw]);
  const guestForm = useMemo(
    () => parseGuestFormParam(raw.guestForm, GUEST_FORM_DEFAULTS),
    [raw.guestForm],
  );

  // The session expired or was claimed while this sat open — back to the door,
  // which resumes or mints one.
  if (!session) return <Redirect href="/test-kitchen" />;

  if (!parsed || !guestForm) {
    // A reload drops the in-memory hop's params on native, and a shared URL
    // never had them: the answers are not here, so the plan cannot be built
    // from them. Back to the wizard, never a dead screen.
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Pick your meals" />
        <View style={s.statusBox}>
          <Text style={s.errorTitle}>Kiwi got distracted. Try again?</Text>
          <Text style={s.errorBody}>
            The meal list wasn&apos;t passed through. Head back to the Test Kitchen
            and choose again.
          </Text>
          <View style={{ marginTop: Spacing[3] }}>
            <Button
              label="Back to the Test Kitchen"
              variant="primary"
              onPress={() => router.replace("/test-kitchen")}
            />
          </View>
        </View>
      </View>
    );
  }

  return <PickMealsScreen {...parsed} guest guestForm={guestForm} />;
}

const s = StyleSheet.create({
  statusBox: {
    margin: Spacing[4],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  errorTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    textAlign: "center",
  },
  errorBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
});
