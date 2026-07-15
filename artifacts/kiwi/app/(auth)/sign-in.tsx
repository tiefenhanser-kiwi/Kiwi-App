import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter, Link } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { useAuth } from "@/contexts/AuthContext";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export default function SignInPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { login, error, clearError } = useAuth();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const handleSubmit = async () => {
    if (!email.trim() || !password) return;
    clearError();
    setSubmitting(true);
    try {
      await login(email.trim(), password);
      // Route through index.tsx's state machine (WS7-2-E Bug 2) so a user
      // who bailed mid-onboarding resumes at the right gate on re-login.
      router.replace("/");
    } catch {
      // Error is already in context.error; submit button re-enables below.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={Colors.sage[700]} />
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>Sign in</Text>
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
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          autoComplete="password"
          style={styles.input}
          editable={!submitting}
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {submitting ? (
          <View style={styles.buttonLoading}>
            <ActivityIndicator color={Colors.sage[700]} />
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Sign in" />
        )}
        <Link href="/(auth)/sign-up" asChild>
          <Pressable>
            <Text style={styles.link}>Don't have an account? Sign up</Text>
          </Pressable>
        </Link>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: Colors.neutral[100], padding: Spacing[4] },
  back: { marginBottom: Spacing[3] },
  body: { gap: Spacing[3] },
  title: { fontSize: Typography.fontSize.xl * 1.4, fontWeight: "700", color: Colors.neutral[900], fontFamily: Typography.face.serif[700] },
  input: { borderWidth: 1, borderColor: Colors.neutral[400], borderRadius: Radius.md, padding: Spacing[3], fontSize: Typography.fontSize.md, backgroundColor: Palette.background.card, fontFamily: Typography.face.sans[400] },
  errorText: { color: Colors.terracotta[700], fontSize: Typography.fontSize.sm, fontFamily: Typography.face.sans[500] },
  buttonLoading: { alignItems: "center", padding: Spacing[3] },
  link: { color: Colors.sage[700], fontSize: Typography.fontSize.md, textAlign: "center", marginTop: Spacing[2], fontFamily: Typography.face.sans[500] },
});
