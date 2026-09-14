// D-WS9-231 — GET /verify-email (web fallback for the email-change link).
//
// On load, POSTs { token } to POST /api/me/email/verify-change — the endpoint
// the mobile client already uses (routes/me.ts; the JWT IS the auth, no
// session needed). Two outcomes, same wording as the reset page's: success,
// or the invalid/expired state. A missing token renders the invalid state
// WITHOUT a request.
//
// BUG-265 — NO `kiwi://` app link here, unlike the reset page. This page
// spends the token on load, so by the time anyone tapped "Open in the Kiwi
// app" the link could only carry them from a success to a failure. The reset
// page keeps its link: there the app screen does the work the form does.

import { pageShell } from "./layout";
import { LINK_INVALID_TEXT } from "./resetPassword";

export const VERIFY_EMAIL_PATH = "/verify-email";
export const VERIFY_CHANGE_ENDPOINT = "/api/me/email/verify-change";

export const VERIFY_SUCCESS_TEXT =
  "Your email address has been changed. Open Kiwi and sign in with it.";

const BODY = `
<section id="pending-state">
  <h1>Confirming your new email…</h1>
  <p class="hint">One moment.</p>
</section>
<section id="done-state" hidden>
  <h1>Email changed</h1>
  <p class="ok">${VERIFY_SUCCESS_TEXT}</p>
</section>
<section id="invalid-state" hidden>
  <h1>Link not valid</h1>
  <p class="error">${LINK_INVALID_TEXT}</p>
</section>
<section id="error-state" hidden>
  <h1>Something went wrong</h1>
  <p id="error-text" class="error"></p>
  <button id="retry" type="button">Try again</button>
</section>
<script>
(function () {
  var token = new URLSearchParams(location.search).get("token") || "";
  var states = {
    pending: document.getElementById("pending-state"),
    done: document.getElementById("done-state"),
    invalid: document.getElementById("invalid-state"),
    error: document.getElementById("error-state")
  };
  function show(name) {
    for (var k in states) states[k].hidden = k !== name;
  }
  if (!token) { show("invalid"); return; }

  var errorText = document.getElementById("error-text");
  function verify() {
    show("pending");
    fetch("${VERIFY_CHANGE_ENDPOINT}", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: token })
    }).then(function (res) {
      if (res.ok) { show("done"); return; }
      if (res.status === 400) { show("invalid"); return; }
      errorText.textContent = "The server answered " + res.status + ".";
      show("error");
    }).catch(function () {
      errorText.textContent = "Could not reach the server. Check your connection.";
      show("error");
    });
  }
  document.getElementById("retry").addEventListener("click", verify);
  verify();
})();
</script>
`;

export const verifyEmailHtml: string = pageShell("Verify email", BODY);
