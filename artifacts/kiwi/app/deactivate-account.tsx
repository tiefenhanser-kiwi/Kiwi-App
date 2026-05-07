import React, { useState } from "react";
import {
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";

const CONFIRM_PHRASE = "deactivate";

const WARNING_BULLETS = [
  "You'll be logged out immediately",
  "All your saved meals, dishes, plans, and preferences will be removed",
  "Activity history (de-identified) is retained for analytics",
  "Your subscription cancels in Stripe automatically",
  "Within 6 months, you can email support to reactivate",
  "After 6 months, the account is permanently deleted",
];

export default function DeactivateAccount() {
  const router = useRouter();
  const auth = useAuth();
  const { deactivateAccount } = useApp();

  const [input, setInput] = useState("");

  const isConfirmed = input.trim().toLowerCase() === CONFIRM_PHRASE;

  const handleConfirmDeactivate = () => {
    Keyboard.dismiss();

    if (!isConfirmed) {
      Alert.alert("Type 'deactivate' to confirm");
      return;
    }

    console.log("[deactivate-account] confirmed");
    void deactivateAccount();

    Alert.alert(
      "Coming in WS7 — real deactivation",
      "Soft-deleting accounts requires the API client. For WS5, you'll be logged out so the flow feels real.",
      [
        {
          text: "OK",
          onPress: async () => {
            try {
              await auth.logout();
            } catch {
              console.log("[deactivate-account] logout fallback");
            }
            router.replace("/(auth)/welcome");
          },
        },
      ],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title="Deactivate account" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <View style={s.warningCard}>
          <View style={s.warningHeader}>
            <Feather
              name="alert-triangle"
              size={22}
              color={KColors.terracotta[600]}
            />
            <Text style={s.warningHeading}>
              This will deactivate your account
            </Text>
          </View>
          <View style={s.bulletList}>
            {WARNING_BULLETS.map((b) => (
              <View key={b} style={s.bulletRow}>
                <Text style={s.bulletDot}>•</Text>
                <Text style={s.bulletText}>{b}</Text>
              </View>
            ))}
          </View>
        </View>

        <View style={s.frictionCard}>
          <Text style={s.frictionHeading}>Type 'deactivate' to confirm</Text>
          <TextInput
            value={input}
            onChangeText={setInput}
            placeholder={CONFIRM_PHRASE}
            placeholderTextColor={KColors.neutral[600]}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={Keyboard.dismiss}
            style={s.input}
          />
          <Text style={s.frictionHint}>
            This step prevents accidental account loss
          </Text>
        </View>

        <View style={s.footer}>
          <Button
            label="Deactivate account"
            variant="terra"
            disabled={!isConfirmed}
            onPress={handleConfirmDeactivate}
          />
          <Pressable
            onPress={() => router.back()}
            hitSlop={6}
            style={({ pressed }) => [
              s.cancelLink,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  warningCard: {
    backgroundColor: KColors.terracotta[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
    padding: KSpacing.lg,
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    marginBottom: KSpacing.md,
  },
  warningHeading: {
    flex: 1,
    fontSize: KType.size.lg,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  bulletList: {
    gap: KSpacing.sm,
  },
  bulletRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  bulletDot: {
    fontSize: KType.size.md,
    color: KColors.terracotta[600],
    fontFamily: "Inter_700Bold",
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
  frictionCard: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  frictionHeading: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  frictionHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.sm,
  },
  footer: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
    alignItems: "center",
  },
  cancelLink: {
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    marginTop: KSpacing.xs,
  },
  cancelText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
});
