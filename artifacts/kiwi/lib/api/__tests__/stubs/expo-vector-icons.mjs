// WS7-4-B c6 — physical @expo/vector-icons stub for node:test.

import React from "react";

function makeIcon(family) {
  return function IconStub(props) {
    return React.createElement(`icon-${family}`, {
      name: props.name,
      size: props.size,
      color: props.color,
    });
  };
}

export const Feather = makeIcon("feather");
export const Ionicons = makeIcon("ionicons");
export const MaterialIcons = makeIcon("material");
export const MaterialCommunityIcons = makeIcon("material-community");
export const FontAwesome = makeIcon("font-awesome");
