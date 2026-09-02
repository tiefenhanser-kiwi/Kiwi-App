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
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useAuth } from "@/contexts/AuthContext";
import { TRIAL_LENGTH_DAYS } from "@/lib/domain";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

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
      // router.replace clears the current (auth) screen from history, so
      // back-swipe can't return to a half-completed signup form. We avoid
      // dismissAll() here — the (auth) group is a regular Stack, not a
      // presented modal stack, so dismissAll() emits a POP_TO_TOP action
      // that races with the AuthLayout redirect (fires when the freshly-set
      // token flips isAuthenticated true) and surfaces a "POP_TO_TOP not
      // handled" warning.
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
        <Feather name="chevron-left" size={26} color={Colors.sage[700]} />
      </Pressable>
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + Spacing[5] },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.stepIndicator}>Step 1 of 3</Text>
        <Text style={styles.title}>Create account</Text>

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
            <ActivityIndicator color={Colors.sage[700]} />
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Create account" />
        )}
        <Text style={styles.trustSignal}>
          {`${TRIAL_LENGTH_DAYS}-day free trial · no credit card needed`}
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
        color={checked ? Colors.sage[700] : Colors.neutral[600]}
      />
      <Text style={styles.consentLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
    paddingHorizontal: Spacing[4],
  },
  back: { marginBottom: Spacing[2] },
  body: { gap: Spacing[3] },
  stepIndicator: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textTransform: "uppercase",
    letterSpacing: 0.6,
  },
  title: {
    fontSize: Typography.fontSize.xl * 1.4,
    fontWeight: Typography.fontWeight.bold,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[700],
    marginTop: -Spacing[1],
  },
  input: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    borderRadius: Radius.md,
    padding: Spacing[3],
    fontSize: Typography.fontSize.md,
    backgroundColor: Palette.background.card,
    fontFamily: Typography.face.sans[400],
  },
  consentRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
    paddingVertical: 4,
  },
  consentLabel: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    lineHeight: 18,
    fontFamily: Typography.face.sans[400],
  },
  errorText: {
    color: Colors.terracotta[700],
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[500],
  },
  buttonLoading: { alignItems: "center", padding: Spacing[3] },
  trustSignal: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    textAlign: "center",
    marginTop: -Spacing[1],
    fontFamily: Typography.face.sans[400],
  },
});
