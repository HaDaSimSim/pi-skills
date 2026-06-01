// Standalone harness for the superpi phase state machine + spec-graph integration.
// Mocks the pi ExtensionAPI (including pi.exec → spec-graph CLI), drives transitions,
// asserts gating + flow + CLI gate behavior.
// Run: bash run-harness.sh  (or node --experimental-strip-types harness.test.ts)

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 실제 임시 cwd — evidence 파일 존재 검증(evidenceExists)이 진짜 fs 를 쓰므로.
const TMP_CWD = mkdtempSync(join(tmpdir(), "superpi-harness-"));
mkdirSync(join(TMP_CWD, ".superpi", "evidence"), { recursive: true });
writeFileSync(join(TMP_CWD, ".superpi", "evidence", "ok.txt"), "build: ok\ntests: 10/10 pass\n");
const EVIDENCE_OK = join(TMP_CWD, ".superpi", "evidence", "ok.txt");

// ── mock pi API ──────────────────────────────────────────────────────────
type Handler = (event: any, ctx: any) => any;
type ToolDef = { name: string; execute: Function; parameters?: any };
type CmdDef = { handler: Function };
type ExecResult = { stdout: string; stderr: string; code: number; killed: boolean };
// A programmable spec-graph responder: maps argv → result.
type ExecResponder = (args: string[]) => ExecResult;

class MockPi {
  handlers = new Map<string, Handler[]>();
  tools = new Map<string, ToolDef>();
  commands = new Map<string, CmdDef>();
  activeTools = new Set<string>(["read", "bash", "edit", "write", "grep", "find", "ls", "spawn_subagents", "fetch_subagent_result", "list_subagents", "send_to_subagent", "abort_subagent"]);
  entries: any[] = [];
  sentMessages: { content: any; options?: any }[] = [];
  events = { on: () => {}, emit: () => {} };
  execLog: string[][] = [];
  responder: ExecResponder = () => ({ stdout: "{}", stderr: "", code: 0, killed: false });

  on(name: string, h: Handler) {
    if (!this.handlers.has(name)) this.handlers.set(name, []);
    this.handlers.get(name)!.push(h);
  }
  registerTool(def: ToolDef) { this.tools.set(def.name, def); }
  registerCommand(name: string, def: CmdDef) { this.commands.set(name, def); }
  appendEntry(customType: string, data: any) { this.entries.push({ type: "custom", customType, data }); }
  getActiveTools() { return [...this.activeTools]; }
  setActiveTools(names: string[]) { this.activeTools = new Set(names); }
  sendUserMessage(content: any, options?: any) { this.sentMessages.push({ content, options }); }
  async exec(command: string, args: string[], _opts?: any): Promise<ExecResult> {
    this.execLog.push([command, ...args]);
    return this.responder(args);
  }
}

function makeCtx(pi: MockPi, ui?: { select?: (q: string, opts: string[]) => any; input?: (q: string, ph?: string) => any; hasUI?: boolean }) {
  return {
    hasUI: ui?.hasUI ?? false,
    cwd: TMP_CWD,
    isIdle: () => true,
    ui: {
      notify: () => {},
      setStatus: () => {},
      theme: { fg: (_: string, s: string) => s },
      select: ui?.select ?? (async () => undefined),
      input: ui?.input ?? (async () => undefined),
      confirm: async () => false,
    },
    sessionManager: { getEntries: () => pi.entries },
  };
}

// ── load extension ─────────────────────────────────────────────────────────
const mod = await import("./index.ts");
const factory = mod.default as (pi: any) => void;

const flush = () => new Promise((r) => setTimeout(r, 5));

let passed = 0;
const check = (label: string, cond: boolean) => {
  assert.ok(cond, label);
  passed++;
  console.log(`  ✓ ${label}`);
};

const ALL_TX = ["setup_done","phase_plan_ready","phase_plan_approved","phase_replan","phase_work_done","phase_verify_pass","phase_verify_fail","pipeline_blocked"];

// Drive SETUP→PLAN→PLAN_REVIEW→WORK→VERIFY for a given phase id (no resolve yet).
async function toVerify(pi: MockPi, ctx: any, phsId: string) {
  await pi.tools.get("setup_done")!.execute("id", { planId: "PLN-001" }, undefined, undefined, ctx);
  await flush();
  await pi.tools.get("phase_plan_ready")!.execute("id", { plan: "1. step" }, undefined, undefined, ctx);
  await flush();
  await pi.tools.get("phase_plan_approved")!.execute("id", { reviewerRunId: "r1", verdict: "ok" }, undefined, undefined, ctx);
  await flush();
  await pi.tools.get("phase_work_done")!.execute("id", { summary: "done" }, undefined, undefined, ctx);
  await flush();
}

// ── TEST 1: child subagent disables the extension entirely ──────────────────
{
  process.env.PI_SUBAGENT = "1";
  const pi = new MockPi();
  factory(pi);
  check("child (PI_SUBAGENT): no /superpi command registered", !pi.commands.has("superpi"));
  check("child (PI_SUBAGENT): no phase tools registered", pi.tools.size === 0);
  delete process.env.PI_SUBAGENT;
}

// ── TEST 2: SETUP gating + registration ─────────────────────────────────────
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);

  check("parent: /superpi command registered", pi.commands.has("superpi"));
  check("parent: all 8 transition tools registered (incl setup_done)", ALL_TX.every((t) => pi.tools.has(t)));

  // phase next --activate returns PHS-001
  pi.responder = (args) => {
    if (args[0] === "phase" && args[1] === "next") {
      return { stdout: JSON.stringify({ phase: { id: "PHS-001" }, scope: { total: 2, delivered: 0, remaining: ["REQ-001"] } }), stderr: "", code: 0, killed: false };
    }
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  };

  await pi.commands.get("superpi")!.handler("build a heavy thing", ctx);
  await flush();

  let active = new Set(pi.getActiveTools());
  check("SETUP: setup_done active", active.has("setup_done"));
  check("SETUP: edit DISABLED", !active.has("edit"));
  check("SETUP: bash active (needs spec-graph CLI)", active.has("bash"));
  check("SETUP: cannot jump — phase_plan_ready NOT active", !active.has("phase_plan_ready"));
  check("SETUP: kick sent a continuation message", pi.sentMessages.length >= 1);
  check("SETUP: continuation mentions spec-graph", String(pi.sentMessages[0].content).includes("spec-graph"));
  check("SETUP: continuation includes HYPERPLAN (PLN-level decomposition)", String(pi.sentMessages[0].content).includes("HYPERPLAN"));
  check("SETUP: continuation includes TURN TERMINATION RULE", String(pi.sentMessages[0].content).includes("TURN TERMINATION RULE"));

  // wrong-phase guard: plan_ready in SETUP rejected
  const pr = await pi.tools.get("phase_plan_ready")!.execute("id", { plan: "x" }, undefined, undefined, ctx);
  check("SETUP: phase_plan_ready rejected out of phase", JSON.stringify(pr).includes("only valid in the PLAN phase"));

  // setup_done → activates PHS-001, enters PLAN
  await pi.tools.get("setup_done")!.execute("id", { planId: "PLN-001" }, undefined, undefined, ctx);
  await flush();
  check("setup_done ran `spec-graph phase next --activate`", pi.execLog.some((c) => c[0] === "spec-graph" && c[1] === "phase" && c[2] === "next" && c.includes("--activate")));
  active = new Set(pi.getActiveTools());
  check("PLAN: phase_plan_ready active after setup_done", active.has("phase_plan_ready"));
  check("PLAN: setup_done no longer active", !active.has("setup_done"));
  check("PLAN: continuation references PHS-001", String(pi.sentMessages[pi.sentMessages.length - 1].content).includes("PHS-001"));
  check("PLAN: continuation includes HYPERPLAN (PHS-level)", String(pi.sentMessages[pi.sentMessages.length - 1].content).includes("HYPERPLAN"));
  check("PLAN: continuation includes INTERVIEW THE USER", String(pi.sentMessages[pi.sentMessages.length - 1].content).includes("INTERVIEW THE USER"));
  check("PLAN: continuation includes TURN TERMINATION RULE", String(pi.sentMessages[pi.sentMessages.length - 1].content).includes("TURN TERMINATION RULE"));
}

// ── TEST 3: per-phase gating PLAN→...→VERIFY (with spec-graph PHS active) ────
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  pi.responder = (args) => args[0] === "phase" && args[1] === "next"
    ? { stdout: JSON.stringify({ phase: { id: "PHS-001" } }), stderr: "", code: 0, killed: false }
    : { stdout: "{}", stderr: "", code: 0, killed: false };

  await pi.commands.get("superpi")!.handler("heavy task", ctx);
  await flush();
  await toVerify(pi, ctx, "PHS-001");

  let active = new Set(pi.getActiveTools());
  // (toVerify ended in VERIFY)
  check("VERIFY: edit DISABLED", !active.has("edit"));
  check("VERIFY: phase_verify_pass active", active.has("phase_verify_pass"));
  check("VERIFY: phase_verify_fail active", active.has("phase_verify_fail"));

  // verify_fail → WORK
  await pi.tools.get("phase_verify_fail")!.execute("id", { findings: "broke" }, undefined, undefined, ctx);
  await flush();
  active = new Set(pi.getActiveTools());
  check("verify_fail: back to WORK (edit enabled)", active.has("edit") && active.has("phase_work_done"));
}

// ── TEST 3b: HUMAN APPROVAL GATE in phase_plan_approved (hasUI) ──────────────
// Drive SETUP→PLAN→PLAN_REVIEW with a UI-enabled ctx, then exercise the 3 outcomes.
async function toPlanReview(pi: MockPi, ctx: any) {
  await pi.commands.get("superpi")!.handler("heavy task", ctx);
  await flush();
  await pi.tools.get("setup_done")!.execute("id", { planId: "PLN-001" }, undefined, undefined, ctx);
  await flush();
  await pi.tools.get("phase_plan_ready")!.execute("id", { plan: "1. step" }, undefined, undefined, ctx);
  await flush();
}
const phaseNextResponder = (args: string[]) => args[0] === "phase" && args[1] === "next"
  ? { stdout: JSON.stringify({ phase: { id: "PHS-001" } }), stderr: "", code: 0, killed: false }
  : { stdout: "{}", stderr: "", code: 0, killed: false };

// (i) user APPROVES → WORK
{
  const pi = new MockPi();
  factory(pi);
  let asked = false;
  const ctx = makeCtx(pi, { hasUI: true, select: async () => { asked = true; return "Approve & start work"; } });
  pi.responder = phaseNextResponder;
  await toPlanReview(pi, ctx);
  await pi.tools.get("phase_plan_approved")!.execute("id", { reviewerRunId: "r1", verdict: "ok" }, undefined, undefined, ctx);
  await flush();
  const active = new Set(pi.getActiveTools());
  check("human-gate(approve): user was asked via ui.select", asked);
  check("human-gate(approve): entered WORK (edit enabled)", active.has("edit") && active.has("phase_work_done"));
}

// (ii) user REFINES → back to PLAN with their note
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi, { hasUI: true, select: async () => "Refine the plan", input: async () => "split task 3" });
  pi.responder = phaseNextResponder;
  await toPlanReview(pi, ctx);
  const res = await pi.tools.get("phase_plan_approved")!.execute("id", { reviewerRunId: "r1", verdict: "ok" }, undefined, undefined, ctx);
  await flush();
  const active = new Set(pi.getActiveTools());
  check("human-gate(refine): returned to PLAN (phase_plan_ready active)", active.has("phase_plan_ready") && !active.has("phase_work_done"));
  check("human-gate(refine): user note captured in result", JSON.stringify(res).includes("split task 3"));
}

// (iii) user BLOCKS → BLOCKED + terminate
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi, { hasUI: true, select: async () => "Block (stop pipeline)" });
  pi.responder = phaseNextResponder;
  await toPlanReview(pi, ctx);
  const res = await pi.tools.get("phase_plan_approved")!.execute("id", { reviewerRunId: "r1", verdict: "ok" }, undefined, undefined, ctx);
  await flush();
  const active = new Set(pi.getActiveTools());
  check("human-gate(block): terminate:true", res.terminate === true);
  check("human-gate(block): all transition tools removed (BLOCKED)", !ALL_TX.some((t) => active.has(t)));
}

// (iv) UI cancel (select returns undefined) → BLOCKED (safe default)
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi, { hasUI: true, select: async () => undefined });
  pi.responder = phaseNextResponder;
  await toPlanReview(pi, ctx);
  const res = await pi.tools.get("phase_plan_approved")!.execute("id", { reviewerRunId: "r1", verdict: "ok" }, undefined, undefined, ctx);
  await flush();
  check("human-gate(ui-cancel): treated as block (terminate:true)", res.terminate === true);
}

// (v) no UI (print mode) → auto-proceed to WORK (non-interactive fallback)
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi); // hasUI:false
  pi.responder = phaseNextResponder;
  await toPlanReview(pi, ctx);
  await pi.tools.get("phase_plan_approved")!.execute("id", { reviewerRunId: "r1", verdict: "ok" }, undefined, undefined, ctx);
  await flush();
  const active = new Set(pi.getActiveTools());
  check("human-gate(no-UI): auto-proceeds to WORK", active.has("edit") && active.has("phase_work_done"));
}

// ── TEST 4: verify_pass — CLI gate BLOCKS → stay in VERIFY ───────────────────
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  pi.responder = (args) => {
    if (args[0] === "phase" && args[1] === "next") return { stdout: JSON.stringify({ phase: { id: "PHS-001" } }), stderr: "", code: 0, killed: false };
    if (args[0] === "entity" && args[1] === "update" && args.includes("resolved")) {
      // gate blocks
      return { stdout: JSON.stringify({ blocked: true, issues: [{ severity: "high", entity: "QST-001", message: "unresolved question" }] }), stderr: "", code: 2, killed: false };
    }
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  };
  await pi.commands.get("superpi")!.handler("heavy", ctx);
  await flush();
  await toVerify(pi, ctx, "PHS-001");

  const res = await pi.tools.get("phase_verify_pass")!.execute("id", { reviewerRunId: "r9", evidence: "tests pass", evidencePath: EVIDENCE_OK }, undefined, undefined, ctx);
  await flush();
  check("verify_pass(blocked): ran spec-graph entity update --status resolved", pi.execLog.some((c) => c[1] === "entity" && c[2] === "update" && c.includes("resolved")));
  check("verify_pass(blocked): NOT terminated", res.terminate !== true);
  check("verify_pass(blocked): reports the gate issue (QST-001)", JSON.stringify(res).includes("QST-001"));
  const active = new Set(pi.getActiveTools());
  check("verify_pass(blocked): still in VERIFY (verify_pass active)", active.has("phase_verify_pass"));
}

// ── TEST 5: verify_pass — gate OK, more phases → advance to next PHS (PLAN) ──
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  let phaseNextCalls = 0;
  pi.responder = (args) => {
    if (args[0] === "phase" && args[1] === "next") {
      phaseNextCalls++;
      // 1st call (setup_done) → PHS-001; 2nd call (after resolve) → PHS-002
      const id = phaseNextCalls === 1 ? "PHS-001" : "PHS-002";
      return { stdout: JSON.stringify({ phase: { id } }), stderr: "", code: 0, killed: false };
    }
    if (args[0] === "entity" && args.includes("resolved")) return { stdout: JSON.stringify({ entity: { status: "resolved" } }), stderr: "", code: 0, killed: false };
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  };
  await pi.commands.get("superpi")!.handler("heavy multi-phase", ctx);
  await flush();
  await toVerify(pi, ctx, "PHS-001");

  const res = await pi.tools.get("phase_verify_pass")!.execute("id", { reviewerRunId: "r1", evidence: "ok", evidencePath: EVIDENCE_OK }, undefined, undefined, ctx);
  await flush();
  check("verify_pass(advance): NOT terminated (more phases remain)", res.terminate !== true);
  check("verify_pass(advance): advanced to PHS-002", JSON.stringify(res).includes("PHS-002"));
  const active = new Set(pi.getActiveTools());
  check("verify_pass(advance): re-entered PLAN for next phase", active.has("phase_plan_ready") && !active.has("phase_verify_pass"));
  check("verify_pass(advance): next PLAN continuation references PHS-002", String(pi.sentMessages[pi.sentMessages.length - 1].content).includes("PHS-002"));
}

// ── TEST 6: verify_pass — gate OK, no more phases → DONE (terminate) ─────────
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  let phaseNextCalls = 0;
  pi.responder = (args) => {
    if (args[0] === "phase" && args[1] === "next") {
      phaseNextCalls++;
      if (phaseNextCalls === 1) return { stdout: JSON.stringify({ phase: { id: "PHS-001" } }), stderr: "", code: 0, killed: false };
      // 2nd call: all resolved → error JSON, exit 0
      return { stdout: JSON.stringify({ error: { code: "INVALID_INPUT", message: "all phases are resolved" } }), stderr: "", code: 0, killed: false };
    }
    if (args[0] === "entity" && args.includes("resolved")) return { stdout: JSON.stringify({ entity: { status: "resolved" } }), stderr: "", code: 0, killed: false };
    return { stdout: "{}", stderr: "", code: 0, killed: false };
  };
  await pi.commands.get("superpi")!.handler("heavy last phase", ctx);
  await flush();
  await toVerify(pi, ctx, "PHS-001");

  const res = await pi.tools.get("phase_verify_pass")!.execute("id", { reviewerRunId: "r1", evidence: "all green", evidencePath: EVIDENCE_OK }, undefined, undefined, ctx);
  await flush();
  check("verify_pass(done): terminate:true when all phases resolved", res.terminate === true);
  const active = new Set(pi.getActiveTools());
  check("DONE: all transition tools removed", !ALL_TX.some((t) => active.has(t)));
}

// ── TEST 6b: evidence machine-check + superpi_note + notepad guard ───────────
// (i) verify_pass with a NON-EXISTENT evidence file → blocked, stays in VERIFY
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  pi.responder = phaseNextResponder;
  await pi.commands.get("superpi")!.handler("evidence gate test", ctx);
  await flush();
  await toVerify(pi, ctx, "PHS-001");
  const res = await pi.tools.get("phase_verify_pass")!.execute("id", { reviewerRunId: "r1", evidence: "x", evidencePath: TMP_CWD + "/.superpi/evidence/does-not-exist.txt" }, undefined, undefined, ctx);
  await flush();
  check("evidence-gate: missing file → NOT terminated", res.terminate !== true);
  check("evidence-gate: reports evidence not found", JSON.stringify(res).includes("evidence file not found"));
  const active = new Set(pi.getActiveTools());
  check("evidence-gate: still in VERIFY", active.has("phase_verify_pass"));
}

// (ii) superpi_note appends to disk
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  pi.responder = phaseNextResponder;
  await pi.commands.get("superpi")!.handler("note test objective", ctx);
  await flush();
  const r = await pi.tools.get("superpi_note")!.execute("id", { kind: "learnings", text: "factory functions are the convention here" }, undefined, undefined, ctx);
  check("superpi_note: registered tool exists", pi.tools.has("superpi_note"));
  check("superpi_note: wrote to a file path", JSON.stringify(r).includes(".superpi/notes"));
}

// (iii) notepad-write-guard blocks write/edit into .superpi/notes/**
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  // superpi registers a tool_call guard handler; find handlers and invoke with a notes-path write
  const guards = pi.handlers.get("tool_call") ?? [];
  let blocked = false;
  for (const h of guards) {
    const out = await h({ toolName: "write", input: { path: ".superpi/notes/foo/learnings.md" } }, ctx);
    if (out && out.block) blocked = true;
  }
  check("notepad-guard: write into .superpi/notes/** is blocked", blocked);
  // a normal src write is NOT blocked by the notepad guard
  let blockedSrc = false;
  for (const h of guards) {
    const out = await h({ toolName: "write", input: { path: "src/index.ts" } }, ctx);
    if (out && out.block) blockedSrc = true;
  }
  check("notepad-guard: normal src write NOT blocked", !blockedSrc);
}

// ── TEST 7: agent_end loop suppression ──────────────────────────────────────
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  await pi.commands.get("superpi")!.handler("do work", ctx);
  await flush();
  const agentEnd = pi.handlers.get("agent_end")![0];

  const before = pi.sentMessages.length;
  await agentEnd({ messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "spawn_subagents", id: "1", arguments: {} }] }] }, ctx);
  await flush();
  check("agent_end: NO re-kick while subagents in-flight", pi.sentMessages.length === before);

  await agentEnd({ messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "thinking" }] }] }, ctx);
  await flush();
  check("agent_end: re-kicks on a plain turn", pi.sentMessages.length === before + 1);

  const before2 = pi.sentMessages.length;
  await agentEnd({ messages: [{ role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", name: "setup_done", id: "2", arguments: {} }] }] }, ctx);
  await flush();
  check("agent_end: NO double re-kick after a transition tool", pi.sentMessages.length === before2);

  const before3 = pi.sentMessages.length;
  await agentEnd({ messages: [{ role: "assistant", stopReason: "aborted", content: [] }] }, ctx);
  await flush();
  check("agent_end: abort pauses (no re-kick)", pi.sentMessages.length === before3);
}

// ── TEST 8: session restore auto-pauses ──────────────────────────────────────
{
  const pi = new MockPi();
  factory(pi);
  const ctx = makeCtx(pi);
  pi.entries.push({ type: "custom", customType: "superpi-state", data: { objective: "x", phase: "WORK", status: "pursuing", iteration: 3, reviewHistory: [], phsId: "PHS-002", createdAt: 1 } });
  const sessionStart = pi.handlers.get("session_start")![0];
  await sessionStart({}, ctx);
  await flush();
  check("session_start: restored pipeline auto-paused (no auto-kick)", pi.sentMessages.length === 0);
}

console.log(`\n✅ all ${passed} superpi assertions passed`);
