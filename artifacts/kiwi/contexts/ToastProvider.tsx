import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { Toast, TOAST_DEFAULT_DURATION_MS } from "@/components/Toast";

// WS9 3d Part 3b-2 — the app-level toast host. A single toast lives ABOVE the
// navigator (mounted once in _layout), so a toast shown right before a route
// change survives the transition and its timer keeps running — that is what lets
// Compost navigate back to the plans list immediately while the Undo window
// keeps ticking, and why backing out no longer cancels a pending compost.
//
// Exactly one toast at a time. onAction (Undo) and onDismiss (timed out OR
// flushed by a newer toast) are separate one-shot callbacks — a deferred-
// destructive caller reads onDismiss as "commit". Starting a second toast while
// one is pending COMMITS the first immediately (its onDismiss fires) rather than
// silently dropping it. No cross-session persistence: if the app is killed
// inside the window the pending action simply never fires (safe — no data loss).

export interface ToastOptions {
  message: string;
  /** Undo variant: supply BOTH actionLabel and onAction. */
  actionLabel?: string;
  onAction?: () => void;
  /** Fired when the toast auto-dismisses (timeout) OR is flushed by a newer
   *  toast — i.e. dismissed WITHOUT the action. The "commit" hook for a
   *  deferred-destructive caller. Never fired when onAction fires. */
  onDismiss?: () => void;
  durationMs?: number;
}

interface ToastContextValue {
  showToast: (opts: ToastOptions) => void;
  hideToast: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return ctx;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [current, setCurrent] = useState<
    (ToastOptions & { key: number }) | null
  >(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The active toast's callbacks + a settled latch so exactly one of
  // onAction/onDismiss fires per showing.
  const activeRef = useRef<ToastOptions | null>(null);
  const settledRef = useRef(true);
  const keyRef = useRef(0);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  // Settle the ACTIVE toast exactly once. "dismiss" → onDismiss (commit);
  // "action" → onAction (undo).
  const settle = useCallback((reason: "dismiss" | "action") => {
    if (settledRef.current) return;
    settledRef.current = true;
    clearTimer();
    const active = activeRef.current;
    activeRef.current = null;
    if (!active) return;
    if (reason === "action") active.onAction?.();
    else active.onDismiss?.();
  }, []);

  const showToast = useCallback(
    (opts: ToastOptions) => {
      // Flush any pending prior toast as a commit before opening a new window.
      settle("dismiss");
      settledRef.current = false;
      activeRef.current = opts;
      const key = ++keyRef.current;
      setCurrent({ ...opts, key });
      clearTimer();
      timerRef.current = setTimeout(() => {
        setCurrent(null);
        settle("dismiss");
      }, opts.durationMs ?? TOAST_DEFAULT_DURATION_MS);
    },
    [settle],
  );

  const hideToast = useCallback(() => {
    setCurrent(null);
    settle("dismiss");
  }, [settle]);

  const onActionPress = useCallback(() => {
    setCurrent(null);
    settle("action");
  }, [settle]);

  useEffect(() => () => clearTimer(), []);

  return (
    <ToastContext.Provider value={{ showToast, hideToast }}>
      {children}
      {current && (
        <Toast
          key={current.key}
          message={current.message}
          actionLabel={current.actionLabel}
          onAction={
            current.actionLabel && current.onAction ? onActionPress : undefined
          }
        />
      )}
    </ToastContext.Provider>
  );
}
