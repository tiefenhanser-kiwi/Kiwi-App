import React, { useRef, useState } from "react";
import {
  Alert,
  Keyboard,
  Linking,
  Platform,
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
import { PasswordField } from "@/components/PasswordField";
import { SubscriptionCardView } from "@/components/SubscriptionCardView";
import { useApp } from "@/contexts/AppContext";
import { useAuth } from "@/contexts/AuthContext";
import { useBilling } from "@/contexts/BillingContext";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { ApiError } from "@/lib/api/errors";
import { subscriptionCardFor } from "@/lib/billing/subscriptionView";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";

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
  } = useApp();
  const auth = useAuth();

  // The auth cache is the source of truth for account fields — the profile
  // mutators field-merge their PATCH result into ['auth','me'], so these
  // re-derive automatically once a save lands.
  const user = auth.user;
  const displayName = user ? `${user.firstName} ${user.lastName}`.trim() : "";
  const displayEmail = user?.email ?? "";
  const displayPhone = user?.phone ?? "";

  const [editingField, setEditingField] = useState<EditableField | null>(null);
  // BUG-236: the synchronously-readable mirror of `editingField`. State alone
  // cannot guard `handleCommitEdit` — see the comment there. Every write to
  // `editingField` must write this too, or a row becomes uneditable after its
  // first commit.
  const editingFieldRef = useRef<EditableField | null>(null);
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
    editingFieldRef.current = field;
    setEditingField(field);
    setDraftValue(fieldDisplay(field));
  };

  const handleCancelEdit = () => {
    editingFieldRef.current = null;
    setEditingField(null);
    setDraftValue("");
  };

  const handleCommitEdit = async () => {
    // BUG-236: EditableRow fires onCommit from BOTH onSubmitEditing and
    // onBlur, and `blurOnSubmit` makes pressing "done" do both — so one tap
    // calls this twice, milliseconds apart. The previous guard read
    // `editingField`, a closure binding captured at render: `setEditingField`
    // queues an update but cannot change that binding, so the second call saw
    // the stale non-null value, passed the guard, and fired a second request
    // concurrently with the first (two `email_change_requested` 5ms apart).
    // Only a ref can be cleared synchronously, so only a ref can swallow the
    // second call. Clear it before `Keyboard.dismiss()`, which itself blurs
    // the input and can re-enter this handler.
    const field = editingFieldRef.current;
    if (!field) return;
    editingFieldRef.current = null;

    Keyboard.dismiss();
    const trimmed = draftValue.trim();
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
      // WS9 BUG-239 §1c — Hans: "I reset my password and nothing happened."
      // The 401 bounce added earlier is REACTIVE: it needs a request to fail
      // against, and this call returns 200, so the app sat on a token it
      // already knew was dead until the user happened to touch something
      // authenticated. BUG-234 bumps the revocation epoch server-side, so
      // success here IS the notification that this token is void — act on
      // what we already know instead of waiting to rediscover it.
      //
      // Routed to sign-in, NOT welcome: welcome renders no error text at all,
      // so the confirmation would be invisible and this would still read as
      // "nothing happened", just one screen further on.
      // WS9 BUG-239 follow-up — NO router call here. Navigating from this
      // handler raced the teardown: replace() ran before AuthProvider had
      // re-rendered, so (auth)/_layout still saw isAuthenticated true and
      // bounced to "/", which sent the still-non-null user back to (tabs) —
      // so the redirect looked like it had never fired. SessionGate owns this
      // now and reacts to user going null, the same value (auth)/_layout
      // guards on, so it cannot arrive too early.
      await auth.endSession(
        "Your password was changed. Please sign in with your new password.",
      );
      return;
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

  const handleLogout = async () => {
    try {
      await auth.logout();
    } catch {
      console.log("[profile] logout fallback");
    }
    router.replace("/(auth)/welcome");
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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
                  color={Colors.neutral[600]}
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
              <PasswordRow
                label="Current password"
                value={currentPw}
                onChangeText={setCurrentPw}
                placeholder="Current password"
                autoComplete="password"
                textContentType="password"
              />
              <PasswordRow
                label="New password"
                value={newPw}
                onChangeText={setNewPw}
                placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
                autoComplete="new-password"
                textContentType="newPassword"
              />
              <PasswordRow
                label="Confirm new password"
                value={confirmPw}
                onChangeText={setConfirmPw}
                placeholder="Re-enter new password"
                autoComplete="new-password"
                textContentType="newPassword"
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

        {/* Section C2: Subscription (§2.8). Row 9 (1.1) · Stripe S2 Part E —
            THE ONE SURFACE THAT SURVIVES THE `enforced` BLACKOUT, because a line
            reading "Free trial · ends Oct 11" promises nothing and answers the one
            question a user in a trial actually has.

            D-WS9-258 removed the trial state and "Upgrade for unlimited Kitchen
            Wizard plans and AI-powered features" from the card below, on the
            grounds that "nothing in the first binary takes money, so nothing in it
            promises a purchase", and said "Stripe lane re-adds both lines". This
            is that lane, and it re-adds them HERE rather than back onto the
            Account card — the Account card's own subtitle is about details,
            password and deletion, and a subscription state squeezed into it was
            what made the old card read as two things at once.

            Renders nothing at all when Stripe is unconfigured AND enforcement is
            off; settingsRowFor decides, not this JSX. */}
        <SubscriptionCard />

        {/* Section D: Account (PRD §14.7). The destination is unchanged. */}
        <Pressable
          onPress={handleAccountAndSubscription}
          style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}
        >
          <View style={s.cardHeaderRow}>
            <Text style={s.cardTitle}>Account</Text>
            <Feather
              name="chevron-right"
              size={18}
              color={Colors.neutral[600]}
            />
          </View>
          <Text style={s.subscriptionHint}>
            Your details, password, and deleting your account
          </Text>
        </Pressable>

        {/* Section D2: Legal. Apple and Google both expect these reachable
            from inside the app, not only from the pre-signup welcome screen. */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Legal</Text>
          <LegalRow label="Terms of Service" onPress={() => openLegal(TERMS_URL)} />
          <LegalRow label="Privacy Policy" onPress={() => openLegal(PRIVACY_URL)} />
        </View>

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
              color={Colors.neutral[600]}
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
          placeholderTextColor={Palette.text.placeholder}
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
          <Feather name="edit-2" size={14} color={Colors.neutral[600]} />
        </View>
      )}
    </Pressable>
  );
}

/**
 * Row 9 (1.1) · Stripe S2 Part E — Settings → Subscription (§2.8), and since
 * Resub C2 the "Kiwi Premium" row and the manage action by source.
 *
 * A thin wrapper. What the card shows is `subscriptionCardFor`'s answer
 * (lib/billing/subscriptionView.ts), tested over every source × platform without
 * a React tree; components/SubscriptionCardView.tsx draws it.
 */
function SubscriptionCard() {
  const { subscription, openSheet, openPortal, openManagement, linkError } = useBilling();
  const card = subscriptionCardFor(Platform.OS, subscription, new Date());
  if (card === null) return null;

  return (
    <SubscriptionCardView
      card={card}
      // The row's own state, explicitly: the trialing account the App Review
      // team uses must reach the sheet even while `enforced` is off.
      onOpenPremium={() => {
        if (card.premium) openSheet(card.premium.sheet);
      }}
      onSubscribe={() => openSheet()}
      onManage={(action) => {
        if (action.kind === "store_link") openManagement(action.url);
        else if (action.kind === "stripe_portal") void openPortal();
      }}
      linkError={linkError}
    />
  );
}

// D-WS9-099 / store prep — the legal pages open in the browser. Rejection is
// handled the way grocery-list/[id].tsx handles the Instacart link's: a device
// with no browser is a warn, not a crash.
function openLegal(url: string): void {
  Linking.openURL(url).catch((err: unknown) => {
    console.warn("[profile] legal openURL rejected", err);
  });
}

function LegalRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [s.legalRow, pressed && { opacity: 0.85 }]}
    >
      <Text style={s.legalRowLabel}>{label}</Text>
      <Feather name="external-link" size={16} color={Colors.neutral[600]} />
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
        color={Colors.neutral[600]}
      />
    </Pressable>
  );
}

/**
 * BUG-237: both hints are REQUIRED props, not optional with a default, so a
 * new secure field cannot be added here without stating what it holds.
 *
 * Without them react-native-web emits `autocomplete="on"` on an
 * `<input type="password">` (its TextInput defaults the attribute — it is not
 * omitted), which affirmatively invites the browser's password manager into
 * all three fields at once. `textContentType` is the iOS spelling of the same
 * intent. sign-in.tsx and sign-up.tsx already hint every credential field they
 * own; these three were the only unhinted ones left in the client.
 */
// The labelled row wrapper. Renamed from PasswordField when the store-prep
// lane added the shared components/PasswordField (the input itself, with the
// show/hide toggle) that this row now renders.
function PasswordRow({
  label,
  value,
  onChangeText,
  placeholder,
  autoComplete,
  textContentType,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  placeholder: string;
  autoComplete: "password" | "new-password";
  textContentType: "password" | "newPassword";
}) {
  return (
    <View style={s.pwField}>
      <Text style={s.pwLabel}>{label}</Text>
      <PasswordField
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Palette.text.placeholder}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete={autoComplete}
        textContentType={textContentType}
        style={s.pwInput}
      />
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  userCard: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  avatar: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Colors.sage[700],
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    color: Colors.neutral[0],
    fontSize: 28,
    fontWeight: "700",
    fontFamily: Typography.face.sans[700],
  },
  userName: {
    fontSize: Typography.fontSize.xl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    marginTop: Spacing[1],
  },
  userEmail: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  cardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
    marginBottom: Spacing[2],
  },
  fieldList: {
    gap: 0,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[3],
    paddingVertical: Spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[200],
    minHeight: 40,
  },
  fieldLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  fieldRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    flexShrink: 1,
  },
  fieldValue: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textAlign: "right",
    maxWidth: 220,
  },
  fieldValueMuted: {
    color: Colors.neutral[700],
    fontStyle: "italic",
  },
  editInput: {
    flex: 1,
    minWidth: 0,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    textAlign: "right",
    paddingVertical: 4,
    paddingHorizontal: Spacing[2],
    borderWidth: 1,
    borderColor: Colors.sage[600],
    borderRadius: Radius.sm,
    backgroundColor: Colors.sage[50],
    marginLeft: Spacing[2],
  },
  changePasswordValue: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  statusText: {
    fontSize: Typography.fontSize.sm,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
    marginTop: Spacing[2],
  },
  statusSuccess: {
    color: Colors.sage[700],
  },
  statusError: {
    color: Colors.terracotta[700],
  },
  pwForm: {
    gap: Spacing[3],
  },
  pwField: {
    gap: Spacing[1],
  },
  pwLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  pwInput: {
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
  navCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[3],
  },
  legalRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    // 44 pt is the Apple minimum touch target; these are the smallest rows on
    // the screen and the only ones that leave the app.
    minHeight: 44,
  },
  legalRowLabel: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[400],
  },
  navCardTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[700],
  },
  navCardSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  subscriptionState: {
    fontSize: Typography.fontSize.lg,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginTop: 2,
  },
  subscriptionHint: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
  },
});
