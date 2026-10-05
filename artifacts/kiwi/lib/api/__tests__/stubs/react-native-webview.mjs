// Resub C1 — physical react-native-webview stub for node:test. The real module
// reaches a native view manager that cannot load under Node. This renders an
// `rn-webview` host carrying every prop, so a test can read what the screen
// configured (source, cookies, storage, origin whitelist, user agent) and drive
// the page side by calling `props.onMessage({ nativeEvent: { data } })`.

import React from "react";

export function WebView(props) {
  return React.createElement("rn-webview", props);
}

export default WebView;
