import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams, useRouter } from "expo-router";
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from "react-native-draggable-flatlist";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { CombineReview } from "@/components/CombineReview";
import { DishChooserSheet } from "@/components/DishChooserSheet";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { SectionLabel } from "@/components/SectionLabel";
import { SortDropdown, type SortKey } from "@/components/SortDropdown";
import {
  Colors,
  Palette,
  Radius,
  Spacing,
  Typography,
} from "@/constants/tokens";
import { useApp } from "@/contexts/AppContext";
import { resolveDisplayTitle } from "@/components/DisplayTitle";
import { fromServerDifficulty, toServerDifficulty } from "@/lib/api/builder";
import { useDishes } from "@/hooks/useDishes";
import { savedDishFromListItem } from "@/lib/dishes/savedDishFromListItem";
import { resolvePostSaveNav } from "@/lib/builder/postSaveNav";
import {
  armDishHandoff,
  disarmDishHandoff,
} from "@/lib/builder/dishHandoff";
import {
  DISH_DISABLED_SORT_KEYS,
  DISH_SORT_LABEL_OVERRIDES,
  toDishSortKey,
} from "@/lib/dishes/sortMapping";
import type { SaveMealInput } from "@/lib/api/meals";
import { useMeal } from "@/hooks/useMeal";
import { CUISINES_TIER_1, CUISINES_TIER_2 } from "@/lib/domain";
import { formatMacroLine } from "@/lib/format/macros";
import { isQuantityInvalid } from "@/lib/quantity";
import {
  buildManualSaveMealInput,
  buildRecipeOverride,
  buildUpdateMealInput,
  draftDishToBuilderDish,
  hydrateBuilderDishesFromDraft,
  hydrateBuilderDishesFromMeal,
  newDish as makeNewDish,
  newIngredient as makeNewIngredient,
  newStep as makeNewStep,
  pickSavedDishToBuilderDish,
  validateManualSave,
  type BuilderDish,
  type BuilderIngredient,
  type BuilderStep,
  type Difficulty,
} from "@/lib/meal-builder-state";
import {
  getFeaturedDishes,
  getSavedDishes,
  getTopRatedDishes,
} from "@/lib/stubs";
import type { DraftMeal, SavedDish } from "@/lib/types";

type Mode = "manual" | "combine" | "ai" | null;

const SERVINGS_MIN = 1;
const SERVINGS_MAX = 12;

let nextUid = 1;
const allocUid = () => nextUid++;

// WS7-6 B-fix Block 3 — Mode-C dish picker mirrors the Recipes→Dishes sort UX
// (Hans ruled parity across dish surfaces). `times_cooked` relabels to "Most
// used"; `last_cooked` is greyed (no Dish.lastUsedAt write path, D-WS7-111).
// WS7-6 C-fix Block 4 — the label/disabled consts + toDishSortKey now live in
// the shared lib/dishes/sortMapping (Recipes→Dishes, Mode-C, and the
// Meal→Add-Dish sheet all share them).

const newIngredient = (
  partial?: Partial<Omit<BuilderIngredient, "uid">>,
): BuilderIngredient => makeNewIngredient(allocUid, partial);

const newDish = (
  partial?: Partial<Omit<BuilderDish, "uid" | "ingredients" | "steps">> & {
    ingredients?: BuilderIngredient[];
    steps?: BuilderStep[];
  },
): BuilderDish => makeNewDish(allocUid, partial);

const newStep = (
  partial?: Partial<Omit<BuilderStep, "uid">>,
): BuilderStep => makeNewStep(allocUid, partial);

// WS7-6 Block 1F — summary copy near the Save button. Lists only the
// fields still missing so the message shrinks as the user fills the
// form. Kept here rather than in lib/meal-builder-state because the
// copy is UI surface, not validation logic.
function summarizeMissing(v: {
  nameMissing: boolean;
  ingredientMissing: boolean;
  stepMissing: boolean;
  quantityInvalid: boolean;
}): string {
  const parts: string[] = [];
  if (v.nameMissing) parts.push("a name");
  if (v.ingredientMissing) parts.push("at least one ingredient");
  if (v.stepMissing) parts.push("at least one step");
  // FU3 — surfaces near Save so a blocked save from an off-screen invalid
  // quantity isn't a silent dead button (the field itself is also red-badged).
  if (v.quantityInvalid) parts.push("a valid quantity on every ingredient");
  return `Needs: ${parts.join(", ")}.`;
}

export default function MealBuilderScreen() {
  const {
    mealId,
    planId,
    planItemId,
    mode: modeParam,
    draftSource,
    draftJson,
    addToPlanId,
    addDishId,
  } = useLocalSearchParams<{
    mealId?: string;
    planId?: string;
    planItemId?: string;
    mode?: "manual" | "combine" | "ai";
    draftSource?: "url" | "image" | "text";
    draftJson?: string;
    addToPlanId?: string;
    addDishId?: string;
  }>();
  const isEditFromPlanContext = !!(mealId && planId && planItemId);
  // WS7-6 1G — library-context edit (Meal Detail → Edit, no plan params).
  // Routes to PATCH /me/meals/:id with NO §2.5 prompt (PRD §8.4.4).
  const isLibraryEditContext = !!(mealId && !planId && !planItemId);
  // WS9 3f-3 (Thread C) — the Change-Recipe client branch (`source=change-recipe`)
  // was deleted: unreachable (Phase 0 proof — no nav/route/deep-link/test ever set
  // the param; the row action was removed in R-3d-2). The backend is RETAINED
  // (D-WS7-216) and `changeRecipeForPlanItem` still powers the live "just this
  // time / apply always" edit flow below — that is NOT part of this deletion.

  // WS7-6 Block 1E — Surface 1 (create) wiring.
  // WS7-6 1F — updateMeal mutator for the library / "Apply always" edit paths.
  const {
    saveMeal,
    updateMeal,
    addMealToPlan,
    changeMealForPlanItem,
    changeRecipeForPlanItem,
  } = useApp();
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  // ② synchronous double-tap guard, shared by all three save paths (create,
  // runUpdateMeal, runSaveJustThisTime). `saving` state drives the button UI but
  // is read stale on a same-tick second tap; the ref is set/reset synchronously
  // so a rapid double-tap can't fire a second create POST and dupe the meal.
  const savingRef = useRef(false);

  // WS7-6 1G — hydration now reads from the server (GET /meals/:id) instead
  // of the lib/stubs catalog. Without this, a library-context edit would
  // PATCH with stub-derived data and wipe the real meal's sub-graph.
  //
  // WS7-7-A B5 follow-on (D-WS7-141 Fix 1a) — thread planItemId so an
  // edit-from-plan / change-recipe open seeds from the per-instance override
  // (GET /meals/:id?planItemId= → composeMealDetail applies recipeOverrideJson)
  // instead of the canonical meal. planItemId is undefined in library-edit
  // context → canonical, unchanged. Without this the form re-seeds the
  // un-removed ingredient set and a "Just this time" save silently clobbers
  // the prior override (the removal reappears). This also aligns the editor
  // onto the cache key ["meals","detail",id,planItemId] the B5 write invalidates.
  const mealDetailQuery = useMeal(mealId ?? "", planItemId);
  const sourceMeal = mealDetailQuery.data ?? null;

  const draftMeal = useMemo<DraftMeal | null>(() => {
    if (!draftJson) return null;
    try {
      return JSON.parse(draftJson) as DraftMeal;
    } catch (e) {
      console.error("[meal-builder] failed to parse draftJson", e);
      return null;
    }
  }, [draftJson]);

  const [mode, setModeState] = useState<Mode>(() => {
    if (mealId) return "manual";
    if (draftJson) return "manual";
    // addDishId means "user wants to build a meal around this dish" —
    // skip the mode picker and drop them into the manual editor with
    // the dish already injected (see the addDishId effect below).
    if (addDishId) return "manual";
    if (modeParam === "manual" || modeParam === "combine") return modeParam;
    return null;
  });

  // ── Manual-mode state ───────────────────────────────────────────
  const [mealName, setMealName] = useState("");
  const [cuisineType, setCuisineType] = useState("");
  const [cuisineExpanded, setCuisineExpanded] = useState(false);
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [estimatedTimeMinutes, setEstimatedTimeMinutes] = useState("30");
  const [servingsDefault, setServingsDefault] = useState(4);
  const [dishes, setDishes] = useState<BuilderDish[]>(() => [newDish()]);
  // WS7-6 Fix-Block 1B — steps now live per-dish on BuilderDish.steps
  // (matches the server's polymorphic (ownerType, ownerId) model). The
  // pre-fix meal-level `steps[]` state was flattened from all dishes at
  // hydration and re-attached to dish[0] on save, so swapping dish[1]
  // left stale steps stuck on dish[0]. Optional per PRD §10.5.
  const [notes, setNotes] = useState("");

  // ── Combine-mode state ──────────────────────────────────────────
  // WS7-6 Block 1D — Mode C picker reads the real /me/dishes catalog so the
  // `selectedDishIds` are real server ids (needed by the POST /me/meals
  // `kind:"link"` ownership check). The list-shape endpoint omits per-dish
  // ingredients; CombineReview gracefully degrades to showing dish names only
  // (a future block can fetch detail per selected id if review parity is
  // required pre-save).
  // WS7-6 B-fix Block 3 — Mode C uses the shared infinite useDishes hook
  // (sort + cursor pagination) for parity with Recipes→Dishes. Sort defaults
  // to alpha; the picker's SortDropdown drives the server ?sort= param.
  const [combineSortKey, setCombineSortKey] = useState<SortKey>("alpha");
  const dishesQuery = useDishes(["my_dishes"], toDishSortKey(combineSortKey));
  // WS7-6 C-fix Block 4 — the wire→SavedDish field map is now the shared
  // savedDishFromListItem adapter (also used by the Meal→Add-Dish sheet).
  const savedDishes = useMemo<SavedDish[]>(
    () => dishesQuery.dishes.map(savedDishFromListItem),
    [dishesQuery.dishes],
  );
  const [selectedDishIds, setSelectedDishIds] = useState<string[]>([]);
  const [combineReview, setCombineReview] = useState(false);

  // ── Dish chooser sheet (Mode B "+ Add Dish") ────────────────────
  const [dishChooserVisible, setDishChooserVisible] = useState(false);
  // WS7-6 C-fix Block 4 — uid of the dish whose name input should auto-focus.
  // Set when "Create from scratch" appends a blank dish so the user lands in
  // the editor (the KeyboardAwareScrollView scrolls the focused input into
  // view). Stays null otherwise so opening the screen never auto-focuses.
  const [autoFocusDishUid, setAutoFocusDishUid] = useState<number | null>(null);

  // WS7-6 Block 1F — save-disabled clarity. Floor-level interaction
  // tracking: flipped to true on the FIRST Save tap; gates inline-error
  // + summary-line display so a pristine form doesn't shout at the user.
  // Per-field touched-on-blur would be a nice-to-have but the prompt
  // calls saveAttempted the floor and we stuck to it.
  const [saveAttempted, setSaveAttempted] = useState(false);

  // WS7-6 1G — hydration from GET /meals/:id (MealDetail shape). Field-name
  // translations from the renamed-flat server payload back to the form's
  // domain naming:
  //   cuisine     (always "" when none) → cuisineType
  //   minutes                            → estimatedTimeMinutes
  //   servings                           → servingsDefault
  //   difficulty (server "fancy")        → UI "hard" via fromServerDifficulty
  //   dishes[].title                     → BuilderDish.name
  //   dishes[].steps[]                   → BuilderDish.steps (per-dish own.)
  //   notes                              → null on the server, so "" here
  //
  // WS7-6 Fix-Block 1B: per-dish step ownership. The pre-fix code flattened
  // WS7-6 G3-fix — clear any armed dish handoff if this builder unmounts before
  // the parsed dish comes back, so a stale closure can't set state post-unmount.
  useEffect(() => disarmDishHandoff, []);

  // every dish's steps into a single meal-level state, which left stale
  // steps stuck on dish[0] after a sub-dish swap.
  useEffect(() => {
    if (!sourceMeal) return;
    setMealName(sourceMeal.title);
    setCuisineType(sourceMeal.cuisine);
    if (
      sourceMeal.cuisine &&
      (CUISINES_TIER_2 as readonly string[]).includes(sourceMeal.cuisine)
    ) {
      setCuisineExpanded(true);
    }
    setDifficulty(
      fromServerDifficulty(
        sourceMeal.difficulty as "easy" | "medium" | "fancy",
      ),
    );
    setEstimatedTimeMinutes(String(sourceMeal.minutes));
    // WS7-8b BUG-002 — the edit-side servings seed (D-WS7-169 keystone) was
    // intentionally REVERTED. Edit mode no longer authors servings: the
    // stepper is create-only and servingsDefault is dropped from the PATCH
    // body, so there is nothing to seed here. Do NOT restore a
    // setServingsDefault(sourceMeal.effectiveServings) line — it would feed a
    // count that disagrees with the unscaled ingredient amounts. The
    // Meal-Detail half of the keystone (effectiveServings → render-time
    // servingsMultiplier) STAYS.
    setDishes(hydrateBuilderDishesFromMeal(sourceMeal, allocUid));
    // notes is intentionally null on the server today (see meals.test.ts and
    // MealDetailSchema). Reset to empty so a re-hydrate doesn't strand stale
    // text from a previous mount.
    setNotes("");
  }, [sourceMeal]);

  // Pre-population from imported draft (one-shot on mount when draftJson present).
  // Distinct from sourceMeal: no Meal record yet, so save = create.
  //
  // WS7-6 Fix-Block 1B: drafts carry a single meal-level steps[] (the
  // importer doesn't know per-dish ownership), so for multi-dish drafts
  // all steps land on dish[0] — the §10.5.4 "meal IS the dish" collapse.
  useEffect(() => {
    if (sourceMeal || !draftMeal) return;
    setMealName(draftMeal.title);
    setCuisineType(draftMeal.cuisineType ?? "");
    if (
      draftMeal.cuisineType &&
      (CUISINES_TIER_2 as readonly string[]).includes(draftMeal.cuisineType)
    ) {
      setCuisineExpanded(true);
    }
    setDifficulty(draftMeal.difficulty);
    setEstimatedTimeMinutes(String(draftMeal.estimatedTimeMinutes));
    setServingsDefault(draftMeal.servingsDefault);
    setDishes(hydrateBuilderDishesFromDraft(draftMeal, allocUid));
    setNotes(draftMeal.notes ?? "");
  }, [draftMeal, sourceMeal]);

  // PRD §10.5 / WS5-5O — entry from Recipes Dishes view "Add to Meal" sheet
  // (Create-new-meal path) seeds a fresh meal with the dish injected as
  // its first BuilderDish. Only runs in fresh-create mode (no mealId,
  // no draftJson) so we never overwrite an existing meal's dishes.
  useEffect(() => {
    if (!addDishId || mealId || draftJson) return;
    const all: SavedDish[] = [
      ...getSavedDishes(),
      ...getFeaturedDishes(),
      ...getTopRatedDishes(),
    ];
    const dish = all.find((d) => d.id === addDishId);
    if (!dish) {
      console.warn("[meal-builder] addDishId not found in stubs", { addDishId });
      return;
    }
    setDishes([
      newDish({
        name: dish.name,
        ingredients: dish.ingredients.length
          ? dish.ingredients.map((ing) =>
              newIngredient({
                quantity: String(ing.quantity),
                unit: ing.unit,
                name: ing.name,
              }),
            )
          : [newIngredient()],
      }),
    ]);
  }, [addDishId, mealId, draftJson]);

  const headerTitle = sourceMeal
    ? `Edit Meal: ${resolveDisplayTitle(sourceMeal)}`
    : mealId
        // mealId present but hydration not resolved yet — neutral header so
        // the screen doesn't flash a misleading "Create Meal" title before
        // GET /meals/:id returns.
        ? "Edit Meal"
        : draftMeal
          ? "Review imported recipe"
          : "Create Meal";

  // ── Mode switching with unsaved-data guard ──────────────────────
  const hasManualData = (): boolean => {
    if (mealName.trim().length > 0) return true;
    if (cuisineType.trim().length > 0) return true;
    if (notes.trim().length > 0) return true;
    if (
      dishes.some(
        (d) =>
          d.name.trim() ||
          d.ingredients.some((i) => i.quantity || i.unit || i.name) ||
          d.steps.some((st) => st.text.trim()),
      )
    ) {
      return true;
    }
    return false;
  };

  const hasCombineData = (): boolean => selectedDishIds.length > 0;

  const trySetMode = (next: Mode) => {
    if (next === mode) return;
    const dirty =
      (mode === "manual" && hasManualData()) ||
      (mode === "combine" && hasCombineData());
    if (dirty) {
      Alert.alert(
        "Switch modes?",
        "Your current entries will be set aside but kept. You can switch back without losing anything.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Switch",
            style: "default",
            onPress: () => {
              Keyboard.dismiss();
              setModeState(next);
            },
          },
        ],
      );
    } else {
      Keyboard.dismiss();
      setModeState(next);
    }
  };

  // ── Manual-mode mutators ────────────────────────────────────────
  const removeDish = (uid: number) =>
    setDishes((prev) => prev.filter((d) => d.uid !== uid));
  const updateDishName = (uid: number, name: string) =>
    setDishes((prev) =>
      prev.map((d) => (d.uid === uid ? { ...d, name } : d)),
    );
  const addIngredient = (dishUid: number) =>
    setDishes((prev) =>
      prev.map((d) =>
        d.uid === dishUid
          ? { ...d, ingredients: [...d.ingredients, newIngredient()] }
          : d,
      ),
    );
  const removeIngredient = (dishUid: number, ingUid: number) =>
    setDishes((prev) =>
      prev.map((d) =>
        d.uid === dishUid
          ? {
              ...d,
              ingredients: d.ingredients.filter((i) => i.uid !== ingUid),
            }
          : d,
      ),
    );
  const updateIngredient = (
    dishUid: number,
    ingUid: number,
    patch: Partial<Omit<BuilderIngredient, "uid">>,
  ) =>
    setDishes((prev) =>
      prev.map((d) =>
        d.uid === dishUid
          ? {
              ...d,
              ingredients: d.ingredients.map((i) =>
                i.uid === ingUid ? { ...i, ...patch } : i,
              ),
            }
          : d,
      ),
    );

  // WS7-6 Fix-Block 1B — step mutators are now per-dish (each dish owns
  // its own steps[]). dishUid identifies which dish's steps array to
  // mutate; targeting the wrong dish would re-create the original swap
  // bug.
  const addStep = (dishUid: number) =>
    setDishes((prev) =>
      prev.map((d) =>
        d.uid === dishUid ? { ...d, steps: [...d.steps, newStep()] } : d,
      ),
    );
  const removeStep = (dishUid: number, stepUid: number) =>
    setDishes((prev) =>
      prev.map((d) =>
        d.uid === dishUid
          ? { ...d, steps: d.steps.filter((st) => st.uid !== stepUid) }
          : d,
      ),
    );
  const updateStep = (
    dishUid: number,
    stepUid: number,
    patch: Partial<Omit<BuilderStep, "uid">>,
  ) =>
    setDishes((prev) =>
      prev.map((d) =>
        d.uid === dishUid
          ? {
              ...d,
              steps: d.steps.map((st) =>
                st.uid === stepUid ? { ...st, ...patch } : st,
              ),
            }
          : d,
      ),
    );
  const reorderStepsForDish = (dishUid: number, next: BuilderStep[]) =>
    setDishes((prev) =>
      prev.map((d) => (d.uid === dishUid ? { ...d, steps: next } : d)),
    );

  // Stable identity so DishPickerRow's memoization holds across parent re-renders
  // (e.g. while user types in MetaFields above the picker).
  const toggleSelectedDish = useCallback((id: string) => {
    setSelectedDishIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  // ── Save ────────────────────────────────────────────────────────
  // WS7-6 Block 1F — manual-mode validation is pulled out to
  // validateManualSave so the predicate + per-field reasons are unit-
  // tested directly. PRD §10.5.6: name + ≥1 named ingredient + ≥1 step.
  //
  // Predicate tightening vs. pre-F: the old predicate accepted an
  // ingredient row with ONLY a quantity (no name). The save serializer
  // at meal-builder-state.ts ~L249 has always filtered ingredients to
  // those with non-empty NAMES, so the old predicate left a gap where
  // Save would enable then throw on tap. F closes that.
  //
  // Step requirement is NEW in F (was optional pre-F). The walk lives
  // in validateManualSave and is the single uniform dishes[].steps[]
  // walk — post-Fix-1B per-dish ownership means there's no meal-level
  // surface to also check.
  const manualValidation = useMemo(
    () => validateManualSave({ mealName, dishes }),
    [mealName, dishes],
  );
  const manualSaveInvalid =
    manualValidation.nameMissing ||
    manualValidation.ingredientMissing ||
    manualValidation.stepMissing ||
    manualValidation.quantityInvalid;
  // Mode C is intentionally NOT step-gated, NOR ingredient-gated: combine-mode
  // dishes are server-linked saved dishes (kind:"link") whose steps +
  // ingredients live with the linked dish, not this builder. The dishesQuery
  // list-shape doesn't carry them so the builder couldn't validate them anyway.
  // The only Mode-C save requirement is a meal name (PRD §10.5.3) + ≥1 dish.
  //
  // WS7-6 G1 — Mode-C validation now mirrors manual mode's saveAttempted
  // pattern (was a flat `combineSaveDisabled` that greyed the Save button dead
  // with no messaging — see the save-bar + CombineReview below). selectedDish
  // can't actually be empty on the review surface (Continue gates ≥1), but we
  // keep the check so the predicate is complete.
  const combineNameMissing = mealName.trim().length === 0;
  const combineDishMissing = selectedDishIds.length === 0;
  const combineSaveInvalid = combineNameMissing || combineDishMissing;

  // WS7-6 Block 1E — translate form state to the POST /me/meals payload.
  // Throws a user-facing Error when validation fails so the caller can
  // surface a friendly Alert and stay on screen.
  //
  // WS7-6 Fix-Block 1B — manual-mode body is built by the pure helper in
  // lib/meal-builder-state.ts (so the per-dish step ownership can be
  // unit-tested directly). Combine-mode stays inline because it composes
  // kind:"link" entries from selectedDishIds.
  const buildSaveMealInput = (): SaveMealInput => {
    if (mode === "combine") {
      const trimmedName = mealName.trim();
      if (!trimmedName) {
        throw new Error("Add a meal name.");
      }
      if (selectedDishIds.length === 0) {
        throw new Error("Pick at least one dish to combine.");
      }
      const minutes = parseInt(estimatedTimeMinutes, 10);
      return {
        title: trimmedName,
        description: notes.trim() || undefined,
        cuisineType: cuisineType.trim() || undefined,
        servingsDefault,
        estimatedTimeMinutes:
          Number.isFinite(minutes) && minutes > 0 ? minutes : undefined,
        difficulty: toServerDifficulty(difficulty),
        sourceType: "manual",
        dishes: selectedDishIds.map((id, i) => ({
          kind: "link",
          dishId: id,
          role: i === 0 ? "main" : "side",
          positionIndex: i,
        })),
      };
    }
    return buildManualSaveMealInput({
      mealName,
      cuisineType,
      difficulty,
      estimatedTimeMinutes,
      servingsDefault,
      notes,
      dishes,
      sourceType: draftMeal ? "directed" : "manual",
    });
  };

  // WS7-7-A B5 — "Just this time": persist the edit as the plan item's
  // recipeOverrideJson (D-WS7-090). The global Meal is untouched; only this
  // plan instance + its grocery list reflect the change.
  const runSaveJustThisTime = async (input: SaveMealInput) => {
    if (!planId || !planItemId) return;
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      await changeRecipeForPlanItem(planId, planItemId, buildRecipeOverride(input));
      Alert.alert("Saved for this plan", `${input.title} was updated here.`, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save your changes. Try again?";
      Alert.alert("Couldn't save meal", msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // WS7-6 1F + 1G — perform the actual PATCH for both the library-context
  // edit (no prompt) and the §2.5 "Apply always" branch. Shared helper so
  // the success/error/post-success-routing copy stays consistent.
  // WS7-7-A B5 — bumpPlanId is set on the "Apply always"-from-a-plan path so
  // the current plan's grocery list reconciles to the global edit.
  //
  // WS7-7-A B5 follow-on (D-WS7-141 Fix 1b) — overridePlanItemId is set on the
  // apply-always-from-a-plan path. Per the locked product model, "Apply always"
  // writes the per-instance override (so THIS plan keeps the edit) AND PATCHes
  // the template (so future plans pull it). Both writes derive from the SAME
  // on-screen `input` via buildRecipeOverride / buildUpdateMealInput. The
  // override is written FIRST so the plan-local guarantee lands even if the
  // template PATCH fails; a failure of either surfaces the shared error Alert
  // rather than half-applying silently. Library-context edits pass neither
  // bumpPlanId nor overridePlanItemId → template-only, unchanged.
  const runUpdateMeal = async (
    id: string,
    input: SaveMealInput,
    bumpPlanId?: string,
    overridePlanItemId?: string,
  ) => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (bumpPlanId && overridePlanItemId) {
        await changeRecipeForPlanItem(
          bumpPlanId,
          overridePlanItemId,
          buildRecipeOverride(input),
        );
      }
      await updateMeal(id, {
        ...buildUpdateMealInput(input),
        ...(bumpPlanId ? { bumpPlanId } : {}),
      });
      Alert.alert("Saved", `${input.title} was updated.`, [
        { text: "OK", onPress: () => router.back() },
      ]);
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't save your changes. Try again?";
      Alert.alert("Couldn't save meal", msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const onSave = async () => {
    Keyboard.dismiss();
    if (saving) return;
    // ② synchronous re-entry guard (see savingRef) — closes the same-tick
    // window the stale `saving` check leaves open, on every save branch below.
    if (savingRef.current) return;

    // WS7-6 Block 1F — flip saveAttempted on the first tap so the
    // inline errors + summary line surface for manual-mode. Pristine
    // forms stay quiet; one tap is the floor for "interaction" per the
    // ruling. We flip BEFORE the validity short-circuit so the user
    // sees the errors that pinned the disabled state.
    // WS7-6 G1 — extend the saveAttempted gate to Mode C so the combine Save
    // button is no longer a dead greyed control. The first tap flips the flag
    // (surfacing the inline name error + summary line on the review surface),
    // subsequent taps with invalid state are blocked by the disabled state.
    if ((mode === "manual" || mode === "combine") && !saveAttempted) {
      setSaveAttempted(true);
    }
    if (mode === "manual" && manualSaveInvalid) {
      // Keep the form open — inline errors + summary line are the user
      // signal here. No Alert: the on-screen feedback is the point of F.
      return;
    }
    if (mode === "combine" && combineSaveInvalid) {
      // Same on-screen feedback contract as manual: stay on the review
      // surface, where the name input + summary line are now rendered.
      return;
    }

    // WS7-6 1G — hydration guard. When the user is editing an existing meal
    // (mealId present), we MUST wait for GET /meals/:id to resolve before
    // letting them save — otherwise the PATCH would carry blank/partial data
    // and wipe-and-recreate would destroy the real sub-graph. Drafts and
    // create-paths (no mealId) skip this guard.
    if (mealId && !sourceMeal) {
      if (mealDetailQuery.isError) {
        Alert.alert(
          "Can't save",
          "We couldn't load this meal. Go back and try opening it again.",
        );
        return;
      }
      // Still loading — block save quietly. The Save button's disabled
      // state below also reflects this so users don't see a spinner with
      // no feedback.
      Alert.alert(
        "Loading…",
        "Hold on a moment while we finish loading this meal.",
      );
      return;
    }

    // Build the save payload up front — it's shared by all branches and a
    // validation error here is the same Alert no matter which branch fires.
    let input: SaveMealInput;
    try {
      input = buildSaveMealInput();
    } catch (e) {
      const msg =
        e instanceof Error ? e.message : "Couldn't build the save payload.";
      Alert.alert("Can't save", msg);
      return;
    }

    // ── §2.5 EDIT-from-plan branch (WS7-6 1F) ────────────────────────────
    // PRD §2.5: editing an existing meal IN A PLAN fires the "apply always
    // vs just this time" prompt. Drafts (no Meal row yet) fall through to
    // create-save below — there's nothing to override until save.
    if (isEditFromPlanContext && !draftMeal && mealId) {
      Alert.alert(
        "Save changes",
        "How do you want to apply your edits?",
        [
          {
            // WS7-7-A B5 (D-WS7-090) — "just this time" writes the plan item's
            // recipeOverrideJson; the saved Meal is untouched, only this plan
            // instance + its grocery list change.
            text: "Just this time",
            onPress: () => {
              void runSaveJustThisTime(input);
            },
          },
          {
            text: "Apply always",
            onPress: () => {
              // WS7-7-A B5 — "forever, starting now": edit the global meal AND
              // bump THIS plan so its grocery list reconciles immediately.
              // WS7-7-A B5 follow-on (D-WS7-141 Fix 1b) — also write the
              // per-instance override (planItemId) so this plan keeps the edit
              // from the same on-screen dishes.
              void runUpdateMeal(mealId, input, planId, planItemId);
            },
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
      return;
    }

    // ── §8.4.4 LIBRARY-context global edit (WS7-6 1G) ────────────────────
    // Meal Detail → Edit, no plan params, hydrated mealId present. The
    // user is on the meal's home page; updating saved fields globally is
    // the intent — NO prompt (per PRD §8.4.4).
    if (isLibraryEditContext && !draftMeal && mealId) {
      void runUpdateMeal(mealId, input);
      return;
    }

    // ── CREATE branches (Surface 1) — WS7-6 Block 1E ────────────────────
    savingRef.current = true;
    setSaving(true);
    try {
      const { id: newMealId } = await saveMeal(input);
      // WS7-6 G2 scope (i): one destination contract for every Add-Meal-
      // originated save (manual Mode B, combine Mode C, Mode A draft, and the
      // text/image/URL imports — all funnel through this CREATE branch). A
      // non-plan save lands on the NEW meal's Meal Detail page (PRD §10.6);
      // a plan-context save keeps its contextual return to the plan.
      //
      // WS9 3f-3 (D-WS9-005) — three outcomes now, decided by the pure resolver:
      //   plan-replace → the swap context (planId + planItemId, no mealId here
      //                  because this is the CREATE branch): REPLACE the slot via
      //                  changeMealForPlanItem (PRD §8.4.2). NOT addMealToPlan
      //                  (append) — that would leave the old meal in the slot.
      //   plan-back    → the append context (addToPlanId): addMealToPlan.
      //   meal-detail  → the library context: land on the new Meal Detail.
      const nav = resolvePostSaveNav({
        newMealId,
        // Phase 1b — pass the route mealId as the self-enforcing edit guard. In
        // this CREATE branch it is normally absent; if a future edit ever reaches
        // here, the resolver forces a detail landing rather than a plan mutation.
        mealId,
        addToPlanId,
        planId,
        planItemId,
      });
      const applyNav = () => {
        // `replace` (not push) drops the builder/input screen so Back returns
        // to the list, not the half-filled form.
        if (nav.kind === "meal-detail") {
          router.replace({
            pathname: "/meal/[id]",
            params: { id: nav.mealId },
          });
        } else {
          // WS7-6 G3 Scope D — dismissTo lands on the plan regardless of how
          // many intermediate screens (import-*/ask-kiwi) sit between the
          // builder and the plan. The pre-G3 `router.back()` popped a single
          // screen, which returned the user to the import/Ask-Kiwi INPUT screen
          // rather than the plan whenever a create flow funnelled through one.
          // Both plan-replace and plan-back carry a planId for this.
          router.dismissTo({
            pathname: "/plan/[id]",
            params: { id: nav.planId },
          });
        }
      };
      if (nav.kind === "plan-replace") {
        // WS9 3f-3 (D-WS9-005) — the imported/created meal REPLACES the swap
        // slot. Two sequential writes (saveMeal already landed): if this second
        // write fails, the meal IS in the library but the plan still shows the
        // OLD meal. Landing on the plan silently would reproduce the exact
        // abandon-the-swap bug this block fixes — so on failure we surface it
        // and DO NOT navigate. (The plan screen's own applyMealReplacement owns
        // optimistic rollback + toast; that machinery is screen-local, so from
        // the builder we mirror the established append partial-failure Alert
        // below rather than import it.)
        try {
          await changeMealForPlanItem(nav.planId, nav.planItemId, newMealId);
          Alert.alert(
            "Saved and swapped in",
            `${input.title} is saved and now in your plan.`,
            [{ text: "OK", onPress: applyNav }],
          );
        } catch (planErr) {
          const msg =
            planErr instanceof Error && planErr.message
              ? planErr.message
              : "Try swapping it in from the plan instead.";
          Alert.alert(
            "Saved but couldn't swap it in",
            `${input.title} was saved to your meals, but swapping it into the plan failed:\n\n${msg}`,
          );
          // Intentionally no nav — user keeps the form open (the old meal is
          // still safely in the slot; nothing was lost).
        }
      } else if (nav.kind === "plan-back") {
        try {
          await addMealToPlan(nav.planId, newMealId);
          Alert.alert(
            "Saved and added to plan",
            `${input.title} is saved and on your plan.`,
            [{ text: "OK", onPress: applyNav }],
          );
        } catch (planErr) {
          // Saved-but-plan-add-failed: STAY on screen per WS7-6 1E spec.
          const msg =
            planErr instanceof Error && planErr.message
              ? planErr.message
              : "Try adding it from the plan instead.";
          Alert.alert(
            "Saved but couldn't add to plan",
            `${input.title} was saved to your meals, but adding it to the plan failed:\n\n${msg}`,
          );
          // Intentionally no nav — user keeps the form open.
        }
      } else {
        Alert.alert(
          draftMeal ? "Recipe saved" : "Meal saved",
          draftMeal
            ? `${input.title} was added to your meals.`
            : `${input.title} was added to your saved meals.`,
          [{ text: "OK", onPress: applyNav }],
        );
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Saving failed. Try again?";
      Alert.alert("Couldn't save meal", msg);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header showBack title={headerTitle} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Edit-context info card: surfaces the §2.5 plan-vs-global save framing.
            FU4 ③ — gated on isEditFromPlanContext (plan-instance edit), NOT bare
            `mealId`. The "just this time or apply to your saved recipe" choice is
            ONLY offered when editing from a plan (onSave shows the apply-always /
            just-this-time Alert). A library/base meal edit (§8.4.4) saves with no
            prompt, so this framing was false there. Same component renders both
            screens — this is a re-gate, not a deletion (deleting would kill the
            correct copy on the plan-instance screen). Reuses the existing
            discriminator that drives the runUpdateMeal / runSaveJustThisTime split.
            WS9 3f-3 (Thread C) — the always-true `!isChangeRecipe` term was dropped
            with the deleted Change-Recipe branch. */}
        {isEditFromPlanContext && (
          <View style={s.contextInfo}>
            <Text style={s.contextInfoText}>
              Adjust ingredients, steps, or dishes in this meal. You can make
              changes for cooking just this time or apply changes to your saved
              recipe.
            </Text>
          </View>
        )}

        {/* Draft-context info card: framing for review-and-edit of an imported recipe */}
        {!mealId && draftMeal && (
          <View style={s.contextInfo}>
            <Text style={s.contextInfoText}>
              Review the imported recipe below. Edit anything Kiwi got wrong
              before saving to your meals.
            </Text>
          </View>
        )}

        {/* addDishId-context info card: user is building a meal around a
            specific dish, so skip mode picker and drop into manual editor. */}
        {!mealId && !draftMeal && addDishId && (
          <View style={s.contextInfo}>
            <Text style={s.contextInfoText}>
              You're starting a new meal with this dish. Add more dishes,
              ingredients, and steps as needed.
            </Text>
          </View>
        )}

        {/* Mode picker — create-from-scratch context only (no mealId, no draft, no addDishId) */}
        {!mealId && !draftMeal && !addDishId && (
          <View>
            <Text style={s.sectionHeader}>How do you want to build this meal?</Text>
            {/* WS7-6 G3 Scope A — Ask-Kiwi-first ordering, mirroring the #4
                reference chooser (Ask Kiwi → create options). WS7-6 G1: Mode A
                is live — routes to the dedicated "Ask Kiwi" free-text input
                screen, which parses and lands back in this builder as a draft
                (mirrors Import-from-Text). Premium is enforced server-side
                (parse-meal 402); the UI stays ungated. */}
            <ModeCard
              icon="type"
              title="Ask Kiwi for a meal"
              subtitle="Describe a meal and Kiwi drafts the dishes, ingredients, and steps"
              selected={false}
              onPress={() => {
                Keyboard.dismiss();
                router.push({
                  pathname: "/ask-kiwi",
                  params: addToPlanId ? { addToPlanId } : {},
                });
              }}
            />
            {/* WS7-6 G3-fix — import parity. Pre-fix the three recipe imports
                were reachable only from the Plan → Add Meal sheet (#2), so a
                user adding a meal from Recipes → Meals had fewer options than
                one adding from inside a plan. They route to the same import
                screens; addToPlanId is threaded only when present (it isn't on
                the Recipes-tab path, so those saves land on Meal Detail). */}
            <ModeCard
              icon="link"
              title="Import from URL"
              subtitle="Paste a recipe link"
              selected={false}
              onPress={() => {
                Keyboard.dismiss();
                router.push({
                  pathname: "/import-url",
                  params: addToPlanId ? { addToPlanId } : {},
                });
              }}
            />
            <ModeCard
              icon="image"
              title="Import from photo"
              subtitle="Take a photo or pick from your library"
              selected={false}
              onPress={() => {
                Keyboard.dismiss();
                router.push({
                  pathname: "/import-image",
                  params: addToPlanId ? { addToPlanId } : {},
                });
              }}
            />
            <ModeCard
              icon="clipboard"
              title="Import from text"
              subtitle="Paste a recipe from anywhere"
              selected={false}
              onPress={() => {
                Keyboard.dismiss();
                router.push({
                  pathname: "/import-text",
                  params: addToPlanId ? { addToPlanId } : {},
                });
              }}
            />
            <ModeCard
              icon="edit-3"
              title="Create manually"
              subtitle="Add dishes, ingredients, and steps directly"
              selected={mode === "manual"}
              onPress={() => trySetMode("manual")}
            />
            <ModeCard
              icon="layers"
              title="Use dishes you've saved"
              subtitle="Mix dishes from your library into a new meal"
              selected={mode === "combine"}
              onPress={() => trySetMode("combine")}
            />
          </View>
        )}

        {/* Mode-specific content */}
        {mode === "manual" && (
          <ManualEditor
            mealName={mealName}
            setMealName={setMealName}
            cuisineType={cuisineType}
            setCuisineType={setCuisineType}
            cuisineExpanded={cuisineExpanded}
            setCuisineExpanded={setCuisineExpanded}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            estimatedTimeMinutes={estimatedTimeMinutes}
            setEstimatedTimeMinutes={setEstimatedTimeMinutes}
            servingsDefault={servingsDefault}
            setServingsDefault={setServingsDefault}
            isEditMode={!!mealId}
            dishes={dishes}
            autoFocusDishUid={autoFocusDishUid}
            onOpenDishChooser={() => setDishChooserVisible(true)}
            removeDish={removeDish}
            updateDishName={updateDishName}
            addIngredient={addIngredient}
            removeIngredient={removeIngredient}
            updateIngredient={updateIngredient}
            addStep={addStep}
            removeStep={removeStep}
            updateStep={updateStep}
            reorderStepsForDish={reorderStepsForDish}
            notes={notes}
            setNotes={setNotes}
            // WS7-6 Block 1F — surface per-field validation reasons
            // only after the user has tapped Save once (saveAttempted).
            // Pre-tap the form stays quiet.
            showFieldErrors={saveAttempted}
            nameMissing={manualValidation.nameMissing}
            ingredientMissing={manualValidation.ingredientMissing}
            stepMissing={manualValidation.stepMissing}
          />
        )}

        {mode === "combine" && !combineReview && (
          <CombinePicker
            mealName={mealName}
            setMealName={setMealName}
            cuisineType={cuisineType}
            setCuisineType={setCuisineType}
            cuisineExpanded={cuisineExpanded}
            setCuisineExpanded={setCuisineExpanded}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            estimatedTimeMinutes={estimatedTimeMinutes}
            setEstimatedTimeMinutes={setEstimatedTimeMinutes}
            servingsDefault={servingsDefault}
            setServingsDefault={setServingsDefault}
            isEditMode={!!mealId}
            savedDishes={savedDishes}
            dishesLoading={dishesQuery.isLoading}
            dishesError={dishesQuery.isError}
            onRetryDishes={() => void dishesQuery.refetch()}
            sortKey={combineSortKey}
            onSortChange={setCombineSortKey}
            hasNextPage={dishesQuery.hasNextPage}
            isFetchingNextPage={dishesQuery.isFetchingNextPage}
            onLoadMore={() => void dishesQuery.fetchNextPage()}
            selectedDishIds={selectedDishIds}
            onToggle={toggleSelectedDish}
            onContinue={() => {
              Keyboard.dismiss();
              setCombineReview(true);
            }}
          />
        )}

        {mode === "combine" && combineReview && (
          <CombineReview
            savedDishes={savedDishes}
            selectedDishIds={selectedDishIds}
            onBack={() => setCombineReview(false)}
            // WS7-6 G1 — name entry lives on the review surface too (PRD
            // §10.5.3). Pre-fix, the name input was only on the picker; a user
            // who skipped it landed here with a greyed Save and no way to name
            // the meal. nameError mirrors manual's saveAttempted gate.
            mealName={mealName}
            setMealName={setMealName}
            nameError={saveAttempted && combineNameMissing}
          />
        )}
      </KeyboardAwareScrollViewCompat>

      {(mode === "manual" || (mode === "combine" && combineReview)) && (
        <View style={s.saveBar}>
          {/* WS7-6 Block 1F — summary line. Lists ONLY the still-missing
              requirements so it shrinks as the user fills the form. Only
              shown after the first Save tap (saveAttempted) so a pristine
              form doesn't shout. Manual mode only — Mode C keeps its
              pre-F UX since the prompt scoped F to manual. */}
          {mode === "manual" && saveAttempted && manualSaveInvalid && (
            <Text style={s.saveBarSummary} testID="meal-builder-save-summary">
              {summarizeMissing(manualValidation)}
            </Text>
          )}
          {/* WS7-6 G1 — Mode-C summary line, parallel to manual's. The only
              reachable miss on the review surface is the name (Continue
              guarantees ≥1 dish). */}
          {mode === "combine" && saveAttempted && combineSaveInvalid && (
            <Text style={s.saveBarSummary} testID="meal-builder-save-summary">
              {combineDishMissing
                ? "Needs: a name, at least one dish."
                : "Needs: a name."}
            </Text>
          )}
          <Button
            label={
              saving
                ? "Saving…"
                : mealId && !sourceMeal && !mealDetailQuery.isError
                  ? "Loading…"
                  : "Save meal"
            }
            variant="primary"
            // WS7-6 1G hydration guard: block save until GET /meals/:id has
            // resolved (or errored — in which case onSave shows the alert).
            // Prevents a PATCH built from blank/partial state from wiping
            // the real meal's sub-graph.
            //
            // WS7-6 1F: manual-mode disabled state is gated on
            // saveAttempted so the FIRST tap still fires onSave (which
            // flips saveAttempted and surfaces the errors); subsequent
            // renders with invalid state grey the button out + block.
            disabled={
              saving ||
              (mode === "manual"
                ? saveAttempted && manualSaveInvalid
                : saveAttempted && combineSaveInvalid) ||
              (!!mealId && !sourceMeal && !mealDetailQuery.isError)
            }
            onPress={onSave}
          />
        </View>
      )}

      <DishChooserSheet
        visible={dishChooserVisible}
        onClose={() => setDishChooserVisible(false)}
        onPickSavedDish={(dish) => {
          setDishes((prev) => [
            ...prev,
            pickSavedDishToBuilderDish(dish, allocUid),
          ]);
        }}
        // WS7-6 Block 1H — append a blank editable dish to the meal
        // under construction. Mirrors the saved-pick append shape but
        // with newDish() (empty) instead of pickSavedDishToBuilderDish
        // (hydrated). Kept as a clean named callback so the sheet
        // stays unaware of meal-builder state — WS9 extraction-friendly.
        // WS7-6 C-fix Block 4 — flag the new dish for auto-focus so the user
        // lands in its name input instead of staring at an unchanged screen.
        onAddEmptyDish={() => {
          const dish = newDish();
          setDishes((prev) => [...prev, dish]);
          setAutoFocusDishUid(dish.uid);
        }}
        // WS7-6 G2 scope (ii) — dish-side Mode A goes live (resolves
        // D-WS7-096). Close the sheet and route to the dish "Ask Kiwi" screen,
        // which parses the typed description (POST /builder/parse-dish) and
        // lands in the Dish Builder as a draft.
        // WS7-6 G3 Scope C — the sheet no longer collects a prompt inline (that
        // embedded TextInput caused the runaway list-scroll); the user types on
        // the ask-kiwi-dish screen.
        // WS7-6 G3-fix — in-place add: arm a one-shot handoff so when the dish
        // is parsed it's APPENDED to THIS meal's dishes[] (auto-focused, like
        // create-from-scratch) and the user pops back here, instead of saving a
        // standalone dish and landing on Dish Detail. `returnToMeal` tells the
        // ask-kiwi-dish screen to take the deliver-and-pop branch.
        onAskKiwi={() => {
          setDishChooserVisible(false);
          armDishHandoff((draft) => {
            const dish = draftDishToBuilderDish(draft, allocUid);
            setDishes((prev) => [...prev, dish]);
            setAutoFocusDishUid(dish.uid);
          });
          router.push({
            pathname: "/ask-kiwi-dish",
            params: { returnToMeal: "1" },
          });
        }}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Mode picker card
// ─────────────────────────────────────────────────────────────────

interface ModeCardProps {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  subtitle: string;
  selected: boolean;
  locked?: boolean;
  onPress: () => void;
}

function ModeCard({
  icon,
  title,
  subtitle,
  selected,
  locked,
  onPress,
}: ModeCardProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        s.modeCard,
        selected && s.modeCardSelected,
        locked && s.modeCardLocked,
        pressed && { opacity: 0.85 },
      ]}
    >
      <View style={s.modeIconWrap}>
        <Feather
          name={icon}
          size={20}
          color={
            locked
              ? Colors.neutral[600]
              : selected
                ? Colors.sage[700]
                : Colors.neutral[800]
          }
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.modeTitle, locked && { color: Colors.neutral[700] }]}>
          {title}
        </Text>
        <Text style={s.modeSubtitle}>{subtitle}</Text>
      </View>
      {locked && (
        <View style={s.premiumPill}>
          <Feather name="lock" size={10} color={Colors.terracotta[700]} />
          <Text style={s.premiumPillText}>Premium</Text>
        </View>
      )}
    </Pressable>
  );
}

// ─────────────────────────────────────────────────────────────────
// Shared meta fields (Mode B + Mode C)
// ─────────────────────────────────────────────────────────────────

interface MetaFieldsProps {
  mealName: string;
  setMealName: (v: string) => void;
  cuisineType: string;
  setCuisineType: (v: string) => void;
  cuisineExpanded: boolean;
  setCuisineExpanded: (v: boolean) => void;
  difficulty: Difficulty;
  setDifficulty: (v: Difficulty) => void;
  estimatedTimeMinutes: string;
  setEstimatedTimeMinutes: (v: string) => void;
  servingsDefault: number;
  setServingsDefault: (v: number) => void;
  // WS7-8b BUG-002 — true when editing an existing meal (mealId present).
  // The "Default servings" stepper is CREATE-ONLY: in edit mode it would
  // change the servings count without rescaling the authored ingredient
  // quantities, persisting a count that disagrees with the amounts and
  // corrupting the canonical recipe. Editing servings happens at render
  // time on Meal Detail (servingsMultiplier), not here.
  isEditMode: boolean;
  // WS7-6 Block 1F — name-field error surface. Manual mode passes this
  // through ManualEditor after saveAttempted; CombinePicker leaves it
  // undefined (Mode C error UX is unchanged in this block).
  nameError?: boolean;
}

function MetaFields(p: MetaFieldsProps) {
  const decServings = () =>
    p.setServingsDefault(Math.max(SERVINGS_MIN, p.servingsDefault - 1));
  const incServings = () =>
    p.setServingsDefault(Math.min(SERVINGS_MAX, p.servingsDefault + 1));

  return (
    <View style={{ gap: Spacing[3] }}>
      <View>
        <Text style={s.fieldLabel}>Meal name</Text>
        <TextInput
          value={p.mealName}
          onChangeText={p.setMealName}
          placeholder="Meal name (e.g., Salmon Teriyaki)"
          placeholderTextColor={Colors.neutral[600]}
          style={[s.textInput, p.nameError && s.inputInvalid]}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={Keyboard.dismiss}
        />
        {p.nameError && (
          <Text style={s.invalidBadge}>Add a meal name to save.</Text>
        )}
      </View>
      {/* TODO(WS9): Add 'Other...' chip + free-text fallback for cuisines
          not in the catalog. Per D-WS5-XXX deferred decisions. */}
      <View>
        <Text style={s.fieldLabel}>Cuisine</Text>
        <View style={s.chipRow}>
          {CUISINES_TIER_1.map((c) => (
            <Chip
              key={c}
              label={c}
              selected={p.cuisineType === c}
              onPress={() =>
                p.setCuisineType(p.cuisineType === c ? "" : c)
              }
            />
          ))}
        </View>
        <Pressable
          onPress={() => p.setCuisineExpanded(!p.cuisineExpanded)}
          hitSlop={6}
          style={({ pressed }) => [
            s.expandLink,
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text style={s.expandLinkText}>More cuisines</Text>
          <Feather
            name={p.cuisineExpanded ? "chevron-up" : "chevron-down"}
            size={14}
            color={Colors.sage[700]}
          />
        </Pressable>
        {p.cuisineExpanded && (
          <View style={[s.chipRow, { marginTop: Spacing[2] }]}>
            {CUISINES_TIER_2.map((c) => (
              <Chip
                key={c}
                label={c}
                selected={p.cuisineType === c}
                onPress={() =>
                  p.setCuisineType(p.cuisineType === c ? "" : c)
                }
              />
            ))}
          </View>
        )}
      </View>
      <View>
        <Text style={s.fieldLabel}>Difficulty</Text>
        <View style={s.difficultyRow}>
          {(["easy", "medium", "hard"] as Difficulty[]).map((d) => (
            <Pressable
              key={d}
              onPress={() => p.setDifficulty(d)}
              style={({ pressed }) => [
                s.difficultyBtn,
                p.difficulty === d && s.difficultyBtnOn,
                pressed && { opacity: 0.7 },
              ]}
            >
              <Text
                style={
                  p.difficulty === d
                    ? s.difficultyBtnTextOn
                    : s.difficultyBtnTextOff
                }
              >
                {d.charAt(0).toUpperCase() + d.slice(1)}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={s.timeServingsRow}>
        <View style={{ flex: 1 }}>
          <Text style={s.fieldLabel}>Estimated time</Text>
          <View style={s.suffixRow}>
            <TextInput
              value={p.estimatedTimeMinutes}
              onChangeText={(v) =>
                p.setEstimatedTimeMinutes(v.replace(/[^0-9]/g, ""))
              }
              keyboardType="number-pad"
              placeholder="30"
              placeholderTextColor={Colors.neutral[600]}
              style={[s.textInput, { flex: 1 }]}
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={Keyboard.dismiss}
            />
            <Text style={s.suffixLabel}>min</Text>
          </View>
        </View>
        {/* WS7-8b BUG-002 — CREATE-ONLY. The stepper sets servingsDefault but
            does NOT rescale authored ingredient quantities; in edit mode that
            persists a servings count that disagrees with the amounts and
            corrupts the canonical recipe. Editing servings is a render-time
            concern on Meal Detail (servingsMultiplier), not here. */}
        {!p.isEditMode && (
          <View style={{ flex: 1 }}>
            <Text style={s.fieldLabel}>Default servings</Text>
            <View style={s.stepperRow}>
              <Pressable
                onPress={decServings}
                disabled={p.servingsDefault <= SERVINGS_MIN}
                hitSlop={6}
                style={({ pressed }) => [
                  s.stepperBtn,
                  p.servingsDefault <= SERVINGS_MIN && { opacity: 0.4 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Feather name="minus" size={16} color={Colors.sage[700]} />
              </Pressable>
              <Text style={s.stepperValue}>{p.servingsDefault}</Text>
              <Pressable
                onPress={incServings}
                disabled={p.servingsDefault >= SERVINGS_MAX}
                hitSlop={6}
                style={({ pressed }) => [
                  s.stepperBtn,
                  p.servingsDefault >= SERVINGS_MAX && { opacity: 0.4 },
                  pressed && { opacity: 0.6 },
                ]}
              >
                <Feather name="plus" size={16} color={Colors.sage[700]} />
              </Pressable>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Mode B — Manual editor
// ─────────────────────────────────────────────────────────────────

interface ManualEditorProps extends MetaFieldsProps {
  dishes: BuilderDish[];
  /** WS7-6 C-fix Block 4 — uid of the dish whose name input should auto-focus
   *  (set when "Create from scratch" appends a blank dish). null = none. */
  autoFocusDishUid: number | null;
  /** Opens DishChooserSheet — replaces the inline "+ Add dish" link. */
  onOpenDishChooser: () => void;
  removeDish: (uid: number) => void;
  updateDishName: (uid: number, name: string) => void;
  addIngredient: (dishUid: number) => void;
  removeIngredient: (dishUid: number, ingUid: number) => void;
  updateIngredient: (
    dishUid: number,
    ingUid: number,
    patch: Partial<Omit<BuilderIngredient, "uid">>,
  ) => void;
  // WS7-6 Fix-Block 1B — step mutators are per-dish (BuilderDish owns its
  // own steps). dishUid identifies which dish's steps array to mutate.
  addStep: (dishUid: number) => void;
  removeStep: (dishUid: number, stepUid: number) => void;
  updateStep: (
    dishUid: number,
    stepUid: number,
    patch: Partial<Omit<BuilderStep, "uid">>,
  ) => void;
  // WS5-5P-fix-drag — drag-to-reorder writes the new array back. The
  // step number circle reads from the array index (no stepNumber field
  // on BuilderStep), so reorder is automatic — no renumber pass needed.
  // WS7-6 Fix-Block 1B — scoped to a single dish's steps.
  reorderStepsForDish: (dishUid: number, next: BuilderStep[]) => void;
  notes: string;
  setNotes: (v: string) => void;
  // WS7-6 Block 1F — per-field validation surface, driven by parent's
  // saveAttempted gate. Showing errors only when showFieldErrors is true
  // keeps pristine forms quiet.
  showFieldErrors: boolean;
  nameMissing: boolean;
  ingredientMissing: boolean;
  stepMissing: boolean;
}

function ManualEditor(p: ManualEditorProps) {
  const moreThanOneDish = p.dishes.length > 1;
  // WS7-6 Block 1F — local convenience flags. Don't bother rendering
  // the section-level error text unless the parent's saveAttempted gate
  // is open AND that specific section is still missing.
  const showNameError = p.showFieldErrors && p.nameMissing;
  const showIngredientError = p.showFieldErrors && p.ingredientMissing;
  const showStepError = p.showFieldErrors && p.stepMissing;
  return (
    <View style={{ marginTop: Spacing[4], gap: Spacing[4] }}>
      <MetaFields {...p} nameError={showNameError} />

      {/* Ingredients */}
      <View style={{ gap: Spacing[2] }}>
        <SectionLabel label="Ingredients" />
        {showIngredientError && (
          <Text style={s.invalidBadge}>
            Add at least one ingredient with a name.
          </Text>
        )}
        {p.dishes.map((dish) => (
          <View key={dish.uid} style={s.dishCard}>
            <View style={s.dishHeaderRow}>
              <TextInput
                value={dish.name}
                onChangeText={(v) => p.updateDishName(dish.uid, v)}
                placeholder="Dish name (optional)"
                placeholderTextColor={Colors.neutral[600]}
                style={[s.textInput, { flex: 1 }]}
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={Keyboard.dismiss}
                // WS7-6 C-fix Block 4 — focus the just-appended "Create from
                // scratch" dish on mount; the KeyboardAwareScrollView then
                // scrolls it into view.
                autoFocus={dish.uid === p.autoFocusDishUid}
              />
              {moreThanOneDish && (
                <Pressable
                  onPress={() => p.removeDish(dish.uid)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    s.removeIconBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Feather name="trash-2" size={16} color={Colors.terracotta[600]} />
                </Pressable>
              )}
            </View>
            <View style={{ gap: Spacing[1], marginTop: Spacing[2] }}>
              {dish.ingredients.map((ing) => {
                // FU3 — invalid when non-blank AND (unparseable OR ≤ 0). Blank
                // is allowed (defaults to 1 at save). Shared rule so builder +
                // save-block agree.
                const qtyInvalid = isQuantityInvalid(ing.quantity);
                return (
                  <View key={ing.uid}>
                    <View style={s.ingredientRow}>
                      <TextInput
                        value={ing.quantity}
                        onChangeText={(v) =>
                          p.updateIngredient(dish.uid, ing.uid, { quantity: v })
                        }
                        placeholder="Qty"
                        placeholderTextColor={Colors.neutral[600]}
                        style={[
                          s.textInput,
                          s.ingQty,
                          qtyInvalid && s.inputInvalid,
                        ]}
                        // Default keyboard so users can type "/" for fractions.
                        autoCapitalize="none"
                        returnKeyType="done"
                        blurOnSubmit
                        onSubmitEditing={Keyboard.dismiss}
                      />
                      <TextInput
                        value={ing.unit}
                        onChangeText={(v) =>
                          p.updateIngredient(dish.uid, ing.uid, { unit: v })
                        }
                        placeholder="Unit"
                        placeholderTextColor={Colors.neutral[600]}
                        style={[s.textInput, s.ingUnit]}
                        autoCapitalize="none"
                        returnKeyType="done"
                        blurOnSubmit
                        onSubmitEditing={Keyboard.dismiss}
                      />
                      <TextInput
                        value={ing.name}
                        onChangeText={(v) =>
                          p.updateIngredient(dish.uid, ing.uid, { name: v })
                        }
                        placeholder="Ingredient"
                        placeholderTextColor={Colors.neutral[600]}
                        style={[s.textInput, { flex: 1 }]}
                        returnKeyType="done"
                        blurOnSubmit
                        onSubmitEditing={Keyboard.dismiss}
                      />
                      <Pressable
                        onPress={() => p.removeIngredient(dish.uid, ing.uid)}
                        hitSlop={8}
                        style={({ pressed }) => [
                          s.removeIconBtn,
                          pressed && { opacity: 0.6 },
                        ]}
                      >
                        <Feather
                          name="x"
                          size={16}
                          color={Colors.neutral[700]}
                        />
                      </Pressable>
                    </View>
                    {qtyInvalid && (
                      <Text style={s.invalidBadge}>
                        Enter a quantity above 0 (e.g. 1, 1.5, 1/2, or 1 1/2)
                      </Text>
                    )}
                  </View>
                );
              })}
              <Pressable
                onPress={() => p.addIngredient(dish.uid)}
                hitSlop={6}
                style={({ pressed }) => [
                  s.addLinkBtn,
                  pressed && { opacity: 0.7 },
                ]}
              >
                <Feather name="plus" size={14} color={Colors.sage[700]} />
                <Text style={s.addLinkText}>Add ingredient</Text>
              </Pressable>
            </View>
          </View>
        ))}
        <View style={s.addDishWrap}>
          <Button
            label="+ Add Dish"
            variant="ghost"
            onPress={p.onOpenDishChooser}
          />
        </View>
      </View>

      {/* Steps — REQUIRED per PRD §10.5.6 (WS7-6 Block 1F tightening:
          previously optional, now ≥1 step text required somewhere in the
          meal).
          WS7-6 Fix-Block 1B: rendered per-dish so each dish carries (and
          edits) its own steps. For single-dish meals this looks identical
          to the pre-fix UX (one section, no dish-name sub-header). For
          multi-dish, each dish gets its own steps block stacked below the
          single "Recipe steps" header — bound to that dish's steps array
          via dish.uid. */}
      <View style={{ gap: Spacing[2] }}>
        <SectionLabel label="Recipe steps" />
        {showStepError && (
          <Text style={s.invalidBadge}>
            Add at least one cooking step.
          </Text>
        )}
        {p.dishes.every((d) => d.steps.length === 0) && (
          <View style={s.stepsEmptyState}>
            <Text style={s.stepsEmptyText}>
              Add at least one cooking step. Short notes count — even
              &quot;plate and serve&quot; works for simple meals.
            </Text>
          </View>
        )}
        {p.dishes.map((dish) => (
          <PerDishSteps
            key={dish.uid}
            dish={dish}
            showDishHeader={moreThanOneDish}
            addStep={p.addStep}
            removeStep={p.removeStep}
            updateStep={p.updateStep}
            reorderStepsForDish={p.reorderStepsForDish}
          />
        ))}
      </View>

      {/* Notes */}
      <View style={{ gap: Spacing[2] }}>
        <SectionLabel label="Notes (optional)" />
        <TextInput
          value={p.notes}
          onChangeText={p.setNotes}
          placeholder="Add any notes about this meal..."
          placeholderTextColor={Colors.neutral[600]}
          style={[s.textInput, s.notesInput]}
          multiline
          returnKeyType="default"
          blurOnSubmit={false}
        />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Per-dish steps section (WS7-6 Fix-Block 1B)
//
// Renders one DraggableFlatList per dish, bound to dish.steps. The pre-
// fix builder rendered ONE meal-level steps list and re-attached the
// whole array to dish[0] on save — sub-dish swaps left stale steps stuck
// on dish[0]. Each PerDishSteps owns reorder/add/remove/update for ITS
// dish only.
// ─────────────────────────────────────────────────────────────────

interface PerDishStepsProps {
  dish: BuilderDish;
  /** True when the meal has >1 dish — render the dish name as a sub-
   *  header above the steps list to disambiguate which dish a step row
   *  belongs to. Single-dish meals suppress the header for visual parity
   *  with the pre-fix UX. */
  showDishHeader: boolean;
  addStep: (dishUid: number) => void;
  removeStep: (dishUid: number, stepUid: number) => void;
  updateStep: (
    dishUid: number,
    stepUid: number,
    patch: Partial<Omit<BuilderStep, "uid">>,
  ) => void;
  reorderStepsForDish: (dishUid: number, next: BuilderStep[]) => void;
}

function PerDishSteps(p: PerDishStepsProps) {
  const dishUid = p.dish.uid;
  return (
    <View style={{ gap: Spacing[2] }}>
      {p.showDishHeader && (
        <Text style={s.perDishStepsHeader}>
          {p.dish.name.trim() || "Untitled dish"}
        </Text>
      )}
      {/* WS5-5P-fix-drag — DraggableFlatList for steps. Drag-to-reorder
          via the always-visible handle (≡) per locked Option A + C.
          Ingredients intentionally not draggable (Option F).

          scrollEnabled={false} delegates scroll to the outer
          KeyboardAwareScrollViewCompat — nested-scrollables would
          otherwise fight for vertical pan. The drag handle uses
          onPressIn (see Pressable below for the v4-API rationale).
          Steps lists are short (typically 2–15 items) so disabling
          virtualization is a non-issue. */}
      <DraggableFlatList
        data={p.dish.steps}
        keyExtractor={(step) => step.uid.toString()}
        onDragEnd={({ data }) => p.reorderStepsForDish(dishUid, data)}
        scrollEnabled={false}
        renderItem={({
          item: step,
          drag,
          isActive,
          getIndex,
        }: RenderItemParams<BuilderStep>) => {
          const i = getIndex() ?? 0;
          return (
            <ScaleDecorator>
              <View
                style={[
                  s.stepRow,
                  isActive && { opacity: 0.7 },
                ]}
              >
                <View
                  style={[
                    s.stepCircle,
                    step.isTimingSensitive && s.stepCircleTiming,
                  ]}
                >
                  <Text
                    style={[
                      s.stepCircleText,
                      step.isTimingSensitive && s.stepCircleTextTiming,
                    ]}
                  >
                    {i + 1}
                  </Text>
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <TextInput
                    value={step.text}
                    onChangeText={(v) =>
                      p.updateStep(dishUid, step.uid, { text: v })
                    }
                    placeholder="Step description"
                    placeholderTextColor={Colors.neutral[600]}
                    style={[s.textInput, s.stepTextInput]}
                    multiline
                    returnKeyType="default"
                    blurOnSubmit={false}
                  />
                  <View style={s.suffixRow}>
                    <TextInput
                      value={step.estimatedMinutes}
                      onChangeText={(v) =>
                        p.updateStep(dishUid, step.uid, {
                          estimatedMinutes: v.replace(/[^0-9]/g, ""),
                        })
                      }
                      placeholder="0"
                      placeholderTextColor={Colors.neutral[600]}
                      style={[s.textInput, { width: 56 }]}
                      keyboardType="number-pad"
                      returnKeyType="done"
                      blurOnSubmit
                      onSubmitEditing={Keyboard.dismiss}
                    />
                    <Text style={s.suffixLabel}>min</Text>
                  </View>
                </View>
                <Pressable
                  onPressIn={drag}
                  disabled={isActive}
                  hitSlop={8}
                  style={({ pressed }) => [
                    s.dragHandleBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Feather
                    name="menu"
                    size={20}
                    color={Colors.neutral[500]}
                  />
                </Pressable>
                <Pressable
                  onPress={() => p.removeStep(dishUid, step.uid)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    s.removeIconBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Feather
                    name="x"
                    size={16}
                    color={Colors.neutral[700]}
                  />
                </Pressable>
              </View>
            </ScaleDecorator>
          );
        }}
      />
      <View style={s.stepsActionsRow}>
        <Button
          label="+ Add step"
          variant="ghost"
          onPress={() => p.addStep(dishUid)}
        />
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Mode C — Combine picker
// ─────────────────────────────────────────────────────────────────

interface CombinePickerProps extends MetaFieldsProps {
  savedDishes: SavedDish[];
  /** WS7-6 1D — true while /me/dishes is in flight. */
  dishesLoading?: boolean;
  /** WS7-6 1D — true if /me/dishes errored. Retry button surfaced. */
  dishesError?: boolean;
  /** WS7-6 1D — retry callback for the error state. */
  onRetryDishes?: () => void;
  /** WS7-6 B-fix Block 3 — sort dropdown state (parity with Recipes→Dishes). */
  sortKey: SortKey;
  onSortChange: (key: SortKey) => void;
  /** WS7-6 B-fix Block 3 — cursor-pagination footer. The picker lives inside
   *  a ScrollView so it can't host a VirtualizedList onEndReached; a "Load
   *  more" footer drives fetchNextPage instead. */
  hasNextPage?: boolean;
  isFetchingNextPage?: boolean;
  onLoadMore?: () => void;
  selectedDishIds: string[];
  onToggle: (id: string) => void;
  onContinue: () => void;
}

function CombinePicker(p: CombinePickerProps) {
  // Set-based lookup so each row check is O(1) instead of O(n) on
  // p.selectedDishIds. Recomputed only when the selection changes.
  const selectedSet = useMemo(
    () => new Set(p.selectedDishIds),
    [p.selectedDishIds],
  );

  return (
    <View style={{ marginTop: Spacing[4], gap: Spacing[4] }}>
      <MetaFields {...p} />
      <View style={{ gap: Spacing[2] }}>
        <View style={s.combineHeaderRow}>
          <Text style={s.subHeader}>Pick dishes to combine</Text>
          <SortDropdown
            value={p.sortKey}
            onChange={p.onSortChange}
            labelOverrides={DISH_SORT_LABEL_OVERRIDES}
            disabledKeys={DISH_DISABLED_SORT_KEYS}
          />
        </View>
        <Text style={s.helperText}>
          Selected dishes will become this meal&apos;s components. You can edit
          ingredients afterward.
        </Text>
        {p.dishesLoading && p.savedDishes.length === 0 ? (
          <View style={s.dishesStatusRow}>
            <ActivityIndicator size="small" color={Colors.sage[700]} />
            <Text style={s.dishesStatusText}>Loading your saved dishes…</Text>
          </View>
        ) : p.dishesError ? (
          <View style={s.dishesStatusRow}>
            <Text style={s.dishesStatusText}>
              Couldn&apos;t load your saved dishes.
            </Text>
            {p.onRetryDishes && (
              <Button
                label="Retry"
                variant="ghost"
                onPress={p.onRetryDishes}
              />
            )}
          </View>
        ) : p.savedDishes.length === 0 ? (
          <Text style={s.helperText}>
            You haven&apos;t saved any dishes yet. Use Mode A or B to build one
            first.
          </Text>
        ) : (
          <>
            {p.savedDishes.map((dish) => (
              <DishPickerRow
                key={dish.id}
                dish={dish}
                isSelected={selectedSet.has(dish.id)}
                onToggle={p.onToggle}
              />
            ))}
            {/* WS7-6 B-fix Block 3 — cursor pagination. The picker sits inside
                the builder's ScrollView, so a "Load more" footer drives
                fetchNextPage rather than a nested VirtualizedList. */}
            {p.isFetchingNextPage ? (
              <View style={s.dishesStatusRow}>
                <ActivityIndicator size="small" color={Colors.sage[700]} />
                <Text style={s.dishesStatusText}>Loading more…</Text>
              </View>
            ) : p.hasNextPage && p.onLoadMore ? (
              <Button
                label="Load more dishes"
                variant="ghost"
                onPress={p.onLoadMore}
              />
            ) : null}
          </>
        )}
        <Button
          label="Continue with selected"
          variant="primary"
          disabled={p.selectedDishIds.length === 0}
          onPress={p.onContinue}
        />
      </View>
    </View>
  );
}

interface DishPickerRowProps {
  dish: SavedDish;
  isSelected: boolean;
  onToggle: (id: string) => void;
}

// Memoized so typing in MetaFields above doesn't re-render every dish row —
// only the row whose isSelected flips on toggle re-renders. Combined with
// useCallback'd onToggle in the parent, this kills the first-render tap
// latency from selection-state churn.
const DishPickerRow = memo(function DishPickerRow({
  dish,
  isSelected,
  onToggle,
}: DishPickerRowProps) {
  const handlePress = useCallback(() => onToggle(dish.id), [dish.id, onToggle]);
  return (
    <Pressable
      onPress={handlePress}
      style={({ pressed }) => [
        s.dishPickerRow,
        isSelected && s.dishPickerRowSelected,
        pressed && { opacity: 0.85 },
      ]}
    >
      <Feather
        name={isSelected ? "check-square" : "square"}
        size={20}
        color={isSelected ? Colors.sage[700] : Colors.neutral[600]}
      />
      <View style={[s.dishThumb, !dish.imageUrl && s.dishThumbFallback]} />
      <View style={{ flex: 1 }}>
        <Text style={s.dishPickerName}>{resolveDisplayTitle(dish)}</Text>
        {(() => {
          // WS7-6 C-fix Block 4 — calories moved into the full macro line
          // below; the meta line keeps cuisine + cook time (when present).
          const metaParts = [
            dish.cuisineType,
            dish.estimatedTimeMinutes && dish.estimatedTimeMinutes > 0
              ? `${dish.estimatedTimeMinutes} min`
              : null,
          ].filter(Boolean) as string[];
          return metaParts.length > 0 ? (
            <Text style={s.dishPickerMeta}>{metaParts.join(" · ")}</Text>
          ) : null;
        })()}
        <Text style={s.dishPickerMacros}>
          {formatMacroLine(
            dish.caloriesPerServing,
            dish.proteinGPerServing,
            dish.carbsGPerServing,
            dish.fatGPerServing,
          )}
        </Text>
      </View>
      {dish.mealUseCount > 0 && (
        <Text style={s.dishPickerUse}>
          Used in {dish.mealUseCount}{" "}
          {dish.mealUseCount === 1 ? "meal" : "meals"}
        </Text>
      )}
    </Pressable>
  );
});

// ─────────────────────────────────────────────────────────────────
// Mode C — Combine review (extracted to components/CombineReview.tsx in
// WS7-6 G1 so the greyed-Save fix is testable without the screen's
// draggable-flatlist dependency).
// ─────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: 240,
  },
  saveBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[3],
    paddingBottom: Spacing[5],
    backgroundColor: Colors.neutral[100],
    borderTopWidth: 1,
    borderTopColor: Colors.neutral[400],
  },
  // WS7-6 Block 1F — summary line above the Save button. Uses the same
  // terracotta tint as invalidBadge for visual continuity with the
  // inline per-field errors.
  saveBarSummary: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    marginBottom: Spacing[2],
    textAlign: "center",
  },
  sectionHeader: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginBottom: Spacing[2],
  },
  contextInfo: {
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.sage[300],
    padding: Spacing[3],
    marginBottom: Spacing[3],
  },
  contextInfoText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  addDishWrap: {
    marginTop: Spacing[3],
    marginBottom: Spacing[4],
  },
  stepsEmptyState: {
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    alignItems: "center",
  },
  stepsEmptyText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    textAlign: "center",
    lineHeight: 18,
  },
  stepsActionsRow: {
    marginTop: Spacing[2],
  },
  perDishStepsHeader: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
    marginTop: Spacing[2],
  },
  modeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    padding: Spacing[3],
    marginBottom: Spacing[2],
  },
  modeCardSelected: {
    backgroundColor: Colors.sage[100],
    borderColor: Colors.sage[300],
  },
  modeCardLocked: {
    opacity: 0.85,
    backgroundColor: Colors.neutral[50],
  },
  modeIconWrap: {
    width: 36,
    height: 36,
    borderRadius: Radius.md,
    backgroundColor: Colors.neutral[100],
    alignItems: "center",
    justifyContent: "center",
  },
  modeTitle: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  modeSubtitle: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  fieldLabel: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: 4,
  },
  textInput: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  expandLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginTop: Spacing[2],
    alignSelf: "flex-start",
  },
  expandLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  inputInvalid: {
    borderColor: Colors.terracotta[400],
  },
  invalidBadge: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
    marginLeft: 4,
  },
  notesInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  difficultyRow: {
    flexDirection: "row",
    gap: Spacing[1],
  },
  difficultyBtn: {
    flex: 1,
    paddingVertical: Spacing[2],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    backgroundColor: Palette.background.card,
    alignItems: "center",
  },
  difficultyBtnOn: {
    backgroundColor: Colors.sage[700],
    borderColor: Colors.sage[700],
  },
  difficultyBtnTextOn: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[0],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  difficultyBtnTextOff: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  timeServingsRow: {
    flexDirection: "row",
    gap: Spacing[3],
  },
  suffixRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  suffixLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: 4,
    alignSelf: "flex-start",
  },
  stepperBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepperValue: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    minWidth: 20,
    textAlign: "center",
  },
  subHeader: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  // WS7-6 B-fix Block 3 — header row pairs the "Pick dishes" title with the
  // sort dropdown (zIndex keeps the open menu above the dish rows below).
  combineHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: Spacing[2],
    zIndex: 10,
  },
  addLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: Spacing[1],
  },
  addLinkText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  dishCard: {
    backgroundColor: Colors.neutral[50],
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[2],
  },
  dishHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
  },
  ingQty: {
    width: 56,
    paddingHorizontal: Spacing[2],
  },
  ingUnit: {
    width: 64,
    paddingHorizontal: Spacing[2],
  },
  removeIconBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  // WS5-5P-fix-drag — drag handle for step reorder. Same hit area as
  // removeIconBtn so the two adjacent controls feel symmetric.
  dragHandleBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: Spacing[2],
  },
  stepCircle: {
    width: 32,
    height: 32,
    // D-WS9-022 — full radius for a 32px circle (was the ambiguous old-xl 16;
    // at 32px, 16 IS a circle, so this is pixel-identical).
    borderRadius: Radius.full,
    backgroundColor: Colors.sage[100],
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  stepCircleText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepCircleTiming: {
    backgroundColor: Colors.terracotta[200],
  },
  stepCircleTextTiming: {
    color: Colors.terracotta[700],
  },
  stepTextInput: {
    minHeight: 60,
    textAlignVertical: "top",
  },
  helperText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  dishesStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    paddingVertical: Spacing[3],
  },
  dishesStatusText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  dishPickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[2],
  },
  dishPickerRowSelected: {
    backgroundColor: Colors.sage[50],
    borderColor: Colors.sage[300],
  },
  dishThumb: {
    width: 40,
    height: 40,
    borderRadius: Radius.sm,
    backgroundColor: Colors.neutral[200],
  },
  dishThumbFallback: {
    backgroundColor: Colors.sage[100],
  },
  dishPickerName: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  dishPickerMeta: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  dishPickerMacros: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  dishPickerUse: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
  },
});
