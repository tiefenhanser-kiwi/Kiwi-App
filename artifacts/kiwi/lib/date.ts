// Display helpers for ISO date strings used in row sort-aware lines
// (Recipes tab, picker sheets) and elsewhere. Approximate; precision
// is a polish pass.

import { parseLocalDate } from "./dates";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function formatRelative(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "in the future";
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} ${weeks === 1 ? "week" : "weeks"} ago`;
  }
  if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${months} ${months === 1 ? "month" : "months"} ago`;
  }
  const years = Math.floor(diffDays / 365);
  return `${years} ${years === 1 ? "year" : "years"} ago`;
}

export function formatDate(iso: string): string {
  // BUG-293 (same class) — a YYYY-MM-DD is a CALENDAR day, not an instant:
  // new Date("2026-09-16") is UTC midnight and reads Sep 15 west of UTC.
  // Full timestamps keep the instant parse.
  const date = DATE_ONLY.test(iso) ? parseLocalDate(iso) : new Date(iso);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
