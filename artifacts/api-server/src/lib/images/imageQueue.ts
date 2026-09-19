// Row 5 · Block 1c (D-WS9-248) — the on-save image queue and its drain.
//
// THE CONSTRAINT: OpenAI allows this org 5 images/minute, org-wide, and that
// is the account maximum. Every import competes for the same five slots.
//
// THE SHAPE: no queue table. A saved meal that needs an image carries
// `imageStatus = pending` on its own row (the schema default) and the save
// returns at once — nothing on a request path ever calls OpenAI. A scheduled
// drain (Cloud Scheduler → POST /api/internal/images/drain, once a minute)
// claims at most five `pending` rows FIFO, marks them `generating`, generates
// + uploads, and writes `ready`. Three strikes → `failed`, the gradient
// permanently. Never an unbounded retry.
//
// 🔴 WHY THE BOUND LIVES IN THE DATABASE. Cloud Run runs up to 20 instances;
// an in-process limiter would give each its own counter and bound nothing
// (the same argument canon made for the spend guard). Everything that
// enforces the cap here is ONE transaction on the shared database:
//
//   1. pg_advisory_xact_lock(hashtext('kiwi:image-drain:claim')) — claims
//      are serialised across every instance, so "count the budget, then
//      take rows" is atomic. Two drains racing cannot both see five free
//      slots.
//   2. The budget = 5 − (generations SENT in the last 60 s, from the
//      LLMCallLog ledger: createdAt − latencyMs is the send time, so a
//      call that finished at :15 after a claim at :03 still counts against
//      the minute it was sent in — and not against the next one) − (rows
//      still `generating`, i.e. sent but not yet logged). The ledger also
//      counts a laptop backfill's rows, so the drain backs off from one
//      automatically (D-WS9-248: they share the same five slots).
//   3. FOR UPDATE SKIP LOCKED on the candidate rows — a row another
//      transaction holds (a user's edit in flight) is skipped this tick,
//      not waited on and not double-claimed.
//
// A FORK NEVER GENERATES ITS OWN IMAGE. cloneMealInto copies the parent's
// image + status; a fork of a still-pending parent is itself `pending` but
// the claim SKIPS any row whose sourceStoreMealId parent is pending /
// generating, and when the parent lands the drain stamps the same URL onto
// every such fork. One generation per catalog image, however many plans
// it is in.
//
// STUCK ROWS: a row left `generating` for IMAGE_STUCK_AFTER_MINUTES (a
// drain that crashed mid-generation) is put back to `pending` at the start
// of the next claim. Its attempt already counted — a crash is a strike.
//
// STRIKES vs DEFERRALS: an OpenAI error, a bad response, a network failure
// or a bucket write failure is a STRIKE (the row's problem, bounded at
// three). A spend-guard refusal (kill switch, ceiling, per-user cap) or a
// missing API key is a DEFERRAL — the environment's problem, not the row's:
// the row goes back to `pending` with its attempt undone, and the next tick
// tries again for free (no OpenAI call, no ledger row, no cost).
//
// A FAILURE REACHES A HUMAN (D-WS9-253). The gradient is the accepted
// terminal state at launch on ONE condition Hans attached himself: "if it
// fails and something gets alerted". So every TRANSITION to `failed` emits a
// structured `image_generation_failed` event (meal id, attempts, last error,
// which path) — the third strike, a throw past the pipeline on the third
// attempt, and the claim-time sweep of a pending row that had already used
// its attempts. A GCP log-based alert on that event is Hans's console step;
// DEPLOY.md carries the recipe. 🔴 TRANSITION, NEVER COUNT: 282 user-authored
// rows were backfilled to `failed` by Block 1c's migration and never pass
// through here, so a count-based alert would fire 282 times on its first
// evaluation. 🔴 A DEFERRAL IS NOT A FAILURE: `no_api_key` and the spend-
// guard reasons put the row back to `pending` and emit nothing — six meals
// survived an unset key on September 19 for exactly this reason. Forks that
// fail with their parent do not get their own event: a fork's image IS the
// parent's, and the parent's event is the alert.
//
// FAIRNESS is deliberately NOT built (D-WS9-248): FIFO means one user
// importing 50 recipes occupies ten minutes of the queue. The cheap fix is a
// per-user cap inside a batch; build it only if the beta shows it happening.
//
// Nothing here touches the network on its own: the generator's fetch and
// the store's writer arrive through `deps` (live.ts assembles the real ones).

import type { PrismaClient } from "@prisma/client";

import { logger } from "../logger";
import { IMAGES_GENERATE_KEY } from "./imageGenerator";
import { resolveMealImage, type PipelineDeps } from "./imagePipeline";
import type { MealImageSubject } from "./types";

// The org-wide OpenAI cap, images per minute. Hans's account maximum.
export const IMAGE_DRAIN_BATCH = 5;
export const IMAGE_DRAIN_WINDOW_SECONDS = 60;
export const IMAGE_MAX_ATTEMPTS = 3;
export const IMAGE_STUCK_AFTER_MINUTES = 5;
export const IMAGE_DRAIN_LOCK_KEY = "kiwi:image-drain:claim";

export interface ClaimedImageRow {
  id: string;
  title: string;
  userId: string | null;
  // AFTER the claim's increment — this attempt's ordinal (1-based).
  imageAttempts: number;
}

export interface ClaimOutcome {
  claimed: ClaimedImageRow[];
  // Rows put back to `pending` by the stuck-row guard this tick.
  requeuedStuck: number;
  // `pending` rows that had already used every attempt → `failed`, BY ID
  // (D-WS9-253: each is a transition to `failed` and gets its own event).
  failedOutIds: string[];
  budget: { recentSends: number; inFlight: number; limit: number };
}

// D-WS9-253 — the structured failure event, one per TRANSITION to `failed`.
export interface ImageGenerationFailedEvent {
  event: "image_generation_failed";
  mealId: string;
  attempts: number;
  // The generation/store reason + detail from the last attempt, the thrown
  // error's message, or "attempts_exhausted_at_claim" for the sweep (that
  // row's last error was logged by the tick that struck it).
  lastError: string;
  path: "strike" | "threw" | "claim_sweep";
}

export type ReleaseOutcome = "strike" | "defer";

// The persistence surface the drain needs. Structural so the hermetic tests
// hand in an in-memory fake; createPrismaImageQueueStore is the real one.
export interface ImageQueueStore {
  claim(batch: number): Promise<ClaimOutcome>;
  loadSubjects(ids: string[]): Promise<MealImageSubject[]>;
  markReady(id: string, url: string, at: Date): Promise<{ forksStamped: number }>;
  // strike: attempts exhausted → `failed` (and pending forks with it), else
  // `pending`. defer: `pending` with the attempt undone.
  release(row: ClaimedImageRow, outcome: ReleaseOutcome): Promise<"pending" | "failed">;
}

interface RawClaimRow {
  id: string;
  title: string;
  userId: string | null;
  imageAttempts: number;
}

export function createPrismaImageQueueStore(prisma: PrismaClient): ImageQueueStore {
  return {
    async claim(batch) {
      return prisma.$transaction(async (tx) => {
        // 1. Serialise claims across every instance.
        //    (cast: the function returns void, which Prisma cannot deserialise)
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${IMAGE_DRAIN_LOCK_KEY}))::text AS locked`;

        // 2. Stuck rows back to the queue; exhausted rows out of it.
        const requeuedStuck = await tx.$executeRaw`
          UPDATE "meals" SET "imageStatus" = 'pending'
          WHERE "imageStatus" = 'generating'
            AND "updatedAt" < (now() at time zone 'utc') - (${IMAGE_STUCK_AFTER_MINUTES} * interval '1 minute')`;
        const failedOutRows = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "meals" SET "imageStatus" = 'failed'
          WHERE "imageStatus" = 'pending' AND "imageAttempts" >= ${IMAGE_MAX_ATTEMPTS}
          RETURNING "id"`;
        const failedOutIds = failedOutRows.map((r) => r.id);

        // 3. The budget for this minute, from the shared ledger.
        const [recent] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM "llm_call_logs"
          WHERE "promptKey" = ${IMAGES_GENERATE_KEY}
            AND ("createdAt" - ("latencyMs" * interval '1 millisecond'))
                > (now() at time zone 'utc') - (${IMAGE_DRAIN_WINDOW_SECONDS} * interval '1 second')`;
        const [inFlight] = await tx.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM "meals" WHERE "imageStatus" = 'generating'`;
        const recentSends = recent?.n ?? 0;
        const generating = inFlight?.n ?? 0;
        const limit = Math.max(0, batch - recentSends - generating);
        const budget = { recentSends, inFlight: generating, limit };
        if (limit === 0) {
          return { claimed: [], requeuedStuck, failedOutIds, budget };
        }

        // 4. The claim. FIFO by createdAt; a fork of a not-yet-imaged parent
        //    waits for the parent (it will be stamped, not generated).
        const rows = await tx.$queryRaw<RawClaimRow[]>`
          UPDATE "meals" m
          SET "imageStatus" = 'generating',
              "imageAttempts" = m."imageAttempts" + 1,
              "updatedAt" = (now() at time zone 'utc')
          WHERE m."id" IN (
            SELECT c."id" FROM "meals" c
            WHERE c."imageStatus" = 'pending'
              AND c."imageAttempts" < ${IMAGE_MAX_ATTEMPTS}
              AND NOT EXISTS (
                SELECT 1 FROM "meals" p
                WHERE p."id" = c."sourceStoreMealId"
                  AND p."imageStatus" IN ('pending', 'generating'))
            ORDER BY c."createdAt" ASC, c."id" ASC
            LIMIT ${limit}
            FOR UPDATE SKIP LOCKED)
          RETURNING m."id", m."title", m."userId", m."imageAttempts"`;
        return { claimed: rows, requeuedStuck, failedOutIds, budget };
      });
    },

    async loadSubjects(ids) {
      if (ids.length === 0) return [];
      const meals = await prisma.meal.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          title: true,
          dishLinks: { orderBy: { positionIndex: "asc" }, select: { dish: { select: { title: true } } } },
        },
      });
      return meals.map((m) => ({ mealId: m.id, title: m.title, dishTitles: m.dishLinks.map((l) => l.dish.title) }));
    },

    async markReady(id, url, at) {
      await prisma.meal.update({
        where: { id },
        data: { imageUrl: url, imageSource: "ai_generated", imageGeneratedAt: at, imageStatus: "ready" },
      });
      // The forks that were waiting on this parent inherit it now.
      const forks = await prisma.meal.updateMany({
        where: { sourceStoreMealId: id, imageUrl: null, imageStatus: "pending" },
        data: { imageUrl: url, imageSource: "ai_generated", imageGeneratedAt: at, imageStatus: "ready" },
      });
      return { forksStamped: forks.count };
    },

    async release(row, outcome) {
      if (outcome === "defer") {
        await prisma.meal.updateMany({
          where: { id: row.id, imageStatus: "generating" },
          data: { imageStatus: "pending", imageAttempts: { decrement: 1 } },
        });
        return "pending";
      }
      const exhausted = row.imageAttempts >= IMAGE_MAX_ATTEMPTS;
      await prisma.meal.updateMany({
        where: { id: row.id, imageStatus: "generating" },
        data: { imageStatus: exhausted ? "failed" : "pending" },
      });
      if (exhausted) {
        await prisma.meal.updateMany({
          where: { sourceStoreMealId: row.id, imageUrl: null, imageStatus: "pending" },
          data: { imageStatus: "failed" },
        });
      }
      return exhausted ? "failed" : "pending";
    },
  };
}

// ── the drain ────────────────────────────────────────────────────────

export interface ImageDrainDeps {
  store: ImageQueueStore;
  // The generator + bucket wiring, minus userId — the drain sets that per row
  // from the meal's owner so the spend guard and the ledger see the real user.
  pipeline: Omit<PipelineDeps, "generator"> & { generator: Omit<PipelineDeps["generator"], "userId"> };
  batch?: number;
  now?: () => Date;
  // D-WS9-253 — where the failure event goes. Production: the pino logger at
  // `error` (below). Injected so the hermetic suite can capture the events
  // and prove a deferral emits none.
  onFailed?: (event: ImageGenerationFailedEvent) => void;
}

function logFailedEvent(event: ImageGenerationFailedEvent): void {
  logger.error(event, "Meal image generation FAILED — the gradient is permanent for this meal (D-WS9-253)");
}

export interface ImageDrainSummary {
  claimed: number;
  ready: number;
  // Struck out this tick (attempts exhausted) — the gradient, permanently.
  failed: number;
  // Struck, attempts remain → back to pending.
  retried: number;
  // Deferred (guard / no key) → back to pending, attempt undone.
  deferred: number;
  forksStamped: number;
  requeuedStuck: number;
  failedOut: number;
  budget: ClaimOutcome["budget"];
  costEstimateUsd: number;
}

const DEFERRAL_REASONS = new Set(["ai_disabled", "spend_cap_global", "spend_cap_user", "no_api_key"]);

export async function runImageDrain(deps: ImageDrainDeps): Promise<ImageDrainSummary> {
  const batch = deps.batch ?? IMAGE_DRAIN_BATCH;
  const now = deps.now ?? (() => new Date());
  const onFailed = deps.onFailed ?? logFailedEvent;
  const claim = await deps.store.claim(batch);
  // D-WS9-253 — the claim-time sweep is a transition to `failed` too (a row
  // requeued from `generating` by the stuck guard with no attempts left).
  for (const mealId of claim.failedOutIds) {
    onFailed({ event: "image_generation_failed", mealId, attempts: IMAGE_MAX_ATTEMPTS, lastError: "attempts_exhausted_at_claim", path: "claim_sweep" });
  }
  const summary: ImageDrainSummary = {
    claimed: claim.claimed.length,
    ready: 0,
    failed: 0,
    retried: 0,
    deferred: 0,
    forksStamped: 0,
    requeuedStuck: claim.requeuedStuck,
    failedOut: claim.failedOutIds.length,
    budget: claim.budget,
    costEstimateUsd: 0,
  };
  if (claim.claimed.length === 0) return summary;

  const subjects = new Map((await deps.store.loadSubjects(claim.claimed.map((r) => r.id))).map((s) => [s.mealId, s]));

  // The whole batch in parallel: five sequential ~12 s generations would run
  // the tick past the minute the scheduler fires it in.
  await Promise.all(
    claim.claimed.map(async (row) => {
      const subject = subjects.get(row.id) ?? { mealId: row.id, title: row.title, dishTitles: [] };
      try {
        const out = await resolveMealImage(subject, {
          ...deps.pipeline,
          generator: { ...deps.pipeline.generator, userId: row.userId ?? undefined },
        });
        summary.costEstimateUsd += out.trace.costEstimateUsd;
        if (out.image.url) {
          const { forksStamped } = await deps.store.markReady(row.id, out.image.url, now());
          summary.ready++;
          summary.forksStamped += forksStamped;
          return;
        }
        const reason = out.trace.generation && !out.trace.generation.ok ? out.trace.generation.reason : "store_error";
        const detail = out.trace.generation && !out.trace.generation.ok ? out.trace.generation.detail : out.trace.storeError;
        const outcome: ReleaseOutcome = DEFERRAL_REASONS.has(reason) ? "defer" : "strike";
        const status = await deps.store.release(row, outcome);
        if (outcome === "defer") summary.deferred++;
        else if (status === "failed") summary.failed++;
        else summary.retried++;
        logger.warn(
          { event: "image_drain_row_not_ready", mealId: row.id, attempt: row.imageAttempts, reason, detail, outcome, status },
          "Meal image not produced this tick",
        );
        // D-WS9-253 — only a STRIKE can transition to `failed`; a deferral
        // returns "pending" by construction and never reaches this line.
        if (status === "failed") {
          onFailed({ event: "image_generation_failed", mealId: row.id, attempts: row.imageAttempts, lastError: detail ? `${reason}: ${detail}` : reason, path: "strike" });
        }
      } catch (err) {
        // A throw past the pipeline (it catches its own) is a strike too —
        // the row must never be left `generating` by an exception.
        const status = await deps.store.release(row, "strike");
        if (status === "failed") summary.failed++;
        else summary.retried++;
        logger.error({ event: "image_drain_row_threw", mealId: row.id, attempt: row.imageAttempts, err, status }, "Image drain row threw");
        if (status === "failed") {
          onFailed({ event: "image_generation_failed", mealId: row.id, attempts: row.imageAttempts, lastError: err instanceof Error ? err.message : String(err), path: "threw" });
        }
      }
    }),
  );

  logger.info({ event: "image_drain_tick", ...summary }, "Image drain tick");
  return summary;
}
