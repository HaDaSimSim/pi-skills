// Standalone test for the output sanitizer (async-bash render safety).
// Run: bash run-harness.sh

import { strict as assert } from "node:assert";

const mod = await import("./sanitize.ts");
const sanitizeForRender = (mod as { sanitizeForRender: (t: string) => string }).sanitizeForRender;
const toLabel = (mod as { toLabel: (t: string, m?: number) => string }).toLabel;

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
};

// sanitizeForRender
check("tab expands to spaces (4-col boundary)", sanitizeForRender("a\tb") === "a   b");
check("tab at col 0 fills 4 spaces", sanitizeForRender("\tx") === "    x");
check("newline preserved and resets column", sanitizeForRender("a\nb\tc") === "a\nb   c");
check("carriage return stripped", sanitizeForRender("a\r\nb") === "a\nb");
check("C0 control chars stripped", sanitizeForRender("a\x00\x07\x1bb") === "ab");
check("DEL (0x7f) stripped", sanitizeForRender("a\x7fb") === "ab");
check("printable unicode preserved", sanitizeForRender("héllo ✨") === "héllo ✨");
check("empty string passthrough", sanitizeForRender("") === "");

// toLabel
check("short label unchanged", toLabel("npm run build") === "npm run build");
check("whitespace collapsed", toLabel("npm   run\tbuild") === "npm run build");
check("newlines collapsed to spaces", toLabel("line1\nline2") === "line1 line2");
check(
  "long label truncated with ellipsis",
  (() => {
    const out = toLabel("x".repeat(100), 10);
    return out.length === 10 && out.endsWith("…");
  })(),
);

console.log(`\n✅ all ${passed} async-bash sanitize assertions passed`);
