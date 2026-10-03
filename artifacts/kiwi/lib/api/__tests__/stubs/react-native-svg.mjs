// Prep the Week loading screen — physical react-native-svg stub for node:test.
// Loaded via the _loader.mjs resolve hook (specifier "react-native-svg" maps to
// this file). The real package's entry pulls in native component specs that
// --experimental-strip-types will not strip under node_modules.
//
// Each element renders as `rn-svg-<lowercase>` with its props intact, so a test
// can walk the tree and read back a path's `d`, fill and stroke exactly as the
// component wrote them.

import React from "react";

function makeHost(name) {
  return function SvgHostStub(props) {
    return React.createElement(name, props, props.children);
  };
}

export const Svg = makeHost("rn-svg");
export const G = makeHost("rn-svg-g");
export const Path = makeHost("rn-svg-path");
export const Rect = makeHost("rn-svg-rect");
export const Circle = makeHost("rn-svg-circle");
export const Line = makeHost("rn-svg-line");
export const Text = makeHost("rn-svg-text");

export default Svg;
