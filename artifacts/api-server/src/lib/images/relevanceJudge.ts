// Row 5 · Block 1 (D-WS9-246 step 2) — the AI relevance judge. One call per
// meal: the meal title, its dish list, and the stock candidates (each as a
// ~340 px preview attached as a vision block, plus the provider's own
// description). Returns the index of the ONE accepted candidate or null.
//
// Runs through runAICall so it is logged to LLMCallLog, priced from the model
// rate table, and inside the D-WS9-240 spend guard. Prompt body lives in
// prisma/seeds/aiPrompts.ts (`images.relevance_judge`) like every other
// prompt; the in-memory REGISTRY carries the placeholder fallback.
//
// The previews are downloaded through the injected fetch — a test hands in a
// stub that returns fixed bytes; nothing here touches the network on its own.

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

import type { AICallResult } from "../ai/runAICall";
import type { PrismaLike } from "../ai/promptRegistry";
import type { ImageFetch, MealImageSubject, StockCandidate } from "./types";

export const IMAGES_RELEVANCE_JUDGE_KEY = "images.relevance_judge";

export const RelevanceVerdictSchema = z.object({
  // 0-based index into the candidate list, or null when none fits.
  accepted: z.number().int().min(0).nullable(),
  reason: z.string().min(1),
});
export type RelevanceVerdict = z.infer<typeof RelevanceVerdictSchema>;

// The runAICall surface the judge needs. Structural so a test can hand in a
// recorder without importing the real orchestrator.
export type JudgeAICall = <T extends z.ZodTypeAny>(
  promptKey: string,
  vars: Record<string, unknown>,
  schema: T,
  opts: {
    prisma?: PrismaLike;
    userId?: string;
    temperature?: number;
    maxTokens?: number;
    attachments?: Anthropic.ImageBlockParam[];
  },
) => Promise<AICallResult<z.infer<T>>>;

export interface JudgeDeps {
  ai: JudgeAICall;
  fetch: ImageFetch;
  prisma?: PrismaLike;
  userId?: string;
  // How many candidates to show at most (attachments are billed per image).
  maxCandidates?: number;
}

export interface JudgeOutcome {
  // The verdict, or null when the AI call failed (the caller treats a failed
  // judge as "rejected all" and moves to step 3).
  verdict: RelevanceVerdict | null;
  // Which candidates were actually shown (a preview that failed to download
  // is dropped BEFORE the call so the indices the model returns line up).
  shown: StockCandidate[];
  failureReason?: string;
  costEstimateUsd: number;
}

export const DEFAULT_MAX_JUDGE_CANDIDATES = 8;
const PREVIEW_TIMEOUT_MS = 8_000;
// Anthropic's accepted image media types.
const VISION_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

async function downloadPreview(
  fetchImpl: ImageFetch,
  url: string,
): Promise<Anthropic.ImageBlockParam | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREVIEW_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { method: "GET", signal: controller.signal });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const mediaType = VISION_MEDIA.has(ct) ? ct : "image/jpeg";
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.byteLength === 0) return null;
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
        data: bytes.toString("base64"),
      },
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function judgeImageRelevance(
  subject: MealImageSubject,
  candidates: StockCandidate[],
  deps: JudgeDeps,
): Promise<JudgeOutcome> {
  const max = deps.maxCandidates ?? DEFAULT_MAX_JUDGE_CANDIDATES;
  const shown: StockCandidate[] = [];
  const attachments: Anthropic.ImageBlockParam[] = [];
  for (const c of candidates.slice(0, max)) {
    const block = await downloadPreview(deps.fetch, c.previewUrl);
    if (!block) continue;
    shown.push(c);
    attachments.push(block);
  }
  if (shown.length === 0) {
    return {
      verdict: { accepted: null, reason: "no candidates to judge" },
      shown,
      costEstimateUsd: 0,
    };
  }

  const judgeInput = {
    meal: { title: subject.title, dishes: subject.dishTitles },
    candidates: shown.map((c, i) => ({
      index: i,
      provider: c.provider,
      description: c.description,
      width: c.width,
      height: c.height,
    })),
  };

  const result = await deps.ai(
    IMAGES_RELEVANCE_JUDGE_KEY,
    { judgeInput },
    RelevanceVerdictSchema,
    {
      prisma: deps.prisma,
      userId: deps.userId,
      temperature: 0,
      maxTokens: 400,
      attachments,
    },
  );

  if (!result.success) {
    return {
      verdict: null,
      shown,
      failureReason: result.reason,
      costEstimateUsd: result.metadata.costEstimateUsd ?? 0,
    };
  }
  const v = result.data;
  // A model index outside the shown list is a rejection, not a crash.
  const accepted = v.accepted != null && v.accepted < shown.length ? v.accepted : null;
  return {
    verdict: {
      accepted,
      reason: accepted == null && v.accepted != null ? `index ${v.accepted} out of range` : v.reason,
    },
    shown,
    costEstimateUsd: result.metadata.costEstimateUsd,
  };
}
