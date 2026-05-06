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
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import { getCurrentSubscription, getCurrentUserInfo } from "@/lib/stubs";
import type { SubscriptionInfo, UserAccountInfo } from "@/lib/types";

type EditableField = "name" | "email" | "phone";

const isValidEmail = (s: string): boolean =>
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * Initials for the avatar circle. Handles edge cases:
 *   "Hans Tiefenthaler" → "HT"
 *   "Madonna"           → "M"
 *   "Mary Anne Smith"   → "MS" (first + last, skips middle)
 *   ""                  → "?" (fallback, shouldn't happen since name is required)
 */
function formatSubscriptionState(sub: SubscriptionInfo): string {
  switch (sub.tier) {
    case "trial":
      return sub.trialDaysRemaining != null
        ? `Trial · ${sub.trialDaysRemaining} days remaining`
        : "Trial";
    case "active":
      return sub.nextRenewalDate
        ? `Active · renews ${sub.nextRenewalDate}`
        : "Active";
    case "past_due":
      return "Past due — please update billing";
    case "canceled":
      return "Canceled";
    case "none":
    default:
      return "No active subscription";
  }
}

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
  const { updateUserName, updateUserEmail, updateUserPhone } = useApp();
  const auth = useAuth();

  const [userInfo, setUserInfo] = useState<UserAccountInfo>(() =>
    getCurrentUserInfo(),
  );
  const [subscription] = useState<SubscriptionInfo>(() =>
    getCurrentSubscription(),
  );
  const [editingField, setEditingField] = useState<EditableField | null>(null);
  const [draftValue, setDraftValue] = useState("");

  const handleStartEdit = (field: EditableField) => {
    setEditingField(field);
    setDraftValue(userInfo[field] ?? "");
  };

  const handleCancelEdit = () => {
    setEditingField(null);
    setDraftValue("");
  };

  const handleCommitEdit = () => {
    if (!editingField) return;
    Keyboard.dismiss();
    const trimmed = draftValue.trim();

    if (editingField === "name") {
      // Required — empty value reverts silently
      if (!trimmed) {
        handleCancelEdit();
        return;
      }
      if (trimmed !== userInfo.name) {
        setUserInfo((prev) => ({ ...prev, name: trimmed }));
        void updateUserName(trimmed);
      }
    } else if (editingField === "email") {
      // Required + valid email; otherwise revert
      if (!trimmed || !isValidEmail(trimmed)) {
        handleCancelEdit();
        return;
      }
      if (trimmed === userInfo.email) {
        handleCancelEdit();
        return;
      }
      // PRD §14.9.1 — email change goes through verification (WS6).
      // Don't update local state; show confirmation alert. Log via
      // stub so WS6 can hook into it.
      void updateUserEmail(trimmed);
      Alert.alert(
        "Coming in WS6 — email verification",
        "We'll send a verification link to your new email address before updating it.",
      );
    } else if (editingField === "phone") {
      // Phone optional — empty allowed (clears the value)
      const next = trimmed || undefined;
      if (next !== userInfo.phone) {
        setUserInfo((prev) => ({ ...prev, phone: next }));
        void updateUserPhone(trimmed);
      }
    }

    setEditingField(null);
    setDraftValue("");
  };

  const handleChangePassword = () => {
    Alert.alert(
      "Coming in WS7 — password change",
      "Password change requires the API client. This will be wired in WS7.",
    );
  };

  const handlePreferences = () => {
    router.push("/preferences");
  };

  const handleManageSubscription = () => {
    Alert.alert(
      "Coming in WS6 — Stripe integration",
      "Subscription management requires the Stripe Customer Portal. This will be wired in WS6.",
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

  const handleDeactivate = () => {
    router.push("/deactivate-account");
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
            <Text style={s.avatarText}>{initialsFor(userInfo.name)}</Text>
          </View>
          <Text style={s.userName}>{userInfo.name}</Text>
          <Text style={s.userEmail}>{userInfo.email}</Text>
        </View>

        {/* Section B: Account info */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Account info</Text>
          <View style={s.fieldList}>
            <EditableRow
              label="Name"
              value={userInfo.name}
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
              value={userInfo.email}
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
              value={userInfo.phone ?? ""}
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
              onPress={handleChangePassword}
              style={({ pressed }) => [s.row, pressed && { opacity: 0.7 }]}
              hitSlop={6}
            >
              <Text style={s.fieldLabel}>Password</Text>
              <View style={s.fieldRight}>
                <Text style={s.changePasswordValue}>Change password</Text>
                <Feather
                  name="chevron-right"
                  size={16}
                  color={KColors.neutral[600]}
                />
              </View>
            </Pressable>
          </View>
        </View>

        {/* Section C: Preferences (stubbed) */}
        <NavCard
          title="Preferences"
          subtitle="Cuisines, dietary, equipment, and more"
          onPress={handlePreferences}
        />

        {/* Section D: Subscription (PRD §14.7) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Subscription</Text>
          <Text style={s.subscriptionState}>
            {formatSubscriptionState(subscription)}
          </Text>
          <Text style={s.subscriptionHint}>
            Upgrade for unlimited Kitchen Wizard plans and AI-powered features
          </Text>
          <View style={{ marginTop: KSpacing.md }}>
            <Button
              label="Manage subscription"
              variant="secondary"
              onPress={handleManageSubscription}
            />
          </View>
        </View>

        {/* Section E: Privacy & Data (PRD §14.9.4) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Privacy & Data</Text>
          <Pressable
            onPress={handleLogout}
            style={({ pressed }) => [s.actionRow, pressed && { opacity: 0.7 }]}
          >
            <View style={{ flex: 1 }}>
              <Text style={s.actionLabel}>Log out</Text>
              <Text style={s.actionSubtitle}>
                Sign out and return to the welcome screen
              </Text>
            </View>
            <Feather
              name="chevron-right"
              size={18}
              color={KColors.neutral[600]}
            />
          </Pressable>
          <Pressable
            onPress={handleDeactivate}
            style={({ pressed }) => [
              s.actionRow,
              s.actionRowDestructive,
              pressed && { opacity: 0.7 },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[s.actionLabel, s.actionLabelDestructive]}>
                Deactivate account
              </Text>
              <Text style={s.actionSubtitle}>
                Soft-deletes your account; admins restore within 6 months
              </Text>
            </View>
            <Feather
              name="chevron-right"
              size={18}
              color={KColors.terracotta[600]}
            />
          </Pressable>
        </View>
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

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  userCard: {
    backgroundColor: KColors.neutral[0],
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
    backgroundColor: KColors.neutral[0],
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
  navCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
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
  actionRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    paddingVertical: KSpacing.sm,
    borderTopWidth: 1,
    borderTopColor: KColors.neutral[200],
    marginTop: KSpacing.sm,
  },
  actionRowDestructive: {
    // Same divider treatment; color handled on the label/icon.
  },
  actionLabel: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  actionLabelDestructive: {
    color: KColors.terracotta[600],
  },
  actionSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
});
