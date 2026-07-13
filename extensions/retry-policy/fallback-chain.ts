// fallback-chain — bundled+overridable fallback model chains for retry-policy.
//
// After native same-model auto-retry is exhausted on a TRANSIENT error,
// `nextFallbackModel(currentModel, chainKey?)` returns the next model in
// the active chain, or undefined when exhausted.
//
// Discovery mirrors subagents/categories.ts pattern:
//   - Bundled defaults in this file (per-category AND per-agent ordered lists).
//   - User overrides from ~/.pi/agent/fallback-chains/*.json (array of model ids).
//   - Dedicated "global" chain (chainKey="default") used when no specific chain matches.
//
// Each chain is an ordered list of model ids (provider/modelId format).
// The chain position advances with each call to nextFallbackModel and resets
// via resetFallbackChain (called on success or chain exhaustion).
//
// Precedence with task 29 category routing:
//   The fallback chain for a category starts AFTER the category's primary model.
//   For example, `resolveCategory("deep")` returns `"relay/gpt-5.5"` (primary);
//   the fallback chain for "deep" is `["relay/claude-opus-4.8", ...]` — the
//   primary is tried first by the subagent spawner; fallback only kicks in
//   on transient error AFTER the primary fails. Use the SAME chainKey name
//   (category name) to align: retry-policy queries the fallback chain by the
//   same key that subagents/categories.ts uses for the primary model.
//
// Task 33 fills the real config. Task 34 surfaces this in pi-gui.

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

// ── Bundled fallback chains ───────────────────────────────────────────────────
// Ordered lists of "provider/modelId" strings. The primary (first-tried) model
// is resolved by categories.ts; these chains list alternatives in preference order.
//
// Each key matches either:
//   - A category name from subagents/categories.ts (deep, quick, ultrabrain, etc.)
//   - An agent/persona name from primary-agents (builder, planner, unspecified)
//
// The "default" chain is used when no specific chain matches the given key.

export const BUNDLED_FALLBACK_CHAINS: Record<string, string[]> = {
  // ── Category-based chains ────────────────────────────────────────────────
  // These align with subagents/categories.ts BUNDLED_CATEGORIES keys.
  // The primary model (from categories.ts) is NOT repeated here — chains start
  // AFTER the primary. Precedence: categories.ts primary → this chain.
  deep: ["relay/claude-opus-4.8", "relay/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"],
  ultrabrain: ["relay/gpt-5.5", "relay/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"],
  quick: ["relay/gpt-5.5", "relay/gpt-5.4", "anthropic/claude-haiku-4-6"],
  "visual-engineering": ["relay/claude-opus-4.8", "relay/gpt-5.4-mini"],
  artistry: ["relay/claude-opus-4.8", "relay/gpt-5.4-mini"],
  "unspecified-low": ["relay/gpt-5.5", "relay/gpt-5.4"],
  "unspecified-high": ["relay/gpt-5.5", "relay/gpt-5.4-mini"],
  writing: ["relay/claude-opus-4.8", "relay/gpt-5.4-mini"],

  // ── Agent/persona-based chains ───────────────────────────────────────────
  builder: ["relay/claude-opus-4.8", "relay/gpt-5.5", "relay/gpt-5.4-mini"],
  planner: ["relay/claude-opus-4.8", "relay/gpt-5.5", "relay/gpt-5.4-mini"],
  unspecified: ["relay/gpt-5.5", "relay/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"],

  // ── Global default chain (used when no specific key matches) ──────────────
  default: [
    "relay/claude-opus-4.8",
    "relay/gpt-5.5",
    "relay/gpt-5.4-mini",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-haiku-4-6",
  ],
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FallbackChainTable {
  /** Merged key→chain map (bundled + user overrides). */
  chains: Record<string, string[]>;
  /** Path to user fallback-chains dir (null if none). */
  userChainsDir: string | null;
}

/** Per-chain position tracker for nextFallbackModel. */
interface ChainPosition {
  index: number;
}

// ── User override loading ─────────────────────────────────────────────────────

function loadUserChains(dir: string): Record<string, string[]> {
  const overrides: Record<string, string[]> = {};
  if (!fs.existsSync(dir)) return overrides;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return overrides;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      continue;
    }

    // Accept an object mapping keys to arrays of model strings.
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      for (const [key, value] of Object.entries(obj)) {
        if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
          overrides[key] = value as string[];
        }
      }
    }
  }

  return overrides;
}

// ── Discovery ─────────────────────────────────────────────────────────────────

let _table: FallbackChainTable | undefined;

/** Build (or return cached) the merged fallback chain table. */
export function discoverFallbackChains(): FallbackChainTable {
  if (_table) return _table;

  const userDir = path.join(getAgentDir(), "fallback-chains");
  const userOverrides = loadUserChains(userDir);

  const merged: Record<string, string[]> = { ...BUNDLED_FALLBACK_CHAINS };
  for (const [name, chain] of Object.entries(userOverrides)) {
    merged[name] = chain;
  }

  _table = {
    chains: merged,
    userChainsDir: fs.existsSync(userDir) ? userDir : null,
  };
  return _table;
}

/**
 * Get the fallback chain for a given key (category name, agent name, or "default").
 * Falls back to the "default" chain if no specific chain exists for the key.
 */
export function getFallbackChain(chainKey?: string): string[] {
  const table = discoverFallbackChains();
  if (chainKey && table.chains[chainKey]) {
    return table.chains[chainKey];
  }
  return table.chains["default"] ?? [];
}

// ── Chain position tracking ───────────────────────────────────────────────────

/** Per-chain positions. Keyed by chainKey (or "default"). */
const _positions = new Map<string, ChainPosition>();

function getPosition(chainKey: string): ChainPosition {
  let pos = _positions.get(chainKey);
  if (!pos) {
    pos = { index: 0 };
    _positions.set(chainKey, pos);
  }
  return pos;
}

/**
 * Resolve the next model in the fallback chain after `currentModel`.
 *
 * @param currentModel - The current model identifier (provider/modelId format).
 *   Used to find the current position in the chain; if the current model is
 *   not found in the chain, starts from the beginning.
 * @param chainKey - Optional key to select a specific chain (category name,
 *   agent name, or undefined for "default").
 * @returns The next model to try, or undefined if the chain is exhausted.
 */
export function nextFallbackModel(currentModel: string, chainKey?: string): string | undefined {
  const key = chainKey ?? "default";
  const chain = getFallbackChain(key);
  if (chain.length === 0) return undefined;

  const pos = getPosition(key);

  // Find the current model's index in the chain (case-insensitive).
  let currentIdx = -1;
  const lower = currentModel.toLowerCase();
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].toLowerCase() === lower) {
      currentIdx = i;
      break;
    }
  }

  if (currentIdx >= 0) {
    // Current model found in chain — advance to next.
    pos.index = currentIdx + 1;
  } else {
    // Current model not in chain — start from beginning.
    pos.index = 0;
  }

  // Return the model at the current position, or undefined if exhausted.
  if (pos.index >= chain.length) return undefined;

  const next = chain[pos.index];
  // Advance position for the NEXT call (so subsequent calls get the next in chain).
  pos.index += 1;
  return next;
}

/**
 * Reset the fallback chain position for a given key (or all chains if key is undefined).
 * Called when a turn succeeds — the chain position is reset so the next
 * transient error starts from the first fallback again.
 */
export function resetFallbackChain(chainKey?: string): void {
  if (chainKey) {
    _positions.delete(chainKey);
  } else {
    _positions.clear();
  }
}

// ── Chain position query (for external consumers like GUI state persistence) ─

/**
 * Return the current position index within a fallback chain.
 * 0 means no advance yet (next call returns first model). Returns -1 if no chain.
 * Used by retry-policy to record the chain position in a durable retry-fallback entry.
 */
export function getChainPosition(chainKey?: string): number {
  const pos = _positions.get(chainKey ?? "default");
  return pos ? pos.index : 0;
}

// ── Discovery helpers (for external consumers) ────────────────────────────────

/** Return all known chain names (for diagnostics, listing). */
export function knownChainNames(): string[] {
  const table = discoverFallbackChains();
  return Object.keys(table.chains).sort();
}

/** Return the user overrides directory path (null if none). */
export function getUserChainsDir(): string | null {
  const table = discoverFallbackChains();
  return table.userChainsDir;
}

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Reset the cached table AND position state (for tests). */
export function _resetForTest(): void {
  _table = undefined;
  _positions.clear();
}
