// WS9 Redesign Arc Block 2a (D-WS9-245) — the two mix dials, ONE component.
//
// Rendered on three surfaces — the preferences screen (stored, auto-saved),
// onboarding step 2 (stored via step 3's PATCH) and the merged wizard's "The
// mix" section (per-run, never written back — D-WS7-035). Same two rows in the
// same order everywhere: PLAYLIST above DISCOVERY, each a None · Some · Mostly
// · All chip row (the Chip idiom the preferences screen already uses for every
// other single-select), each with its hint under the label.
//
// ⚠️ ZERO PLAYLIST MEALS → the Playlist row is REPLACED by the nudge card,
// here, so the preferences screen and the wizard cannot drift on when it shows
// or what it says. The caller passes `playlistCount` (from GET /me/playlist);
// `undefined` means "not known / not asked" and renders the chips; a
// preferences screen whose playlist read failed falls back to the chips rather
// than nagging.
//
// Block 2b (ruled, 2a CANDIDATE-2) — onboarding step 2 HIDES the Playlist row
// (`showPlaylist={false}`): a brand-new user has no playlist, the stored default
// stays none, and they meet the dial in Preferences and the wizard. Discovery
// stays.
//
// The stored level may be non-none while the playlist is empty (the user set
// it, then removed every meal). The server treats that as none; the UI shows
// the nudge and leaves the stored value alone.
//
// "All on one forces None on the other" lives in lib/wizard/dials.ts (setDial)
// — the server applies the same rule, this just shows it.

import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";

import { Chip } from "@/components/Chip";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import { DIAL_LEVEL_OPTIONS, type DialLevel } from "@/lib/domain";
import { setDial, type DialState } from "@/lib/wizard/dials";

import { pickerStyles } from "./shared";

// Copy — verbatim from the locked September 16 mockups.
export const PLAYLIST_DIAL_LABEL = "Playlist meals";
export const PLAYLIST_DIAL_HINT = "from your playlist";
export const DISCOVERY_DIAL_LABEL = "Discovery meals";
export const DISCOVERY_DIAL_HINT = "new to you, still your preferences";
export const NUDGE_TITLE = "No playlist? No problem.";
export const NUDGE_BODY = "Want your own go-to favorites in your plans?";
export const NUDGE_LINK = "Start your playlist ›";

/** Where the nudge's link lands — the Playlist tab (Block 2b). */
export const PLAYLIST_ROUTE = "/(tabs)/playlist" as const;

export interface MixDialsProps {
  value: DialState;
  onChange: (next: DialState) => void;
  /** GET /me/playlist `count`. 0 → the nudge replaces the Playlist row;
   *  undefined → chips (count unknown or not applicable). */
  playlistCount?: number;
  /** Space above the first row — the preferences screen stacks rows with
   *  Spacing[4]; the wizard's section supplies its own. */
  style?: object;
  /** Block 2b — onboarding step 2 passes false: Discovery only. Default true. */
  showPlaylist?: boolean;
}

export function MixDials({
  value,
  onChange,
  playlistCount,
  style,
  showPlaylist = true,
}: MixDialsProps) {
  const showNudge = playlistCount === 0;
  return (
    <View style={style}>
      {!showPlaylist ? null : showNudge ? (
        <PlaylistNudgeCard />
      ) : (
        <DialRow
          label={PLAYLIST_DIAL_LABEL}
          hint={PLAYLIST_DIAL_HINT}
          value={value.playlistLevel}
          onSelect={(level) => onChange(setDial(value, "playlistLevel", level))}
        />
      )}
      <DialRow
        label={DISCOVERY_DIAL_LABEL}
        hint={DISCOVERY_DIAL_HINT}
        value={value.discoveryLevel}
        onSelect={(level) => onChange(setDial(value, "discoveryLevel", level))}
        style={showPlaylist ? { marginTop: Spacing[4] } : undefined}
      />
    </View>
  );
}

function DialRow({
  label,
  hint,
  value,
  onSelect,
  style,
}: {
  label: string;
  hint: string;
  value: DialLevel;
  onSelect: (level: DialLevel) => void;
  style?: object;
}) {
  return (
    <View style={style}>
      <Text style={s.label}>{label}</Text>
      <Text style={s.hint}>{hint}</Text>
      <View style={pickerStyles.chipRow}>
        {DIAL_LEVEL_OPTIONS.map((opt) => (
          <Chip
            key={opt.value}
            label={opt.label}
            selected={value === opt.value}
            onPress={() => onSelect(opt.value)}
          />
        ))}
      </View>
    </View>
  );
}

/**
 * The zero-playlist nudge — sage-50 surface, sage-300 border, a terracotta
 * link to the Playlist tab. Exported so a screen that wants the card without
 * the dials (none today) does not re-draw it.
 */
export function PlaylistNudgeCard() {
  const router = useRouter();
  return (
    <View style={s.nudge}>
      <Text style={s.nudgeTitle}>{NUDGE_TITLE}</Text>
      <Text style={s.nudgeBody}>{NUDGE_BODY}</Text>
      <Pressable
        onPress={() => router.push(PLAYLIST_ROUTE)}
        accessibilityRole="link"
        hitSlop={6}
        style={({ pressed }) => [s.nudgeLinkWrap, pressed && { opacity: 0.6 }]}
      >
        <Text style={s.nudgeLink}>{NUDGE_LINK}</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  // Same treatment as preferences.tsx's SubLabel / helpText pair, so the two
  // rows sit in that screen's rhythm without a screen-local override.
  label: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  hint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 1,
    marginBottom: Spacing[2],
  },
  nudge: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
  },
  nudgeTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  nudgeBody: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
    lineHeight: 20,
  },
  nudgeLinkWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: Spacing[2],
    alignSelf: "flex-start",
  },
  nudgeLink: {
    fontSize: Typography.fontSize.sm,
    color: Palette.text.link,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
});
