import fs from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const integrationUrl = process.env.CLEF_INTEGRATION_BASE_URL;
const distReady = fs.existsSync("dist/index.js");

if (integrationUrl !== undefined && integrationUrl !== "" && !distReady) {
  console.warn("Skipping integration tests: dist/index.js is missing; run npm run build first");
}

const shouldRun = integrationUrl !== undefined && integrationUrl !== "" && distReady;

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

let client: Client;

describe.skipIf(!shouldRun)("clef integration against a live server", () => {
  beforeAll(async () => {
    const transport = new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        ...(process.env as Record<string, string>),
        CLEF_BASE_URL: integrationUrl as string,
      },
      stderr: "pipe",
    });
    client = new Client({ name: "integration-harness", version: "0.0.0" });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close().catch(() => {});
  });

  it("decides a refund/urgency example against a live server", async () => {
    const result = await client.callTool({
      name: "decide",
      arguments: {
        state: "Customer: I was charged twice and the checkout page crashes. I want my money back now.",
        questions: {
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
      },
    });

    expect(result.isError).toBeUndefined();

    const structured = result.structuredContent as {
      answers: {
        refund: { type: string; noul: number };
        urgency: { type: string; score: number; legend: Record<string, string> };
      };
      usage: { input_tokens: number };
    };

    expect(structured.answers.refund.type).toBe("noul");
    expect(structured.answers.refund.noul).toBeGreaterThanOrEqual(0);
    expect(structured.answers.refund.noul).toBeLessThanOrEqual(1);
    expect(structured.answers.urgency.type).toBe("score");
    expect(structured.answers.urgency.score).toBeGreaterThanOrEqual(0);
    expect(structured.answers.urgency.score).toBeLessThanOrEqual(2);
    expect(Object.keys(structured.answers.urgency.legend)).toEqual(["0", "1", "2"]);
    expect(structured.usage.input_tokens).toBeGreaterThan(0);
  });
});
