import React, { useEffect, useMemo, useState } from "react";
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
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";

import { Button } from "@/components/Button";
import { Header } from "@/components/Header";
import { KeyboardAwareScrollViewCompat } from "@/components/KeyboardAwareScrollViewCompat";
import { TypeaheadList } from "@/components/TypeaheadList";
import { useApp } from "@/contexts/AppContext";
import {
  getGroceryList,
  lookupGroceryItemCandidates,
  parseSuggestedQuantity,
  type AddItemPayload,
  type GroceryItemCandidate,
} from "@/lib/api/grocery";
import { GROCERY_SECTIONS } from "@/lib/domain";
import { parseQuantity } from "@/lib/quantity";
import { getGroceryListById } from "@/lib/stubs";
import {
  KColors,
  KPalette,
  KRadius,
  KSpacing,
  KType,
} from "@/constants/tokens";
import type { GroceryList, GroceryListItem } from "@/lib/types";

const SECTION_LABELS: Record<GroceryListItem["sectionKey"], string> =
  GROCERY_SECTIONS.reduce(
    (acc, s) => ({ ...acc, [s.key]: s.label }),
    {} as Record<GroceryListItem["sectionKey"], string>,
  );

const UNDO_TIMEOUT_MS = 5000;

type RemovedItem = {
  item: GroceryListItem;
};

export default function GroceryListDetail() {
  const router = useRouter();
  const { id: rawId } = useLocalSearchParams<{ id: string }>();
  const id = typeof rawId === "string" ? rawId : "";
  const {
    toggleGroceryItemCompleted,
    toggleGroceryStapleSelection,
    addGroceryItem,
    removeGroceryItem,
    markGroceryShoppingDone,
  } = useApp();

  // Optimistic local state. WS5 stubs were log-only; WS6 6c-4 Block C now
  // loads real lists via the API for non-demo ids. Demo ids
  // ("demo-grocery-*") still resolve from the stub catalog for design review
  // and the no-network grocery-list screen smoke test.
  const [list, setList] = useState<GroceryList | null>(() =>
    id.startsWith("demo-grocery-") ? getGroceryListById(id) : null,
  );
  // WS7-5d Block 5 Fix 3: distinguish "still fetching" from "fetched + null".
  // Pre-fix the screen rendered the not-found branch any time `list === null`,
  // so the GET round-trip on a real list flashed "List not found." for ~the
  // duration of the request. Loading shows a spinner; the not-found branch
  // only renders on a resolved error or a demo-stub miss. PRD §12.7 doesn't
  // pin a skeleton; ActivityIndicator + the existing notFoundWrap layout is
  // the smallest faithful match to the design system here.
  const [loadStatus, setLoadStatus] = useState<"loading" | "ready" | "error">(
    () => {
      if (!id) return "error";
      if (id.startsWith("demo-grocery-")) {
        return getGroceryListById(id) ? "ready" : "error";
      }
      return "loading";
    },
  );
  const [addItemInput, setAddItemInput] = useState("");
  // 6c-6-C — debounced typeahead state. debouncedQuery trails the raw
  // input by 250ms to match the plans.tsx debounce convention; the
  // server call only fires off the debounced value. candidates +
  // candidatesLoading drive the floating <TypeaheadList>.
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [candidates, setCandidates] = useState<GroceryItemCandidate[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  // PRD §12.7 — staples ship in "default" (dimmed, not yet on the trip).
  // Opting in promotes them to a normal item; isCompleted strikethrough
  // only fires after opt-in so "include in shopping" stays decoupled
  // from "checked off while shopping". WS7 promotes this to a real
  // schema field.
  const [stapleOptedInSet, setStapleOptedInSet] = useState<Set<string>>(
    () => new Set(),
  );
  const [recentlyRemoved, setRecentlyRemoved] = useState<RemovedItem | null>(
    null,
  );
  // WS5-5Q-fix-2 — inline quantity edit (mirrors meal-builder's two-input
  // amount + unit pattern; parent owns edit state so a focus-swap between
  // the two inputs doesn't unmount the row mid-edit).
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState("");
  const [editUnit, setEditUnit] = useState("");

  useEffect(() => {
    if (!recentlyRemoved) return;
    const timeout = setTimeout(() => {
      setRecentlyRemoved(null);
    }, UNDO_TIMEOUT_MS);
    return () => clearTimeout(timeout);
  }, [recentlyRemoved]);

  // 6c-6-C — 250ms input → debouncedQuery (mirrors plans.tsx:60-66).
  useEffect(() => {
    const trimmed = addItemInput.trim();
    if (!trimmed) {
      setDebouncedQuery("");
      return;
    }
    const t = setTimeout(() => setDebouncedQuery(trimmed), 250);
    return () => clearTimeout(t);
  }, [addItemInput]);

  // 6c-6-C — fire the lookup when the debounced value changes. The
  // cancelled flag short-circuits stale responses if the user keeps
  // typing past a slow request.
  useEffect(() => {
    if (!debouncedQuery) {
      setCandidates([]);
      setCandidatesLoading(false);
      return;
    }
    let cancelled = false;
    setCandidatesLoading(true);
    lookupGroceryItemCandidates(debouncedQuery)
      .then((res) => {
        if (!cancelled) setCandidates(res.candidates);
      })
      .catch((err) => {
        // Network/AI failures degrade silently — the user can still
        // press Enter to submit the raw text via the Extras fallback.
        console.warn("[grocery-list] lookup failed", err);
        if (!cancelled) setCandidates([]);
      })
      .finally(() => {
        if (!cancelled) setCandidatesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery]);

  // WS6 6c-4 Block C — fetch the real list from the API for non-demo ids.
  // Demo lists are stub-only (design review) and were already populated
  // synchronously above. WS7-5d Block 5 Fix 3: success and error paths now
  // flip loadStatus so the render branches below distinguish "still
  // fetching" (spinner) from "resolved-empty / error" (not-found text). Pre-
  // fix both states were indistinguishable and the screen flashed the
  // not-found branch for the duration of the GET.
  useEffect(() => {
    if (!id || id.startsWith("demo-grocery-")) return;
    let cancelled = false;
    (async () => {
      try {
        const real = await getGroceryList(id);
        if (!cancelled) {
          setList(real);
          setLoadStatus("ready");
        }
      } catch (err) {
        console.error("[grocery-list/[id]] load failed", err);
        if (!cancelled) {
          setList(null);
          setLoadStatus("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (loadStatus === "loading") {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack title="Grocery List" />
        <View style={s.notFoundWrap}>
          <ActivityIndicator size="large" color={KColors.sage[700]} />
        </View>
      </View>
    );
  }

  if (!list) {
    return (
      <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
        <Header showBack title="Grocery List" />
        <View style={s.notFoundWrap}>
          <Text style={s.notFoundText}>List not found.</Text>
        </View>
      </View>
    );
  }

  const listId = list.id;

  const handleItemTap = (item: GroceryListItem) => {
    // Tapping anywhere on the row while a quantity edit is open should
    // commit + exit edit (matches the ambient "tap-out to confirm"
    // expectation), not toggle the checkbox in the same gesture.
    if (editingItemId) {
      commitQuantityEdit();
      return;
    }
    if (item.isUniversalStaple) {
      const isOptedIn = stapleOptedInSet.has(item.id);
      if (!isOptedIn) {
        // Staple's first tap = opt in for this trip; don't strike.
        setStapleOptedInSet((prev) => {
          const next = new Set(prev);
          next.add(item.id);
          return next;
        });
        void toggleGroceryStapleSelection(listId, item.id);
        return;
      }
      // Already opted in: fall through to normal complete-toggle.
    }
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === item.id ? { ...it, isCompleted: !it.isCompleted } : it,
            ),
          }
        : prev,
    );
    void toggleGroceryItemCompleted(listId, item.id);
  };

  const handleRemove = (item: GroceryListItem) => {
    if (item.isUniversalStaple) {
      // X on a staple just clears the opt-in (returns to dimmed state).
      // Default-staple X is hidden in GroceryRow, so this branch only
      // fires for opted-in staples.
      setStapleOptedInSet((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      // Also clear any strikethrough if the staple was opted-in then checked.
      setList((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.map((it) =>
                it.id === item.id ? { ...it, isCompleted: false } : it,
              ),
            }
          : prev,
      );
      void toggleGroceryStapleSelection(listId, item.id);
      return;
    }
    // Standard item: optimistic remove with undo banner.
    setList((prev) =>
      prev
        ? { ...prev, items: prev.items.filter((it) => it.id !== item.id) }
        : prev,
    );
    setRecentlyRemoved({ item });
    void removeGroceryItem(listId, item.id);
  };

  const handleUndo = () => {
    if (!recentlyRemoved) return;
    const { item } = recentlyRemoved;
    setList((prev) =>
      prev ? { ...prev, items: [...prev.items, item] } : prev,
    );
    setRecentlyRemoved(null);
    // 6c-6-C — restore via the real POST. Preserves the original
    // section + quantity so the undone item lands in the same place
    // it was removed from. The original item's server id is lost
    // (this writes a fresh row); WS7 swaps for a real undo endpoint
    // that resurrects the row by id. Errors swallowed — the local
    // row is already back on screen.
    const restorePayload: AddItemPayload = {
      itemName: item.name,
      sectionKey: item.sectionKey,
      quantity: item.quantityAmount
        ? parseFloat(item.quantityAmount) || 1
        : 1,
      unit: item.quantityUnit ?? undefined,
    };
    void addGroceryItem(listId, restorePayload).catch((err) => {
      console.warn("[grocery-list] undo restore failed", err);
    });
  };

  const enterQuantityEdit = (item: GroceryListItem) => {
    // Diagnostic — WS5-5Q-fix-3 added these to chase an intermittent
    // "edit doesn't fire on tap" report. Keep them through WS6 to
    // catch any reappearance once the prod sample size grows.
    console.log("[grocery-list] quantity tap", {
      itemId: item.id,
      currentEditingId: editingItemId,
    });
    setEditingItemId(item.id);
    setEditAmount(item.quantityAmount ?? "");
    setEditUnit(item.quantityUnit ?? "");
  };

  const commitQuantityEdit = () => {
    if (!editingItemId) {
      console.log("[grocery-list] commit no-op (no active edit)");
      return;
    }
    const amt = editAmount.trim() || undefined;
    const unit = editUnit.trim() || undefined;
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === editingItemId
                ? {
                    ...it,
                    quantityAmount: amt,
                    quantityUnit: unit,
                    // Keep legacy display string in sync so any consumer
                    // still reading `quantity` (summaries, exports) sees
                    // the edited value.
                    quantity: [amt, unit].filter(Boolean).join(" ") || it.quantity,
                  }
                : it,
            ),
          }
        : prev,
    );
    // TODO(WS7): wire to PATCH /grocery-lists/{id}/items/{itemId}
    console.log("[grocery-list] quantity edit commit", {
      listId,
      itemId: editingItemId,
      quantityAmount: amt,
      quantityUnit: unit,
    });
    // Order matters (WS5-5Q-fix-4): dismiss keyboard FIRST so the keyboard
    // animation and layout shift start before React re-renders the row;
    // then clear edit state, which unmounts the TextInput and naturally
    // releases focus. Reversing the order makes the unmount-blur and the
    // explicit dismiss race, occasionally leaving the responder system
    // stuck until the next scroll resets it.
    Keyboard.dismiss();
    setEditingItemId(null);
    console.log("[grocery-list] quantity edit committed; ready for next tap");
  };

  // 6c-6-C — optimistic-add core. Resolves quantity/unit from candidate
  // metadata (defaultUnit for lookup, parseSuggestedQuantity for AI),
  // writes an optimistic row with a local-${Date.now()} id, fires the
  // POST in the background, then reconciles on success or rolls back
  // on failure. Called from both candidate-tap and Enter-key paths.
  const performAdd = (
    candidate: GroceryItemCandidate | null,
    rawText: string,
  ) => {
    const trimmed = rawText.trim();
    if (!candidate && !trimmed) return;

    const itemName = candidate?.displayName ?? trimmed;
    const sectionKey: GroceryListItem["sectionKey"] =
      candidate?.sectionKey ?? "extras";
    const ingredientId = candidate?.ingredientId ?? null;

    let quantity = 1;
    let unit = "each";
    if (candidate) {
      if (candidate.suggestedQuantity) {
        const parsed = parseSuggestedQuantity(candidate.suggestedQuantity);
        quantity = parsed.quantity;
        unit = parsed.unit;
      } else if (candidate.defaultUnit) {
        unit = candidate.defaultUnit;
      }
    }

    const tempId = `local-${Date.now()}`;
    const optimistic: GroceryListItem = {
      id: tempId,
      name: itemName,
      quantity:
        quantity && unit ? `${quantity} ${unit}` : unit || `${quantity}`,
      quantityAmount: String(quantity),
      quantityUnit: unit || undefined,
      sectionKey,
      isUniversalStaple: false,
      isRecurringItem: false,
      isAmbiguous: false,
      isOptional: false,
      isCompleted: false,
    };

    setList((prev) =>
      prev ? { ...prev, items: [...prev.items, optimistic] } : prev,
    );
    setAddItemInput("");
    setDebouncedQuery("");
    setCandidates([]);

    const payload: AddItemPayload = {
      itemName,
      sectionKey,
      quantity,
      unit,
      ingredientId,
    };

    void addGroceryItem(listId, payload)
      .then((serverItem) => {
        // Replace the optimistic row with the server-canonical row so
        // subsequent edits (qty / strike / remove) target the real id.
        setList((prev) =>
          prev
            ? {
                ...prev,
                items: prev.items.map((it) =>
                  it.id === tempId ? serverItem : it,
                ),
              }
            : prev,
        );
      })
      .catch((err) => {
        console.warn("[grocery-list] add failed; rolling back", err);
        setList((prev) =>
          prev
            ? { ...prev, items: prev.items.filter((it) => it.id !== tempId) }
            : prev,
        );
        // MVP error surface — toast/inline error is D-WS6-079.
        Alert.alert(
          "Couldn't add item",
          "Something went wrong. Please try again.",
        );
      });
  };

  const handleCandidateSelect = (candidate: GroceryItemCandidate) => {
    performAdd(candidate, addItemInput);
  };

  // Enter-key handler. If suggestions are visible (loading or non-empty),
  // pick the top candidate (auto-tap); else submit raw text as Extras.
  const handleAddItem = () => {
    const trimmed = addItemInput.trim();
    if (!trimmed) return;
    const top = candidates[0];
    if (top && !candidatesLoading) {
      performAdd(top, trimmed);
      return;
    }
    performAdd(null, trimmed);
  };

  // Visibility for the floating typeahead panel. Show as soon as the
  // user has typed *anything* — covers the "lookup pending → eventually
  // empty" case (so the user sees the spinner instead of a blank gap)
  // and the "candidates returned" case. Hidden when input is empty.
  const typeaheadVisible = useMemo(() => {
    const hasInput = addItemInput.trim().length > 0;
    if (!hasInput) return false;
    const debounceLag = addItemInput.trim() !== debouncedQuery;
    return candidatesLoading || candidates.length > 0 || debounceLag;
  }, [addItemInput, debouncedQuery, candidates, candidatesLoading]);

  const handleMarkDone = () => {
    void markGroceryShoppingDone(listId, true);
    setList((prev) => (prev ? { ...prev, status: "completed" } : prev));
  };

  const handleUnmarkDone = () => {
    void markGroceryShoppingDone(listId, false);
    setList((prev) => (prev ? { ...prev, status: "active" } : prev));
  };

  const handleAmbiguousReview = () => {
    Alert.alert(
      "Coming in WS6 — ambiguous item resolution",
      "Resolving flagged items needs the AI orchestration layer.",
    );
  };

  const handleEmail = () => {
    Alert.alert(
      "Coming in WS6 — email integration",
      "Sending grocery lists via email requires server-side template + SES wiring.",
    );
  };

  const handleOrderOnline = () => {
    Alert.alert(
      "Coming in WS6 — retailer integration",
      "Online ordering requires the retailer adapter pattern from PRD §12.12.",
    );
  };

  const handleViewPlan = () => {
    if (list.planId) {
      router.push({ pathname: "/plan/[id]", params: { id: list.planId } });
    }
  };

  const handleBackToPlan = () => {
    if (list.planId) {
      router.push({ pathname: "/plan/[id]", params: { id: list.planId } });
    } else {
      router.back();
    }
  };

  const handlePrepCook = () => {
    router.push("/prep-cook");
  };

  const subtitle = list.isThisWeek
    ? `${list.planName} · This Week`
    : list.planName;

  return (
    <View style={{ flex: 1, backgroundColor: KColors.neutral[100] }}>
      <Header
        showBack
        title="Grocery List"
        subtitle={subtitle}
        rightContent={
          <Pressable
            onPress={handleOrderOnline}
            style={({ pressed }) => [
              s.orderHeaderBtn,
              pressed && { opacity: 0.85 },
            ]}
            hitSlop={6}
          >
            <Text style={s.orderHeaderBtnText}>Order →</Text>
          </Pressable>
        }
      />
      <KeyboardAwareScrollViewCompat
        style={{ flex: 1 }}
        contentContainerStyle={s.scrollContent}
        showsVerticalScrollIndicator={false}
        // Explicit even though the compat default is "handled" — WS5-5Q-fix-4
        // documents intent at the call site so a future refactor of the
        // compat layer can't silently regress to "never" and re-introduce
        // the "tap on qty during keyboard dismiss is eaten" bug.
        keyboardShouldPersistTaps="handled"
      >
        {list.ambiguousItemCount > 0 && (
          <View style={s.ambiguousBanner}>
            <View style={s.ambiguousIcon}>
              <Feather
                name="alert-triangle"
                size={20}
                color={KColors.terracotta[500]}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.ambiguousHeading}>
                Kiwi needs a few specifics
              </Text>
              <Text style={s.ambiguousSubtitle}>
                A few items need clarification before adding to online order.
              </Text>
              <Pressable
                onPress={handleAmbiguousReview}
                style={({ pressed }) => [pressed && { opacity: 0.7 }]}
              >
                <Text style={s.ambiguousLink}>
                  Review {list.ambiguousItemCount} flagged items →
                </Text>
              </Pressable>
            </View>
          </View>
        )}

        {list.planId && (
          <Pressable
            onPress={handleViewPlan}
            style={({ pressed }) => [
              s.viewPlanLink,
              pressed && { opacity: 0.7 },
            ]}
          >
            <Feather
              name="external-link"
              size={14}
              color={KColors.sage[700]}
            />
            <Text style={s.viewPlanText} numberOfLines={1}>
              View meal plan: {list.planName}
            </Text>
            <Feather
              name="chevron-right"
              size={14}
              color={KColors.sage[700]}
            />
          </Pressable>
        )}

        {/* 6c-6-C — typeahead wrapper. zIndex+relative so the absolute
            <TypeaheadList> below stacks above the action row + sections
            even though the next sibling is later in the tree. */}
        <View style={s.typeaheadWrap}>
          <View style={s.addItemRow}>
            <TextInput
              value={addItemInput}
              onChangeText={setAddItemInput}
              placeholder="Add an item…"
              placeholderTextColor={KColors.neutral[600]}
              style={s.addItemInput}
              returnKeyType="done"
              // Keep keyboard up after Done so the user can add several
              // items in a row without retapping the input. Without this
              // (default blurOnSubmit=true on iOS), the keyboard collapses
              // on every submit and smoke-testers read the disappearing
              // keyboard + cleared input as "nothing happened" — the new
              // item is added but lands below the fold.
              blurOnSubmit={false}
              onSubmitEditing={handleAddItem}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Pressable
              onPress={handleAddItem}
              disabled={!addItemInput.trim()}
              style={({ pressed }) => [
                s.addItemBtn,
                !addItemInput.trim() && { opacity: 0.45 },
                pressed && addItemInput.trim() ? { opacity: 0.85 } : null,
              ]}
            >
              <Text style={s.addItemBtnText}>Add</Text>
            </Pressable>
          </View>
          <TypeaheadList<GroceryItemCandidate>
            items={candidates}
            visible={typeaheadVisible}
            loading={candidatesLoading}
            keyExtractor={(c) =>
              c.ingredientId ?? `ai-${c.canonicalName}-${c.sectionKey}`
            }
            onSelect={handleCandidateSelect}
            getAccessibilityLabel={(c) =>
              `${c.displayName}, ${SECTION_LABELS[c.sectionKey] ?? c.sectionKey}`
            }
            style={s.typeaheadAnchored}
            renderItem={(c) => (
              <View style={s.candidateRow}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.candidateName} numberOfLines={1}>
                    {c.displayName}
                  </Text>
                  <Text style={s.candidateSection} numberOfLines={1}>
                    {SECTION_LABELS[c.sectionKey] ?? c.sectionKey}
                  </Text>
                </View>
                {c.suggestedQuantity ? (
                  <View style={s.candidateChip}>
                    <Text style={s.candidateChipText} numberOfLines={1}>
                      {c.suggestedQuantity}
                    </Text>
                  </View>
                ) : null}
              </View>
            )}
          />
        </View>

        <View style={s.actionRow}>
          <View style={{ flex: 1 }}>
            <Button
              label="Email Me My List"
              variant="secondary"
              onPress={handleEmail}
            />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              label="Order Online →"
              variant="terra"
              onPress={handleOrderOnline}
            />
          </View>
        </View>

        <View style={s.sectionsWrap}>
          {GROCERY_SECTIONS.map((section) => {
            const items = list.items.filter(
              (i) => i.sectionKey === section.key,
            );
            if (items.length === 0) return null;
            return (
              <View key={section.key} style={s.section}>
                <View style={s.sectionHeaderRow}>
                  <Text style={s.sectionHeader}>{section.label}</Text>
                  <Pressable onPress={() => {}} hitSlop={6}>
                    {/* WS5: tap "+ Add item" focuses the top input via
                        natural tab order; WS6 will pre-target the section. */}
                    <Text style={s.addItemInline}>+ Add item</Text>
                  </Pressable>
                </View>
                <View style={s.itemList}>
                  {items.map((item) => (
                    <GroceryRow
                      key={item.id}
                      item={item}
                      stapleOptedIn={stapleOptedInSet.has(item.id)}
                      isEditing={editingItemId === item.id}
                      editAmount={editAmount}
                      editUnit={editUnit}
                      onEditAmount={setEditAmount}
                      onEditUnit={setEditUnit}
                      onEnterEdit={() => enterQuantityEdit(item)}
                      onCommitEdit={commitQuantityEdit}
                      onTap={() => handleItemTap(item)}
                      onRemove={() => handleRemove(item)}
                    />
                  ))}
                </View>
              </View>
            );
          })}
        </View>

        {list.status === "completed" ? (
          <View style={s.completionWrap}>
            <View style={s.completionIcon}>
              <Feather
                name="check-circle"
                size={32}
                color={KColors.sage[700]}
              />
            </View>
            <Text style={s.completionHeading}>Shopping complete!</Text>
            <Text style={s.completionSubtitle}>
              You've checked off everything on your list.
            </Text>
            <View style={s.completionActions}>
              <View style={{ flex: 1 }}>
                <Button
                  label="Back to Meal Plan"
                  variant="secondary"
                  onPress={handleBackToPlan}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Button
                  label="Start Prep & Cook →"
                  variant="terra"
                  onPress={handlePrepCook}
                />
              </View>
            </View>
            <Pressable
              onPress={handleUnmarkDone}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
              hitSlop={6}
            >
              <Text style={s.unmarkLink}>Mark as not done</Text>
            </Pressable>
          </View>
        ) : (
          <View style={s.markDoneWrap}>
            <Button
              label="Mark Shopping Done ✓"
              variant="secondary"
              onPress={handleMarkDone}
            />
          </View>
        )}
      </KeyboardAwareScrollViewCompat>

      {recentlyRemoved && (
        <View style={s.undoBanner} pointerEvents="box-none">
          <View style={s.undoBannerInner}>
            <Text style={s.undoBannerText}>Item removed.</Text>
            <Pressable
              onPress={handleUndo}
              hitSlop={6}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Text style={s.undoBannerAction}>Undo</Text>
            </Pressable>
          </View>
        </View>
      )}
    </View>
  );
}

function GroceryRow({
  item,
  stapleOptedIn,
  isEditing,
  editAmount,
  editUnit,
  onEditAmount,
  onEditUnit,
  onEnterEdit,
  onCommitEdit,
  onTap,
  onRemove,
}: {
  item: GroceryListItem;
  stapleOptedIn: boolean;
  isEditing: boolean;
  editAmount: string;
  editUnit: string;
  onEditAmount: (v: string) => void;
  onEditUnit: (v: string) => void;
  onEnterEdit: () => void;
  onCommitEdit: () => void;
  onTap: () => void;
  onRemove: () => void;
}) {
  const isDefaultStaple = item.isUniversalStaple && !stapleOptedIn;
  const isActiveStaple = item.isUniversalStaple && stapleOptedIn;
  // Default staples don't strike — opting in is a separate concept from
  // "checked off." Once a staple is opted-in, isCompleted drives strike.
  const showStrikethrough = !isDefaultStaple && item.isCompleted;
  // The dashed border + plus icon affordance is intentionally gated on
  // ONLY isDefaultStaple. Per WS5-5Q-fix-3: do NOT add isOptional here —
  // optional items render with the regular checkbox; the "Optional" tag
  // alone communicates the optional state. This guard exists so a
  // future refactor can't silently fold isOptional into the dashed
  // condition.
  const useDashedCheckbox = isDefaultStaple;
  const showCheck = !isDefaultStaple && item.isCompleted;
  const showPlusAffordance = isDefaultStaple;

  // Display fallback chain: structured → legacy quantity string. Both
  // can be empty (e.g., user clears the qty during edit) — show empty.
  const displayQty =
    item.quantityAmount !== undefined || item.quantityUnit !== undefined
      ? [item.quantityAmount, item.quantityUnit].filter(Boolean).join(" ")
      : item.quantity;

  // parseQuantity returns null for invalid; empty input is "valid" (
  // intentional clear), so guard on length first — same convention as
  // meal-builder's ingredient row.
  const editAmountInvalid =
    editAmount.trim().length > 0 && parseQuantity(editAmount) === null;

  // WS5-5Q-fix-3 — row container is a plain View (was a Pressable). The
  // three tap targets (toggle area, qty, X) are now SIBLINGS, not
  // nested inside a parent Pressable. Nesting was the root cause of an
  // intermittent "tap on qty doesn't open edit" bug: the outer
  // Pressable would occasionally win the responder race and fire onTap
  // with a stale-closure editingItemId, falling through to checkbox
  // toggle instead of edit. Sibling Pressables eliminate the conflict.
  return (
    <View style={s.row}>
      <Pressable
        onPress={onTap}
        style={({ pressed }) => [s.toggleArea, pressed && { opacity: 0.7 }]}
      >
        <View
          style={[
            s.check,
            showCheck && {
              backgroundColor: KColors.sage[700],
              borderColor: KColors.sage[700],
            },
            useDashedCheckbox && {
              borderColor: KColors.neutral[400],
              backgroundColor: "transparent",
              borderStyle: "dashed",
            },
          ]}
        >
          {showCheck && (
            <Feather name="check" size={14} color={KColors.neutral[0]} />
          )}
          {showPlusAffordance && (
            <Feather name="plus" size={12} color={KColors.neutral[500]} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.itemTopRow}>
            <Text
              style={[
                s.itemName,
                showStrikethrough && {
                  textDecorationLine: "line-through",
                  color: KColors.neutral[600],
                },
                isDefaultStaple && {
                  color: KColors.neutral[700],
                },
              ]}
              numberOfLines={2}
            >
              {item.name}
            </Text>
            {item.isUniversalStaple && (
              <Tag
                label="Pantry Staple"
                tone={isActiveStaple ? "sage" : "muted"}
              />
            )}
            {item.isRecurringItem && <Tag label="Recurring" tone="sage" />}
            {item.isOptional && <Tag label="Optional" tone="muted" />}
          </View>
        </View>
      </Pressable>
      {isEditing ? (
        // Inline edit pair — mirrors meal-builder's ingredient row
        // (s.ingQty + s.ingUnit). Parent owns state so swapping focus
        // between the two doesn't unmount the row mid-edit.
        <View style={s.qtyEditWrap}>
          <TextInput
            value={editAmount}
            onChangeText={onEditAmount}
            placeholder="Qty"
            placeholderTextColor={KColors.neutral[600]}
            style={[
              s.qtyInput,
              editAmountInvalid && s.qtyInputInvalid,
            ]}
            // Default keyboard so users can type "/" for fractions —
            // same as meal-builder ("1/2", "1 1/2" supported).
            autoCapitalize="none"
            returnKeyType="done"
            blurOnSubmit
            autoFocus
            onSubmitEditing={onCommitEdit}
          />
          <TextInput
            value={editUnit}
            onChangeText={onEditUnit}
            placeholder="Unit"
            placeholderTextColor={KColors.neutral[600]}
            style={s.unitInput}
            autoCapitalize="none"
            returnKeyType="done"
            blurOnSubmit
            onSubmitEditing={onCommitEdit}
          />
        </View>
      ) : (
        // Qty Pressable — for default staples, tapping fires onTap
        // (opt-in, same as the toggle area); for non-staples, fires
        // onEnterEdit. Always a sibling Pressable, never nested.
        <Pressable
          onPress={isDefaultStaple ? onTap : onEnterEdit}
          // Generous hitSlop (WS5-5Q-fix-4) to absorb the few-px layout
          // shift that fires when the keyboard dismisses on commit — a
          // narrower target was the likely cause of the intermittent
          // "tap fails until I scroll" repro: scroll resets the layout
          // and the next tap lands cleanly. Also matches the X button's
          // hitSlop scale (8) so adjacent targets feel symmetric.
          hitSlop={12}
          style={({ pressed }) => [
            s.qtyTapTarget,
            pressed && { opacity: 0.6 },
          ]}
        >
          <Text
            style={[
              s.qty,
              (isDefaultStaple || item.isCompleted) && {
                color: KColors.neutral[600],
              },
            ]}
          >
            {displayQty || "—"}
          </Text>
        </Pressable>
      )}
      {/* Default staples can't be removed — they just sit dimmed in the
          list. Opted-in staples + regular items expose the X. */}
      {!isDefaultStaple && !isEditing && (
        <Pressable
          onPress={onRemove}
          hitSlop={8}
          style={({ pressed }) => [s.removeBtn, pressed && { opacity: 0.6 }]}
        >
          <Feather name="x" size={16} color={KColors.neutral[500]} />
        </Pressable>
      )}
    </View>
  );
}

function Tag({
  label,
  tone,
}: {
  label: string;
  tone: "sage" | "muted";
}) {
  const palette =
    tone === "sage"
      ? { bg: KColors.sage[100], text: KColors.sage[700] }
      : { bg: KColors.neutral[200], text: KColors.neutral[700] };
  return (
    <View
      style={[
        s.tag,
        { backgroundColor: palette.bg },
      ]}
    >
      <Text style={[s.tagText, { color: palette.text }]}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  scrollContent: {
    paddingHorizontal: KSpacing.lg,
    paddingTop: KSpacing.lg,
    paddingBottom: KSpacing.xxxl,
    gap: KSpacing.md,
  },
  notFoundWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: KSpacing.lg,
  },
  notFoundText: {
    fontSize: KType.size.md,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  orderHeaderBtn: {
    backgroundColor: KColors.terracotta[400],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: 6,
  },
  orderHeaderBtnText: {
    color: KColors.neutral[0],
    fontSize: KType.size.sm,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  ambiguousBanner: {
    flexDirection: "row",
    gap: KSpacing.md,
    backgroundColor: KColors.terracotta[50],
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KColors.terracotta[200],
    padding: KSpacing.md,
  },
  ambiguousIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: KColors.terracotta[100],
    alignItems: "center",
    justifyContent: "center",
  },
  ambiguousHeading: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  ambiguousSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    lineHeight: 18,
  },
  ambiguousLink: {
    fontSize: KType.size.sm,
    color: KColors.terracotta[500],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    marginTop: 4,
  },
  viewPlanLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KPalette.border.default,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.sm,
  },
  viewPlanText: {
    flex: 1,
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  // 6c-6-C — relative-positioned wrapper so the floating <TypeaheadList>
  // can absolute-anchor below the input row. zIndex lifts it above the
  // sibling action row / sections list while the dropdown is open.
  typeaheadWrap: {
    position: "relative",
    zIndex: 10,
  },
  typeaheadAnchored: {
    position: "absolute",
    left: 0,
    right: 0,
    top: "100%",
    marginTop: KSpacing.xs,
  },
  candidateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.sm,
  },
  candidateName: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  candidateSection: {
    fontSize: KType.size.xs,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  candidateChip: {
    backgroundColor: KColors.sage[100],
    borderRadius: KRadius.sm,
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 2,
  },
  candidateChipText: {
    fontSize: KType.size.xs,
    color: KColors.sage[700],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  addItemRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
    alignItems: "stretch",
  },
  addItemInput: {
    flex: 1,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[400],
    paddingHorizontal: KSpacing.md,
    paddingVertical: 10,
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  addItemBtn: {
    backgroundColor: KColors.sage[700],
    borderRadius: KRadius.md,
    paddingHorizontal: KSpacing.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  addItemBtnText: {
    color: KColors.neutral[0],
    fontSize: KType.size.md,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  actionRow: {
    flexDirection: "row",
    gap: KSpacing.sm,
  },
  sectionsWrap: {
    gap: KSpacing.lg,
  },
  section: {
    gap: KSpacing.sm,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: KSpacing.xs,
  },
  sectionHeader: {
    fontSize: KType.size.sm,
    color: KColors.sage[600],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  addItemInline: {
    fontSize: KType.size.sm,
    color: KColors.sage[700],
    fontWeight: KType.weight.medium,
    fontFamily: "Inter_500Medium",
  },
  itemList: {
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.lg,
    borderWidth: 1,
    borderColor: KPalette.border.default,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
    paddingHorizontal: KSpacing.md,
    paddingVertical: KSpacing.md,
    borderBottomWidth: 1,
    borderBottomColor: KPalette.border.muted,
  },
  // Sibling tap area (checkbox + name + tags). flex:1 so it consumes
  // all width left over by the qty + X siblings. Keeping its own
  // flex-row layout lets the checkbox and name sit side-by-side as
  // before. Per WS5-5Q-fix-3, this Pressable replaces the previous
  // row-wrapping Pressable that nested the qty + X Pressables — see
  // GroceryRow comment for the responder-race rationale.
  toggleArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.md,
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: KColors.neutral[500],
    alignItems: "center",
    justifyContent: "center",
  },
  itemTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
    flexWrap: "wrap",
  },
  itemName: {
    fontSize: KType.size.md,
    color: KColors.neutral[900],
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  qty: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
  },
  qtyTapTarget: {
    paddingVertical: 4,
    paddingHorizontal: KSpacing.xs,
    borderRadius: KRadius.sm,
  },
  qtyEditWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: KSpacing.xs,
  },
  // Mirrors meal-builder's s.ingQty (width 56) + s.ingUnit (width 64)
  // so the inline edit pair matches the meal editor exactly.
  qtyInput: {
    width: 56,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  qtyInputInvalid: {
    borderColor: KColors.terracotta[400],
  },
  unitInput: {
    width: 64,
    backgroundColor: KPalette.bg.card,
    borderRadius: KRadius.md,
    borderWidth: 1,
    borderColor: KColors.neutral[300],
    paddingHorizontal: KSpacing.sm,
    paddingVertical: KSpacing.sm,
    fontSize: KType.size.sm,
    color: KColors.neutral[900],
    fontFamily: "Inter_400Regular",
  },
  removeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: KSpacing.xs,
    marginRight: -KSpacing.xs,
  },
  tag: {
    paddingHorizontal: KSpacing.sm,
    paddingVertical: 2,
    borderRadius: KRadius.pill,
  },
  tagText: {
    fontSize: 10,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  markDoneWrap: {
    marginTop: KSpacing.lg,
  },
  completionWrap: {
    marginTop: KSpacing.lg,
    backgroundColor: KColors.sage[50],
    borderRadius: KRadius.xl,
    borderWidth: 1,
    borderColor: KColors.sage[200],
    padding: KSpacing.lg,
    alignItems: "center",
    gap: KSpacing.sm,
  },
  completionIcon: {
    marginBottom: KSpacing.xs,
  },
  completionHeading: {
    fontSize: KType.size.lg,
    color: KColors.neutral[900],
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
  },
  completionSubtitle: {
    fontSize: KType.size.sm,
    color: KColors.neutral[700],
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  completionActions: {
    flexDirection: "row",
    gap: KSpacing.sm,
    width: "100%",
    marginTop: KSpacing.sm,
  },
  unmarkLink: {
    fontSize: KType.size.sm,
    color: KColors.neutral[600],
    fontFamily: "Inter_400Regular",
    textDecorationLine: "underline",
    marginTop: KSpacing.xs,
  },
  undoBanner: {
    position: "absolute",
    left: KSpacing.lg,
    right: KSpacing.lg,
    bottom: KSpacing.lg,
    alignItems: "center",
  },
  undoBannerInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: KColors.neutral[800],
    borderRadius: KRadius.lg,
    paddingHorizontal: KSpacing.lg,
    paddingVertical: KSpacing.md,
    width: "100%",
    gap: KSpacing.md,
  },
  undoBannerText: {
    color: KColors.neutral[0],
    fontSize: KType.size.md,
    fontFamily: "Inter_500Medium",
    fontWeight: KType.weight.medium,
  },
  undoBannerAction: {
    color: KColors.terracotta[300],
    fontSize: KType.size.md,
    fontWeight: KType.weight.semibold,
    fontFamily: "Inter_600SemiBold",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
