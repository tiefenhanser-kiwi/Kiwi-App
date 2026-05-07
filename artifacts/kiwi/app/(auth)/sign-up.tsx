import React from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather, FontAwesome } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

function showOauthStub() {
  Alert.alert(
    "Coming in WS6 — OAuth integration",
    "Apple/Google sign-in requires the OAuth infrastructure. This will be wired in WS6. For now, please use the email/password form below.",
  );
}

export default function SignUpPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signup, error, clearError } = useAuth();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [emailConsent, setEmailConsent] = React.useState(false);
  const [smsConsent, setSmsConsent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  const firstNameRef = React.useRef<TextInput>(null);
  const lastNameRef = React.useRef<TextInput>(null);
  const emailRef = React.useRef<TextInput>(null);
  const passwordRef = React.useRef<TextInput>(null);
  const phoneRef = React.useRef<TextInput>(null);

  const phoneEntered = phone.trim().length > 0;

  // Reset SMS consent if the phone number is cleared, so a re-add doesn't
  // silently inherit a prior opt-in.
  React.useEffect(() => {
    if (!phoneEntered && smsConsent) setSmsConsent(false);
  }, [phoneEntered, smsConsent]);

  const canSubmit =
    email.trim().length > 0 &&
    password.length >= 8 &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    !submitting;

  const handleSubmit = async () => {
    console.log("[sign-up] submit attempt", {
      email: email.trim(),
      hasPhone: phoneEntered,
      canSubmit,
    });
    if (!canSubmit) {
      console.log("[sign-up] submit blocked — canSubmit=false", {
        emailLen: email.trim().length,
        passwordLen: password.length,
        firstNameLen: firstName.trim().length,
        lastNameLen: lastName.trim().length,
        submitting,
      });
      Alert.alert(
        "Missing required fields",
        "Please enter your name, email, and a password of at least 8 characters.",
      );
      return;
    }
    clearError();
    setSubmitting(true);
    try {
      // Phone + consent flags collected here; the signup payload extension
      // (server-side User.phone + consent storage) lands in WS5-firstrun-2
      // or WS6 depending on schema-migration scheduling. For now, we keep
      // the existing 4-arg signup() shape so this sub-phase ships cleanly.
      await signup(email.trim(), password, firstName.trim(), lastName.trim());
      // dismissAll clears the (auth) stack so back-swipe can't return to
      // a half-completed signup form once the user is authenticated.
      router.dismissAll();
      router.replace("/onboarding-prefs");
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Signup failed. Please try again.";
      console.log("[sign-up] submit failed", message);
      Alert.alert("Couldn't create your account", message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={KColors.sage[700]} />
      </Pressable>
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + KSpacing.xl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.stepIndicator}>Step 1 of 3</Text>
        <Text style={styles.title}>Create account</Text>

        <Pressable
          onPress={showOauthStub}
          style={({ pressed }) => [styles.oauthButton, pressed && { opacity: 0.85 }]}
        >
          <FontAwesome name="apple" size={20} color={KColors.neutral[900]} />
          <Text style={styles.oauthLabel}>Continue with Apple</Text>
        </Pressable>
        <Pressable
          onPress={showOauthStub}
          style={({ pressed }) => [styles.oauthButton, pressed && { opacity: 0.85 }]}
        >
          <FontAwesome name="google" size={18} color={KColors.neutral[900]} />
          <Text style={styles.oauthLabel}>Continue with Google</Text>
        </Pressable>

        <View style={styles.dividerRow}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>OR</Text>
          <View style={styles.dividerLine} />
        </View>

        <TextInput
          ref={firstNameRef}
          value={firstName}
          onChangeText={setFirstName}
          placeholder="First name"
          autoCapitalize="words"
          autoComplete="given-name"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => lastNameRef.current?.focus()}
          style={styles.input}
          editable={!submitting}
        />
        <TextInput
          ref={lastNameRef}
          value={lastName}
          onChangeText={setLastName}
          placeholder="Last name"
          autoCapitalize="words"
          autoComplete="family-name"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => emailRef.current?.focus()}
          style={styles.input}
          editable={!submitting}
        />
        <TextInput
          ref={emailRef}
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          autoComplete="email"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => passwordRef.current?.focus()}
          style={styles.input}
          editable={!submitting}
        />
        <TextInput
          ref={passwordRef}
          value={password}
          onChangeText={setPassword}
          placeholder="Password (min 8 characters)"
          secureTextEntry
          autoComplete="new-password"
          returnKeyType="next"
          blurOnSubmit={false}
          onSubmitEditing={() => phoneRef.current?.focus()}
          style={styles.input}
          editable={!submitting}
        />
        <TextInput
          ref={phoneRef}
          value={phone}
          onChangeText={setPhone}
          placeholder="Phone number (optional)"
          keyboardType="phone-pad"
          autoComplete="tel"
          returnKeyType="done"
          onSubmitEditing={Keyboard.dismiss}
          style={styles.input}
          editable={!submitting}
        />

        <ConsentRow
          checked={emailConsent}
          onToggle={() => setEmailConsent((v) => !v)}
          label="Email me weekly meal plan tips and Kiwi updates."
        />
        {phoneEntered && (
          <ConsentRow
            checked={smsConsent}
            onToggle={() => setSmsConsent((v) => !v)}
            label="Text me grocery reminders and weekly plan nudges. (Standard rates apply)"
          />
        )}

        {error && <Text style={styles.errorText}>{error}</Text>}
        {submitting ? (
          <View style={styles.buttonLoading}>
            <ActivityIndicator color={KColors.sage[700]} />
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Create account" />
        )}
        <Text style={styles.trustSignal}>
          30-day free trial · no credit card needed
        </Text>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function ConsentRow({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={({ pressed }) => [styles.consentRow, pressed && { opacity: 0.7 }]}
      hitSlop={6}
    >
      <Feather
        name={checked ? "check-square" : "square"}
        size={20}
        color={checked ? KColors.sage[700] : KColors.neutral[600]}
      />
      <Text style={styles.consentLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: KColors.neutral[100],
    paddingHorizontal: KSpacing.lg,
  },
  back: { marginBottom: KSpacing.sm },
  body: { gap: KSpacing.md },
  stepIndicator: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  title: {
    fontSize: KType.size.xl * 1.4,
    fontWeight: "700",
    color: KColors.neutral[900],
    fontFamily: "Inter_700Bold",
    marginTop: -KSpacing.xs,
  },
  oauthButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[0],
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    borderRadius: KRadius.lg,
    paddingVertical: 14,
    paddingHorizontal: KSpacing.lg,
  },
  oauthLabel: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dividerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    marginVertical: KSpacing.xs,
  },
  dividerLine: {
    flex: 1,
    height: 1,
    backgroundColor: KColors.neutral[400],
  },
  dividerText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    letterSpacing: 1,
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    borderRadius: KRadius.md,
    padding: KSpacing.md,
    fontSize: KType.size.md,
    backgroundColor: KColors.neutral[0],
    fontFamily: "Inter_400Regular",
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: KSpacing.sm,
    paddingVertical: 4,
  },
  consentLabel: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    lineHeight: 18,
    fontFamily: "Inter_400Regular",
  },
  errorText: {
    color: KColors.terracotta?.[700] ?? "#c04a2e",
    fontSize: KType.size.sm,
    fontFamily: "Inter_500Medium",
  },
  buttonLoading: { alignItems: "center", padding: KSpacing.md },
  trustSignal: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    textAlign: "center",
    marginTop: -KSpacing.xs,
    fontFamily: "Inter_400Regular",
  },
});
