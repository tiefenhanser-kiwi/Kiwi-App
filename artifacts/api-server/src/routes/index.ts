import { Router, type IRouter } from "express";
import authRouter from "./auth";
import builderRouter from "./builder";
import cookingRouter from "./cooking";
import groceryListsRouter from "./groceryLists";
import healthRouter from "./health";
import mealsRouter from "./meals";
import meRouter from "./me";
import plansRouter from "./plans";
import recipesRouter from "./recipes";
import wizardRouter from "./wizard";

const router: IRouter = Router();

router.use(authRouter);
router.use(builderRouter);
router.use(cookingRouter);
router.use(groceryListsRouter);
router.use(healthRouter);
router.use(meRouter);
router.use(mealsRouter);
router.use(plansRouter);
router.use(recipesRouter);
router.use(wizardRouter);

export default router;
