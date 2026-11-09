import * as z from "zod/v4";
import type { Config } from "./config.js";

export type Instructions = string | Record<string, unknown> | unknown[];

export type Question =
  | { type: "choice"; instructions: Instructions; criteria: Record<string, string | null> }
  | { type: "noul"; instructions: Instructions; criteria?: { false: string; true: string } }
  | { type: "score"; instructions: Instructions; criteria: string[] };

export interface DecideRequest {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, Question>;
  images?: string[];
}

const choiceAnswerSchema = z.object({
  type: z.literal("choice"),
  choice: z.string(),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

const noulAnswerSchema = z.object({
  type: z.literal("noul"),
  noul: z.number(),
});

const scoreAnswerSchema = z.object({
  type: z.literal("score"),
  score: z.number(),
  legend: z.record(z.string(), z.string()),
  probabilities: z.record(z.string(), z.number()),
  confidence: z.number(),
});

export const decideResponseSchema = z.object({
  model: z.string(),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [choiceAnswerSchema, noulAnswerSchema, scoreAnswerSchema]),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
  }),
});

export type DecideResponse = z.infer<typeof decideResponseSchema>;
export type Answer = DecideResponse["answers"][string];

export class ClefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClefError";
  }
}

export class ClefApiError extends ClefError {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ClefApiError";
    this.status = status;
  }
}

export class ClefNetworkError extends ClefError {
  constructor(message: string) {
    super(message);
    this.name = "ClefNetworkError";
  }
}

export async function decide(cfg: Config, request: DecideRequest): Promise<DecideResponse> {
  const payload = {
    model: cfg.model,
    state: request.state,
    questions: request.questions,
    ...(request.images ? { images: request.images } : {}),
  };

  const response = await send(cfg, payload);
  const body = await response.text();

  if (!response.ok) {
    throw new ClefApiError(response.status, apiErrorMessage(cfg, response.status, body));
  }

  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new ClefError(`Ollama returned an unexpected response: ${excerpt(body)}`);
  }
  const parsed = decideResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new ClefError(`Ollama returned an unexpected response: ${excerpt(body)}`);
  }
  return parsed.data;
}

async function send(cfg: Config, payload: unknown): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers.Authorization = `Bearer ${cfg.apiKey}`;
  }
  try {
    return await fetch(`${cfg.baseUrl}/v1/systemone`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (error) {
    throw toNetworkError(error, cfg);
  }
}

function toNetworkError(error: unknown, cfg: Config): ClefNetworkError {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new ClefNetworkError(
      `Request to Ollama timed out after ${cfg.timeoutMs} ms. Increase CLEF_TIMEOUT_MS or check that the server is reachable.`,
    );
  }
  const cause = error instanceof Error ? error.message : String(error);
  return new ClefNetworkError(
    `Could not reach Ollama at ${cfg.baseUrl}: ${cause}. Check CLEF_BASE_URL and network connectivity.`,
  );
}

function apiErrorMessage(cfg: Config, status: number, body: string): string {
  const detail = errorDetail(body);
  switch (status) {
    case 400:
      return `Ollama rejected the request (HTTP 400): ${detail}. Check the questions and criteria, and that the state fits in the model context.`;
    case 401:
      return `Ollama returned HTTP 401: ${detail}. The API key is missing or invalid: set CLEF_API_KEY to a valid key from https://ollama.com/settings/keys. For a local Ollama server, run \`ollama signin\`.`;
    case 402:
      return `Ollama returned HTTP 402: ${detail}. The account plan or payment status does not allow this request.`;
    case 404:
      return `Ollama returned HTTP 404: ${detail}. Model "${cfg.model}" may not exist or the path may be wrong. Check CLEF_MODEL; on a local server run \`ollama pull ${cfg.model}\`.`;
    case 413:
      return "Ollama returned HTTP 413: the request is too large. Shorten the state or send fewer or smaller images.";
    case 500:
      return `Ollama failed to score the questions (HTTP 500): ${detail}`;
    default:
      return `Ollama returned HTTP ${status}: ${detail}`;
  }
}

function errorDetail(body: string): string {
  try {
    const data: unknown = JSON.parse(body);
    if (typeof data === "object" && data !== null && "error" in data) {
      const message = (data as { error: unknown }).error;
      if (typeof message === "string") {
        return message;
      }
    }
  } catch {
    return excerpt(body);
  }
  return excerpt(body);
}

function excerpt(body: string): string {
  return body.slice(0, 200);
}
