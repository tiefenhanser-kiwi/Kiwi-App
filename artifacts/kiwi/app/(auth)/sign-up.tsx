import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter, Link } from "expo-router";
import { useSignUp } from "@clerk/expo";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

export default function SignUpPage() {
  const { signUp, errors, fetchStatus } = useSignUp();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [emailAddress, setEmailAddress] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");

  const handleSubmit = async () => {
    const { error } = await signUp.password({ emailAddress, password });
    if (error) return;
    await signUp.verifications.sendEmailCode();
  };

  const handleVerify = async () => {
    await signUp.verifications.verifyEmailCode({ code });
    if (signUp.status === "complete") {
      await signUp.finalize({
        navigate: () => router.replace("/onboarding-prefs"),
      });
    }
  };

  const needsCode =
    signUp.status === "missing_requirements" &&
    signUp.unverifiedFields?.includes("email_address") &&
    signUp.missingFields?.length === 0;

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={KColors.sage[700]} />
      </Pressable>

      {needsCode ? (
        <View style={styles.body}>
          <Text style={styles.title}>Check your email</Text>
          <Text style={styles.subtitle}>
            We sent a verification code to {emailAddress}.
          </Text>
          <View style={{ height: KSpacing.xl }} />
          <Text style={styles.label}>Verification code</Text>
          <TextInput
            style={styles.input}
            keyboardType="numeric"
            placeholder="123456"
            placeholderTextColor={KColors.neutral[600]}
            value={code}
            onChangeText={setCode}
          />
          {errors?.fields?.code && (
            <Text style={styles.error}>{errors.fields.code.message}</Text>
          )}
          <View style={{ height: KSpacing.xl }} />
          <Button
            label="Verify & continue"
            onPress={handleVerify}
            loading={fetchStatus === "fetching"}
            disabled={!code}
          />
          <Pressable
            onPress={() => signUp.verifications.sendEmailCode()}
            style={{ marginTop: KSpacing.md, alignSelf: "center" }}
          >
            <Text style={styles.link}>Resend code</Text>
          </Pressable>
        </View>
      ) : (
        <View style={styles.body}>
          <Text style={styles.title}>Create your account</Text>
          <Text style={styles.subtitle}>
            Start your 30-day free trial of Kiwi Premium.
          </Text>

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
          {errors?.fields?.emailAddress && (
            <Text style={styles.error}>
              {errors.fields.emailAddress.message}
            </Text>
          )}

          <Text style={[styles.label, { marginTop: KSpacing.lg }]}>
            Password
          </Text>
          <TextInput
            style={styles.input}
            secureTextEntry
            placeholder="At least 8 characters"
            placeholderTextColor={KColors.neutral[600]}
            value={password}
            onChangeText={setPassword}
          />
          {errors?.fields?.password && (
            <Text style={styles.error}>{errors.fields.password.message}</Text>
          )}

          <View style={{ height: KSpacing.xl }} />
          <Button
            label="Create account"
            onPress={handleSubmit}
            loading={fetchStatus === "fetching"}
            disabled={!emailAddress || password.length < 8}
          />

          <View style={styles.linkRow}>
            <Text style={styles.muted}>Already have an account? </Text>
            <Link href="/(auth)/sign-in">
              <Text style={styles.link}>Sign in</Text>
            </Link>
          </View>

          <View nativeID="clerk-captcha" />
        </View>
      )}
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
