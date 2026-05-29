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
import { KColors, KPalette, KRadius, KSpacing, KType } from "@/constants/tokens";
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
                color={KColors.sage[700]}
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
          <ActivityIndicator color={KColors.sage[700]} />
        ) : (
          <Feather
            name="chevron-right"
            size={20}
            color={KColors.sage[700]}
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
    backgroundColor: KColors.neutral[100],
  },
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.xl,
    paddingBottom: KSpacing.xxxl,
    gap: KSpacing.md,
  },
  eyebrow: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
  },
  title: {
    fontSize: KType.size.xxl,
    color: KColors.neutral[900],
    fontWeight: KType.weight.bold,
    fontFamily: "Inter_700Bold",
  },
  subtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginBottom: KSpacing.sm,
  },
  card: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
    gap: KSpacing.xs,
  },
  cardHighlighted: {
    borderColor: KColors.sage[600],
    borderWidth: 2,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  cardTitle: {
    flex: 1,
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardPreview: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  cardCta: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: KSpacing.xs,
  },
  seeAllLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    alignSelf: "flex-start",
    paddingVertical: KSpacing.xs,
  },
  seeAllText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  othersList: {
    gap: KSpacing.sm,
  },
  errorText: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[600],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  footer: {
    marginTop: KSpacing.lg,
    alignItems: "center",
  },
});
