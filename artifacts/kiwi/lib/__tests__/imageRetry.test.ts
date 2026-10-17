// BOOK-1C2 (item 4a) — one retry for a failed photo (lib/imageRetry.ts).

import assert from "node:assert/strict";
import { test } from "node:test";

import { IMAGE_LOAD_RETRIES, nextImageAttempt } from "../imageRetry";

test("the first failure earns one retry; the second gives up", () => {
  assert.equal(IMAGE_LOAD_RETRIES, 1);
  assert.equal(nextImageAttempt(0), 1);
  assert.equal(nextImageAttempt(1), null);
  assert.equal(nextImageAttempt(5), null);
});
