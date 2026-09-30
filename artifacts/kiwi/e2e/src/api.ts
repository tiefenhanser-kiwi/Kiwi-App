// ─────────────────────────────────────────────────────────────────────────────
// The HTTP lane. Same origin the browser uses, so a call here and a call the
// screen makes are indistinguishable to the server.
//
// WHY THE HARNESS TALKS HTTP AT ALL, when the point is to drive the UI:
//
//   • plan CREATION is a setup step, not the thing under test. POST
//     /plans/from-meals is deterministic and free (no AI), so building the
//     corpus through it costs nothing and varies nothing. Driving the Pick
//     screen for it would test the picker, five times, instead of the grocery
//     and prep renders this pass is about.
//   • the RULE CHECKERS need structured rows — sectionKey, packCount, notes,
//     isRecurringItem — that the DOM does not carry. The same GET the screen
//     makes supplies them.
//   • and the cross-check in rules.ts then asserts the DOM text and the
//     structured rows agree, which is the one thing neither the census nor a
//     pure API test can see.
// ─────────────────────────────────────────────────────────────────────────────
import { API_BASE } from "./env";
import { readCreds } from "./creds";

export interface ApiCall {
  method: string;
  path: string;
  status: number;
  ms: number;
}

/** Every call the harness made, for the wall-time and latency columns. */
export const apiLog: ApiCall[] = [];

export class Api {
  private token: string | null = null;
  userId: string | null = null;

  private async once<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { allowStatus?: number[] } = {},
  ): Promise<T> {
    const t0 = Date.now();
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const ms = Date.now() - t0;
    apiLog.push({ method, path, status: res.status, ms });
    const text = await res.text();
    const ok = res.ok || (opts.allowStatus ?? []).includes(res.status);
    if (!ok) {
      const e = new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
      (e as { httpStatus?: number }).httpStatus = res.status;
      throw e;
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /**
   * ── 🔴 THE DEV SERVER RESTARTS UNDER YOU, AND THIS IS THE ONLY RETRY IN THE
   * HARNESS ────────────────────────────────────────────────────────────────
   *
   * `pnpm --filter @workspace/api-server dev` is `tsx watch`. While another
   * lane is editing artifacts/api-server/src — which, during this pass, one
   * was, continuously — every save kills the child mid-request and the proxy
   * answers `502 proxy error: read ECONNRESET`. That is a TRANSPORT failure:
   * the request never got a response, and nothing about the app is implicated.
   *
   * ⛔ IT RETRIES READS ONLY. A 502 on a POST is ambiguous by construction —
   * the server may have completed the work and died before answering — so a
   * blind retry on `generate-grocery-list` could spend a second Sonnet call and
   * leave two lists. Writes handle their own recovery by ASKING WHAT HAPPENED
   * (see generateGroceryList), never by repeating the request.
   *
   * Playwright's own `retries` stays 0: a flake a retry hides is the signal
   * this harness exists to report. This is the one exception, it is scoped to
   * one cause, and every retry is left in `apiLog` for the record.
   */
  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    opts: { allowStatus?: number[]; retryTransport?: boolean } = {},
  ): Promise<T> {
    const retry = opts.retryTransport ?? method === "GET";
    // Six attempts with a linear back-off sums to ~42s of patience. Measured,
    // not guessed: a `tsx watch` restart of this api-server closed the port for
    // 2–15s during this pass, and a 9s budget (the first version) ran out twice
    // on somebody else's save.
    const attempts = retry ? 6 : 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.once<T>(method, path, body, opts);
      } catch (err) {
        last = err;
        const status = (err as { httpStatus?: number }).httpStatus;
        const transport =
          status === 502 || status === 503 || /ECONNRESET|fetch failed/i.test(String(err));
        // ⚠️ A 502 WITH A JSON BODY IS THE APP TALKING, NOT THE TRANSPORT.
        // The proxy's own failure says "proxy error: … is the api-server
        // running"; the app's own 502s (prep-week's `assembly_invalid`,
        // `narration_incomplete`) are real answers and must never be retried —
        // each retry would spend another model call on a known refusal.
        const appLevel502 = /"reason"\s*:|"error"\s*:/.test(String(err));
        if (!transport || appLevel502 || i === attempts - 1) throw err;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
    throw last;
  }

  /** Lists on this account, newest first — the write-recovery read. */
  private async listsForPlan(planId: string): Promise<string[]> {
    const r = await this.call<{ groceryLists: { id: string; mealPlanInstanceId: string | null }[] }>(
      "GET",
      "/grocery-lists",
    );
    return r.groceryLists.filter((l) => l.mealPlanInstanceId === planId).map((l) => l.id);
  }

  /**
   * The API-side sign-in. The BROWSER signs in through the real form (see
   * signInThroughUi) — this is the token the harness itself needs for the
   * setup calls and the structured reads.
   */
  async login(): Promise<string> {
    const { email, password } = readCreds();
    const r = await this.call<{ authToken: string; user: { id: string } }>(
      "POST",
      "/auth/login",
      { email, password },
    );
    // ⚠️ THE FIELD IS `authToken`, NOT `token`. A harness that reads `token`
    // gets undefined, sends "Bearer undefined", and every subsequent call
    // answers 401 "invalid or expired token" — which reads like an auth bug in
    // the app rather than a typo in the test. Recorded because it cost time.
    this.token = r.authToken;
    this.userId = r.user.id;
    return r.authToken;
  }

  get authToken(): string {
    if (!this.token) throw new Error("not signed in");
    return this.token;
  }

  // ── setup ─────────────────────────────────────────────────────────────────

  /** Deterministic, no AI, no cost. */
  async planFromMeals(input: {
    mealIds: string[];
    planDurationDays: number;
    title?: string;
    localDate?: string;
  }): Promise<{ planId: string; planName: string | null }> {
    const r = await this.call<Record<string, unknown>>("POST", "/plans/from-meals", input);
    // The 201 body has been reshaped twice in this arc (Block 1 added meals[],
    // and "from-meals 201 has no name" was a Block 2 note). Read defensively
    // and resolve the name from the plan read instead of trusting this body.
    const plan = (r.plan ?? r) as Record<string, unknown>;
    const planId = String(plan.id ?? r.planId ?? "");
    if (!planId) throw new Error(`from-meals gave no plan id: ${JSON.stringify(r).slice(0, 300)}`);
    return { planId, planName: (plan.name as string | null) ?? null };
  }

  // ── grocery ───────────────────────────────────────────────────────────────

  /**
   * Spends: one grocery-list generation (Sonnet).
   *
   * ⚠️ THE 200 BODY IS `{ groceryListId }` AND NOTHING ELSE
   * (groceryLists.ts:523) — not `{ list }`, not `{ groceryList }`. The items
   * come from the follow-up GET, which is also what the screen does.
   */
  async generateGroceryList(planId: string): Promise<{ listId: string; recovered: boolean }> {
    try {
      const r = await this.call<Record<string, unknown>>(
        "POST",
        `/plans/${planId}/generate-grocery-list`,
      );
      const nested = (r.groceryList ?? r.list) as Record<string, unknown> | undefined;
      const listId = String(r.groceryListId ?? nested?.id ?? "");
      if (!listId) {
        throw new Error(`generate-grocery-list gave no list id: ${JSON.stringify(r).slice(0, 300)}`);
      }
      return { listId, recovered: false };
    } catch (err) {
      const status = (err as { httpStatus?: number }).httpStatus;
      const transport = status === 502 || status === 503;
      if (!transport) throw err;
      // ⛔ DO NOT REPEAT THE POST. Ask the server what happened instead: the
      // list may already exist, in which case a second generation would spend
      // a second Sonnet call for a duplicate. Only a plan with NO list at all
      // is generated again, and only once.
      await new Promise((r) => setTimeout(r, 4000));
      const existing = await this.listsForPlan(planId);
      if (existing.length > 0) return { listId: existing[0], recovered: true };
      const r2 = await this.call<Record<string, unknown>>(
        "POST",
        `/plans/${planId}/generate-grocery-list`,
      );
      const listId = String(r2.groceryListId ?? "");
      if (!listId) throw err;
      return { listId, recovered: true };
    }
  }

  async groceryList(listId: string): Promise<GroceryListResponse> {
    return this.call<GroceryListResponse>("GET", `/grocery-lists/${listId}`);
  }

  async plan(planId: string): Promise<PlanResponse> {
    return this.call<PlanResponse>("GET", `/plans/${planId}`);
  }

  // ── cook / prep ───────────────────────────────────────────────────────────

  async meal(mealId: string, planItemId?: string): Promise<MealDetail> {
    const q = planItemId ? `?planItemId=${encodeURIComponent(planItemId)}` : "";
    return this.call<MealDetail>("GET", `/meals/${mealId}${q}`);
  }

  /**
   * Free — BUG-018 B2 removed the sequencer's Sonnet call; pure arithmetic.
   *
   * ⚠️ NO REQUEST BODY. mealId travels in the path and the server loads all the
   * step data itself (lib/api/cooking.ts). Sending `{dishes:[…]}` also answers
   * 200, because Express ignores an unread body — so a harness that invents one
   * looks like it works and is in fact testing a contract the app never sends.
   */
  async cookingSequence(mealId: string, _unused?: undefined): Promise<CookingSequenceResponse> {
    return this.call<CookingSequenceResponse>("POST", `/meals/${mealId}/cooking-sequence`);
  }

  /**
   * Spends: one prep-week narration (Sonnet) — unless `cacheHit`.
   *
   * ⚠️ TWO DIFFERENT 502s COME OUT OF THIS ROUTE AND THEY MEAN OPPOSITE
   * THINGS, which is why the recovery is here and not in `call`:
   *
   *   • `502 {"reason":"assembly_invalid"}` / `"narration_incomplete"` — the
   *     APP refusing. The narration already ran, so the money is already
   *     spent, and repeating the request spends it again for the same refusal.
   *     Never retried.
   *   • `502 proxy error: read ECONNRESET` — the dev server's watcher restarted
   *     mid-request. Nothing is implicated and nothing may have been charged.
   *
   * The transport case retries ONCE, and it is close to free when the first
   * attempt got far enough to persist: `routes/cooking.ts` upserts
   * `prepWeekStructure` on success, so the retry comes back `cacheHit: true`
   * with no second model call. `cacheHit` is surfaced so the caller can say
   * which happened rather than guessing.
   */
  async prepWeek(planId: string, body: unknown = {}): Promise<PrepWeekResponse> {
    try {
      return await this.call<PrepWeekResponse>("POST", `/plans/${planId}/prep-week`, body);
    } catch (err) {
      const status = (err as { httpStatus?: number }).httpStatus;
      const appLevel = /"reason"\s*:/.test(String(err));
      if (appLevel || !(status === 502 || status === 503)) throw err;
      await new Promise((r) => setTimeout(r, 5000));
      return this.call<PrepWeekResponse>("POST", `/plans/${planId}/prep-week`, body);
    }
  }
}

// ── the wire shapes the harness actually reads ───────────────────────────────
//
// Declared, not imported from lib/api/*. The client's normalizeListItem DROPS
// fields the checkers need (and the client schema is .passthrough(), so the raw
// response carries more than the app's own types admit). Reading the raw body
// is the point.

export interface GroceryItemWire {
  id: string;
  ingredientId: string | null;
  displayName: string;
  quantity: number;
  unit: string;
  storeSection: string;
  isChecked: boolean;
  isOptional: boolean;
  isAmbiguous: boolean;
  isUniversalStaple: boolean;
  isUserPantryStaple: boolean;
  isRecurringItem: boolean;
  isUserAdded?: boolean;
  stapleOptedIn: boolean;
  notes: string | null;
  purchaseUnit?: string | null;
  purchaseQuantity?: number | null;
  purchaseDisplay?: string | null;
  purchaseUnitOverride?: string | null;
  purchaseQuantityOverride?: number | null;
  purchaseDisplayOverride?: string | null;
  packCount?: number | null;
  mealNames?: string[];
  deletedAt?: string | null;
}

export interface GroceryListResponse {
  list: {
    id: string;
    title: string;
    status: string;
    mealPlanInstanceId: string | null;
    items: GroceryItemWire[];
  };
  reconciled?: boolean;
}

export interface PlanResponse {
  plan: {
    id: string;
    name: string | null;
    startDate: string | null;
    endDate: string | null;
    items: {
      id: string;
      mealId: string;
      assignedDayOfWeek: string | null;
      assignedDate?: string | null;
      meal?: { id: string; title: string } | null;
      title?: string | null;
    }[];
  };
}

export interface MealDetail {
  [k: string]: unknown;
}

export interface CookingSequenceResponse {
  sequence: {
    sequenceIndex: number;
    dishId: string;
    originalStepIndex: number;
    startOffsetMinutes: number;
    reason?: string;
  }[];
  totalMinutes?: number;
  [k: string]: unknown;
}

export interface PrepWeekResponse {
  cacheHit: boolean;
  subset: boolean;
  result: unknown;
  planRevisionId?: string;
  promptVersion?: string;
  metadata?: { latencyMs?: number };
}
