// SEC-3 B — the state behind "Confirm it's you" on the two re-auth actions
// (app/delete-account.tsx, the email change in app/(tabs)/profile.tsx). Every
// decision is lib/reauth.ts's; this holds the password and the last refusal.

import { useState } from "react";

import { useAuth } from "@/contexts/AuthContext";
import {
  accountHasPassword,
  learnedHasPassword,
  reauthBody,
  reauthFailure,
  reauthMethod,
  reauthReady,
  type ReauthFailure,
} from "@/lib/reauth";

export interface ReauthAction {
  /** true / false when the user payload or a refusal said, null until then. */
  hasPassword: boolean | null;
  password: string;
  setPassword: (v: string) => void;
  /** The last re-auth refusal, or null. components/ReauthFields.tsx says it. */
  failure: ReauthFailure | null;
  /** The button may be pressed, as far as re-auth goes. */
  ready: boolean;
  /**
   * Run the action with the password (or nothing). Resolves true when it
   * succeeded, false when the server refused it for re-auth (the fields now say
   * why); any OTHER failure is re-thrown for the screen's own copy.
   */
  run: () => Promise<boolean>;
  reset: () => void;
}

export function useReauthAction(
  action: (reauth: { currentPassword?: string }) => Promise<void>,
): ReauthAction {
  const { user } = useAuth();
  // The payload's answer when it has one; otherwise what the last refusal's
  // `method` taught (SEC-2 sends no hasPassword).
  const [learned, setLearned] = useState<boolean | null>(null);
  const hasPassword = accountHasPassword(user) ?? learned;
  const [password, setPassword] = useState("");
  const [failure, setFailure] = useState<ReauthFailure | null>(null);

  const run = async (): Promise<boolean> => {
    setFailure(null);
    try {
      await action(reauthBody(password));
      return true;
    } catch (err) {
      const f = reauthFailure(err);
      if (f === null) throw err;
      const known = learnedHasPassword(f, reauthMethod(err));
      if (known !== null) setLearned(known);
      setFailure(f);
      return false;
    }
  };

  const reset = () => {
    setPassword("");
    setFailure(null);
  };

  return {
    hasPassword,
    password,
    setPassword,
    failure,
    ready: reauthReady(hasPassword, password),
    run,
    reset,
  };
}
