import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { loadConfig } from "../src/config.js";
import { DECIDE_DESCRIPTION, SERVER_INSTRUCTIONS, createServer } from "../src/tools.js";

const cfg = loadConfig({
  CLEF_BASE_URL: "http://example.test",
  CLEF_API_KEY: "secret-key-123",
  CLEF_MODEL: "clef",
  CLEF_TIMEOUT_MS: "1000",
});

const validQuestions = {
  label: {
    type: "choice",
    instructions: "Classify the ticket",
    criteria: { billing: "Charges", bug: "Defects", account: null },
  },
  refund: { type: "noul", instructions: "Does the customer ask for a refund?" },
  urgency: {
    type: "score",
    instructions: "How urgent is it?",
    criteria: [
      "Routine: no time pressure",
      "Soon: a customer is inconvenienced",
      "Immediate: a critical service is unavailable",
    ],
  },
};

const validArgs = {
  state: "Customer: I was charged twice and the checkout page crashes.",
  questions: validQuestions,
};

const successBody = {
  model: "clef",
  answers: {
    label: {
      type: "choice",
      choice: "bug",
      probabilities: { billing: 0.0125, bug: 0.9781, account: 0.0093 },
      confidence: 0.8906,
    },
    refund: { type: "noul", noul: 0.97 },
    urgency: {
      type: "score",
      score: 1.84,
      legend: {
        "0": "Routine: no time pressure",
        "1": "Soon: a customer is inconvenienced",
        "2": "Immediate: a critical service is unavailable",
      },
      probabilities: { "0": 0.02, "1": 0.12, "2": 0.86 },
      confidence: 0.71,
    },
  },
  usage: { input_tokens: 174, output_tokens: 1 },
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

function forwardedBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("fetch was not called");
  }
  return JSON.parse(String(call[1]?.body)) as Record<string, unknown>;
}

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

function resultText(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function decideCall(args: Record<string, unknown>): Promise<CallToolResult> {
  return client.callTool({ name: "decide", arguments: args });
}

function manyChoiceCriteria(count: number): Record<string, string> {
  return Object.fromEntries(Array.from({ length: count }, (_, i) => [`label${i}`, `desc ${i}`]));
}

function manyQuestions(count: number): Record<string, unknown> {
  return Object.fromEntries(
    Array.from({ length: count }, (_, i) => [`q${i}`, { type: "noul", instructions: "Is it?" }]),
  );
}

let client: Client;
let server: McpServer;

beforeEach(async () => {
  vi.stubGlobal("fetch", fetchMock);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.1" });
  server = createServer(cfg);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterEach(async () => {
  await client.close();
  await server.close();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("clef-mcp decide tool", () => {
  it("lists exactly one tool named decide with English description and annotations", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(["decide"]);
    const tool = tools[0];
    expect(tool?.description).toBe(DECIDE_DESCRIPTION);
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    expect(tool?.inputSchema.properties).not.toHaveProperty("model");
    expect(tool?.outputSchema).toBeDefined();
  });

  it("exposes the server instructions", () => {
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
  });

  it("returns structured content and markdown for a successful decision", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));

    const result = await decideCall(validArgs);

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual(successBody);
    const text = resultText(result);
    expect(text).toContain("**label** (choice): bug");
    expect(text).toContain("0.978");
    expect(text).toContain("**refund** (noul): 0.97");
    expect(text).toContain("closest level 2");
    expect(text).toContain("Usage: 174 input tokens");
  });

  it("sends the configured model, never a tool-provided one", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));

    const result = await decideCall({ ...validArgs, model: "other" });

    expect(result.isError).toBeUndefined();
    const body = forwardedBody();
    expect(body.model).toBe("clef");
    expect(JSON.stringify(body)).not.toContain("other");
  });

  it("accepts choice criteria with null descriptions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    const questions = {
      label: {
        type: "choice",
        instructions: "Label",
        criteria: { bug: null, billing: "Charges" },
      },
    };

    const result = await decideCall({ state: "text", questions });

    expect(result.isError).toBeUndefined();
    expect(forwardedBody().questions).toEqual(questions);
  });

  it("accepts noul without criteria and object/array instructions and state", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    const args = {
      state: { ticket: { id: 1, body: "charged twice" } },
      questions: {
        refund: { type: "noul", instructions: { ask: "refund?", hints: ["money"] } },
        other: { type: "noul", instructions: ["Is it", "urgent?"] },
      },
    };

    const result = await decideCall(args);

    expect(result.isError).toBeUndefined();
    const body = forwardedBody();
    expect(body.state).toEqual(args.state);
    expect(body.questions).toEqual(args.questions);
  });

  it.each([
    ["empty questions", { state: "text", questions: {} }],
    ["65 questions", { state: "text", questions: manyQuestions(65) }],
    [
      "question name with a space",
      { state: "text", questions: { "bad name": { type: "noul", instructions: "Is it?" } } },
    ],
    [
      "101-character question name",
      { state: "text", questions: { [`a${"b".repeat(100)}`]: { type: "noul", instructions: "Is it?" } } },
    ],
    [
      "choice with 1 criterion",
      { state: "text", questions: { q: { type: "choice", instructions: "x", criteria: { a: "A" } } } },
    ],
    [
      "choice with 27 criteria",
      {
        state: "text",
        questions: { q: { type: "choice", instructions: "x", criteria: manyChoiceCriteria(27) } },
      },
    ],
    ["choice without criteria", { state: "text", questions: { q: { type: "choice", instructions: "x" } } }],
    [
      "score with 1 level",
      { state: "text", questions: { q: { type: "score", instructions: "x", criteria: ["only"] } } },
    ],
    [
      "score with 11 levels",
      {
        state: "text",
        questions: {
          q: { type: "score", instructions: "x", criteria: Array.from({ length: 11 }, (_, i) => `l${i}`) },
        },
      },
    ],
    [
      "score with object criteria",
      {
        state: "text",
        questions: { q: { type: "score", instructions: "x", criteria: { a: "A", b: "B" } } },
      },
    ],
    [
      "noul criteria with an extra key",
      {
        state: "text",
        questions: {
          q: { type: "noul", instructions: "x", criteria: { false: "a", true: "b", maybe: "c" } },
        },
      },
    ],
    [
      "unknown question type",
      { state: "text", questions: { q: { type: "rank", instructions: "x" } } },
    ],
    ["blank state", { state: "   ", questions: validQuestions }],
    ["missing state", { questions: validQuestions }],
    ["5 images", { ...validArgs, images: ["QUJD", "QUJD", "QUJD", "QUJD", "QUJD"] }],
  ])("rejects invalid inputs before calling fetch: %s", async (_label, args) => {
    const result = await decideCall(args);

    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["data URL", ["data:image/png;base64,iVBOR"]],
    ["http URL", ["https://x.test/a.png"]],
  ])("rejects %s images before calling fetch", async (_label, images) => {
    const result = await decideCall({ ...validArgs, images });

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("base64");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("surfaces an upstream 404 as an error result with the ollama pull hint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "model not found" }, { status: 404 }));

    const result = await decideCall(validArgs);

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("ollama pull clef");
  });
});
