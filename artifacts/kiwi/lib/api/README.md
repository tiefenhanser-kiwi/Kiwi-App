# Mobile API client (`lib/api/`)

The `apiClient` wrapper consolidates the network plumbing for the mobile app:
single `apiBase`, single bearer-token plumbing, typed error classes, optional
Zod validation, a 401 cascade that flips AuthContext to the welcome screen.

## TL;DR

```ts
import { apiClient } from "@/lib/api/client";
import { z } from "zod";

const PlanSchema = z.object({ id: z.string(), title: z.string() });

// Throw mode (default) — returns Promise<T>
const plan = await apiClient(`/plans/${id}`, { schema: PlanSchema });

// Envelope mode — never throws on HTTP errors
const res = await apiClient(`/plans/${id}/generate`, {
  method: "POST",
  schema: ResultSchema,
  errorMode: "envelope",
});
if (res.success) {
  // res.data is T
} else {
  // res.error is one of: ApiError, UnauthenticatedError,
  // UpgradeRequiredError, ApiNetworkError, ApiSchemaError
}
```

## Path convention

`apiBase` already includes `/api`, so endpoint paths look like:

- ✅ `apiClient("/auth/me")` — leading slash required
- ❌ `apiClient("auth/me")` — throws `Error: apiClient: path must start with "/"`
- ❌ `apiClient("/api/auth/me")` — double-prefixes; will 404

## `apiBase` resolution

Single source: [base.ts](./base.ts). Precedence:

1. `EXPO_PUBLIC_API_BASE_URL` — explicit absolute URL (CI / staging / prod)
2. `EXPO_PUBLIC_DOMAIN` — bare host, wrapped as `https://<DOMAIN>/api` (Replit dev)
3. `http://localhost:3000/api` — local-dev fallback

Falsy-OR chain, not nullish-coalescing — empty-string env values fall through.

## Errors

Five typed classes in [errors.ts](./errors.ts):

| Class                    | When thrown                                              |
| ------------------------ | -------------------------------------------------------- |
| `UnauthenticatedError`   | 401 from server, or `readToken()` returned null + `auth: true` |
| `UpgradeRequiredError`   | 402 from server                                          |
| `ApiError` (base)        | All other 4xx / 5xx                                      |
| `ApiNetworkError`        | `fetch` itself rejected (offline, DNS, TLS, abort)       |
| `ApiSchemaError`         | Response body failed `opts.schema.safeParse()`           |

`userFacingMessage` extraction precedence (parsed from the JSON body):

1. `body.userFacingMessage`
2. `body.error`
3. `body.message`
4. `undefined`

All five classes carry the parsed `body` and `status` (where applicable) on
their fields — consumers can branch on `err.status === 409` without re-reading
the response.

## 401 cascade

`apiClient` calls `emitSessionExpired()` from [auth-bridge.ts](./auth-bridge.ts)
on every 401 (and on missing-token-with-auth-required). AuthContext subscribes
in [contexts/AuthContext.tsx](../../contexts/AuthContext.tsx):

1. `clearToken()` — wipes SecureStore
2. `queryClient.removeQueries({ queryKey: ["auth"] })` — drops cached me/etc.
3. `setToken(null)` — flips `isAuthenticated` false
4. `setError("Your session expired. Please sign in again.")` — surfaced to UI
5. `resetCascade()` — re-arms the in-flight flag

The cascade is de-duplicated by an in-flight flag inside `auth-bridge` — many
concurrent 401s only fire one cascade.

**Bootstrap-time 401s fire the cascade too**: if the user has a stored-but-
expired token, cold-start `/auth/me` 401 → cascade → `"Your session expired."`
message. This is the intentional replacement for the pre-WS7-1 silent-redirect.

402 does **not** fire the cascade — it's a per-call upgrade signal, consumers
catch `UpgradeRequiredError` (or check `err instanceof UpgradeRequiredError`
in envelope mode) and route to the upgrade modal.

## React Query conventions

### Query keys

```ts
[<domain>, <resource>, ...(scope-narrowing args)]
```

Examples:

- `["auth", "me"]` — the authenticated user
- `["plans", "list", filters]` — plans tab listing
- `["plans", "detail", planId]` — single plan
- `["wizard", "candidates", inputHash]` — generated plan candidates
- `["catalog", "cuisines"]` — static-ish reference data

Cascade & logout drop the entire `["auth"]` prefix in one `removeQueries` call —
keep auth-related keys under `["auth", ...]` so the prefix-match works.

### `staleTime` tiers

| Tier             | `staleTime`      | Examples                                 |
| ---------------- | ---------------- | ---------------------------------------- |
| auth             | `Infinity`       | `["auth", "me"]`                         |
| catalog          | `5 * 60_000`     | Cuisines, eating styles, allergens       |
| personal-mutable | `60_000`         | Plans list, meals list                   |
| hot-volatile     | `0`              | Wizard candidates, AI-generated previews |

Global default in [`app/_layout.tsx`](../../app/_layout.tsx): `60_000` — matches
the personal tier. Per-query overrides land alongside the hook (see
[`useAuthMe`](./auth.ts) for `Infinity`).

### Global defaults

The shared `QueryClient` ships with:

- `refetchOnWindowFocus: false` — mobile rarely benefits, drains battery.
- `retry: false` — backend errors should surface immediately; opt back in per
  query if the endpoint is known-flaky.
- `staleTime: 60_000` — personal-mutable default.

## Environment variables

| Var                        | Purpose                                           | Where set       |
| -------------------------- | ------------------------------------------------- | --------------- |
| `EXPO_PUBLIC_API_BASE_URL` | Explicit absolute base URL (highest precedence)   | CI / prod env   |
| `EXPO_PUBLIC_DOMAIN`       | Bare host; wrapper appends `https://` + `/api`    | `pnpm dev` (Replit) — `package.json:7` |

If neither is set, the wrapper targets `http://localhost:3000/api`. The
historical `lib/auth.ts` "footgun" (only reading `EXPO_PUBLIC_API_BASE_URL`
with `??` rather than `||`) was removed in WS7-1 Commit 3.

## Per-module patterns

| File             | Mode                                | Schema                          |
| ---------------- | ----------------------------------- | ------------------------------- |
| `lib/auth.ts`    | throw                               | `LoginResponse`, `SignupResponse`, `MeResponse` |
| `api/wizard.ts`  | throw                               | `BuildWizardPlansResponse`      |
| `api/tellKiwi.ts`| throw                               | `BuildFromTextResponse`         |
| `api/meals.ts`   | throw                               | `FindSimilarResponse`           |
| `api/grocery.ts` | envelope (POST), throw (GET / add)  | `GenerateGroceryListSuccess`, `GetGroceryListResponse`, `LookupResponse`, `AddItemResponse` |
| `api/recipeImport.ts` | envelope                        | `ImportEnvelope` (discriminated union over `success`) |

Universal Zod adoption per WS7-1 Decision 4: every wrapper call site passes
`opts.schema`. Drift between mobile schemas and server schemas surfaces as
`ApiSchemaError` at runtime.

## When NOT to use `apiClient`

- Calling something that isn't the Kiwi API server (3rd-party APIs, asset
  downloads). Use `fetch` directly with explicit headers.
- Streaming responses, multipart uploads. Wrapper doesn't support these yet —
  if you need them, extend the wrapper rather than working around it.
