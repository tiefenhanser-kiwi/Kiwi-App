import React from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

export default function SignUpPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { signup, error, clearError } = useAuth();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [firstName, setFirstName] = React.useState("");
  const [lastName, setLastName] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  const canSubmit =
    email.trim().length > 0 &&
    password.length >= 8 &&
    firstName.trim().length > 0 &&
    lastName.trim().length > 0 &&
    !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    clearError();
    setSubmitting(true);
    try {
      await signup(email.trim(), password, firstName.trim(), lastName.trim());
      router.replace("/onboarding-prefs");
    } catch {
      // Error in context.error; button re-enables below.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={KColors.sage[700]} />
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>Create account</Text>
        <TextInput
          value={firstName}
          onChangeText={setFirstName}
          placeholder="First name"
          autoCapitalize="words"
          style={styles.input}
          editable={!submitting}
        />
        <TextInput
          value={lastName}
          onChangeText={setLastName}
          placeholder="Last name"
          autoCapitalize="words"
          style={styles.input}
          editable={!submitting}
        />
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
          placeholder="Password (min 8 characters)"
          secureTextEntry
          autoComplete="new-password"
          style={styles.input}
          editable={!submitting}
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {submitting ? (
          <View style={styles.buttonLoading}>
            <ActivityIndicator color={KColors.sage[700]} />
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Create account" />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: KColors.neutral[100], padding: KSpacing.lg },
  back: { marginBottom: KSpacing.md },
  body: { gap: KSpacing.md },
  title: { fontSize: KType.size.xl * 1.4, fontWeight: "700", color: KColors.neutral[900], fontFamily: "Inter_700Bold" },
  input: { borderWidth: 1, borderColor: KColors.neutral[400], borderRadius: KRadius.md, padding: KSpacing.md, fontSize: KType.size.md, backgroundColor: KColors.neutral[0], fontFamily: "Inter_400Regular" },
  errorText: { color: KColors.terracotta?.[700] ?? "#c04a2e", fontSize: KType.size.sm, fontFamily: "Inter_500Medium" },
  buttonLoading: { alignItems: "center", padding: KSpacing.md },
});
