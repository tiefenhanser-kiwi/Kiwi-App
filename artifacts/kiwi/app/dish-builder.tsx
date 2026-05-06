import React, { useEffect, useState } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { useApp } from "@/contexts/AppContext";
import { KColors, KRadius, KSpacing, KType } from "@/constants/tokens";
import {
  CUISINES_TIER_1,
  CUISINES_TIER_2,
} from "@/lib/domain";
import {
  getFeaturedDishes,
  getSavedDishes,
  getTopRatedDishes,
} from "@/lib/stubs";
import type { DishDraft, SavedDish } from "@/lib/types";

const TIME_MIN = 0;
const TIME_MAX = 300;
const TIME_STEP = 5;
const SERVINGS_MIN = 1;
const SERVINGS_MAX = 30;

interface IngredientRow {
  uid: number;
  quantity: number;
  unit: string;
  name: string;
}

interface StepRow {
  uid: number;
  text: string;
  estimatedMinutes: number;
  isTimingSensitive: boolean;
}

interface DishBuilderForm {
  id?: string;
  name: string;
  cuisineType?: string;
  cuisineExpanded: boolean;
  estimatedTimeMinutes: number;
  servingsDefault: number;
  caloriesPerServing: number;
  proteinGPerServing: number;
  carbsGPerServing: number;
  fatGPerServing: number;
  ingredients: IngredientRow[];
  steps: StepRow[];
  notes: string;
}

let UID_COUNTER = 1;
const nextUid = () => UID_COUNTER++;

const emptyIngredient = (): IngredientRow => ({
  uid: nextUid(),
  quantity: 1,
  unit: "",
  name: "",
});

const initialForm = (): DishBuilderForm => ({
  id: undefined,
  name: "",
  cuisineType: undefined,
  cuisineExpanded: false,
  estimatedTimeMinutes: 30,
  servingsDefault: 4,
  caloriesPerServing: 0,
  proteinGPerServing: 0,
  carbsGPerServing: 0,
  fatGPerServing: 0,
  ingredients: [emptyIngredient()],
  steps: [],
  notes: "",
});

function findDishById(id: string): SavedDish | null {
  const all: SavedDish[] = [
    ...getSavedDishes(),
    ...getFeaturedDishes(),
    ...getTopRatedDishes(),
  ];
  return all.find((d) => d.id === id) ?? null;
}

function dishToForm(dish: SavedDish): DishBuilderForm {
  const cuisinePreset =
    dish.cuisineType &&
    [...CUISINES_TIER_1, ...CUISINES_TIER_2].includes(
      dish.cuisineType as never,
    );
  return {
    id: dish.id,
    name: dish.name,
    cuisineType: dish.cuisineType,
    cuisineExpanded:
      !!dish.cuisineType &&
      !cuisinePreset
        ? true
        : !!dish.cuisineType &&
          (CUISINES_TIER_2 as readonly string[]).includes(dish.cuisineType),
    estimatedTimeMinutes: dish.estimatedTimeMinutes ?? 30,
    servingsDefault: 4,
    caloriesPerServing: dish.caloriesPerServing,
    proteinGPerServing: dish.proteinGPerServing,
    carbsGPerServing: dish.carbsGPerServing,
    fatGPerServing: dish.fatGPerServing,
    ingredients: dish.ingredients.length
      ? dish.ingredients.map((i) => ({
          uid: nextUid(),
          quantity: i.quantity,
          unit: i.unit,
          name: i.name,
        }))
      : [emptyIngredient()],
    steps:
      dish.steps?.map((s) => ({
        uid: nextUid(),
        text: s.text,
        estimatedMinutes: s.estimatedMinutes ?? 0,
        isTimingSensitive: s.isTimingSensitive ?? false,
      })) ?? [],
    notes: dish.notes ?? "",
  };
}

export default function DishBuilderScreen() {
  const router = useRouter();
  const { dishId } = useLocalSearchParams<{ dishId?: string }>();
  const { saveDish } = useApp();
  const [form, setForm] = useState<DishBuilderForm>(initialForm);

  // Pre-populate on edit. Re-runs only if dishId changes.
  useEffect(() => {
    if (!dishId) return;
    const dish = findDishById(dishId);
    if (!dish) {
      console.warn("[dish-builder] dishId not found in stubs", { dishId });
      return;
    }
    setForm(dishToForm(dish));
  }, [dishId]);

  const isEdit = !!form.id;
  const headerTitle = isEdit ? `Edit Dish: ${form.name || "—"}` : "Create Dish";

  const update = <K extends keyof DishBuilderForm>(
    key: K,
    value: DishBuilderForm[K],
  ) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateIngredient = (uid: number, patch: Partial<IngredientRow>) => {
    setForm((prev) => ({
      ...prev,
      ingredients: prev.ingredients.map((i) =>
        i.uid === uid ? { ...i, ...patch } : i,
      ),
    }));
  };

  const addIngredient = () => {
    setForm((prev) => ({
      ...prev,
      ingredients: [...prev.ingredients, emptyIngredient()],
    }));
  };

  const removeIngredient = (uid: number) => {
    setForm((prev) => {
      const next = prev.ingredients.filter((i) => i.uid !== uid);
      return {
        ...prev,
        ingredients: next.length ? next : [emptyIngredient()],
      };
    });
  };

  const addStep = () => {
    setForm((prev) => ({
      ...prev,
      steps: [
        ...prev.steps,
        {
          uid: nextUid(),
          text: "",
          estimatedMinutes: 0,
          isTimingSensitive: false,
        },
      ],
    }));
  };

  const updateStep = (uid: number, patch: Partial<StepRow>) => {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.map((s) => (s.uid === uid ? { ...s, ...patch } : s)),
    }));
  };

  const removeStep = (uid: number) => {
    setForm((prev) => ({
      ...prev,
      steps: prev.steps.filter((s) => s.uid !== uid),
    }));
  };

  const handleAiMacros = () => {
    Alert.alert(
      "Coming in WS6 — AI orchestration",
      "Kiwi will determine macros from your ingredients when AI orchestration ships.",
    );
  };

  const handleAiSteps = () => {
    Alert.alert(
      "Coming in WS6 — AI orchestration",
      "Kiwi will suggest recipe steps when AI orchestration ships.",
    );
  };

  const handleSave = async () => {
    Keyboard.dismiss();
    if (!form.name.trim()) {
      Alert.alert("Add a name", "Give this dish a name to save it.");
      return;
    }
    const cleanIngredients = form.ingredients.filter((i) => i.name.trim());
    if (cleanIngredients.length === 0) {
      Alert.alert("Add ingredients", "Add at least one ingredient.");
      return;
    }

    const draft: DishDraft = {
      id: form.id,
      name: form.name.trim(),
      cuisineType: form.cuisineType,
      estimatedTimeMinutes: form.estimatedTimeMinutes,
      servingsDefault: form.servingsDefault,
      ingredients: cleanIngredients.map((i) => ({
        quantity: i.quantity,
        unit: i.unit.trim(),
        name: i.name.trim(),
      })),
      steps: form.steps
        .filter((s) => s.text.trim())
        .map((s, idx) => ({
          stepNumber: idx + 1,
          text: s.text.trim(),
          estimatedMinutes:
            s.estimatedMinutes > 0 ? s.estimatedMinutes : undefined,
          isTimingSensitive: s.isTimingSensitive || undefined,
        })),
      caloriesPerServing: form.caloriesPerServing,
      proteinGPerServing: form.proteinGPerServing,
      carbsGPerServing: form.carbsGPerServing,
      fatGPerServing: form.fatGPerServing,
      notes: form.notes.trim() || undefined,
    };

    const result = await saveDish(draft);
    console.log("[dish-builder] saved", { result, draft });

    Alert.alert(
      isEdit ? "Coming in WS7 — saving dish edits" : "Coming in WS7 — saving new dishes",
      isEdit
        ? "Edits to existing dishes save to your library when the API client lands."
        : "New dishes save to your library when the API client lands.",
      [{ text: "OK", onPress: () => router.back() }],
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        showBack
        title={headerTitle}
        subtitle={isEdit ? "Edit dish" : "Save a dish to reuse across meals"}
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Basics */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Basics</Text>
          <Text style={s.cardTitle}>Dish details</Text>
          <View style={{ marginTop: KSpacing.md, gap: KSpacing.md }}>
            <View>
              <Text style={s.fieldLabel}>Dish name</Text>
              <TextInput
                value={form.name}
                onChangeText={(v) => update("name", v)}
                placeholder="What's the dish called?"
                placeholderTextColor={KColors.neutral[600]}
                returnKeyType="done"
                blurOnSubmit
                onSubmitEditing={Keyboard.dismiss}
                style={s.input}
              />
            </View>
            <View>
              <Text style={s.fieldLabel}>Cuisine</Text>
              <View style={s.chipRow}>
                {CUISINES_TIER_1.map((c) => (
                  <Chip
                    key={c}
                    label={c}
                    selected={form.cuisineType === c}
                    onPress={() =>
                      update("cuisineType", form.cuisineType === c ? undefined : c)
                    }
                  />
                ))}
              </View>
              <ExpandLink
                expanded={form.cuisineExpanded}
                label="More cuisines"
                onPress={() =>
                  update("cuisineExpanded", !form.cuisineExpanded)
                }
              />
              {form.cuisineExpanded && (
                <View style={[s.chipRow, { marginTop: KSpacing.sm }]}>
                  {CUISINES_TIER_2.map((c) => (
                    <Chip
                      key={c}
                      label={c}
                      selected={form.cuisineType === c}
                      onPress={() =>
                        update(
                          "cuisineType",
                          form.cuisineType === c ? undefined : c,
                        )
                      }
                    />
                  ))}
                </View>
              )}
            </View>
          </View>
        </View>

        {/* Section 2: Logistics */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Logistics</Text>
          <Text style={s.cardTitle}>Time & servings</Text>
          <View style={{ marginTop: KSpacing.md, gap: KSpacing.lg }}>
            <View>
              <Text style={s.fieldLabel}>Estimated cook time</Text>
              <Stepper
                value={form.estimatedTimeMinutes}
                onChange={(n) => update("estimatedTimeMinutes", n)}
                min={TIME_MIN}
                max={TIME_MAX}
                step={TIME_STEP}
                suffix="minutes"
              />
            </View>
            <View>
              <Text style={s.fieldLabel}>Servings default</Text>
              <Stepper
                value={form.servingsDefault}
                onChange={(n) => update("servingsDefault", n)}
                min={SERVINGS_MIN}
                max={SERVINGS_MAX}
                suffix={form.servingsDefault === 1 ? "serving" : "servings"}
              />
            </View>
          </View>
        </View>

        {/* Section 3: Macros per serving */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Macros per serving</Text>
          <Text style={s.cardTitle}>Nutrition</Text>
          <Text style={s.cardSubtitle}>Optional</Text>
          <View style={{ marginTop: KSpacing.md, gap: KSpacing.lg }}>
            <View>
              <Text style={s.fieldLabel}>Calories</Text>
              <Stepper
                value={form.caloriesPerServing}
                onChange={(n) => update("caloriesPerServing", n)}
                min={0}
                step={5}
                suffix="cal"
              />
            </View>
            <View>
              <Text style={s.fieldLabel}>Protein</Text>
              <Stepper
                value={form.proteinGPerServing}
                onChange={(n) => update("proteinGPerServing", n)}
                min={0}
                step={1}
                suffix="g"
              />
            </View>
            <View>
              <Text style={s.fieldLabel}>Carbs</Text>
              <Stepper
                value={form.carbsGPerServing}
                onChange={(n) => update("carbsGPerServing", n)}
                min={0}
                step={1}
                suffix="g"
              />
            </View>
            <View>
              <Text style={s.fieldLabel}>Fat</Text>
              <Stepper
                value={form.fatGPerServing}
                onChange={(n) => update("fatGPerServing", n)}
                min={0}
                step={1}
                suffix="g"
              />
            </View>
            <Pressable
              onPress={handleAiMacros}
              style={({ pressed }) => [
                s.aiBtn,
                pressed && { opacity: 0.7 },
              ]}
              hitSlop={6}
            >
              <Feather name="zap" size={14} color={KColors.terracotta[600]} />
              <Text style={s.aiBtnText}>Have Kiwi determine macros</Text>
              <View style={s.premiumPill}>
                <Feather
                  name="lock"
                  size={10}
                  color={KColors.terracotta[700]}
                />
                <Text style={s.premiumPillText}>Premium</Text>
              </View>
            </Pressable>
          </View>
        </View>

        {/* Section 4: Ingredients */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Ingredients</Text>
          <Text style={s.cardTitle}>What's in this dish?</Text>
          <View style={{ marginTop: KSpacing.md, gap: KSpacing.sm }}>
            {form.ingredients.map((ing) => (
              <View key={ing.uid} style={s.ingredientRow}>
                <TextInput
                  value={ing.quantity === 0 ? "" : String(ing.quantity)}
                  onChangeText={(v) => {
                    const n = parseFloat(v.replace(/[^0-9.]/g, ""));
                    updateIngredient(ing.uid, {
                      quantity: Number.isFinite(n) ? n : 0,
                    });
                  }}
                  placeholder="Qty"
                  placeholderTextColor={KColors.neutral[600]}
                  keyboardType="decimal-pad"
                  returnKeyType="done"
                  blurOnSubmit
                  style={[s.input, s.qtyInput]}
                />
                <TextInput
                  value={ing.unit}
                  onChangeText={(v) => updateIngredient(ing.uid, { unit: v })}
                  placeholder="unit"
                  placeholderTextColor={KColors.neutral[600]}
                  returnKeyType="done"
                  blurOnSubmit
                  style={[s.input, s.unitInput]}
                />
                <TextInput
                  value={ing.name}
                  onChangeText={(v) => updateIngredient(ing.uid, { name: v })}
                  placeholder="ingredient"
                  placeholderTextColor={KColors.neutral[600]}
                  returnKeyType="done"
                  blurOnSubmit
                  style={[s.input, { flex: 1 }]}
                />
                <Pressable
                  onPress={() => removeIngredient(ing.uid)}
                  hitSlop={8}
                  style={({ pressed }) => [
                    s.removeBtn,
                    pressed && { opacity: 0.6 },
                  ]}
                >
                  <Feather name="x" size={16} color={KColors.neutral[700]} />
                </Pressable>
              </View>
            ))}
            <Pressable
              onPress={addIngredient}
              style={({ pressed }) => [s.addRowBtn, pressed && { opacity: 0.7 }]}
              hitSlop={6}
            >
              <Feather name="plus" size={14} color={KColors.sage[700]} />
              <Text style={s.addRowText}>Add ingredient</Text>
            </Pressable>
          </View>
        </View>

        {/* Section 5: Steps */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Steps</Text>
          <Text style={s.cardTitle}>How to make it</Text>
          <Text style={s.cardSubtitle}>
            Optional — describe how to make this dish
          </Text>
          <View style={{ marginTop: KSpacing.md, gap: KSpacing.md }}>
            {form.steps.map((step, idx) => (
              <StepEditor
                key={step.uid}
                index={idx}
                step={step}
                onChange={(patch) => updateStep(step.uid, patch)}
                onRemove={() => removeStep(step.uid)}
              />
            ))}
            <Pressable
              onPress={addStep}
              style={({ pressed }) => [s.addRowBtn, pressed && { opacity: 0.7 }]}
              hitSlop={6}
            >
              <Feather name="plus" size={14} color={KColors.sage[700]} />
              <Text style={s.addRowText}>Add step</Text>
            </Pressable>
            <Pressable
              onPress={handleAiSteps}
              style={({ pressed }) => [
                s.aiBtn,
                pressed && { opacity: 0.7 },
              ]}
              hitSlop={6}
            >
              <Feather name="zap" size={14} color={KColors.terracotta[600]} />
              <Text style={s.aiBtnText}>Have Kiwi suggest steps</Text>
              <View style={s.premiumPill}>
                <Feather
                  name="lock"
                  size={10}
                  color={KColors.terracotta[700]}
                />
                <Text style={s.premiumPillText}>Premium</Text>
              </View>
            </Pressable>
          </View>
        </View>

        {/* Section 6: Notes */}
        <View style={s.card}>
          <Text style={s.sectionLabel}>Notes</Text>
          <Text style={s.cardTitle}>Anything else?</Text>
          <Text style={s.cardSubtitle}>
            Optional — anything else worth remembering
          </Text>
          <View style={{ marginTop: KSpacing.md }}>
            <TextInput
              value={form.notes}
              onChangeText={(v) => update("notes", v)}
              placeholder="e.g., 'best with fresh herbs', 'sub butter for ghee'"
              placeholderTextColor={KColors.neutral[600]}
              multiline
              returnKeyType="default"
              blurOnSubmit
              style={[s.input, { minHeight: 80 }]}
            />
          </View>
        </View>

        {/* Submit + cancel */}
        <View style={s.footer}>
          <Button
            label={isEdit ? "Save changes" : "Save dish"}
            variant="terra"
            onPress={handleSave}
          />
          <Text style={s.footerHint}>
            {isEdit
              ? "Updates this dish in your library"
              : "Adds to your saved dishes"}
          </Text>
          <Pressable
            onPress={() => router.back()}
            hitSlop={6}
            style={({ pressed }) => [
              s.cancelLink,
              pressed && { opacity: 0.6 },
            ]}
          >
            <Text style={s.cancelText}>Cancel</Text>
          </Pressable>
        </View>
      </KeyboardAwareScrollViewCompat>
    </View>
  );
}

function StepEditor({
  index,
  step,
  onChange,
  onRemove,
}: {
  index: number;
  step: StepRow;
  onChange: (patch: Partial<StepRow>) => void;
  onRemove: () => void;
}) {
  return (
    <View style={s.stepEditorRow}>
      <View
        style={[
          s.stepCircle,
          step.isTimingSensitive
            ? s.stepCircleTiming
            : s.stepCircleNormal,
        ]}
      >
        <Text
          style={
            step.isTimingSensitive
              ? s.stepCircleTextTiming
              : s.stepCircleTextNormal
          }
        >
          {index + 1}
        </Text>
      </View>
      <View style={{ flex: 1, gap: KSpacing.xs }}>
        <TextInput
          value={step.text}
          onChangeText={(v) => onChange({ text: v })}
          placeholder="Describe this step…"
          placeholderTextColor={KColors.neutral[600]}
          multiline
          returnKeyType="default"
          blurOnSubmit
          style={[s.input, { minHeight: 60 }]}
        />
        <View style={s.stepMetaRow}>
          <TextInput
            value={
              step.estimatedMinutes === 0 ? "" : String(step.estimatedMinutes)
            }
            onChangeText={(v) => {
              const n = parseInt(v.replace(/[^0-9]/g, ""), 10);
              onChange({ estimatedMinutes: Number.isFinite(n) ? n : 0 });
            }}
            placeholder="min"
            placeholderTextColor={KColors.neutral[600]}
            keyboardType="number-pad"
            returnKeyType="done"
            blurOnSubmit
            style={[s.input, s.minutesInput]}
          />
          <Pressable
            onPress={() =>
              onChange({ isTimingSensitive: !step.isTimingSensitive })
            }
            hitSlop={6}
            style={({ pressed }) => [
              s.timingToggle,
              step.isTimingSensitive && s.timingToggleActive,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather
              name="clock"
              size={12}
              color={
                step.isTimingSensitive
                  ? KColors.terracotta[700]
                  : KColors.neutral[700]
              }
            />
            <Text
              style={[
                s.timingToggleText,
                step.isTimingSensitive && s.timingToggleTextActive,
              ]}
            >
              Timing-sensitive
            </Text>
          </Pressable>
        </View>
      </View>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        style={({ pressed }) => [
          s.removeBtn,
          pressed && { opacity: 0.6 },
        ]}
      >
        <Feather name="x" size={16} color={KColors.neutral[700]} />
      </Pressable>
    </View>
  );
}

function ExpandLink({
  expanded,
  label,
  onPress,
}: {
  expanded: boolean;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      style={({ pressed }) => [
        s.expandLink,
        pressed && { opacity: 0.6 },
      ]}
    >
      <Text style={s.expandLinkText}>{label}</Text>
      <Feather
        name={expanded ? "chevron-up" : "chevron-down"}
        size={14}
        color={KColors.sage[700]}
      />
    </Pressable>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl * 2,
    gap: KSpacing.md,
  },
  card: {
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    padding: KSpacing.lg,
  },
  sectionLabel: {
    fontSize: KType.size.xs,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    fontFamily: "Inter_600SemiBold",
    marginBottom: 6,
  },
  cardTitle: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  cardSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    marginTop: 2,
  },
  fieldLabel: {
    fontSize: KType.size.sm,
    color: KColors.neutral[800],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginBottom: KSpacing.xs,
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
    marginTop: KSpacing.sm,
    alignSelf: "flex-start",
  },
  expandLinkText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  input: {
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
    textAlignVertical: "top",
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
  },
  qtyInput: {
    width: 56,
    paddingHorizontal: KSpacing.sm,
  },
  unitInput: {
    width: 70,
    paddingHorizontal: KSpacing.sm,
  },
  removeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  addRowBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: KSpacing.xs,
  },
  addRowText: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  aiBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KColors.terracotta[50],
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
    alignSelf: "flex-start",
  },
  aiBtnText: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: KColors.terracotta[100],
    borderRadius: KRadius.pill,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 2,
  },
  premiumPillText: {
    fontSize: KType.size.xs,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepEditorRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "flex-start",
  },
  stepCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  stepCircleNormal: {
    backgroundColor: KColors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: KColors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepCircleTextTiming: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  stepMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  minutesInput: {
    width: 72,
    paddingHorizontal: KSpacing.sm,
  },
  timingToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.xs,
    borderRadius: KRadius.pill,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    backgroundColor: KColors.neutral[0],
  },
  timingToggleActive: {
    borderColor: KColors.terracotta[300],
    backgroundColor: KColors.terracotta[50],
  },
  timingToggleText: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_500Medium",
  },
  timingToggleTextActive: {
    color: KColors.terracotta[700],
    fontWeight: KType.weight.semibold,
  },
  footer: {
    marginTop: KSpacing.lg,
    gap: KSpacing.sm,
    alignItems: "center",
  },
  footerHint: {
    fontSize: KType.size.xs,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  cancelLink: {
    paddingVertical: KSpacing.sm,
    paddingHorizontal: KSpacing.md,
    marginTop: KSpacing.xs,
  },
  cancelText: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
});
