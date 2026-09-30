# [prepcook] B1 — the eight breaks

Each break is a single edit to a committed tree, run, then restored. A break is
RED when the named test fails for the named reason; a break that stays green is a
test that does not actually pin its fix.

Run from `artifacts/api-server` (mobile breaks from `artifacts/kiwi`). Every SHA is
`sha256` of the file, before and after restore — the restore is only proven if the
before and after digests match.

| # | ruling | edit | expected RED |
|---|---|---|---|
| 1 | 1 | `LAG_AFTER_HEAT_REST`/`_OTHER` → `Infinity` | Carne Asada rest gap returns to 20 min |
| 2 | 2 | `passiveStateOf` returns `"staying warm"` for a cold `hold` | "staying warm" said of a refrigerated guacamole |
| 3 | 2 | drop `oIdx < seqIdx` from `composeCue`'s window search | a cue points at a later step |
| 4 | 3 | `isServedCold` returns `false` always | pico is finish-aligned again; the marinade window empties |
| 5 | 5 | footer uses `remainingMinutes` only | Carne Asada footer reads 116 |
| 6 | 7 | `toCount` returns the raw decimal | `0.25` prints as `0.25` |
| 7 | 9 | remove the one-component blend fold | the lone paprika gets its own step again |
| 8 | 13 | `buildStepPlan` stops emitting `daysUntilCook` | no lag in the narration input |

See `breaks.ts` for the mechanics: it applies each edit by exact-string
replacement (refusing if the anchor is absent, so a moved line cannot silently
skip a break), runs the named test file, records the result, and restores from an
in-memory copy of the original bytes.
