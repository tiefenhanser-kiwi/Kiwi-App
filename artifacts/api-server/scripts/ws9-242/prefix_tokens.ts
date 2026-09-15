// D-WS9-242 lane — count_tokens for the two store prefixes (system-only, baseline-subtracted).
//   node --env-file=.env --import tsx scripts/ws9-242/prefix_tokens.ts
import Anthropic from "@anthropic-ai/sdk";
import { STABLE_FINALIZE_PREFIX, STABLE_GENERATE_PREFIX } from "../../src/lib/storeFillPrompts";
const MODEL = "claude-sonnet-4-6";
const client = new Anthropic();
const count = async (system?: string) => (await client.messages.countTokens({ model: MODEL, messages: [{ role: "user", content: "x" }], ...(system ? { system: [{ type: "text", text: system }] } : {}) })).input_tokens;
const base = await count();
const gen = await count(STABLE_GENERATE_PREFIX);
const fin = await count(STABLE_FINALIZE_PREFIX);
console.log(`model=${MODEL} · baseline=${base} · STABLE_GENERATE_PREFIX=${gen - base} tok · STABLE_FINALIZE_PREFIX=${fin - base} tok · chars gen=${STABLE_GENERATE_PREFIX.length} fin=${STABLE_FINALIZE_PREFIX.length}`);
