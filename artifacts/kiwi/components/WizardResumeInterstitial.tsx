// WS7-5b-mobile Block B — wizard-entry resume interstitial.
//
// Renders BEFORE the wizard inputs (not after, not as a banner) when GET
// /wizard/drafts returned ≥1 unsaved draft. Forces a choice:
//
//   - "Pick up where you left off" → caller fetches the resume detail and
//     navigates to /wizard-plan-details (Block A's screen). Tied to a
//     specific draft id — most-recent for "single", or whichever the user
//     taps in the see-all list for "multi".
//   - "Get new results"            → caller dismisses the interstitial;
//     the wizard inputs render as today.
//
// The decision shape (none / single / multi) is computed by
// decideWizardResumeUi(drafts) in lib/wizard/resumeUi.ts. This component
// only handles render; the consumer (wizard.tsx) owns fetch + navigation
// so the interstitial stays presentational.

import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { Button } from "./Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import type { WizardDraftSummary } from "@/lib/api/wizard";
import {
  decideWizardResumeUi,
  type WizardResumeUiDecision,
} from "@/lib/wizard/resumeUi";

export interface WizardResumeInterstitialProps {
  drafts: WizardDraftSummary[];
  /**
   * Tap on a draft card (most-recent or any in the see-all list). The
   * consumer fetches GET /wizard/drafts/:id and routes to
   * /wizard-plan-details with (draftId, expanded). Receives draft.id.
   */
  onResume: (draftId: string) => void;
  /** "Get new results" tap — dismiss the interstitial; render inputs. */
  onDismiss: () => void;
  /** Pending state from the consumer's resume fetch, if any. */
  resumePendingDraftId?: string | null;
  /** Error message from the consumer's resume fetch, if any. */
  resumeErrorMessage?: string | null;
}

export function WizardResumeInterstitial({
  drafts,
  onResume,
  onDismiss,
  resumePendingDraftId,
  resumeErrorMessage,
}: WizardResumeInterstitialProps) {
  const decision: WizardResumeUiDecision = decideWizardResumeUi(drafts);
  const [seeAllExpanded, setSeeAllExpanded] = useState(false);

  // kind=none is the consumer's signal to render inputs — by contract,
  // this component should not be mounted in that branch. Guard so a
  // future caller bug surfaces as a no-op render rather than a crash.
  if (decision.kind === "none") return null;

  const primary =
    decision.kind === "single" ? decision.draft : decision.primary;
  const others = decision.kind === "multi" ? decision.others : [];

  return (
    <View style={s.root}>
      <ScrollView
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <Text style={s.eyebrow}>Welcome back</Text>
        <Text style={s.title}>Pick up where you left off?</Text>
        <Text style={s.subtitle}>
          Kiwi held onto your last unsaved plan. Resume it or start fresh.
        </Text>

        <DraftCard
          draft={primary}
          highlighted
          pending={resumePendingDraftId === primary.id}
          disabled={!!resumePendingDraftId}
          onPress={() => onResume(primary.id)}
        />

        {decision.kind === "multi" && (
          <>
            <Pressable
              onPress={() => setSeeAllExpanded((v) => !v)}
              hitSlop={6}
              style={({ pressed }) => [
                s.seeAllLink,
                pressed && { opacity: 0.6 },
              ]}
              testID="wizard-resume-see-all"
            >
              <Text style={s.seeAllText}>
                {seeAllExpanded
                  ? "Hide other drafts"
                  : `See ${others.length} more draft${others.length === 1 ? "" : "s"}`}
              </Text>
              <Feather
                name={seeAllExpanded ? "chevron-up" : "chevron-down"}
                size={14}
                color={Colors.sage[700]}
              />
            </Pressable>
            {seeAllExpanded && (
              <View style={s.othersList}>
                {others.map((d) => (
                  <DraftCard
                    key={d.id}
                    draft={d}
                    highlighted={false}
                    pending={resumePendingDraftId === d.id}
                    disabled={!!resumePendingDraftId}
                    onPress={() => onResume(d.id)}
                  />
                ))}
              </View>
            )}
          </>
        )}

        {resumeErrorMessage && (
          <Text style={s.errorText}>{resumeErrorMessage}</Text>
        )}

        <View style={s.footer}>
          <Button
            label="Get new results"
            variant="ghost"
            onPress={onDismiss}
            disabled={!!resumePendingDraftId}
          />
        </View>
      </ScrollView>
    </View>
  );
}

function DraftCard({
  draft,
  highlighted,
  pending,
  disabled,
  onPress,
}: {
  draft: WizardDraftSummary;
  highlighted: boolean;
  pending: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const previewTitles = draft.mealTitles.slice(0, 3);
  const extraCount = Math.max(0, draft.mealTitles.length - previewTitles.length);
  const displayTitle = draft.title || "Untitled plan";

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      style={({ pressed }) => [
        s.card,
        highlighted && s.cardHighlighted,
        pressed && !disabled && { opacity: 0.85 },
        disabled && { opacity: 0.6 },
      ]}
      testID={`wizard-resume-draft-${draft.id}`}
    >
      <View style={s.cardHeader}>
        <Text style={s.cardTitle} numberOfLines={1}>
          {displayTitle}
        </Text>
        {pending ? (
          <ActivityIndicator color={Colors.sage[700]} />
        ) : (
          <Feather
            name="chevron-right"
            size={20}
            color={Colors.sage[700]}
          />
        )}
      </View>
      {previewTitles.length > 0 && (
        <Text style={s.cardPreview} numberOfLines={2}>
          {previewTitles.join(" · ")}
          {extraCount > 0 ? ` · +${extraCount} more` : ""}
        </Text>
      )}
      {highlighted && (
        <Text style={s.cardCta}>Pick up where you left off →</Text>
      )}
    </Pressable>
  );
}

const s = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
  },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[5],
    paddingBottom: Spacing[8],
    gap: Spacing[3],
  },
  eyebrow: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: Typography.face.sans[600],
  },
  title: {
    fontSize: Typography.fontSize.xxl,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.bold,
    fontFamily: Typography.face.serif[600],
  },
  subtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[2],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
    gap: Spacing[1],
  },
  cardHighlighted: {
    borderColor: Colors.sage[600],
    borderWidth: 2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  cardTitle: {
    flex: 1,
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardPreview: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  cardCta: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginTop: Spacing[1],
  },
  seeAllLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: Spacing[1],
  },
  seeAllText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  othersList: {
    gap: Spacing[2],
  },
  errorText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  footer: {
    marginTop: Spacing[4],
    alignItems: "center",
  },
});
