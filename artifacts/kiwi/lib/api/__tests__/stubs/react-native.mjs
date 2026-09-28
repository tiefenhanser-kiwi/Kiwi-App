// WS7-4-B c6 — physical react-native stub for node:test. Loaded via the
// _loader.mjs resolve hook (specifier "react-native" maps to this file).
// Each primitive is a thin functional React component whose host name is
// preserved in the rendered tree as `rn-<lowercase>` — tests walk the tree
// (TestRenderer.toJSON()) to assert on text content / interaction.

import React from "react";

function makeHost(name) {
  return function HostStub(props) {
    return React.createElement(name, props, props.children);
  };
}

export const View = makeHost("rn-view");
export const Text = makeHost("rn-text");
export const ScrollView = makeHost("rn-scrollview");
export const Pressable = makeHost("rn-pressable");
export const ActivityIndicator = makeHost("rn-activity-indicator");
export const Image = makeHost("rn-image");
export const TextInput = makeHost("rn-text-input");
export const TouchableOpacity = makeHost("rn-touchable-opacity");
export const FlatList = makeHost("rn-flatlist");
export const SafeAreaView = makeHost("rn-safe-area-view");
export const KeyboardAvoidingView = makeHost("rn-keyboard-avoiding-view");

export function Modal(props) {
  if (!props.visible) return null;
  return React.createElement("rn-modal", props, props.children);
}

export const StyleSheet = {
  create(s) {
    return s;
  },
  flatten(s) {
    return Array.isArray(s) ? Object.assign({}, ...s.filter(Boolean)) : s ?? {};
  },
  hairlineWidth: 1,
  absoluteFillObject: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
  // WS9-2 2c Commit 2 — TreatedImage layers its gradient / photo / overlay with
  // StyleSheet.absoluteFill (the registered-style alias of absoluteFillObject).
  absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};

let __alertHandler = null;
export function __setAlertHandler(fn) {
  __alertHandler = fn;
}
export const Alert = {
  alert(title, message, buttons) {
    if (__alertHandler) __alertHandler({ title, message, buttons });
  },
};

// Store-prep lane — Linking, for the welcome + Profile legal links and the
// Instacart hand-off. Records every openURL call and resolves by default; a
// test can make it reject (the no-browser device) with __setLinkingFailure.
// A stub that always resolved would let a missing .catch() ship as an
// unhandled rejection, which is the exact failure the real screens guard.
let __linkingCalls = [];
let __linkingFailure = null;
export function __getLinkingCalls() {
  return [...__linkingCalls];
}
export function __resetLinking() {
  __linkingCalls = [];
  __linkingFailure = null;
}
export function __setLinkingFailure(err) {
  __linkingFailure = err;
}
export const Linking = {
  openURL(url) {
    __linkingCalls.push(url);
    return __linkingFailure ? Promise.reject(__linkingFailure) : Promise.resolve(true);
  },
  canOpenURL() {
    return Promise.resolve(true);
  },
};

export const Platform = {
  OS: "ios",
  select(spec) {
    return spec.ios ?? spec.default;
  },
};

export const Dimensions = {
  get() {
    return { width: 375, height: 812 };
  },
};

export const Keyboard = {
  dismiss() {},
};

// WS9-2 2e Part 2 — added for TellKiwiCard's rotating placeholder.
//
// AccessibilityInfo: the card must render its FIRST placeholder statically when
// the OS reports reduce-motion, so the query has to exist under node:test or
// importing the card throws. Default false (motion allowed) keeps every
// pre-existing test unchanged; __setReduceMotionForTests flips it so the
// reduced-motion path is actually exercisable rather than assumed.
let __reduceMotion = false;
export function __setReduceMotionForTests(v) {
  __reduceMotion = v;
}
export function __resetReduceMotionForTests() {
  __reduceMotion = false;
}
export const AccessibilityInfo = {
  isReduceMotionEnabled: async () => __reduceMotion,
  addEventListener: () => ({ remove() {} }),
};

// Animated: enough surface for an opacity cross-fade. timing().start() applies
// the target value and invokes the callback SYNCHRONOUSLY — the real driver is
// async, so a test must never infer real timing from this; it exists so the
// component mounts and its fade bookkeeping runs.
function AnimatedValue(v) {
  this._value = v;
}
AnimatedValue.prototype.setValue = function (v) {
  this._value = v;
};
AnimatedValue.prototype.interpolate = function () {
  return this;
};
export const Animated = {
  View: makeHost("rn-animated-view"),
  Text: makeHost("rn-animated-text"),
  Value: AnimatedValue,
  timing(value, config) {
    return {
      start(cb) {
        value.setValue(config.toValue);
        if (cb) cb({ finished: true });
      },
    };
  },
  sequence(animations) {
    return {
      start(cb) {
        animations.forEach((a) => a.start());
        if (cb) cb({ finished: true });
      },
    };
  },
};

// Row 9 (1.1) · Stripe S2 Part D — AppState, for BillingContext's foreground
// refetch. §2.3 refetches GET /me/subscription on every "active", because the
// user pays in the SYSTEM browser and comes back to the app by hand, so there is
// no callback — "the app became active" is the only signal there is.
//
// A test drives it with __emitAppState("active"). Listeners are returned with a
// real `remove()` so a provider that forgot to unsubscribe shows up as a listener
// still in this array after unmount, rather than as a silent leak.
let __appStateListeners = [];
export function __getAppStateListenerCount() {
  return __appStateListeners.length;
}
export function __emitAppState(next) {
  for (const l of [...__appStateListeners]) l(next);
}
export function __resetAppState() {
  __appStateListeners = [];
}
export const AppState = {
  currentState: "active",
  addEventListener(type, listener) {
    if (type !== "change") return { remove() {} };
    __appStateListeners.push(listener);
    return {
      remove() {
        __appStateListeners = __appStateListeners.filter((l) => l !== listener);
      },
    };
  },
};
