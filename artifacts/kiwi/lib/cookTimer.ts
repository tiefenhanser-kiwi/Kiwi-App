// Parses cook-step strings like "Simmer for 15 minutes" and returns the
// suggested timer in seconds. Returns null when no duration can be detected.

const PATTERNS: Array<{ re: RegExp; mult: number }> = [
  { re: /(\d+)\s*(?:-|to)\s*\d+\s*minute/i, mult: 60 },
  { re: /(\d+)\s*minute/i, mult: 60 },
  { re: /(\d+)\s*min\b/i, mult: 60 },
  { re: /(\d+)\s*hour/i, mult: 3600 },
  { re: /(\d+)\s*second/i, mult: 1 },
];

export function detectStepSeconds(step: string): number | null {
  for (const { re, mult } of PATTERNS) {
    const m = step.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > 0) return n * mult;
    }
  }
  return null;
}

export function formatTimer(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}
