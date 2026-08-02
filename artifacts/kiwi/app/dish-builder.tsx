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
import DraggableFlatList, {
  ScaleDecorator,
  type RenderItemParams,
} from "react-native-draggable-flatlist";

import { Button } from "@/components/Button";
import { Chip } from "@/components/Chip";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { Stepper } from "@/components/Stepper";
import { useApp } from "@/contexts/AppContext";
import { Colors, Palette, Radius, Spacing, Typography } from "@/constants/tokens";
import {
  assistIngredients,
  assistSteps,
} from "@/lib/api/builder";
import {
  CUISINES_TIER_1,
  CUISINES_TIER_2,
} from "@/lib/domain";
import {
  getFeaturedDishes,
  getSavedDishes,
  getTopRatedDishes,
} from "@/lib/stubs";
import type { DraftDish } from "@/lib/builder/parsedDishToDraft";
import { resolveDishPostSaveNav } from "@/lib/builder/dishPostSaveNav";
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
  type: "side" | "main";
  estimatedTimeMinutes: number;
  servingsDefault: number;
  kiwiAssistIngredients: boolean;
  kiwiAssistSteps: boolean;
  // Hidden — preserved across edit but not user-controlled. Macros
  // are AI-computed from ingredients on save (WS6); WS5-5O-fix-2
  // removed manual entry + the kiwiAssistMacros toggle.
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
  type: "main",
  estimatedTimeMinutes: 30,
  servingsDefault: 4,
  kiwiAssistIngredients: false,
  kiwiAssistSteps: false,
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
  const isTier2 =
    !!dish.cuisineType &&
    (CUISINES_TIER_2 as readonly string[]).includes(dish.cuisineType);
  return {
    id: dish.id,
    name: dish.name,
    cuisineType: dish.cuisineType,
    cuisineExpanded: isTier2,
    type: dish.type,
    estimatedTimeMinutes: dish.estimatedTimeMinutes ?? 30,
    servingsDefault: 4,
    // Kiwi-assist defaults to false on edit — user's existing manual
    // content takes precedence and shouldn't be silently overwritten.
    kiwiAssistIngredients: false,
    kiwiAssistSteps: false,
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

// WS7-6 G2 — Dish Mode A draft hydration. Maps a DraftDish (the
// parsedDishToDraft output handed in via the draftJson param from the dish-side
// "Ask Kiwi" screen) into the builder form. Mirrors dishToForm but seeds a NEW
// dish (no id) — the user reviews/edits before the first save.
function draftDishToForm(draft: DraftDish): DishBuilderForm {
  const isTier2 =
    !!draft.cuisineType &&
    (CUISINES_TIER_2 as readonly string[]).includes(draft.cuisineType);
  return {
    id: undefined,
    name: draft.name,
    cuisineType: draft.cuisineType,
    cuisineExpanded: isTier2,
    type: draft.type,
    estimatedTimeMinutes: draft.estimatedTimeMinutes,
    servingsDefault: draft.servingsDefault,
    kiwiAssistIngredients: false,
    kiwiAssistSteps: false,
    caloriesPerServing: 0,
    proteinGPerServing: 0,
    carbsGPerServing: 0,
    fatGPerServing: 0,
    ingredients: draft.ingredients.length
      ? draft.ingredients.map((i) => ({
          uid: nextUid(),
          quantity: i.quantity,
          unit: i.unit,
          name: i.name,
        }))
      : [emptyIngredient()],
    steps: draft.steps.map((s) => ({
      uid: nextUid(),
      text: s.text,
      estimatedMinutes: s.estimatedMinutes ?? 0,
      isTimingSensitive: s.isTimingSensitive ?? false,
    })),
    notes: "",
  };
}

export default function DishBuilderScreen() {
  const router = useRouter();
  const { dishId, draftJson } = useLocalSearchParams<{
    dishId?: string;
    draftJson?: string;
  }>();
  const { saveDish } = useApp();
  const [form, setForm] = useState<DishBuilderForm>(initialForm);
  // WS7-6 Block 1C: in-flight flags for the two Kiwi-assist buttons.
  // Local-only state — each assist call is a one-shot fire that replaces
  // the form section on success.
  const [assistingIngredients, setAssistingIngredients] = useState(false);
  const [assistingSteps, setAssistingSteps] = useState(false);

  useEffect(() => {
    if (!dishId) return;
    const dish = findDishById(dishId);
    if (!dish) {
      console.warn("[dish-builder] dishId not found in stubs", { dishId });
      return;
    }
    setForm(dishToForm(dish));
  }, [dishId]);

  // WS7-6 G2 — Dish Mode A: hydrate the form once from a draftJson (DraftDish)
  // handed in by the dish-side "Ask Kiwi" screen. Guarded behind !dishId so an
  // edit context (dishId present) always wins. A malformed draft leaves the
  // blank initial form so the user can still build manually.
  useEffect(() => {
    if (dishId || !draftJson) return;
    try {
      const draft = JSON.parse(draftJson) as DraftDish;
      setForm(draftDishToForm(draft));
    } catch {
      console.warn("[dish-builder] malformed draftJson ignored");
    }
  }, [dishId, draftJson]);

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

  // WS5-5P-fix-drag — drag-to-reorder writes the new array back. The
  // StepEditor reads its position from the `index` prop (passed from
  // the renderItem callback), and `stepNumber` is derived from the
  // array index at save time (line ~280), so reorder is automatic —
  // no separate renumber pass needed.
  const reorderSteps = (next: StepRow[]) => {
    setForm((prev) => ({ ...prev, steps: next }));
  };

  // WS7-6 Block 1C — Kiwi-assist handlers. On success the corresponding
  // toggle flips OFF so the suggested rows are visible in the normal editor
  // (user can review / tweak before save). On failure the toggle stays ON
  // so the user can retry without losing the AI mode they opted into.
  const handleAssistIngredients = async () => {
    if (!form.name.trim()) {
      Alert.alert(
        "Add a name first",
        "Kiwi needs a dish name to suggest ingredients.",
      );
      return;
    }
    Keyboard.dismiss();
    setAssistingIngredients(true);
    try {
      const existing = form.ingredients
        .filter((i) => i.name.trim())
        .map((i) => ({
          name: i.name.trim(),
          quantity: i.quantity > 0 ? i.quantity : undefined,
          unit: i.unit.trim() || undefined,
        }));
      const result = await assistIngredients({
        dishTitle: form.name.trim(),
        cuisine: form.cuisineType,
        existingIngredients: existing,
        servings: form.servingsDefault,
      });
      setForm((prev) => ({
        ...prev,
        kiwiAssistIngredients: false,
        ingredients: result.ingredients.length
          ? result.ingredients.map((ing) => ({
              uid: nextUid(),
              quantity: ing.quantity,
              unit: ing.unit,
              name: ing.name,
            }))
          : [emptyIngredient()],
      }));
      if (result.caveats && result.caveats.length > 0) {
        Alert.alert("Kiwi's note", result.caveats.join("\n"));
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't reach Kiwi right now. Try again?";
      Alert.alert("Suggestion failed", msg);
    } finally {
      setAssistingIngredients(false);
    }
  };

  const handleAssistSteps = async () => {
    if (!form.name.trim()) {
      Alert.alert(
        "Add a name first",
        "Kiwi needs a dish name to suggest steps.",
      );
      return;
    }
    // assist-steps requires a complete ingredient list (server: min 1 with
    // required quantity + unit). Surface this up-front instead of letting a
    // 400 round-trip the user back.
    const usableIngredients = form.ingredients
      .filter((i) => i.name.trim() && i.quantity > 0 && i.unit.trim())
      .map((i) => ({
        name: i.name.trim(),
        quantity: i.quantity,
        unit: i.unit.trim(),
      }));
    if (usableIngredients.length === 0) {
      Alert.alert(
        "Add ingredients first",
        "Kiwi needs at least one ingredient (with quantity and unit) to suggest steps.",
      );
      return;
    }
    Keyboard.dismiss();
    setAssistingSteps(true);
    try {
      const result = await assistSteps({
        dishTitle: form.name.trim(),
        cuisine: form.cuisineType,
        ingredients: usableIngredients,
        servings: form.servingsDefault,
        cookTimeMinutes:
          form.estimatedTimeMinutes > 0 ? form.estimatedTimeMinutes : undefined,
      });
      setForm((prev) => ({
        ...prev,
        kiwiAssistSteps: false,
        steps: result.steps.map((st) => ({
          uid: nextUid(),
          text: st.content,
          estimatedMinutes: st.estimatedMinutes,
          isTimingSensitive: st.isTimingSensitive ?? false,
        })),
      }));
      if (result.caveats && result.caveats.length > 0) {
        Alert.alert("Kiwi's note", result.caveats.join("\n"));
      }
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Couldn't reach Kiwi right now. Try again?";
      Alert.alert("Suggestion failed", msg);
    } finally {
      setAssistingSteps(false);
    }
  };

  const handleSave = async () => {
    Keyboard.dismiss();
    if (!form.name.trim()) {
      Alert.alert("Add a name", "Give this dish a name to save it.");
      return;
    }
    // WS7-6 Block 1E — server requires at least one ingredient (min 1) on
    // POST /me/dishes regardless of how it was populated. The Kiwi-assist
    // flow flips its toggle OFF on success and writes into form.ingredients,
    // so by save-time the array must be non-empty either way.
    const cleanIngredients = form.ingredients.filter((i) => i.name.trim());
    if (cleanIngredients.length === 0) {
      Alert.alert(
        "Add ingredients",
        form.kiwiAssistIngredients
          ? "Tap 'Get suggestions from Kiwi' first, or add ingredients manually."
          : "Add at least one ingredient before saving.",
      );
      return;
    }

    const draft: DishDraft = {
      id: form.id,
      name: form.name.trim(),
      cuisineType: form.cuisineType,
      estimatedTimeMinutes: form.estimatedTimeMinutes,
      servingsDefault: form.servingsDefault,
      type: form.type,
      kiwiAssistIngredients: form.kiwiAssistIngredients,
      kiwiAssistSteps: form.kiwiAssistSteps,
      ingredients: cleanIngredients.map((i) => ({
        quantity: i.quantity,
        unit: i.unit.trim() || "unit",
        name: i.name.trim(),
      })),
      steps: form.kiwiAssistSteps
        ? []
        : form.steps
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

    try {
      const { id: newDishId } = await saveDish(draft);
      // WS7-6 G3 Scope E / #3 — land on the new dish's Dish Detail on create
      // (LANDING CONTRACT), via `replace` so Back returns to the list, not the
      // half-filled builder. Fixes the dish-side Ask-Kiwi flow, which used to
      // `router.back()` onto the ask-kiwi-dish input screen instead of the
      // saved dish. Edits keep their contextual back.
      const nav = resolveDishPostSaveNav({ newDishId, isEdit });
      Alert.alert(
        isEdit ? "Dish saved as new" : "Dish saved",
        isEdit
          ? "Editing existing dishes lands in a future block — your changes were saved as a new dish."
          : "Added to your saved dishes.",
        [
          {
            text: "OK",
            onPress: () => {
              if (nav.kind === "dish-detail") {
                router.replace({
                  pathname: "/dish/[id]",
                  params: { id: nav.dishId },
                });
              } else {
                router.back();
              }
            },
          },
        ],
      );
    } catch (err) {
      const msg =
        err instanceof Error && err.message
          ? err.message
          : "Saving failed. Try again?";
      Alert.alert("Couldn't save dish", msg);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
      <Header
        showBack
        title={headerTitle}
        subtitle={isEdit ? "Edit dish" : "Save a dish to reuse across meals"}
      />
      <KeyboardAwareScrollViewCompat
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Section 1: Dish Details */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Dish details</Text>
          <View style={{ marginTop: Spacing[3], gap: Spacing[3] }}>
            <View>
              <Text style={s.fieldLabel}>Dish name</Text>
              <TextInput
                value={form.name}
                onChangeText={(v) => update("name", v)}
                placeholder="What's the dish called?"
                placeholderTextColor={Colors.neutral[600]}
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
                      update(
                        "cuisineType",
                        form.cuisineType === c ? undefined : c,
                      )
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
                <View style={[s.chipRow, { marginTop: Spacing[2] }]}>
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
            {/* WS9 3f-1 — the Side/Main Type picker was removed. Dish has no
                `type` column server-side (SaveDishInput carries no key for it),
                so the control silently discarded its value on save. `form.type`
                is retained (defaults "main", preserved on edit) only to satisfy
                the required DishDraft.type contract; it is no longer user-set.
                NOTE: the Cuisine picker above is deliberately KEPT — unlike type,
                cuisine steers the Kiwi-assist ingredient/step calls this session
                even though it, too, is dropped on save. */}
          </View>
        </View>

        {/* Section 2: Logistics */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Logistics</Text>
          <View style={{ marginTop: Spacing[3], gap: Spacing[4] }}>
            <View>
              <Text style={s.fieldLabel}>Cook time</Text>
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
              <Text style={s.fieldLabel}>Servings</Text>
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

        {/* Section 3: What's in this dish (ingredients + Kiwi-assist) */}
        <View style={s.card}>
          <Text style={s.cardTitle}>What's in this dish</Text>
          <View style={{ marginTop: Spacing[2] }}>
            <CheckboxRow
              checked={form.kiwiAssistIngredients}
              label="Have Kiwi suggest recipe"
              premiumLabel="Premium · WS6"
              onToggle={() =>
                update("kiwiAssistIngredients", !form.kiwiAssistIngredients)
              }
            />
          </View>
          {form.kiwiAssistIngredients ? (
            <View style={{ marginTop: Spacing[2], gap: Spacing[2] }}>
              <Text style={s.assistHint}>
                Kiwi will suggest ingredients based on the dish name and
                cuisine.
              </Text>
              <Button
                label={
                  assistingIngredients
                    ? "Asking Kiwi…"
                    : "Get suggestions from Kiwi"
                }
                variant="ghost"
                disabled={assistingIngredients || !form.name.trim()}
                onPress={handleAssistIngredients}
              />
            </View>
          ) : (
            <View style={{ marginTop: Spacing[3], gap: Spacing[2] }}>
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
                    placeholderTextColor={Colors.neutral[600]}
                    keyboardType="decimal-pad"
                    returnKeyType="done"
                    blurOnSubmit
                    style={[s.input, s.qtyInput]}
                  />
                  <TextInput
                    value={ing.unit}
                    onChangeText={(v) => updateIngredient(ing.uid, { unit: v })}
                    placeholder="unit"
                    placeholderTextColor={Colors.neutral[600]}
                    returnKeyType="done"
                    blurOnSubmit
                    style={[s.input, s.unitInput]}
                  />
                  <TextInput
                    value={ing.name}
                    onChangeText={(v) => updateIngredient(ing.uid, { name: v })}
                    placeholder="ingredient"
                    placeholderTextColor={Colors.neutral[600]}
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
                    <Feather name="x" size={16} color={Colors.neutral[700]} />
                  </Pressable>
                </View>
              ))}
              <Pressable
                onPress={addIngredient}
                style={({ pressed }) => [
                  s.addRowBtn,
                  pressed && { opacity: 0.7 },
                ]}
                hitSlop={6}
              >
                <Feather name="plus" size={14} color={Colors.sage[700]} />
                <Text style={s.addRowText}>Add ingredient</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Section 4: How to make it */}
        <View style={s.card}>
          <Text style={s.cardTitle}>How to make it</Text>
          <Text style={s.cardSubtitle}>Optional</Text>
          <View style={{ marginTop: Spacing[2] }}>
            <CheckboxRow
              checked={form.kiwiAssistSteps}
              label="Have Kiwi suggest steps"
              premiumLabel="Premium · WS6"
              onToggle={() => update("kiwiAssistSteps", !form.kiwiAssistSteps)}
            />
          </View>
          {form.kiwiAssistSteps ? (
            <View style={{ marginTop: Spacing[2], gap: Spacing[2] }}>
              <Text style={s.assistHint}>
                Kiwi will write the steps from your ingredients and cuisine.
              </Text>
              <Button
                label={
                  assistingSteps ? "Asking Kiwi…" : "Get suggestions from Kiwi"
                }
                variant="ghost"
                disabled={assistingSteps || !form.name.trim()}
                onPress={handleAssistSteps}
              />
            </View>
          ) : (
            <View style={{ marginTop: Spacing[3], gap: Spacing[3] }}>
              {/* WS5-5P-fix-drag — DraggableFlatList for steps. Drag via
                  always-visible handle (≡) per locked Option A + C.
                  Ingredients intentionally not draggable (Option F).
                  scrollEnabled={false} delegates scroll to the outer
                  KeyboardAwareScrollViewCompat — see meal-builder for
                  the full nested-scroll rationale. */}
              <DraggableFlatList
                data={form.steps}
                keyExtractor={(step) => step.uid.toString()}
                onDragEnd={({ data }) => reorderSteps(data)}
                scrollEnabled={false}
                renderItem={({
                  item: step,
                  drag,
                  isActive,
                  getIndex,
                }: RenderItemParams<StepRow>) => (
                  <StepEditor
                    index={getIndex() ?? 0}
                    step={step}
                    onChange={(patch) => updateStep(step.uid, patch)}
                    onRemove={() => removeStep(step.uid)}
                    drag={drag}
                    isActive={isActive}
                  />
                )}
              />
              <Pressable
                onPress={addStep}
                style={({ pressed }) => [
                  s.addRowBtn,
                  pressed && { opacity: 0.7 },
                ]}
                hitSlop={6}
              >
                <Feather name="plus" size={14} color={Colors.sage[700]} />
                <Text style={s.addRowText}>Add step</Text>
              </Pressable>
            </View>
          )}
        </View>

        {/* Section 5: Notes */}
        <View style={s.card}>
          <Text style={s.cardTitle}>Notes</Text>
          <Text style={s.cardSubtitle}>Optional</Text>
          <View style={{ marginTop: Spacing[3] }}>
            <TextInput
              value={form.notes}
              onChangeText={(v) => update("notes", v)}
              placeholder="Anything else worth remembering"
              placeholderTextColor={Colors.neutral[600]}
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
            variant="primary"
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

function CheckboxRow({
  checked,
  label,
  premiumLabel,
  onToggle,
}: {
  checked: boolean;
  label: string;
  premiumLabel?: string;
  onToggle: () => void;
}) {
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={6}
      style={({ pressed }) => [
        s.checkboxRow,
        pressed && { opacity: 0.7 },
      ]}
    >
      <Feather
        name={checked ? "check-square" : "square"}
        size={18}
        color={checked ? Colors.sage[700] : Colors.neutral[600]}
      />
      <Text style={s.checkboxLabel}>{label}</Text>
      {premiumLabel && (
        <View style={s.premiumPill}>
          <Feather name="lock" size={10} color={Colors.terracotta[700]} />
          <Text style={s.premiumPillText}>{premiumLabel}</Text>
        </View>
      )}
    </Pressable>
  );
}

function StepEditor({
  index,
  step,
  onChange,
  onRemove,
  drag,
  isActive,
}: {
  index: number;
  step: StepRow;
  onChange: (patch: Partial<StepRow>) => void;
  onRemove: () => void;
  drag: () => void;
  isActive: boolean;
}) {
  return (
    <ScaleDecorator>
    <View style={[s.stepEditorRow, isActive && { opacity: 0.7 }]}>
      <View
        style={[
          s.stepCircle,
          step.isTimingSensitive ? s.stepCircleTiming : s.stepCircleNormal,
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
      <View style={{ flex: 1, gap: Spacing[1] }}>
        <TextInput
          value={step.text}
          onChangeText={(v) => onChange({ text: v })}
          placeholder="Describe this step…"
          placeholderTextColor={Colors.neutral[600]}
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
            placeholderTextColor={Colors.neutral[600]}
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
                  ? Colors.terracotta[700]
                  : Colors.neutral[700]
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
      {/* WS5-5P-fix-drag-2 — onPressIn (not onLongPress) per
          draggable-flatlist v4 API: the lib's `drag` callback owns
          its own long-press timing, so wiring it to RN's onLongPress
          double-gates the gesture and drag never fires. */}
      <Pressable
        onPressIn={drag}
        disabled={isActive}
        hitSlop={8}
        style={({ pressed }) => [s.dragHandleBtn, pressed && { opacity: 0.6 }]}
      >
        <Feather name="menu" size={20} color={Colors.neutral[500]} />
      </Pressable>
      <Pressable
        onPress={onRemove}
        hitSlop={8}
        style={({ pressed }) => [s.removeBtn, pressed && { opacity: 0.6 }]}
      >
        <Feather name="x" size={16} color={Colors.neutral[700]} />
      </Pressable>
    </View>
    </ScaleDecorator>
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
      style={({ pressed }) => [s.expandLink, pressed && { opacity: 0.6 }]}
    >
      <Text style={s.expandLinkText}>{label}</Text>
      <Feather
        name={expanded ? "chevron-up" : "chevron-down"}
        size={14}
        color={Colors.sage[700]}
      />
    </Pressable>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8] * 2,
    gap: Spacing[3],
  },
  card: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    padding: Spacing[4],
  },
  cardTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  cardSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    marginTop: 2,
  },
  fieldLabel: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginBottom: Spacing[1],
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
  input: {
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
    textAlignVertical: "top",
  },
  checkboxRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  checkboxLabel: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  assistHint: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    fontStyle: "italic",
    marginTop: Spacing[2],
  },
  premiumPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: Colors.terracotta[100],
    borderRadius: Radius.full,
    paddingHorizontal: Spacing[2],
    paddingVertical: 2,
  },
  premiumPillText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  ingredientRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
  },
  qtyInput: {
    width: 56,
    paddingHorizontal: Spacing[2],
  },
  unitInput: {
    width: 70,
    paddingHorizontal: Spacing[2],
  },
  removeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  // WS5-5P-fix-drag — drag handle for step reorder. Same hit area as
  // removeBtn so the two adjacent controls feel symmetric. marginTop
  // aligns the handle with the step circle, matching meal-builder.
  dragHandleBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  addRowBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    alignSelf: "flex-start",
    paddingVertical: Spacing[1],
  },
  addRowText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepEditorRow: {
    flexDirection: "row",
    gap: Spacing[2],
    alignItems: "flex-start",
  },
  stepCircle: {
    width: 32,
    height: 32,
    // D-WS9-022 — a 32px step circle wants a full radius, not the ambiguous
    // old-xl(16). Radius.full clamps to a perfect circle (pixel-identical).
    borderRadius: Radius.full,
    alignItems: "center",
    justifyContent: "center",
    marginTop: 4,
  },
  stepCircleNormal: {
    backgroundColor: Colors.sage[100],
  },
  stepCircleTiming: {
    backgroundColor: Colors.terracotta[200],
  },
  stepCircleTextNormal: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepCircleTextTiming: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  stepMetaRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  minutesInput: {
    width: 72,
    paddingHorizontal: Spacing[2],
  },
  timingToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[1],
    borderRadius: Radius.full,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    backgroundColor: Palette.background.card,
  },
  timingToggleActive: {
    borderColor: Colors.terracotta[300],
    backgroundColor: Colors.terracotta[50],
  },
  timingToggleText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[500],
  },
  timingToggleTextActive: {
    color: Colors.terracotta[700],
    fontWeight: Typography.fontWeight.semibold,
  },
  footer: {
    marginTop: Spacing[4],
    gap: Spacing[2],
    alignItems: "center",
  },
  footerHint: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  cancelLink: {
    paddingVertical: Spacing[2],
    paddingHorizontal: Spacing[3],
    marginTop: Spacing[1],
  },
  cancelText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
});
