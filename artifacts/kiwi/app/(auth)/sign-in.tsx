import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter, Link } from "expo-router";
import { useSignIn } from "@clerk/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

export default function SignInPage() {
  const { signIn, errors, fetchStatus } = useSignIn();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");

  const handleSubmit = async () => {
    const { error } = await signIn.password({ emailAddress, password });
    if (error) return;
    if (signIn.status === "complete") {
      await signIn.finalize({
        navigate: () => router.replace("/"),
      });
    }
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={KColors.sage[700]} />
      </Pressable>

      <View style={styles.body}>
        <Text style={styles.title}>Welcome back</Text>
        <Text style={styles.subtitle}>Sign in to keep cooking with Kiwi.</Text>

        <View style={{ height: KSpacing.xl }} />

        <Text style={styles.label}>Email</Text>
        <TextInput
          style={styles.input}
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          placeholder="you@example.com"
          placeholderTextColor={KColors.neutral[600]}
          value={emailAddress}
          onChangeText={setEmailAddress}
        />
        {errors?.fields?.identifier && (
          <Text style={styles.error}>{errors.fields.identifier.message}</Text>
        )}

        <Text style={[styles.label, { marginTop: KSpacing.lg }]}>Password</Text>
        <TextInput
          style={styles.input}
          secureTextEntry
          placeholder="Your password"
          placeholderTextColor={KColors.neutral[600]}
          value={password}
          onChangeText={setPassword}
        />
        {errors?.fields?.password && (
          <Text style={styles.error}>{errors.fields.password.message}</Text>
        )}

        <View style={{ height: KSpacing.xl }} />
        <Button
          label="Sign in"
          variant="primary"
          onPress={handleSubmit}
          loading={fetchStatus === "fetching"}
          disabled={!emailAddress || !password}
        />

        <View style={styles.linkRow}>
          <Text style={styles.muted}>Don't have an account? </Text>
          <Link href="/(auth)/sign-up">
            <Text style={styles.link}>Sign up</Text>
          </Link>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: KColors.neutral[100],
    paddingHorizontal: KSpacing.xl,
  },
  back: { width: 40, height: 40, justifyContent: "center" },
  body: { marginTop: KSpacing.xxl },
  title: {
    fontSize: KType.size.display,
    fontWeight: "700",
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
  },
  subtitle: {
    marginTop: 6,
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  label: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    marginBottom: 6,
    fontFamily: "Inter_500Medium",
    fontWeight: "500",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 14,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  error: {
    color: KColors.terracotta[600],
    fontSize: KType.size.sm,
    marginTop: 4,
    fontFamily: "Inter_400Regular",
  },
  linkRow: {
    flexDirection: "row",
    justifyContent: "center",
    marginTop: KSpacing.xl,
  },
  muted: { color: KColors.neutral[700], fontFamily: "Inter_400Regular" },
  link: {
    color: KColors.sage[700],
    fontWeight: "600",
    fontFamily: "Inter_600SemiBold",
  },
});
