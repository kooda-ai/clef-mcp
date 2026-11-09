import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("applies defaults when nothing but the key is set", () => {
    const cfg = loadConfig({ CLEF_API_KEY: "k" });
    expect(cfg).toEqual({ baseUrl: "https://ollama.com", apiKey: "k", model: "clef", timeoutMs: 60000 });
  });

  it("throws ConfigError mentioning CLEF_API_KEY when the host is ollama.com and no key is set", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/CLEF_API_KEY/);
    expect(() => loadConfig({ CLEF_BASE_URL: "https://api.ollama.com", CLEF_API_KEY: "  " })).toThrow(ConfigError);
  });

  it("allows a local base URL without a key", () => {
    const cfg = loadConfig({ CLEF_BASE_URL: "http://localhost:11434" });
    expect(cfg.apiKey).toBeUndefined();
    expect("apiKey" in cfg).toBe(false);
  });

  it("normalizes trailing slashes and keeps a path prefix", () => {
    expect(loadConfig({ CLEF_BASE_URL: "http://localhost:11434/" }).baseUrl).toBe("http://localhost:11434");
    expect(loadConfig({ CLEF_BASE_URL: "http://host:8080/ollama//" }).baseUrl).toBe("http://host:8080/ollama");
  });

  it("throws ConfigError for an invalid or non-http CLEF_BASE_URL", () => {
    for (const bad of ["not-a-url", "http://[::1", "ftp://example.com"]) {
      expect(() => loadConfig({ CLEF_BASE_URL: bad })).toThrow(ConfigError);
    }
  });

  it("uses CLEF_MODEL when set and falls back to clef when blank", () => {
    expect(loadConfig({ CLEF_BASE_URL: "http://localhost:11434", CLEF_MODEL: " clef:cloud " }).model).toBe("clef:cloud");
    expect(loadConfig({ CLEF_BASE_URL: "http://localhost:11434", CLEF_MODEL: "" }).model).toBe("clef");
  });

  it("parses CLEF_TIMEOUT_MS and rejects non-positive or non-integer values", () => {
    const local = { CLEF_BASE_URL: "http://localhost:11434" };
    expect(loadConfig({ ...local, CLEF_TIMEOUT_MS: "2500" }).timeoutMs).toBe(2500);
    for (const bad of ["0", "-5", "fast", "1.5"]) {
      expect(() => loadConfig({ ...local, CLEF_TIMEOUT_MS: bad })).toThrow(ConfigError);
    }
  });

  it("never includes the API key in ConfigError messages", () => {
    try {
      loadConfig({ CLEF_API_KEY: "secret-key-123", CLEF_TIMEOUT_MS: "x" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-key-123");
    }
    expect.assertions(1);
  });
});
