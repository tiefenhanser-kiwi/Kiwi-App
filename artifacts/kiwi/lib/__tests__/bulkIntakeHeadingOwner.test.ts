// WS9 row 5 Block 3 (BUG-298) — the Add Meals headings are laid out by ONE rule.
//
// Hans, device item 7b: the "Several at once · Name the meals you already
// cook" heading rendered INSIDE the bulk-intake component's card while the
// sibling "One at a time · How do you want to build this meal?" heading was the
// screen's, so the page read as one heading owning the wrong block. The fix is
// ownership, not copy: the SCREEN renders both headings with the same two
// styles (sectionLabelQuiet + sectionHeader), and the component renders only
// its subline and boxes.
//
// A source-level guard, on the noWriteback.test.ts precedent: app/meal-builder.tsx
// is a 2,300-line route that is not render-testable here, and the thing being
// pinned is structural — which file renders which string, with which style.
// The component side (it must NOT render the heading) is pinned by
// components/__tests__/PlaylistBulkIntake.test.ts on a real mount.

import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const screen = readFileSync(resolve(root, "app/meal-builder.tsx"), "utf8");
const component = readFileSync(resolve(root, "components/PlaylistBulkIntake.tsx"), "utf8");

test("BUG-298: the screen renders the bulk heading with the same styles as the one-at-a-time heading", () => {
  // Both headings, same two styles, in the screen.
  assert.match(
    screen,
    /<Text style=\{s\.sectionLabelQuiet\}>\{BULK_SECTION_LABEL\}<\/Text>/,
    "the eyebrow is the screen's, styled sectionLabelQuiet",
  );
  assert.match(
    screen,
    /<Text style=\{s\.sectionHeader\}>\{BULK_SECTION_TITLE\}<\/Text>/,
    "the title is the screen's, styled sectionHeader",
  );
  assert.match(
    screen,
    /<Text style=\{s\.sectionLabelQuiet\}>One at a time<\/Text>/,
    "the sibling eyebrow keeps the same style (the rule the bulk heading joined)",
  );
  assert.match(
    screen,
    /<Text style=\{s\.sectionHeader\}>How do you want to build this meal\?<\/Text>/,
    "the sibling title keeps the same style",
  );
  // The strings come from the runner module, not a second literal.
  assert.match(screen, /BULK_SECTION_LABEL, BULK_SECTION_TITLE \} from "@\/lib\/builder\/bulkPlaylistIntake"/);
  assert.ok(!screen.includes('"Several at once"'), "no duplicate literal in the screen");
});

test("BUG-298: the component renders neither heading string (the subline stays)", () => {
  assert.ok(!component.includes("BULK_SECTION_LABEL"), "label not referenced by the component");
  assert.ok(!component.includes("BULK_SECTION_TITLE"), "title not referenced by the component");
  assert.ok(component.includes("{BULK_SECTION_SUBLINE}"), "the subline is still the component's");
});
