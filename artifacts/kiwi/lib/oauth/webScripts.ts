// Row 9 (1.1) · OAuth Block 2 Part D — loading a provider's own script, once,
// lazily, and only on web.
//
// §2.7 — "Load the two web scripts lazily and only on web." Lazily because
// neither Apple's nor Google's script should be fetched by someone who signs
// in with a password, and only on web because there is no `document` anywhere
// else.
//
// Precedent and shape: components/TurnstileGate.tsx's `ensureScript`. Every
// DOM access is inside a try, including the `globalThis.document` read
// itself — a CSP that refuses the script, or a runtime with no DOM, must
// produce an absent button and not an exception.

const pending = new Map<string, Promise<void>>();

function doc(): Document | null {
  try {
    return (globalThis as { document?: Document }).document ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves when the script has loaded, rejects when it cannot. Cached by id,
 * so two mounted buttons (or a remount) share one fetch and one promise.
 *
 * A REJECTION IS NOT CACHED: a failed load is usually the network, and a
 * second attempt after the user taps again should be allowed to succeed.
 */
export function loadProviderScript(id: string, src: string): Promise<void> {
  const existing = pending.get(id);
  if (existing) return existing;

  const p = new Promise<void>((resolve, reject) => {
    const d = doc();
    if (!d) {
      reject(new Error(`loadProviderScript(${id}): no document`));
      return;
    }
    try {
      const already = d.getElementById(id) as HTMLScriptElement | null;
      if (already) {
        // Present from a previous mount. `dataset.loaded` is ours: a <script>
        // gives no way to ask "did you already fire load?", and attaching a
        // listener to a script that finished would wait forever.
        if (already.dataset.loaded === "1") {
          resolve();
          return;
        }
        already.addEventListener("load", () => resolve(), { once: true });
        already.addEventListener(
          "error",
          () => reject(new Error(`loadProviderScript(${id}): load failed`)),
          { once: true },
        );
        return;
      }
      const el = d.createElement("script");
      el.id = id;
      el.src = src;
      el.async = true;
      el.addEventListener(
        "load",
        () => {
          el.dataset.loaded = "1";
          resolve();
        },
        { once: true },
      );
      el.addEventListener(
        "error",
        () => reject(new Error(`loadProviderScript(${id}): load failed`)),
        { once: true },
      );
      d.head.appendChild(el);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  pending.set(id, p);
  p.catch(() => pending.delete(id));
  return p;
}
