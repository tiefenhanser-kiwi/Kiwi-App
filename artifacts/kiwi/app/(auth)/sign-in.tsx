import React from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter, Link } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";

// TODO(WS2-E): Rewrite against real POST /auth/login endpoint.
// Current behavior is a bypass stub — any submit jumps to tabs.
// Phase 2A removed Clerk; Phase 2E will wire custom JWT auth.

export default function SignInPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");

  const handleSubmit = () => {
    // Bypass — no auth validation yet. See WS2-E.
    router.replace("/(tabs)");
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={KColors.sage[700]} />
      </Pressable>
      <View style={styles.body}>
        <Text style={styles.title}>Sign in</Text>
        <Text style={styles.subtitle}>
          Auth bypass active during WS2 rebuild — any credentials work.
        </Text>
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          autoCapitalize="none"
          keyboardType="email-address"
          style={styles.input}
        />
        <TextInput
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          secureTextEntry
          style={styles.input}
        />
        <Button onPress={handleSubmit} label="Sign in" />
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
  wrap: { flex: 1, backgroundColor: KColors.neutral[100], padding: KSpacing.lg },
  back: { marginBottom: KSpacing.md },
  body: { gap: KSpacing.md },
  title: { fontSize: KType.size.xl * 1.4, fontWeight: "700", color: KColors.neutral[900], fontFamily: "Inter_700Bold" },
  subtitle: { fontSize: KType.size.md, color: KColors.neutral[700], fontFamily: "Inter_400Regular" },
  input: { borderWidth: 1, borderColor: KColors.neutral[400], borderRadius: KRadius.md, padding: KSpacing.md, fontSize: KType.size.md, backgroundColor: KColors.neutral[0], fontFamily: "Inter_400Regular" },
  link: { color: KColors.sage[700], fontSize: KType.size.md, textAlign: "center", marginTop: KSpacing.sm, fontFamily: "Inter_500Medium" },
});
