// Sanitize captured command output before it is persisted/rendered.
//
// Literal TABs and other C0 control characters break pi-tui's width
// calculation (visibleWidth counts TAB as several columns, but the
// compositor's sliceByColumn passes it through unchanged, so the widths
// diverge), causing a "Rendered line exceeds terminal width" crash. Before the
// text reaches any renderer (the persisted custom entry is read by pi-gui),
// expand TAB→spaces and strip other control characters so both calculations
// always agree.
//
// Why a separate module: index.ts uses class parameter properties, which can't
// be imported under node's strip-only execution (the test harness). This pure
// function is split out so it stays testable in isolation.
export function sanitizeForRender(text: string): string {
  if (!text) return text;
  let out = "";
  let col = 0;
  for (const ch of text) {
    if (ch === "\t") {
      // Expand the tab to spaces up to the next 4-column boundary.
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else if (ch === "\n") {
      out += ch;
      col = 0;
    } else if (ch === "\r") {
    } else {
      const code = ch.codePointAt(0) ?? 0;
      // Strip C0 control characters (except \n, handled above) and DEL.
      // Preserve everything else (width is delegated to pi-tui).
      if ((code >= 0x00 && code < 0x20) || code === 0x7f) continue;
      out += ch;
      col += 1;
    }
  }
  return out;
}

// Trim a string to a single-line display label of at most `max` characters,
// collapsing newlines to spaces and appending an ellipsis when truncated.
export function toLabel(text: string, max = 60): string {
  const oneLine = sanitizeForRender(text).replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1)}…`;
}
