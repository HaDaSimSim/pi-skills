// evidence — structured evidence capture for pi ultrawork/QA flows.
//
// Provides a typed EvidenceRecord format and a writer that lands jq-validatable
// JSON under .ohpi/evidence/<date>-<label>/ (one .json file per record).
//
// The writer applies a redaction pass to `content` before writing, per
// AGENTS.md: NO raw secrets (tokens, keys, passwords) in captured evidence.
//
// Consumers:
//   - task 27: ultrawork/QA flows call writeEvidence() to capture
//     RED→GREEN proof, surface artifacts, and manual-QA output.
//   - task 28: GUI evidence view reads *.json records from
//     .ohpi/evidence/*/ to render a timeline.
//
// Install: ~/.pi/agent/extensions/evidence/index.ts (make install symlinks it)
// Guardrail: NO raw before_agent_start / agent_end hooks registered here.
//   This is a capture library — tasks 27/28 wire it into their own extension
//   lifecycle.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, ohpiSubdir } from "./shared/ohpi-paths.ts";

// ── Evidence record type ──────────────────────────────────────────────────────

/**
 * A single structured evidence record.
 *
 * Field rationale (task 13 ultrawork directive): every scenario demands two
 * artifacts — RED→GREEN proof (test output before + after change) and a
 * real-surface artifact (bash/curl/browser/CLI output the user actually sees).
 * An EvidenceRecord captures either of those (or a manual-QA confirmation).
 *
 * `jq -e '.timestamp and .type and .content' <record.json>` MUST exit 0 on
 * every valid record written by this module.
 */
export interface EvidenceRecord {
  /**
   * ISO-8601 timestamp of when the evidence was captured.
   * Required. Produced by the writer (caller does not set it).
   */
  timestamp: string;

  /**
   * Evidence category:
   *   - "test-output"     RED→GREEN test runner output (before/after)
   *   - "bash-output"     CLI command execution transcript
   *   - "curl-response"   HTTP response body + status
   *   - "screenshot"      browser screenshot path (content = description)
   *   - "browser-action"  browser automation log
   *   - "manual-qa"       manual QA execution confirmation
   *   - "build-output"    build/compile output
   *   - "lsp-output"      LSP diagnostics output
   *   - "db-state"        database state dump
   *   - "config-dump"     parsed config output
   *   - "notepad-excerpt" relevant excerpt from ultrawork notepad
   *   - "general"         catch-all for other evidence
   *
   * Required. Validation: jq '.type' must be one of the known values.
   */
  type: string;

  /**
   * Identifier of the REAL surface that produced this evidence.
   * Examples:
   *   - "cli:pnpm build"         build command
   *   - "api:POST /status"       API endpoint
   *   - "browser:/login"         browser page/route
   *   - "bash:grep -rn pattern"  shell command
   *   - "test:validation.test.ts::S2-invalid-email"
   *
   * Required for task 13's "REAL surface that proves it" mandate.
   * Validation: jq '.surface' must be a non-empty string.
   */
  surface: string;

  /**
   * The captured evidence payload. After redaction, this is the sanitised
   * text output / transcript / body. For screenshot type, content is a
   * human-readable description of what the screenshot shows.
   *
   * Required. Validation: jq '.content' must be a non-empty string (after
   * redaction it may be shorter than original).
   */
  content: string;

  /**
   * Optional absolute or relative path to an artifact file saved alongside
   * the JSON record (e.g. a screenshot .png, a log file, a build artifact).
   * If present, the artifact file is expected to live next to the JSON
   * record in the same evidence directory.
   */
  artifactPath?: string;
}

// ── Redaction ─────────────────────────────────────────────────────────────────
//
// Per AGENTS.md (extensions/AGENTS.md ~line 66 + omo-flow task spec): do NOT
// capture secrets raw. This pass strips obvious token/key patterns from
// `content` before the writer touches disk.
//
// The redaction is deliberately aggressive — false positives (over-redaction)
// are safer than leaking a real secret into a git-ignored evidence directory
// that might still be screenshotted, pasted into chat, or logged.

/** Regex patterns for secrets that MUST be redacted from evidence content. */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // OpenAI / Anthropic / generic API keys (sk-..., ant-..., key-...)
  { pattern: /\b(sk-[a-zA-Z0-9_-]{20,})\b/g, replacement: "•••REDACTED•••" },
  { pattern: /\b(ant-[a-zA-Z0-9_-]{20,})\b/g, replacement: "•••REDACTED•••" },

  // JWT tokens (eyJ... header.payload.signature) — BEFORE Bearer so the JWT
  // gets its specific replacement rather than being swallowed by a generic
  // long-token-after-Bearer match.
  {
    pattern: /\b(eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})\b/g,
    replacement: "•••REDACTED_JWT•••",
  },

  // GitHub tokens
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/g, replacement: "•••REDACTED•••" },
  { pattern: /\b(github_pat_[a-zA-Z0-9_]{20,})\b/g, replacement: "•••REDACTED•••" },

  // Slack tokens
  { pattern: /\b(xox[bpsr]-[a-zA-Z0-9-]{10,})\b/g, replacement: "•••REDACTED•••" },

  // Generic "key=" / "token=" values (catch long hex/base64 values)
  {
    pattern:
      /(key|token|secret|password|passwd|api_key|apikey)=['"]?([A-Za-z0-9+/=_\-@]{20,})['"]?/gi,
    replacement: "$1=•••REDACTED•••",
  },

  // Bearer tokens in Authorization headers (AFTER specific token patterns so
  // they get priority — the Bearer rule is a backstop for unidentified tokens)
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._\-+=/:]{20,})\b/gi, replacement: "$1•••REDACTED•••" },

  // AWS access key ID pattern (AKIA...)
  { pattern: /\b(AKIA[A-Z0-9]{16})\b/g, replacement: "•••REDACTED•••" },

  // Private key PEM headers (strip the whole block)
  {
    pattern:
      /-----BEGIN (RSA PRIVATE KEY|EC PRIVATE KEY|OPENSSH PRIVATE KEY|PRIVATE KEY|PGP PRIVATE KEY BLOCK)-----[\s\S]*?-----END \1-----/g,
    replacement: "-----BEGIN •••REDACTED PRIVATE KEY-----",
  },

  // Generic hex secrets of significant length (32+ hex chars)
  { pattern: /\b([0-9a-fA-F]{40,})\b/g, replacement: "•••REDACTED•••" },
];

/**
 * Apply all secret patterns to a content string.
 * Returns the redacted string. If no secrets are found, returns the original.
 * Exported so task 27 can pre-redact before write and task 28 can verify
 * no secrets leak into the GUI.
 */
export function redactContent(raw: string): string {
  let redacted = raw;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

// ── Writer ────────────────────────────────────────────────────────────────────

/**
 * Serialize an EvidenceRecord to pretty-printed JSON.
 * Uses 2-space indent (Biome convention), final newline.
 */
function serializeRecord(record: EvidenceRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** Counter for deduplication within a single writer session. */
let _seq = 0;

/**
 * Reset the internal sequence counter. Exported for test control.
 */
export function _resetSeqForTest(): void {
  _seq = 0;
}

/**
 * Generate a unique filename for an evidence record.
 * Format: `<iso-timestamp>-<type>-<3-digit-seq>.json`
 * The ISO timestamp uses dashes (not colons) for safe filesystem naming.
 */
function makeFilename(type: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const seq = String(_seq++).padStart(3, "0");
  return `${ts}-${type}-${seq}.json`;
}

/**
 * Write a single evidence record to disk.
 *
 * Layout:
 *   `<cwd>/.ohpi/evidence/<date>-<label>/<timestamp>-<type>-<seq>.json`
 *
 * - `cwd`: project root (typically process.cwd()).
 * - `label`: short slug describing the task/phase (e.g. "wave6-task26",
 *   "ultrawork-issue-42"). Used as a subdirectory under evidence/ for
 *   grouping records from the same run.
 * - `recordFields`: the caller-supplied fields (`type`, `surface`, `content`,
 *   optional `artifactPath`). `timestamp` is auto-generated.
 *
 * The writer:
 *   1. Resolves `<cwd>/.ohpi/evidence/<date>-<label>/` via
 *      `ohpiSubdir(cwd, "evidence")` + `ensureDir`.
 *   2. Redacts `content` via `redactContent()`.
 *   3. Writes a single `.json` file — one record per file so that
 *      `jq -e '.timestamp and .type and .content' <file.json>` exits 0
 *      on every file.
 *
 * Returns the absolute path of the written file, or throws on I/O error.
 */
export function writeEvidence(
  cwd: string,
  label: string,
  recordFields: {
    type: string;
    surface: string;
    content: string;
    artifactPath?: string;
  },
): string {
  // Resolve evidence base dir: <cwd>/.ohpi/evidence/
  const evidenceBase = ohpiSubdir(cwd, "evidence");

  // Date prefix for the subdirectory: YYYY-MM-DD
  const dateStr = new Date().toISOString().slice(0, 10);

  // Target dir: <cwd>/.ohpi/evidence/<date>-<label>/
  const dir = join(evidenceBase, `${dateStr}-${label}`);
  ensureDir(dir);

  const record: EvidenceRecord = {
    timestamp: new Date().toISOString(),
    type: recordFields.type,
    surface: recordFields.surface,
    content: redactContent(recordFields.content),
  };
  if (recordFields.artifactPath) {
    record.artifactPath = recordFields.artifactPath;
  }

  const filename = makeFilename(recordFields.type);
  const filePath = join(dir, filename);
  writeFileSync(filePath, serializeRecord(record), "utf-8");
  return filePath;
}

// ── Re-exports for convenience ────────────────────────────────────────────────
// Consumers that import { EvidenceRecord, writeEvidence, redactContent } from
// "evidence" get everything they need without needing separate imports.
