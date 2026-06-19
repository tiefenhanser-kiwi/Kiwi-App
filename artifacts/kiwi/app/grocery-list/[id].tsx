import React, { useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  Modal,
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
  Colors,
  Palette,
  Radius,
  Spacing,
  Typography,
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
    updateGroceryItemQuantity,
    addGroceryItem,
    removeGroceryItem,
    restoreGroceryItem,
    markGroceryShoppingDone,
    resolveGroceryItemAmbiguity,
  } = useApp();
  // Demo lists ("demo-grocery-*") are local fixtures for design review with
  // non-UUID ids the server rejects — keep their mutations purely optimistic
  // (no network call) so the design-review screen stays self-contained.
  const isDemo = id.startsWith("demo-grocery-");

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
  // PRD §12.7 — staple opt-in ("buying this week") is now a server field
  // (`stapleOptedIn` on the item), driving the active/dimmed render. WS7-7-A
  // Block 3 retired the local stapleOptedInSet in favour of the persisted
  // per-list flag, so opt-in survives reload.
  const [recentlyRemoved, setRecentlyRemoved] = useState<RemovedItem | null>(
    null,
  );
  // WS7-7-A B5 — shown when the GET reconciled the list to plan changes
  // (data-driven off the server's `reconciled` flag, not a timer). Dismissable.
  const [showReconciledBanner, setShowReconciledBanner] = useState(false);
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
        const { list: real, reconciled } = await getGroceryList(id);
        if (!cancelled) {
          setList(real);
          setLoadStatus("ready");
          // The list self-maintained to match plan edits — tell the user so
          // a changed quantity doesn't look like a glitch (PRD: no staleness).
          if (reconciled) setShowReconciledBanner(true);
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

  // WS7-7-A B5 (Issue A) — these six hooks previously sat below the early
  // returns (loading / !list), making them conditional and crashing the
  // loading→ready transition with "Rendered more hooks than during the
  // previous render". They are hoisted above BOTH early returns so the hook
  // count is identical on every render path (loading, empty, ready). Each is
  // safe above the !list guard: the useMemos already read `list?` optionally
  // and the useStates take no list dependency.

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

  // Unresolved = isAmbiguous === true. Computed live off the items so an
  // optimistic resolve/leave-as-is updates the banner + queue immediately
  // (the denormalized list.ambiguousItemCount can lag a single-item patch).
  const unresolvedItems = useMemo(
    () => (list?.items ?? []).filter((it) => it.isAmbiguous),
    [list],
  );

  // The clarify sheet walks a snapshot queue of item ids, advancing an index.
  // Resolve / leave-as-is / skip all advance; resolve + leave-as-is also flip
  // isAmbiguous off (so they leave the unresolved set), skip leaves it on.
  const [clarifyQueue, setClarifyQueue] = useState<string[]>([]);
  const [clarifyIndex, setClarifyIndex] = useState(0);
  const [clarifyOtherText, setClarifyOtherText] = useState("");
  const [clarifyOtherOpen, setClarifyOtherOpen] = useState(false);

  if (loadStatus === "loading") {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Grocery List" />
        <View style={s.notFoundWrap}>
          <ActivityIndicator size="large" color={Colors.sage[700]} />
        </View>
      </View>
    );
  }

  if (!list) {
    return (
      <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
        <Header showBack title="Grocery List" />
        <View style={s.notFoundWrap}>
          <Text style={s.notFoundText}>List not found.</Text>
        </View>
      </View>
    );
  }

  const listId = list.id;

  // Optimistic single-item patch into the local list state. Used by every
  // mutation handler to apply (and revert) without re-fetching.
  const applyItemPatch = (
    itemId: string,
    patch: Partial<GroceryListItem>,
  ) => {
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === itemId ? { ...it, ...patch } : it,
            ),
          }
        : prev,
    );
  };

  const handleItemTap = (item: GroceryListItem) => {
    // Tapping anywhere on the row while a quantity edit is open should
    // commit + exit edit (matches the ambient "tap-out to confirm"
    // expectation), not toggle the checkbox in the same gesture.
    if (editingItemId) {
      commitQuantityEdit();
      return;
    }
    if (item.isUniversalStaple && !(item.stapleOptedIn ?? false)) {
      // Staple's first tap = opt in for this trip; don't strike. Optimistic
      // local flip, then persist (§12.7); revert + surface on failure.
      applyItemPatch(item.id, { stapleOptedIn: true });
      if (isDemo) return;
      toggleGroceryStapleSelection(listId, item.id, true).catch((err) => {
        console.warn("[grocery-list] staple opt-in failed", err);
        applyItemPatch(item.id, { stapleOptedIn: false });
        Alert.alert(
          "Couldn't update item",
          "Something went wrong. Please try again.",
        );
      });
      return;
    }
    // Standard complete-toggle (incl. already-opted-in staples).
    const nextChecked = !item.isCompleted;
    applyItemPatch(item.id, { isCompleted: nextChecked });
    if (isDemo) return;
    toggleGroceryItemCompleted(listId, item.id, nextChecked).catch((err) => {
      console.warn("[grocery-list] check-off failed", err);
      applyItemPatch(item.id, { isCompleted: !nextChecked });
      Alert.alert(
        "Couldn't update item",
        "Something went wrong. Please try again.",
      );
    });
  };

  const handleRemove = (item: GroceryListItem) => {
    if (item.isUniversalStaple) {
      // X on a staple just clears the opt-in (returns to dimmed state).
      // Default-staple X is hidden in GroceryRow, so this branch only
      // fires for opted-in staples. Also clear any strikethrough.
      applyItemPatch(item.id, { stapleOptedIn: false, isCompleted: false });
      if (isDemo) return;
      toggleGroceryStapleSelection(listId, item.id, false).catch((err) => {
        console.warn("[grocery-list] staple opt-out failed", err);
        applyItemPatch(item.id, { stapleOptedIn: true });
        Alert.alert(
          "Couldn't update item",
          "Something went wrong. Please try again.",
        );
      });
      return;
    }
    // Standard item: optimistic remove with undo banner. Soft-delete on the
    // server; the row id is preserved so undo restores the SAME row.
    setList((prev) =>
      prev
        ? { ...prev, items: prev.items.filter((it) => it.id !== item.id) }
        : prev,
    );
    setRecentlyRemoved({ item });
    if (isDemo) return;
    removeGroceryItem(listId, item.id).catch((err) => {
      console.warn("[grocery-list] remove failed; restoring row", err);
      // Re-insert the optimistically-removed row and drop the undo banner.
      setList((prev) =>
        prev ? { ...prev, items: [...prev.items, item] } : prev,
      );
      setRecentlyRemoved(null);
      Alert.alert(
        "Couldn't remove item",
        "Something went wrong. Please try again.",
      );
    });
  };

  const handleUndo = () => {
    if (!recentlyRemoved) return;
    const { item } = recentlyRemoved;
    // Re-insert immediately; the restore endpoint resurrects the SAME row id
    // (WS7-7-A B2), so no fresh-row reconciliation is needed.
    setList((prev) =>
      prev ? { ...prev, items: [...prev.items, item] } : prev,
    );
    setRecentlyRemoved(null);
    if (isDemo) return;
    restoreGroceryItem(listId, item.id).catch((err) => {
      console.warn("[grocery-list] undo restore failed; removing again", err);
      setList((prev) =>
        prev
          ? { ...prev, items: prev.items.filter((it) => it.id !== item.id) }
          : prev,
      );
      Alert.alert(
        "Couldn't restore item",
        "Something went wrong. Please try again.",
      );
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
    const itemId = editingItemId;
    const amt = editAmount.trim() || undefined;
    const unit = editUnit.trim() || undefined;
    // Snapshot the pre-edit values so a failed persist can revert cleanly.
    const prior = list?.items.find((it) => it.id === itemId);
    setList((prev) =>
      prev
        ? {
            ...prev,
            items: prev.items.map((it) =>
              it.id === itemId
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
    // Order matters (WS5-5Q-fix-4): dismiss keyboard FIRST so the keyboard
    // animation and layout shift start before React re-renders the row;
    // then clear edit state, which unmounts the TextInput and naturally
    // releases focus. Reversing the order makes the unmount-blur and the
    // explicit dismiss race, occasionally leaving the responder system
    // stuck until the next scroll resets it.
    Keyboard.dismiss();
    setEditingItemId(null);

    if (isDemo) return;
    // Persist (§12.9). The server stores quantity as a positive Float; when
    // the amount is cleared/invalid we fall back to the prior numeric (or 1)
    // so a unit-only edit still round-trips a valid quantity.
    const parsed = amt ? parseQuantity(amt) : null;
    const priorNum = prior?.quantityAmount
      ? parseFloat(prior.quantityAmount)
      : NaN;
    const quantity =
      parsed != null && parsed > 0
        ? parsed
        : Number.isFinite(priorNum) && priorNum > 0
          ? priorNum
          : 1;
    updateGroceryItemQuantity(listId, itemId, quantity, unit ?? "").catch(
      (err) => {
        console.warn("[grocery-list] quantity edit persist failed", err);
        if (prior) {
          applyItemPatch(itemId, {
            quantityAmount: prior.quantityAmount,
            quantityUnit: prior.quantityUnit,
            quantity: prior.quantity,
          });
        }
        Alert.alert(
          "Couldn't update quantity",
          "Something went wrong. Please try again.",
        );
      },
    );
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
      stapleOptedIn: false,
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

  const handleMarkDone = () => {
    const prev = list.status;
    setList((p) => (p ? { ...p, status: "completed" } : p));
    if (isDemo) return;
    markGroceryShoppingDone(listId, true).catch((err) => {
      console.warn("[grocery-list] mark-done failed", err);
      setList((p) => (p ? { ...p, status: prev } : p));
      Alert.alert(
        "Couldn't update list",
        "Something went wrong. Please try again.",
      );
    });
  };

  const handleUnmarkDone = () => {
    const prev = list.status;
    setList((p) => (p ? { ...p, status: "active" } : p));
    if (isDemo) return;
    markGroceryShoppingDone(listId, false).catch((err) => {
      console.warn("[grocery-list] unmark-done failed", err);
      setList((p) => (p ? { ...p, status: prev } : p));
      Alert.alert(
        "Couldn't update list",
        "Something went wrong. Please try again.",
      );
    });
  };

  // ── WS7-7-A B5 — clarify-any-time ──────────────────────────────────────
  const clarifyOpen = clarifyQueue.length > 0;
  const currentClarifyItem = clarifyOpen
    ? list?.items.find((it) => it.id === clarifyQueue[clarifyIndex])
    : undefined;

  const handleAmbiguousReview = () => {
    const queue = unresolvedItems.map((it) => it.id);
    if (queue.length === 0) return;
    setClarifyQueue(queue);
    setClarifyIndex(0);
    setClarifyOtherText("");
    setClarifyOtherOpen(false);
  };

  const closeClarify = () => {
    // Exit affordance — leave the flow; all partial progress is already
    // persisted (resolved + leave-as-is permanent; skipped stays pending).
    setClarifyQueue([]);
    setClarifyIndex(0);
    setClarifyOtherText("");
    setClarifyOtherOpen(false);
  };

  const advanceClarify = () => {
    setClarifyOtherText("");
    setClarifyOtherOpen(false);
    if (clarifyIndex + 1 < clarifyQueue.length) {
      setClarifyIndex(clarifyIndex + 1);
    } else {
      // End of this pass. Skipped items remain unresolved → the banner
      // persists and the user can reopen to clear them.
      closeClarify();
    }
  };

  const resolveCurrent = (value: string) => {
    const item = currentClarifyItem;
    if (!item) return;
    const resolution = value.trim();
    if (!resolution) return;
    const prevResolved = item.userResolvedTo;
    // Optimistic: project the resolved value + drop the flag.
    applyItemPatch(item.id, { userResolvedTo: resolution, isAmbiguous: false });
    advanceClarify();
    if (isDemo) return;
    resolveGroceryItemAmbiguity(listId, item.id, resolution).catch((err) => {
      console.warn("[grocery-list] resolve failed; reverting", err);
      applyItemPatch(item.id, {
        userResolvedTo: prevResolved,
        isAmbiguous: true,
      });
      Alert.alert("Couldn't save", "Something went wrong. Please try again.");
    });
  };

  const leaveAsIsCurrent = () => {
    const item = currentClarifyItem;
    if (!item) return;
    // Accept the current value: clear the flag WITHOUT a resolution value.
    applyItemPatch(item.id, { isAmbiguous: false });
    advanceClarify();
    if (isDemo) return;
    resolveGroceryItemAmbiguity(listId, item.id, null).catch((err) => {
      console.warn("[grocery-list] leave-as-is failed; reverting", err);
      applyItemPatch(item.id, { isAmbiguous: true });
      Alert.alert("Couldn't save", "Something went wrong. Please try again.");
    });
  };

  const skipCurrent = () => {
    // Item stays unresolved (isAmbiguous untouched); just advance.
    advanceClarify();
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

  // WS7-8b B2 — plan-context entry: land on the real Prep & Cook Hub for this
  // list's plan. Fall back to a bare push (Hub self-resolves) if the list has
  // no planId.
  const handlePrepCook = () => {
    if (list.planId) {
      router.push({ pathname: "/prep-cook", params: { id: list.planId } });
    } else {
      router.push("/prep-cook");
    }
  };

  const subtitle = list.isThisWeek
    ? `${list.planName} · This Week`
    : list.planName;

  return (
    <View style={{ flex: 1, backgroundColor: Colors.neutral[100] }}>
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
        {unresolvedItems.length > 0 && (
          <View style={s.ambiguousBanner}>
            <View style={s.ambiguousIcon}>
              <Feather
                name="alert-triangle"
                size={20}
                color={Colors.terracotta[500]}
              />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={s.ambiguousHeading}>
                Kiwi needs a few specifics
              </Text>
              <Text style={s.ambiguousSubtitle}>
                Some items need clarifying before they can be ordered. Tap to
                specify.
              </Text>
              <Pressable
                onPress={handleAmbiguousReview}
                style={({ pressed }) => [pressed && { opacity: 0.7 }]}
              >
                <Text style={s.ambiguousLink}>
                  Clarify {unresolvedItems.length}{" "}
                  {unresolvedItems.length === 1 ? "item" : "items"} →
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
              color={Colors.sage[700]}
            />
            <Text style={s.viewPlanText} numberOfLines={1}>
              View meal plan: {list.planName}
            </Text>
            <Feather
              name="chevron-right"
              size={14}
              color={Colors.sage[700]}
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
              placeholderTextColor={Colors.neutral[600]}
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
              variant="primary"
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
                      stapleOptedIn={item.stapleOptedIn ?? false}
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
                color={Colors.sage[700]}
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
                  variant="primary"
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

      {/* WS7-7-A B5 — reconcile notice. Reuses the undo-banner shape; sits a
          row higher so it doesn't collide with the undo banner. */}
      {showReconciledBanner && (
        <View style={s.reconcileBanner} pointerEvents="box-none">
          <View style={s.undoBannerInner}>
            <Text style={s.undoBannerText}>Updated to match your plan.</Text>
            <Pressable
              onPress={() => setShowReconciledBanner(false)}
              hitSlop={6}
              style={({ pressed }) => [pressed && { opacity: 0.7 }]}
            >
              <Text style={s.undoBannerAction}>Got it</Text>
            </Pressable>
          </View>
        </View>
      )}

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

      {/* WS7-7-A B5 — clarify-any-time sheet. Auto-advances through unresolved
          items; per item: resolve (chip / Other), skip, leave-as-is, exit. */}
      <Modal
        visible={clarifyOpen}
        transparent
        animationType="slide"
        onRequestClose={closeClarify}
      >
        <View style={s.clarifyBackdrop}>
          <View style={s.clarifySheet}>
            {currentClarifyItem && (
              <>
                <View style={s.clarifyHeaderRow}>
                  {/* Exit affordance — back chevron leaves the flow; progress
                      is already persisted. */}
                  <Pressable onPress={closeClarify} hitSlop={8}>
                    <Feather
                      name="chevron-left"
                      size={24}
                      color={Colors.neutral[700]}
                    />
                  </Pressable>
                  <Text style={s.clarifyProgress}>
                    {clarifyIndex + 1} of {clarifyQueue.length}
                  </Text>
                  <Pressable onPress={closeClarify} hitSlop={8}>
                    <Text style={s.clarifyDone}>Done</Text>
                  </Pressable>
                </View>

                <Text style={s.clarifyTitle}>Which one did you mean?</Text>
                <Text style={s.clarifyItemName}>{currentClarifyItem.name}</Text>

                <View style={s.clarifyChips}>
                  {(currentClarifyItem.ambiguityOptions ?? []).map((opt) => (
                    <Pressable
                      key={opt}
                      onPress={() => resolveCurrent(opt)}
                      style={({ pressed }) => [
                        s.clarifyChip,
                        pressed && { opacity: 0.7 },
                      ]}
                    >
                      <Text style={s.clarifyChipText}>{opt}</Text>
                    </Pressable>
                  ))}
                  <Pressable
                    onPress={() => setClarifyOtherOpen((v) => !v)}
                    style={({ pressed }) => [
                      s.clarifyChip,
                      clarifyOtherOpen && s.clarifyChipActive,
                      pressed && { opacity: 0.7 },
                    ]}
                  >
                    <Text style={s.clarifyChipText}>Other…</Text>
                  </Pressable>
                </View>

                {clarifyOtherOpen && (
                  <View style={s.clarifyOtherRow}>
                    <TextInput
                      value={clarifyOtherText}
                      onChangeText={setClarifyOtherText}
                      placeholder="Type what you want"
                      placeholderTextColor={Colors.neutral[600]}
                      style={s.clarifyOtherInput}
                      autoFocus
                      returnKeyType="done"
                      onSubmitEditing={() => resolveCurrent(clarifyOtherText)}
                    />
                    <Button
                      label="Confirm"
                      variant="primary"
                      onPress={() => resolveCurrent(clarifyOtherText)}
                      disabled={clarifyOtherText.trim().length === 0}
                    />
                  </View>
                )}

                <View style={s.clarifyActions}>
                  <Pressable
                    onPress={skipCurrent}
                    hitSlop={6}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={s.clarifySecondaryAction}>Skip</Text>
                  </Pressable>
                  <Pressable
                    onPress={leaveAsIsCurrent}
                    hitSlop={6}
                    style={({ pressed }) => [pressed && { opacity: 0.7 }]}
                  >
                    <Text style={s.clarifySecondaryAction}>Leave as is</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>
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
              backgroundColor: Colors.sage[700],
              borderColor: Colors.sage[700],
            },
            useDashedCheckbox && {
              borderColor: Colors.neutral[400],
              backgroundColor: "transparent",
              borderStyle: "dashed",
            },
          ]}
        >
          {showCheck && (
            <Feather name="check" size={14} color={Colors.neutral[0]} />
          )}
          {showPlusAffordance && (
            <Feather name="plus" size={12} color={Colors.neutral[500]} />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <View style={s.itemTopRow}>
            <Text
              style={[
                s.itemName,
                showStrikethrough && {
                  textDecorationLine: "line-through",
                  color: Colors.neutral[600],
                },
                isDefaultStaple && {
                  color: Colors.neutral[700],
                },
              ]}
              numberOfLines={2}
            >
              {/* WS7-7-A B5 projection — a resolved item renders its
                  userResolvedTo value over displayName; underlying fields stay
                  intact. */}
              {item.userResolvedTo ?? item.name}
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
            placeholderTextColor={Colors.neutral[600]}
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
            placeholderTextColor={Colors.neutral[600]}
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
                color: Colors.neutral[600],
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
          <Feather name="x" size={16} color={Colors.neutral[500]} />
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
      ? { bg: Colors.sage[100], text: Colors.sage[700] }
      : { bg: Colors.neutral[200], text: Colors.neutral[700] };
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
    paddingHorizontal: Spacing[4],
    paddingTop: Spacing[4],
    paddingBottom: Spacing[8],
    gap: Spacing[3],
  },
  notFoundWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: Spacing[4],
  },
  notFoundText: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  orderHeaderBtn: {
    backgroundColor: Colors.terracotta[400],
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: 6,
  },
  orderHeaderBtnText: {
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.sm,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  ambiguousBanner: {
    flexDirection: "row",
    gap: Spacing[3],
    backgroundColor: Colors.terracotta[50],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Colors.terracotta[200],
    padding: Spacing[3],
  },
  ambiguousIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: Colors.terracotta[100],
    alignItems: "center",
    justifyContent: "center",
  },
  ambiguousHeading: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  ambiguousSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    lineHeight: 18,
  },
  ambiguousLink: {
    fontSize: Typography.fontSize.sm,
    color: Colors.terracotta[500],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    marginTop: 4,
  },
  // WS7-7-A B5 — clarify-any-time sheet.
  clarifyBackdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.35)",
    justifyContent: "flex-end",
  },
  clarifySheet: {
    backgroundColor: Colors.neutral[0],
    borderTopLeftRadius: Radius.lg,
    borderTopRightRadius: Radius.lg,
    padding: Spacing[4],
    paddingBottom: Spacing[4] + 16,
    gap: Spacing[3],
  },
  clarifyHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  clarifyProgress: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  clarifyDone: {
    fontSize: Typography.fontSize.md,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  clarifyTitle: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontFamily: Typography.face.serif[600],
    fontWeight: Typography.fontWeight.semibold,
  },
  clarifyItemName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[700],
    fontFamily: Typography.face.serif[400],
  },
  clarifyChips: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Spacing[2],
  },
  clarifyChip: {
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.border.default,
    backgroundColor: Palette.background.card,
  },
  clarifyChipActive: {
    borderColor: Colors.sage[700],
    backgroundColor: Colors.sage[100],
  },
  clarifyChipText: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[800],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  clarifyOtherRow: {
    gap: Spacing[2],
  },
  clarifyOtherInput: {
    borderWidth: 1,
    borderColor: Palette.border.default,
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  clarifyActions: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: Spacing[1],
  },
  clarifySecondaryAction: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  viewPlanLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Palette.border.default,
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[2],
  },
  viewPlanText: {
    flex: 1,
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
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
    marginTop: Spacing[1],
  },
  candidateRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[2],
  },
  candidateName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  candidateSection: {
    fontSize: Typography.fontSize.xs,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textTransform: "uppercase",
    letterSpacing: 0.4,
  },
  candidateChip: {
    backgroundColor: Colors.sage[100],
    borderRadius: Radius.sm,
    paddingHorizontal: Spacing[2],
    paddingVertical: 2,
  },
  candidateChipText: {
    fontSize: Typography.fontSize.xs,
    color: Colors.sage[700],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  addItemRow: {
    flexDirection: "row",
    gap: Spacing[2],
    alignItems: "stretch",
  },
  addItemInput: {
    flex: 1,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[400],
    paddingHorizontal: Spacing[3],
    paddingVertical: 10,
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  addItemBtn: {
    backgroundColor: Colors.sage[700],
    borderRadius: Radius.md,
    paddingHorizontal: Spacing[4],
    alignItems: "center",
    justifyContent: "center",
  },
  addItemBtnText: {
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
  },
  actionRow: {
    flexDirection: "row",
    gap: Spacing[2],
  },
  sectionsWrap: {
    gap: Spacing[4],
  },
  section: {
    gap: Spacing[2],
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: Spacing[1],
  },
  sectionHeader: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[600],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    letterSpacing: 0.6,
    textTransform: "uppercase",
  },
  addItemInline: {
    fontSize: Typography.fontSize.sm,
    color: Colors.sage[700],
    fontWeight: Typography.fontWeight.medium,
    fontFamily: Typography.face.sans[500],
  },
  itemList: {
    backgroundColor: Palette.background.card,
    borderRadius: Radius.lg,
    borderWidth: 1,
    borderColor: Palette.border.default,
    overflow: "hidden",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[3],
    paddingHorizontal: Spacing[3],
    paddingVertical: Spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: Palette.border.muted,
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
    gap: Spacing[3],
  },
  check: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: Colors.neutral[500],
    alignItems: "center",
    justifyContent: "center",
  },
  itemTopRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
    flexWrap: "wrap",
  },
  itemName: {
    fontSize: Typography.fontSize.md,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  qty: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
  },
  qtyTapTarget: {
    paddingVertical: 4,
    paddingHorizontal: Spacing[1],
    borderRadius: Radius.sm,
  },
  qtyEditWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: Spacing[1],
  },
  // Mirrors meal-builder's s.ingQty (width 56) + s.ingUnit (width 64)
  // so the inline edit pair matches the meal editor exactly.
  qtyInput: {
    width: 56,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  qtyInputInvalid: {
    borderColor: Colors.terracotta[400],
  },
  unitInput: {
    width: 64,
    backgroundColor: Palette.background.card,
    borderRadius: Radius.md,
    borderWidth: 1,
    borderColor: Colors.neutral[300],
    paddingHorizontal: Spacing[2],
    paddingVertical: Spacing[2],
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[900],
    fontFamily: Typography.face.sans[400],
  },
  removeBtn: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: Spacing[1],
    marginRight: -Spacing[1],
  },
  tag: {
    paddingHorizontal: Spacing[2],
    paddingVertical: 2,
    borderRadius: Radius.full,
  },
  tagText: {
    fontSize: 10,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    letterSpacing: 0.3,
  },
  markDoneWrap: {
    marginTop: Spacing[4],
  },
  completionWrap: {
    marginTop: Spacing[4],
    backgroundColor: Colors.sage[50],
    borderRadius: Radius.xl,
    borderWidth: 1,
    borderColor: Colors.sage[200],
    padding: Spacing[4],
    alignItems: "center",
    gap: Spacing[2],
  },
  completionIcon: {
    marginBottom: Spacing[1],
  },
  completionHeading: {
    fontSize: Typography.fontSize.lg,
    color: Colors.neutral[900],
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.serif[600],
  },
  completionSubtitle: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[700],
    fontFamily: Typography.face.sans[400],
    textAlign: "center",
  },
  completionActions: {
    flexDirection: "row",
    gap: Spacing[2],
    width: "100%",
    marginTop: Spacing[2],
  },
  unmarkLink: {
    fontSize: Typography.fontSize.sm,
    color: Colors.neutral[600],
    fontFamily: Typography.face.sans[400],
    textDecorationLine: "underline",
    marginTop: Spacing[1],
  },
  undoBanner: {
    position: "absolute",
    left: Spacing[4],
    right: Spacing[4],
    bottom: Spacing[4],
    alignItems: "center",
  },
  // WS7-7-A B5 — reconcile notice, stacked above the undo banner's slot.
  reconcileBanner: {
    position: "absolute",
    left: Spacing[4],
    right: Spacing[4],
    bottom: Spacing[4] + 64,
    alignItems: "center",
  },
  undoBannerInner: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: Colors.neutral[800],
    borderRadius: Radius.lg,
    paddingHorizontal: Spacing[4],
    paddingVertical: Spacing[3],
    width: "100%",
    gap: Spacing[3],
  },
  undoBannerText: {
    color: Colors.neutral[0],
    fontSize: Typography.fontSize.md,
    fontFamily: Typography.face.sans[500],
    fontWeight: Typography.fontWeight.medium,
  },
  undoBannerAction: {
    color: Colors.terracotta[300],
    fontSize: Typography.fontSize.md,
    fontWeight: Typography.fontWeight.semibold,
    fontFamily: Typography.face.sans[600],
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
});
