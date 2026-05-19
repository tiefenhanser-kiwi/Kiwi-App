# WS7-1 — Phase 3 implementation report

**Run:** 2026-05-19
**Branch:** `main` (17 commits ahead of `origin/main`)
**Head:** `4066e5c` ([WS7-1 Commit 9] test(mobile-api): wrapper + auth-bridge + base + schemas)
**Working tree:** clean
**Next-available D-WS7 ID:** D-WS7-018 (no new deferrals filed below)

---

## Commit-by-commit changes

| # | SHA | Title | Files |
|---|---|---|---|
| 1 | `26c8253` | feat(mobile-api): apiClient wrapper + base + errors + auth-bridge | `lib/api/base.ts`, `lib/api/client.ts`, `lib/api/errors.ts`, `lib/api/auth-bridge.ts` (4 new, 411 inserts) |
| 2 | `0d1701f` | feat(auth): AuthContext subscribes to 401 cascade + QueryClient defaults | `contexts/AuthContext.tsx`, `app/_layout.tsx` (35 inserts / 1 delete) |
| 3 | `53102f2` | refactor(mobile-api): migrate lib/auth.ts to apiClient + first Zod schemas | `lib/auth.ts`, `contexts/AuthContext.tsx` (93/65) |
| 4 | `aa5cc91` | refactor(mobile-api): migrate 5 per-feature modules to apiClient + author Zod schemas | `lib/api/wizard.ts`, `tellKiwi.ts`, `meals.ts`, `grocery.ts`, `recipeImport.ts` (455/424) |
| 5 | `b870ce5` | refactor(mobile-api): delete lib/api.ts + scaleIngredients | `lib/api.ts` deleted (50 deletes) |
| 6 | `06c8bbb` | feat(auth): useAuthMe + AuthContext bootstrap via React Query | `lib/api/auth.ts` (new), `contexts/AuthContext.tsx` (79/57) |
| 7 | `a72d15c` | feat(ui): LoadingShim + migrate 3 mutation consumers | `components/LoadingShim.tsx` (new), `app/wizard-results.tsx`, `app/tellkiwi.tsx`, `components/FindSimilarSheet.tsx` (104/13) |
| 8 | `956b780` | docs(mobile-api): lib/api/README.md | `lib/api/README.md` (168 inserts) |
| 9 | `4066e5c` | test(mobile-api): wrapper + auth-bridge + base + schemas | 8 test files under `lib/api/__tests__/` + `package.json`/`tsconfig.json` updates (685/1) |

Files now living in the mobile codebase that didn't exist before WS7-1:

- `lib/api/base.ts` — single apiBase source.
- `lib/api/client.ts` — `apiClient<T>()` wrapper (throw + envelope overloads).
- `lib/api/errors.ts` — five typed error classes + extractUserFacingMessage.
- `lib/api/auth-bridge.ts` — pub/sub for the 401 cascade.
- `lib/api/auth.ts` — `useAuthMe(token)` hook.
- `lib/api/README.md` — canonical reference for wrapper + React Query conventions.
- `components/LoadingShim.tsx` — shared loading-state component (3 variants).
- 8 files under `lib/api/__tests__/`.

Files deleted: `lib/api.ts` (the 7th apiBase site + dead `scaleIngredients`).

---

## Test count delta

**Target (Phase 1 §10 + §11):** ~25-28 mobile tests; 0 server-side test changes.
**Actual:** 43 mobile tests, 0 server-side changes (337 baseline preserved).

Per-file breakdown:
- `errors.test.ts` — 10
- `auth-bridge.test.ts` — 5
- `base.test.ts` — 4
- `client.test.ts` — 18
- `auth-schemas.test.ts` — 6
- Total — 43 mobile tests; all pass.

The over-target is mostly client.test.ts (18 vs. an implicit ~10 target). The
wrapper has a lot of branches (throw vs envelope × status-code branches ×
parseAs × auth-required vs auth-optional × schema present/absent) so the
breadth fell out naturally rather than from goal-creep.

Tests not authored:
- **AuthContext-end-to-end render tests** were out of scope for what node --test
  + native TS support can reach cleanly (no React renderer available; would
  need react-test-renderer or @testing-library/react-native, which means
  bringing in jsdom + a heavy dep tree). The cascade subscription is exercised
  indirectly via auth-bridge tests + the client tests that verify cascade
  firing; AuthContext's cascade-handler logic itself remains untested as a
  unit. Filed informally below.

---

## Smoke results

**Type-check + automated tests are all that were verifiable from this dev environment** — Expo Go / device runs require local-machine driving that this session can't perform.

Concretely verified:
- `pnpm --filter kiwi exec tsc -p tsconfig.json --noEmit` → **clean** at every commit boundary that touched mobile code (1, 2, 3, 4, 5, 6, 7, 9).
- `pnpm --filter @workspace/api-server exec tsc -p tsconfig.json --noEmit` → **clean** end-of-phase.
- `pnpm --filter kiwi test` → **43 / 43 pass, 0 fail**.
- `pnpm --filter @workspace/api-server test` → **335 pass / 2 skipped / 0 fail** (matches the 337 baseline; skipped tests were skipped pre-WS7-1).

Not verified (called out per the brief's smoke instructions):
- **Commit 3 smoke** — Expo Go signup/login/cold-start with a valid stored token routing to (tabs), kill+reopen persistence. Not runnable from here.
- **Commit 6 smoke** — Expo Go cold-start storage-read race; bootstrap-time 401 cascade producing "Your session expired…" on welcome screen. Not runnable from here.
- **Commit 7 visual smoke** — LoadingShim visual parity in the three migrated consumers. Not runnable from here.

The wrapper's behavior under these flows IS unit-tested (commit 9 covers
missing-token + 401 + cascade firing + envelope mode interactions), but the
device-loop confirmation of the end-to-end UX is owed before WS7-1 closes
fully. Hans's call on whether to drive these before / after WS7-2 kicks off.

---

## Decisions made during execution that weren't in the prompt

1. **`logoutRequest` swallows wrapper throws (incl. 401) with `try/catch` rather than asking the wrapper not to fire the cascade.** The Phase 1 design's "client always wins on logout" landed as: logoutRequest's `try { … } catch { /* ignore */ }`. If the server returns 401 mid-logout, the cascade fires AND AuthContext.logout's own `setError(null)` runs after the cascade's microtask — by then setError(null) is the final state. The race is benign. Documented in lib/auth.ts:`logoutRequest`'s comment.

2. **Mobile schemas are transcribed rather than imported from `@workspace/api-server`.** Audit / Phase 1 design says "prefer reuse" — but the mobile package doesn't depend on the api-server package (and adding such a dep would pull in Prisma + express + bcrypt etc. into the mobile graph). Schemas are mirrored mobile-side with `.passthrough()` for forward-compat; drift surfaces as `ApiSchemaError` at runtime. The mirror is one-directional from server → mobile and lives next to each module's wire interfaces (commit 4 commit message documents this).

3. **`recipeImport.ts`'s failure `reason` schema is widened to `z.string()`** rather than the enum the wire types currently spell out. Audit flagged the wire interface as "broad and partial"; the server route has different `reason` enums per endpoint (url vs image vs text) and may grow. Widening + casting back at the consumer-facing union boundary keeps the schema future-proof. Tagged in-file with a comment.

4. **`lib/api/client.ts` does NOT include the bearer token in the `body` for `Content-Type` setting** — it only adds Content-Type when the body is an object (sent JSON-stringified). Strings are passed through with caller-controlled Content-Type. This was implicit in the design; calling it out because two prior modules used `Content-Type: "application/json"` for GET requests with no body. The wrapper drops the redundant header.

5. **Test infrastructure uses `--experimental-strip-types` (Node 25) rather than `tsx`** so the mobile package didn't grow a new devDependency. A custom `_loader.mjs` handles `expo-secure-store` / `expo-image-manipulator` stubbing, the `@/*` tsconfig path alias, and extensionless relative-TS imports. Test files in `lib/api/__tests__/` excluded from the Expo typecheck path since node:test types aren't in the dep graph.

6. **Cascade handler's `removeQueries` widened from `["auth", "me"]` to `["auth"]`** between commits 2 and 6. Commit 2 used the narrow form (only the one cached query that existed); commit 6 introduced the prefix-broadening to match the spec's `logout` behavior and any future `["auth", ...]` queries WS7-N adds. Both commit messages mention this.

7. **`lib/auth.ts`'s `clearError` and `setError(null)` interplay with the cascade in the logout path** — I worked through the microtask ordering to confirm `setError(null)` lands after the cascade's `setError("Your session expired…")` due to the await-yields-to-microtask sequence. No code added for this; verified by reading the React Query + RN scheduler semantics. Documented in passing in the commit 3 message.

8. **`setUiState` in the new AuthContext writes to the React Query cache via `queryClient.setQueryData(["auth", "me"], (prev) => …)`** rather than calling `setUser(...)` directly (the setter doesn't exist anymore — user comes from `meQuery.data`). PRD §4.2.5's optimistic-UI semantics preserved: the cache update is synchronous; the debounced PATCH still fires 400ms later.

None of the above contradicts the locked design — they're surface-level execution choices that the design left open.

---

## New deferrals

**None filed.** Phase 2 implementation landed within the design constraints. The one item worth flagging informally:

- **AuthContext-render unit tests** — see "Tests not authored" above. Not filed as a deferral because the cascade + bootstrap-via-useQuery logic is covered indirectly by the auth-bridge + client tests. If WS7-2+ needs render-level confidence, the lift is: add @testing-library/react-native or react-test-renderer to mobile devDeps, write the missing tests. Estimated 4-6 tests covering bootstrap → 401-cascade-cleanup, login seeds cache, logout removes queries, setUiState writes cache. Hans's call.

The next-available D-WS7 ID remains **D-WS7-018**.

---

## D-WS7 deferrals status updates

Per the brief:

- **D-WS7-003** (apiBase + token consolidation) — the wrapper + `lib/api/base.ts` exist and all seven historical sites are migrated (or deleted, for `lib/api.ts`). **Addressed by WS7-1**; chat-Claude flips to RESOLVED at close.
- **D-WS7-006** (401 cascade) — `auth-bridge.ts` + AuthContext subscription + `apiClient` emit-on-401 wire it end-to-end. Bootstrap-time and mid-session 401s both fire the same handler. **Addressed by WS7-1**; chat-Claude flips to RESOLVED at close.
- **D-WS7-016** (Button.loading underuse) — addressed by establishing the `LoadingShim` convention. sign-in.tsx itself NOT migrated (per Phase 1 §9 footnote). Chat-Claude logs as RESOLVED at WS7-1 close per the brief.
- **D-WS7-017** (two `// WS7` consolidation annotations in lib/auth.ts + lib/api.ts) — both annotations are gone with the lib/api.ts deletion + lib/auth.ts rewrite. Chat-Claude logs as RESOLVED at WS7-1 close per the brief.

---

## Working tree state at close

```
$ git status
On branch main
Your branch is ahead of 'origin/main' by 17 commits.
nothing to commit, working tree clean

$ git log --oneline -12
4066e5c [WS7-1 Commit 9] test(mobile-api): wrapper + auth-bridge + base + schemas
956b780 [WS7-1 Commit 8] docs(mobile-api): lib/api/README.md
a72d15c [WS7-1 Commit 7] feat(ui): LoadingShim + migrate 3 mutation consumers
06c8bbb [WS7-1 Commit 6] feat(auth): useAuthMe + AuthContext bootstrap via React Query
b870ce5 [WS7-1 Commit 5] refactor(mobile-api): delete lib/api.ts + scaleIngredients
aa5cc91 [WS7-1 Commit 4] refactor(mobile-api): migrate 5 per-feature modules to apiClient + author Zod schemas
53102f2 [WS7-1 Commit 3] refactor(mobile-api): migrate lib/auth.ts to apiClient + first Zod schemas
0d1701f [WS7-1 Commit 2] feat(auth): AuthContext subscribes to 401 cascade + QueryClient defaults
26c8253 [WS7-1 Commit 1] feat(mobile-api): apiClient wrapper + base + errors + auth-bridge
e8a19d4 [WS7-1-PRE] Add WS7-1 mobile API client audit report
524baea [WS7-PRE Fix 5b] D-WS7-013 6b-5 smoke Case 1 cuisine fixture update
219f814 [WS7-PRE Fix 5a] D-WS7-014 mode_a_parse caveats prompt-body strengthening + re-seed
```

Local-only — Hans handles the push when ready.
