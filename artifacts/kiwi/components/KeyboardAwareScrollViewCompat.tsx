import React from "react";
import {
  KeyboardAwareScrollView,
  KeyboardAwareScrollViewProps,
} from "react-native-keyboard-controller";
import { Platform, ScrollView, ScrollViewProps } from "react-native";

import { Spacing } from "@/constants/tokens";

type Props = KeyboardAwareScrollViewProps & ScrollViewProps;

export const KeyboardAwareScrollViewCompat = React.forwardRef<ScrollView, Props>(
  (
    {
      children,
      keyboardShouldPersistTaps = "handled",
      // WS9-2 BUG-077 — default the keyboard clearance. Without it all consumers
      // inherited the library default of 0, which aligns the focused caret flush
      // with the keyboard top (reads as covered). Spacing[6] (24) is the only
      // measured-good value in the app — app/wizard.tsx passes it explicitly and
      // notes 0 was wrong. Destructured BEFORE ...props, so an explicit consumer
      // prop still wins (wizard's === the default, so nothing is overridden).
      bottomOffset = Spacing[6],
      ...props
    },
    ref,
  ) => {
    if (Platform.OS === "web") {
      // Plain web ScrollView has no bottomOffset — it's a KeyboardAwareScrollView
      // concept, so it's intentionally not forwarded on web.
      return (
        <ScrollView
          ref={ref}
          keyboardShouldPersistTaps={keyboardShouldPersistTaps}
          {...props}
        >
          {children}
        </ScrollView>
      );
    }
    return (
      <KeyboardAwareScrollView
        ref={ref}
        keyboardShouldPersistTaps={keyboardShouldPersistTaps}
        bottomOffset={bottomOffset}
        {...props}
      >
        {children}
      </KeyboardAwareScrollView>
    );
  },
);
