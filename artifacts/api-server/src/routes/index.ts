import { Router, type IRouter } from "express";
import authRouter from "./auth";
import healthRouter from "./health";
import mealsRouter from "./meals";
import meRouter from "./me";
import recipesRouter from "./recipes";
import wizardRouter from "./wizard";

const router: IRouter = Router();

router.use(authRouter);
router.use(healthRouter);
router.use(meRouter);
router.use(mealsRouter);
router.use(recipesRouter);
router.use(wizardRouter);

export default router;
