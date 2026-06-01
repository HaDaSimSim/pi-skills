// stats — pi 사용 내역 대시보드. opencode 의 `stats` 처럼 세션/글로벌 사용량을
// 풀스크린 TUI 로 보여준다.
//
// 동작:
//   /stats           → 풀스크린 오버레이 (Session 탭으로 시작)
//   pi --tools ... 와 무관하게 LLM 컨텍스트엔 0 영향(순수 뷰어 + 디스크 읽기 전용).
//
// 탭:
//   [Session]  현재 세션만 집계
//   [Global]   ~/.pi/agent/sessions/ 아래 전체 세션 집계 + 세션 리스트 드릴다운
//
// 키:
//   Tab / ← →     탭 전환 (Session ↔ Global)
//   ↑↓ / j k      스크롤 (1줄)
//   Space / b     페이지 다운/업
//   g / G         맨 위 / 맨 아래
//   s             (Global) 세션 리스트 토글
//   Enter         (세션 리스트) 선택 세션 드릴다운
//   Esc / q       닫기 (드릴다운/리스트면 한 단계 위로)
//
// 단축키는 두지 않는다: 쓸 만한 ctrl 조합은 대부분 내장 바인딩과 겹치고(ctrl+s 는
// app.models.save), 비어있는 조합은 터미널 흐름제어에 먹혀 신뢰할 수 없다. 원하면
// keybindings 설정에서 직접 /stats 에 키를 바인딩하면 된다.
//
// 데이터: aggregate.ts 가 jsonl 을 스트리밍 파싱(읽기 전용). 자식 subagent
// 프로세스에선 뜨지 않게 PI_SUBAGENT 가드.

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Focusable, type TUI, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
  type AggregateStats,
  aggregateGlobal,
  aggregateSession,
  computeStreak,
  type SessionStats,
  statsFromSession,
} from "./aggregate.ts";
import { type BarRow, formatCost, formatInt, formatTokens, type KV, renderBars, renderBox, renderHourHeatmap, truncate } from "./format.ts";

export default function statsExtension(pi: ExtensionAPI) {
  if (process.env.PI_SUBAGENT) return; // 자식 프로세스에선 비활성

  async function openStats(ctx: ExtensionContext): Promise<void> {
    if (!ctx.hasUI) return;

    const sessionFile = ctx.sessionManager.getSessionFile();

    // 먼저 로딩 표시. 큰 글로벌 집계는 시간이 걸릴 수 있다.
    ctx.ui.setStatus("stats", "Computing stats…");

    // 현재 세션 집계(파일 없으면 ephemeral → 빈 집계).
    let sessionAgg: AggregateStats;
    try {
      sessionAgg = sessionFile ? await aggregateSession(sessionFile) : statsFromSessionEmpty();
    } catch {
      sessionAgg = statsFromSessionEmpty();
    }

    // 글로벌 집계.
    let globalAgg: AggregateStats;
    try {
      globalAgg = await aggregateGlobal();
    } catch {
      globalAgg = statsFromSessionEmpty();
    }

    ctx.ui.setStatus("stats", undefined);

    await ctx.ui.custom<void>(
      (tui, theme, _kb, done) => new StatsViewer(sessionAgg, globalAgg, sessionFile, theme, tui, done),
      {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left" },
      },
    );
  }

  pi.registerCommand("stats", {
    description: "Show usage stats (session & global) in a fullscreen dashboard",
    handler: async (_args, ctx) => {
      await openStats(ctx);
    },
  });
}

function statsFromSessionEmpty(): AggregateStats {
  return {
    sessions: [],
    totalSessions: 0,
    totalMessages: 0,
    userMessages: 0,
    assistantMessages: 0,
    toolResults: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    tools: new Map(),
    models: new Map(),
    days: new Set(),
    costByDay: new Map(),
    byHour: new Array(24).fill(0),
    byWeekday: new Array(7).fill(0),
    firstActivity: 0,
    lastActivity: 0,
  };
}

// ─── 뷰어 컴포넌트 ───────────────────────────────────────────────────────────

type Tab = "session" | "global";
type View = "dashboard" | "list" | "detail";

class StatsViewer implements Focusable {
  focused = false;
  private tab: Tab = "session";
  private view: View = "dashboard";
  private scroll = 0; // dashboard/detail 스크롤
  private selected = 0; // 세션 리스트 선택
  private listScroll = 0; // 세션 리스트 스크롤
  private detailAgg?: AggregateStats; // 드릴다운한 세션 집계

  constructor(
    private sessionAgg: AggregateStats,
    private globalAgg: AggregateStats,
    private sessionFile: string | undefined,
    private theme: Theme,
    private tui: TUI,
    private done: (r: void) => void,
  ) {}

  private get rows(): number {
    return Math.max(10, (this.tui.terminal.rows || 30) - 1);
  }

  private get pageStep(): number {
    return Math.max(3, this.rows - 6);
  }

  handleInput(data: string): void {
    // 닫기 / 뒤로
    if (matchesKey(data, "escape") || data === "q") {
      if (this.view === "detail") {
        this.view = "list";
        this.scroll = 0;
        this.detailAgg = undefined;
      } else if (this.view === "list") {
        this.view = "dashboard";
        this.scroll = 0;
      } else {
        this.done();
      }
      return;
    }

    // 탭 전환 (dashboard 에서만)
    if (this.view === "dashboard" && (matchesKey(data, "tab") || matchesKey(data, "left") || matchesKey(data, "right"))) {
      this.tab = this.tab === "session" ? "global" : "session";
      this.scroll = 0;
      return;
    }

    // Global 탭: 세션 리스트 토글
    if (this.tab === "global" && this.view === "dashboard" && data === "s") {
      if (this.globalAgg.sessions.length > 0) {
        this.view = "list";
        this.selected = 0;
        this.listScroll = 0;
      }
      return;
    }

    if (this.view === "list") {
      this.handleListInput(data);
      return;
    }

    // dashboard / detail 스크롤
    const page = this.pageStep;
    if (matchesKey(data, "up") || data === "k") this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, "down") || data === "j") this.scroll += 1;
    else if (matchesKey(data, "pageUp") || data === "b") this.scroll = Math.max(0, this.scroll - page);
    else if (matchesKey(data, "pageDown") || data === " ") this.scroll += page;
    else if (data === "g" || matchesKey(data, "home")) this.scroll = 0;
    else if (data === "G" || matchesKey(data, "end")) this.scroll = Number.MAX_SAFE_INTEGER;
  }

  private handleListInput(data: string): void {
    const last = this.globalAgg.sessions.length - 1;
    if (matchesKey(data, "up") || data === "k") this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, "down") || data === "j") this.selected = Math.min(last, this.selected + 1);
    else if (matchesKey(data, "pageUp") || data === "b") this.selected = Math.max(0, this.selected - 10);
    else if (matchesKey(data, "pageDown") || data === " ") this.selected = Math.min(last, this.selected + 10);
    else if (data === "g" || matchesKey(data, "home")) this.selected = 0;
    else if (data === "G" || matchesKey(data, "end")) this.selected = last;
    else if (matchesKey(data, "return")) {
      const s = this.globalAgg.sessions[this.selected];
      if (s) {
        this.detailAgg = statsFromSession(s);
        this.view = "detail";
        this.scroll = 0;
      }
    }
  }

  // ── 렌더 ────────────────────────────────────────────────────────────────

  render(width: number): string[] {
    const innerW = width - 2;
    const rows = this.rows;
    const header = this.renderHeader(innerW);
    const footer = this.renderFooter(innerW);
    const viewport = Math.max(3, rows - header.length - 1);

    let body: string[];
    if (this.view === "list") {
      body = this.renderSessionList(innerW, viewport);
      // 리스트는 자체적으로 viewport 에 맞춰 잘려 나온다.
      const lines = [...header, ...body];
      while (lines.length < rows - 1) lines.push("");
      lines.push(footer);
      return lines.map((l) => truncateToWidth(" " + l, innerW + 2));
    }

    // dashboard / detail: 전체 body 를 만든 뒤 scroll 로 슬라이스
    const agg = this.view === "detail" ? this.detailAgg! : this.tab === "session" ? this.sessionAgg : this.globalAgg;
    body = this.renderDashboard(innerW, agg, this.tab === "global" && this.view === "dashboard");

    const maxScroll = Math.max(0, body.length - viewport);
    if (this.scroll > maxScroll) this.scroll = maxScroll;
    const slice = body.slice(this.scroll, this.scroll + viewport);

    const lines = [...header, ...slice];
    while (lines.length < rows - 1) lines.push("");
    lines.push(this.renderFooterWithScroll(innerW, body.length, viewport));
    return lines.map((l) => truncateToWidth(" " + l, innerW + 2));
  }

  private renderHeader(innerW: number): string[] {
    const th = this.theme;
    if (this.view === "detail") {
      const s = this.detailAgg!.sessions[0];
      const label = sessionLabel(s);
      return [
        " " + th.bold(th.fg("accent", "📊 pi stats")) + th.fg("dim", "  ▸ session detail"),
        " " + th.fg("text", truncate(label, innerW - 4)),
        "",
      ];
    }
    if (this.view === "list") {
      return [
        " " + th.bold(th.fg("accent", "📊 pi stats")) + th.fg("dim", `  ▸ sessions (${this.globalAgg.sessions.length})`),
        "",
      ];
    }
    // dashboard: 탭바
    const sessionTab = this.tabLabel("Session", this.tab === "session");
    const globalTab = this.tabLabel("Global", this.tab === "global");
    return [" " + th.bold(th.fg("accent", "📊 pi stats")) + "   " + sessionTab + " " + globalTab, ""];
  }

  private tabLabel(text: string, active: boolean): string {
    const th = this.theme;
    if (active) return th.bold(th.fg("accent", `▸ ${text} ◂`));
    return th.fg("dim", `  ${text}  `);
  }

  private renderFooter(innerW: number): string {
    return this.renderFooterWithScroll(innerW, 0, 0);
  }

  private renderFooterWithScroll(innerW: number, bodyLen: number, viewport: number): string {
    const th = this.theme;
    let keys: string;
    if (this.view === "list") {
      keys = "↑↓/jk select · space/b page · g/G ends · Enter open · Esc back";
    } else if (this.view === "detail") {
      keys = "↑↓/jk scroll · space/b page · g/G ends · Esc back";
    } else {
      const sessionKey = this.tab === "global" ? " · s sessions" : "";
      keys = `Tab/←→ switch · ↑↓/jk scroll · space/b page${sessionKey} · q/Esc close`;
    }
    let pos = "";
    if ((this.view === "dashboard" || this.view === "detail") && bodyLen > viewport && viewport > 0) {
      const end = Math.min(bodyLen, this.scroll + viewport);
      pos = `  [${this.scroll + 1}-${end}/${bodyLen}]`;
    }
    return th.fg("dim", " " + keys + pos);
  }

  // 대시보드 본문: Overview, Cost & Tokens, Models, Tools (+ Global 이면 활동 일자).
  private renderDashboard(innerW: number, agg: AggregateStats, isGlobal: boolean): string[] {
    const th = this.theme;
    const out: string[] = [];
    const boxW = Math.min(64, innerW - 1);

    if (agg.totalMessages === 0 && agg.totalSessions === 0) {
      out.push("");
      out.push(" " + th.fg("muted", "No usage data yet."));
      if (this.tab === "session" && !this.sessionFile) {
        out.push(" " + th.fg("dim", "This is an ephemeral session (--no-session), so nothing is recorded."));
      }
      return out;
    }

    // Overview
    const days = agg.days.size;
    const overview: KV[] = [];
    if (isGlobal) overview.push({ label: "Sessions", value: formatInt(agg.totalSessions), accent: true });
    overview.push({ label: "Messages", value: formatInt(agg.totalMessages), accent: true });
    overview.push({ label: "  User", value: formatInt(agg.userMessages) });
    overview.push({ label: "  Assistant", value: formatInt(agg.assistantMessages) });
    overview.push({ label: "  Tool results", value: formatInt(agg.toolResults) });
    if (days > 0) overview.push({ label: "Active days", value: formatInt(days) });
    const streak = computeStreak(agg.days);
    if (streak.current > 0 || streak.longest > 0) {
      overview.push({ label: "Current streak", value: `${streak.current}d`, accent: streak.current > 0 });
      overview.push({ label: "Longest streak", value: `${streak.longest}d` });
    }
    if (agg.firstActivity > 0) {
      overview.push({ label: "First activity", value: formatDate(agg.firstActivity) });
      overview.push({ label: "Last activity", value: formatDate(agg.lastActivity) });
    }
    pushSection(out, renderBox(th, boxW, "Overview", overview));

    // Cost & Tokens
    const t = agg.tokens;
    const costRows: KV[] = [];
    costRows.push({ label: "Total cost", value: formatCost(t.cost), accent: true });
    if (days > 0) costRows.push({ label: "Avg cost/day", value: formatCost(t.cost / days) });
    if (isGlobal && agg.totalSessions > 0) {
      costRows.push({ label: "Avg cost/session", value: formatCost(t.cost / agg.totalSessions) });
    }
    if (agg.assistantMessages > 0) {
      costRows.push({ label: "Avg cost/msg", value: formatCost(t.cost / agg.assistantMessages) });
    }
    costRows.push({ label: "Input tokens", value: formatTokens(t.input) });
    costRows.push({ label: "Output tokens", value: formatTokens(t.output) });
    if (t.cacheRead > 0) costRows.push({ label: "Cache read", value: formatTokens(t.cacheRead) });
    if (t.cacheWrite > 0) costRows.push({ label: "Cache write", value: formatTokens(t.cacheWrite) });
    costRows.push({ label: "Total tokens", value: formatTokens(t.input + t.output), accent: true });
    pushSection(out, renderBox(th, boxW, "Cost & Tokens", costRows));

    // Models (assistant 메시지 수 기준)
    const modelRows: BarRow[] = [...agg.models.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    if (modelRows.length > 0) {
      pushSection(out, renderBars(th, boxW, "Models", modelRows, 12));
    }

    // Tools (호출 수 기준)
    const toolRows: BarRow[] = [...agg.tools.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count);
    if (toolRows.length > 0) {
      pushSection(out, renderBars(th, boxW, "Tool Usage", toolRows, 20));
    }

    // Activity by hour (로컬 시간대 히트맵) + 요일별 막대
    const hourTotal = agg.byHour.reduce((a, b) => a + b, 0);
    if (hourTotal > 0) {
      pushSection(out, renderHourHeatmap(th, boxW, "Activity by Hour", agg.byHour));
      const weekdayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const weekdayRows: BarRow[] = agg.byWeekday
        .map((count, i) => ({ label: weekdayNames[i], count }))
        .filter((r) => r.count > 0);
      if (weekdayRows.length > 0) {
        pushSection(out, renderBars(th, boxW, "Activity by Weekday", weekdayRows, 7));
      }
    }

    // Global: 최근 일자별 비용 (최대 14일)
    if (isGlobal && agg.costByDay.size > 0) {
      const dayKV: KV[] = [...agg.costByDay.entries()]
        .sort((a, b) => (a[0] < b[0] ? 1 : -1)) // 최신 먼저
        .slice(0, 14)
        .map(([day, cost]) => ({ label: day, value: formatCost(cost) }));
      pushSection(out, renderBox(th, boxW, "Cost by Day (recent)", dayKV));
    }

    // Global dashboard: 세션 리스트 진입 힌트
    if (isGlobal && agg.sessions.length > 0) {
      out.push(" " + th.fg("dim", `Press 's' to browse ${agg.sessions.length} sessions →`));
      out.push("");
    }

    return out;
  }

  // 세션 리스트(글로벌 드릴다운). 각 항목 2줄.
  private renderSessionList(innerW: number, viewport: number): string[] {
    const th = this.theme;
    const sessions = this.globalAgg.sessions;
    const rowsPerItem = 2;
    const itemsVisible = Math.max(1, Math.floor(viewport / rowsPerItem));

    if (this.selected < this.listScroll) this.listScroll = this.selected;
    else if (this.selected >= this.listScroll + itemsVisible) this.listScroll = this.selected - itemsVisible + 1;
    const maxListScroll = Math.max(0, sessions.length - itemsVisible);
    if (this.listScroll > maxListScroll) this.listScroll = maxListScroll;

    const body: string[] = [];
    const end = Math.min(sessions.length, this.listScroll + itemsVisible);
    for (let i = this.listScroll; i < end; i++) {
      const s = sessions[i];
      const sel = i === this.selected;
      const prefix = sel ? th.fg("accent", " ▶ ") : "   ";
      const label = sessionLabel(s);
      const titleMax = Math.max(12, innerW - 8);
      const title = truncate(label, titleMax);
      const head = `${prefix}${sel ? th.fg("text", title) : th.fg("muted", title)}`;
      const tokens = formatTokens(s.tokens.input + s.tokens.output);
      const meta = `${formatCost(s.tokens.cost)} · ${tokens} tok · ${s.assistantMessages} msg · ${formatDate(s.endedAt)}`;
      const cwdShort = shortCwd(s.cwd);
      body.push(head);
      body.push("     " + th.fg("dim", `${meta}  ·  ${truncate(cwdShort, Math.max(10, innerW - 50))}`));
    }
    if (sessions.length === 0) body.push(" " + th.fg("dim", "(no sessions)"));
    return body;
  }

  invalidate(): void {}
  dispose(): void {}
}

// ─── 헬퍼 ────────────────────────────────────────────────────────────────

function pushSection(out: string[], box: string[]): void {
  for (const l of box) out.push(l);
  out.push("");
}

function sessionLabel(s: SessionStats): string {
  if (s.name) return s.name;
  if (s.firstUserText) return s.firstUserText.replace(/\s+/g, " ").trim();
  return s.id || s.file;
}

function shortCwd(cwd: string): string {
  if (!cwd) return "";
  const home = process.env.HOME;
  if (home && cwd.startsWith(home)) return "~" + cwd.slice(home.length);
  return cwd;
}

function formatDate(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, "0");
  const da = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${mo}-${da} ${hh}:${mm}`;
}
