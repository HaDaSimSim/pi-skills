---
name: context7
description: Query up-to-date documentation and code examples from Context7 for any programming library or framework. Use when you need current API docs, usage examples, or library-specific information that may not be in your training data.
---

# Context7 — Library Documentation Search

Real-time documentation lookup for any library or framework.

## Setup

The binary needs a Context7 API key. Either export `CONTEXT7_API_KEY` in your
shell, or drop a `.env` next to the binary:

```
CONTEXT7_API_KEY=ctx7sk-...
```

## Usage

### Step 1: Resolve library ID

```bash
./context7 resolve "<library name>"
```

Example:
```bash
./context7 resolve "Next.js"
```

Returns a list of matching libraries with their IDs (format: `/org/project`).

### Step 2: Query documentation

```bash
./context7 query "<library_id>" "<your question>"
```

Example:
```bash
./context7 query "/vercel/next.js" "How to set up authentication with JWT"
```

## Tips

- Use the official library name with proper punctuation (e.g. "Next.js", not "nextjs").
- Be specific in your query for better results.
- Always resolve the library ID first before querying.
