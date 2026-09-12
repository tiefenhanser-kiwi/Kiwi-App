// D-WS9-231 — GET /reset-password (web fallback, the PRIMARY reset surface).
//
// Reads `token` from the query string, collects a new password twice, and
// POSTs { token, newPassword } to POST /api/auth/password-reset/confirm — the
// endpoint the mobile client already uses (routes/auth.ts). The password rule
// shown in the hint is resetConfirmSchema's: `newPassword: z.string().min(8)
// .max(100)`; the browser-side check mirrors it only so a too-short password
// never spends a request — the server rule is the one that binds.
//
// A missing token renders the invalid state WITHOUT a request. A 400 from the
// endpoint (bad, expired, or already-spent token — BUG-233's single-use
// ledger) renders the same invalid state.

import { APP_SCHEME, pageShell } from "./layout";

export const RESET_PASSWORD_PATH = "/reset-password";
export const RESET_CONFIRM_ENDPOINT = "/api/auth/password-reset/confirm";

export const RESET_SUCCESS_TEXT =
  "Your password has been changed. Open Kiwi and sign in.";
export const LINK_INVALID_TEXT =
  "This link is invalid or has expired. Request a new one from the app.";

const BODY = `
<h1>Set a new password</h1>
<section id="form-state">
  <p class="hint">Choose a new password for your Kiwi account. At least 8 characters.</p>
  <form id="reset-form" novalidate>
    <label for="new-password">New password</label>
    <input id="new-password" type="password" autocomplete="new-password" minlength="8" maxlength="100" required>
    <label for="confirm-password">Confirm new password</label>
    <input id="confirm-password" type="password" autocomplete="new-password" minlength="8" maxlength="100" required>
    <p id="form-error" class="error" hidden></p>
    <button id="submit" type="submit">Change password</button>
  </form>
  <a id="app-link" class="app-link" hidden>Open in the Kiwi app</a>
</section>
<section id="done-state" hidden>
  <h1>Password changed</h1>
  <p class="ok">${RESET_SUCCESS_TEXT}</p>
</section>
<section id="invalid-state" hidden>
  <h1>Link not valid</h1>
  <p class="error">${LINK_INVALID_TEXT}</p>
</section>
<script>
(function () {
  var token = new URLSearchParams(location.search).get("token") || "";
  var formState = document.getElementById("form-state");
  var doneState = document.getElementById("done-state");
  var invalidState = document.getElementById("invalid-state");
  function show(el) {
    formState.hidden = doneState.hidden = invalidState.hidden = true;
    el.hidden = false;
  }
  if (!token) { show(invalidState); return; }

  var appLink = document.getElementById("app-link");
  appLink.href = "${APP_SCHEME}:/${RESET_PASSWORD_PATH}?token=" + encodeURIComponent(token);
  appLink.hidden = false;

  var form = document.getElementById("reset-form");
  var error = document.getElementById("form-error");
  var submit = document.getElementById("submit");
  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var pw = document.getElementById("new-password").value;
    var confirm = document.getElementById("confirm-password").value;
    error.hidden = true;
    if (pw.length < 8) { error.textContent = "Use at least 8 characters."; error.hidden = false; return; }
    if (pw.length > 100) { error.textContent = "Use at most 100 characters."; error.hidden = false; return; }
    if (pw !== confirm) { error.textContent = "The two passwords do not match."; error.hidden = false; return; }
    submit.disabled = true;
    fetch("${RESET_CONFIRM_ENDPOINT}", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token, newPassword: pw })
    }).then(function (res) {
      if (res.ok) { show(doneState); return; }
      if (res.status === 400) { show(invalidState); return; }
      error.textContent = "Something went wrong (" + res.status + "). Please try again.";
      error.hidden = false; submit.disabled = false;
    }).catch(function () {
      error.textContent = "Could not reach the server. Check your connection and try again.";
      error.hidden = false; submit.disabled = false;
    });
  });
})();
</script>
`;

export const resetPasswordHtml: string = pageShell("Reset password", BODY);
