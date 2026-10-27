// Prep the Week footer copy — Hans's device-pass wording (Oct 3), verbatim:
// "Next: {next step title} · This step: ~{n} min", and on the last step
// "Last step · This step: ~{n} min".

import assert from "node:assert/strict";
import { test } from "node:test";

import { prepWeekFooterLine } from "../prepWeekFooter";

test("a step with a next one: names it, then this step's minutes", () => {
  assert.equal(
    prepWeekFooterLine("Sauces and marinades", 12),
    "Next: Sauces and marinades · This step: ~12 min",
  );
});

test("the last step: 'Last step', then this step's minutes", () => {
  assert.equal(prepWeekFooterLine(null, 20), "Last step · This step: ~20 min");
});

test("a step with nothing to prep drops the minutes rather than saying ~0", () => {
  assert.equal(prepWeekFooterLine("Produce", 0), "Next: Produce");
  assert.equal(prepWeekFooterLine(null, 0), "Last step");
});

// CLIENT-3 E (BUG-534) — the label step as the prep-area card.
import { prepAreaCard } from "../prepWeekFooter";

test("CLIENT-3 E: the card reads its count from the title and its list from the instructions", () => {
  const card = prepAreaCard({
    stepKey: "week-labels",
    title: "Label 3 containers",
    instructions: "Write these on tape, one per container: Taco spices · Chicken plate · Lemon juice.",
  });
  assert.deepEqual(card, {
    title: "Set up your prep area",
    body: "As you chop and measure in this session, you'll fill 3 containers. Set them out however works for you (tape and a pen work well for labels):",
    labels: ["Taco spices", "Chicken plate", "Lemon juice"],
  });
});

test("CLIENT-3 E: n is the session's count, not the list's (the week's list is cut at 800 characters)", () => {
  const card = prepAreaCard({ stepKey: "week-labels", title: "Label 40 containers", instructions: "Write these on tape, one per container: A · B · C" });
  assert.ok(card?.body.includes("fill 40 containers"), card?.body);
  assert.deepEqual(card?.labels, ["A", "B", "C"]);
});

test("CLIENT-3 E: one container reads singular; a title without a count falls back to the list", () => {
  const one = prepAreaCard({ stepKey: "feast-labels", title: "Label 1 container", instructions: "Write these on tape, one per container: Gravy base." });
  assert.ok(one?.body.includes("fill 1 container."), one?.body);
  const noCount = prepAreaCard({ stepKey: "feast-labels", title: "Labels", instructions: "Write these on tape, one per container: X · Y." });
  assert.ok(noCount?.body.includes("fill 2 containers"), noCount?.body);
});

test("CLIENT-3 E: instructions in another form keep the server's text; no count at all keeps the server's step", () => {
  const odd = prepAreaCard({ stepKey: "week-labels", title: "Label 2 containers", instructions: "Grab two jars." });
  assert.equal(odd?.labels, null);
  assert.equal(odd?.title, "Set up your prep area");
  assert.equal(prepAreaCard({ stepKey: "week-labels", title: "Labels", instructions: "Grab two jars." }), null);
  assert.equal(prepAreaCard({ stepKey: "produce#onions", title: "Label 2 containers", instructions: "x: A · B" }), null);
});
