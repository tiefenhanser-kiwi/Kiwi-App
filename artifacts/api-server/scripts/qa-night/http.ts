// QA-NIGHT-1 — the HTTP client. Every call is recorded (R11 reads the log).
//
// It never throws on a status: a journey reads `status` and decides. A call is
// "unexpected" when its status is not 2xx and not in the step's `expect` list —
// R11 reports those, and a journey that cannot continue stops that path and
// says so. Writes are never retried (a 502 on a POST may have spent money);
// reads retry once on a transport failure, and the retry is in the log.
import type { CallRecord } from "./types";

export interface Reply<T = any> {
  status: number;
  body: T;
  ms: number;
}

export class Client {
  token: string | null = null;
  step = "setup";

  constructor(
    private readonly base: string,
    readonly household: string,
    private readonly log: CallRecord[],
  ) {}

  at(step: string): this {
    this.step = step;
    return this;
  }

  async req<T = any>(
    method: string,
    path: string,
    body?: unknown,
    opts: { expect?: number[]; token?: string | null } = {},
  ): Promise<Reply<T>> {
    const attempts = method === "GET" ? 2 : 1;
    let last: Reply<T> | null = null;
    for (let i = 0; i < attempts; i++) {
      const headers: Record<string, string> = { accept: "application/json" };
      const token = opts.token === undefined ? this.token : opts.token;
      if (token) headers.authorization = `Bearer ${token}`;
      if (body !== undefined) headers["content-type"] = "application/json";
      const t0 = Date.now();
      let status = 0;
      let text = "";
      try {
        const res = await fetch(this.base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(300_000),
        });
        status = res.status;
        text = await res.text();
      } catch (e) {
        text = String((e as Error).message ?? e);
      }
      const ms = Date.now() - t0;
      let parsed: any = text;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        /* keep text */
      }
      const ok = status >= 200 && status < 300;
      this.log.push({
        household: this.household,
        step: this.step,
        method,
        path: path.replace(/\?.*$/, (q) => q.replace(/=[^&]+/g, "=…")),
        status,
        ms,
        expected: opts.expect ?? [],
        ...(ok ? {} : { error: text.slice(0, 300) }),
      });
      last = { status, body: parsed as T, ms };
      if (status !== 0 && status !== 502 && status !== 503) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    return last!;
  }

  /** A call the journey cannot continue without. Throws with the body when it is not 2xx. */
  async must<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const r = await this.req<T>(method, path, body);
    if (r.status < 200 || r.status >= 300) {
      throw new JourneyError(`${this.step}: ${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
    }
    return r.body;
  }
}

/** A path that could not go on. Recorded on the household, and the rest of the household continues where it can. */
export class JourneyError extends Error {}
