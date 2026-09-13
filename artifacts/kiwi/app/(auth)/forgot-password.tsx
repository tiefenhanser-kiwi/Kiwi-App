import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { ApiError, ApiNetworkError } from "@/lib/api/errors";
import { requestPasswordReset } from "@/lib/api/passwordReset";

// WS9A BUG-235 / D-WS9-241 (C) — the password-reset REQUEST screen. Reached
// from sign-in's "Forgot your password?" link. Email → POST
// /auth/password-reset/request → the anti-enumeration copy regardless of
// outcome: the server answers 200 whether or not the email exists (and even
// if sending fails), so this screen never branches on whether an account
// exists. Lives under (auth)/ because the user is logged out by definition;
// SessionGate (root _layout) would bounce it anywhere else.
//
// Layout mirrors sign-in.tsx (same wrap / back chevron / title / input /
// button styles, copied rather than imported — sign-in is the auth-core
// lane's file); the "sent" card is verify-email.tsx's card.

const NETWORK_MSG = "Can't reach Kiwi. Check your connection and try again.";

type Stage = "form" | "sent";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [stage, setStage] = React.useState<Stage>("form");

  const goToSignIn = () => router.replace("/(auth)/sign-in");

  const handleSubmit = async () => {
    const trimmed = email.trim();
    if (!trimmed) return;
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(trimmed);
      setStage("sent");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        // The only 400 this route emits is the zod schema (email().max(255)).
        setError("Enter a valid email address.");
      } else if (err instanceof ApiError) {
        // 429 "Too many requests, slow down." and anything else: the
        // server's own copy.
        setError(err.message);
      } else if (err instanceof ApiNetworkError) {
        setError(NETWORK_MSG);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (stage === "sent") {
    return (
      <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
        <View style={styles.centered}>
          <View style={styles.card}>
            <View style={styles.iconWrap}>
              <Feather name="check-circle" size={32} color={Colors.sage[700]} />
            </View>
            <Text style={styles.heading}>Check your email</Text>
            <Text style={styles.message}>
              If an account exists for that email, you'll receive a reset link.
            </Text>
            <Text style={styles.message}>The link expires in 1 hour.</Text>
            <View style={styles.actionWrap}>
              <Button label="Back to sign in" variant="primary" onPress={goToSignIn} />
            </View>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={Colors.sage[700]} />
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>Reset your password</Text>
        <Text style={styles.hint}>
          Enter the email for your Kiwi account and we'll send a link to choose a new password.
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          style={styles.input}
          editable={!submitting}
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {submitting ? (
          <View style={styles.buttonLoading}>
            <ActivityIndicator color={Colors.sage[700]} />
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Send reset link" />
        )}
        <Pressable onPress={goToSignIn}>
          <Text style={styles.link}>Back to sign in</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // sign-in.tsx's form styles.
  wrap: { flex: 1, backgroundColor: Colors.neutral[100], padding: Spacing[4] },
  back: { marginBottom: Spacing[3] },
  body: { gap: Spacing[3] },
  title: { fontSize: Typography.fontSize.xl * 1.4, fontWeight: "700", color: Colors.neutral[900], fontFamily: Typography.face.serif[700] },
  hint: { fontSize: Typography.fontSize.sm, color: Colors.neutral[700], fontFamily: Typography.face.sans[400], lineHeight: 20 },
  input: { borderWidth: 1, borderColor: Colors.neutral[400], borderRadius: Radius.md, padding: Spacing[3], fontSize: Typography.fontSize.md, backgroundColor: Palette.background.card, fontFamily: Typography.face.sans[400] },
  errorText: { color: Colors.terracotta[700], fontSize: Typography.fontSize.sm, fontFamily: Typography.face.sans[500] },
  buttonLoading: { alignItems: "center", padding: Spacing[3] },
  link: { color: Colors.sage[700], fontSize: Typography.fontSize.md, textAlign: "center", marginTop: Spacing[2], fontFamily: Typography.face.sans[500] },
  // verify-email.tsx's card styles.
  centered: { flex: 1, justifyContent: "center" },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[5],
    alignItems: "center",
    gap: Spacing[3],
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
  },
  heading: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    textAlign: "center",
  },
  message: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
    lineHeight: 20,
  },
  actionWrap: {
    alignSelf: "stretch",
    marginTop: Spacing[2],
  },
});
