// stats/format — number formatting + box/bar-chart render helpers.
//
// To avoid clashing with pi-tui's width calculation, every line built here uses only
// ASCII/box-drawing characters and applies ANSI color via theme.fg only. The caller clamps once more with truncateToWidth.

import type { Theme } from "@earendil-works/pi-coding-agent";

// 1234567 -> "1.2M", 12345 -> "12k", 999 -> "999"
export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(2)}M`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

// Integer with thousands separators.
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

// Cost. Large values get commas, small values show more decimals.
export function formatCost(n: number): string {
  if (n >= 100)
    return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(4)}`;
}

// milliseconds → short duration like "3d", "5h", "12m", "<1m".
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

// One box section. Wraps the title header + key/value lines in a │ … │ box.
// width is the outer box width (including borders).
export interface KV {
  label: string;
  value: string;
  accent?: boolean; // render value in the accent color
}

export function renderBox(theme: Theme, width: number, title: string, rows: KV[]): string[] {
  const inner = Math.max(10, width - 2); // inner width of │
  const out: string[] = [];
  const top = `┌${"─".repeat(inner)}┐`;
  const mid = `├${"─".repeat(inner)}┤`;
  const bot = `└${"─".repeat(inner)}┘`;
  out.push(theme.fg("dim", top));
  // center-aligned title
  out.push(
    theme.fg("dim", "│") +
      centerStyled(theme, title.toUpperCase(), inner, "accent", true) +
      theme.fg("dim", "│"),
  );
  out.push(theme.fg("dim", mid));
  for (const r of rows) {
    const labelCol = r.label;
    const valueCol = r.value;
    const pad = inner - visibleLen(labelCol) - visibleLen(valueCol) - 2; // 1 space on each side
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

// One bar-chart line: label ███████ count (pct%)
// Distributes maxBar cells proportionally to the maximum value.
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
  const top = `┌${"─".repeat(inner)}┐`;
  const mid = `├${"─".repeat(inner)}┤`;
  const bot = `└${"─".repeat(inner)}┘`;
  out.push(theme.fg("dim", top));
  out.push(
    theme.fg("dim", "│") +
      centerStyled(theme, title.toUpperCase(), inner, "accent", true) +
      theme.fg("dim", "│"),
  );
  out.push(theme.fg("dim", mid));

  const total = rows.reduce((a, r) => a + r.count, 0) || 1;
  const max = rows.reduce((a, r) => Math.max(a, r.count), 0) || 1;
  const shown = rows.slice(0, maxRows);

  // compute column widths: label (fixed) + bar + " count (pct%)"
  const labelW = Math.min(18, Math.max(8, ...shown.map((r) => r.label.length)));
  // the right-side number area width is based on the longest "count (pct%)".
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
    out.push(
      theme.fg("dim", "│") +
        clampStyled(` ${theme.fg("dim", "(none)")}`, inner) +
        theme.fg("dim", "│"),
    );
  }
  out.push(theme.fg("dim", bot));
  return out;
}

// Hour-of-day (24) heatmap: each hour shown as one density block. Ticks 0/6/12/18/23 below.
// counts is [0..23] message counts.
export function renderHourHeatmap(
  theme: Theme,
  width: number,
  title: string,
  counts: number[],
): string[] {
  const inner = Math.max(28, width - 2);
  const out: string[] = [];
  out.push(theme.fg("dim", `┌${"─".repeat(inner)}┐`));
  out.push(
    theme.fg("dim", "│") +
      centerStyled(theme, title.toUpperCase(), inner, "accent", true) +
      theme.fg("dim", "│"),
  );
  out.push(theme.fg("dim", `├${"─".repeat(inner)}┤`));

  const max = counts.reduce((a, b) => Math.max(a, b), 0) || 1;
  const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const peakHour = counts.indexOf(Math.max(...counts));

  const cells = counts
    .map((c) => {
      const lvl = c === 0 ? 0 : Math.max(1, Math.round((c / max) * 8));
      return blocks[lvl];
    })
    .join("");
  const bar = ` ${theme.fg("accent", cells)}`;
  out.push(theme.fg("dim", "│") + clampStyled(bar, inner) + theme.fg("dim", "│"));

  // ruler line: roughly aligned to the 0 / 6 / 12 / 18 / 23 positions.
  const ruler = buildHourRuler();
  out.push(
    theme.fg("dim", "│") + clampStyled(` ${theme.fg("dim", ruler)}`, inner) + theme.fg("dim", "│"),
  );

  // peak hour summary.
  const peakLine = ` ${theme.fg("muted", "peak")} ${theme.fg("text", `${pad2(peakHour)}:00`)} ${theme.fg("dim", `(${formatInt(counts[peakHour] || 0)} msgs)`)}`;
  out.push(theme.fg("dim", "│") + clampStyled(peakLine, inner) + theme.fg("dim", "│"));

  out.push(theme.fg("dim", `└${"─".repeat(inner)}┘`));
  return out;
}

// Approximate one-line ruler "0   6   12  18 23" below the 24 blocks (aligned to 24 cells).
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

// ─── Small helpers ────────────────────────────────────────────────

function pct(n: number, total: number): string {
  const p = (n / total) * 100;
  if (p >= 10) return `${p.toFixed(1)}%`;
  return `${p.toFixed(1)}%`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return `${s.slice(0, max - 1)}…`;
}

function padRight(s: string, w: number): string {
  const len = visibleLen(s);
  return len >= w ? s : s + " ".repeat(w - len);
}

function padLeft(s: string, w: number): string {
  const len = visibleLen(s);
  return len >= w ? s : " ".repeat(w - len) + s;
}

// Length assuming no ANSI (what comes in here is plain text before coloring).
function visibleLen(s: string): number {
  // Combining emoji / wide chars are rare, so approximate by length. The caller's truncateToWidth is the final defense.
  return [...s].length;
}

// Right-pads a colored line to the inner width (approximated by plain-text length).
// Since the string is already colored, exact width calculation is left to the caller's truncateToWidth;
// here we just fill the shortfall with spaces so the box's right border stays aligned.
function clampStyled(styled: string, inner: number): string {
  const plainLen = stripAnsiLen(styled);
  if (plainLen >= inner) return styled;
  return styled + " ".repeat(inner - plainLen);
}

function centerStyled(
  theme: Theme,
  text: string,
  inner: number,
  color: string,
  bold: boolean,
): string {
  const t = truncate(text, inner);
  const len = [...t].length;
  const leftPad = Math.max(0, Math.floor((inner - len) / 2));
  const rightPad = Math.max(0, inner - len - leftPad);
  const styled = bold ? theme.bold(theme.fg(color as never, t)) : theme.fg(color as never, t);
  return " ".repeat(leftPad) + styled + " ".repeat(rightPad);
}

// Visible length excluding ANSI escapes.
function stripAnsiLen(s: string): number {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR escape sequences requires the ESC control char
  const plain = s.replace(/\u001b\[[0-9;]*m/g, "");
  return [...plain].length;
}
