/**
 * Single source of truth for the mobile API base URL.
 *
 * Resolution precedence (uses `||`, not `??`, matching the historical
 * 6-of-7 callsites — an explicitly-set-but-empty env value falls through):
 *
 *   1. EXPO_PUBLIC_API_BASE_URL — explicit absolute URL (e.g.
 *      "https://api.example.com/api"). Use this in CI / production.
 *   2. EXPO_PUBLIC_DOMAIN — bare host (e.g. "kiwi-app.replit.dev"). The
 *      Replit dev pattern wired by package.json:7. We append https:// and /api.
 *   3. http://localhost:3000/api — local-dev fallback for `pnpm dev`
 *      without either env var set.
 *
 * Convention: `apiBase` includes the `/api` suffix. Wrapper callers
 * supply endpoint paths WITHOUT a leading `/api` segment — just the
 * leading slash plus the route (e.g. "/auth/login", not "/api/auth/login").
 */
export const apiBase: string =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");
