# Kiwi — Mobile Meal Planning App

Mobile-first meal planning app built with Expo + Expo Router, designed to ship to iOS and Android. Currently runs in Replit as an Expo Go web preview while we iterate on UX; the same codebase publishes to native via Expo's build pipeline.

## Stack

- **Mobile shell:** Expo SDK 54, expo-router (typed routes), React Native 0.81, React 19, React Compiler enabled.
- **Auth:** Clerk (`@clerk/expo`) wired through `ClerkProvider` in `app/_layout.tsx` with email + password verification flow.
- **State:** React Context (`contexts/AppContext.tsx`) backed by AsyncStorage (`lib/storage.ts`, `kiwi:` key prefix).
- **Design system:** `constants/tokens.ts` defines the locked sage + terracotta palette, spacing, radius, shadows, type scale, and brand copy (Compost / Build / Kiwi is thinking).
- **Components:** `components/Button`, `Card`, `Chip`, `MealCard`, `Header`, `Screen`, plus the existing `ErrorBoundary` and `KeyboardAwareScrollViewCompat`.
- **Fonts:** Inter (400/500/600/700) via `@expo-google-fonts/inter`.
- **Backend artifact:** `artifacts/api-server` (Fastify) is reserved for the eventual `/api/plans/*`, `/api/groceries/*`, `/api/cook/*`, and Clerk-proxy endpoints once API keys arrive.

## Screen map

```
app/
├── _layout.tsx                 ClerkProvider + AppProvider + Stack
├── index.tsx                   Auth/onboarding router redirect
├── (auth)/
│   ├── _layout.tsx             Redirects to /(tabs) when signed in
│   ├── welcome.tsx             Sage hero with brand pillars
│   ├── sign-in.tsx             Email + password
│   └── sign-up.tsx             Email + password + email-code verify
├── onboarding-prefs.tsx        Household, diet, allergies, cuisines, skill
├── (tabs)/
│   ├── _layout.tsx             4 tabs (Feather icons)
│   ├── index.tsx               This Week — tonight's dinner + queue
│   ├── plans.tsx               Wizard / Tell Kiwi entry + saved plans
│   ├── groceries.tsx           Grouped list w/ pantry toggle + retailer CTA
│   └── profile.tsx             Account, prefs, sign-out, upgrade
├── wizard.tsx                  Kitchen Wizard form
├── tellkiwi.tsx                Free-text plan request + suggestions
├── plan-results.tsx            Generated plan preview
├── recipe/[id].tsx             Recipe detail w/ macros, ingredients, steps
├── cookmode/[id].tsx           Full-screen step-by-step cook mode
└── upgrade.tsx                 Premium upsell (sets local flag for now)
```

## Recipe library

`lib/mockData.ts` ships with **12 richly-detailed seed recipes** (grain bowl, salmon, stir-fry, beef tacos, mushroom pasta, lentil stew, teriyaki tofu, margherita pizza, chickpea curry, buddha bowl, shrimp scampi, Greek salad) each with full ingredient lists, step-by-step instructions, and AI-generated photos in `assets/images/`. The catalog is also mirrored server-side in `artifacts/api-server/src/lib/recipeCatalog.ts` as the authoritative source for AI plan generation.

## AI plan generation (live)

- **`POST /api/plans/generate`** in the api-server calls `claude-sonnet-4-6` via Replit AI Integrations for Anthropic (no user key required, billed against Replit credits).
- Server owns the recipe catalog — clients cannot inject IDs. Output is strictly normalized (valid days/slots/IDs, exact night count).
- Per-IP token-bucket rate limiter at `lib/rateLimit.ts` (8 burst, ~1/7.5s sustained) guards the LLM endpoint against cost abuse.
- Falls back to a deterministic plan if Anthropic is unavailable or the response can't be parsed.
- `wizard.tsx` (multi-step: nights → time → style → notes) and `tellkiwi.tsx` (free-text prompt with suggestion chips) both call `lib/api.ts` → `generatePlan()`.

## Other Kiwi features now live

- **Pantry screen** (`app/pantry.tsx`, linked from Profile) — add/remove items, quick-add chips, pantry items get sent to AI to bias recipe choices and pre-checked on grocery lists.
- **Meal swap** (`components/SwapSheet.tsx`) — bottom-sheet on plan-results lets users replace any meal in the current plan; grocery list auto-rebuilds.
- **Cook-mode timers** (`lib/cookTimer.ts`) — auto-detects durations like "Simmer for 15 minutes" from step text and shows a play/pause/reset timer with success haptic when complete.

## Pending integrations

These flows have hooks in the UI but use stubs until keys are provisioned:

- **Stripe / RevenueCat** — `upgrade.tsx` flips a local `isPremium` flag instead of charging.
- **Instacart / Whole Foods** — `groceries.tsx` "Send to Instacart" shows an alert. Adapter contracts are in `attached_assets/adapters_*.ts`.
- **Twilio / Resend / Unsplash** — not yet referenced in app code.

## Environment

- `CLERK_PUBLISHABLE_KEY` is provisioned and forwarded to Metro as `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY` via the `dev` script and `scripts/build.js`.
- `EXPO_PUBLIC_CLERK_PROXY_URL` is forwarded for production builds (currently unset).
- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` + `AI_INTEGRATIONS_ANTHROPIC_API_KEY` set automatically by Replit AI Integrations — used only by the api-server.

## Locked references

`attached_assets/` holds Claude's locked specs (24-screen prototype, Prisma schema, design tokens, retailer adapters, Stripe integration spec, types). Treat these as read-only source-of-truth for future build-out.

## Workflows

- `artifacts/kiwi: expo` — Expo dev server on port 23406, Web preview reachable through `$REPLIT_EXPO_DEV_DOMAIN`.
- `artifacts/api-server: API Server` — Express on 8080. Routes: `/api/healthz`, `/api/plans/generate`.
- `artifacts/mockup-sandbox` — Vite preview (template; not used by Kiwi).
