import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import meRouter from "./me";
import plansRouter from "./plans";
import recipesRouter from "./recipes";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(meRouter);
router.use(plansRouter);
router.use(recipesRouter);

export default router;
