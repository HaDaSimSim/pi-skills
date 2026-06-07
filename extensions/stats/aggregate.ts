// stats/aggregate — 세션 jsonl 을 직접 스트리밍으로 읽어 사용량을 집계한다.
//
// 왜 raw jsonl 직접 파싱인가:
//   - SessionManager.listAll() 이 주는 SessionInfo 엔 토큰/비용이 없다(메타데이터뿐).
//     어차피 각 파일의 엔트리를 봐야 하므로, 트리 인덱스를 만드는 getEntries() 보다
//     단순 라인 스캔이 가장 빠르고 메모리도 아낀다(11MB 짜리 파일도 스트리밍이면 OK).
//   - 분기(branch)된 세션은 활성 경로 밖 엔트리도 파일에 남는다. "실제로 발생한
//     사용량/비용" 관점에선 모든 assistant 메시지를 더하는 게 맞다(과금은 전부 일어났다).
//
// 집계 단위:
//   - 세션별(파일별) / 글로벌(전체 합) / 일자별(UTC yyyy-mm-dd) / 모델별 / 툴별.
//   - 툴 카운트는 assistant content 의 toolCall 블록 name 으로 센다("호출된 툴" 기준).

import * as fs from "node:fs";
import * as readline from "node:readline";
import { SessionManager } from "@earendil-works/pi-coding-agent";

// ─── 타입 ────────────────────────────────────────────────────────────────

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface SessionStats {
  file: string; // 세션 jsonl 절대경로
  id: string; // 세션 UUID (헤더)
  cwd: string; // 작업 디렉터리
  name?: string; // /name 으로 지정한 표시 이름
  firstUserText: string; // 첫 user 메시지(이름 없을 때 라벨용)
  startedAt: number; // 첫 엔트리 timestamp (ms)
  endedAt: number; // 마지막 엔트리 timestamp (ms)
  userMessages: number;
  assistantMessages: number;
  toolResults: number;
  tokens: TokenTotals;
  tools: Map<string, number>; // toolName -> count
  models: Map<string, number>; // model -> assistant message count
  days: Set<string>; // 활동한 날짜(로컬 yyyy-mm-dd)
  costByDay: Map<string, number>; // yyyy-mm-dd -> cost
  byHour: number[]; // [0..23] 시간대별 메시지 수(로컬)
  byWeekday: number[]; // [0..6] 요일별 메시지 수(일=0, 로컬)
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
  days: Set<string>; // 전체 활동 날짜(로컬)
  costByDay: Map<string, number>; // yyyy-mm-dd -> cost
  byHour: number[]; // [0..23]
  byWeekday: number[]; // [0..6]
  firstActivity: number; // ms
  lastActivity: number; // ms
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────

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

// 디스크의 모든 세션 jsonl 경로를 받는다. SessionManager.listAll() 이 모든
// 프로젝트의 모든 세션을 찾아주고 PI_CODING_AGENT_DIR 도 알아서 처리한다.
// SessionInfo 엔 토큰/비용이 없으므로 경로(path)만 귫어 쓴다.
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

// ms → 로컬 yyyy-mm-dd (UTC 아닌 사용자 타임존 기준으로 날짜 버킷팅).
function localDayKey(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  return `${y}-${mo}-${da}`;
}

// 한 세션 파일을 스트리밍으로 읽어 SessionStats 로 집계.
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
      continue; // 깨진 라인은 건너뛴다
    }
    sawAny = true;

    // 헤더
    if (e.type === "session") {
      stats.id = e.id || stats.id;
      stats.cwd = e.cwd || stats.cwd;
      continue;
    }

    // 표시 이름
    if (e.type === "session_info" && typeof e.name === "string") {
      stats.name = e.name;
    }

    // 날짜/시간 범위 (엔트리 레벨 ISO timestamp 사용, 로컬 날짜로 버킷팅)
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

// 여러 SessionStats 를 글로벌로 합친다.
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

// 일자별 비용은 메인 패스(aggregateFile)에서 엔트리별 cost 를 day 에 누적해 둔다.

// ─── 공개 API ─────────────────────────────────────────────────────────────

// 글로벌: 모든 프로젝트의 모든 세션을 집계(SessionManager.listAll()).
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
  // 최근 활동 순 정렬
  sessions.sort((a, b) => b.endedAt - a.endedAt);
  return combine(sessions);
}

// 단일 세션 파일만 집계 (현재 세션 탭용).
export async function aggregateSession(file: string): Promise<AggregateStats> {
  const s = await aggregateFile(file);
  return combine(s ? [s] : []);
}

// 이미 집계된 SessionStats 하나를 대시보드용 AggregateStats 로 래핑(글로벌 탭의 세션 드릴다운).
export function statsFromSession(s: SessionStats): AggregateStats {
  return combine([s]);
}

// 활동 streak 계산 결과.
export interface StreakInfo {
  current: number; // 오늘(또는 어제)까지 이어지는 연속 활동일
  longest: number; // 역대 최장 연속 활동일
}

// days(로컬 yyyy-mm-dd) 집합에서 현재/최장 streak 를 계산.
// current 는 오늘 또는 어제에서 시작해 연속된 날을 센다(오늘 아직 활동 전이어도 유지).
export function computeStreak(days: Set<string>): StreakInfo {
  if (days.size === 0) return { current: 0, longest: 0 };
  // yyyy-mm-dd 를 � 수로 변환(로컬 자정 기준) 해 인접일 비교.
  const toNum = (key: string): number => {
    const [y, m, d] = key.split("-").map(Number);
    return Math.floor(new Date(y, m - 1, d).getTime() / 86400000);
  };
  const nums = [...days].map(toNum).sort((a, b) => a - b);

  // 최장 streak
  let longest = 1;
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) run++;
    else if (nums[i] !== nums[i - 1]) run = 1;
    if (run > longest) longest = run;
  }

  // 현재 streak: 오늘부터 거꾸로 연속된 날 세기. 오늘 활동이 없으면 어제부터.
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
