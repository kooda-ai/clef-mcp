import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

if (!fs.existsSync("dist/index.js")) {
  throw new Error("dist/index.js not found: run npm run build first (or use npm run test:e2e)");
}

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

type CallToolResult = Awaited<ReturnType<Client["callTool"]>>;

interface RecordedRequest {
  path: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
}

const API_KEY = "e2e-secret";

const validArgs = {
  state: "Customer: I was charged twice and the checkout page crashes.",
  questions: {
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
  },
};

const successBody = {
  model: "clef-test",
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

const requests: RecordedRequest[] = [];
const stderrChunks: string[] = [];
let state: "ok" | "not-found" = "ok";

let mockServer: http.Server;
let client: Client;
let transport: StdioClientTransport;
let childPid: number | null;

function resultText(result: CallToolResult): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function lastRequest(): RecordedRequest {
  const found = requests[requests.length - 1];
  if (found === undefined) {
    throw new Error("mock server never received a request");
  }
  return found;
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("CLEF_")) {
      env[key] = value;
    }
  }
  return env;
}

beforeAll(async () => {
  mockServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {}
      requests.push({
        path: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
      });

      if (req.url !== "/v1/systemone") {
        sendJson(res, 404, { error: "not found" });
        return;
      }
      if (state === "not-found") {
        sendJson(res, 404, { error: "model not found" });
        return;
      }
      sendJson(res, 200, successBody);
    });
  });

  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const { port } = mockServer.address() as AddressInfo;

  transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: {
      ...cleanEnv(),
      CLEF_BASE_URL: `http://127.0.0.1:${port}`,
      CLEF_API_KEY: API_KEY,
      CLEF_MODEL: "clef-test",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk.toString("utf8")));

  client = new Client({ name: "e2e-harness", version: "0.0.0" });
  await client.connect(transport);
  childPid = transport.pid;
});

afterAll(async () => {
  await client.close().catch(() => {});
  mockServer.close();

  if (childPid !== null) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      process.kill(childPid, 0);
      process.kill(childPid, "SIGKILL");
    } catch {}
  }
});

describe("e2e against built dist/index.js with a mock Ollama", () => {
  it("lists exactly the decide tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(["decide"]);
  });

  it("forwards the decision with model, auth header, and body", async () => {
    state = "ok";
    const result = await client.callTool({ name: "decide", arguments: validArgs });

    expect(result.isError).toBeUndefined();

    const request = lastRequest();
    expect(request.path).toBe("/v1/systemone");
    expect(request.method).toBe("POST");
    expect(request.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(request.body.model).toBe("clef-test");
    expect(request.body).not.toHaveProperty("keep_alive");

    const structured = result.structuredContent as {
      answers: { label: { choice: string } };
    };
    expect(structured.answers.label.choice).toBe("bug");
  });

  it("maps upstream 404 to an error result", async () => {
    state = "not-found";
    const result = await client.callTool({ name: "decide", arguments: validArgs });
    state = "ok";

    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain("ollama pull clef-test");
  });

  it("never writes the API key to stderr", () => {
    expect(stderrChunks.join("")).not.toContain(API_KEY);
  });

  it("exits with code 1 and a CLEF_API_KEY message when cloud config lacks a key", () => {
    const run = spawnSync("node", ["dist/index.js"], {
      env: { PATH: process.env.PATH ?? "", CLEF_BASE_URL: "https://ollama.com" },
      timeout: 10_000,
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    expect(run.stderr).toContain("CLEF_API_KEY");
  });
});
