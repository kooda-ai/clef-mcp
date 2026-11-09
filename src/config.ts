export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface Config {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
}

const DEFAULT_BASE_URL = "https://ollama.com";
const DEFAULT_MODEL = "clef";
const DEFAULT_TIMEOUT_MS = 60000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.CLEF_BASE_URL;
  const urlText =
    rawUrl === undefined || rawUrl.trim() === "" ? DEFAULT_BASE_URL : rawUrl.trim();

  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch {
    throw new ConfigError(
      `CLEF_BASE_URL is not a valid URL: ${urlText}. It must be an absolute http(s) URL, e.g. http://localhost:11434. See README.md.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ConfigError(
      `CLEF_BASE_URL must use http or https, got: ${urlText}. See README.md.`,
    );
  }
  const baseUrl = urlText.replace(/\/+$/, "");

  const apiKey = env.CLEF_API_KEY?.trim();
  const hostname = parsed.hostname;
  const requiresKey = hostname === "ollama.com" || hostname.endsWith(".ollama.com");
  if (requiresKey && !apiKey) {
    throw new ConfigError(
      "CLEF_API_KEY is required when CLEF_BASE_URL points to Ollama Cloud (ollama.com). Create a key at https://ollama.com/settings/keys, or point CLEF_BASE_URL at a local Ollama server such as http://localhost:11434. See README.md.",
    );
  }

  const model = env.CLEF_MODEL?.trim() || DEFAULT_MODEL;

  const timeoutMs = parseEnvInteger(env.CLEF_TIMEOUT_MS, "CLEF_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  if (timeoutMs < 1) {
    throw new ConfigError(
      `CLEF_TIMEOUT_MS must be a positive integer, got: ${env.CLEF_TIMEOUT_MS}`,
    );
  }

  const config: Config = { baseUrl, model, timeoutMs };
  if (apiKey) {
    config.apiKey = apiKey;
  }
  return config;
}

function parseEnvInteger(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new ConfigError(`${name} must be an integer, got: ${value}`);
  }
  return parsed;
}
