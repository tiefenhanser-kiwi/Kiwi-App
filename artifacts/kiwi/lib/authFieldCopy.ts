// WEB-2 Part H (BUG-365) — the sign-up fields' placeholders, short enough for
// one line at the largest text size, with the detail moved under the field.
//
// A TextInput placeholder never wraps: it is cut at the field's edge. Measured
// in DM Sans 400 at the field's 15 px, against a 360 dp phone's password field
// (328 wide less 12 + 32 padding for the eye toggle, 2 border = 282 px) and its
// phone field (302 px): "Password (min 8 characters)" is 13.35 em = 200 px and
// was cut above a 1.41× system text size; "Phone number (optional)" 11.56 em =
// 173 px, cut above 1.74×. "Password" (4.48 em) fits to 4.2× and "Phone
// (optional)" (7.69 em) to 2.6× — past Android's 2× ceiling. The 8-character
// rule is helper text under the field, which wraps.

export const PASSWORD_PLACEHOLDER = "Password";
export const PASSWORD_HELPER = "At least 8 characters";
export const PHONE_PLACEHOLDER = "Phone (optional)";
