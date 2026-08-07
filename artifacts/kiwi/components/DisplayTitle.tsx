// WS9 3f-4d (D-WS9-121) — the app-wide title primitive. Phase 0 confirmed there
// was NO shared title component: ~34 render sites each styled their own <Text>
// and each had to remember which field to read. This retires that.
//
// The primitive OWNS three things and ONLY these three:
//   1. which field is read — displayTitle ?? title ?? fallback (resolveDisplayTitle)
//   2. how many lines the variant allows (VARIANT_LINES)
//   3. the fallback string when both names are absent (BUG-066's client half)
//
// It deliberately does NOT own typography. Font / size / weight / color stay
// with the calling surface via the passed `style`. If the primitive imposed
// type, converting 34 sites would become a visual redesign — every converted
// site must render pixel-identically to today except where a variant
// intentionally changes the line count. `numberOfLines` / `ellipsizeMode` are
// omitted from the accepted props so a caller cannot fight the variant policy.
//
// `title` STAYS the canonical identity key (client dedupe, server dedupKey,
// wizard idempotency hash, SwapMealSheet self-exclusion). displayTitle is a
// pure display override; nothing keys off it. Until the Haiku backfill
// populates displayTitle it is null on every record, so resolveDisplayTitle
// falls through to `title` — behavior is unchanged today.

import React from "react";
import { StyleProp, Text, TextProps, TextStyle } from "react-native";

// A title source is either a raw string (surfaces that only hold a `.title`
// string in scope) or an entity carrying the optional short-name override.
// `name` is the plan alias for `title` — plan list/summary shapes expose their
// resolved name as `.name` (titleOverride ?? template.title), while meals/dishes
// expose `.title`. Only one of the two is ever present on a given entity.
export type TitleSource =
  | string
  | {
      title?: string | null;
      displayTitle?: string | null;
      name?: string | null;
    };

// Reused verbatim from the pre-existing PlanNameEditor / plan/[id] fallback so
// the app has ONE "no name" string, not two. Meals/dishes never hit this (their
// title column is NOT NULL); it is effectively the nameless-plan guard (BUG-066).
export const DISPLAY_TITLE_FALLBACK = "Untitled plan";

// Plain resolver for non-JSX callers (Alert / toast strings). Same precedence
// the component uses: displayTitle wins, then title, then the fallback.
export function resolveDisplayTitle(
  source: TitleSource | null | undefined,
  fallback: string = DISPLAY_TITLE_FALLBACK,
): string {
  if (source == null) return fallback;
  if (typeof source === "string") {
    return source.trim() || fallback;
  }
  const display = source.displayTitle?.trim();
  if (display) return display;
  const title = source.title?.trim();
  if (title) return title;
  const name = source.name?.trim();
  if (name) return name;
  return fallback;
}

export type DisplayTitleVariant = "row" | "slim" | "railCard" | "hero";

// Line policy per variant, derived from the Phase 0 wrap audit. `undefined` =
// uncapped (wraps freely) for the detail-screen hero titles that were
// deliberately left uncapped.
const VARIANT_LINES: Record<DisplayTitleVariant, number | undefined> = {
  row: 2, // list rows — grow to two lines then truncate
  slim: 1, // fixed-height strips / one-line plan-name caps
  railCard: 2, // TriedTrueCard (fixed 150px width; the rail edge still clips)
  hero: undefined, // detail-screen hero titles — wrap freely
};

export interface DisplayTitleProps
  extends Omit<TextProps, "children" | "numberOfLines" | "ellipsizeMode"> {
  source: TitleSource | null | undefined;
  variant: DisplayTitleVariant;
  /** Override the default "Untitled plan" fallback for a specific surface. */
  fallback?: string;
  style?: StyleProp<TextStyle>;
}

export function DisplayTitle({
  source,
  variant,
  fallback,
  style,
  ...rest
}: DisplayTitleProps) {
  const text = resolveDisplayTitle(source, fallback);
  const numberOfLines = VARIANT_LINES[variant];
  return (
    <Text
      style={style}
      numberOfLines={numberOfLines}
      ellipsizeMode={numberOfLines != null ? "tail" : undefined}
      {...rest}
    >
      {text}
    </Text>
  );
}
