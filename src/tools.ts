import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { Config } from "./config.js";
import { ClefError, decide, decideResponseSchema } from "./systemone.js";
import type { DecideRequest, DecideResponse } from "./systemone.js";

export const SERVER_INSTRUCTIONS =
  "clef-mcp exposes one tool, decide, backed by Ollama's /v1/systemone decision endpoint. Use it when you need a fast, probability-calibrated judgement about a piece of text, JSON data, or images: pick one label (choice), estimate how likely a yes/no statement is true (noul), or grade on an ordered scale (score). Batch every question about the same state into one call. The model is fixed by the server configuration and cannot be chosen per call.";

export const DECIDE_DESCRIPTION = `Ask an Ollama decision model to answer one or more structured questions about a state, in a single call. Answers are probabilities, never free text, so you can threshold them.

Inputs:
- state: what to judge. Non-empty text, or a JSON object or array (sent as JSON text).
- questions: map of question name to question. 1 to 64 questions. Names are 1-100 characters of ASCII letters, digits, "_", "." or "-".
- images (optional): up to 4 images as raw base64 strings (no data: URLs, no http URLs).

Every question has a type, instructions (text, or a JSON object or array, explaining what to decide) and criteria:
- choice: pick exactly one label. criteria is required: an object mapping 2-26 label keys to a description string or null. Answer: choice (the winning key), probabilities (one per key, summing to 1) and confidence (0-1).
- noul: a yes/no judgement. criteria is optional: exactly {"false": "...", "true": "..."} describing each side. Answer: noul, the probability from 0 to 1 that the statement is true. It is not a boolean and has no confidence field.
- score: place the state on an ordered scale. criteria is required: an array of 2-10 level descriptions ordered from lowest to highest. Answer: score, the probability-weighted mean of the zero-based level index (for example 1.84 on a 0-2 scale; not rounded), legend (index to description), probabilities (per index) and confidence (0-1).

Use it for classification, routing, triage, moderation and rubric grading. Do not use it to generate text.`;

const instructionsSchema = z.union([
  z.string().trim().min(1),
  z.record(z.string(), z.unknown()),
  z.array(z.unknown()),
]);

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z
      .record(z.string().trim().min(1), z.string().nullable())
      .refine((criteria) => {
        const count = Object.keys(criteria).length;
        return count >= 2 && count <= 26;
      }, "Choice criteria need between 2 and 26 entries"),
  }),
  z.object({
    type: z.literal("noul"),
    instructions: instructionsSchema,
    criteria: z.object({ false: z.string(), true: z.string() }).strict().optional(),
  }),
  z.object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    criteria: z.array(z.string().trim().min(1)).min(2).max(10),
  }),
]);

const inputSchema = z.object({
  state: z
    .union([
      z.string().trim().min(1),
      z.record(z.string(), z.unknown()),
      z.array(z.unknown()).min(1),
    ])
    .describe("The input to judge: non-empty text, or a JSON object or array (sent as JSON text)."),
  questions: z
    .record(z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/), questionSchema)
    .refine((questions) => {
      const count = Object.keys(questions).length;
      return count >= 1 && count <= 64;
    }, "Provide between 1 and 64 questions"),
  images: z
    .array(
      z
        .string()
        .regex(/^[A-Za-z0-9+/]+={0,2}$/, "Images must be raw base64 strings, not data: URLs or http URLs"),
    )
    .min(1)
    .max(4)
    .optional(),
});

export function createServer(cfg: Config): McpServer {
  const server = new McpServer(
    { name: "clef-mcp", version: "0.1.0" },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "decide",
    {
      title: "Decide",
      description: DECIDE_DESCRIPTION,
      inputSchema,
      outputSchema: decideResponseSchema,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const request: DecideRequest = {
          state: args.state,
          questions: args.questions as DecideRequest["questions"],
        };
        if (args.images !== undefined) {
          request.images = args.images;
        }
        const result = await decide(cfg, request);
        return {
          content: [{ type: "text" as const, text: renderDecisionMarkdown(result) }],
          structuredContent: result,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: errorMessage(error) }],
          isError: true,
        };
      }
    },
  );

  return server;
}

function errorMessage(error: unknown): string {
  if (error instanceof ClefError) {
    return error.message;
  }
  if (error instanceof Error) {
    return `Unexpected error while contacting Ollama: ${error.message}`;
  }
  return "Unexpected error while contacting Ollama";
}

function round(value: number): number {
  return Number(value.toFixed(3));
}

export function renderDecisionMarkdown(result: DecideResponse): string {
  const lines: string[] = [];

  for (const [name, answer] of Object.entries(result.answers)) {
    if (answer.type === "choice") {
      const probabilities = Object.entries(answer.probabilities)
        .sort((a, b) => b[1] - a[1])
        .map(([label, probability]) => `${label} ${round(probability)}`)
        .join(", ");
      lines.push(`**${name}** (choice): ${answer.choice}, confidence ${round(answer.confidence)}`);
      lines.push(`  probabilities: ${probabilities}`);
    } else if (answer.type === "noul") {
      lines.push(`**${name}** (noul): ${round(answer.noul)} probability that the statement is true`);
    } else {
      const maxIndex = Math.max(Object.keys(answer.legend).length - 1, 0);
      const closest = Math.min(Math.max(Math.round(answer.score), 0), maxIndex);
      lines.push(
        `**${name}** (score): ${round(answer.score)} on a 0-${maxIndex} scale, closest level ${closest} "${answer.legend[String(closest)] ?? ""}", confidence ${round(answer.confidence)}`,
      );
    }
  }

  lines.push(
    `Usage: ${result.usage.input_tokens} input tokens, ${result.usage.output_tokens} output tokens`,
  );
  return lines.join("\n");
}
