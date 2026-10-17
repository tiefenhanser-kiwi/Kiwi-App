// LIFE-1 — GET /email/unsubscribe (the footer link in every lifecycle email
// but the welcome).
//
// On load, POSTs { token } to POST /api/email/unsubscribe — the verify-email
// page's shape. The page itself writes nothing: a mail scanner that prefetches
// the link gets this HTML and stops, and only a browser that runs the script
// opts out (routes/lifecycleEmail.ts has the reasoning). A missing token
// renders the invalid state without a request.

import { UNSUBSCRIBE_API_PATH, UNSUBSCRIBE_PAGE_PATH } from "../lib/lifecycle/unsubscribe";
import { pageShell } from "./layout";

export { UNSUBSCRIBE_PAGE_PATH };
export const UNSUBSCRIBE_ENDPOINT = `/api${UNSUBSCRIBE_API_PATH}`;

export const UNSUBSCRIBE_DONE_TEXT =
  "You won't get any more tips or reminders from Kiwi. Account emails, like password resets, still arrive.";
export const UNSUBSCRIBE_INVALID_TEXT =
  "This unsubscribe link isn't valid. Reply to any Kiwi email and we'll take you off the list.";

const BODY = `
<section id="pending-state">
  <h1>Unsubscribing…</h1>
  <p class="hint">One moment.</p>
</section>
<section id="done-state" hidden>
  <h1>You're unsubscribed</h1>
  <p class="ok">${UNSUBSCRIBE_DONE_TEXT}</p>
</section>
<section id="invalid-state" hidden>
  <h1>Link not valid</h1>
  <p class="error">${UNSUBSCRIBE_INVALID_TEXT}</p>
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
  function unsubscribe() {
    show("pending");
    fetch("${UNSUBSCRIBE_ENDPOINT}", {
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
  document.getElementById("retry").addEventListener("click", unsubscribe);
  unsubscribe();
})();
</script>
`;

export const unsubscribeHtml: string = pageShell("Unsubscribe", BODY);
