# Deploying the api-server to Cloud Run

Operator notes for the container defined by the repo-root `Dockerfile` (WS9A).
PowerShell-native. Placeholders are in `<angle brackets>`. **No value in this
file is real; no value ever goes in the tree** — secrets live in Secret
Manager, plain config in the service's env vars, and locally in
`artifacts/api-server/.env` (gitignored).

## What the image is

- Multi-stage, `node:24.21.0-bookworm-slim` in both stages (Node 24 LTS —
  the local 25.x is EOL; the suite, typecheck and the boot chain were verified
  under 24.21.0 before pinning). `engines.node: ">=24"` in `package.json`.
  There is deliberately **no `packageManager` field**: corepack is absent on
  the local Windows setup, so the field could not be verified there. The
  image bootstraps pnpm 10.33.1 through corepack itself, which Node 24 ships.
- Build stage: `pnpm install --frozen-lockfile --filter @workspace/api-server...`
  → `prisma generate` (Linux engine, generated **inside** the image — the
  schema has no `binaryTargets`) → `node build.mjs`.
- Runtime stage carries only `dist/` (whole folder — pino worker files
  included), `node_modules/@prisma/client` + `node_modules/.prisma/client`,
  `prisma/schema.prisma`, `package.json`. Runs as `USER node`,
  `NODE_ENV=production`, `CMD node --enable-source-maps dist/index.mjs`.
- BUG-229: build and start come from the same layer; a stale `dist/` cannot
  be served. (Locally, `pnpm start` now runs `build.mjs` first for the same
  reason.)
- The container **does not run migrations**. Run them from the repo
  (`pnpm --filter @workspace/api-server exec prisma migrate deploy` with
  `DATABASE_URL` pointing at the target) before the first deploy of a revision
  that needs them.
- `@types/node` in the pnpm catalog is `^25.3.3` while the runtime is 24 —
  types only, left as is.

## Environment contract

Every variable the server reads, by name. Destination is where the value
lives for the deployed instance. "env" = a plain Cloud Run env var
(`--set-env-vars`); "Secret Manager" = `--set-secrets`.

| Name | Required | Destination | Note |
| --- | --- | --- | --- |
| `PORT` | yes | Cloud Run injects it (8080) | `index.ts` refuses to boot without it. Do not set it yourself. |
| `NODE_ENV` | yes | env, `production` | Without it pino emits ANSI text instead of JSON and the dev Prisma guard stays on. |
| `DATABASE_URL` | yes | Secret Manager | Neon connection string. Wrong value does NOT crash the process — `/api/readyz` is what catches it. |
| `JWT_SECRET` | yes | Secret Manager | Signs sessions, reset and email-change tokens. Absent → throws at import of `lib/auth.ts`. |
| `ANTHROPIC_API_KEY` | for AI features | Secret Manager | Absent → every AI call returns a typed `no_api_key` failure; the server still serves. |
| `RESEND_API_KEY` | for email | Secret Manager | Absent → password-reset / email-change mint tokens but send nothing (BUG-224 seam). |
| `EMAIL_FROM` | if `RESEND_API_KEY` is set | env | Resend-verified sender, e.g. `Kiwi <noreply@<verified-domain>>`. Boot refuses a key without it. |
| `PUBLIC_APP_URL` | if `RESEND_API_KEY` is set | env | Base of the emailed links. **Must equal the Cloud Run service URL** (`https://<service>-<hash>-<region>.run.app`, no trailing slash) for the first deploy, the custom domain later — the `/reset-password` and `/verify-email` pages are served by this same service at its root, so any other host makes the links dead. |
| `TRUST_PROXY_HOPS` | no | **unset** | Leave unset (= 0, trust nothing) until measured — see below. Never `true`. |
| `LOG_LEVEL` | no | env | pino level; default `info`. |
| `USDA_INGREDIENTS_API_KEY` | no | Secret Manager | Absent → USDA enrichment no-ops. |
| `KIWI_STORE_SHORTLIST_SIZE` | no | env | Default 40. |
| `KIWI_STORE_CUISINE_QUOTA_FRACTION` | no | env | Default 0.7. |
| `EMAIL_REVIEW_RECIPIENT` | no | — | Documented in `.env.example`; **read by no code yet** (D-WS9-226 message 3 is not built). Nothing to set. |

## First deploy

One-time: project, APIs, secrets. The secret values are read from a prompt
so they never appear on a command line or in shell history.

```powershell
gcloud config set project <gcp-project-id>
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

foreach ($name in "DATABASE_URL", "JWT_SECRET", "ANTHROPIC_API_KEY", "RESEND_API_KEY") {
  $secure = Read-Host -AsSecureString "Value for $name"
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  $plain | gcloud secrets create $name --data-file=- --replication-policy=automatic
}
```

Grant the service's runtime service account access to each secret
(`roles/secretmanager.secretAccessor`) — the default compute service account
if you did not create a dedicated one:

```powershell
$sa = "<project-number>-compute@developer.gserviceaccount.com"
foreach ($name in "DATABASE_URL", "JWT_SECRET", "ANTHROPIC_API_KEY", "RESEND_API_KEY") {
  gcloud secrets add-iam-policy-binding $name --member="serviceAccount:$sa" --role="roles/secretmanager.secretAccessor"
}
```

Deploy from the **repo root** (the Dockerfile lives there; Cloud Build reads
it — no local Docker needed). Region `us-east4` (N. Virginia) is the nearest
GCP region to the Neon project (AWS us-east-1).

```powershell
gcloud run deploy kiwi-api `
  --source . `
  --region us-east4 `
  --allow-unauthenticated `
  --port 8080 `
  --set-env-vars "NODE_ENV=production,EMAIL_FROM=<sender>,PUBLIC_APP_URL=<https://service-url>" `
  --set-secrets "DATABASE_URL=DATABASE_URL:latest,JWT_SECRET=JWT_SECRET:latest,ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,RESEND_API_KEY=RESEND_API_KEY:latest"
```

`PUBLIC_APP_URL` is chicken-and-egg on the very first deploy: the service URL
does not exist until the service does. Deploy once **without**
`RESEND_API_KEY` in `--set-secrets` (the mailer is then a no-op and
`EMAIL_FROM` / `PUBLIC_APP_URL` may be omitted), read the URL with

```powershell
gcloud run services describe kiwi-api --region us-east4 --format "value(status.url)"
```

then redeploy with all three set.

Then set the probes. A second call is unavoidable on the first deploy anyway
(`PUBLIC_APP_URL` is not known until the service exists), so the probes ride
it here; `gcloud run deploy` accepts the same `--startup-probe` /
`--liveness-probe` flags, and on every later deploy they can go on the
`deploy` call itself.

```powershell
gcloud run services update kiwi-api --region us-east4 `
  --startup-probe "httpGet.path=/api/readyz,httpGet.port=8080,initialDelaySeconds=0,periodSeconds=2,failureThreshold=15,timeoutSeconds=3" `
  --liveness-probe "httpGet.path=/api/healthz,httpGet.port=8080,periodSeconds=30,failureThreshold=3,timeoutSeconds=3"
```

- **Startup → `GET /api/readyz`**: proves the database with a bounded
  `SELECT 1`. A revision whose `DATABASE_URL` is wrong never goes green
  (BUG-221).
- **Liveness → `GET /api/healthz`**: pure; never fails because Neon blipped.

## Smoke

```powershell
$url = gcloud run services describe kiwi-api --region us-east4 --format "value(status.url)"
curl.exe -i "$url/api/healthz"
curl.exe -i "$url/api/readyz"
curl.exe -i "$url/reset-password"      # 200, text/html, Cache-Control: no-store
curl.exe -i "$url/verify-email"        # same
```

A JSON body, if ever needed, goes through a hashtable — never inline JSON
after `-d`:

```powershell
$body = @{ token = "<token-from-the-email>"; newPassword = "<new-password>" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri "$url/api/auth/password-reset/confirm" -ContentType "application/json" -Body $body
```

## Watch items on the first deploy

1. **`/api/readyz` vs a Neon cold start.** The readiness query is bounded at
   **2 s** (`READINESS_TIMEOUT_MS` in `routes/health.ts`) and has never met a
   real Neon auto-suspend wake-up. If the startup probe flaps on a fresh
   revision, that bound is the first thing to look at — the probe settings
   above allow 15 × 2 s before the revision is failed. Do not widen the bound
   pre-emptively; measure first.
2. **`TRUST_PROXY_HOPS` — unset until measured.** The rate limiter keys on
   `req.ip`. At the default 0 the peer address is Google's front end for
   every request, so `authLimiter`'s 10/min is briefly a *global* 10/min —
   safe, but noticeable under real traffic. The expected value on Cloud Run
   is 1; it is reasoned, not measured. To measure: deploy a revision with one
   log line printing `req.socket.remoteAddress` and `req.headers["x-forwarded-for"]`,
   then `curl.exe "$url/api/healthz"` from two different networks (e.g. home
   and phone hotspot). If `x-forwarded-for` carries exactly one address and
   it differs between the two runs, set `TRUST_PROXY_HOPS=1`. Never `true`.
3. **Boot log.** `prisma_connected` should appear shortly after `Server
   listening`. `prisma_connect_failed` on a green revision means readiness
   passed on a later retry — check `DATABASE_URL`.
4. **A `Cannot find module` at boot** means a new package was added to
   `build.mjs`'s `external` list and imported — the runtime tree carries only
   `@prisma/client`. Add it to the copy step in the Dockerfile.

## Redeploy

Same `gcloud run deploy kiwi-api --source . --region us-east4` from the repo
root; env vars and secrets persist on the service, so the flags are only
needed when they change.
