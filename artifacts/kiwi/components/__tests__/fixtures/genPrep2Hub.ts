// PREP-2 item 1 — writes prep2HubNonFeast.pre.json from the CURRENT Hub component.
// Run it only against the pre-PREP-2 component; see prep2Hub.ts.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { writeFileSync } from "node:fs";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { PrepCookHubView } from "../../PrepCookHubView";
import { buildPrepCookHubModel } from "@/lib/cooking/hubModel";
import { nonFeastPlan, NON_FEAST_TAGS, NON_FEAST_TODAY } from "./prep2Hub";

const NOOP = () => {};
let r!: TestRenderer.ReactTestRenderer;
act(() => {
  r = TestRenderer.create(
    React.createElement(PrepCookHubView, {
      model: buildPrepCookHubModel(nonFeastPlan(), NON_FEAST_TODAY, NON_FEAST_TAGS),
      onPrepWeek: NOOP,
      onPrepSelected: NOOP,
      onToggleMealSelected: NOOP,
      selectedMealIds: new Set(["m-tue"]),
      onSelectMeal: NOOP,
      onPrepFeast: NOOP,
      onOpenRecipe: NOOP,
      onMakePlan: NOOP,
      onCookThisWeek: NOOP,
      promotingPlanId: null,
    } as never),
  );
});
const out = new URL("./prep2HubNonFeast.pre.json", import.meta.url);
writeFileSync(out, JSON.stringify(r.toJSON(), null, 1) + "\n");
console.log("wrote", out.pathname);
