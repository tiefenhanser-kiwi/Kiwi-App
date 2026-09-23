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

// D-WS9-257 — replaces app/deactivate-account.tsx.
//
// Same shape as that screen (warning card, type-the-word confirm, a button
// disabled until it matches) because the shape was right. What changed is that
// every line is now TRUE of the server.
//
// The old screen promised "All your saved meals, dishes, plans, and preferences
// will be removed" while POST /me/deactivate flipped accountStatus to 'paused'
// and removed NOTHING — no anonymization, no deletion job, no restore path a
// user could reach, and a 30-day session JWT that kept authenticating. Apple
// 5.1.1(v) asks an app that creates accounts to DELETE them, and says in terms
// that offering to "temporarily deactivate or disable" is insufficient.
//
// Every bullet below is checkable against DELETE /me in routes/me.ts. There is
// no mention of support, email, six months, Stripe or reactivation, because
// none of those exists: there is no admin to restore from and no Stripe
// customer to retain. The de-identified line is not a hedge — the route really
// does keep llm_call_logs rows with userId nulled, and saying so is better than
// a blanket "everything is deleted" that is a shade untrue.
const CONFIRM_PHRASE = "delete";

const WARNING_BULLETS = [
  "You'll be signed out on this device right away",
  "Your account, saved meals, dishes, plans, grocery lists and preferences are permanently deleted",
  "This can't be undone",
  "De-identified usage records (which features ran and what they cost) are kept",
];

export default function DeleteAccount() {
  const router = useRouter();
  const { deleteAccount } = useApp();

  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isConfirmed = input.trim().toLowerCase() === CONFIRM_PHRASE;

  // The mutator sends DELETE /me, then clears the session AND every cached
  // query before this screen navigates — so nothing of the deleted account is
  // left in memory for whoever signs in next on this device.
  const handleConfirmDelete = async () => {
    Keyboard.dismiss();
    if (!isConfirmed || busy) return;

    setError(null);
    setBusy(true);
    try {
      await deleteAccount();
      router.replace("/(auth)/welcome");
    } catch {
      setError("Couldn't delete your account. Please try again.");
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title="Delete account" />
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
              This will delete your account
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
          <Text style={s.frictionHeading}>Type 'delete' to confirm</Text>
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
            label="Delete my account"
            variant="primary"
            loading={busy}
            disabled={!isConfirmed || busy}
            onPress={handleConfirmDelete}
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
