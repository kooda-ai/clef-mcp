import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import {
  ClefApiError,
  ClefError,
  ClefNetworkError,
  decide,
  type DecideRequest,
} from "../src/systemone.js";

const cfg: Config = {
  baseUrl: "http://example.test/ollama",
  apiKey: "secret-key-123",
  model: "clef",
  timeoutMs: 1000,
};

const request: DecideRequest = {
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

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[0];
  if (!call) {
    throw new Error("fetch was not called");
  }
  return { url: String(call[0]), init: call[1] ?? {} };
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("decide", () => {
  it("posts to {base}/v1/systemone with the configured model and JSON body", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    await decide(cfg, request);
    const { url, init } = lastCall();
    expect(url).toBe("http://example.test/ollama/v1/systemone");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "clef",
      state: request.state,
      questions: request.questions,
    });
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).not.toHaveProperty("images");
    expect(body).not.toHaveProperty("keep_alive");
  });

  it("forwards images when provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    await decide(cfg, { ...request, images: ["aGVsbG8=", "d29ybGQ="] });
    const body = JSON.parse(lastCall().init.body as string) as Record<string, unknown>;
    expect(body.images).toEqual(["aGVsbG8=", "d29ybGQ="]);
  });

  it("sends Authorization Bearer only when apiKey is set", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    await decide(cfg, request);
    expect((lastCall().init.headers as Record<string, string>).Authorization).toBe(
      "Bearer secret-key-123",
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    const { apiKey: _apiKey, ...noKey } = cfg;
    await decide(noKey, request);
    expect(lastCall().init.headers as Record<string, string>).not.toHaveProperty("Authorization");
  });

  it("returns the parsed response for HTTP 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(successBody));
    await expect(decide(cfg, request)).resolves.toEqual(successBody);
  });

  it.each([
    [400, ["HTTP 400", "boom-400", "context"]],
    [401, ["HTTP 401", "CLEF_API_KEY"]],
    [402, ["HTTP 402", "boom-402", "plan"]],
    [404, ["HTTP 404", "clef", "ollama pull clef"]],
    [413, ["HTTP 413", "too large"]],
    [500, ["HTTP 500", "boom-500"]],
  ])("maps upstream error status %i to ClefApiError", async (status, parts) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: `boom-${status}` }, { status }));
    const error = await decide(cfg, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClefApiError);
    expect((error as ClefApiError).status).toBe(status);
    for (const part of parts) {
      expect((error as ClefApiError).message).toContain(part);
    }
  });

  it("uses a body excerpt when the error body is not JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>Bad Gateway</html>", { status: 502 }));
    const error = await decide(cfg, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClefApiError);
    expect((error as ClefApiError).message).toBe(
      "Ollama returned HTTP 502: <html>Bad Gateway</html>",
    );
  });

  it.each([["nope"], [JSON.stringify({ answers: "x" })]])(
    "throws ClefError for a 200 with a non-JSON or wrong-shaped body (%s)",
    async (body) => {
      fetchMock.mockResolvedValueOnce(new Response(body, { status: 200 }));
      const error = await decide(cfg, request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ClefError);
      expect((error as ClefError).message).toContain("unexpected response");
    },
  );

  it("maps a timeout to ClefNetworkError mentioning CLEF_TIMEOUT_MS", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("t", "TimeoutError"));
    const error = await decide(cfg, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClefNetworkError);
    expect((error as ClefNetworkError).message).toContain("1000 ms");
    expect((error as ClefNetworkError).message).toContain("CLEF_TIMEOUT_MS");
  });

  it("maps a connection failure to ClefNetworkError mentioning CLEF_BASE_URL", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    const error = await decide(cfg, request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ClefNetworkError);
    expect((error as ClefNetworkError).message).toContain("CLEF_BASE_URL");
  });

  it("never includes the API key in error messages", async () => {
    const messages: string[] = [];

    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "bad key" }, { status: 401 }));
    messages.push(((await decide(cfg, request).catch((e: unknown) => e)) as Error).message);

    fetchMock.mockRejectedValueOnce(new DOMException("t", "TimeoutError"));
    messages.push(((await decide(cfg, request).catch((e: unknown) => e)) as Error).message);

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    messages.push(((await decide(cfg, request).catch((e: unknown) => e)) as Error).message);

    expect(messages).toHaveLength(3);
    for (const message of messages) {
      expect(message).not.toContain("secret-key-123");
    }
  });
});
