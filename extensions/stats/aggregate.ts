// stats/aggregate — reads session jsonl directly via streaming to aggregate usage.
//
// Why parse raw jsonl directly:
//   - The SessionInfo returned by SessionManager.listAll() has no tokens/cost (metadata only).
//     Since we have to look at each file's entries anyway, a simple line scan is faster
//     and uses less memory than getEntries() which builds a tree index (an 11MB file is fine when streamed).
//   - A branched session leaves entries outside the active path in the file too. From the
//     "usage/cost that actually happened" perspective, summing all assistant messages is correct (all of it was billed).
//
// Aggregation units:
//   - Per session (per file) / global (grand total) / per day (UTC yyyy-mm-dd) / per model / per tool.
//   - Tool counts are tallied by the name of toolCall blocks in assistant content ("tools invoked" basis).

import * as fs from "node:fs";
import * as readline from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// ─── Types ───────────────────────────────────────────────────────────────

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionStats {
  file: string; // absolute path to the session jsonl
  id: string; // session UUID (header)
  cwd: string; // working directory
  name?: string; // display name set via /name
  firstUserText: string; // first user message (used as label when there is no name)
  startedAt: number; // first entry timestamp (ms)
  endedAt: number; // last entry timestamp (ms)
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  tokens: TokenTotals;
  tools: Map<string, number>; // toolName -> count
  models: Map<string, number>; // model -> assistant message count
  days: Set<string>; // active dates (local yyyy-mm-dd)
  costByDay: Map<string, number>; // yyyy-mm-dd -> cost
  byHour: number[]; // [0..23] message count per hour (local)
  byWeekday: number[]; // [0..6] message count per weekday (Sun=0, local)
}

export interface AggregateStats {
  sessions: SessionStats[];
  totalSessions: number;
  totalMessages: number; // user + assistant + toolResult
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  tokens: TokenTotals;
  tools: Map<string, number>;
  models: Map<string, number>;
  days: Set<string>; // all active dates (local)
  costByDay: Map<string, number>; // yyyy-mm-dd -> cost
  byHour: number[]; // [0..23]
  byWeekday: number[]; // [0..6]
  firstActivity: number; // ms
  lastActivity: number; // ms
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addTokens(into: TokenTotals, u: any): void {
  if (!u) return;
  into.input += u.input || 0;
  into.output += u.output || 0;
  into.cacheRead += u.cacheRead || 0;
  into.cacheWrite += u.cacheWrite || 0;
  into.cost += u.cost?.total || 0;
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) || 0) + by);
}

// Gets the paths of all session jsonl files on disk. SessionManager.listAll() finds
// every session across all projects and handles PI_CODING_AGENT_DIR on its own.
// SessionInfo has no tokens/cost, so we only pull out the path.
async function listAllSessionFiles(): Promise<string[]> {
  try {
    const infos = await SessionManager.listAll();
    return infos.map((i) => i.path).filter((p): p is string => typeof p === "string");
  } catch {
    return [];
  }
}

function firstLineText(content: string | any[]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const blk of content) {
      if (blk && blk.type === "text" && typeof blk.text === "string") return blk.text;
    }
  }
  return "";
}

// ms → local yyyy-mm-dd (bucket dates by the user's timezone, not UTC).
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// Streams a single session file and aggregates it into a SessionStats.
async function aggregateFile(file: string): Promise<SessionStats | undefined> {
  const stats: SessionStats = {
    file,
    id: "",
    cwd: "",
    firstUserText: "",
    startedAt: 0,
    endedAt: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    tokens: emptyTokens(),
    tools: new Map(),
    models: new Map(),
    days: new Set(),
    costByDay: new Map(),
    byHour: new Array(24).fill(0),
    byWeekday: new Array(7).fill(0),
  };

  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf8" });
  } catch {
    return undefined;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  let sawAny = false;
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let e: any;
    try {
      e = JSON.parse(trimmed);
    } catch {
      continue; // skip broken lines
    }
    sawAny = true;

    // header
    if (e.type === "session") {
      stats.id = e.id || stats.id;
      stats.cwd = e.cwd || stats.cwd;
      continue;
    }

    // display name
    if (e.type === "session_info" && typeof e.name === "string") {
      stats.name = e.name;
    }

    // date/time range (uses the entry-level ISO timestamp, bucketed by local date)
    const tsIso: string | undefined = typeof e.timestamp === "string" ? e.timestamp : undefined;
    let tsMs = Number.NaN;
    if (tsIso) {
      tsMs = Date.parse(tsIso);
      if (!Number.isNaN(tsMs)) {
        if (stats.startedAt === 0 || tsMs < stats.startedAt) stats.startedAt = tsMs;
        if (tsMs > stats.endedAt) stats.endedAt = tsMs;
        stats.days.add(localDayKey(tsMs));
      }
    }

    if (e.type !== "message") continue;
    const m = e.message;
    if (!m || typeof m !== "object") continue;

    if (m.role === "user") {
      stats.userMessages++;
      if (!stats.firstUserText) stats.firstUserText = firstLineText(m.content).slice(0, 200);
    } else if (m.role === "assistant") {
      stats.assistantMessages++;
      addTokens(stats.tokens, m.usage);
      if (typeof m.model === "string") bump(stats.models, m.model);
      const cost = m.usage?.cost?.total || 0;
      if (!Number.isNaN(tsMs)) {
        if (cost > 0) bump(stats.costByDay, localDayKey(tsMs), cost);
        const d = new Date(tsMs);
        stats.byHour[d.getHours()]++;
        stats.byWeekday[d.getDay()]++;
      }
      if (Array.isArray(m.content)) {
        for (const blk of m.content) {
          if (blk && blk.type === "toolCall" && typeof blk.name === "string") {
            bump(stats.tools, blk.name);
          }
        }
      }
    } else if (m.role === "toolResult") {
      stats.toolResults++;
    }
  }

  if (!sawAny) return undefined;
  return stats;
}

// Combines multiple SessionStats into a global aggregate.
function combine(sessions: SessionStats[]): AggregateStats {
  const agg: AggregateStats = {
    sessions,
    totalSessions: sessions.length,
    totalMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    tokens: emptyTokens(),
    tools: new Map(),
    models: new Map(),
    days: new Set(),
    costByDay: new Map(),
    byHour: new Array(24).fill(0),
    byWeekday: new Array(7).fill(0),
    firstActivity: 0,
    lastActivity: 0,
  };

  for (const s of sessions) {
    agg.userMessages += s.userMessages;
    agg.assistantMessages += s.assistantMessages;
    agg.toolResults += s.toolResults;
    agg.tokens.input += s.tokens.input;
    agg.tokens.output += s.tokens.output;
    agg.tokens.cacheRead += s.tokens.cacheRead;
    agg.tokens.cacheWrite += s.tokens.cacheWrite;
    agg.tokens.cost += s.tokens.cost;
    for (const [k, v] of s.tools) bump(agg.tools, k, v);
    for (const [k, v] of s.models) bump(agg.models, k, v);
    for (const [k, v] of s.costByDay) bump(agg.costByDay, k, v);
    for (const d of s.days) agg.days.add(d);
    for (let h = 0; h < 24; h++) agg.byHour[h] += s.byHour[h] || 0;
    for (let w = 0; w < 7; w++) agg.byWeekday[w] += s.byWeekday[w] || 0;
    if (s.startedAt > 0 && (agg.firstActivity === 0 || s.startedAt < agg.firstActivity))
      agg.firstActivity = s.startedAt;
    if (s.endedAt > agg.lastActivity) agg.lastActivity = s.endedAt;
  }
  agg.totalMessages = agg.userMessages + agg.assistantMessages + agg.toolResults;
  return agg;
}

// Per-day cost is accumulated into each day from per-entry cost during the main pass (aggregateFile).

// ─── Public API ────────────────────────────────────────────────────────────

// Global: aggregate every session across all projects (SessionManager.listAll()).
export async function aggregateGlobal(
  onProgress?: (loaded: number, total: number) => void,
): Promise<AggregateStats> {
  const files = await listAllSessionFiles();
  const sessions: SessionStats[] = [];
  let loaded = 0;
  for (const f of files) {
    const s = await aggregateFile(f);
    loaded++;
    onProgress?.(loaded, files.length);
    if (s) sessions.push(s);
  }
  // sort by most recent activity
  sessions.sort((a, b) => b.endedAt - a.endedAt);
  return combine(sessions);
}

// Aggregate a single session file only (for the current-session tab).
export async function aggregateSession(file: string): Promise<AggregateStats> {
  const s = await aggregateFile(file);
  return combine(s ? [s] : []);
}

// Wraps a single already-aggregated SessionStats into a dashboard AggregateStats (session drill-down on the global tab).
export function statsFromSession(s: SessionStats): AggregateStats {
  return combine([s]);
}

// Result of the activity streak calculation.
export interface StreakInfo {
  current: number; // consecutive active days running up to today (or yesterday)
  longest: number; // longest run of consecutive active days ever
}

// Computes the current/longest streak from a set of days (local yyyy-mm-dd).
// current counts consecutive days starting from today or yesterday (kept even if there's been no activity today yet).
export function computeStreak(days: Set<string>): StreakInfo {
  if (days.size === 0) return { current: 0, longest: 0 };
  // convert yyyy-mm-dd to a day number (based on local midnight) to compare adjacent days.
  const toNum = (key: string): number => {
    const [y, m, d] = key.split("-").map(Number);
    return Math.floor(new Date(y, m - 1, d).getTime() / 86400000);
  };
  const nums = [...days].map(toNum).sort((a, b) => a - b);

  // longest streak
  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) run++;
    else if (nums[i] !== nums[i - 1]) run = 1;
    if (run > longest) longest = run;
  }

  // current streak: count consecutive days backward from today. If there's no activity today, start from yesterday.
  const set = new Set(nums);
  const now = new Date();
  const today = Math.floor(
    new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 86400000,
  );
  let cursor = set.has(today) ? today : set.has(today - 1) ? today - 1 : Number.NaN;
  let current = 0;
  while (!Number.isNaN(cursor) && set.has(cursor)) {
    current++;
    cursor--;
  }
  return { current, longest };
}
