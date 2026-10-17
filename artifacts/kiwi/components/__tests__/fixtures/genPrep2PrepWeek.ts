// PREP-2 item 5 — writes prep2PrepWeek.pre.json. Point it at the PRE-PREP-2 view:
//   mkdir components/__tests__/fixtures/_head
//   git show 5c2233b:artifacts/kiwi/components/PrepWeekView.tsx > components/__tests__/fixtures/_head/PrepWeekView.tsx
//   git show 5c2233b:artifacts/kiwi/components/cooking/CookFooter.tsx > components/__tests__/fixtures/_head/CookFooter.tsx
//   (in _head/PrepWeekView.tsx, import CookFooter from "./CookFooter")
//   node --experimental-strip-types --no-warnings --import ./lib/api/__tests__/_setup.mjs \
//     components/__tests__/fixtures/genPrep2PrepWeek.ts
//   then delete _head/.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { writeFileSync } from "node:fs";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { prepWeekFixture } from "./prep2PrepWeek";

// Dynamic so the checked-in tree typechecks without _head/ (it exists only while regenerating).
const HEAD = "./_head/PrepWeekView";
const { PrepWeekView } = (await import(HEAD)) as { PrepWeekView: unknown };

const NOOP = () => {};
let r!: TestRenderer.ReactTestRenderer;
act(() => {
  r = TestRenderer.create(
    React.createElement(PrepWeekView as never, {
      ...prepWeekFixture(),
      onAdvancePhase: NOOP,
      onPrevPhase: NOOP,
      onSkipPhase: NOOP,
      onSaveExit: NOOP,
      onFinish: NOOP,
      onExit: NOOP,
    }),
  );
});
writeFileSync(new URL("./prep2PrepWeek.pre.json", import.meta.url), JSON.stringify(r.toJSON(), null, 1) + "\n");
console.log("wrote prep2PrepWeek.pre.json");
