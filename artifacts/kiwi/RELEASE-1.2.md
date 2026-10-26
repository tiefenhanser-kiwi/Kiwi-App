# Kiwi 1.2: build and submit checklist

For Hans. Nothing here has been run. Submit both platforms by **Sat Oct 31**.

1.2 carries only what needs a new binary, plus dormant native modules so later
features can ship by update. Everything else keeps shipping by `eas update`.

| Item | In the 1.2 binary | Live in 1.2? |
|---|---|---|
| A. BUG-525 | `updates.fallbackToCacheTimeout` 5000; the foreground update check + "Kiwi updated — tap to restart" line (JS, also reaches 1.1 via release/1.1) | yes |
| B. Crash reporting | `@sentry/react-native` 7.2.0 + its plugin; metro debug ids; Crash Data in the privacy manifest | off until `EXPO_PUBLIC_SENTRY_DSN` is set (an update can turn it on) |
| C. Store review prompt | `expo-store-review` 9.0.9 | yes |
| D. Play symbols warning | pending: waiting on the exact Play Console text | — |
| E. Push-ready | `android.googleServicesFile`; iOS already has `aps-environment` | dormant: no prompt, no token |
| F. Shop Your Store | `expo-web-browser` 15.0.11 | dormant: used nowhere (D-WS9-325) |
| G. Runtime | `version` 1.2.0, so runtime 1.2.0 | — |

## 1. Before the build

**Firebase (E). Required: the build fails without the file.**
1. In the Firebase console, create a project, then add an Android app with package `com.kitchenwizard.kiwi`.
2. Download `google-services.json` and save it to `artifacts/kiwi/google-services.json`.
3. Commit it with `git add artifacts/kiwi/google-services.json`. It is not secret. `lib/__tests__/pushReady.test.ts` checks its package name once it exists.
4. The FCM v1 service-account key goes up with `eas credentials -p android` (Google Service Account → FCM V1). It can wait for the server half; the binary doesn't need it.

**Sentry (B). Optional before the build: the binary works without it.**
1. Create a Sentry org and a React Native project.
2. In Sentry project settings, turn on **Prevent Storing of IP Addresses** and keep the server-side data scrubber on.
3. Set these EAS environment variables (dashboard → Environment variables):
   - `EXPO_PUBLIC_SENTRY_DSN`: plaintext, in production and preview. Empty or absent means crash reporting stays off. Since it's read when the bundle is built, setting it later and running `ota-update.ps1` turns Sentry on for 1.2 phones, no new binary needed.
   - `SENTRY_ORG`, `SENTRY_PROJECT`: plaintext.
   - `SENTRY_AUTH_TOKEN`: secret.
4. Once the token is set, delete `"SENTRY_DISABLE_AUTO_UPLOAD": "true"` from `eas.json` → `build.production.env` and commit. `eas.json` env beats EAS env, and while that line is there the build uploads no source maps. Without a token, the line has to stay: the Sentry plugin's iOS bundle phase fails the build otherwise.
5. For `ota-update.ps1` uploads, put `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` and `SENTRY_PROJECT` in the shell. With no token in the shell the upload is skipped. A token without org and project is refused at step 3.

**Store privacy answers (B)**
- App Store Connect → App Privacy: Diagnostics → **Crash Data**, linked to the user (the id is hashed but still linkable), used for App Functionality, not used for tracking. This matches the privacy manifest in `app.json`.
- Play Console → Data safety: **Crash logs** collected, not shared, encrypted in transit.
- Privacy page: chat-Claude is adding Sentry.

## 2. Branches (G)

The 1.1 binaries (`216b2a0`; Android vc5, iOS build 8) keep receiving updates from **release/1.1**, never from next. Next's 1.2 JS imports modules the 1.1 binary lacks.

```powershell
git branch release/1.1 bb75d2d1        # the commit before any 1.2 native change; carries A's JS half
git push origin release/1.1
git push origin next
git worktree add "..\Kiwi-App-1.1" release/1.1
cd "..\Kiwi-App-1.1"; pnpm install --frozen-lockfile
```

- **A 1.1.0 update:**
  1. In the worktree, `git cherry-pick <sha>`; JS-only commits only.
  2. `git push origin release/1.1`.
  3. Run `.\scripts\release\ota-update.ps1 -Runtime 1.1.0 -Platform <p> -ConfirmReleased -Message "..."` from the worktree.
- The first such update ships BUG-525's foreground check to 1.1 phones.
- **Recommended:** keep release/1.1 alive through the iOS review and Thanksgiving (Nov 26), for fixes only. Then stop shipping 1.1.0 updates to each platform once 1.2 is live there. Phones that never update the app stay on the last 1.1.0 bundle, so the server must keep the 1.1 API working for them.

## 3. Build (both platforms from ONE commit)

From `next` at a pushed commit, clean tree, `google-services.json` committed:

```powershell
cd artifacts\kiwi
eas build --profile production --platform ios
eas build --profile production --platform android
```

- **Env:** `eas.json` `build.production.env` supplies `EXPO_PUBLIC_API_BASE_URL` and `SENTRY_DISABLE_AUTO_UPLOAD`. The EAS **production** environment supplies the rest, the same names `ota-update.ps1` step 3 checks: API base URL, Turnstile site key, Google web + iOS client ids, Apple Services ID + web redirect, RevenueCat iOS + Android keys, and optionally the Sentry DSN.
- **Build numbers** auto-increment remotely (`appVersionSource: remote`), so expect iOS build 9+ and Android versionCode 6+.
- **Then record the commit.** In `scripts/release/ota-update.ps1`, set `$script:Binaries['1.2.0'].Commit` to the build commit and `.Builds` to the build numbers, and commit. Until that's done, `-Runtime 1.2.0` refuses at step 0. One commit per runtime, so rebuilding one platform from a later commit means rebuilding both.

## 4. TestFlight (internal) and Play (internal testing)

```powershell
eas submit -p ios --latest       # then add the build to the internal TestFlight group
eas submit -p android --latest   # eas submit's default Android track is internal
```

Do the device pass (section 6) on these installs, then:
- **iOS:** submit 1.2.0 for review in App Store Connect.
- **Android:** promote internal → production in Play Console.

## 5. Notes for the reviewer

**What's New (both stores):**
> Kiwi now picks up its latest improvements faster, and we've added crash reporting so we can find and fix problems sooner. Plus bug fixes and polish.

**App Review notes (Apple):**
> Version 1.2 adds:
> - Crash reporting (Sentry). Reports carry no personal content; the account is identified only by a one-way hash.
> - The system rating prompt (SKStoreReviewController), shown at most once every 120 days, only after the user has finished cooking a meal in Cook Mode at least twice.
> - Push notification capability that this version does not use: there is no notification prompt beyond the existing Cook Mode timer alerts.
>
> No new permissions are requested. The sign-in details are the same as for 1.1.

## 6. Device pass for the 1.2 binary

The dev build can't show A: expo-updates is off when Metro serves the JS. For a pre-submit check of A, build a preview APK from the same commit (`eas build --profile preview -p android`, channel preview). Publish a test update with `eas update --branch preview --environment preview`.

- **G (runtime):** Profile's footer reads `Version 1.2.0 · runtime 1.2.0 · built-in` on a fresh install while no 1.2.0 update exists.
- **A (fresh install):** once a 1.2.0 update is published, a fresh install's first launch shows `update <id>` in the footer, not `built-in`. The splash may stay up to 5 s.
- **A (warm phone):**
  1. Publish a 1.2.0 update while the app sits in the background for more than 10 minutes.
  2. Bring the app back. "Kiwi updated — tap to restart" shows at the top for 8 s.
  3. It never shows in Cook Mode or Prep the Week.
  4. Tapping it restarts the app, and the footer shows the new update id.
- **B:** with no DSN, nothing changes. After a DSN ships by update, Sentry → Releases shows sessions for the 1.2.0 release (`com.kitchenwizard.kiwi@1.2.0+<build>`). No test-crash hook ships, on purpose.
- **C:** TestFlight never shows the rating sheet; Apple suppresses it there. Prove the rules on an iOS dev build of this commit, where the sheet always shows:
  1. Use an account at least 3 days old.
  2. Cook a meal to its last step and go back: no sheet.
  3. Do it again: the sheet opens about 1 s after leaving.
  4. A third time: no sheet (the 120-day rule).
  5. Reset by deleting the app.
- **D:** pending.
- **E:** no notification prompt beyond the Cook Mode timers, and no push token in the server logs. The Android build log shows the google-services plugin applied.
- **F:** nothing visible.
- **G (script):**
  - `ota-update.ps1 -Runtime 1.2.0 -Platform android -ConfirmReleased -Message "dry" -DryRun` from next passes steps 0–6.
  - The same with `-Runtime 1.1.0` from the release/1.1 worktree passes too.
  - `-Runtime 1.1.0` from next refuses at step 1.

D-WS9-279 still holds: a runtime's update goes to a platform only after that platform's binary for that runtime is released.
