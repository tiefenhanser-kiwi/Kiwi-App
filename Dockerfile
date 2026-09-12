# syntax=docker/dockerfile:1
#
# WS9A — the api-server container for Cloud Run.
#
# Lives at the REPO ROOT because the build context must include the workspace
# root (package.json, pnpm-lock.yaml, pnpm-workspace.yaml, lib/api-zod): the
# api-server depends on @workspace/api-zod, whose export is TypeScript source
# that esbuild bundles. `gcloud run deploy --source .` from the root reads this
# file; .dockerignore beside it keeps artifacts/kiwi, node_modules, .env* and
# the rest out of the context.
#
# BUG-229 — build and start come from the SAME image layer: the runtime stage
# copies the dist/ the build stage just produced, so a stale dist/ is impossible
# here by construction (the local `pnpm start` has its own fix in package.json).
#
# Node 24 LTS (Active until 2026-10-20, maintenance to 2028-04-30). Hans's
# local is 25.9.0, which is EOL since 2026-06-01 and whose image is no longer
# maintained; the suite, typecheck and this exact chain were run under a
# portable 24.21.0 before this pin was made. Same tag in both stages.
#
# ⚠️ The `-slim` image purges libssl3 after installing Node (Node links OpenSSL
# statically). Prisma's Linux query engine dlopens libssl.so.3, so BOTH stages
# install `openssl` — without it the engine fails to load at first query.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim

# ── build ──────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS build

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# pnpm only, never npm (the root preinstall refuses anything else). The
# lockfile is v9 and was produced by pnpm 10.33.1 — pin the same. corepack
# ships with Node 24 (it was dropped from 25, which is why there is no
# `packageManager` field: it is unverifiable on the local Windows setup).
RUN corepack enable && corepack prepare pnpm@10.33.1 --activate

WORKDIR /workspace

# Manifests first so the install layer caches independently of source edits.
# Only the manifests of the packages the filter selects are needed — pnpm
# tolerates lockfile importers whose directories are absent (verified with
# `pnpm install --frozen-lockfile --filter @workspace/api-server...` against a
# context holding exactly these files).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY lib/api-zod/package.json lib/api-zod/
COPY artifacts/api-server/package.json artifacts/api-server/

# `...` = api-server plus its workspace dependencies (@workspace/api-zod).
# @prisma/engines' postinstall is not in onlyBuiltDependencies, so no engine
# is fetched here; `prisma generate` below downloads the Linux one on demand.
RUN pnpm install --frozen-lockfile --filter @workspace/api-server...

COPY lib/api-zod lib/api-zod
COPY artifacts/api-server artifacts/api-server

WORKDIR /workspace/artifacts/api-server

# The generated client is platform-bound (schema.prisma has no binaryTargets;
# a Windows engine will not load on Linux) — it MUST be generated here.
RUN pnpm exec prisma generate
RUN pnpm run build

# Assemble the runtime tree. The esbuild bundle externalises exactly one
# package the code imports — @prisma/client — so the runtime node_modules is
# that package plus its generated sibling, copied OUT of pnpm's symlinked
# store into npm's flat layout (`.prisma/client` resolves
# `@prisma/client/runtime/library.js` upward; `@prisma/client/default.js`
# resolves `.prisma/client` upward — the same resolution the symlink layout
# performs today).
#
# ⚠️ If a future change imports another package that build.mjs lists as
# external (sharp, bcrypt, …), this tree will not carry it and the container
# fails LOUDLY at boot with `Cannot find module '<name>'` — visible in the
# revision's logs, never a silent degradation. Add it to the copies below.
#
# prisma/schema.prisma rides along as the schema of record for the client this
# image was generated from. It is NOT enough to run `prisma migrate deploy`
# from the image — that needs the prisma CLI (a devDependency) and
# prisma/migrations, neither of which is carried. Migrations are run by Hans
# from the repo against the target database; the container never runs them.
RUN set -eu \
 && CLIENT_DIR="$(readlink -f node_modules/@prisma/client)" \
 && mkdir -p /runtime/node_modules/@prisma /runtime/node_modules/.prisma /runtime/prisma \
 && cp -r dist /runtime/dist \
 && cp -r "${CLIENT_DIR}" /runtime/node_modules/@prisma/client \
 && cp -r "${CLIENT_DIR}/../.prisma/client" /runtime/node_modules/.prisma/client \
 && cp prisma/schema.prisma /runtime/prisma/schema.prisma \
 && cp package.json /runtime/package.json \
 && test -f /runtime/dist/index.mjs \
 && ls /runtime/node_modules/.prisma/client/ | grep -q 'libquery_engine-.*\.so\.node'

# ── runtime ────────────────────────────────────────────────────────────────
FROM ${NODE_IMAGE} AS runtime

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /runtime /app

USER node

# Cloud Run injects PORT (8080); index.ts refuses to boot without it. No .env
# is copied and no secret is baked — every variable arrives from the service's
# env / Secret Manager (see artifacts/api-server/DEPLOY.md).
EXPOSE 8080
CMD ["node", "--enable-source-maps", "dist/index.mjs"]
