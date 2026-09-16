// WS9 Redesign Arc Block 2a — physical react-native-keyboard-controller stub
// for node:test. Loaded via the _loader.mjs resolve hook. Needed so the merged
// wizard (components/WizardScreen.tsx, which wraps its form in
// KeyboardAwareScrollViewCompat) can be mounted under plain Node: the real
// package pulls native modules that cannot load without an RN runtime.
//
// Renders as `rn-keyboard-aware-scrollview`, children passed through — the
// keyboard behaviour is not under test, the form inside it is.

import React from "react";

export const KeyboardAwareScrollView = React.forwardRef(function KeyboardAwareScrollView(
  props,
  ref,
) {
  return React.createElement(
    "rn-keyboard-aware-scrollview",
    { ...props, ref },
    props.children,
  );
});

export default { KeyboardAwareScrollView };
