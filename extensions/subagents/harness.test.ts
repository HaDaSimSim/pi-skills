// Standalone test for the transient-error classifier (subagents retry logic).
// Run: bash run-harness.sh

import { strict as assert } from "node:assert";

const mod = await import("./transient.ts");
const isTransientError = (mod as { isTransientError: (e: string | undefined) => boolean }).isTransientError;

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
};

// Transient (should retry)
const transient = [
  "Error: 429 Too Many Requests",
  "rate limit exceeded, retry after 5s",
  "model overloaded",
  "request timed out",
  "ETIMEDOUT",
  "ECONNRESET",
  "socket hang up",
  "503 Service Unavailable",
  "502 Bad Gateway",
  "upstream server error",
  "network error: connection reset by peer",
  "stream error",
];
for (const e of transient) check(`transient: "${e.slice(0, 32)}"`, isTransientError(e) === true);

// Deterministic (should NOT retry)
const deterministic = [
  "Unknown option: -m",
  "invalid model: relay/nope",
  "invalid argument",
  "401 Unauthorized",
  "403 Forbidden",
  "invalid api key",
  "missing api key",
  "no such file",
  "command not found",
];
for (const e of deterministic) check(`deterministic: "${e.slice(0, 32)}"`, isTransientError(e) === false);

// Edge cases
check("undefined → not transient", isTransientError(undefined) === false);
check("empty string → not transient", isTransientError("") === false);
// A 500 that is also 'invalid' → deterministic wins (we bail on invalid)
check("'invalid input (500)' → deterministic (invalid wins)", isTransientError("invalid input (500)") === false);

console.log(`\n✅ all ${passed} subagents transient-retry assertions passed`);
