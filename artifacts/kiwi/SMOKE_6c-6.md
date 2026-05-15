# 6c-6 Smoke Test (Expo Go)

Pre-req: have a real grocery list ID in hand. Generate one via Plan Review →
Grocery List flow against a real plan, or note a known UUID from the dev DB.
The Plan Review → Grocery List nav stub is broken (WS7); deep-link directly
to `grocery-list/<your-real-list-id>` via the Expo Go dev menu or paste-into-URL
fallback if needed.

## Steps

1. Open the app in Expo Go, navigate to `grocery-list/[your-real-list-id]`.
2. Tap the "Add an item" input → start typing `mil`.
   - Expect: dropdown appears with suggestions; "whole milk" first.
3. Tap "whole milk" suggestion.
   - Expect: item appears in Dairy & Eggs section instantly (optimistic).
     The id flickers from `local-<timestamp>` to the server-returned id once
     the POST completes (verify in console logs if curious).
4. Type `doritos`.
   - Expect: lookup miss → AI fallback fires after debounce → "Doritos"
     suggestion appears with the AI's suggestedQuantity chip (e.g. "1 bag").
5. Tap "Doritos".
   - Expect: appears in Snacks section.
6. Type `pb`.
   - Expect: alias match → "peanut butter" suggested.
7. Tap → appears in Pantry with "1 jar" parsed from suggestedQuantity.
8. Type `tp`.
   - Expect: no Ingredient hit → AI fallback → "toilet paper / household".
9. Type random gibberish `asdfgh`.
   - Expect: AI fallback gracefully assigns to "extras" or best guess.
10. Press Enter without selecting a suggestion (just type `random thing`
    and hit return).
    - Expect: if candidates are visible, the top one is auto-tapped. If
      none are visible (cleared or empty), the raw text is added to the
      Extras section with quantity=1 unit=each.
11. Toggle airplane mode briefly during an add.
    - Expect: optimistic item appears, then disappears with an error
      Alert ("Couldn't add item"). Local row is rolled back.
12. Re-open list (pull-to-refresh or navigate away + back).
    - Expect: all items added round-tripped via the server are persisted;
      raw-id items from step 11 are gone.

## Pass/fail rubric

- Steps 2-9 all show the correct section after add → pass.
- Step 10 raw-text submission lands in Extras → pass.
- Step 11 produces visible rollback (no orphan local row) → pass.
- Step 12 persistence holds across reload → pass.

If any step misbehaves, capture a screenshot + the relevant
`console.warn("[grocery-list] ...")` log lines.
