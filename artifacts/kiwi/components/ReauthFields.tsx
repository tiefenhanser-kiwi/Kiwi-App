// SEC-3 B — "Confirm it's you": the password field, the refusal line, and,
// when the server wants a recent sign-in, "Sign in again to confirm" with the
// provider buttons. Shared by app/delete-account.tsx and the email change in
// app/(tabs)/profile.tsx; the state is hooks/useReauthAction.ts's and every
// string is lib/reauth.ts's.
//
// A completed "Sign in again" calls `onSignedInAgain`, and the screen retries
// its action with the fresh session — the member does not press the button a
// second time.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { PasswordField } from "@/components/PasswordField";
import { SocialSignInBlock } from "@/components/oauth/SocialSignInBlock";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { ReauthAction } from "@/hooks/useReauthAction";
import {
  REAUTH_PASSWORD_HINT,
  REAUTH_PASSWORD_LABEL,
  REAUTH_SIGN_IN_AGAIN,
  REAUTH_SIGN_IN_AGAIN_FALLBACK,
  offersSignInAgain,
  reauthMessage,
  showsPasswordField,
} from "@/lib/reauth";

export function ReauthFields({
  reauth,
  onSignedInAgain,
  disabled,
}: {
  reauth: ReauthAction;
  onSignedInAgain: () => void;
  disabled?: boolean;
}) {
  const { hasPassword, password, setPassword, failure } = reauth;
  return (
    <View style={s.wrap} testID="reauth-fields">
      {showsPasswordField(hasPassword) && (
        <View style={s.field}>
          <Text style={s.label}>{REAUTH_PASSWORD_LABEL}</Text>
          <PasswordField
            value={password}
            onChangeText={setPassword}
            placeholder={REAUTH_PASSWORD_LABEL}
            placeholderTextColor={Palette.text.placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="password"
            textContentType="password"
            editable={!disabled}
            style={s.input}
            testID="reauth-password"
          />
          {hasPassword === null && <Text style={s.hint}>{REAUTH_PASSWORD_HINT}</Text>}
        </View>
      )}
      {failure !== null && (
        <Text style={s.error} testID="reauth-error">
          {reauthMessage(failure, hasPassword)}
        </Text>
      )}
      {failure !== null && offersSignInAgain(failure, hasPassword) && (
        <View style={s.again} testID="reauth-sign-in-again">
          <Text style={s.againHeading}>{REAUTH_SIGN_IN_AGAIN}</Text>
          <SocialSignInBlock
            mode="signin"
            reauth
            disabled={disabled}
            onSuccess={() => onSignedInAgain()}
          />
          <Text style={s.hint}>{REAUTH_SIGN_IN_AGAIN_FALLBACK}</Text>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: Spacing[2] },
  field: { gap: Spacing[1] },
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
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
  hint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  error: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  again: {
    gap: Spacing[2],
    marginTop: Spacing[1],
  },
  againHeading: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
});
