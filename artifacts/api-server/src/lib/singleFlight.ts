// SERVER-8 D (BUG-572) — ONE CALL PER KEY AT A TIME, IN THIS PROCESS.
//
// QA-7: Cook Mode through a plan item POSTs /plans/:id/prep-week on every load, and on
// a stale cache that POST is the regenerate — a paid narration. Two loads 5 s apart both
// missed the cache (the first had not written it yet) and both paid. A key's second
// caller, while the first is still running, now waits for the first one's result.
//
// ⚠️ PROCESS-LOCAL. Cloud Run may run more than one instance and routes without
// affinity, so two requests that land on different instances still each run. A
// cross-instance guard needs shared state: a lease on the plan's PrepWeekStructure row
// (a column claimed by an atomic conditional UPDATE, the loser polling the cache) —
// a migration, so not here.

export interface SingleFlight<T> {
  /** Runs `fn` unless a call for `key` is in flight, in which case its result is shared. */
  run(key: string, fn: () => Promise<T>): Promise<{ value: T; shared: boolean }>;
  /** Keys in flight (tests). */
  readonly size: number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inflight = new Map<string, Promise<T>>();
  return {
    async run(key, fn) {
      const running = inflight.get(key);
      if (running) return { value: await running, shared: true };
      const p = fn().finally(() => inflight.delete(key));
      inflight.set(key, p);
      return { value: await p, shared: false };
    },
    get size() {
      return inflight.size;
    },
  };
}
