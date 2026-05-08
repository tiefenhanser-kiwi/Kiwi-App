// WS6 AI orchestrator — tool_use vs text+Zod mode helpers.
// Per kiwi_ws6_plan.md §4 (Hybrid mode = locked decision).

import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export type AICallMode = "tool" | "text";

// Constants
const TOOL_NAME = "kiwi_response";

// Strip markdown code fences from a model's text response.
// Tolerates ```json...```, ```...```, leading/trailing whitespace.
export function stripFences(s: string): string {
  return s
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

// Build the tools[] array for tool_use mode.
// One tool per call, forced via tool_choice.
export function buildToolForSchema(
  schema: z.ZodTypeAny,
  description: string,
): Anthropic.Tool[] {
  const inputSchema = zodToJsonSchema(schema, {
    name: TOOL_NAME,
    target: "openApi3",
    $refStrategy: "none",
  }) as Record<string, unknown>;

  // zod-to-json-schema with `name` wraps under `definitions`. Unwrap.
  const def = (inputSchema.definitions as Record<string, unknown> | undefined)
    ?.[TOOL_NAME] as Record<string, unknown> | undefined;
  const finalSchema = def ?? inputSchema;

  // Anthropic tools expect input_schema.type === "object".
  return [
    {
      name: TOOL_NAME,
      description,
      input_schema: finalSchema as unknown as Anthropic.Tool.InputSchema,
    },
  ];
}

export function forcedToolChoice(): Anthropic.ToolChoiceTool {
  return { type: "tool", name: TOOL_NAME };
}

// For text mode: append a JSON-only instruction to the prompt body.
// Caller is responsible for prompt engineering; this is a default suffix
// that callers can override by setting a custom textModeSuffix in opts.
export function defaultTextModeSuffix(): string {
  return [
    "",
    "Respond with ONLY a single valid JSON object that satisfies the requested shape.",
    "Do not wrap the JSON in markdown code fences. Do not add commentary before or after.",
  ].join("\n");
}

// Extract the parsed payload from an Anthropic Messages response based on mode.
// Returns the raw JS value (not yet Zod-validated).
export function extractPayload(
  message: Anthropic.Message,
  mode: AICallMode,
): { ok: true; value: unknown } | { ok: false; reason: "parse_failed"; raw: string } {
  if (mode === "tool") {
    const block = message.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      return { ok: false, reason: "parse_failed", raw: JSON.stringify(message.content) };
    }
    return { ok: true, value: block.input };
  }
  // text mode
  const block = message.content.find((b) => b.type === "text");
  const text = block && block.type === "text" ? block.text : "";
  const cleaned = stripFences(text);
  try {
    return { ok: true, value: JSON.parse(cleaned) };
  } catch {
    return { ok: false, reason: "parse_failed", raw: cleaned };
  }
}
