---
name: grep-search
description: Search real-world code examples from public GitHub repositories using grep.app. Use when you need to find actual usage patterns, implementation examples, or see how developers use specific APIs and libraries in production code.
---

# Grep Search — GitHub Code Search

Search across millions of public GitHub repositories for real code examples.

## Usage

```bash
./grep-search "<query>" [options]
```

### Options

| Option | Description |
|--------|-------------|
| `--lang <language>` | Filter by language (e.g. TypeScript, Python, Go). Repeat to OR multiple. |
| `--repo <owner/repo>` | Filter by repository (e.g. `vercel/next.js`). |
| `--path <path>` | Filter by file path (e.g. `src/components`). |
| `--regexp` | Treat query as a regular expression. |
| `--case` | Case-sensitive search. |
| `--words` | Match whole words only. |

### Examples

Search for a specific function usage:
```bash
./grep-search "useEffect(" --lang TypeScript
```

Search with regex for a pattern:
```bash
./grep-search "useState\(.*loading" --regexp --lang TSX
```

Search in a specific repo:
```bash
./grep-search "getServerSession" --repo nextauthjs/next-auth
```

Search by file path:
```bash
./grep-search "export default" --path "route.ts" --lang TypeScript
```

## Tips

- Search for literal code patterns, not keywords (e.g. `useState(` not "react hooks").
- Use `--regexp` for flexible patterns like `(?s)try {.*await`.
- Combine `--lang` and `--path` for precise results.
- Results include file paths, line numbers, and code snippets.
