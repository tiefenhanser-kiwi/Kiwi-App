// SEC-3 B — "Confirm it's you" on the email change and account deletion.
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

import { ReauthFields } from "../ReauthFields";
import { AuthProvider } from "@/contexts/AuthContext";
import { useReauthAction, type ReauthAction } from "@/hooks/useReauthAction";
import { ApiError } from "@/lib/api/errors";
import {
  REAUTH_COPY,
  REAUTH_PASSWORD_HINT,
  REAUTH_SIGN_IN_AGAIN,
  type ReauthFailure,
} from "@/lib/reauth";

type Json = { type: string; props: Record<string, unknown>; children: (Json | string)[] | null };

let active: TestRenderer.ReactTestRenderer | null = null;
afterEach(async () => {
  if (active) {
    const r = active;
    active = null;
    await act(async () => r.unmount());
  }
});

function state(hasPassword: boolean | null, failure: ReauthFailure | null = null): ReauthAction {
  return {
    hasPassword,
    password: "",
    setPassword: () => {},
    failure,
    ready: true,
    run: async () => true,
    reset: () => {},
  };
}

async function render(reauth: ReauthAction): Promise<Json> {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    active = TestRenderer.create(
      React.createElement(
        QueryClientProvider,
        { client: qc },
        React.createElement(
          AuthProvider,
          null,
          React.createElement(ReauthFields, { reauth, onSignedInAgain: () => {} }),
        ),
      ),
    );
  });
  return active!.toJSON() as unknown as Json;
}

function walk(n: Json | string | null): Json[] {
  if (n == null || typeof n === "string") return [];
  return [n, ...(n.children ?? []).flatMap(walk)];
}
function text(n: Json | string | null): string {
  if (n == null) return "";
  if (typeof n === "string") return n;
  return (n.children ?? []).map(text).join("");
}
const byId = (root: Json, id: string) => walk(root).find((n) => n.props.testID === id) ?? null;

test("unknown account: the password field, with the 'Google or Apple? Leave it empty' hint", async () => {
  const root = await render(state(null));
  assert.ok(byId(root, "reauth-password"), "password field");
  assert.ok(text(root).includes(REAUTH_PASSWORD_HINT));
  assert.equal(byId(root, "reauth-error"), null);
  assert.equal(byId(root, "reauth-sign-in-again"), null, "no 'Sign in again' until the server asks");
});

test("a password account: the field, no hint", async () => {
  const root = await render(state(true));
  assert.ok(byId(root, "reauth-password"));
  assert.ok(!text(root).includes(REAUTH_PASSWORD_HINT));
});

test("a Google/Apple-only account: no password field at all", async () => {
  const root = await render(state(false));
  assert.equal(byId(root, "reauth-password"), null);
});

test("wrong password: the plain line, and no 'Sign in again'", async () => {
  const root = await render(state(true, "password_incorrect"));
  assert.equal(text(byId(root, "reauth-error")), REAUTH_COPY.passwordIncorrect);
  assert.equal(byId(root, "reauth-sign-in-again"), null);
});

test("too-old sign-in on a Google/Apple account: the line and 'Sign in again to confirm'", async () => {
  const root = await render(state(false, "reauth_required"));
  assert.equal(text(byId(root, "reauth-error")), REAUTH_COPY.signInTooOld);
  const again = byId(root, "reauth-sign-in-again");
  assert.ok(again, "the sign-in-again block");
  assert.ok(text(again).includes(REAUTH_SIGN_IN_AGAIN));
});

test("reauth_required on a known password account asks for the password, never a provider", async () => {
  const root = await render(state(true, "reauth_required"));
  assert.equal(text(byId(root, "reauth-error")), REAUTH_COPY.passwordNeeded);
  assert.equal(byId(root, "reauth-sign-in-again"), null);
});

// ── with the real hook: SEC-2's refusal teaches which account this is ───────

async function renderLive(refusal: Record<string, unknown> | null): Promise<{ press: () => Promise<boolean>; root: () => Json }> {
  let reauth!: ReauthAction;
  function Harness() {
    reauth = useReauthAction(async () => {
      if (refusal) throw new ApiError("refused", { status: 403, body: refusal });
    });
    return React.createElement(ReauthFields, { reauth, onSignedInAgain: () => {} });
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    active = TestRenderer.create(
      React.createElement(QueryClientProvider, { client: qc }, React.createElement(AuthProvider, null, React.createElement(Harness))),
    );
  });
  return {
    press: async () => {
      let ok = false;
      await act(async () => {
        ok = await reauth.run();
      });
      return ok;
    },
    root: () => active!.toJSON() as unknown as Json,
  };
}

test("SEC-2 'sign_in' refusal: the password field goes, 'Sign in again' comes", async () => {
  const live = await renderLive({ code: "reauth_required", method: "sign_in", error: "sign in again to continue" });
  assert.ok(byId(live.root(), "reauth-password"), "unknown account: the field shows first");
  assert.equal(await live.press(), false);
  assert.equal(byId(live.root(), "reauth-password"), null, "a Google/Apple-only account has no password to type");
  assert.equal(text(byId(live.root(), "reauth-error")), REAUTH_COPY.signInTooOld);
  assert.ok(byId(live.root(), "reauth-sign-in-again"));
});

test("SEC-2 'password' refusal: the field stays, its hint goes, no provider buttons", async () => {
  const live = await renderLive({ code: "reauth_required", method: "password", error: "current password required" });
  assert.equal(await live.press(), false);
  assert.ok(byId(live.root(), "reauth-password"));
  assert.ok(!text(live.root()).includes(REAUTH_PASSWORD_HINT), "now known to be a password account");
  assert.equal(text(byId(live.root(), "reauth-error")), REAUTH_COPY.passwordNeeded);
  assert.equal(byId(live.root(), "reauth-sign-in-again"), null);
});

test("no refusal: run() resolves true and nothing is said", async () => {
  const live = await renderLive(null);
  assert.equal(await live.press(), true);
  assert.equal(byId(live.root(), "reauth-error"), null);
});
