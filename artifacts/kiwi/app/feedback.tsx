import React, { useState } from "react";
import { Keyboard, Platform, StyleSheet, Text, TextInput, View } from "react-native";
import Constants from "expo-constants";
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { sendFeedback } from "@/lib/api/me";
import { ApiError } from "@/lib/api/errors";
import {
  FEEDBACK_MAX_CHARS,
  canSendFeedback,
  feedbackErrorText,
  feedbackPlatform,
} from "@/lib/feedback";

// LIFE-1 — "Send feedback", opened from Profile. One text box, an optional
// "where in the app" line (pre-filled from `?from=` when a screen links here
// with its own name), and Send. The server emails it to Hans with the
// member's address, the app version and the platform (routes/feedback.ts).
//
// Web parity: every outcome is inline text on this screen — no Alert, which
// is an empty stub on react-native-web (lib/dialog.ts).
export default function FeedbackScreen() {
  const router = useRouter();
  const { from } = useLocalSearchParams<{ from?: string }>();
  const [message, setMessage] = useState("");
  const [screen, setScreen] = useState(typeof from === "string" ? from : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const handleSend = async () => {
    if (!canSendFeedback(message) || busy) return;
    Keyboard.dismiss();
    setBusy(true);
    setError(null);
    try {
      await sendFeedback({
        message: message.trim(),
        ...(screen.trim() ? { screen: screen.trim().slice(0, 80) } : {}),
        ...(Constants.expoConfig?.version ? { appVersion: Constants.expoConfig.version } : {}),
        ...(feedbackPlatform(Platform.OS) ? { platform: feedbackPlatform(Platform.OS) } : {}),
      });
      setSent(true);
    } catch (err) {
      setError(feedbackErrorText(err instanceof ApiError ? err.status : null));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title="Send feedback" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {sent ? (
          <View style={s.card}>
            <Text style={s.cardTitle}>Thank you</Text>
            <Text style={s.body}>
              Your feedback is on its way to Hans. If he has a question, he'll reply by email.
            </Text>
            <View style={s.action}>
              <Button label="Done" variant="primary" onPress={() => router.back()} />
            </View>
          </View>
        ) : (
          <View style={s.card}>
            <Text style={s.cardTitle}>What's on your mind?</Text>
            <Text style={s.body}>
              Something broken, confusing, or missing? Something you love? It goes straight to
              Hans, who built Kiwi.
            </Text>
            <TextInput
              value={message}
              onChangeText={setMessage}
              placeholder="Type your feedback"
              placeholderTextColor={Palette.text.placeholder}
              multiline
              maxLength={FEEDBACK_MAX_CHARS}
              textAlignVertical="top"
              accessibilityLabel="Your feedback"
              style={[s.input, s.messageInput]}
            />
            <Text style={s.label}>Where in the app? (optional)</Text>
            <TextInput
              value={screen}
              onChangeText={setScreen}
              placeholder="e.g. Grocery list"
              placeholderTextColor={Palette.text.placeholder}
              maxLength={80}
              accessibilityLabel="Where in the app"
              style={s.input}
            />
            {error && <Text style={s.error}>{error}</Text>}
            <View style={s.action}>
              <Button
                label="Send"
                variant="primary"
                loading={busy}
                disabled={busy || !canSendFeedback(message)}
                onPress={handleSend}
              />
            </View>
          </View>
        )}
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
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
    gap: Spacing[2],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  body: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
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
  messageInput: {
    minHeight: 160,
    marginTop: Spacing[1],
  },
  error: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
  },
  action: {
    marginTop: Spacing[2],
  },
});
