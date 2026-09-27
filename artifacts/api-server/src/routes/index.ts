import { Router, type IRouter } from "express";
import authRouter from "./auth";
import billingRouter from "./billing";
import builderRouter from "./builder";
import cookingRouter from "./cooking";
import dishesRouter from "./dishes";
import groceryListsRouter from "./groceryLists";
import guestRouter from "./guest";
import healthRouter from "./health";
import homeRouter from "./home";
import internalRouter from "./internal";
import mealsRouter from "./meals";
import meRouter from "./me";
import plansRouter from "./plans";
import playlistRouter from "./playlist";
import recipesRouter from "./recipes";
import wizardRouter from "./wizard";

const router: IRouter = Router();

router.use(authRouter);
// Row 9 (1.1) · Stripe S1 — the two hosted link-outs. Both member-only; both
// answer 503 `billing_unavailable` until the deploy has Stripe.
router.use(billingRouter);
router.use(builderRouter);
router.use(cookingRouter);
router.use(dishesRouter);
router.use(groceryListsRouter);
// Row 13 "Test Kitchen" · Block 1 (D-WS9-259) — the guest lane. POST
// /guest/session is the ONE unauthenticated route this block adds; the other
// three sit behind requireGuestOrAuth.
router.use(guestRouter);
router.use(healthRouter);
router.use(homeRouter);
// Row 5 · Block 1c (D-WS9-248) — scheduler-only routes (OIDC-gated).
router.use(internalRouter);
router.use(meRouter);
router.use(mealsRouter);
router.use(plansRouter);
// WS9 Redesign Arc Block 1 — the playlist (D-WS9-234).
router.use(playlistRouter);
router.use(recipesRouter);
router.use(wizardRouter);

export default router;
