import React, { forwardRef, useState } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
} from "react-native";
import { Feather } from "@expo/vector-icons";

import { Colors, Radius, Spacing } from "@/constants/tokens";

// A password TextInput with a show/hide toggle.
//
// Five screens took a password before this component: sign-in, sign-up, both
// fields on reset-password, and the change-password field on Profile. All five
// were a bare `secureTextEntry` TextInput with no way to see what had been
// typed — on a phone keyboard, with a minimum-length rule and (on reset) a
// confirm field that has to match, that is a retype, not a typo.
//
// ⚠️ THE INPUT KEEPS THE CALLER'S STYLE, and the toggle is positioned OVER it
// rather than laid out beside it. Each of the five screens styles its inputs
// itself (styles.input, s.pwInput — different padding, borders and radii), and
// wrapping them in a flex row would have re-laid-out five screens for one
// button. The wrapper is `position: relative` and the button is absolute at the
// trailing edge; the input gains right padding so text cannot run under it.
//
// The toggle's hit area is 44 pt (the Apple minimum) via hitSlop rather than
// via size — the icon itself stays 18 pt so it does not crowd the field.
//
// forwardRef, because sign-up's password field is the `onSubmitEditing` focus
// target of the field above it. A wrapper that swallowed the ref would break
// that keyboard flow silently: the Next key would simply do nothing.

export interface PasswordFieldProps
  extends Omit<TextInputProps, "secureTextEntry"> {
  /** The caller's own input style — applied to the TextInput, as before. */
  style?: StyleProp<TextStyle>;
}

export const PasswordField = forwardRef<TextInput, PasswordFieldProps>(
  function PasswordField({ style, editable, ...rest }, ref) {
    const [visible, setVisible] = useState(false);

    return (
      <View style={s.wrap}>
        <TextInput
          {...rest}
          ref={ref}
          editable={editable}
          secureTextEntry={!visible}
          // Password managers and autocorrect have no business here, and every
          // one of the five call sites either set these or wanted them.
          autoCapitalize={rest.autoCapitalize ?? "none"}
          autoCorrect={rest.autoCorrect ?? false}
          style={[style, s.inputRoom]}
        />
        <Pressable
          onPress={() => setVisible((v) => !v)}
          // 44 pt total from an 18 pt icon: (44 - 18) / 2 = 13 a side.
          hitSlop={13}
          accessibilityRole="button"
          accessibilityLabel={visible ? "Hide password" : "Show password"}
          style={({ pressed }) => [s.toggle, pressed && { opacity: 0.6 }]}
          testID="password-visibility-toggle"
        >
          <Feather
            name={visible ? "eye-off" : "eye"}
            size={18}
            color={Colors.neutral[600]}
          />
        </Pressable>
      </View>
    );
  },
);

const s = StyleSheet.create({
  wrap: {
    position: "relative",
    justifyContent: "center",
  },
  // Room for the toggle so a long password does not slide under the icon.
  inputRoom: {
    paddingRight: Spacing[8],
  },
  toggle: {
    position: "absolute",
    right: Spacing[3],
    // Centred vertically without knowing the caller's height.
    top: 0,
    bottom: 0,
    justifyContent: "center",
    borderRadius: Radius.full,
  },
});
