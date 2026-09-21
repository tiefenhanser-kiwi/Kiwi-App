// Plan Review "Order Online" → the ordering surface (Row 8 Block 3).
//
// Block 2 put the Instacart CTA on the grocery detail screen; Block 3 moved it
// to the top of that screen and retired the D-WS9-158 "Coming soon" stub on
// Plan Review's "Order Online" cell. The cell is now Kiwi's entry to ordering:
// it lands on the plan's grocery list, where the hand-off actually happens.
// "Grocery List" and "Order Online" share that destination BY DESIGN — one is
// view/edit intent, the other is go-shop intent — and a vendor-selection page
// is deferred until there is a second vendor.
//
// Two paths:
//   has-list → navigate straight to /grocery-list/[id]. One tap.
//   no-list  → CONFIRM before generating. Generation is slow, and Hans's
//              device ruling is verbatim: "I don't want someone stuck on a
//              loading page after they pressed order online out of
//              curiosity." "Create list" runs the screen's EXISTING generate
//              flow (handleGroceryListPress → generateGroceryListForPlan →
//              dispatchGenerateResult) — one request path, one mapping
//              (lib/groceryHandoff.ts); nothing is re-inlined here.
//
// ⚠️ No time estimate in the copy. Nothing in canon measures grocery-list
// generation end to end, and an unmeasured number in user-facing copy is what
// §27 forbids. "Builds it", not "takes about N seconds".
//
// ── Where "has a list" comes from ──────────────────────────────────────────
// GET /plans/:id carries no grocery-list pointer (PlanDetailSchema has none;
// the server route reads none), so the screen reads what the app ALREADY
// holds, cheapest first, with no network on the tap:
//   1. Home's activePlan.groceryListId (["home","payload"]) — the server's
//      "non-archived list id or null", but only for the active plan.
//   2. The Groceries tab's cached index (["groceries","list",*]) matched on
//      mealPlanInstanceId === planId. The server excludes archived rows from
//      that index, so a match is a live list — the same status rule the
//      generate endpoint's 409 check uses. Edge: the index is paginated
//      (BUG-139 stopgap asks for limit=100 and follows no cursor), so a plan
//      older than the newest 100 lists is unknowable here.
// Both are CACHE reads and may be absent or stale. That is safe in one
// direction: an unknown or stale "no list" costs one extra confirmation and
// then the existing flow's 409 → navigate lands on the list anyway. The
// other direction (a cached id for a list that has since been archived) is
// bounded by the compost cascade — a composted plan hides these CTAs
// (D-WS9-090 guard) — and lands on the list screen's own not-found state.

// ── Copy (canonical here; Plan Review renders these verbatim) ──────────────
export const ORDER_ONLINE_CONFIRM_TITLE = "Create your grocery list?";
export const ORDER_ONLINE_CONFIRM_BODY =
  "Kiwi builds it from this plan's meals. You'll review it before anything is sent to a store.";
export const ORDER_ONLINE_CONFIRM_CANCEL = "Not now";
export const ORDER_ONLINE_CONFIRM_CREATE = "Create list";

/** The slice of Home's payload this reads — structural, so the caller passes
 *  the cached HomePayload (or undefined) without a type dependency here. */
export interface HomeActivePlanPointer {
  activePlan: { id: string; groceryListId: string | null } | null;
}

/** The slice of a Groceries-index row this reads. */
export interface GroceryIndexPointer {
  id: string;
  mealPlanInstanceId: string | null;
}

export interface KnownListSources {
  home: HomeActivePlanPointer | undefined;
  /** Every cached ["groceries","list",*] page the client holds, flattened. */
  groceryIndex: ReadonlyArray<GroceryIndexPointer>;
}

/**
 * The plan's grocery-list id if the app already knows one, else null. Pure.
 * Home first (authoritative pointer for the active plan), then the index.
 */
export function resolveKnownGroceryListId(
  planId: string,
  sources: KnownListSources,
): string | null {
  const active = sources.home?.activePlan;
  if (active && active.id === planId && active.groceryListId) {
    return active.groceryListId;
  }
  const row = sources.groceryIndex.find((l) => l.mealPlanInstanceId === planId);
  return row?.id ?? null;
}

export type OrderOnlineAction =
  | { kind: "navigate"; listId: string }
  | { kind: "confirm" };

/** Pure decision: a known list → navigate; otherwise ask before generating. */
export function decideOrderOnline(knownListId: string | null): OrderOnlineAction {
  if (knownListId) return { kind: "navigate", listId: knownListId };
  return { kind: "confirm" };
}

/** What the confirmation asks the screen to render. The screen maps this
 *  onto its own confirm mechanism (Plan Review uses Alert.alert). */
export interface OrderOnlineConfirmSpec {
  title: string;
  body: string;
  cancelLabel: string;
  confirmLabel: string;
  /** "Create list" — runs the screen's existing generate flow. */
  onConfirm: () => void;
}

export interface OrderOnlineSinks {
  navigate: (listId: string) => void;
  confirm: (spec: OrderOnlineConfirmSpec) => void;
  /** The screen's existing generate-or-open flow (handleGroceryListPress). */
  generate: () => void;
}

/**
 * Resolve the tap and deliver it. Returns the action so a test can assert on
 * what happened. Lives here because Plan Review is under `app/`, outside the
 * mobile test glob — the same reason dispatchGenerateResult exists.
 */
export function dispatchOrderOnline(
  planId: string,
  sources: KnownListSources,
  sinks: OrderOnlineSinks,
): OrderOnlineAction {
  const action = decideOrderOnline(resolveKnownGroceryListId(planId, sources));
  if (action.kind === "navigate") {
    sinks.navigate(action.listId);
  } else {
    sinks.confirm({
      title: ORDER_ONLINE_CONFIRM_TITLE,
      body: ORDER_ONLINE_CONFIRM_BODY,
      cancelLabel: ORDER_ONLINE_CONFIRM_CANCEL,
      confirmLabel: ORDER_ONLINE_CONFIRM_CREATE,
      onConfirm: sinks.generate,
    });
  }
  return action;
}
