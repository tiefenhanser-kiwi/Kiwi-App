import React, { useState } from "react";
import {
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
import { ApiError } from "@/lib/api/errors";
import { formatSubscriptionState } from "@/lib/domain";
import { getCurrentSubscription } from "@/lib/stubs";
import type { SubscriptionInfo } from "@/lib/types";

type EditableField = "name" | "email" | "phone";

/** Inline result banner shown under a field after a save attempt. */
type FieldStatus = { kind: "success" | "error"; text: string } | null;

const MIN_PASSWORD_LENGTH = 8;

const isValidEmail = (s: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Initials for the avatar circle. Handles edge cases:
 *   "Hans Tiefenthaler" → "HT"
 *   "Madonna"           → "M"
 *   "Mary Anne Smith"   → "MS" (first + last, skips middle)
 *   ""                  → "?" (fallback, shouldn't happen since name is required)
 */
function initialsFor(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  const first = parts[0].charAt(0);
  const last = parts[parts.length - 1].charAt(0);
  return (first + last).toUpperCase();
}

export default function ProfileTab() {
  const router = useRouter();
  const {
    updateUserName,
    requestEmailChange,
    updateUserPhone,
    changePassword,
    injectDevTestPlan,
    resetAllDevState,
  } = useApp();
  const auth = useAuth();

  // The auth cache is the source of truth for account fields — the profile
  // mutators field-merge their PATCH result into ['auth','me'], so these
  // re-derive automatically once a save lands. (Subscription stays stubbed —
  // Stripe wiring is WS8.)
  const user = auth.user;
  const displayName = user ? `${user.firstName} ${user.lastName}`.trim() : "";
  const displayEmail = user?.email ?? "";
  const displayPhone = user?.phone ?? "";

  const [subscription] = useState<SubscriptionInfo>(() =>
    getCurrentSubscription(),
  );
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [fieldStatus, setFieldStatus] = useState<FieldStatus>(null);

  // Password-change inline form (collapsed by default; the Password row
  // toggles it).
  const [pwOpen, setPwOpen] = useState(false);
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwBusy, setPwBusy] = useState(false);
  const [pwStatus, setPwStatus] = useState<FieldStatus>(null);

  const fieldDisplay = (field: EditableField): string => {
    if (field === "name") return displayName;
    if (field === "email") return displayEmail;
    return displayPhone;
  };

  const handleStartEdit = (field: EditableField) => {
    setFieldStatus(null);
    setEditingField(field);
    setDraftValue(fieldDisplay(field));
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setDraftValue("");
  };

  const handleCommitEdit = async () => {
    if (!editingField) return;
    Keyboard.dismiss();
    const field = editingField;
    const trimmed = draftValue.trim();
    // Clear the editing state up front: EditableRow fires onCommit on both
    // submit and blur, so the second call must early-return on `!editingField`.
    setEditingField(null);
    setDraftValue("");

    if (field === "name") {
      // Required — empty or unchanged reverts silently.
      if (!trimmed || trimmed === displayName) return;
      try {
        await updateUserName(trimmed);
        setFieldStatus({ kind: "success", text: "Name updated." });
      } catch {
        setFieldStatus({
          kind: "error",
          text: "Couldn't update your name. Please try again.",
        });
      }
    } else if (field === "email") {
      // Required + valid + changed; otherwise revert silently.
      if (!trimmed || !isValidEmail(trimmed) || trimmed === displayEmail) {
        return;
      }
      // Request side only — the server emails a verification link and the
      // address only changes once the user clicks through. The verify-side
      // landing screen is WS7-2 Block D.
      try {
        await requestEmailChange(trimmed);
        setFieldStatus({
          kind: "success",
          text: "Check your email for a verification link to confirm the change.",
        });
      } catch {
        setFieldStatus({
          kind: "error",
          text: "Couldn't start the email change. Please try again.",
        });
      }
    } else if (field === "phone") {
      // Clearing the phone to empty would need a null-write the /me/profile
      // contract doesn't expose yet — empty input reverts silently. A
      // non-empty, changed value PATCHes through.
      if (!trimmed || trimmed === displayPhone) return;
      try {
        await updateUserPhone(trimmed);
        setFieldStatus({ kind: "success", text: "Phone updated." });
      } catch {
        setFieldStatus({
          kind: "error",
          text: "Couldn't update your phone. Please try again.",
        });
      }
    }
  };

  const handleTogglePasswordForm = () => {
    setPwStatus(null);
    setPwOpen((open) => !open);
  };

  const handleSubmitPassword = async () => {
    Keyboard.dismiss();
    setPwStatus(null);
    if (!currentPw || !newPw || !confirmPw) {
      setPwStatus({ kind: "error", text: "Please fill in all three fields." });
      return;
    }
    if (newPw.length < MIN_PASSWORD_LENGTH) {
      setPwStatus({
        kind: "error",
        text: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      });
      return;
    }
    if (newPw !== confirmPw) {
      setPwStatus({ kind: "error", text: "New passwords don't match." });
      return;
    }

    setPwBusy(true);
    try {
      await changePassword(currentPw, newPw);
      setPwStatus({ kind: "success", text: "Password updated." });
      setCurrentPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err) {
      // The server returns a userFacingMessage on a wrong-current-password
      // 400 ("Current password is incorrect") — surface it when present.
      const text =
        err instanceof ApiError && err.userFacingMessage
          ? err.userFacingMessage
          : "Couldn't change your password. Please try again.";
      setPwStatus({ kind: "error", text });
    } finally {
      setPwBusy(false);
    }
  };

  const handlePreferences = () => {
    router.push("/preferences");
  };

  const handleAccountAndSubscription = () => {
    router.push("/manage-account");
  };

  const handleInjectDevPlan = async () => {
    await injectDevTestPlan();
    // Plans tab "This Week" card is the only AppContext-fed surface today.
    // Home hero + Plans tab "Your plans" list both read from getTodaysMeal /
    // getCurrentActivePlan / getPlansPayload stubs that return null/[]
    // unconditionally — so directing Hans to those would mislead him.
    // WS7 swaps those stubs and this Alert text becomes obsolete.
    Alert.alert(
      "Dev test plan injected",
      "Open the Plans tab and tap 'Open' on the 'This Week' card at the top to reach Plan Review.",
    );
  };

  const handleResetDevState = () => {
    Alert.alert(
      "Reset all local data?",
      "This wipes AsyncStorage and resets all in-memory state. Force-quit Expo Go and re-launch for a clean session.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: () => {
            void resetAllDevState();
          },
        },
      ],
    );
  };

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      console.log("[profile] logout fallback");
    }
    router.replace("/(auth)/welcome");
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header title="Profile" />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Section A: User card (centered avatar + name + email) */}
        <View style={s.userCard}>
          {/* TODO(WS9): tap-to-upload image picker; until then, initials only. */}
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initialsFor(displayName)}</Text>
          </View>
          <Text style={s.userName}>{displayName}</Text>
          <Text style={s.userEmail}>{displayEmail}</Text>
        </View>

        {/* Section B: Account info */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Account info</Text>
          <View style={s.fieldList}>
            <EditableRow
              label="Name"
              value={displayName}
              isEditing={editingField === "name"}
              draft={draftValue}
              onDraftChange={setDraftValue}
              onStartEdit={() => handleStartEdit("name")}
              onCommit={handleCommitEdit}
              keyboardType="default"
              placeholder="Your name"
            />
            <EditableRow
              label="Email"
              value={displayEmail}
              isEditing={editingField === "email"}
              draft={draftValue}
              onDraftChange={setDraftValue}
              onStartEdit={() => handleStartEdit("email")}
              onCommit={handleCommitEdit}
              keyboardType="email-address"
              autoCapitalize="none"
              placeholder="you@example.com"
            />
            <EditableRow
              label="Phone"
              value={displayPhone}
              displayWhenEmpty="Not set"
              isEditing={editingField === "phone"}
              draft={draftValue}
              onDraftChange={setDraftValue}
              onStartEdit={() => handleStartEdit("phone")}
              onCommit={handleCommitEdit}
              keyboardType="phone-pad"
              placeholder="Phone number"
            />
            <Pressable
              onPress={handleTogglePasswordForm}
              style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
              hitSlop={6}
            >
              <Text style={s.fieldLabel}>Password</Text>
              <View style={s.fieldRight}>
                <Text style={s.changePasswordValue}>Change password</Text>
                <Feather
                  name={pwOpen ? "chevron-up" : "chevron-right"}
                  size={16}
                  color={KColors.neutral[600]}
                />
              </View>
            </Pressable>
          </View>
          {fieldStatus && (
            <Text
              style={[
                s.statusText,
                fieldStatus.kind === "error"
                  ? s.statusError
                  : s.statusSuccess,
              ]}
            >
              {fieldStatus.text}
            </Text>
          )}
        </View>

        {/* Section B2: Change-password inline form (toggled by the row above) */}
        {pwOpen && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Change password</Text>
            <View style={s.pwForm}>
              <PasswordField
                label="Current password"
                value={currentPw}
                onChangeText={setCurrentPw}
                placeholder="Current password"
              />
              <PasswordField
                label="New password"
                value={newPw}
                onChangeText={setNewPw}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              />
              <PasswordField
                label="Confirm new password"
                value={confirmPw}
                onChangeText={setConfirmPw}
                placeholder="Re-enter new password"
              />
              {pwStatus && (
                <Text
                  style={[
                    s.statusText,
                    pwStatus.kind === "error"
                      ? s.statusError
                      : s.statusSuccess,
                  ]}
                >
                  {pwStatus.text}
                </Text>
              )}
              <Button
                label="Update password"
                variant="primary"
                loading={pwBusy}
                disabled={pwBusy}
                onPress={handleSubmitPassword}
              />
            </View>
          </View>
        )}

        {/* Section C: Preferences (stubbed) */}
        <NavCard
          title="Preferences"
          subtitle="Cuisines, dietary, equipment, and more"
          onPress={handlePreferences}
        />

        {/* Section D: Account & Subscription (PRD §14.7) */}
        <Pressable
          onPress={handleAccountAndSubscription}
          style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
        >
          <View style={s.cardHeaderRow}>
            <Text style={s.cardTitle}>Account & Subscription</Text>
            <Feather
              name="chevron-right"
              size={18}
              color={KColors.neutral[600]}
            />
          </View>
          <Text style={s.subscriptionState}>
            {formatSubscriptionState(subscription)}
          </Text>
          <Text style={s.subscriptionHint}>
            Upgrade for unlimited Kitchen Wizard plans and AI-powered features
          </Text>
        </Pressable>

        {/* Developer (DEV-ONLY, removed at WS7-CLOSE per WS6 6b-1.6) */}
        {__DEV__ && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Developer</Text>
            <Text style={s.devHint}>
              Throwaway scaffolding. Removed at WS7-CLOSE.
            </Text>
            <Pressable
              onPress={handleInjectDevPlan}
              style={({ pressed }) => [
                s.devButton,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={s.devButtonText}>Inject dev test plan</Text>
            </Pressable>
            <Pressable
              onPress={handleResetDevState}
              style={({ pressed }) => [
                s.devButton,
                s.devButtonDestructive,
                pressed && { opacity: 0.85 },
              ]}
            >
              <Text style={[s.devButtonText, s.devButtonTextDestructive]}>
                Reset all dev state
              </Text>
            </Pressable>
          </View>
        )}

        {/* Section E: Log Out (standalone) */}
        <Pressable
          onPress={handleLogout}
          style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
        >
          <View style={s.cardHeaderRow}>
            <Text style={s.cardTitle}>Log Out</Text>
            <Feather
              name="chevron-right"
              size={18}
              color={KColors.neutral[600]}
            />
          </View>
          <Text style={s.subscriptionHint}>
            Sign out and return to the welcome screen
          </Text>
        </Pressable>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function EditableRow({
  label,
  value,
  displayWhenEmpty,
  isEditing,
  draft,
  onDraftChange,
  onStartEdit,
  onCommit,
  keyboardType,
  autoCapitalize,
  placeholder,
}: {
  label: string;
  value: string;
  displayWhenEmpty?: string;
  isEditing: boolean;
  draft: string;
  onDraftChange: (v: string) => void;
  onStartEdit: () => void;
  onCommit: () => void;
  keyboardType?: "default" | "email-address" | "phone-pad";
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
  placeholder?: string;
}) {
  const display = value || displayWhenEmpty || "";

  return (
    <Pressable
      onPress={isEditing ? undefined : onStartEdit}
      style={({ pressed }) => [
        s.row,
        pressed && !isEditing && { opacity: 0.7 },
      ]}
      hitSlop={6}
    >
      <Text style={s.fieldLabel}>{label}</Text>
      {isEditing ? (
        <TextInput
          value={draft}
          onChangeText={onDraftChange}
          onSubmitEditing={onCommit}
          onBlur={onCommit}
          autoFocus
          returnKeyType="done"
          blurOnSubmit
          keyboardType={keyboardType ?? "default"}
          autoCapitalize={autoCapitalize ?? "sentences"}
          placeholder={placeholder}
          placeholderTextColor={KColors.neutral[600]}
          style={s.editInput}
        />
      ) : (
        <View style={s.fieldRight}>
          <Text
            style={[
              s.fieldValue,
              !value && displayWhenEmpty && s.fieldValueMuted,
            ]}
            numberOfLines={1}
          >
            {display}
          </Text>
          <Feather name="edit-2" size={14} color={KColors.neutral[600]} />
        </View>
      )}
    </Pressable>
  );
}

function NavCard({
  title,
  subtitle,
  onPress,
}: {
  title: string;
  subtitle: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [s.navCard, pressed && { opacity: 0.85 }]}
    >
      <View style={{ flex: 1 }}>
        <Text style={s.navCardTitle}>{title}</Text>
        <Text style={s.navCardSubtitle}>{subtitle}</Text>
      </View>
      <Feather
        name="chevron-right"
        size={18}
        color={KColors.neutral[600]}
      />
    </Pressable>
  );
}

function PasswordField({
  label,
  value,
  onChangeText,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
}) {
  return (
    <View style={s.pwField}>
      <Text style={s.pwLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={KColors.neutral[600]}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={s.pwInput}
      />
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  userCard: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: KColors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: KColors.neutral[0],
    fontSize: 28,
    fontWeight: "700",
    fontFamily: "Inter_700Bold",
  },
  userName: {
    fontSize: KType.size.xl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    marginTop: KSpacing.xs,
  },
  userEmail: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  cardTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
    marginBottom: KSpacing.sm,
  },
  fieldList: {
    gap: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.md,
    paddingVertical: KSpacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: KColors.neutral[200],
    minHeight: 40,
  },
  fieldLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  fieldRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    flexShrink: 1,
  },
  fieldValue: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    textAlign: "right",
    maxWidth: 220,
  },
  fieldValueMuted: {
    color: KColors.neutral[600],
    fontStyle: "italic",
  },
  editInput: {
    flex: 1,
    minWidth: 0,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    textAlign: "right",
    paddingVertical: 4,
    paddingHorizontal: KSpacing.sm,
    borderWidth: 1,
    borderColor: KColors.sage[600],
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[50],
    marginLeft: KSpacing.sm,
  },
  changePasswordValue: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  statusText: {
    fontSize: KType.size.sm,
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
    marginTop: KSpacing.sm,
  },
  statusSuccess: {
    color: KColors.sage[700],
  },
  statusError: {
    color: KColors.terracotta[700],
  },
  pwForm: {
    gap: KSpacing.md,
  },
  pwField: {
    gap: KSpacing.xs,
  },
  pwLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  pwInput: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  navCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
  },
  navCardTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[800],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  navCardSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  subscriptionState: {
    fontSize: KType.size.lg,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: 2,
  },
  subscriptionHint: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: KSpacing.xs,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: KSpacing.sm,
  },
  devHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginBottom: KSpacing.sm,
    fontStyle: "italic",
  },
  devButton: {
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    borderWidth: 1,
    borderColor: KColors.sage[600],
    borderRadius: KRadius.sm,
    backgroundColor: KColors.sage[50],
    marginTop: KSpacing.sm,
    alignItems: "center",
  },
  devButtonDestructive: {
    borderColor: KColors.terracotta[600],
    backgroundColor: KColors.terracotta[50],
  },
  devButtonText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  devButtonTextDestructive: {
    color: KColors.terracotta[700],
  },
});
