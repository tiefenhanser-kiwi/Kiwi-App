import React, { useState } from "react";
import {
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
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

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
  const { deactivateAccount } = useApp();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConfirmed = input.trim().toLowerCase() === CONFIRM_PHRASE;

  // The mutator soft-deletes the account server-side then drops the local
  // session (logout). On success the user lands back on the welcome screen.
  const handleConfirmDeactivate = async () => {
    Keyboard.dismiss();
    if (!isConfirmed || busy) return;

    setError(null);
    setBusy(true);
    try {
      await deactivateAccount();
      router.replace("/(auth)/welcome");
    } catch {
      setError("Couldn't deactivate your account. Please try again.");
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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
              color={Colors.terracotta[600]}
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
            placeholderTextColor={Palette.text.placeholder}
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
            variant="primary"
            loading={busy}
            disabled={!isConfirmed || busy}
            onPress={handleConfirmDeactivate}
          />
          {error && <Text style={s.errorText}>{error}</Text>}
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
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  warningCard: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[200],
    padding: Spacing[4],
  },
  warningHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    marginBottom: Spacing[3],
  },
  warningHeading: {
    flex: 1,
    fontSize: Typography.fontSize.lg,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  bulletList: {
    gap: Spacing[2],
  },
  bulletRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  bulletDot: {
    fontSize: Typography.fontSize.md,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[700],
    lineHeight: 20,
  },
  bulletText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  frictionCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
  },
  frictionHeading: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  frictionHint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[2],
  },
  footer: {
    marginTop: Spacing[4],
    gap: Spacing[2],
    alignItems: "center",
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textAlign: "center",
  },
  cancelLink: {
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[3],
    marginTop: Spacing[1],
  },
  cancelText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
