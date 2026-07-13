// evidence.test.ts — structured evidence capture tests.
//
// Tests:
//   1. EvidenceRecord structure — all required fields present, valid types.
//   2. File layout — record lands under .ohpi/evidence/<date>-<label>/.
//   3. jq validation — `jq -e '.timestamp and .type and .content' <file>` exit 0.
//   4. Redaction — planted secrets stripped from content before write.
//   5. Edge cases — empty content, missing optional fields, two records.
//
// Uses node builtins only (no pi SDK import). Runs via:
//   node --experimental-strip-types evidence.test.ts
//   or via run-harness.sh.

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { _resetSeqForTest, type EvidenceRecord, redactContent, writeEvidence } from "./index.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const CWD = process.cwd();
const TEST_LABEL = "wave6-task26-test";
const TEST_DATE = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;

function check(desc: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${desc}`);
  } catch (err: unknown) {
    fail++;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ ${desc}: ${msg}`);
  }
}

/** Run jq on a JSON file and return { code, stdout, stderr }. */
function jq(filter: string, filePath: string) {
  const r = spawnSync("jq", [filter, filePath], { encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

/** Run jq -e filter on a JSON file and return { code, stdout, stderr }. */
function jqe(filter: string, filePath: string) {
  const r = spawnSync("jq", ["-e", filter, filePath], { encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log("evidence extension tests\n");

// Reset state before each logical group.
_resetSeqForTest();

// ── Part 1: redactContent ──────────────────────────────────────────────────

console.log("Part 1: redactContent");

const plantedSecret = "sk-proj-deadbeef1234567890abcdef123456";
const redacted = redactContent(`API key: ${plantedSecret} used for auth`);

check("redactContent strips sk-... tokens", () => {
  assert.ok(!redacted.includes(plantedSecret), "secret should be redacted");
  assert.ok(redacted.includes("•••REDACTED•••"), "redaction marker should be present");
  assert.ok(redacted.includes("API key:"), "non-secret content should be preserved");
});

check("redactContent handles clean content (no secrets)", () => {
  const clean = redactContent("build: success, 0 errors");
  assert.strictEqual(clean, "build: success, 0 errors");
});

check("redactContent strips JWT tokens", () => {
  const jwt =
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
  const result = redactContent(jwt);
  assert.ok(!result.includes("eyJ"), "JWT header should be redacted");
  assert.ok(result.includes("REDACTED_JWT"), "JWT redaction marker should be present");
});

check("redactContent strips github_pat_ tokens", () => {
  const pat = "github_pat_11ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  const result = redactContent(pat);
  assert.ok(!result.includes("github_pat_11"), "PAT should be redacted");
});

check("redactContent strips hardcoded password in key=value", () => {
  const line = "password=supersecretpassword12345 for db";
  const result = redactContent(line);
  assert.ok(!result.includes("supersecretpassword"), "password value should be redacted");
  assert.ok(result.includes("password=•••REDACTED•••"), "key= marker should remain");
});

check("redactContent strips multi-line PEM private key block", () => {
  const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA0Z3xVgP5hL7k8w2YtRqN4aBcDeFgHiJkLmNoPqRsTuVwXyZa
BcDeFgHiJkLmNoPqRsTuVwXyZ1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p7q8r9s0t
1u2v3w4x5y6z7A8B9C0D1E2F3G4H5I6J7K8L9M0N1O2P3Q4R5S6T7U8V9W0X1Y2Z3
-----END RSA PRIVATE KEY-----`;
  const result = redactContent(pem);
  assert.ok(!result.includes("MIIEpA"), "PEM body should be redacted");
  assert.ok(!result.includes("RSA PRIVATE KEY-----"), "PEM footer should be redacted");
  assert.ok(result.includes("-----BEGIN •••REDACTED PRIVATE KEY-----"), "redaction marker present");
  // Verify single-line: the entire multi-line block collapses to the marker line.
  assert.ok(!result.includes("\n"), "multi-line PEM should collapse to single-line marker");
});

// ── Part 2: writeEvidence — file layout ────────────────────────────────────

console.log("\nPart 2: writeEvidence — file layout");

_resetSeqForTest();

const filePath1 = writeEvidence(CWD, TEST_LABEL, {
  type: "test-output",
  surface: "bash:node evidence.test.ts",
  content: "Tests: 5 passed, 0 failed",
});

check("writeEvidence returns absolute path", () => {
  assert.ok(filePath1.startsWith("/"), `expected absolute path, got ${filePath1}`);
});

check("file exists at returned path", () => {
  assert.ok(existsSync(filePath1), `file does not exist: ${filePath1}`);
});

check("file is under .ohpi/evidence/<date>-<label>/", () => {
  const dir = dirname(filePath1);
  assert.ok(dir.includes(`.ohpi/evidence/${TEST_DATE}-${TEST_LABEL}`), `unexpected dir: ${dir}`);
});

check("filename format: <timestamp>-<type>-<seq>.json", () => {
  const fn = basename(filePath1);
  assert.ok(fn.includes("-test-output-"), `unexpected filename: ${fn}`);
  assert.ok(fn.endsWith(".json"), `expected .json extension: ${fn}`);
});

// ── Part 3: jq validation ──────────────────────────────────────────────────

console.log("\nPart 3: jq validation");

check("jq -e '.timestamp and .type and .content' exits 0", () => {
  const result = jqe(".timestamp and .type and .content", filePath1);
  console.log(`     jq code: ${result.code}, stdout: ${result.stdout.trim()}`);
  assert.strictEqual(result.code, 0, `jq code ${result.code}: ${result.stderr}`);
});

check("jq -e '.type and .content' boolean returns true", () => {
  const result = jqe(".type and .content", filePath1);
  assert.strictEqual(result.code, 0, `jq code ${result.code}`);
  assert.strictEqual(result.stdout.trim(), "true");
});

check("jq '.timestamp' returns an ISO string", () => {
  const result = jq(".timestamp", filePath1);
  const ts = result.stdout.trim().replace(/^"(.*)"$/, "$1");
  assert.ok(ts.includes("T") || ts.includes("Z"), `unexpected timestamp: ${ts}`);
});

check("jq '.surface' returns the surface identifier", () => {
  const result = jq(".surface", filePath1);
  const surface = result.stdout.trim().replace(/^"(.*)"$/, "$1");
  assert.strictEqual(surface, "bash:node evidence.test.ts");
});

check("jq '.content' returns the redacted content", () => {
  const result = jq(".content", filePath1);
  const content = result.stdout.trim().replace(/^"(.*)"$/, "$1");
  assert.strictEqual(content, "Tests: 5 passed, 0 failed");
});

// ── Part 4: redaction in written record ────────────────────────────────────

console.log("\nPart 4: redaction in written record");

const filePath2 = writeEvidence(CWD, TEST_LABEL, {
  type: "bash-output",
  surface: "bash:echo secret test",
  content: `env FOO=bar API_KEY=sk-ant-api03-abcdefghijklmnopqrstuvwxyz run\nAlso contains bearer: Bearer ghx_abc123def456ghi789jkl012mno345pqr678stu`,
});

check("written record has secrets redacted", () => {
  const raw = readFileSync(filePath2, "utf-8");
  const record = JSON.parse(raw) as EvidenceRecord;
  // The sk-ant key should be redacted
  assert.ok(!record.content.includes("sk-ant"), "sk-ant token should be redacted");
  // The bearer token value should be redacted
  assert.ok(!record.content.includes("ghx_abc"), "bearer token value should be redacted");
  // Redaction marker should be present for the API_KEY value
  assert.ok(record.content.includes("API_KEY=•••REDACTED•••"), "API_KEY value should be redacted");
  // Non-secret content should be preserved
  assert.ok(record.content.includes("env FOO=bar"), "non-secret content should be preserved");
  assert.ok(record.content.includes("run"), "non-secret command should be preserved");
});

check("jq validation still passes on redacted record", () => {
  const result = jqe(".timestamp and .type and .content", filePath2);
  assert.strictEqual(result.code, 0, `jq code ${result.code}: ${result.stderr}`);
});

// ── Part 5: record structure (typed) ───────────────────────────────────────

console.log("\nPart 5: record structure");

check("written record has all required fields", () => {
  const raw = readFileSync(filePath1, "utf-8");
  const record = JSON.parse(raw) as EvidenceRecord;
  assert.ok(typeof record.timestamp === "string", "timestamp must be string");
  assert.ok(typeof record.type === "string", "type must be string");
  assert.ok(typeof record.surface === "string", "surface must be string");
  assert.ok(typeof record.content === "string", "content must be string");
});

check("artifactPath is optional — not present when omitted", () => {
  const raw = readFileSync(filePath1, "utf-8");
  const record = JSON.parse(raw) as EvidenceRecord & { artifactPath?: string };
  assert.strictEqual(record.artifactPath, undefined, "artifactPath should be absent");
});

check("record with artifactPath includes it", () => {
  const fp = writeEvidence(CWD, TEST_LABEL, {
    type: "screenshot",
    surface: "browser:/login",
    content: "Screenshot shows login page with error banner",
    artifactPath: "login-error.png",
  });
  const raw = readFileSync(fp, "utf-8");
  const record = JSON.parse(raw) as EvidenceRecord;
  assert.strictEqual(record.artifactPath, "login-error.png");
});

// ── Part 6: two records, distinct files ────────────────────────────────────

console.log("\nPart 6: two records, distinct files");

check("two writes produce distinct filenames (sequence numbers)", () => {
  // filePath1 and filePath2 should have different filenames
  assert.notStrictEqual(basename(filePath1), basename(filePath2), "filenames should differ");
  // The seq counter should have incremented
  assert.ok(
    basename(filePath2).includes("-001.json") || basename(filePath2).includes("-002.json"),
    `unexpected filename: ${basename(filePath2)}`,
  );
});

// ── Part 7: directory listing ──────────────────────────────────────────────

console.log("\nPart 7: directory listing");

const evidenceDir = join(CWD, ".ohpi", "evidence", `${TEST_DATE}-${TEST_LABEL}`);

check("evidence directory exists and contains .json files", () => {
  const entries = readdirSync(evidenceDir);
  const jsonFiles = entries.filter((e) => e.endsWith(".json"));
  assert.ok(jsonFiles.length >= 3, `expected >= 3 json files, got ${jsonFiles.length}`);
});

check("all .json files are jq-validatable (have timestamp, type, content)", () => {
  const entries = readdirSync(evidenceDir);
  const jsonFiles = entries.filter((e) => e.endsWith(".json"));
  for (const fn of jsonFiles) {
    const fp = join(evidenceDir, fn);
    const result = jqe(".timestamp and .type and .content", fp);
    assert.strictEqual(result.code, 0, `jq failed on ${fn}: ${result.stderr}`);
  }
});

// ── Part 8: redactContent pure ─────────────────────────────────────────────

console.log("\nPart 8: redactContent is pure");

check("redactContent is idempotent", () => {
  const input = "token=sk-ant-api03-abcdef1234567890deadbeef";
  const first = redactContent(input);
  const second = redactContent(first);
  assert.strictEqual(second, first, "redactContent should be idempotent");
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exitCode = 1;
}
