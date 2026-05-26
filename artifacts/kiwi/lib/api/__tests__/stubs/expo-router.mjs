// WS7-4-B c9 — physical expo-router stub for node:test. Real expo-router
// pulls in a deep tree of native modules (Layouts, Stack, navigation
// containers) that can't load under Node without a full RN runtime. Tests
// override useRouter() on this module after import for per-test assertions.

import React from "react";

let __routerImpl = {
  push: () => {},
  replace: () => {},
  back: () => {},
  navigate: () => {},
  setParams: () => {},
};

export function __setRouterForTests(impl) {
  __routerImpl = { ...__routerImpl, ...impl };
}

export function __resetRouterForTests() {
  __routerImpl = {
    push: () => {},
    replace: () => {},
    back: () => {},
    navigate: () => {},
    setParams: () => {},
  };
}

export function useRouter() {
  return __routerImpl;
}

export function useLocalSearchParams() {
  return {};
}

export function usePathname() {
  return "/";
}

export function useSegments() {
  return [];
}

export function useFocusEffect() {}

export const Link = (props) =>
  React.createElement("expo-link", props, props.children);

export const Stack = Object.assign(
  (props) => React.createElement("expo-stack", props, props.children),
  { Screen: (props) => React.createElement("expo-stack-screen", props) },
);

export const Tabs = Object.assign(
  (props) => React.createElement("expo-tabs", props, props.children),
  { Screen: (props) => React.createElement("expo-tabs-screen", props) },
);

export const Slot = (props) =>
  React.createElement("expo-slot", null, props.children);

export const Redirect = () => null;

export const router = __routerImpl;
