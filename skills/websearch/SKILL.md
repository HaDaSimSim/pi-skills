---
name: websearch
description: Search the web via a SearXNG instance and get back ranked results (title, URL, snippet) as plain text. Use when you need current information from the internet — recent events, documentation, prices, version-specific behavior, or anything where up-to-date web results would change the answer. Wraps a SearXNG JSON API endpoint; the instance base URL is read from $SEARXNG_URL (or a `.env` next to the binary).
---

# websearch — web search via SearXNG

Queries a [SearXNG](https://docs.searxng.org/) instance's JSON API
(`/search?format=json`) and prints ranked results for the agent to read.

## Setup

The binary needs a SearXNG base URL. One of:

```bash
export SEARXNG_URL=https://searxng.example.org
```

Or drop a `.env` next to the binary (preferred — pi runs the binary directly
with no shell):

```
SEARXNG_URL=https://searxng.example.org
# optional, for token-protected instances:
SEARXNG_API_KEY=...
```

> The instance must have the JSON output format enabled
> (`search.formats: [html, json]` in its `settings.yml`). Public instances
> often disable JSON; a self-hosted one is the reliable choice.

## Usage

```bash
./websearch "<query>" [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--count N` | Max results to print (default 10). |
| `--lang CODE` | Search language, e.g. `en`, `ko`, `de`. |
| `--time RANGE` | Time filter: `day`, `week`, `month`, `year`. |
| `--category CAT` | Category: `general`, `news`, `images`, `videos`, `science`, `it`, ... |
| `--engines LIST` | Comma-separated engines, e.g. `google,bing,duckduckgo`. |
| `--page N` | Result page number (default 1). |
| `--safe 0\|1\|2` | Safe search: 0=off, 1=moderate, 2=strict. |
| `--json` | Print the raw SearXNG JSON response instead of formatted text. |

### Examples

Basic search:
```bash
./websearch "go 1.26 release notes"
```

Recent news in Korean, top 5:
```bash
./websearch "AI 규제" --lang ko --category news --time week --count 5
```

Restrict to specific engines:
```bash
./websearch "rust async runtime comparison" --engines google,duckduckgo
```

Raw JSON (for further processing):
```bash
./websearch "current bitcoin price" --json
```

## Config

| Variable | Purpose | Default |
|---|---|---|
| `SEARXNG_URL` | Base URL of the SearXNG instance (required). | (none — `.env` fallback) |
| `SEARXNG_API_KEY` | Optional bearer token for protected instances. | (none) |

Both fall back to a `KEY=VALUE` `.env` next to the binary.

## Tips

- Results are ordered by SearXNG's relevance score across the aggregated
  engines. Infoboxes (if any) print first as the most direct answer.
- If decoding fails, the instance likely doesn't expose the JSON format —
  check `search.formats` in its `settings.yml`.
- Use `--time week`/`--time day` for fast-moving topics to avoid stale hits.
