// WS9-2 2c Commit 2 — physical expo-linear-gradient stub for node:test. Loaded
// via the _loader.mjs resolve hook (specifier "expo-linear-gradient" maps to
// this file). Needed so TreatedImage can be imported under plain Node: the real
// package ships native .ts source that --experimental-strip-types refuses to
// strip under node_modules.
//
// Renders as `rn-linear-gradient` so a test can assert the placeholder gradient
// is present (its presence behind the photo is the whole fallback contract —
// see §0.2: TreatedImage's null-source rendering is load-bearing for the rail).

import React from "react";

export function LinearGradient(props) {
  return React.createElement("rn-linear-gradient", props, props.children);
}

export default LinearGradient;
