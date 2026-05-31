---
name: update-models
description: Sync the Relay model catalog into pi's models.json. Use when the user wants to install, refresh, remove, or troubleshoot the Relay (`sk-relay-...`) provider in pi — for example "update my models", "add Relay to pi", "refresh Relay model list", or "set up Relay API key". Wraps the Relay-side `https://relay-api.algorix.io/integration/opencode/config` endpoint (the one the OpenCode installer uses) and translates its response into pi's `~/.pi/agent/models.json` shape. Reads the API key from `$RELAY_API_KEY`, `$PI_RELAY_API_KEY`, or a `.env` next to the binary.
---

# update-models — Relay provider sync for pi

This skill manages the `relay` entry inside pi's `~/.pi/agent/models.json`.

Relay does not ship a pi-specific config endpoint, so this skill calls the
OpenCode endpoint (`/integration/opencode/config`) and translates the
response into pi's expected shape. The translation is mechanical:

| OpenCode | pi |
|---|---|
| `provider.relay.options.baseURL` | `providers.relay.baseUrl` |
| `provider.relay.models[id].name` | `providers.relay.models[].name` |
| `provider.relay.models[id].limit.context` | `providers.relay.models[].contextWindow` |
| `provider.relay.models[id].limit.output` | `providers.relay.models[].maxTokens` |
| `provider.relay.models[id].modalities.input` | `providers.relay.models[].input` |
| `provider.relay.models[id].cost.{input,output,cache_read,cache_write}` | `providers.relay.models[].cost.{input,output,cacheRead,cacheWrite}` |
| `provider.relay.models[id].variants` includes `max` | `reasoning: true`, `thinkingLevelMap: { minimal: null, xhigh: "max" }` (Claude family) |
| `provider.relay.models[id].variants` includes `xhigh` | `reasoning: true`, `thinkingLevelMap: { minimal: null, xhigh: "xhigh" }` (GPT family) |
| any other variants set, or no variants | plain entry, no `reasoning` toggle (covers non-thinking models like deepseek/glm/qwen/minimax, and would cover Gemini if Relay ever exposes it) |

`api` is hard-coded to `"openai-completions"` and `apiKey` to
`"$PI_RELAY_API_KEY"` so pi resolves the key from the user's shell env at
request time.

## Setup

The binary needs a Relay API key (starts with `sk-relay-`). One of:

```bash
export RELAY_API_KEY=sk-relay-...
# or
export PI_RELAY_API_KEY=sk-relay-...
```

Or drop a `.env` next to the binary (preferred for unattended use — pi runs
the binary directly with no shell):

```
RELAY_API_KEY=sk-relay-...
```

The easiest way is `./update-models setup`, which writes the `.env` for you
and then runs `refresh`.

> Note: this skill only edits `models.json`. pi reads `$PI_RELAY_API_KEY` at
> request time (that is the literal `apiKey` value written into the file),
> so the user still needs that variable in their shell rc for actual chat
> completions to work. `setup` reminds about this.

## Usage

### Refresh the model list

```bash
./update-models refresh
```

Fetches the latest OpenCode-shaped Relay config and rewrites the `relay`
slot of `~/.pi/agent/models.json`. Other providers in the file are untouched.

### Initial setup (save key + refresh)

```bash
./update-models setup --api-key sk-relay-XXXX
```

Or omit `--api-key` and it will read from `$RELAY_API_KEY` /
`$PI_RELAY_API_KEY`, then prompt on `/dev/tty` as a last resort. Saves the
key to a `.env` (`chmod 600`) next to the binary, then runs `refresh`.

Pass `--skip-refresh` to save the key only.

### Remove the Relay provider

```bash
./update-models remove
```

Drops the `relay` provider from `models.json`. Leaves everything else alone.

### Inspect current state

```bash
./update-models status
```

Prints which paths are in use, whether an API key is found, and a summary of
the currently configured `relay` provider (baseUrl, api type, model list).

### Smoke-test the configured models

```bash
./update-models test
```

Sends a minimal `chat/completions` request against the first model in the
configured `relay` provider, using `baseUrl` from `models.json`. Useful for
verifying the API key actually works against the gateway, not just the
config endpoint.

## Environment overrides

| Variable | Purpose | Default |
|---|---|---|
| `RELAY_API_KEY` / `PI_RELAY_API_KEY` | Auth for the Relay endpoints. | (none — `.env` fallback) |
| `RELAY_SETUP_URL` | Override the config endpoint. | `https://relay-api.algorix.io/integration/opencode/config` |
| `PI_MODELS_PATH` | Override the path to pi's `models.json`. | `~/.pi/agent/models.json` |

## Tips

- After `refresh`, pi picks up the new model list the next time the user
  opens `/model` — no restart needed.
- If `test` fails with HTTP 401, the API key is invalid; re-run `setup`.
- If `refresh` errors with "missing 'provider'", the endpoint URL is wrong
  (this skill expects the OpenCode shape; check `RELAY_SETUP_URL`).
- The skill respects model order returned by the server, even though
  OpenCode encodes models as a JSON object. It uses an order-preserving
  decoder rather than `map[string]X` for the translation step.
