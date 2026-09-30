import React from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useRouter, Link } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { SocialSignInBlock } from "@/components/oauth/SocialSignInBlock";
import { PasswordField } from "@/components/PasswordField";
import { useAuth } from "@/contexts/AuthContext";
import { useGuestOptional } from "@/contexts/GuestContext";
import { useSubmitCooldown } from "@/hooks/useSubmitCooldown";
import { authErrorPresentation } from "@/lib/authErrorCopy";
import { CLAIM_BUSY_LABEL, CLAIM_LOST_LINE, CLAIM_RETRY_LINE } from "@/lib/guest/claim";
import { readGuestSessionId } from "@/lib/guest/guestToken";
import { authLanding } from "@/lib/authCompletion";
import type { OAuthAuthResponse } from "@/lib/oauth/api";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";

export default function SignInPage() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { login, error, clearError } = useAuth();
  const cooldown = useSubmitCooldown();
  // Row 13 Block 2 Part E (R5) — the door sheet offers "Already have an account?
  // Sign in", and the server claims the plan for a returning user too, WITHOUT
  // copying preferences (theirs are theirs). useGuestOptional, not useGuest: this
  // screen renders in the member app as well, where no provider-backed guest
  // session exists.
  const guestCtx = useGuestOptional();

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const claimPending = submitting && !!guestCtx?.session;

  // ── Row 9 (1.1) · OAuth Block 2 Part E — a social sign-in completes ────
  //
  // §2.5 — the routing is IDENTICAL to a password sign-in, and it is one
  // function (lib/authCompletion.ts authLanding) rather than this screen's own
  // opinion. Where the password path routes through "/" and lets index.tsx
  // re-derive the gate from the cached user, this reads the SAME fact off the
  // response the server just sent: onboardingRequired is !onboardingComplete.
  //
  // 🔴 AND IT MAY HAVE BEEN A SIGN-UP. Tapping Continue with Apple on the
  // SIGN-IN screen having never used Kiwi creates the account — the server
  // says so with isNewUser — so the claim copy has to cover both, and the
  // title on screen is the only thing that said "sign in".
  const handleSocialSuccess = React.useCallback(
    (res: OAuthAuthResponse, ctx: { claimAttempted: boolean }) => {
      if (ctx.claimAttempted) {
        guestCtx?.setGeneration(null);
        if (res.claimRetryable) {
          Alert.alert(res.isNewUser ? "Account created" : "Signed in", CLAIM_RETRY_LINE);
        } else if (res.isNewUser && res.claimedPlanId === null) {
          // The claim was refused (409) and the sign-up was resent without it.
          // Only reachable for a NEW user: an existing account's failed claim
          // is logged and never refused, so it never 409s.
          Alert.alert("Account created", CLAIM_LOST_LINE);
        }
      }
      router.replace(authLanding(res));
    },
    [guestCtx, router],
  );

  const handleSubmit = async () => {
    if (!email.trim() || !password || cooldown.active) return;
    clearError();
    setSubmitting(true);
    // Row 13 Block 2 Part E — read before the call; a successful claim clears the
    // guest store inside login().
    const claimedGuestSession = readGuestSessionId() !== null;
    try {
      const res = await login(email.trim(), password);
      if (claimedGuestSession) {
        guestCtx?.setGeneration(null);
        // R7 — stage 2 failed and the claim was RELEASED; the next sign-in with
        // the same id retries it, which is why the id is deliberately kept.
        if (res.claimRetryable) Alert.alert("Signed in", CLAIM_RETRY_LINE);
      }
      // Route through index.tsx's state machine (WS7-2-E Bug 2) so a user
      // who bailed mid-onboarding resumes at the right gate on re-login.
      router.replace("/");
    } catch (err) {
      // The message is already in context.error. BUG-296 — a 429 also holds
      // the button for the server's Retry-After so the bucket can refill.
      const { retryAfterSec } = authErrorPresentation(err, "Login failed");
      if (retryAfterSec !== null) cooldown.start(retryAfterSec);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.wrap, { paddingTop: insets.top + 8 }]}>
      <Pressable onPress={() => router.back()} hitSlop={12} style={styles.back}>
        <Feather name="chevron-left" size={26} color={Colors.sage[700]} />
      </Pressable>
      {/* Sept 29 design review — the form SCROLLS and clears the keyboard.
          sign-up has done this since BUG-077; these three did not, so a focused
          field near the bottom sat under the keyboard and, at a large font
          scale, the trailing links were unreachable even with it dismissed.
          Pattern copied verbatim from sign-up.tsx: `style={{ flex: 1 }}` on the
          scroller, the old `body` style moved to contentContainerStyle, and the
          safe-area bottom inset added there. The Compat wrapper already
          defaults bottomOffset to Spacing[6] and degrades to a plain ScrollView
          on web. */}
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={[
          styles.body,
          { paddingBottom: insets.bottom + Spacing[5] },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={styles.title}>Sign in</Text>
        {/* §2.1 — at the TOP, then the divider, then the email form. Renders
            nothing at all while neither provider is configured. */}
        <SocialSignInBlock
          mode="signin"
          disabled={submitting}
          onSuccess={handleSocialSuccess}
        />
        <TextInput
          value={email}
          onChangeText={setEmail}
          placeholder="Email"
          placeholderTextColor={Palette.text.placeholder}
          autoCapitalize="none"
          keyboardType="email-address"
          autoComplete="email"
          style={styles.input}
          editable={!submitting}
        />
        <PasswordField
          value={password}
          onChangeText={setPassword}
          placeholder="Password"
          placeholderTextColor={Palette.text.placeholder}
          autoComplete="password"
          style={styles.input}
          editable={!submitting}
        />
        {error && <Text style={styles.errorText}>{error}</Text>}
        {submitting ? (
          <View style={styles.buttonLoading}>
            <ActivityIndicator color={Colors.sage[700]} />
            {/* R7 — a sign-in that is also claiming a plan takes ~10s. */}
            {claimPending ? <Text style={styles.claimBusy}>{CLAIM_BUSY_LABEL}</Text> : null}
          </View>
        ) : (
          <Button onPress={handleSubmit} label="Sign in" disabled={cooldown.active} />
        )}
        <Link href="/(auth)/forgot-password" asChild>
          <Pressable>
            <Text style={styles.link}>Forgot your password?</Text>
          </Pressable>
        </Link>
        <Link href="/(auth)/sign-up" asChild>
          <Pressable>
            <Text style={styles.link}>Don't have an account? Sign up</Text>
          </Pressable>
        </Link>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

const styles = StyleSheet.create({
  // paddingHorizontal, not padding: the bottom pad moved onto the scroller's
  // contentContainerStyle (with the safe-area inset) and the top is set inline.
  wrap: { flex: 1, backgroundColor: Colors.neutral[100], paddingHorizontal: Spacing[4] },
  back: { marginBottom: Spacing[3] },
  body: { gap: Spacing[3] },
  title: { fontSize: Typography.fontSize.xl * 1.4, fontWeight: "700", color: Colors.neutral[900], fontFamily: Typography.face.serif[700] },
  // BUG-295 — `color` is explicit: with neither it nor placeholderTextColor
  // set, the preview APK rendered white-on-white (the native EditText theme
  // decided). Every other text on this screen already sets a Colors.* value.
  input: { borderWidth: 1, borderColor: Colors.neutral[400], borderRadius: Radius.md, padding: Spacing[3], fontSize: Typography.fontSize.md, color: Colors.neutral[900], backgroundColor: Palette.background.card, fontFamily: Typography.face.sans[400] },
  claimBusy: { marginTop: Spacing[2], fontSize: Typography.fontSize.sm, color: Colors.neutral[700], fontFamily: Typography.face.sans[500], textAlign: "center" },
  errorText: { color: Colors.terracotta[700], fontSize: Typography.fontSize.sm, fontFamily: Typography.face.sans[500] },
  buttonLoading: { alignItems: "center", padding: Spacing[3] },
  link: { color: Colors.sage[700], fontSize: Typography.fontSize.md, textAlign: "center", marginTop: Spacing[2], fontFamily: Typography.face.sans[500] },
});
