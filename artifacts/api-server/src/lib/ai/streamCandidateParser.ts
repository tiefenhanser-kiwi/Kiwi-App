// Latency Block (D-WS9-076) — progressive-render partial-JSON scanner.
//
// tool_use output streams as `input_json_delta` — a growing, generally-invalid
// JSON string. To render candidate cards as they arrive we must extract ONLY
// the candidates that have been FULLY received, never a half-built trailing
// object (a half-drawn card is worse than waiting).
//
// The completeness guarantee is structural, not heuristic: a candidate object
// is returned only once its closing `}` has been seen at array depth. JSON
// grammar forbids adding keys to a closed object — the next token after `}`
// can only be `,` or `]` — so a brace-balanced (string/escape-aware) object is
// definitively complete and cannot change. The caller still runs the real
// WizardPlanCandidateSchema over each returned object before rendering, so a
// structurally-complete-but-semantically-wrong object is caught there too.
//
// Pure + dependency-free so the every-offset fuzz test (streamCandidateParser
// .test.ts) can hammer it: feed a real response truncated at each byte offset
// and assert it never surfaces an object that hasn't structurally closed.

/**
 * Returns the candidate objects that are fully present in `partialJson` — the
 * accumulated tool_use input string for a `{ candidates: [...], ... }` result.
 * Order-preserving. Never returns a partially-received trailing object; returns
 * [] when the `candidates` array hasn't started yet or its key isn't received.
 *
 * Each element is JSON.parsed but NOT schema-validated — the caller applies
 * WizardPlanCandidateSchema and decides what to emit.
 */
export function extractCompleteCandidates(partialJson: string): unknown[] {
  const arrStart = findCandidatesArrayStart(partialJson);
  if (arrStart < 0) return [];
  const out: unknown[] = [];
  for (const raw of scanCompleteObjects(partialJson, arrStart)) {
    try {
      out.push(JSON.parse(raw));
    } catch {
      // A brace-balanced slice that fails JSON.parse shouldn't occur for
      // well-formed model output; stop rather than throw mid-stream. The
      // final buffered parse in the orchestrator is the backstop.
      break;
    }
  }
  return out;
}

// Locate the content-start index (just past `[`) of the top-level `candidates`
// array. Tolerates keys emitted before `candidates`; returns -1 while the key
// or its opening `[` has not yet been received.
function findCandidatesArrayStart(s: string): number {
  const n = s.length;
  let i = 0;
  while (i < n && s[i] !== "{") i++;
  if (i >= n) return -1;
  i++; // past the root `{`
  while (i < n) {
    while (i < n && isWsOrComma(s[i])) i++;
    if (i >= n) return -1;
    if (s[i] === "}") return -1; // root object closed with no candidates key
    if (s[i] !== '"') return -1; // malformed or key not yet arrived
    const key = readString(s, i);
    if (!key.complete) return -1; // key still streaming
    i = key.end;
    while (i < n && isWs(s[i])) i++;
    if (i >= n || s[i] !== ":") return -1;
    i++; // past `:`
    while (i < n && isWs(s[i])) i++;
    if (i >= n) return -1;
    if (key.value === "candidates") {
      return s[i] === "[" ? i + 1 : -1;
    }
    const end = skipValue(s, i);
    if (end < 0) return -1; // a value before `candidates` is still streaming
    i = end;
  }
  return -1;
}

// From the array content start, collect each fully-closed `{...}` element until
// the array closes (`]`) or a trailing element is still streaming.
function scanCompleteObjects(s: string, from: number): string[] {
  const out: string[] = [];
  const n = s.length;
  let i = from;
  while (i < n) {
    while (i < n && isWsOrComma(s[i])) i++;
    if (i >= n) break;
    if (s[i] === "]") break; // array closed
    if (s[i] !== "{") break; // unexpected token / not an object
    const end = skipValue(s, i);
    if (end < 0) break; // trailing object still streaming
    out.push(s.slice(i, end));
    i = end;
  }
  return out;
}

// Returns the index just past a complete JSON value starting at `i`, or -1 if
// the value is still streaming. String/escape-aware brace matching for
// objects/arrays; delimiter scan for primitives.
function skipValue(s: string, i: number): number {
  const n = s.length;
  if (i >= n) return -1;
  const c = s[i];
  if (c === '"') {
    const r = readString(s, i);
    return r.complete ? r.end : -1;
  }
  if (c === "{" || c === "[") {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let j = i; j < n; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === "\\") esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === "{" || ch === "[") depth++;
      else if (ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
    }
    return -1; // unbalanced → still streaming
  }
  // primitive: number / true / false / null — read to the next delimiter.
  let j = i;
  while (j < n && !isDelim(s[j])) j++;
  // If we ran to the buffer end, the token may still be growing (e.g. "12" →
  // "123"), so treat as incomplete.
  return j >= n ? -1 : j;
}

// Reads a JSON string starting at s[i] === '"'. `value` is the raw inner text
// (no unescaping — only used for exact key comparison, and JSON keys we care
// about contain no escapes).
function readString(
  s: string,
  i: number,
): { value: string; end: number; complete: boolean } {
  const n = s.length;
  let esc = false;
  let buf = "";
  for (let j = i + 1; j < n; j++) {
    const ch = s[j];
    if (esc) {
      buf += ch;
      esc = false;
      continue;
    }
    if (ch === "\\") {
      buf += ch;
      esc = true;
      continue;
    }
    if (ch === '"') return { value: buf, end: j + 1, complete: true };
    buf += ch;
  }
  return { value: "", end: n, complete: false };
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}
function isWsOrComma(ch: string): boolean {
  return ch === "," || isWs(ch);
}
function isDelim(ch: string): boolean {
  return ch === "," || ch === "]" || ch === "}" || isWs(ch);
}
