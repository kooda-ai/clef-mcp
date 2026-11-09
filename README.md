# clef-mcp

MCP server (stdio) that exposes Ollama's `POST /v1/systemone` decision endpoint as a single tool, `decide`. Use it when you need a fast, probability-calibrated judgement about a piece of text, JSON data, or images: pick one label (`choice`), estimate how likely a yes/no statement is true (`noul`), or grade on an ordered scale (`score`). Batch every question about the same state into one call. The model is fixed by the server configuration and cannot be chosen per call.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CLEF_BASE_URL` | `https://ollama.com` | Ollama server base URL. |
| `CLEF_API_KEY` | none | Bearer token. Required when the host is `ollama.com` or `*.ollama.com`; optional otherwise. |
| `CLEF_MODEL` | `clef` | Model name sent with every request. |
| `CLEF_TIMEOUT_MS` | `60000` | Request timeout in milliseconds (positive integer). |

Model names:

- `clef` on Ollama Cloud (`https://ollama.com`).
- `clef:cloud` through a local Ollama server that proxies to the cloud.
- `clef` for a locally pulled model.

The API key is never logged or included in error messages or tool output.

## Build

```bash
npm install && npm run build
```

## Claude Code setup

```bash
claude mcp add clef -e CLEF_API_KEY=your-key -e CLEF_MODEL=clef -- node /absolute/path/to/clef-mcp/dist/index.js
```

Or in `.mcp.json`:

```json
{
  "mcpServers": {
    "clef": {
      "command": "node",
      "args": ["/absolute/path/to/clef-mcp/dist/index.js"],
      "env": {
        "CLEF_BASE_URL": "https://ollama.com",
        "CLEF_API_KEY": "your-key",
        "CLEF_MODEL": "clef"
      }
    }
  }
}
```

Local Ollama variant (no key):

```json
{
  "mcpServers": {
    "clef": {
      "command": "node",
      "args": ["/absolute/path/to/clef-mcp/dist/index.js"],
      "env": {
        "CLEF_BASE_URL": "http://localhost:11434",
        "CLEF_MODEL": "clef:cloud"
      }
    }
  }
}
```

## The `decide` tool

Inputs:

- `state`: non-empty text, or a JSON object or array (sent as JSON text).
- `questions`: map of question name to question, 1 to 64 entries. Names match `^[A-Za-z0-9_.-]{1,100}$`.
- `images` (optional): up to 4 raw base64 strings (no `data:` URLs).

Question types:

- `choice`: `criteria` is required, an object of 2-26 label keys mapped to a description or `null`.
- `noul`: `criteria` is optional, exactly `{"false": "...", "true": "..."}`.
- `score`: `criteria` is required, an array of 2-10 level descriptions ordered lowest to highest.

Example call:

```json
{
  "state": "Customer: I was charged twice and the checkout page crashes.",
  "questions": {
    "refund": { "type": "noul", "instructions": "Does the customer ask for a refund?" },
    "urgency": {
      "type": "score",
      "instructions": "How urgent is it?",
      "criteria": [
        "Routine: no time pressure",
        "Soon: a customer is inconvenienced",
        "Immediate: a critical service is unavailable"
      ]
    }
  }
}
```

Answer semantics:

- `choice`: `choice` (winning key), `probabilities` per key (sum to 1), `confidence` (0-1).
- `noul`: `noul` is the probability from 0 to 1 that the statement is true. It is not a boolean and has no confidence field.
- `score`: `score` is the probability-weighted mean of the zero-based level index (for example 1.84 on a 0-2 scale, not rounded), plus `legend`, `probabilities` per index, and `confidence`.

The result also carries `usage` with `input_tokens` and `output_tokens`.

## Tests

```bash
npm run build && npm test
npm run test:e2e
CLEF_INTEGRATION_BASE_URL=http://localhost:11434 npm run test:integration
```

`npm test` runs the unit and e2e suites; the integration suite is skipped unless `CLEF_INTEGRATION_BASE_URL` is set (set `CLEF_API_KEY` and `CLEF_MODEL` as needed).
