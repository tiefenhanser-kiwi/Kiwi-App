// WS7-3 A2 — date-windowed featuring resolution (PRD §15.6.3).
//
// A featured (or hosting-featured) plan template is "currently visible" when
// its flag is set AND `now` falls inside its optional [start, end] window. A
// null start or end leaves that side of the window unbounded. Both Featured
// and Hosting-Featured share the same featuredStartDate / featuredEndDate
// columns (per WS7-3 A2 §1.1).
//
// Pure functions, no side effects, `now` injected for testability.

import type { Prisma } from "@prisma/client";

// The subset of MealPlanTemplate fields the resolution reads.
export interface FeaturingWindowFields {
  isFeatured: boolean;
  isHostingFeatured: boolean;
  featuredStartDate: Date | null;
  featuredEndDate: Date | null;
}

// True when `now` is within an optional [start, end] window. Both bounds are
// inclusive; a null bound leaves that side open.
function isWithinWindow(
  start: Date | null,
  end: Date | null,
  now: Date,
): boolean {
  if (start && now.getTime() < start.getTime()) return false;
  if (end && now.getTime() > end.getTime()) return false;
  return true;
}

// Predicate — is this template currently visible as Featured?
export function isCurrentlyFeatured(
  t: FeaturingWindowFields,
  now: Date,
): boolean {
  return (
    t.isFeatured && isWithinWindow(t.featuredStartDate, t.featuredEndDate, now)
  );
}

// Predicate — is this template currently visible as Hosting-Featured?
export function isCurrentlyHostingFeatured(
  t: FeaturingWindowFields,
  now: Date,
): boolean {
  return (
    t.isHostingFeatured &&
    isWithinWindow(t.featuredStartDate, t.featuredEndDate, now)
  );
}

// Prisma `where` fragment for the date window alone (flag-agnostic). Spread
// into a larger where, or compose under `AND`.
function windowWhere(now: Date): Prisma.MealPlanTemplateWhereInput {
  return {
    AND: [
      {
        OR: [
          { featuredStartDate: null },
          { featuredStartDate: { lte: now } },
        ],
      },
      {
        OR: [{ featuredEndDate: null }, { featuredEndDate: { gte: now } }],
      },
    ],
  };
}

// Prisma `where` fragment: isFeatured = true AND `now` inside the window.
export function featuredWhere(now: Date): Prisma.MealPlanTemplateWhereInput {
  return { isFeatured: true, ...windowWhere(now) };
}

// Prisma `where` fragment: isHostingFeatured = true AND `now` inside the
// window.
export function hostingFeaturedWhere(
  now: Date,
): Prisma.MealPlanTemplateWhereInput {
  return { isHostingFeatured: true, ...windowWhere(now) };
}
