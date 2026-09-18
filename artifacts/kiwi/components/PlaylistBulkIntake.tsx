// WS9 Redesign Arc Block 2c Part A (D-WS9-244) — the Playlist BULK intake
// section — the boxes under the host-owned "Several at once · Name the meals you already cook" heading (BUG-298).
//
// Hans: "a component with say 3 individual text boxes, with an 'add another
// meal' action below them, and the user can just type in a handful of meals,
// hit save, and it adds them to their favorites." Rendered by the Meal
// Builder in its Add-to-your-playlist context (toPlaylist=1), ABOVE the six
// ways in. The runner (lib/builder/bulkPlaylistIntake.ts) owns the
// sequence — one Ask-Kiwi call per box, one at a time; this file owns the
// boxes, the per-box progress, Retry, and the hand-off when the run ends.
//
// While it runs the host must not let the screen be dismissed without a
// confirm (onRunningChange). When every box has saved the host lands on the
// Playlist tab with the review sheet; when some failed the user chooses:
// Retry them, or "Go to playlist" with what saved.

import React, { useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";

import { ASK_KIWI_SERVINGS_DEFAULT } from "@/components/AskKiwiView";
import { Button } from "@/components/Button";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  addBox,
  BULK_ADD_ANOTHER,
  BULK_PLACEHOLDERS,
  BULK_RETRY,
  BULK_SECTION_SUBLINE,
  BULK_STATUS_FAILED,
  BULK_STATUS_SAVED,
  BULK_STATUS_WAITING,
  BULK_STATUS_WRITING,
  BULK_SUBMIT,
  BULK_SUBMIT_CAPTION,
  initialBoxes,
  retryBox,
  runBulkIntake,
  runnableBoxes,
  savedBoxes,
  setBoxText,
  type BulkBox,
  type BulkIntakeDeps,
} from "@/lib/builder/bulkPlaylistIntake";

export const BULK_RUNNING_LABEL = "Kiwi is writing…";
export const BULK_GO_TO_PLAYLIST = "Go to playlist with what saved";
export const bulkOutcomeLine = (saved: number, failed: number) =>
  `${saved} saved · ${failed} failed — retry, or move on with what saved`;

export interface PlaylistBulkIntakeProps {
  deps: Pick<BulkIntakeDeps, "parseMeal" | "saveMeal" | "addToPlaylist">;
  /** Every box saved (or the user moved on) — land on the tab with the sheet. */
  onFinished: (saved: { mealId: string; title: string }[]) => void;
  /** A 402 stopped the run — the upgrade modal. */
  onUpgradeRequired: () => void;
  /** The host's dismissal guard. */
  onRunningChange?: (running: boolean) => void;
}

export function PlaylistBulkIntake({
  deps,
  onFinished,
  onUpgradeRequired,
  onRunningChange,
}: PlaylistBulkIntakeProps) {
  const [boxes, setBoxesState] = useState<BulkBox[]>(() => initialBoxes());
  const [running, setRunning] = useState(false);
  const [lastOutcome, setLastOutcome] = useState<{ saved: number; failed: number } | null>(null);
  // Re-entry guard read synchronously (the `running` state is stale on a
  // same-tick second tap — the builder's savingRef idiom).
  const runningRef = useRef(false);
  // The runner reports per-box updates while an await is pending; the
  // hand-off after the run must see the LATEST list, so it is mirrored here
  // and every write goes through updateBoxes.
  const boxesRef = useRef(boxes);
  const updateBoxes = (fn: (prev: BulkBox[]) => BulkBox[]) => {
    boxesRef.current = fn(boxesRef.current);
    setBoxesState(boxesRef.current);
  };

  const setRunningBoth = (v: boolean) => {
    runningRef.current = v;
    setRunning(v);
    onRunningChange?.(v);
  };
  const applyUpdate = (b: BulkBox) =>
    updateBoxes((prev) => prev.map((x) => (x.id === b.id ? b : x)));
  const runnerDeps: BulkIntakeDeps = {
    ...deps,
    servings: ASK_KIWI_SERVINGS_DEFAULT,
    onBoxUpdate: applyUpdate,
  };

  const finish = (next: BulkBox[]) => onFinished(savedBoxes(next));

  const handleSubmit = async () => {
    Keyboard.dismiss();
    if (runningRef.current) return;
    if (runnableBoxes(boxes).length === 0) return;
    setRunningBoth(true);
    setLastOutcome(null);
    const outcome = await runBulkIntake(boxesRef.current, runnerDeps);
    setRunningBoth(false);
    if (outcome.upgradeRequired) {
      onUpgradeRequired();
      return;
    }
    const next = boxesRef.current;
    if (outcome.failed.length === 0) {
      finish(next);
      return;
    }
    setLastOutcome({ saved: savedBoxes(next).length, failed: outcome.failed.length });
  };

  const handleRetry = async (box: BulkBox) => {
    if (runningRef.current) return;
    setRunningBoth(true);
    const outcome = await retryBox(box, runnerDeps);
    setRunningBoth(false);
    if (outcome.upgradeRequired) {
      onUpgradeRequired();
      return;
    }
    const next = boxesRef.current;
    const stillFailed = next.filter((b) => b.status === "failed").length;
    if (stillFailed === 0 && runnableBoxes(next).length === 0) finish(next);
    else setLastOutcome({ saved: savedBoxes(next).length, failed: stillFailed });
  };

  const handleMoveOn = () => {
    if (runningRef.current) return;
    finish(boxesRef.current);
  };

  const canSubmit = !running && runnableBoxes(boxes).length > 0;

  return (
    <View style={s.section} testID="playlist-bulk">
      {/* WS9 row 5 Block 3 (BUG-298) — the section heading ("Several at once ·
          Name the meals you already cook") is NOT rendered here any more. The
          HOST renders it, exactly as it renders the sibling "One at a time ·
          How do you want to build this meal?" heading, so the two sit under
          one layout rule instead of one inside a card and one outside it
          (Hans, device item 7b). The strings still live in
          lib/builder/bulkPlaylistIntake.ts; the one mount (app/meal-builder.tsx)
          reads them from there. The subline stays: it captions the boxes. */}
      <Text style={s.subline}>{BULK_SECTION_SUBLINE}</Text>

      <View style={s.boxes}>
        {boxes.map((box, i) => (
          <BulkBoxRow
            key={box.id}
            box={box}
            placeholder={BULK_PLACEHOLDERS[i % BULK_PLACEHOLDERS.length]}
            running={running}
            onChangeText={(t) => updateBoxes((prev) => setBoxText(prev, box.id, t))}
            onRetry={() => handleRetry(box)}
          />
        ))}
      </View>

      <Pressable
        onPress={() => updateBoxes((prev) => addBox(prev))}
        disabled={running}
        accessibilityRole="button"
        accessibilityLabel={BULK_ADD_ANOTHER}
        style={({ pressed }) => [s.addAnother, pressed && { opacity: 0.7 }]}
      >
        <Text style={s.addAnotherText}>{BULK_ADD_ANOTHER}</Text>
      </Pressable>

      <View style={s.submitWrap}>
        <Button
          label={running ? BULK_RUNNING_LABEL : BULK_SUBMIT}
          variant="primary"
          onPress={handleSubmit}
          disabled={!canSubmit}
          loading={running}
          testID="playlist-bulk-submit"
        />
        <Text style={s.caption}>{BULK_SUBMIT_CAPTION}</Text>
      </View>

      {lastOutcome && lastOutcome.failed > 0 && !running && (
        <View style={s.outcomeCard}>
          <Text style={s.outcomeText}>{bulkOutcomeLine(lastOutcome.saved, lastOutcome.failed)}</Text>
          {lastOutcome.saved > 0 && (
            <View style={{ marginTop: Spacing[2] }}>
              <Button
                label={BULK_GO_TO_PLAYLIST}
                variant="ghost"
                onPress={handleMoveOn}
                testID="playlist-bulk-move-on"
              />
            </View>
          )}
        </View>
      )}
    </View>
  );
}

function BulkBoxRow({
  box,
  placeholder,
  running,
  onChangeText,
  onRetry,
}: {
  box: BulkBox;
  placeholder: string;
  running: boolean;
  onChangeText: (t: string) => void;
  onRetry: () => void;
}) {
  const locked = box.status === "saved" || box.status === "writing" || box.status === "waiting";
  return (
    <View style={s.boxWrap} testID={`bulk-box-${box.id}`} accessibilityLabel={`Meal box ${box.status}`}>
      <TextInput
        value={box.text}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={Palette.text.placeholder}
        // The italic serif face applies to the PLACEHOLDER only — RN draws the
        // placeholder in the input's face, so the face swaps when text lands.
        style={[
          s.input,
          box.text.length === 0 && s.inputPlaceholderFace,
          box.status === "saved" && s.inputSaved,
          box.status === "failed" && s.inputFailed,
        ]}
        editable={!locked}
        multiline
        returnKeyType="done"
        blurOnSubmit
        onSubmitEditing={Keyboard.dismiss}
        autoCapitalize="sentences"
        autoCorrect
        testID={`bulk-input-${box.id}`}
      />
      {box.status !== "idle" && (
        <View style={s.statusRow}>
          {box.status === "writing" && <ActivityIndicator size="small" color={Colors.sage[700]} />}
          <Text
            style={[
              s.statusText,
              box.status === "saved" && s.statusSaved,
              box.status === "failed" && s.statusFailed,
            ]}
            testID={`bulk-status-${box.id}`}
          >
            {box.status === "waiting"
              ? BULK_STATUS_WAITING
              : box.status === "writing"
                ? BULK_STATUS_WRITING
                : box.status === "saved"
                  ? BULK_STATUS_SAVED
                  : BULK_STATUS_FAILED}
          </Text>
          {box.status === "failed" && (
            <Pressable
              onPress={onRetry}
              disabled={running}
              accessibilityRole="button"
              accessibilityLabel={`${BULK_RETRY} ${box.text.trim()}`}
              hitSlop={8}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Text style={s.retryText}>{BULK_RETRY}</Text>
            </Pressable>
          )}
        </View>
      )}
      {box.status === "failed" && box.error ? (
        <Text style={s.errorText}>{box.error}</Text>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  section: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[4],
    marginBottom: Spacing[4],
  },
  // BUG-298 — `label` / `title` styles DELETED with the heading hoist; the
  // host's sectionLabelQuiet / sectionHeader render the heading now. The
  // subline is the card's first line, so its top margin (which spaced it off
  // the title) is gone with them.
  subline: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[3],
  },
  boxes: { gap: Spacing[2] },
  boxWrap: { gap: 4 },
  input: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    minHeight: 52,
  },
  inputPlaceholderFace: {
    fontFamily: Typography.face.serifItalic[400],
    fontStyle: "italic",
  },
  inputSaved: { borderColor: Colors.sage[300], backgroundColor: Colors.sage[50] },
  inputFailed: { borderColor: Colors.terracotta[300] },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingHorizontal: 2,
  },
  statusText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  statusSaved: { color: Colors.sage[700], fontFamily: Typography.face.sans[500] },
  statusFailed: { color: Colors.terracotta[600], fontFamily: Typography.face.sans[500] },
  retryText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  errorText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    paddingHorizontal: 2,
  },
  addAnother: { alignSelf: "flex-start", paddingVertical: Spacing[2] },
  addAnotherText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[600],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  submitWrap: { gap: Spacing[2], marginTop: Spacing[1] },
  caption: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  outcomeCard: {
    marginTop: Spacing[3],
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.terracotta[300],
    padding: Spacing[3],
  },
  outcomeText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
  },
});
