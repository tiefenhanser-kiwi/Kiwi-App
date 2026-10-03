// Sonnet 5.5 side-by-side · P0 — does the API accept Kiwi's request shapes on
// claude-sonnet-5-5 via @anthropic-ai/sdk 0.90.0? Five tiny calls, no DB.
// Run: node --env-file=.env --import tsx scripts/_scratch/sonnet55/p0-accept.ts
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();
const M = "claude-sonnet-5-5";
const tool = {
  name: "emit",
  description: "Emit the answer.",
  input_schema: {
    type: "object" as const,
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
};
const msg = [{ role: "user" as const, content: "Name one herb. Use the emit tool." }];

async function probe(label: string, params: Record<string, unknown>) {
  const t0 = Date.now();
  try {
    const r = (await client.messages.create({
      model: M,
      max_tokens: 1024,
      messages: msg,
      ...params,
    } as Anthropic.MessageCreateParamsNonStreaming)) as Anthropic.Message;
    console.log(
      `OK   ${label} · ${Date.now() - t0}ms · model=${r.model} stop=${r.stop_reason}` +
        ` blocks=${r.content.map((b) => b.type).join(",")} in=${r.usage.input_tokens} out=${r.usage.output_tokens}`,
    );
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.log(`FAIL ${label} · ${err.status} ${String(err.message).slice(0, 200)}`);
  }
}

await probe("plain (no temperature, no tools)", {});
await probe("temperature 0.7 (Kiwi default)", { temperature: 0.7 });
await probe("forced tool_choice {type:tool} (Kiwi tool mode)", {
  tools: [tool],
  tool_choice: { type: "tool", name: "emit" },
});
await probe("tool_choice auto, adaptive (default)", { tools: [tool], tool_choice: { type: "auto" } });
await probe("tool_choice auto, thinking between_tools", {
  tools: [tool],
  tool_choice: { type: "auto" },
  thinking: { type: "between_tools" },
});
