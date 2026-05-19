// Setup file: registers _loader.mjs as a customization hook BEFORE any
// imports of expo-* packages cascade through the dependency graph.
// Wired via package.json's `test` script: `node --import ./_setup.mjs ...`.

import { register } from "node:module";

register("./_loader.mjs", import.meta.url);
