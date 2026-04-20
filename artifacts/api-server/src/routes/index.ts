import { Router, type IRouter } from "express";
import healthRouter from "./health";
import plansRouter from "./plans";
import recipesRouter from "./recipes";

const router: IRouter = Router();

router.use(healthRouter);
router.use(plansRouter);
router.use(recipesRouter);

export default router;
