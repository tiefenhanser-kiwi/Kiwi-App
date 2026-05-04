import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useLocalSearchParams } from "expo-router";

import { Button } from "@/components/Button";
import { DishChooserSheet } from "@/components/DishChooserSheet";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import {
  KColors,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";
import { getMealById, getSavedDishes } from "@/lib/stubs";
import type { SavedDish } from "@/lib/types";

type Mode = "manual" | "combine" | "ai" | null;
type Difficulty = "easy" | "medium" | "hard";

interface BuilderIngredient {
  uid: number;
  quantity: string;
  unit: string;
  name: string;
}

interface BuilderDish {
  uid: number;
  name: string;
  ingredients: BuilderIngredient[];
}

interface BuilderStep {
  uid: number;
  text: string;
  estimatedMinutes: string;
}

const SERVINGS_MIN = 1;
const SERVINGS_MAX = 12;

let nextUid = 1;
const allocUid = () => nextUid++;

/**
 * Parse a quantity string supporting fractions and decimals.
 * Returns null for invalid input.
 * Examples: "1.5" → 1.5, "1/2" → 0.5, "1 1/2" → 1.5, "abc" → null
 */
export function parseQuantity(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Plain decimal: "1.5", "0.25", "2"
  const decimal = Number(trimmed);
  if (!isNaN(decimal) && isFinite(decimal)) return decimal;

  // Mixed fraction: "1 1/2", "2 3/4"
  const mixedMatch = trimmed.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (mixedMatch) {
    const [, whole, num, den] = mixedMatch;
    const denN = Number(den);
    if (denN === 0) return null;
    return Number(whole) + Number(num) / denN;
  }

  // Pure fraction: "1/2", "3/4", "1/8"
  const fracMatch = trimmed.match(/^(\d+)\/(\d+)$/);
  if (fracMatch) {
    const [, num, den] = fracMatch;
    const denN = Number(den);
    if (denN === 0) return null;
    return Number(num) / denN;
  }

  return null;
}

const newIngredient = (
  partial?: Partial<Omit<BuilderIngredient, "uid">>,
): BuilderIngredient => ({
  uid: allocUid(),
  quantity: partial?.quantity ?? "",
  unit: partial?.unit ?? "",
  name: partial?.name ?? "",
});

const newDish = (
  partial?: Partial<Omit<BuilderDish, "uid" | "ingredients">> & {
    ingredients?: BuilderIngredient[];
  },
): BuilderDish => ({
  uid: allocUid(),
  name: partial?.name ?? "",
  ingredients: partial?.ingredients ?? [newIngredient()],
});

const newStep = (
  partial?: Partial<Omit<BuilderStep, "uid">>,
): BuilderStep => ({
  uid: allocUid(),
  text: partial?.text ?? "",
  estimatedMinutes: partial?.estimatedMinutes ?? "",
});

export default function MealBuilderScreen() {
  const { mealId, planId, planItemId, mode: modeParam } =
    useLocalSearchParams<{
      mealId?: string;
      planId?: string;
      planItemId?: string;
      mode?: "manual" | "combine" | "ai";
    }>();
  const isEditFromPlanContext = !!(mealId && planId && planItemId);

  const sourceMeal = useMemo(
    () => (mealId ? getMealById(mealId) : null),
    [mealId],
  );

  const [mode, setModeState] = useState<Mode>(() => {
    if (mealId) return "manual";
    if (modeParam === "manual" || modeParam === "combine") return modeParam;
    return null;
  });

  // ── Manual-mode state ───────────────────────────────────────────
  const [mealName, setMealName] = useState("");
  const [cuisineType, setCuisineType] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  const [estimatedTimeMinutes, setEstimatedTimeMinutes] = useState("30");
  const [servingsDefault, setServingsDefault] = useState(4);
  const [dishes, setDishes] = useState<BuilderDish[]>(() => [newDish()]);
  // Steps are optional per PRD §10.5 — start empty so the empty-state copy
  // surfaces and users aren't forced into a forms-y experience for simple dishes.
  const [steps, setSteps] = useState<BuilderStep[]>([]);
  const [notes, setNotes] = useState("");

  // ── Combine-mode state ──────────────────────────────────────────
  const savedDishes = useMemo(() => getSavedDishes(), []);
  const [selectedDishIds, setSelectedDishIds] = useState<string[]>([]);
  const [combineReview, setCombineReview] = useState(false);

  // ── Dish chooser sheet (Mode B "+ Add Dish") ────────────────────
  const [dishChooserVisible, setDishChooserVisible] = useState(false);

  // Pre-population from existing meal (one-shot on mount when mealId present).
  useEffect(() => {
    if (!sourceMeal) return;
    setMealName(sourceMeal.title);
    setCuisineType(sourceMeal.cuisineType ?? "");
    setDifficulty(sourceMeal.difficulty);
    setEstimatedTimeMinutes(String(sourceMeal.estimatedTimeMinutes));
    setServingsDefault(sourceMeal.servingsDefault);
    setDishes(
      sourceMeal.dishes.map((d) =>
        newDish({
          name: d.name,
          ingredients:
            d.ingredients.length > 0
              ? d.ingredients.map((ing) =>
                  newIngredient({
                    quantity: String(ing.quantity),
                    unit: ing.unit,
                    name: ing.name,
                  }),
                )
              : [newIngredient()],
        }),
      ),
    );
    setSteps(
      sourceMeal.steps.length > 0
        ? sourceMeal.steps.map((st) =>
            newStep({
              text: st.text,
              estimatedMinutes:
                st.estimatedMinutes !== undefined
                  ? String(st.estimatedMinutes)
                  : "",
            }),
          )
        : [],
    );
    setNotes(sourceMeal.notes ?? "");
  }, [sourceMeal]);

  const headerTitle = sourceMeal
    ? `Edit Meal: ${sourceMeal.title}`
    : "Create Meal";

  // ── Mode switching with unsaved-data guard ──────────────────────
  const hasManualData = (): boolean => {
    if (mealName.trim().length > 0) return true;
    if (cuisineType.trim().length > 0) return true;
    if (notes.trim().length > 0) return true;
    if (dishes.some((d) => d.name.trim() || d.ingredients.some((i) => i.quantity || i.unit || i.name))) {
      return true;
    }
    if (steps.some((st) => st.text.trim())) return true;
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

  const addStep = () => setSteps((prev) => [...prev, newStep()]);
  const removeStep = (uid: number) =>
    setSteps((prev) => prev.filter((st) => st.uid !== uid));
  const updateStep = (
    uid: number,
    patch: Partial<Omit<BuilderStep, "uid">>,
  ) =>
    setSteps((prev) =>
      prev.map((st) => (st.uid === uid ? { ...st, ...patch } : st)),
    );

  // Stable identity so DishPickerRow's memoization holds across parent re-renders
  // (e.g. while user types in MetaFields above the picker).
  const toggleSelectedDish = useCallback((id: string) => {
    setSelectedDishIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }, []);

  // ── Save (stub) ─────────────────────────────────────────────────
  const manualSaveDisabled =
    mealName.trim().length === 0 ||
    !dishes.some((d) =>
      d.ingredients.some(
        (i) => i.name.trim().length > 0 || i.quantity.trim().length > 0,
      ),
    );
  const combineSaveDisabled =
    mealName.trim().length === 0 || selectedDishIds.length === 0;

  const onSave = () => {
    if (mode === "manual") {
      const ingredientCount = dishes.reduce(
        (acc, d) => acc + d.ingredients.length,
        0,
      );
      console.log("[meal-builder] save tapped", {
        mode,
        mealName,
        mealId: sourceMeal?.id,
        dishCount: dishes.length,
        ingredientCount,
      });
    } else if (mode === "combine") {
      console.log("[meal-builder] save tapped", {
        mode,
        mealName,
        mealId: sourceMeal?.id,
        dishCount: selectedDishIds.length,
      });
    }
    // §2.5 prompt only when editing an existing meal AND that edit was opened
    // from a plan context (planId + planItemId in route params).
    if (isEditFromPlanContext) {
      Alert.alert(
        "Save changes",
        "How do you want to apply your edits?",
        [
          {
            text: "Save changes only on this plan",
            onPress: () => {
              console.log("[meal-builder] save (just-this-plan) tapped", {
                mealId,
                planId,
                planItemId,
              });
              Alert.alert(
                "Coming in WS7",
                "Saving plan-instance overrides requires the API client. This will be wired in WS7.",
              );
            },
          },
          {
            text: "Save edits for this meal",
            onPress: () => {
              console.log("[meal-builder] save (save-globally) tapped", {
                mealId,
                planId,
                planItemId,
              });
              Alert.alert(
                "Coming in WS7",
                "Saving meals globally requires the API client. This will be wired in WS7.",
              );
            },
          },
          { text: "Cancel", style: "cancel" },
        ],
      );
    } else {
      Alert.alert(
        "Coming in WS7",
        "Saving meals requires the API client. This action will be wired in WS7. Your work is preserved on this screen until you navigate away.",
      );
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header showBack title={headerTitle} />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Edit-context info card: surfaces the §2.5 plan-vs-global save framing */}
        {mealId && (
          <View style={s.contextInfo}>
            <Text style={s.contextInfoText}>
              Adjust ingredients, steps, or dishes in this meal. You can make
              changes for cooking just this time or apply changes to your saved
              recipe.
            </Text>
          </View>
        )}

        {/* Mode picker — create-context only */}
        {!mealId && (
          <View>
            <Text style={s.sectionHeader}>How do you want to build this meal?</Text>
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
            <ModeCard
              icon="type"
              title="Tell Kiwi what you want"
              subtitle="Premium · coming in WS6 — paste a recipe or describe a dish, Kiwi parses it"
              selected={false}
              locked
              onPress={() => {
                Alert.alert(
                  "Coming in WS6 — AI orchestration",
                  "Pasting recipe text and having Kiwi parse it requires the AI layer. This will be wired in WS6.",
                );
              }}
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
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            estimatedTimeMinutes={estimatedTimeMinutes}
            setEstimatedTimeMinutes={setEstimatedTimeMinutes}
            servingsDefault={servingsDefault}
            setServingsDefault={setServingsDefault}
            dishes={dishes}
            onOpenDishChooser={() => setDishChooserVisible(true)}
            removeDish={removeDish}
            updateDishName={updateDishName}
            addIngredient={addIngredient}
            removeIngredient={removeIngredient}
            updateIngredient={updateIngredient}
            steps={steps}
            addStep={addStep}
            removeStep={removeStep}
            updateStep={updateStep}
            notes={notes}
            setNotes={setNotes}
          />
        )}

        {mode === "combine" && !combineReview && (
          <CombinePicker
            mealName={mealName}
            setMealName={setMealName}
            cuisineType={cuisineType}
            setCuisineType={setCuisineType}
            difficulty={difficulty}
            setDifficulty={setDifficulty}
            estimatedTimeMinutes={estimatedTimeMinutes}
            setEstimatedTimeMinutes={setEstimatedTimeMinutes}
            servingsDefault={servingsDefault}
            setServingsDefault={setServingsDefault}
            savedDishes={savedDishes}
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
          />
        )}
      </KeyboardAwareScrollViewCompat>

      {(mode === "manual" || (mode === "combine" && combineReview)) && (
        <View style={s.saveBar}>
          <Button
            label="Save meal"
            variant="primary"
            disabled={
              mode === "manual" ? manualSaveDisabled : combineSaveDisabled
            }
            onPress={onSave}
          />
        </View>
      )}

      <DishChooserSheet
        visible={dishChooserVisible}
        onClose={() => setDishChooserVisible(false)}
        onPickSavedDish={(dish) => {
          const next = newDish({
            name: dish.name,
            ingredients: dish.ingredients.map((ing) =>
              newIngredient({
                quantity: String(ing.quantity),
                unit: ing.unit,
                name: ing.name,
              }),
            ),
          });
          setDishes((prev) => [...prev, next]);
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
              ? KColors.neutral[600]
              : selected
                ? KColors.sage[700]
                : KColors.neutral[800]
          }
        />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[s.modeTitle, locked && { color: KColors.neutral[700] }]}>
          {title}
        </Text>
        <Text style={s.modeSubtitle}>{subtitle}</Text>
      </View>
      {locked && (
        <View style={s.premiumPill}>
          <Feather name="lock" size={10} color={KColors.terracotta[700]} />
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
  difficulty: Difficulty;
  setDifficulty: (v: Difficulty) => void;
  estimatedTimeMinutes: string;
  setEstimatedTimeMinutes: (v: string) => void;
  servingsDefault: number;
  setServingsDefault: (v: number) => void;
}

function MetaFields(p: MetaFieldsProps) {
  const decServings = () =>
    p.setServingsDefault(Math.max(SERVINGS_MIN, p.servingsDefault - 1));
  const incServings = () =>
    p.setServingsDefault(Math.min(SERVINGS_MAX, p.servingsDefault + 1));

  return (
    <View style={{ gap: KSpacing.md }}>
      <View>
        <Text style={s.fieldLabel}>Meal name</Text>
        <TextInput
          value={p.mealName}
          onChangeText={p.setMealName}
          placeholder="Meal name (e.g., Salmon Teriyaki)"
          placeholderTextColor={KColors.neutral[600]}
          style={s.textInput}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={Keyboard.dismiss}
        />
      </View>
      <View>
        <Text style={s.fieldLabel}>Cuisine</Text>
        <TextInput
          value={p.cuisineType}
          onChangeText={p.setCuisineType}
          placeholder="Cuisine (Italian, Japanese, etc.)"
          placeholderTextColor={KColors.neutral[600]}
          style={s.textInput}
          returnKeyType="done"
          blurOnSubmit
          onSubmitEditing={Keyboard.dismiss}
        />
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
              placeholderTextColor={KColors.neutral[600]}
              style={[s.textInput, { flex: 1 }]}
              returnKeyType="done"
              blurOnSubmit
              onSubmitEditing={Keyboard.dismiss}
            />
            <Text style={s.suffixLabel}>min</Text>
          </View>
        </View>
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
              <Feather name="minus" size={16} color={KColors.sage[700]} />
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
              <Feather name="plus" size={16} color={KColors.sage[700]} />
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Mode B — Manual editor
// ─────────────────────────────────────────────────────────────────

interface ManualEditorProps extends MetaFieldsProps {
  dishes: BuilderDish[];
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
  steps: BuilderStep[];
  addStep: () => void;
  removeStep: (uid: number) => void;
  updateStep: (uid: number, patch: Partial<Omit<BuilderStep, "uid">>) => void;
  notes: string;
  setNotes: (v: string) => void;
}

function ManualEditor(p: ManualEditorProps) {
  const moreThanOneDish = p.dishes.length > 1;
  return (
    <View style={{ marginTop: KSpacing.lg, gap: KSpacing.lg }}>
      <MetaFields {...p} />

      {/* Ingredients */}
      <View style={{ gap: KSpacing.sm }}>
        <Text style={s.subHeader}>Ingredients</Text>
        {p.dishes.map((dish) => (
          <View key={dish.uid} style={s.dishCard}>
            <View style={s.dishHeaderRow}>
              <TextInput
                value={dish.name}
                onChangeText={(v) => p.updateDishName(dish.uid, v)}
                placeholder="Dish name (optional)"
                placeholderTextColor={KColors.neutral[600]}
                style={[s.textInput, { flex: 1 }]}
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={Keyboard.dismiss}
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
                  <Feather name="trash-2" size={16} color={KColors.terracotta[600]} />
                </Pressable>
              )}
            </View>
            <View style={{ gap: KSpacing.xs, marginTop: KSpacing.sm }}>
              {dish.ingredients.map((ing) => {
                // Quantity supports decimals + fractions ("1/2", "1 1/2").
                // Invalid only when non-empty AND parser rejects.
                const qtyInvalid =
                  ing.quantity.trim().length > 0 &&
                  parseQuantity(ing.quantity) === null;
                return (
                  <View key={ing.uid}>
                    <View style={s.ingredientRow}>
                      <TextInput
                        value={ing.quantity}
                        onChangeText={(v) =>
                          p.updateIngredient(dish.uid, ing.uid, { quantity: v })
                        }
                        placeholder="Qty"
                        placeholderTextColor={KColors.neutral[600]}
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
                        placeholderTextColor={KColors.neutral[600]}
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
                        placeholderTextColor={KColors.neutral[600]}
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
                          color={KColors.neutral[700]}
                        />
                      </Pressable>
                    </View>
                    {qtyInvalid && (
                      <Text style={s.invalidBadge}>
                        Invalid quantity (try 1, 1.5, 1/2, or 1 1/2)
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
                <Feather name="plus" size={14} color={KColors.sage[700]} />
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

      {/* Steps — optional per PRD §10.5 */}
      <View style={{ gap: KSpacing.sm }}>
        <Text style={s.subHeader}>Recipe steps</Text>
        {p.steps.length === 0 && (
          <View style={s.stepsEmptyState}>
            <Text style={s.stepsEmptyText}>
              Cooking steps are optional. Add them yourself, or skip if not
              needed (store-bought sides, leftovers, simple plating).
            </Text>
          </View>
        )}
        {p.steps.map((step, i) => (
          <View key={step.uid} style={s.stepRow}>
            <View style={s.stepCircle}>
              <Text style={s.stepCircleText}>{i + 1}</Text>
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <TextInput
                value={step.text}
                onChangeText={(v) => p.updateStep(step.uid, { text: v })}
                placeholder="Step description"
                placeholderTextColor={KColors.neutral[600]}
                style={[s.textInput, s.stepTextInput]}
                multiline
                returnKeyType="default"
                blurOnSubmit={false}
              />
              <View style={s.suffixRow}>
                <TextInput
                  value={step.estimatedMinutes}
                  onChangeText={(v) =>
                    p.updateStep(step.uid, {
                      estimatedMinutes: v.replace(/[^0-9]/g, ""),
                    })
                  }
                  placeholder="0"
                  placeholderTextColor={KColors.neutral[600]}
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
              onPress={() => p.removeStep(step.uid)}
              hitSlop={8}
              style={({ pressed }) => [
                s.removeIconBtn,
                pressed && { opacity: 0.6 },
              ]}
            >
              <Feather name="x" size={16} color={KColors.neutral[700]} />
            </Pressable>
          </View>
        ))}
        <View style={s.stepsActionsRow}>
          <Button label="+ Add step" variant="ghost" onPress={p.addStep} />
        </View>
      </View>

      {/* Notes */}
      <View style={{ gap: KSpacing.sm }}>
        <Text style={s.subHeader}>Notes (optional)</Text>
        <TextInput
          value={p.notes}
          onChangeText={p.setNotes}
          placeholder="Add any notes about this meal..."
          placeholderTextColor={KColors.neutral[600]}
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
// Mode C — Combine picker
// ─────────────────────────────────────────────────────────────────

interface CombinePickerProps extends MetaFieldsProps {
  savedDishes: SavedDish[];
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
    <View style={{ marginTop: KSpacing.lg, gap: KSpacing.lg }}>
      <MetaFields {...p} />
      <View style={{ gap: KSpacing.sm }}>
        <Text style={s.subHeader}>Pick dishes to combine</Text>
        <Text style={s.helperText}>
          Selected dishes will become this meal&apos;s components. You can edit
          ingredients afterward.
        </Text>
        {p.savedDishes.map((dish) => (
          <DishPickerRow
            key={dish.id}
            dish={dish}
            isSelected={selectedSet.has(dish.id)}
            onToggle={p.onToggle}
          />
        ))}
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
        color={isSelected ? KColors.sage[700] : KColors.neutral[600]}
      />
      <View style={[s.dishThumb, !dish.imageUrl && s.dishThumbFallback]} />
      <View style={{ flex: 1 }}>
        <Text style={s.dishPickerName}>{dish.name}</Text>
        <Text style={s.dishPickerMeta}>
          {[dish.cuisineType, `${dish.caloriesPerServing} cal/serving`]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      </View>
      {dish.useCount !== undefined && (
        <Text style={s.dishPickerUse}>
          Used in {dish.useCount} meals
        </Text>
      )}
    </Pressable>
  );
});

// ─────────────────────────────────────────────────────────────────
// Mode C — Combine review
// ─────────────────────────────────────────────────────────────────

interface CombineReviewProps {
  savedDishes: SavedDish[];
  selectedDishIds: string[];
  onBack: () => void;
}

function CombineReview({
  savedDishes,
  selectedDishIds,
  onBack,
}: CombineReviewProps) {
  const selected = savedDishes.filter((d) => selectedDishIds.includes(d.id));
  return (
    <View style={{ marginTop: KSpacing.lg, gap: KSpacing.md }}>
      <View style={s.subHeaderRow}>
        <Text style={s.subHeader}>Review combined meal</Text>
        <Pressable
          onPress={onBack}
          hitSlop={6}
          style={({ pressed }) => [
            s.addLinkBtn,
            pressed && { opacity: 0.7 },
          ]}
        >
          <Feather name="chevron-left" size={14} color={KColors.sage[700]} />
          <Text style={s.addLinkText}>Back to picker</Text>
        </Pressable>
      </View>
      <Text style={s.helperText}>
        After saving, you can edit any dish or ingredient individually.
      </Text>
      {selected.map((dish) => (
        <View key={dish.id} style={s.reviewDish}>
          <Text style={s.reviewDishHeader}>{dish.name}</Text>
          {dish.ingredients.map((ing, i) => (
            <Text key={i} style={s.reviewIngredient}>
              {ing.quantity} {ing.unit} {ing.name}
            </Text>
          ))}
        </View>
      ))}
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.md,
    paddingBottom: 240,
  },
  saveBar: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.md,
    paddingBottom: KSpacing.xl,
    backgroundColor: KColors.neutral[100],
    borderTopWidth: 1,
    borderTopColor: KColors.neutral[400],
  },
  sectionHeader: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.sm,
  },
  contextInfo: {
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.sage[300],
    padding: KSpacing.md,
    marginBottom: KSpacing.md,
  },
  contextInfoText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  addDishWrap: {
    marginTop: KSpacing.md,
    marginBottom: KSpacing.lg,
  },
  stepsEmptyState: {
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
    alignItems: "center",
  },
  stepsEmptyText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    fontStyle: "italic",
    textAlign: "center",
    lineHeight: 18,
  },
  stepsActionsRow: {
    marginTop: KSpacing.sm,
  },
  modeCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    padding: KSpacing.md,
    marginBottom: KSpacing.sm,
  },
  modeCardSelected: {
    backgroundColor: KColors.sage[100],
    borderColor: KColors.sage[300],
  },
  modeCardLocked: {
    opacity: 0.85,
    backgroundColor: KColors.neutral[50],
  },
  modeIconWrap: {
    width: 36,
    height: 36,
    borderRadius: KRadius.md,
    backgroundColor: KColors.neutral[100],
    alignItems: "center",
    justifyContent: "center",
  },
  modeTitle: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  modeSubtitle: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 4,
  },
  premiumPillText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  fieldLabel: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  textInput: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  inputInvalid: {
    borderColor: KColors.terracotta[400],
  },
  invalidBadge: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
    marginLeft: 4,
  },
  notesInput: {
    minHeight: 80,
    textAlignVertical: "top",
  },
  difficultyRow: {
    flexDirection: "row",
    gap: KSpacing.xs,
  },
  difficultyBtn: {
    flex: 1,
    paddingVertical: KSpacing.sm,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    backgroundColor: KColors.neutral[0],
    alignItems: "center",
  },
  difficultyBtnOn: {
    backgroundColor: KColors.sage[700],
    borderColor: KColors.sage[700],
  },
  difficultyBtnTextOn: {
    fontSize: KType.size.sm,
    color: KColors.neutral[0],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  difficultyBtnTextOff: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  timeServingsRow: {
    flexDirection: "row",
    gap: KSpacing.md,
  },
  suffixRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  suffixLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.sm,
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
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    minWidth: 20,
    textAlign: "center",
  },
  subHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  subHeader: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  addLinkBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingVertical: 4,
    paddingHorizontal: KSpacing.xs,
  },
  addLinkText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dishCard: {
    backgroundColor: KColors.neutral[50],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  dishHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
  },
  ingQty: {
    width: 56,
    paddingHorizontal: KSpacing.sm,
  },
  ingUnit: {
    width: 64,
    paddingHorizontal: KSpacing.sm,
  },
  removeIconBtn: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: KSpacing.sm,
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: KColors.sage[100],
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  stepCircleText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepTextInput: {
    minHeight: 60,
    textAlignVertical: "top",
  },
  helperText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  dishPickerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.sm,
  },
  dishPickerRowSelected: {
    backgroundColor: KColors.sage[50],
    borderColor: KColors.sage[300],
  },
  dishThumb: {
    width: 40,
    height: 40,
    borderRadius: KRadius.sm,
    backgroundColor: KColors.neutral[200],
  },
  dishThumbFallback: {
    backgroundColor: KColors.sage[100],
  },
  dishPickerName: {
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  dishPickerMeta: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  dishPickerUse: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
  },
  reviewDish: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.md,
    gap: 4,
  },
  reviewDishHeader: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: 4,
  },
  reviewIngredient: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontFamily: "Inter_400Regular",
    lineHeight: 20,
  },
});
