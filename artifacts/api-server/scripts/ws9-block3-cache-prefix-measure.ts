// Plan-Gen Arc · Block 3 — cache-prefix measurement gate.
// Measures the actual token count of the harness's stable finalize prefix
// against the real model (claude-sonnet-4-6) so we know it clears the 2048-token
// prompt-cache floor with genuine margin. Read-only; makes one count_tokens call.
//
//   node --env-file=.env --import tsx scripts/ws9-block3-cache-prefix-measure.ts

import Anthropic from "@anthropic-ai/sdk";

import {
  PREFERENCE_CONTRACT_PREAMBLE,
  STABLE_FINALIZE_PREFIX,
  STABLE_GENERATE_PREFIX,
} from "../src/lib/storeFillPrompts";

const MODEL = "claude-sonnet-4-6";
const FLOOR = 2048; // Sonnet 4.6 prompt-cache minimum cacheable prefix.

async function countTokens(client: Anthropic, text: string): Promise<number> {
  const res = await client.messages.countTokens({
    model: MODEL,
    messages: [{ role: "user", content: text }],
  });
  return res.input_tokens;
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY not set — cannot measure. Aborting.");
    process.exit(1);
  }
  const client = new Anthropic();

  const [preambleTok, finalizeTok, generateTok] = await Promise.all([
    countTokens(client, PREFERENCE_CONTRACT_PREAMBLE),
    countTokens(client, STABLE_FINALIZE_PREFIX),
    countTokens(client, STABLE_GENERATE_PREFIX),
  ]);

  const pct = (t: number) => (((t - FLOOR) / FLOOR) * 100).toFixed(1);
  console.log(`model:                        ${MODEL}`);
  console.log(`cache floor:                  ${FLOOR} tokens`);
  console.log("");
  console.log(`preference preamble alone:    ${preambleTok} tokens`);
  console.log(
    `STABLE_FINALIZE_PREFIX total: ${finalizeTok} tokens  → clears? ${finalizeTok >= FLOOR ? "YES" : "NO"} (margin ${pct(finalizeTok)}%)`,
  );
  console.log(
    `STABLE_GENERATE_PREFIX total: ${generateTok} tokens  → clears? ${generateTok >= FLOOR ? "YES" : "NO"} (margin ${pct(generateTok)}%)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
