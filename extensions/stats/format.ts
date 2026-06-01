// stats/format — 숫자 포매팅 + 박스/막대그래프 렌더 헬퍼.
//
// pi-tui 의 폭 계산과 충돌하지 않도록, 여기서 만드는 줄은 모두 ASCII/박스문자만
// 쓰고 ANSI 색은 theme.fg 로만 입힌다. 호출부에서 truncateToWidth 로 한 번 더 clamp.

import type { Theme } from "@earendil-works/pi-coding-agent";

// 1234567 -> "1.2M", 12345 -> "12k", 999 -> "999"
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// 정수에 천단위 콤마.
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// 비용. 큰 값은 콤마, 작은 값은 소수 더 보여줌.
export function formatCost(n: number): string {
  if (n >= 100) return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

// 밀리초 → "3d", "5h", "12m", "<1m" 같은 짧은 기간.
export function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// 박스 한 섹션. title 헤더 + key/value 줄들을 │ … │ 박스로 감싼다.
// width 는 박스 바깥 폭(테두리 포함).
export interface KV {
  label: string;
  value: string;
  accent?: boolean; // value 를 accent 색으로
}

export function renderBox(theme: Theme, width: number, title: string, rows: KV[]): string[] {
  const inner = Math.max(10, width - 2); // │ 안쪽 폭
  const out: string[] = [];
  const top = "┌" + "─".repeat(inner) + "┐";
  const mid = "├" + "─".repeat(inner) + "┤";
  const bot = "└" + "─".repeat(inner) + "┘";
  out.push(theme.fg("dim", top));
  // 가운데 정렬 타이틀
  out.push(theme.fg("dim", "│") + centerStyled(theme, title.toUpperCase(), inner, "accent", true) + theme.fg("dim", "│"));
  out.push(theme.fg("dim", mid));
  for (const r of rows) {
    const labelCol = r.label;
    const valueCol = r.value;
    const pad = inner - visibleLen(labelCol) - visibleLen(valueCol) - 2; // 양옆 1칸씩
    const padded = pad > 0 ? " ".repeat(pad) : " ";
    const line =
      " " +
      theme.fg("muted", labelCol) +
      padded +
      (r.accent ? theme.fg("accent", valueCol) : theme.fg("text", valueCol)) +
      " ";
    out.push(theme.fg("dim", "│") + clampStyled(line, inner) + theme.fg("dim", "│"));
  }
  out.push(theme.fg("dim", bot));
  return out;
}

// 막대그래프 한 줄: label ███████ count (pct%)
// maxBar 칸을 최댓값 기준으로 비례 배분.
export interface BarRow {
  label: string;
  count: number;
}

export function renderBars(
  theme: Theme,
  width: number,
  title: string,
  rows: BarRow[],
  maxRows: number,
): string[] {
  const inner = Math.max(20, width - 2);
  const out: string[] = [];
  const top = "┌" + "─".repeat(inner) + "┐";
  const mid = "├" + "─".repeat(inner) + "┤";
  const bot = "└" + "─".repeat(inner) + "┘";
  out.push(theme.fg("dim", top));
  out.push(theme.fg("dim", "│") + centerStyled(theme, title.toUpperCase(), inner, "accent", true) + theme.fg("dim", "│"));
  out.push(theme.fg("dim", mid));

  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  const max = rows.reduce((a, r) => Math.max(a, r.count), 0) || 1;
  const shown = rows.slice(0, maxRows);

  // 컬럼 폭 계산: label(고정) + bar + " count (pct%)"
  const labelW = Math.min(18, Math.max(8, ...shown.map((r) => r.label.length)));
  // 우측 숫자 영역 폭은 가장 긴 "count (pct%)" 기준.
  const numStrs = shown.map((r) => `${formatInt(r.count)} (${pct(r.count, total)})`);
  const numW = Math.max(...numStrs.map((s) => s.length), 6);
  const barW = Math.max(6, inner - 1 - labelW - 1 - 1 - numW - 1);

  for (let i = 0; i < shown.length; i++) {
    const r = shown[i];
    const label = padRight(truncate(r.label, labelW), labelW);
    const fill = Math.max(r.count > 0 ? 1 : 0, Math.round((r.count / max) * barW));
    const bar = "█".repeat(fill) + " ".repeat(Math.max(0, barW - fill));
    const num = padLeft(numStrs[i], numW);
    const line =
      " " +
      theme.fg("muted", label) +
      " " +
      theme.fg("accent", bar) +
      " " +
      theme.fg("text", num) +
      " ";
    out.push(theme.fg("dim", "│") + clampStyled(line, inner) + theme.fg("dim", "│"));
  }
  if (shown.length === 0) {
    out.push(theme.fg("dim", "│") + clampStyled(" " + theme.fg("dim", "(none)"), inner) + theme.fg("dim", "│"));
  }
  out.push(theme.fg("dim", bot));
  return out;
}

// 시간대(24) 히트맵: 각 시간을 농도 블록 한 칸으로 표현. 아래에 0/6/12/18/23 눈금.
// counts 는 [0..23] 메시지 수.
export function renderHourHeatmap(theme: Theme, width: number, title: string, counts: number[]): string[] {
  const inner = Math.max(28, width - 2);
  const out: string[] = [];
  out.push(theme.fg("dim", "┌" + "─".repeat(inner) + "┐"));
  out.push(theme.fg("dim", "│") + centerStyled(theme, title.toUpperCase(), inner, "accent", true) + theme.fg("dim", "│"));
  out.push(theme.fg("dim", "├" + "─".repeat(inner) + "┤"));

  const max = counts.reduce((a, b) => Math.max(a, b), 0) || 1;
  const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const peakHour = counts.indexOf(Math.max(...counts));

  const cells = counts
    .map((c) => {
      const lvl = c === 0 ? 0 : Math.max(1, Math.round((c / max) * 8));
      return blocks[lvl];
    })
    .join("");
  const bar = " " + theme.fg("accent", cells);
  out.push(theme.fg("dim", "│") + clampStyled(bar, inner) + theme.fg("dim", "│"));

  // 눈금 줄: 0 / 6 / 12 / 18 / 23 위치에 대략 맞춤.
  const ruler = buildHourRuler();
  out.push(theme.fg("dim", "│") + clampStyled(" " + theme.fg("dim", ruler), inner) + theme.fg("dim", "│"));

  // 피크 시간 요약.
  const peakLine = ` ${theme.fg("muted", "peak")} ${theme.fg("text", `${pad2(peakHour)}:00`)} ${theme.fg("dim", `(${formatInt(counts[peakHour] || 0)} msgs)`)}`;
  out.push(theme.fg("dim", "│") + clampStyled(peakLine, inner) + theme.fg("dim", "│"));

  out.push(theme.fg("dim", "└" + "─".repeat(inner) + "┘"));
  return out;
}

// 24칸 블록 아래 눈금 "0   6   12  18 23" 근사치 한 줄(24칸 정렬).
function buildHourRuler(): string {
  const slots = new Array(24).fill(" ");
  const marks: [number, string][] = [
    [0, "0"],
    [6, "6"],
    [12, "12"],
    [18, "18"],
    [22, "23"],
  ];
  for (const [h, label] of marks) {
    for (let i = 0; i < label.length; i++) {
      const pos = Math.min(23, h + i);
      slots[pos] = label[i];
    }
  }
  return slots.join("");
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// ─── 작은 헬퍼들 ───────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  const p = (n / total) * 100;
  if (p >= 10) return `${p.toFixed(1)}%`;
  return `${p.toFixed(1)}%`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function padRight(s: string, w: number): string {
  const len = visibleLen(s);
  return len >= w ? s : s + " ".repeat(w - len);
}

function padLeft(s: string, w: number): string {
  const len = visibleLen(s);
  return len >= w ? s : " ".repeat(w - len) + s;
}

// ANSI 없는 가정의 길이(여기 들어오는 건 색 입히기 전 평문).
function visibleLen(s: string): number {
  // 결합 이모지/와이드 문자는 드물어 대략 길이로 처리. 호출부 truncateToWidth 가 최종 방어.
  return [...s].length;
}

// 색 입힌 줄을 inner 폭에 맞게 우측 공백 패딩(평문 길이 기준 근사).
// 이미 색이 들어간 문자열이라 정확 폭 계산은 호출부 truncateToWidth 에 맡기고,
// 여기선 부족분만 공백으로 채워 박스 우측 테두리가 정렬되게 한다.
function clampStyled(styled: string, inner: number): string {
  const plainLen = stripAnsiLen(styled);
  if (plainLen >= inner) return styled;
  return styled + " ".repeat(inner - plainLen);
}

function centerStyled(theme: Theme, text: string, inner: number, color: string, bold: boolean): string {
  const t = truncate(text, inner);
  const len = [...t].length;
  const leftPad = Math.max(0, Math.floor((inner - len) / 2));
  const rightPad = Math.max(0, inner - len - leftPad);
  const styled = bold ? theme.bold(theme.fg(color as never, t)) : theme.fg(color as never, t);
  return " ".repeat(leftPad) + styled + " ".repeat(rightPad);
}

// ANSI 이스케이프를 뺀 가시 길이.
function stripAnsiLen(s: string): number {
  // eslint-disable-next-line no-control-regex
  const plain = s.replace(/\u001b\[[0-9;]*m/g, "");
  return [...plain].length;
}
