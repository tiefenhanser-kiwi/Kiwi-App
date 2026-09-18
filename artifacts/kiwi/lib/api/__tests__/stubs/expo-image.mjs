// WS9 row 5 Block 2 Part E — physical expo-image stub for node:test. Loaded
// via the _loader.mjs resolve hook (specifier "expo-image" maps to this file).
// Needed so TreatedImage can be imported under plain Node: the real package
// ships native source that --experimental-strip-types refuses to strip under
// node_modules.
//
// Renders as `expo-image` so a test can find the photo element and read the
// props TreatedImage hands it (source, contentFit, cachePolicy, onError).

import React from "react";

export function Image(props) {
  return React.createElement("expo-image", props, props.children);
}

export default Image;
