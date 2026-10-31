import { Router, type IRouter } from "express";
import authRouter, { createAuthRouter } from "./auth";
import billingRouter, { createBillingRouter } from "./billing";
import builderRouter from "./builder";
import cookbookRouter from "./cookbook";
import cookingRouter from "./cooking";
import dishesRouter from "./dishes";
import groceryListsRouter from "./groceryLists";
import guestRouter, { createGuestRouter } from "./guest";
import healthRouter from "./health";
import homeRouter from "./home";
import internalRouter, { createInternalRouter } from "./internal";
import lifecycleEmailRouter, { createLifecycleEmailRouter } from "./lifecycleEmail";
import feedbackRouter from "./feedback";
import mealsRouter from "./meals";
import meRouter, { createMeRouter } from "./me";
import plansRouter from "./plans";
import playlistRouter from "./playlist";
import recipesRouter from "./recipes";
import storesRouter from "./stores";
import webhooksRouter, { createWebhooksRouter } from "./webhooks";
import wizardRouter from "./wizard";
import { readBillingConfig } from "../lib/billing/config";
import { readOAuthConfig } from "../lib/oauth/config";

export interface RootRouterDeps {
  /**
   * BUG-370 — the environment the env-reading routers are built from. Omitted (the
   * production path) → the modules' own default instances, which read `process.env`
   * exactly as before. Given → those routers are built from it instead, so a test of
   * the whole mounted surface (unauthenticatedSurface) answers the same on every
   * machine whatever its `.env` configures: Turnstile turns POST /guest/session's
   * tokenless probe into a 403, RevenueCat's auth turns its webhook's into a 401,
   * an OAuth audience changes the social doors' answer.
   *
   * Every router whose UNAUTHENTICATED answer can depend on the environment is built
   * from it here. Grocery lists also reads env (Instacart), but only behind
   * requireAuth, so its default instance is kept.
   */
  env?: NodeJS.ProcessEnv;
}

export function createRootRouter(deps: RootRouterDeps = {}): IRouter {
  const env = deps.env;
  const billingConfig = env ? readBillingConfig(env) : null;

  const router: IRouter = Router();

  router.use(env ? createAuthRouter({ oauthConfig: readOAuthConfig(env) }) : authRouter);
  // Row 9 (1.1) · Stripe S1 — the two hosted link-outs. Both member-only; both
  // answer 503 `billing_unavailable` until the deploy has Stripe.
  router.use(billingConfig ? createBillingRouter({ billingConfig }) : billingRouter);
  router.use(builderRouter);
  // BOOK-1S (D-WS9-312) — the Cookbook search. Member-only (requireAuth).
  router.use(cookbookRouter);
  router.use(cookingRouter);
  router.use(dishesRouter);
  router.use(groceryListsRouter);
  // Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — the guest lane. POST
  // /guest/session is the ONE unauthenticated route this block adds; the other
  // three sit behind requireGuestOrAuth.
  router.use(env ? createGuestRouter({ env }) : guestRouter);
  router.use(healthRouter);
  router.use(homeRouter);
  // Row 5 · Block 1c (D-WS9-248) — scheduler-only routes (OIDC-gated).
  router.use(env ? createInternalRouter({ env }) : internalRouter);
  // LIFE-1 — the lifecycle emails' one-click unsubscribe. UNAUTHENTICATED by
  // design: the signed token is the credential (lib/lifecycle/unsubscribe.ts).
  router.use(env ? createLifecycleEmailRouter({ env }) : lifecycleEmailRouter);
  // LIFE-1 — POST /me/feedback (requireAuth).
  router.use(feedbackRouter);
  router.use(billingConfig ? createMeRouter({ billingConfig }) : meRouter);
  router.use(mealsRouter);
  router.use(plansRouter);
  // WS9 Redesign Arc Block 1 — the playlist (D-WS9-234).
  router.use(playlistRouter);
  router.use(recipesRouter);
  // SHOP-1 (D-WS9-325) — the Shop Your Store registry, ranked by state.
  router.use(storesRouter);
  // Row 9 (1.1) · Stripe S1 Part E — the webhook. UNAUTHENTICATED by design: the
  // stripe-signature header over the RAW body is the credential. Its path is in
  // app.ts ROUTE_SCOPED_JSON_PATHS so the default JSON parser never touches it.
  router.use(billingConfig ? createWebhooksRouter({ billingConfig }) : webhooksRouter);
  router.use(wizardRouter);

  return router;
}

const router: IRouter = createRootRouter();

export default router;
