# WS7-1 — Mobile API client foundation audit (read-only)

**Run:** 2026-05-18
**HEAD:** `524baea` (`[WS7-PRE Fix 5b] D-WS7-013 6b-5 smoke Case 1 cuisine fixture update`)
**Working tree:** clean
**Branch:** `main` (parity with `origin/ws7-in-progress` at `524baea`; `origin/main` lags at `7c2b385`)
**Auditor note:** Project-knowledge docs (`kiwi_navigation.md`, `kiwi_codebase_map.md`, `kiwi_deferred_decisions_log.md`, `kiwi_ws6_plan.md` §5 WS7-1, D-WS7-003 + D-WS7-006 entries) live chat-Claude-side and are not reachable from this Claude Code session. This audit works from repo state plus the prior `ws7-pre-audit-report.md` template. Any claim that would normally cite a chat-doc passage is grounded in file:line evidence from the working tree and flagged where the chat-side context would have refined the framing.

---

## Executive summary

There are **seven** apiBase resolution sites today, not six. The five per-feature modules in [lib/api/](../../kiwi/lib/api) share an identical 4-line fallback chain; [lib/api.ts:11-15](../../kiwi/lib/api.ts#L11-L15) is a 6th copy with the same shape (host to `scaleIngredients`, which is itself a dead export — no callsites); [lib/auth.ts:23](../../kiwi/lib/auth.ts#L23) is a 7th, materially different copy ("footgun") that omits the `EXPO_PUBLIC_DOMAIN` branch and falls back to `localhost:3000/api`. The token-read pattern is broadly consistent — every feature module routes through `readToken()` from `lib/auth` — but the resulting **authentication contracts diverge across modules**: grocery's POST helper returns a discriminated-union with `error: "unauthenticated"`, every other call throws `new Error("Not authenticated")`, and `lib/api.ts:33` sets `Authorization` only when a token exists (no throw on missing). Error-handling shape is similarly fragmented: three modules throw with a parsed `body.error` string, one (recipeImport) returns server typed-envelope failures verbatim, one (grocery POST) returns a discriminated union by status code, and `lib/auth.ts` throws a status-coded synthetic. **There is no shared 401-bounce today** — AuthContext's bootstrap clears the token only when `/auth/me` itself returns 401; every other 401 surfaces as a generic error string to the caller, and the user sees no logout. The React Query surface is tiny: three `useMutation` consumers and zero `useQuery` consumers, so the "AuthContext bootstrap useEffect → `useAuthMe`" pivot the plan-doc names is the cleanest first migration target — there are no existing `useQuery` callers to harmonize with, and the bootstrap useEffect at [AuthContext.tsx:51-82](../../kiwi/contexts/AuthContext.tsx#L51-L82) is the only auth-gated read on cold start. Loading state is per-screen ad-hoc with no shared `LoadingShim`; every screen rolls its own `<ActivityIndicator>` inside a status card/box. The route layer at [app/_layout.tsx](../../kiwi/app/_layout.tsx), [app/index.tsx](../../kiwi/app/index.tsx), [(auth)/_layout.tsx](../../kiwi/app/(auth)/_layout.tsx) is small (~3 files) and would naturally host a global 401-bounce by reacting to a shared "session expired" signal.

---

## §A — apiBase resolution audit

There are **7** apiBase resolution sites in the mobile codebase, not 6. (The task description names 6 — the missing site is [lib/api.ts:11-15](../../kiwi/lib/api.ts#L11-L15), which hosts the dead `scaleIngredients` export.)

### §A.1 — Canonical pattern (5 per-feature modules + lib/api.ts)

The five `lib/api/*.ts` modules and `lib/api.ts` share an identical 4-line resolution. Verbatim from [lib/api/grocery.ts:20-24](../../kiwi/lib/api/grocery.ts#L20-L24):

```ts
const apiBase =
  process.env.EXPO_PUBLIC_API_BASE_URL ||
  (process.env.EXPO_PUBLIC_DOMAIN
    ? `https://${process.env.EXPO_PUBLIC_DOMAIN}/api`
    : "http://localhost:3000/api");
```

Identical text appears in:
- [lib/api/wizard.ts:7-11](../../kiwi/lib/api/wizard.ts#L7-L11)
- [lib/api/tellKiwi.ts:11-15](../../kiwi/lib/api/tellKiwi.ts#L11-L15)
- [lib/api/meals.ts:13-17](../../kiwi/lib/api/meals.ts#L13-L17)
- [lib/api/recipeImport.ts:17-21](../../kiwi/lib/api/recipeImport.ts#L17-L21)
- [lib/api.ts:11-15](../../kiwi/lib/api.ts#L11-L15)

**Env vars read:**
1. `EXPO_PUBLIC_API_BASE_URL` — explicit absolute URL (e.g. `https://api.example.com/api`)
2. `EXPO_PUBLIC_DOMAIN` — bare host (e.g. `kiwi-app.replit.dev`); module appends `https://` and `/api`

**Fallback chain:** explicit base → domain-derived → `http://localhost:3000/api`.

**Drift between the six canonical copies:** none. Whitespace-identical. This is six independent string copies of the same expression, ripe for consolidation into a single `lib/api/base.ts` or similar.

### §A.2 — `lib/auth.ts:23` "apiBase footgun"

Verbatim from [lib/auth.ts:21-23](../../kiwi/lib/auth.ts#L21-L23):

```ts
// ── API base URL (duplicated from lib/api.ts for now; consolidate in WS7) ─

const apiBase = process.env.EXPO_PUBLIC_API_BASE_URL ?? "http://localhost:3000/api";
```

**What makes it different:**

1. **No `EXPO_PUBLIC_DOMAIN` branch.** It reads only `EXPO_PUBLIC_API_BASE_URL`; if that env var is unset, it skips straight to `localhost:3000/api`. The other six sites would still derive a working URL from `EXPO_PUBLIC_DOMAIN` (the Replit dev-domain shape used by [package.json:7](../../kiwi/package.json#L7) — `EXPO_PUBLIC_DOMAIN=$REPLIT_DEV_DOMAIN`).
2. **Uses `??` nullish coalescing.** The canonical copies use `||` (string falsy: empty string falls through). With `??`, an explicitly-set-but-empty `EXPO_PUBLIC_API_BASE_URL=""` would short-circuit to `""` instead of falling through — an edge case but a real semantic difference.
3. **Author comment acknowledges the drift:** `// duplicated from lib/api.ts for now; consolidate in WS7`. This is the only one of the seven sites that's annotated as a known consolidation candidate.

**Footgun consequence:** in any environment where only `EXPO_PUBLIC_DOMAIN` is set (the working pattern for Replit dev — see [package.json:7](../../kiwi/package.json#L7)), the five per-feature modules + `lib/api.ts` correctly target the Replit URL, but `lib/auth.ts` silently targets `localhost:3000/api`. That means auth calls (signup, login, logout, fetchMe, patchUiState) would 404/refuse-connection while every other endpoint works — a confusing, hard-to-spot split-brain.

**WS7-1 consolidation target:** a single source of `apiBase` that all seven callsites import.

---

## §B — Token read pattern audit

Every site reads from `lib/auth.ts`'s `readToken()` (or the auth flow inside `lib/auth.ts` itself). Storage is consistently `expo-secure-store` under key `kiwi_authToken`. Variation lives entirely in how a missing token is handled.

| Site | Read pattern | Missing-token handling | Notes |
|---|---|---|---|
| [lib/auth.ts:13-15](../../kiwi/lib/auth.ts#L13-L15) | `readToken()` source: `SecureStore.getItemAsync(TOKEN_KEY)` returning `string \| null` | N/A — internal calls in `lib/auth.ts` don't gate on token presence; they take the token as an argument from AuthContext | Canonical implementation |
| [lib/api/grocery.ts:41-44](../../kiwi/lib/api/grocery.ts#L41-L44) (POST helper) | `const token = await readToken();` | `if (!token) return { success: false, error: "unauthenticated" };` | **Only site that returns** an unauthenticated result instead of throwing |
| [lib/api/grocery.ts:179-181](../../kiwi/lib/api/grocery.ts#L179-L181) (GET list), [:252-253](../../kiwi/lib/api/grocery.ts#L252-L253) (lookup), [:297-300](../../kiwi/lib/api/grocery.ts#L297-L300) (add item) | `const token = await readToken();` | `if (!token) throw new Error("Not authenticated");` | Throws — same module, different contract per helper |
| [lib/api/meals.ts:65-68](../../kiwi/lib/api/meals.ts#L65-L68) | `const token = await readToken();` | `if (!token) throw new Error("Not authenticated");` | Throw |
| [lib/api/tellKiwi.ts:56-59](../../kiwi/lib/api/tellKiwi.ts#L56-L59) | `const token = await readToken();` | `if (!token) throw new Error("Not authenticated");` | Throw |
| [lib/api/wizard.ts:26-29](../../kiwi/lib/api/wizard.ts#L26-L29) | `const token = await readToken();` | `if (!token) throw new Error("Not authenticated");` | Throw |
| [lib/api/recipeImport.ts:193-196](../../kiwi/lib/api/recipeImport.ts#L193-L196), [:304-307](../../kiwi/lib/api/recipeImport.ts#L304-L307), [:391-394](../../kiwi/lib/api/recipeImport.ts#L391-L394) | `const token = await readToken();` | `if (!token) throw new Error("Not authenticated");` | Throw — one per import flow |
| [lib/api.ts:29-35](../../kiwi/lib/api.ts#L29-L35) (`scaleIngredients`) | `const token = await readToken();` | **Does not throw** — sets `Authorization` only if token present | Unique tolerant pattern; helper is currently dead (no consumers grep-found) |

**Drift:**

- **Same module, different contracts.** [lib/api/grocery.ts](../../kiwi/lib/api/grocery.ts) has both styles: `generateGroceryListForPlan` returns `{ success: false, error: "unauthenticated" }`; `getGroceryList`, `lookupGroceryItemCandidates`, `addGroceryListItem` all throw. The discriminated-union style was chosen for the POST helper specifically because the consumer (Plan Review) needs to branch on `error === "list_exists"` vs `"plan_not_found"` vs `"unauthenticated"` without try/catch.
- **`lib/api.ts:scaleIngredients` is uniquely tolerant of missing token** — it just sends the request unauthenticated, letting the server return 401 (which then throws via the status check at [lib/api.ts:41-43](../../kiwi/lib/api.ts#L41-L43)). This works because the helper is dead (no consumers) — if WS7 keeps the recipe-scale path, the canonical pattern should apply.
- **No expiry awareness anywhere.** None of the seven sites read a token-expiry timestamp; "missing" is the only failure mode they distinguish from "present." Tokens are opaque to the mobile side. The server is the only authority on validity, and the mobile side learns of expiry exclusively via 401 responses.

**Canonical pattern to consolidate around:** the throw-on-missing pattern (6 of 7 sites). The grocery POST discriminated-union exception is a deliberate UX call (Plan Review screen branches on the result type) — keeping it as a typed-result helper but layering a shared `requireToken()` helper under it is a clean WS7 shape. Single source of truth in `lib/api/base.ts` (or similar) that the consolidated `apiBase` lives next to.

---

## §C — Authorization header construction audit

All token-bearing requests use the same `Bearer ${token}` shape. The variation is structural (where the header object is built) rather than semantic.

| Site | Construction | Notes |
|---|---|---|
| [lib/auth.ts:84](../../kiwi/lib/auth.ts#L84) (logout) | `headers: { Authorization: \`Bearer ${token}\` }` | Token passed in as arg, not via readToken — caller (AuthContext) holds the token in React state |
| [lib/auth.ts:92](../../kiwi/lib/auth.ts#L92) (fetchMe) | Same shape | Token-as-arg |
| [lib/auth.ts:125-127](../../kiwi/lib/auth.ts#L125-L127) (patchUiState) | `headers: { "Content-Type": "application/json", Authorization: \`Bearer ${token}\` }` | Token-as-arg; merged with Content-Type for the JSON PATCH body |
| [lib/api/grocery.ts:50-54](../../kiwi/lib/api/grocery.ts#L50-L54) (POST generate) | Same merged shape | Token from readToken |
| [lib/api/grocery.ts:188](../../kiwi/lib/api/grocery.ts#L188) (GET list) | `headers: { Authorization: \`Bearer ${token}\` }` | Token from readToken; GET has no Content-Type |
| [lib/api/grocery.ts:259](../../kiwi/lib/api/grocery.ts#L259) (lookup GET) | Same | |
| [lib/api/grocery.ts:313-317](../../kiwi/lib/api/grocery.ts#L313-L317) (POST add item) | Merged shape with Content-Type | |
| [lib/api/meals.ts:71-74](../../kiwi/lib/api/meals.ts#L71-L74) | Merged shape | |
| [lib/api/tellKiwi.ts:62-65](../../kiwi/lib/api/tellKiwi.ts#L62-L65) | Merged shape | |
| [lib/api/wizard.ts:32-35](../../kiwi/lib/api/wizard.ts#L32-L35) | Merged shape | |
| [lib/api/recipeImport.ts:200-203](../../kiwi/lib/api/recipeImport.ts#L200-L203), [:323-326](../../kiwi/lib/api/recipeImport.ts#L323-L326), [:398-401](../../kiwi/lib/api/recipeImport.ts#L398-L401) | Merged shape | |
| [lib/api.ts:30-35](../../kiwi/lib/api.ts#L30-L35) | `Record<string, string>` built incrementally; `Authorization` set conditionally | **Only site that builds the headers object as a mutable record** rather than an inline literal |

**Drift:**

- **One site (lib/api.ts:30-35) handles missing-token in the header construction** — every other site throws/returns before reaching the header step. The `lib/api.ts` pattern is the only one that would send a request without an Authorization header (and rely on the server 401). All other sites guarantee `Authorization` is present once the fetch is made.
- **Token source bifurcation.** Three sites in `lib/auth.ts` take the token as an argument (because they're called from AuthContext, which already has the token in state). Every site outside `lib/auth.ts` calls `readToken()` itself. This means: post-WS7, if AuthContext exposes a `useQuery`-backed auth state, callers outside `lib/auth.ts` will need to keep using `readToken()` (or a hook equivalent) — the inside-auth pattern doesn't generalize.

**Consolidation candidate for WS7-1:** a shared `authHeaders(token: string | null, contentType?: string): Record<string, string>` (or curried `authedFetch`) that all seven sites use, eliminating both the per-call inline literal and the divergent `lib/api.ts:30-35` mutable-record path.

---

## §D — Error handling audit

The most variable surface in the audit. Five distinct error shapes coexist.

### §D.1 — lib/auth.ts

[lib/auth.ts:46-53](../../kiwi/lib/auth.ts#L46-L53) `parseAuthError`:

```ts
async function parseAuthError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    return body.error ?? `Request failed (${res.status})`;
  } catch {
    return `Request failed (${res.status})`;
  }
}
```

- **signupRequest / loginRequest:** `if (!res.ok) throw new Error(await parseAuthError(res))` — `body.error` string surfaced verbatim.
- **logoutRequest** ([:79-88](../../kiwi/lib/auth.ts#L79-L88)): wrapped in `.catch(() => {})` — **swallows everything**. "Client always wins on logout."
- **fetchMe** ([:90-102](../../kiwi/lib/auth.ts#L90-L102)): **401-aware**. `if (res.status === 401) return null;` (caller is AuthContext bootstrap; null = "token invalid, clear it"). Other non-2xx throws.
- **patchUiState** ([:114-134](../../kiwi/lib/auth.ts#L114-L134)): `throw new Error(\`patchUiState failed: ${res.status} ${text}\`)` — status-coded synthetic with raw response text, no JSON parsing.

### §D.2 — Per-feature modules

| Module | Helper | Error shape | 401-aware | 402-aware | Surfaces `userFacingMessage` |
|---|---|---|---|---|---|
| `lib/api/wizard.ts` | `buildWizardPlans` ([:38-49](../../kiwi/lib/api/wizard.ts#L38-L49)) | Throw `Error(body.error \|\| \`HTTP ${status}\`)` | No (treats 401 same as any non-2xx — body.error string) | Comment at [:39-40](../../kiwi/lib/api/wizard.ts#L39-L40) **explicitly mentions 402** ("entitlement") but no special branch; relies on server returning a styled `body.error` string | Indirectly — via `body.error` string |
| `lib/api/tellKiwi.ts` | `buildFromText` ([:68-77](../../kiwi/lib/api/tellKiwi.ts#L68-L77)) | Same `Error(body.error \|\| HTTP-status)` | No | No (no mention) | Indirectly |
| `lib/api/meals.ts` | `findSimilarMeals` ([:77-86](../../kiwi/lib/api/meals.ts#L77-L86)) | Same | No | No | Indirectly |
| `lib/api/grocery.ts` | `generateGroceryListForPlan` ([:57-86](../../kiwi/lib/api/grocery.ts#L57-L86)) | **Discriminated union by status**: 200 success, 409 list_exists, 404 plan_not_found, 401 unauthenticated, 502 ai_failed (with `message`), default unknown | **Yes — explicit `error: "unauthenticated"` branch** at [:72-74](../../kiwi/lib/api/grocery.ts#L72-L74) | No | Yes — `ai_failed` carries `message` |
| `lib/api/grocery.ts` | `getGroceryList`, `lookupGroceryItemCandidates`, `addGroceryListItem` | Throw `Error(\`failed: ${status}\`)` — no body parsing | No | No | No |
| `lib/api/recipeImport.ts` | `importRecipeFromUrl`, `importRecipeFromImage`, `importRecipeFromText` | **Typed envelope passthrough**: server returns `{ success: true, recipe, source, sourceUrl }` or `{ success: false, reason, userFacingMessage, suggestedAction }`; client returns same shape (adapted to DraftMeal on success). Hard-codes 429 → rate_limited envelope at [:207-214](../../kiwi/lib/api/recipeImport.ts#L207-L214), [:330-337](../../kiwi/lib/api/recipeImport.ts#L330-L337), [:405-412](../../kiwi/lib/api/recipeImport.ts#L405-L412) without reading body | No (would throw `if (!token)` — server 401 falls through to "sdk_error" envelope via JSON parse failure) | No | **Yes — first-class `userFacingMessage` field** in every failure branch |
| `lib/api.ts` | `scaleIngredients` ([:36-46](../../kiwi/lib/api.ts#L36-L46)) | Throw `Error(\`Scaling failed (${status})\`)` — no body parsing | No | No | No |

### §D.3 — 401 surfacing today

- **AuthContext bootstrap [AuthContext.tsx:51-82](../../kiwi/contexts/AuthContext.tsx#L51-L82):** the only 401-aware caller. `fetchMe` returns `null` on 401 → token is silently cleared, user is treated as unauthenticated, `isLoading` flips false. The user sees no error message; the next render hits the [(auth)/_layout.tsx:12-14](../../kiwi/app/(auth)/_layout.tsx#L12-L14) redirect chain and lands on welcome.
- **Grocery POST `generateGroceryListForPlan`:** returns `{ error: "unauthenticated" }` to the Plan Review screen. The screen handler at [plan/[id].tsx:257](../../kiwi/app/plan/[id].tsx#L257) (per prior audit) branches on the error — but **the codepath surfaces "unauthenticated" as a generic recoverable error**, not a forced logout. If the user's token expires mid-session, this call will return an error envelope and the user will see "couldn't generate" without being signed out.
- **All other modules:** 401 → generic thrown Error with `body.error` string or HTTP status. The consumer screen treats it as any other failure (Alert.alert / inline notice / "Kiwi got distracted" banner). **The user is not signed out**, and the token is not cleared. Subsequent calls keep failing the same way until the user manually signs out via Profile.

**There is no global 401 interceptor today.** Every consumer would need to be made 401-aware individually. The plan-doc D-WS7-006 entry (per task description: "the existing 401 handling at AuthContext.tsx:61-75") refers to the bootstrap-only handling captured above; there is no in-flight 401 cascade.

### §D.4 — 402 surfacing today

Only one module mentions 402: [lib/api/wizard.ts:39-40](../../kiwi/lib/api/wizard.ts#L39-L40) ("entitlement"), and only in a comment. The handling is identical to any other non-2xx — the server-styled `body.error` string is surfaced as the thrown Error message. **No module branches on `status === 402`**. The mobile [upgrade.tsx](../../kiwi/app/upgrade.tsx) screen exists as a modal target, but no error path routes to it today.

### §D.5 — `userFacingMessage` extraction

Two distinct conventions:

- **String-in-error.message** (wizard, tellKiwi, meals): server returns `{ error: "user-facing string" }`; mobile threads it through `throw new Error(body.error)`; consumer reads `mutation.error?.message`. Fragile — if the server adds a structured field, it's lost.
- **Typed-envelope.userFacingMessage** (recipeImport): server returns `{ success: false, reason, userFacingMessage, suggestedAction }`; mobile preserves the shape; consumer reads `result.userFacingMessage`. Robust — extensible without changing the throw contract.

The lib/auth.ts and lib/api.ts/grocery (non-POST) helpers extract nothing — the throw message is `\`failed: ${status}\`` or `\`HTTP ${status}\``, which is not user-facing.

**Consolidation target:** the typed-envelope pattern is the more durable contract, but the grocery POST discriminated-union is the most type-safe (consumer must handle each failure mode at the type level). WS7-1's design decision: pick one and migrate.

---

## §E — React Query existing-mutations audit

**Three** `useMutation` consumers exist. **Zero** `useQuery` / `useInfiniteQuery` / `useQueryClient` consumers. (Verified via Grep — `useQuery|useInfiniteQuery|useQueryClient|invalidateQueries` returns zero files in [artifacts/kiwi](../../kiwi).)

The three hooks live at [hooks/](../../kiwi/hooks) and follow an identical paper-thin shape:

### §E.1 — Hook signatures (verbatim)

[hooks/useBuildWizardPlans.ts](../../kiwi/hooks/useBuildWizardPlans.ts):

```ts
import { useMutation } from "@tanstack/react-query";
import { buildWizardPlans, type BuildWizardPlansResult } from "@/lib/api/wizard";
import type { WizardPreferencesInput } from "@/lib/types";

export function useBuildWizardPlans() {
  return useMutation<BuildWizardPlansResult, Error, WizardPreferencesInput>({
    mutationFn: buildWizardPlans,
  });
}
```

[hooks/useBuildFromText.ts](../../kiwi/hooks/useBuildFromText.ts):

```ts
export function useBuildFromText() {
  return useMutation<BuildFromTextResult, Error, BuildFromTextInput>({
    mutationFn: buildFromText,
  });
}
```

[hooks/useFindSimilarMeals.ts](../../kiwi/hooks/useFindSimilarMeals.ts):

```ts
export function useFindSimilarMeals() {
  return useMutation<FindSimilarResponse, Error, FindSimilarRequest>({
    mutationFn: findSimilarMeals,
  });
}
```

**Common shape:** generic `useMutation<TData, Error, TVariables>` with `mutationFn` bound to the per-feature module's POST helper. **No `onSuccess`, `onError`, `onMutate`, `onSettled` in the hook**. No `retry` config, no `gcTime`, no cache invalidation. The hook is purely a thin React Query wrapper around the network call.

### §E.2 — Consumer patterns

| Consumer | Hook | onSuccess / onError site | Cache invalidation | Calls feature module directly? |
|---|---|---|---|---|
| [app/wizard-results.tsx:78-89](../../kiwi/app/wizard-results.tsx#L78-L89) | `useBuildWizardPlans` | `useEffect` calls `mutation.reset(); mutation.mutate(wizardInput);` — **no onSuccess/onError callback passed**; consumer reads `mutation.isPending / .isError / .isSuccess / .data` reactively in render | None | No — through hook |
| [app/tellkiwi.tsx:104-125](../../kiwi/app/tellkiwi.tsx#L104-L125) | `useBuildFromText` | `mutation.mutate(payload, { onSuccess: (result) => { if (unclear/empty) return; router.push(...) } })` — **inline onSuccess passed to `.mutate()`, no onError** | None | No — through hook |
| [components/FindSimilarSheet.tsx:80-114](../../kiwi/components/FindSimilarSheet.tsx#L80-L114) | `useFindSimilarMeals` | `mutation.mutate({...}, { onSuccess: (data) => setAiOrderedIds(...), onError: () => setUsedFallback(true) })` — **inline onSuccess AND onError**; consumer also relies on `mutation.isPending` via derived `isLoading = findSimilarMutation.isPending` | None | No — through hook |

**Other useMutation-adjacent state in `app/wizard-results.tsx`:**

```ts
const mutation = useBuildWizardPlans();

useEffect(() => {
  if (tellKiwiPayload) return;
  if (!wizardInput) return;
  mutation.reset();
  mutation.mutate(wizardInput);
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [input, attempt, tellKiwiPayload]);
```

Note the deliberate `mutation.reset()` before `.mutate()` and the `attempt` ticker at [:77](../../kiwi/app/wizard-results.tsx#L77) — used to force re-fire when the user taps "More options" with unchanged input. This is a useful pattern to keep in mind for `useQuery` adoption: `useQuery`'s `refetch()` would replace this idiom.

### §E.3 — Cache invalidation reality

There are no cache reads to invalidate. `useQueryClient` is unused, so `invalidateQueries` is moot today. WS7-1 introduces the first `useQuery` consumer — there's no existing cache surface to harmonize with; the convention is being established fresh.

### §E.4 — Conventions to harmonize useQuery around

From the three mutations, the conventions to carry forward into useQuery are:

1. **Paper-thin hook in [hooks/](../../kiwi/hooks)** that re-exports a `useMutation`/`useQuery` wrapping a per-feature module function. No business logic in the hook.
2. **`Error` as the error generic** (matches the throw-Error pattern from §B/§D — fine for mutations, less ideal for queries where `useQuery` will surface `error.message` in shared loading-state UI).
3. **Consumer holds onSuccess/onError inline at the `.mutate()` callsite**, not in the hook. For useQuery this maps cleanly: hook returns `{ data, isLoading, isError, error, refetch }`; consumer reacts in render.
4. **No global `QueryClient` config beyond default** ([app/_layout.tsx:23](../../kiwi/app/_layout.tsx#L23): `const queryClient = new QueryClient();` with no options). WS7-1 can establish defaults (e.g. `staleTime`, `retry`, `refetchOnWindowFocus`) here without breaking existing mutations.

---

## §F — AuthContext bootstrap + 401 cascade audit

### §F.1 — Bootstrap flow

[AuthContext.tsx:41-82](../../kiwi/contexts/AuthContext.tsx#L41-L82):

```ts
const [user, setUser] = React.useState<User | null>(null);
const [token, setToken] = React.useState<string | null>(null);
const [isLoading, setIsLoading] = React.useState(true);
const [error, setError] = React.useState<string | null>(null);
// ...
React.useEffect(() => {
  let cancelled = false;
  const bootstrap = async () => {
    try {
      const stored = await readToken();
      if (!stored) {
        if (!cancelled) setIsLoading(false);
        return;
      }
      const me = await fetchMe(stored);
      if (cancelled) return;
      if (me) {
        setToken(stored);
        setUser(me);
      } else {
        // Token invalid — clear it silently.
        await clearToken();
      }
    } catch {
      // Network error during boot — treat as unauthenticated but don't
      // clear token (might be a transient offline state).
    } finally {
      if (!cancelled) setIsLoading(false);
    }
  };
  bootstrap();
  return () => { cancelled = true; };
}, []);
```

**Flow on cold start:**
1. Read stored token from SecureStore.
2. If no token → `isLoading = false`, user is `null` → routes hit (auth)/welcome via [(auth)/_layout.tsx](../../kiwi/app/(auth)/_layout.tsx) + [index.tsx](../../kiwi/app/index.tsx).
3. If token exists → call `fetchMe(token)`.
4. If `fetchMe` returns user → populate `token` + `user` state, `isAuthenticated = true`.
5. If `fetchMe` returns `null` (server said 401) → call `clearToken()` to wipe SecureStore. Local React state `token`/`user` stay `null`. **User sees no error — silent re-login flow.**
6. If `fetchMe` throws (network failure) → swallow, `isLoading = false`, user stays at `null`. **Token is NOT cleared** — assumption is "transient offline." On the next cold start the token is still there and gets retried.
7. `cancelled` flag short-circuits any post-unmount setState.

### §F.2 — Token validation pattern

`fetchMe` at [lib/auth.ts:90-102](../../kiwi/lib/auth.ts#L90-L102) is the validator. It hits `GET /api/auth/me` with the token; server returns `{ user }` on 200, 401 on bad/expired token. Mobile maps the 401 to `null` (the only 401-aware mapping in the entire mobile codebase outside of grocery POST).

It does NOT just check token presence — it makes a real round-trip on every cold start. This is the **only** API call on cold start before the user navigates anywhere. A `useAuthMe` `useQuery` would slot in here cleanly: the bootstrap useEffect becomes a `const { data: user, isLoading } = useAuthMe()`, and AuthContext exposes `user` + `isLoading` from the query state directly.

### §F.3 — 401 cascade today

Per §D.3 above and prior audit's §J: **there is no in-flight 401 handler**. AuthContext's bootstrap branch is the only place a 401 results in `clearToken()`. Any post-bootstrap 401:

- Grocery POST: returns `{ error: "unauthenticated" }`, consumer shows generic error. User stays signed in.
- All other modules: throw generic error or surface `body.error`. User stays signed in.

The user-facing consequence: token expiry mid-session results in everything quietly failing with generic errors until the user manually navigates to Profile and signs out / re-signs in.

This is the gap WS7-1 is positioned to close: a shared `authedFetch` (or React Query interceptor / global error handler) that detects 401 globally, calls `clearToken()` + `setUser(null)` + `setToken(null)` on AuthContext, which then cascades through (auth)/_layout's `isAuthenticated` redirect.

### §F.4 — Signals consumed by root layout

AuthContext exposes (from [AuthContext.tsx:17-37](../../kiwi/contexts/AuthContext.tsx#L17-L37)):

```ts
interface AuthContextValue {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;  // !!token && !!user
  isLoading: boolean;         // true until bootstrap settles
  error: string | null;
  login, signup, logout, clearError, setUiState
}
```

Three signals are consumed by routing (see §G):
- `isLoading` — gate that prevents redirect decisions mid-bootstrap.
- `isAuthenticated` — the redirect decision input.
- (Indirectly) `user` — consumed by tabs screens for filter persistence (`user.lastPlansFilters` etc.) but not for routing.

---

## §G — Root layout routing audit

### §G.1 — The route tree (3 files)

[app/_layout.tsx](../../kiwi/app/_layout.tsx) is the root Expo Router stack. It mounts providers (in this nesting): `SafeAreaProvider` → `ErrorBoundary` → `QueryClientProvider` → `AuthProvider` → `AppProvider` → `GestureHandlerRootView` → `KeyboardProvider` → `RootLayoutNav` (Stack). [`_layout.tsx:73-83`](../../kiwi/app/_layout.tsx#L73-L83):

```tsx
<QueryClientProvider client={queryClient}>
  <AuthProvider>
    <AppProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
          <StatusBar style="dark" />
          <RootLayoutNav />
        </KeyboardProvider>
      </GestureHandlerRootView>
    </AppProvider>
  </AuthProvider>
</QueryClientProvider>
```

**Crucial nesting:** `QueryClientProvider` wraps `AuthProvider`. This means `AuthProvider` (and a future `useAuthMe`) can use React Query. ✅ no provider reorder needed.

The Stack screens are listed at [_layout.tsx:26-50](../../kiwi/app/_layout.tsx#L26-L50) — all named, none auth-gated at this level. The root doesn't do auth decisions itself; it delegates to the (auth) and (tabs) group layouts.

### §G.2 — Auth decision: app/index.tsx

[app/index.tsx](../../kiwi/app/index.tsx) — full file:

```tsx
import { Redirect } from "expo-router";
import { useAuth } from "@/contexts/AuthContext";

export default function Index() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }
  if (isAuthenticated) {
    return <Redirect href="/(tabs)" />;
  }
  return <Redirect href="/(auth)/welcome" />;
}
```

The decision tree:
- `isLoading = true` (bootstrap pending) → render nothing. Splash screen stays up until fonts also loaded ([_layout.tsx:62-68](../../kiwi/app/_layout.tsx#L62-L68)).
- `isAuthenticated = true` (token + user populated) → redirect to (tabs).
- `isAuthenticated = false` → redirect to (auth)/welcome.

### §G.3 — (auth)/_layout.tsx

[app/(auth)/_layout.tsx](../../kiwi/app/(auth)/_layout.tsx) — full file:

```tsx
export default function AuthLayout() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return null;
  }
  if (isAuthenticated) {
    return <Redirect href="/(tabs)" />;
  }
  return <Stack screenOptions={{ headerShown: false }} />;
}
```

Same gating, mirror direction: if you somehow land on an (auth) route while authenticated, bounce to (tabs).

### §G.4 — (tabs)/_layout.tsx

[(tabs)/_layout.tsx](../../kiwi/app/(tabs)/_layout.tsx) — **no auth gate**. It's a pure `<Tabs>` rendering the five tab routes (index, meals, plans, groceries, profile). The assumption is that the only way to reach (tabs) is via [index.tsx](../../kiwi/app/index.tsx) Redirect, which already gates on `isAuthenticated`. If a stale (tabs) route survives sign-out, there's nothing here to bounce.

### §G.5 — Onboarding gate

No onboarding completeness check is present in the routing layer. [app/onboarding-prefs.tsx](../../kiwi/app/onboarding-prefs.tsx) and [onboarding-step-3.tsx](../../kiwi/app/onboarding-step-3.tsx) are named in the root Stack but no "if onboarding incomplete → redirect here" gate fires; signup flow probably routes there via `router.push` from the signup screen (not verified this audit).

### §G.6 — Where a global 401-bounce would integrate

The natural integration point is **inside AuthContext** — a `bounceOn401()` action exposed alongside `logout()`, called from a shared `authedFetch` wrapper or a React Query global onError handler. The cascade:

1. Any in-flight call returns 401.
2. Shared wrapper detects → calls `bounceOn401()`.
3. `bounceOn401()` does what `logout()` does without the server-side `/auth/logout` call (since the token is already invalid server-side): `clearToken()`, `setToken(null)`, `setUser(null)`, optionally `setError("Your session expired — please sign in again.")`.
4. `isAuthenticated` flips false → both [index.tsx](../../kiwi/app/index.tsx) and [(auth)/_layout.tsx](../../kiwi/app/(auth)/_layout.tsx) gates re-evaluate → user lands on welcome.
5. (Open design question for WS7-1) does the user see the toast/banner explaining the bounce, or just silently land on welcome? Today the silent flow is the only one.

---

## §H — Bootstrap useEffect → useQuery migration target

### §H.1 — Why `useAuthMe` is the right first target

Per the plan-doc's framing in the task description, `useAuthMe` is "probably" the right first useQuery target. Repo-state checks support that:

1. **It's the only auth-gated read on cold start.** Other tab/screen reads (plans, meals, etc.) are stub-fed from [lib/stubs.ts](../../kiwi/lib/stubs.ts) today and don't hit the network. Migrating one of those would require a real server endpoint first (which is WS7-2 onwards).
2. **It already exists as a clean async function** — `fetchMe(token)` at [lib/auth.ts:90-102](../../kiwi/lib/auth.ts#L90-L102) — that takes one argument (token) and returns `Promise<User | null>`. The `useQuery` shape would be `useQuery({ queryKey: ['me', token], queryFn: () => fetchMe(token), enabled: !!token })`.
3. **It's the only 401-aware read.** Returning `null` on 401 (rather than throwing) is the contract that makes `useQuery` data-or-null a clean fit.
4. **The current bootstrap useEffect is small and self-contained** ([AuthContext.tsx:51-82](../../kiwi/contexts/AuthContext.tsx#L51-L82)) — under 35 lines. The migration is mostly delete-and-replace.

### §H.2 — Rough migration sketch

Today's manual flow:
- `useState(isLoading=true)` + `useState(user=null)` + `useState(token=null)`.
- useEffect on mount reads SecureStore → calls fetchMe → setUser/setToken on success.
- Cancellation via `cancelled` flag.

useQuery flow:
- `useState(token=null)` (still needed; SecureStore is mutable + persistent, useQuery doesn't own that state).
- A small useEffect that reads SecureStore once → setToken (no fetchMe call here).
- `const { data: user, isLoading, error } = useQuery({ queryKey: ['me', token], queryFn: () => fetchMe(token!), enabled: !!token, staleTime: Infinity, retry: false })`.
- `isAuthenticated = !!token && !!user`.
- On `data === null` (401 path) → side-effect (in a useEffect on data) calls `clearToken()` + `setToken(null)`.

### §H.3 — Gotchas

1. **Token-as-queryKey.** Including the token in the queryKey is natural (different token = different user) but means a token rotation triggers a refetch. For WS7-1 with no refresh tokens, this is fine — token only changes on login/logout. Future refresh-token work would need to redesign.
2. **Race condition on cold-start storage read.** SecureStore is async; `useQuery({ enabled: !!token })` will fire as soon as `token` is set, but only the second render (after the storage useEffect resolves). The first render has `token = null` so useQuery is disabled — clean.
3. **`isLoading` semantics.** `useQuery`'s `isLoading` is true only while the query is in flight; before the token is read from SecureStore, `enabled` is false and `isLoading` is also false. Need to distinguish "haven't read storage yet" from "no token / not signed in" — the AuthContext bootstrap currently uses one `isLoading` state for both. A combined `isBootstrapping = storageReadPending || (queryEnabled && isLoading)` would replace it.
4. **Network-failure-vs-401 divergence.** Today's bootstrap swallows network errors (keeps the token, treats as offline) and clears the token only on 401. With `useQuery`, `retry: false` + `fetchMe` returning `null` on 401 keeps this split clean: error → keep token; `data === null` → clear token. The mapping is preserved.
5. **AppProvider depends on AuthProvider's `token` for some reads.** Need to confirm AppProvider's contract doesn't break if `token` is briefly available before `user` is — `isAuthenticated` requires both, so consumers should be reading that, not token directly. Worth a once-over during implementation.
6. **`logout()` invalidation.** Today logout sets `token = null` + `user = null` directly. Post-migration, useQuery needs to be invalidated/reset on logout so the cached `me` data is dropped. `queryClient.removeQueries({ queryKey: ['me'] })` in `logout` covers this.

---

## §I — Loading-state patterns today

**No shared `LoadingShim` / `LoadingSpinner` / `LoadingScreen` component exists** (Grep verified). Every consumer rolls its own pattern. Three distinct idioms recur:

### §I.1 — Cancellable useEffect with local `loading` boolean

Most common for one-shot read effects against stub helpers (which will become real `useQuery`s in WS7-N).

[(tabs)/plans.tsx:56-82](../../kiwi/app/(tabs)/plans.tsx#L56-L82):

```ts
const [rows, setRows] = useState<PlanRowData[]>([]);
const [loading, setLoading] = useState(false);
// ...
useEffect(() => {
  let cancelled = false;
  (async () => {
    setLoading(true);
    try {
      const payload = await getPlansPayload();
      if (!cancelled) setRows(payload.plans);
    } finally {
      if (!cancelled) setLoading(false);
    }
  })();
  return () => { cancelled = true; };
}, []);
```

Same idiom in:
- [components/PlanDiscoveryCard.tsx:33-50](../../kiwi/components/PlanDiscoveryCard.tsx#L33-L50) (`getHomePayload`)
- [app/grocery-list/[id].tsx:117-141](../../kiwi/app/grocery-list/[id].tsx#L117-L141) (lookup typeahead — separate `candidatesLoading` flag, debounced)
- [app/grocery-list/[id].tsx:147-162](../../kiwi/app/grocery-list/[id].tsx#L147-L162) (`getGroceryList` — **no `loading` flag**, just null-check on the list state; partial-loading state is invisible to the user)
- [app/plan/[id].tsx:115](../../kiwi/app/plan/[id].tsx#L115) `useState(() => getReviewPlan(planId))` — **synchronous stub read; no async loading state** at all. Will need one once `GET /plans/:id` becomes a real network call.

### §I.2 — React Query mutation flags (`mutation.isPending`)

Used by the three mutation consumers from §E:

[wizard-results.tsx:227-232](../../kiwi/app/wizard-results.tsx#L227-L232):

```tsx
{!tellKiwiPayload && mutation.isPending && (
  <View style={s.statusBox}>
    <ActivityIndicator size="large" color={KColors.sage[700]} />
    <Text style={s.statusText}>Kiwi is thinking…</Text>
  </View>
)}
```

[tellkiwi.tsx:317-322](../../kiwi/app/tellkiwi.tsx#L317-L322): button label flips to `"Kiwi is thinking…"` with `disabled={mutation.isPending}` plus an inline ActivityIndicator below.

[FindSimilarSheet.tsx:188-192](../../kiwi/components/FindSimilarSheet.tsx#L188-L192): `isLoading = findSimilarMutation.isPending` → renders a loading card with ActivityIndicator + "Kiwi is thinking…" text.

**Common copy:** every loading-state UI says some variant of "Kiwi is thinking…" / "Reading your recipe…" / "Searching…". No shared string source; each screen hardcodes its own.

### §I.3 — Ad-hoc `phase` / `submitting` state machine

[app/import-url.tsx:18-107](../../kiwi/app/import-url.tsx#L18-L107) — `type Phase = "input" | "loading"` with manual transitions in the submit handler. On `phase === "loading"`, renders an entirely separate full-screen view with ActivityIndicator. Mirrored in [import-image.tsx](../../kiwi/app/import-image.tsx) and [import-text.tsx](../../kiwi/app/import-text.tsx).

[app/(auth)/sign-in.tsx:18,61-65](../../kiwi/app/(auth)/sign-in.tsx#L18-L65) — `submitting: boolean` state, conditionally renders `<ActivityIndicator>` in place of the submit button.

### §I.4 — Component-level (`Button.tsx`, `TypeaheadList.tsx`)

[components/Button.tsx:21,62-69](../../kiwi/components/Button.tsx#L21-L69) — `Button` accepts a `loading: boolean` prop that swaps the label for an `ActivityIndicator` colored to match the variant. **Not currently used by any of the §I.3 callsites** (sign-in.tsx renders its own ActivityIndicator wrapper instead of using `<Button loading>`). Worth surfacing in WS7-1 as a candidate for the LoadingShim consolidation.

[components/TypeaheadList.tsx:54-66](../../kiwi/components/TypeaheadList.tsx#L54-L66) — `loading: boolean` prop drives an inline "Searching…" row with small ActivityIndicator. Component-local; the only shared loading-row UI today.

### §I.5 — Grounds for LoadingShim-vs-hook decision

The three patterns above suggest two design axes:

1. **Visual shape:** status box / status card / replace-the-button / inline row. Today each screen picks one ad-hoc.
2. **State source:** mutation-flag / local-useState / phase-state-machine.

A `LoadingShim` component would consolidate axis 1 (visual). A `useLoadingState` (or convention around `useQuery` returns) would consolidate axis 2 (source). Both are valid WS7-1 calls, and they're orthogonal — the design could pick either, neither, or both. The `useQuery` adoption naturally addresses axis 2 (everyone reads `{ data, isLoading, error }` from the same hook shape); LoadingShim is the axis 1 question.

**Existing reusable surface to extend rather than rebuild:** [Button.tsx](../../kiwi/components/Button.tsx)'s `loading` prop (already present, underused) and [TypeaheadList.tsx](../../kiwi/components/TypeaheadList.tsx)'s loading-row pattern (good template for "loading inside a list").

---

## §J — Risks + unknowns

### §J.1 — Seventh apiBase site (lib/api.ts) not in scope description

The task names "6 known locations" (5 per-feature + lib/auth). [lib/api.ts:11-15](../../kiwi/lib/api.ts#L11-L15) is a 7th, also-canonical site hosting `scaleIngredients`. **Consolidating only the 6 listed sites would leave a 7th drift copy behind.** Either:
- Treat lib/api.ts as part of the canonical scope (consolidate alongside).
- Delete `scaleIngredients` (it's currently dead — no consumers grep-found) and remove lib/api.ts's `apiBase` block along with the function.

The latter is the cleaner option but requires Hans confirming `recipes/scale` is genuinely not wired anywhere (prior audit notes "consumer presumed [meal/[id].tsx](../../kiwi/app/meal/[id].tsx) servings stepper (not verified end-to-end this audit)" — the stepper UI exists, but the import chain is the question).

### §J.2 — `lib/api.ts:30-35` is the only site that sends without Authorization

If WS7-1 introduces an `authedFetch` that *requires* a token, dropping into that wrapper from `scaleIngredients` breaks the optional-auth path silently (server-side scale endpoint might or might not require auth — needs server-side check). If `scaleIngredients` is kept, the wrapper needs an `authedFetch({ requireAuth: false })` or `optionalAuth` variant.

### §J.3 — Grocery POST contract divergence is intentional, not drift

The discriminated-union `GenerateGroceryListResult` at [lib/api/grocery.ts:30-36](../../kiwi/lib/api/grocery.ts#L30-L36) is a UX-driven design (Plan Review needs to type-narrow on the failure reason to route the user correctly). Consolidating it into the throw-Error pattern would lose type safety on the failure branches. WS7-1 should explicitly preserve or replace this with an equivalent typed return — don't reflexively flatten.

### §J.4 — recipeImport's typed-envelope passthrough is a different intentional shape

Similarly, [lib/api/recipeImport.ts](../../kiwi/lib/api/recipeImport.ts)'s `{ success, reason, userFacingMessage, suggestedAction }` is the server's contract surfaced verbatim. The `userFacingMessage` field is a real product-spec field (per the prompt schemas under `artifacts/api-server/src/lib/ai/schemas/reformat.ts` per the comment at [recipeImport.ts:24](../../kiwi/lib/api/recipeImport.ts#L24)). The consolidated pattern needs to handle this — likely by adopting the typed-envelope as the canonical shape rather than throw-Error.

### §J.5 — Token reads are not coordinated with React Query

Currently, every API call does its own `await readToken()`. If WS7-1 introduces a `useAuthMe`/`useAuthToken` hook that holds the token in cache, the per-call readToken becomes an extra SecureStore hit per request. Two paths:
- Keep `readToken()` as the source of truth (cheapest fix; SecureStore reads are fast).
- Pass token in via React context (synced from useQuery cache); helpers take an explicit `token` arg.

The second is more refactor-heavy but eliminates a per-call async operation and makes 401-bounce centralization easier.

### §J.6 — AppContext loads before AuthContext finishes bootstrapping

Provider nesting at [_layout.tsx:74-75](../../kiwi/app/_layout.tsx#L74-L75): `AuthProvider > AppProvider`. AppProvider can call `useAuth()` synchronously, but `isLoading=true` means `token` is null and `user` is null during the first render. Any AppProvider-internal fetches gated on `user` will not fire until `isLoading` flips false. Verified at [AuthContext.tsx:163-167](../../kiwi/contexts/AuthContext.tsx#L163-L167) — `patchUiState` is debounced + null-token-checked. ✅ no race, but worth flagging as a constraint for any new AuthContext-dependent hooks WS7-1 introduces.

### §J.7 — `mutation.reset()` idiom won't translate to useQuery cleanly

[wizard-results.tsx:86-87](../../kiwi/app/wizard-results.tsx#L86-L87) does `mutation.reset(); mutation.mutate(wizardInput);` in an effect, plus an `attempt` counter to force re-fires. The useQuery equivalent for re-fetch is `refetch()` — different API, different mental model. If WS7-1 documents useQuery conventions, calling out that mutations and queries diverge here will help future engineers not pattern-match wrong.

### §J.8 — No global error boundary for query/mutation failures

[components/ErrorBoundary.tsx](../../kiwi/components/ErrorBoundary.tsx) catches render errors but not query/mutation rejections. React Query has a `QueryCache({ onError })` hook that fires for all queries; ditto `MutationCache({ onError })`. Today neither is configured ([_layout.tsx:23](../../kiwi/app/_layout.tsx#L23) just news a default `QueryClient`). The global 401 interceptor in §F.3 / §G.6 would naturally live here.

### §J.9 — `EXPO_PUBLIC_DOMAIN` is the only working env in dev today

Per [package.json:7](../../kiwi/package.json#L7), `pnpm dev` exports `EXPO_PUBLIC_DOMAIN=$REPLIT_DEV_DOMAIN`. **It does NOT export `EXPO_PUBLIC_API_BASE_URL`**. So today, lib/auth.ts's "footgun" (§A.2) **actively fires in the dev environment** — every dev session, auth calls go to `localhost:3000/api` (likely fine since the api-server runs there) while every other call goes to the Replit domain. If api-server is also bound to Replit-domain via reverse proxy in dev, there might be a working-by-accident asymmetry. Worth surfacing for D-WS7-003 cross-check (chat-Claude can confirm what D-WS7-003 says about this).

---

## §K — Out-of-scope drift surfaced

Candidate deferrals for chat-Claude to assess. Audit does not assign IDs.

### §K.1 — Candidate: `lib/api.ts:scaleIngredients` is a dead export

**Owner suggestion:** WS7 cleanup or pre-WS7-1 hygiene.
**Justification:** Grep `scaleIngredients` returns only the declaration in [lib/api.ts:22](../../kiwi/lib/api.ts#L22). No consumers. The function existed for the meal/servings stepper but never got wired (prior audit also flagged this with `WIRED_REAL (suspected)` / `UNKNOWN` smoke status). Leaving it in place forces WS7-1 to decide between consolidating the 7th apiBase site (effort) or deleting the dead function (cleaner). If chat-Claude confirms scaleIngredients is genuinely unused, deleting it lets the audit shrink the apiBase consolidation to 6 sites with one clean snip.
**Next-available ID hint:** D-WS7-016 or later, per task description.

### §K.2 — Candidate: Button.tsx `loading` prop is underused

**Owner suggestion:** WS7-1 implementation phase or WS7-N polish.
**Justification:** [components/Button.tsx:21,62-69](../../kiwi/components/Button.tsx#L21-L69) supports `loading: boolean` which renders an ActivityIndicator in place of the label, but [(auth)/sign-in.tsx:61-67](../../kiwi/app/(auth)/sign-in.tsx#L61-L67) hand-rolls its own ActivityIndicator wrapper rather than passing `loading` to Button. Same pattern in (auth)/sign-up. Consolidating these to `<Button label="Sign in" onPress={...} loading={submitting} />` would remove ~10 lines per screen and unify the visual idiom. Small but easy WS7-1 win that also de-risks the LoadingShim discussion (axis 1, §I.5).

### §K.3 — Candidate: `EXPO_PUBLIC_DOMAIN` vs `EXPO_PUBLIC_API_BASE_URL` env-var convention is undocumented

**Owner suggestion:** WS7 cleanup or docs.
**Justification:** Six of seven apiBase sites accept either env var. Nothing in [package.json](../../kiwi/package.json), [app.json](../../kiwi/app.json), or any visible README documents which takes precedence, which is preferred for dev/staging/prod, or that the seventh site ([lib/auth.ts:23](../../kiwi/lib/auth.ts#L23)) only reads one of them. The consolidation in WS7-1 should land with a one-liner comment in the consolidated module documenting the precedence rule and which env to set per environment.

### §K.4 — Candidate: prior-audit's D-WS7-006 framing may need refresh after this audit

**Owner suggestion:** chat-Claude review.
**Justification:** The task description references "the existing 401 handling at `:61-75` per D-WS7-006." Per §D.3 / §F.3 above, the only 401 handling at AuthContext.tsx:51-82 is the **bootstrap-time** `fetchMe → null → clearToken()` flow. There is no mid-session 401 handling there. If D-WS7-006 names a richer 401 cascade that doesn't yet exist in the repo, this audit confirms the gap — but it might also suggest that the deferral's framing predates a code change that removed mid-session handling. Chat-Claude is positioned to reconcile.

### §K.5 — Candidate: `lib/api.ts` author comment and `lib/auth.ts` author comment both promise WS7 consolidation

**Owner suggestion:** WS7-1.
**Justification:** Two separate `// WS7` consolidation notes exist:
- [lib/auth.ts:21](../../kiwi/lib/auth.ts#L21): `// API base URL (duplicated from lib/api.ts for now; consolidate in WS7) ─`
- [lib/api.ts:5](../../kiwi/lib/api.ts#L5): `// Per-feature API modules now live under ./api/. This file remains for stand-alone helpers that don't fit a feature module.`

Both annotations are honest about the duplication. WS7-1 closing should remove both annotations (or the entire `lib/api.ts` file per §K.1) so the comments don't lie post-consolidation.

---

## Synthesis

WS7-1 is a small refactor with a large coordinating role. The technical surface — 7 apiBase strings, 7 token reads, 7 Authorization headers, a fragmented error contract — is mechanically simple to consolidate; a single `lib/api/base.ts` exporting `apiBase`, `authedFetch`, and `requireToken` removes most of the drift in a focused PR. The harder questions are the contract decisions: keep grocery POST's discriminated-union or flatten? Preserve recipeImport's typed-envelope or normalize to throw-Error? Add a global 401 interceptor at the React Query layer or inside `authedFetch`? Each choice cascades through the seven sites differently. The React Query side is in a rare zero-existing-precedent state — three thin `useMutation` wrappers, zero `useQuery` callers, no `QueryClient` configuration — which makes `useAuthMe` an ideal first establishing migration: the bootstrap useEffect is the only auth-gated cold-start read, the existing `fetchMe(token)` function is already a clean `queryFn`, and the migration shape (`useQuery` with `enabled: !!token`, `data === null` on 401, `clearQueries` on logout) establishes the convention for the WS7-2-onward read endpoints to follow. The routing layer is small and clean — three files, one `isAuthenticated` signal — so a global 401-bounce can land in WS7-1 by adding a single `bounceOn401` action to AuthContext that the new `authedFetch` triggers. Phase 1 design needs to decide (a) seventh-apiBase-site disposition (consolidate vs delete-scaleIngredients), (b) which error-shape becomes canonical and how to preserve the two intentional exceptions, and (c) whether `useQuery` conventions establish a shared `LoadingShim` or stay with per-screen idioms. Everything else falls out of those three.
