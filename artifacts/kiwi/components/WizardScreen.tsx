// WS9 Redesign Arc Block 2a Part C (D-WS9-237) — the MERGED Kitchen Wizard.
//
// app/wizard.tsx and app/tellkiwi.tsx were near-clones (Phase 0): the same
// plan-length chips, household stepper, "Adjust saved prefs" disclosure and
// footer, differing in a text box at the top and which generate call submit
// made. They are ONE screen now, this component, mounted by both routes with a
// `mode` — the old route names stay live because Home, the exhausted card on
// the Pick screen and the "See Previous Options" link address them.
//
// Top to bottom (the September 16 mockups):
//   1. header "Kitchen Wizard" — "Set preferences" / "Just say what you want";
//   2. the CTA "Build my plan", terracotta, at the TOP (it lived at the bottom
//      of both old screens) — DISABLED until a path is chosen, with a hint
//      line that says what happens next. Block 2c Part B: ANCHORED — it sits
//      outside the scroll view, pinned under the header at any scroll;
//   3. text mode only — "Tell Kiwi · What do you want to eat?" (the existing
//      500-cap box + counter);
//   4. "How to build it · What should Kiwi suggest?" — two option rows, NOTHING
//      selected by default: "Meals to choose from" (→ POST /wizard/shelf → the
//      Pick screen) and "Complete plans" (→ today's build-plans / build-from-
//      text → today's results screen, untouched);
//   5. "The mix · What goes in?" — the two dials (<MixDials>, shared with the
//      preferences screen), hydrated from stored prefs, per-run edits NEVER
//      written back (D-WS7-035). Zero playlist meals → the nudge card;
//   6. today's wizard exactly: plan length, household, the disclosure, Notes
//      (prefs mode), Cancel.
//
// ⚠️ NO RADIO IDIOM EXISTED to reuse for (4) — both old screens are chip-only.
// PathOptionRow below is the smallest honest one: a pressable row with a
// select circle, title and sub-line, the same select circle the Pick card uses.
//
// 🔴 HOOKS SIT ABOVE THE EARLY RETURN. This file is under components/ so the
// test glob reaches it; the two app/** routes are one-line mounts.

import React, { useEffect, useRef, useState } from "react";
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
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { LoadingShim } from "@/components/LoadingShim";
import { Stepper } from "@/components/Stepper";
import { WizardPreviousOptionsLink } from "@/components/WizardPreviousOptionsLink";
import { DietarySection } from "@/components/preference-pickers/DietarySection";
import { CuisinePicker } from "@/components/preference-pickers/CuisinePicker";
import { MixDials } from "@/components/preference-pickers/MixDials";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  COOK_TIME_CAP_OPTIONS,
  COOK_TIME_COVERAGE_OPTIONS,
  PLAN_DURATION_PRESETS,
  SAUCE_PREFERENCE_OPTIONS,
  type DialLevel,
} from "@/lib/domain";
import type { TellKiwiInput, WizardPreferencesInput } from "@/lib/types";
import { getPreferences, type UserPreferences } from "@/lib/api/me";
import { getPlaylist, PLAYLIST_QUERY_KEY } from "@/lib/api/playlist";
import { buildWizardShelf, type WizardShelfResponse } from "@/lib/api/wizard";
import { useBuildFromText } from "@/hooks/useBuildFromText";
import {
  buildShelfRequest,
  buildTellKiwiPayload,
  buildWizardPayload,
  HIDDEN_DEFAULT_DIFFICULTY,
  wizardFormFromPreferences,
  type WizardShelfRequest,
} from "@/lib/wizard/perRunPayload";
import { pickMealsRouteParams } from "@/lib/wizard/pickMeals";
// Row 13 "Test Kitchen" · Block 2 Part C (R3) — the guest form.
import {
  buildGuestShelfRequest,
  buildGuestWizardPayload,
  type GuestWizardForm,
} from "@/lib/wizard/guestPayload";
import { buildGuestPlans, buildGuestShelf, trackGuestEvent } from "@/lib/api/guest";
import { useGuestOptional } from "@/contexts/GuestContext";
import { useGuestDoor } from "@/hooks/useGuestDoor";
import { GuestDoorSheet } from "@/components/GuestDoorSheet";

export type WizardMode = "prefs" | "text";
/** Which of the two "How to build it" rows is chosen. `null` = nothing yet. */
export type WizardPath = "pick" | "plans";

type Difficulty = WizardPreferencesInput["difficulty"];
type WeeklyPacing = WizardPreferencesInput["weeklyPacing"];
type SaucePreference = NonNullable<WizardPreferencesInput["saucePreference"]>;
type CookTimeCoverage = NonNullable<WizardPreferencesInput["maxCookTimeCoverage"]>;

const PACING_OPTIONS: { key: WeeklyPacing; label: string }[] = [
  { key: "mostly_easy", label: "Mostly easy" },
  { key: "mixed", label: "Mixed (quick + nicer)" },
  { key: "one_fancy_night", label: "One fancy night" },
  { key: "minimal_effort", label: "Minimal effort" },
];

const HOUSEHOLD_MIN = 1;
const HOUSEHOLD_MAX = 30;
const DESCRIPTION_MAX = 500;
const DESCRIPTION_MIN = 5;

const PLACEHOLDER =
  "Describe what you'd like for the week. Examples: 'Comforting weeknight meals for a family of 4', 'Italian and Mediterranean only', 'burgers, mac and cheese, grilled chicken, soup, and pasta', or 'Easy meals my picky kids will eat plus one fancy night'";

// ── Copy (verbatim from the locked mockups; the "Complete plans" hint is
// proposed — it is not in the mockup) ──────────────────────────────────────
export const CTA_LABEL = "Build my plan";
export const CTA_HINT_NO_PATH = "Choose what Kiwi should suggest first";
export const CTA_HINT_PICK = "Next: Kiwi suggests about 15 meals — you choose";
export const CTA_HINT_PLANS = "Next: Kiwi builds 3 plans — you pick one";
export const TEXT_SECTION_TITLE = "What do you want to eat?";
export const TEXT_SECTION_SUBLINE =
  "Name the exact meals you want, describe the kind of week, or both — Kiwi keeps what you name and fills the rest to your preferences.";
export const PATH_PICK_TITLE = "Meals to choose from";
export const PATH_PICK_SUB_PREFS =
  "About 15 that fit your preferences. Pick the ones you want — that's your plan.";
export const PATH_PICK_SUB_TEXT =
  "About 15 that fit what you wrote and your preferences. Pick the ones you want — that's your plan.";
export const PATH_PLANS_TITLE = "Complete plans";
export const PATH_PLANS_SUB_PREFS = "3 plans built from your preferences. Pick one.";
export const PATH_PLANS_SUB_TEXT =
  "3 plans built from what you wrote and your preferences. Pick one.";
export const MIX_INTRO = "Leave both unset and Kiwi plans straight from your preferences.";

// ── Row 13 Block 2 (R3) — the guest form's copy ───────────────────────────
// The disclosure is EXPANDED by default and RETITLED for a guest: it holds the
// allergy question, and it is the ONLY place a guest is ever asked. Collapsed
// behind "Adjust saved prefs for this plan · Optional" a visitor could generate
// a week without ever seeing it — and there are no saved prefs to adjust.
export const GUEST_DIET_TITLE = "Allergies, cuisines and more";
export const GUEST_DIET_SUBTITLE = "Tell Kiwi what to avoid and what you like";
// Resub C4 — the guest's plans-path hint. Its pick-path sibling is
// CTA_HINT_PICK itself: the copy is identical, so there is no second constant.
export const GUEST_CTA_HINT = "Next: Kiwi builds 3 plans — you pick one";
export const GUEST_SPENT_TITLE = "You've built your Test Kitchen plan";
export const GUEST_SPENT_BODY =
  "The Test Kitchen builds one plan per visit. Create a free account for unlimited plans — and to keep this one.";

interface WizardFormState {
  /** Text mode's box. Empty and unrendered in prefs mode. */
  description: string;
  planDurationDays: number;
  householdSize: number;
  cuisines: string[];
  eatingStyles: string[];
  allergies: string[];
  dietaryNotes: string;
  /** WS9 D-WS9-206 — free-text allergy terms. PER-RUN, like the rest here. */
  otherAllergies: string[];
  /** Hidden from UI per WS5-5N-bis-fix-wizard-fix; kept on state so the
   *  payload still carries the field (required on the server schema). */
  difficulty: Difficulty;
  weeklyPacing: WeeklyPacing;
  additionalNotes: string;
  // Cookbook Phase B Block 4 (D-WS7-035) — the generation-shaping prefs,
  // hydrated from stored UserPreferences and editable for THIS plan only.
  discoveryLevel: DialLevel;
  playlistLevel: DialLevel;
  saucePreference: SaucePreference;
  maxCookTimeMinutes: number | null;
  maxCookTimeCoverage: CookTimeCoverage;
  /** "Adjust saved prefs for this plan" disclosure open state. */
  adjustExpanded: boolean;
}


// Fallback state before stored preferences hydrate (or if the prefs read
// fails — hydration is an assist, not a blocker). Once prefs load, the form is
// re-seeded from the stored values by hydrateForm() below.
const INITIAL_FORM: WizardFormState = {
  description: "",
  planDurationDays: 5,
  householdSize: 4,
  cuisines: [],
  eatingStyles: [],
  allergies: [],
  dietaryNotes: "",
  otherAllergies: [],
  difficulty: HIDDEN_DEFAULT_DIFFICULTY,
  weeklyPacing: "mostly_easy",
  additionalNotes: "",
  discoveryLevel: "none",
  playlistLevel: "none",
  saucePreference: "balanced",
  maxCookTimeMinutes: null,
  maxCookTimeCoverage: "most",
  adjustExpanded: false,
};

// Cookbook Phase B Block 4 — seed the form from the user's stored prefs on
// open (D-WS7-035 hydrate step). The description box and the disclosure's open
// state are the user's, never seeded. Edits mutate local state only; nothing
// here writes back to /me/preferences.
function hydrateForm(
  prefs: UserPreferences,
  prev: WizardFormState,
): WizardFormState {
  // Block 2b — the stored-prefs seed is shared with the Playlist tab's "Plan a
  // week from these" (lib/wizard/perRunPayload.ts). The description, the
  // disclosure state and additionalNotes are the user's, never seeded.
  const { additionalNotes: _seedNotes, ...seeded } = wizardFormFromPreferences(prefs);
  return {
    ...prev,
    ...seeded,
    otherAllergies: prefs.otherAllergies,
  };
}

export interface WizardScreenProps {
  mode: WizardMode;
  /** Text mode — the Home card's typed text, seeding the box (WS9 3a seam). */
  initialText?: string;
  /** Open the "Adjust saved prefs" disclosure on mount (the Pick screen's
   *  exhausted card → "Refine preferences"). */
  adjustOpen?: boolean;
  /** Focus the text box on mount (the exhausted card → "Tell Kiwi"). */
  focusText?: boolean;
  /** Block 2b — changes when the Pick screen dismisses BACK to this mounted
   *  screen with adjust / focus, so the effects below re-fire on the same "1". */
  paramNonce?: string;
  // ── Row 13 "Test Kitchen" · Block 2 Part C (R3) ───────────────────────────
  /**
   * The Test Kitchen's guest form. Hans: "it's the wizard flow… users can skip
   * most of it if they want" — so this is a SET OF GATES on the existing screen,
   * not a second screen:
   *   · mode is locked to prefs: /wizard/build-from-text is requireAuth and the
   *     AI-invention surface Hans ruled off for guests. Resub C4 — the PATH is
   *     no longer locked: the chooser renders with nothing selected, as for a
   *     member (Hans, October 7: "it should be the same as the in-app/with-
   *     account flow"). "Meals to choose from" posts the guest shelf (G1) and
   *     goes to /test-kitchen/pick; "Complete plans" is the generate below;
   *   · sauce and "The mix" are HIDDEN and omitted from the request entirely
   *     (lib/wizard/guestPayload.ts — the claim saves what the request carried);
   *   · the dietary disclosure is EXPANDED and retitled;
   *   · every member-only read on this screen is disabled: GET /me/preferences,
   *     GET /playlist and GET /wizard/last-batch are all requireAuth, and a
   *     guest token there is a 401 (measured), which is the cascade.
   */
  guest?: boolean;
  /** The one generation is used (GET /guest/session generationCount > 0). The
   *  server's 409 guest_generation_used is the authority; this is what lets the
   *  screen show a door instead of spending a call to be refused. */
  guestGenerationSpent?: boolean;
  /** The entry s "pick up where you left off" link, rendered above the form. */
  guestResumeBanner?: React.ReactNode;
}

export function WizardScreen({
  mode,
  initialText = "",
  adjustOpen = false,
  focusText = false,
  paramNonce,
  guest = false,
  guestGenerationSpent = false,
  guestResumeBanner = null,
}: WizardScreenProps) {
  const router = useRouter();
  const queryClient = useQueryClient();
  // Row 13 Block 2 — a guest is never in text mode (build-from-text is
  // member-only AND the AI-invention surface), whatever the route asked for.
  const isText = mode === "text" && !guest;

  const [form, setForm] = useState<WizardFormState>(() => ({
    ...INITIAL_FORM,
    description: isText ? initialText : "",
    // R3 — EXPANDED by default for a guest. It holds the allergy question and
    // it is the only place a guest is ever asked.
    adjustExpanded: guest || adjustOpen,
  }));
  // Nothing selected by default — for a guest too since Resub C4 (it was preset
  // to "plans" with the chooser hidden while /wizard/shelf was member-only).
  const [path, setPath] = useState<WizardPath | null>(null);
  const textInputRef = useRef<TextInput>(null);

  // Cookbook Phase B Block 4 — stored prefs hydrate the controls (D-WS7-035).
  // Read-only here: the wizard never PATCHes /me/preferences.
  //
  // 🔴 DISABLED FOR A GUEST. GET /me/preferences is requireAuth. A guest token
  // there is a measured 401, and an authenticated 401 is the session-expired
  // cascade — so leaving this enabled would have evicted every Test Kitchen
  // visitor to /(auth)/sign-in on mount. `enabled: false` also keeps `hydrated`
  // false forever for a guest, which is exactly why the guest payload has its
  // own builder (lib/wizard/guestPayload.ts): the member builder reads
  // `hydrated` and would drop the visitor's allergies.
  const prefsQuery = useQuery<UserPreferences>({
    queryKey: ["me", "preferences"],
    queryFn: getPreferences,
    enabled: !guest,
  });
  // Block 2a — the Playlist dial's gate. Only `count` is read; a failed read
  // leaves it undefined and the chips render (never a blocker). Disabled for a
  // guest for the same reason as above — and moot, since "The mix" is hidden.
  const playlistQuery = useQuery({
    queryKey: PLAYLIST_QUERY_KEY,
    queryFn: getPlaylist,
    enabled: !guest,
  });

  // Once stored prefs arrive we seed the form exactly once. `hydrated` also
  // gates whether the per-run overrides are sent on submit: if the prefs read
  // failed we must NOT send the wizard-default values (they would clobber the
  // user's real stored prefs via the server resolver) — omit them so the
  // server falls back to stored (BUG-201 / lib/wizard/perRunPayload.ts).
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    if (prefsQuery.data && !hydrated) {
      setForm((prev) => hydrateForm(prefsQuery.data!, prev));
      setHydrated(true);
    }
  }, [prefsQuery.data, hydrated]);

  // Text mode, "Tell Kiwi" from the exhausted card — put the caret in the box
  // once the loader has lifted. The ref is null while the loader renders.
  // Block 2b — keyed on paramNonce too: the Pick screen dismisses BACK to this
  // mounted screen, so the param arrives as an update, not at mount.
  useEffect(() => {
    if (!focusText || prefsQuery.isLoading) return;
    const t = setTimeout(() => textInputRef.current?.focus(), 50);
    return () => clearTimeout(t);
  }, [focusText, prefsQuery.isLoading, paramNonce]);

  // "Refine preferences" from the exhausted card → the disclosure opens on the
  // wizard already on the stack (initial state covers the mount case).
  useEffect(() => {
    if (adjustOpen) setForm((prev) => ({ ...prev, adjustExpanded: true }));
  }, [adjustOpen, paramNonce]);

  // ── Row 13 Block 2 Part C — the guest's ONE generation ──────────────────
  // Buffered POST /wizard/build-plans with the guest principal. Not the SSE
  // stream: see lib/api/guest.ts buildGuestPlans. `useGuest()` is called
  // unconditionally (hooks sit above every branch) and simply goes unread on the
  // member path — GuestProvider wraps the whole navigator, so it is always there.
  // useGuestOptional, not useGuest: this component is shared with the member app
  // and its own component tests render it bare, with no providers at all.
  const guestCtx = useGuestOptional();
  const guestMutation = useMutation({ mutationFn: buildGuestPlans });
  // Part D — the one shared door. Mounted unconditionally (hooks above the early
  // returns); it renders nothing until an action hits a door, and for a member
  // guestGuard always answers "allow", so no action ever does.
  const guestDoor = useGuestDoor();

  // Path B, text mode — today's build-from-text (buffered), untouched.
  const textMutation = useBuildFromText();
  // Path A — the shelf. Fast, DB-only unless text is sent.
  const shelfMutation = useMutation<
    WizardShelfResponse,
    Error,
    WizardShelfRequest
  >({ mutationFn: buildWizardShelf });
  // Resub C4 — the guest's path A: the same shelf, under the guest principal.
  const guestShelfMutation = useMutation<
    WizardShelfResponse,
    Error,
    WizardShelfRequest
  >({ mutationFn: buildGuestShelf });

  const update =<K extends keyof WizardFormState>(
    key: K,
    value: WizardFormState[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const busy =
    textMutation.isPending ||
    shelfMutation.isPending ||
    guestMutation.isPending ||
    guestShelfMutation.isPending;

  const textTooShort = () =>
    isText && form.description.trim().length < DESCRIPTION_MIN;
  const alertTextTooShort = () =>
    Alert.alert(
      "Tell Kiwi a bit more",
      "Describe what you'd like — at least a few words about meals, cuisines, or the kind of week you want.",
    );

  // ── Path B: "Complete plans" → the plan-options screen (D-WS9-191 Block 2) ─
  const submitPlans = () => {
    if (!isText) {
      // WS6 6a-3 — payload travels to the chooser as a JSON-encoded route
      // param; that screen calls POST /api/wizard/build-plans on mount.
      const payload = buildWizardPayload(form, hydrated);
      router.push({
        pathname: "/plan-options",
        params: { input: JSON.stringify(payload) },
      });
      return;
    }
    if (textTooShort()) return alertTextTooShort();
    const payload: TellKiwiInput = buildTellKiwiPayload(form, hydrated);
    textMutation.mutate(payload, {
      onSuccess: (result) => {
        // Scenario F (unclear) — keep the user here and show the clarifying
        // question inline (rendered under the CTA below).
        if (
          result.parsedIntent.scenario === "unclear" ||
          result.candidates.length === 0
        ) {
          return;
        }
        // Block 4b-3 (D-WS9-072) — this generation overwrote the server
        // last-batch row; the "See Previous Options" link must reflect it.
        queryClient.invalidateQueries({ queryKey: ["wizard", "lastBatch"] });
        router.push({
          pathname: "/plan-options",
          params: {
            source: "tellkiwi",
            tellKiwiResult: JSON.stringify(result),
            tellKiwiInput: JSON.stringify(payload),
          },
        });
      },
    });
  };

  // ── Path A: "Meals to choose from" → the shelf → the Pick screen ────────
  const submitPick = () => {
    if (textTooShort()) return alertTextTooShort();
    const body = buildShelfRequest(form, hydrated, {
      text: isText ? form.description : undefined,
    });
    shelfMutation.mutate(body, {
      onSuccess: (shelf) => {
        router.push({
          pathname: "/pick-meals",
          params: pickMealsRouteParams({
            shelf,
            request: body,
            mode,
            planDurationDays: form.planDurationDays,
            householdSize: form.householdSize,
            // The user's cap for THIS run — the per-run override when set,
            // else the stored one it hydrated from. null = no cap.
            capMinutes: form.maxCookTimeMinutes,
          }),
        });
      },
    });
  };

  // ── Row 13 Block 2 Part C — the guest's submit ───────────────────────────
  // The guest payload is built HERE and nowhere else: buildGuestWizardPayload
  // always carries allergies, eating styles and the cap, and never carries sauce
  // or either dial. The cards go into GuestContext (so the options screen has
  // them even if the server's best-effort persist missed) alongside the form,
  // because the expand's candidateContext is built from these same answers.
  const guestForm = (): GuestWizardForm => ({
    planDurationDays: form.planDurationDays,
    householdSize: form.householdSize,
    cuisines: form.cuisines,
    eatingStyles: form.eatingStyles,
    allergies: form.allergies,
    dietaryNotes: form.dietaryNotes,
    difficulty: form.difficulty,
    weeklyPacing: form.weeklyPacing,
    additionalNotes: form.additionalNotes,
    maxCookTimeMinutes: form.maxCookTimeMinutes,
    maxCookTimeCoverage: form.maxCookTimeCoverage,
  });

  const submitGuest = () => {
    const form_ = guestForm();
    void trackGuestEvent("wizard_step", { step: "generate_submitted" });
    guestMutation.mutate(buildGuestWizardPayload(form_), {
      onSuccess: (result) => {
        if (result.candidates.length === 0) return;
        guestCtx?.setGeneration({ candidates: result.candidates, form: form_ });
        // The session row's generationCount and candidates both moved.
        queryClient.invalidateQueries({ queryKey: ["guest", "session"] });
        router.push("/test-kitchen/options");
      },
    });
  };

  // ── Resub C4 — the guest's "Meals to choose from" ───────────────────────
  // The shelf is DB-only and spends nothing: the session's one plan is spent
  // by POST /guest/plan-from-picks on the Pick screen's "Build my week". The
  // form rides to the Pick screen because that call's `preferences` is the
  // guest's whole wizard body (G1b) — the same body build-plans gets.
  const submitGuestPick = () => {
    const form_ = guestForm();
    void trackGuestEvent("wizard_step", { step: "pick_submitted" });
    const body = buildGuestShelfRequest(form_);
    guestShelfMutation.mutate(body, {
      onSuccess: (shelf) => {
        router.push({
          pathname: "/test-kitchen/pick",
          params: {
            ...pickMealsRouteParams({
              shelf,
              request: body,
              mode: "prefs",
              planDurationDays: form_.planDurationDays,
              householdSize: form_.householdSize,
              capMinutes: form_.maxCookTimeMinutes,
            }),
            guestForm: JSON.stringify(form_),
          },
        });
      },
    });
  };

  const handleSubmit = () => {
    Keyboard.dismiss();
    if (!path || busy) return;
    if (guest) {
      // R4 — "a second generation" is on the door list, whichever path: one
      // plan per session (G1). The CTA is disabled when the generation is
      // spent, so this is the belt against a stale render (and the path a
      // keyboard "enter" could still take).
      if (guestGenerationSpent) return guestDoor.open("second_generation");
      return path === "pick" ? submitGuestPick() : submitGuest();
    }
    if (path === "plans") submitPlans();
    else submitPick();
  };

  const ctaHint =
    path === "pick"
      ? CTA_HINT_PICK
      : path === "plans"
        ? guest
          ? GUEST_CTA_HINT
          : CTA_HINT_PLANS
        : CTA_HINT_NO_PATH;

  // Inline status for the submit calls, right under the action.
  const submitError =
    shelfMutation.error ??
    textMutation.error ??
    guestMutation.error ??
    guestShelfMutation.error;

  const cuisineSelectedCount = form.cuisines.length;
  const charCount = form.description.length;

  // ── prefs-hydration gate ─────────────────────────────────────────────
  // Show a short loader while stored prefs are in flight so the inputs don't
  // flash unhydrated. On a prefs error we fall through — hydration is an
  // assist, not a blocker (the form renders with defaults).
  if (prefsQuery.isLoading) {
    return (
      <View style={s.loadingWrap}>
        <ActivityIndicator color={Colors.sage[700]} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header
        // A guest reached this screen from a URL, not from a stack — there is
        // nothing behind it to go back to.
        showBack={!guest}
        title={guest ? "Kiwi Test Kitchen" : "Kitchen Wizard"}
        subtitle={
          guest
            ? "Build a week of dinners — no account needed"
            : isText
              ? "Just say what you want"
              : "Set preferences"
        }
      />
      {/* 2 — the CTA, at the TOP as drawn, and ANCHORED (Block 2c Part B,
          Hans's item 6: "persist/anchor the top button… anchor is probably
          slicker"). It sits OUTSIDE the scroll view, pinned under the header
          at any scroll position, the way the Pick screen's footer is pinned.
          Gate, disabled state and the three hints are untouched. */}
      <View style={s.ctaBar} testID="wizard-cta-bar">
        <Button
          label={busy ? "Kiwi is thinking…" : CTA_LABEL}
          variant="primary"
          onPress={handleSubmit}
          disabled={!path || busy || (guest && guestGenerationSpent)}
          testID="wizard-build"
        />
        {guestMutation.isPending ? (
          <LoadingShim variant="inline" label="Kiwi is building your week…" />
        ) : shelfMutation.isPending || guestShelfMutation.isPending ? (
          <LoadingShim variant="inline" label="Pulling meals that fit…" />
        ) : textMutation.isPending ? (
          <LoadingShim variant="inline" label="Reading what you wrote…" />
        ) : (
          <Text style={s.ctaHint}>{ctaHint}</Text>
        )}
      </View>
      <KeyboardAwareScrollViewCompat
        // WS9 3f-4c (BUG-064) — clearance so a focused field near the bottom
        // lifts clear of the keyboard.
        bottomOffset={Spacing[6]}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Row 13 Block 2 — the entry's resume link, and the spent-generation
            notice. Both above everything else: they are the reason a returning
            visitor is on this screen at all. */}
        {guest && guestResumeBanner}
        {guest && guestGenerationSpent && (
          <View style={s.noticeCard}>
            <Text style={s.noticeTitle}>{GUEST_SPENT_TITLE}</Text>
            <Text style={s.noticeBody}>{GUEST_SPENT_BODY}</Text>
          </View>
        )}

        {/* Inline status for the two calls, right under the action. */}
        {submitError && (
          <View style={s.noticeCard}>
            <Text style={s.noticeTitle}>Kiwi got distracted. Try again?</Text>
            {submitError.message ? (
              <Text style={s.noticeBody}>{submitError.message}</Text>
            ) : null}
          </View>
        )}
        {textMutation.isSuccess &&
          textMutation.data?.parsedIntent.scenario === "unclear" && (
            <View style={s.clarifyCard}>
              <Text style={s.clarifyTitle}>Kiwi needs a little more</Text>
              <Text style={s.clarifyBody}>
                {textMutation.data.needsClarification?.reason ??
                  "Tell me a bit more — what kind of week do you want, or any meals you've been craving?"}
              </Text>
              <View style={{ marginTop: Spacing[2] }}>
                <Button
                  label="Edit my message"
                  variant="ghost"
                  // Reset so the clarification clears; the text stays for editing.
                  onPress={() => textMutation.reset()}
                />
              </View>
            </View>
          )}

        {/* Block 4b-3 — "See Previous Options" (hidden when no batch).
            🔴 NOT for a guest: it reads GET /wizard/last-batch, which is
            requireAuth. The guest's equivalent is the entry's resume banner,
            fed by GET /guest/session. */}
        {!guest && <WizardPreviousOptionsLink />}

        {/* 3 — text mode only: the box. */}
        {isText && (
          <Section label="Tell Kiwi" title={TEXT_SECTION_TITLE}>
            <Text style={s.cardSubtitle}>{TEXT_SECTION_SUBLINE}</Text>
            <View style={{ marginTop: Spacing[3] }}>
              <TextInput
                ref={textInputRef}
                value={form.description}
                onChangeText={(v) =>
                  update("description", v.slice(0, DESCRIPTION_MAX))
                }
                placeholder={PLACEHOLDER}
                placeholderTextColor={Palette.text.placeholder}
                multiline
                maxLength={DESCRIPTION_MAX}
                returnKeyType="default"
                blurOnSubmit
                style={[s.input, s.descriptionInput]}
                testID="wizard-text"
              />
              <Text style={s.charCount}>
                {charCount}/{DESCRIPTION_MAX}
              </Text>
            </View>
          </Section>
        )}

        {/* 4 — the path. Nothing selected by default — for a guest too since
            Resub C4 (POST /wizard/shelf takes a guest token since G1). */}
        <Section label="How to build it" title="What should Kiwi suggest?">
          <View style={s.pathList}>
            <PathOptionRow
              title={PATH_PICK_TITLE}
              subline={isText ? PATH_PICK_SUB_TEXT : PATH_PICK_SUB_PREFS}
              selected={path === "pick"}
              onPress={() => setPath("pick")}
              testID="wizard-path-pick"
            />
            <PathOptionRow
              title={PATH_PLANS_TITLE}
              subline={isText ? PATH_PLANS_SUB_TEXT : PATH_PLANS_SUB_PREFS}
              selected={path === "plans"}
              onPress={() => setPath("plans")}
              testID="wizard-path-plans"
            />
          </View>
        </Section>

        {/* 5 — the mix. Per-run: hydrated from stored, never written back.
            🔴 HIDDEN for a guest (R3), and the two dial keys are omitted from
            the request entirely — the server then runs both off. Showing the
            dials would also be dishonest: the Playlist dial's whole subject is
            the user's own meals, and a guest has none. */}
        {!guest && (
          <Section label="The mix" title="What goes in?">
            <Text style={s.mixIntro}>{MIX_INTRO}</Text>
            <MixDials
              style={{ marginTop: Spacing[3] }}
              value={{
                playlistLevel: form.playlistLevel,
                discoveryLevel: form.discoveryLevel,
              }}
              onChange={(next) => setForm((prev) => ({ ...prev, ...next }))}
              playlistCount={playlistQuery.data?.count}
            />
          </Section>
        )}

        {/* 6 — today's wizard exactly, from here down. */}
        <Section label="Plan length" title="How long is this plan?">
          <View style={s.chipRow}>
            {PLAN_DURATION_PRESETS.map((n) => (
              <Chip
                key={n}
                label={n === 1 ? "1 day" : `${n} days`}
                selected={form.planDurationDays === n}
                onPress={() => update("planDurationDays", n)}
              />
            ))}
          </View>
        </Section>

        <Section label="Household" title="Cooking for">
          <Stepper
            value={form.householdSize}
            onChange={(n) => update("householdSize", n)}
            min={HOUSEHOLD_MIN}
            max={HOUSEHOLD_MAX}
            suffix={form.householdSize === 1 ? "person" : "people"}
          />
        </Section>

        {/* Collapsed disclosure: per-run overrides of saved prefs (D-WS7-035)
            — hydrated from stored prefs, edits apply to THIS plan only and
            never write back. */}
        <View style={s.card}>
          <Pressable
            onPress={() => update("adjustExpanded", !form.adjustExpanded)}
            style={({ pressed }) => [s.dietHeader, pressed && { opacity: 0.7 }]}
            hitSlop={6}
          >
            <View style={{ flex: 1 }}>
              {/* R3 — RETITLED for a guest. "Adjust saved prefs" names something
                  a guest does not have, and "Optional" invites skipping the one
                  place the allergy question is asked. */}
              <Text style={s.cardTitle}>
                {guest ? GUEST_DIET_TITLE : "Adjust saved prefs for this plan"}
              </Text>
              <Text style={s.cardSubtitle}>
                {guest
                  ? GUEST_DIET_SUBTITLE
                  : "Optional — changes apply to this plan only"}
              </Text>
            </View>
            <Feather
              name={form.adjustExpanded ? "chevron-up" : "chevron-down"}
              size={20}
              color={Colors.neutral[700]}
            />
          </Pressable>

          {form.adjustExpanded && (
            <View style={s.dietBody}>
              <Text style={s.subSectionLabel}>
                Cuisines
                {cuisineSelectedCount > 0 ? ` · ${cuisineSelectedCount} selected` : ""}
              </Text>
              <CuisinePicker
                value={form.cuisines}
                onChange={(next) => update("cuisines", next)}
              />

              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Weekly pacing
              </Text>
              <View style={s.chipRow}>
                {PACING_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.key}
                    label={opt.label}
                    selected={form.weeklyPacing === opt.key}
                    onPress={() => update("weeklyPacing", opt.key)}
                  />
                ))}
              </View>

              {/* Dietary — the shared <DietarySection> (D-WS9-206/207). No
                  heading of its own here: the block sits under "Optional —
                  changes apply to this plan only". NOTHING PERSISTS FROM HERE. */}
              <View style={{ marginTop: Spacing[4] }}>
                <DietarySection
                  eatingStyles={form.eatingStyles}
                  onEatingStylesChange={(next) => update("eatingStyles", next)}
                  allergies={form.allergies}
                  onAllergiesChange={(next) => update("allergies", next)}
                  otherAllergies={form.otherAllergies}
                  onOtherAllergiesChange={(next) => update("otherAllergies", next)}
                  dietaryNotes={form.dietaryNotes}
                  onDietaryNotesChange={(v) => update("dietaryNotes", v)}
                  // WS9 BUG-201 — the screen renders past a prefs error by
                  // design; this makes it SAY so.
                  // A guest has no stored prefs to be unavailable — the form IS
                  // the source. Passing prefsQuery.isError here would render a
                  // "we couldn't load your preferences" warning about a read
                  // that was never made.
                  prefsUnavailable={!guest && prefsQuery.isError}
                />
              </View>

              {/* 🔴 HIDDEN for a guest (R3), and `saucePreference` is omitted
                  from the request. The server runs sauce as balanced for this
                  generation; the account's own default is set later, by the
                  user, in Preferences — never by a form they never saw. */}
              {!guest && (
                <>
                  <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                    Sauces and Spice Mixes Preference
                  </Text>
                  <View style={s.chipRow}>
                    {SAUCE_PREFERENCE_OPTIONS.map((opt) => (
                      <Chip
                        key={opt.value}
                        label={opt.label}
                        selected={form.saucePreference === opt.value}
                        onPress={() => update("saucePreference", opt.value)}
                      />
                    ))}
                  </View>
                </>
              )}

              <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                Max cook time
              </Text>
              <View style={s.chipRow}>
                {COOK_TIME_CAP_OPTIONS.map((opt) => (
                  <Chip
                    key={opt.label}
                    label={opt.label}
                    selected={form.maxCookTimeMinutes === opt.value}
                    onPress={() => update("maxCookTimeMinutes", opt.value)}
                  />
                ))}
              </View>

              {form.maxCookTimeMinutes !== null && (
                <>
                  <Text style={[s.subSectionLabel, { marginTop: Spacing[4] }]}>
                    Apply the cap to
                  </Text>
                  <View style={s.chipRow}>
                    {COOK_TIME_COVERAGE_OPTIONS.map((opt) => (
                      <Chip
                        key={opt.value}
                        label={opt.label}
                        selected={form.maxCookTimeCoverage === opt.value}
                        onPress={() => update("maxCookTimeCoverage", opt.value)}
                      />
                    ))}
                  </View>
                </>
              )}
            </View>
          )}
        </View>

        {/* Notes — prefs mode only; text mode has the box at the top instead. */}
        {!isText && (
          <Section
            label="Notes"
            title="Anything specific for this plan?"
            subtitle="Optional"
          >
            <TextInput
              value={form.additionalNotes}
              onChangeText={(v) => update("additionalNotes", v)}
              placeholder="e.g., a comforting week, planning to entertain Saturday, lots of veggies"
              placeholderTextColor={Palette.text.placeholder}
              multiline
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={Keyboard.dismiss}
              style={[s.input, { minHeight: 80 }]}
            />
          </Section>
        )}

        {/* Cancel goes BACK, and a guest arrived by URL with nothing behind it. */}
        {!guest && (
          <View style={s.footer}>
            <Pressable
              onPress={() => router.back()}
              hitSlop={6}
              style={({ pressed }) => [s.cancelLink, pressed && { opacity: 0.6 }]}
            >
              <Text style={s.cancelText}>Cancel</Text>
            </Pressable>
          </View>
        )}
      </KeyboardAwareScrollViewCompat>
      {/* Part D — the shared door (R5). Renders nothing until an action hits it,
          and for a member no action ever does. */}
      <GuestDoorSheet action={guestDoor.door} onClose={guestDoor.close} />
    </View>
  );
}

/** One "How to build it" row: select circle · title · sub-line. */
function PathOptionRow({
  title,
  subline,
  selected,
  onPress,
  testID,
}: {
  title: string;
  subline: string;
  selected: boolean;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={title}
      testID={testID}
      style={({ pressed }) => [
        s.pathRow,
        selected && s.pathRowSelected,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={[s.selectCircle, selected && s.selectCircleOn]}>
        {selected && <Feather name="check" size={12} color={Colors.neutral[0]} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={s.pathTitle}>{title}</Text>
        <Text style={s.pathSub}>{subline}</Text>
      </View>
    </Pressable>
  );
}

function Section({
  label,
  title,
  subtitle,
  children,
}: {
  label: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <View style={s.card}>
      <Text style={s.sectionLabel}>{label}</Text>
      <Text style={s.cardTitle}>{title}</Text>
      {subtitle && <Text style={s.cardSubtitle}>{subtitle}</Text>}
      <View style={{ marginTop: Spacing[3] }}>{children}</View>
    </View>
  );
}

const s = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    backgroundColor: Colors.neutral[100],
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
  },
  // The anchored CTA bar — a card-surface strip under the header, hairline
  // below so the scrolling content reads as passing beneath it.
  ctaBar: {
    gap: Spacing[2],
    alignItems: "stretch",
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[3],
    backgroundColor: Palette.background.card,
    borderBottomWidth: 1,
    borderBottomColor: Colors.neutral[300],
  },
  ctaHint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  sectionLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: Typography.face.sans[600],
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
    lineHeight: 20,
  },
  mixIntro: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  pathList: {
    gap: Spacing[2],
  },
  pathRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[3],
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    borderRadius: Radius.md,
    padding: Spacing[3],
    backgroundColor: Palette.background.card,
  },
  pathRowSelected: {
    borderColor: Colors.sage[600],
    borderWidth: 1.4,
    backgroundColor: Colors.sage[50],
  },
  selectCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: Colors.neutral[400],
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  selectCircleOn: {
    backgroundColor: Colors.sage[600],
    borderColor: Colors.sage[600],
  },
  pathTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  pathSub: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
    lineHeight: 19,
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  dietHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  dietBody: {
    marginTop: Spacing[4],
  },
  subSectionLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[2],
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
    textAlignVertical: "top",
  },
  descriptionInput: {
    minHeight: 110,
    maxHeight: 220,
    paddingVertical: Spacing[3],
    lineHeight: 22,
  },
  charCount: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: Spacing[1],
    textAlign: "right",
  },
  footer: {
    marginTop: Spacing[2],
    alignItems: "center",
  },
  cancelLink: {
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[3],
  },
  cancelText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  noticeCard: {
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[3],
  },
  noticeTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  noticeBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
  clarifyCard: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  clarifyTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: 4,
  },
  clarifyBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 20,
  },
});
