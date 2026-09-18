import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { useToast } from "@/contexts/ToastProvider";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { ApiError, ApiNetworkError } from "@/lib/api/errors";
import { confirmPasswordReset } from "@/lib/api/passwordReset";

// WS9A BUG-235 / D-WS9-241 (C) — the password-reset CONFIRM screen. Reached
// ONLY by the deep link kiwi://reset-password?token=… that the reset web page
// (D-WS9-231, Cloud Run host root) emits — cold or warm start; nothing in-app
// navigates here. Route groups are not part of the URL, so /reset-password
// resolves to this file under (auth)/, where a logged-out user belongs
// (SessionGate would evict the screen anywhere else). A signed-in user opening
// the link is redirected home by (auth)/_layout — accepted; they change their
// password from profile.
//
// New password twice, min 8 / max 100 mirrored from the server's
// resetConfirmSchema (a violation there is a schema 400, so we pre-validate
// with the web page's own strings). POST /auth/password-reset/confirm. The
// server answers ONE opaque 400 for bad / expired / already-spent tokens
// (BUG-233), so there is one `invalid` state. Success does NOT sign the user
// in — no token comes back — so we toast and replace to sign-in; useAuth() is
// deliberately untouched.
//
// Token shape copied from verify-email.tsx (useLocalSearchParams). No back
// chevron: there is usually no stack behind a deep link.

const NETWORK_MSG = "Can't reach Kiwi. Check your connection and try again.";
const LINK_INVALID_MSG = "This link is invalid or has expired.";
const SUCCESS_TOAST = "Password changed. Sign in with your new password.";

type Stage = "form" | "invalid";

export default function ResetPasswordPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{ token?: string | string[] }>();
  const rawToken = Array.isArray(params.token) ? params.token[0] : params.token;
  const token = typeof rawToken === "string" ? rawToken : "";

  const [password, setPassword] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Missing / empty token → invalid immediately, with NO request.
  const [stage, setStage] = React.useState<Stage>(token ? "form" : "invalid");
  // Synchronous double-submit latch: state alone is not enough for two taps
  // in one tick, and a second confirm would spend nothing but get the opaque
  // 400 — the user would see "Link not valid" right after a success.
  const inFlightRef = React.useRef(false);

  const goToSignIn = () => router.replace("/(auth)/sign-in");
  const goToRequest = () => router.replace("/(auth)/forgot-password");

  const handleSubmit = async () => {
    if (inFlightRef.current) return;
    // Client checks — same order and strings as the reset web page.
    if (password.length < 8) {
      setError("Use at least 8 characters.");
      return;
    }
    if (password.length > 100) {
      setError("Use at most 100 characters.");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords do not match.");
      return;
    }
    setError(null);
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      await confirmPasswordReset(token, password);
      // Toast first, then navigate — the host is above the navigator, so the
      // toast survives the replace.
      showToast({ message: SUCCESS_TOAST });
      router.replace("/(auth)/sign-in");
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        // Bad, expired, or already-spent — the server answers the same 400
        // for all three on purpose (BUG-233). A schema 400 can't reach here:
        // the bounds above are the server's.
        setStage("invalid");
      } else if (err instanceof ApiError) {
        // 429 / 500: the server's own copy, form re-enabled.
        setError(err.message);
      } else if (err instanceof ApiNetworkError) {
        setError(NETWORK_MSG);
      } else {
        setError("Something went wrong. Please try again.");
      }
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  };

  if (stage === "invalid") {
    return (
      <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
        <View style={styles.centered}>
          <View style={styles.card}>
            <View style={styles.iconWrapAlert}>
              <Feather name="alert-triangle" size={32} color={Colors.terracotta[600]} />
            </View>
            <Text style={styles.heading}>Link not valid</Text>
            <Text style={styles.message}>{LINK_INVALID_MSG}</Text>
            <View style={styles.actionWrap}>
              <Button label="Request a new link" variant="primary" onPress={goToRequest} />
            </View>
            <Pressable onPress={goToSignIn}>
              <Text style={styles.link}>Back to sign in</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <View style={styles.body}>
        <Text style={styles.title}>Set a new password</Text>
        <Text style={styles.hint}>
          Choose a new password for your Kiwi account. At least 8 characters.
        </Text>
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="New password"
          placeholderTextColor={Palette.text.placeholder}
          secureTextEntry
          autoComplete="new-password"
          style={styles.input}
          editable={!submitting}
        />
        <TextInput
          value={confirm}
          onChangeText={setConfirm}
          placeholder="Confirm new password"
          placeholderTextColor={Palette.text.placeholder}
          secureTextEntry
          autoComplete="new-password"
          style={styles.input}
          editable={!submitting}
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {submitting ? (
          <View style={styles.buttonLoading}>
            <ActivityIndicator color={Colors.sage[700]} />
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Change password" />
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
  body: { gap: Spacing[3], paddingTop: Spacing[3] },
  title: { fontSize: Typography.fontSize.xl * 1.4, fontWeight: "700", color: Colors.neutral[900], fontFamily: Typography.face.serif[700] },
  hint: { fontSize: Typography.fontSize.sm, color: Colors.neutral[700], fontFamily: Typography.face.sans[400], lineHeight: 20 },
  // BUG-295 — explicit `color`; see sign-in.tsx.
  input: { borderWidth: 1, borderColor: Colors.neutral[400], borderRadius: Radius.md, padding: Spacing[3], fontSize: Typography.fontSize.md, color: Colors.neutral[900], backgroundColor: Palette.background.card, fontFamily: Typography.face.sans[400] },
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
  iconWrapAlert: {
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
