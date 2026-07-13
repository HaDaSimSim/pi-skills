// Strip-only unit test for primary-agents persona discovery, switching, and
// coordinator compose integration.
//
// Run:  node --experimental-strip-types extensions/primary-agents/agents.test.ts
// Or:   cd extensions/primary-agents && bash run-harness.sh
//
// Requires: symlinked pi node_modules (handled by run-harness.sh) so the
// @earendil-works/pi-coding-agent import resolves.

import * as assert from "node:assert";
import { __sections, composeSystemPrompt } from "../hook-coordinator/index.ts";
import type { PersonaConfig } from "./agents.ts";
import { discoverPersonas } from "./agents.ts";
import {
  findLastActiveAgent,
  getActivePersona,
  getRoster,
  loadRoster,
  resetActivePersona,
  switchAgent,
} from "./index.ts";

// ── Sentinels (must match agents/builder.md and agents/planner.md) ───────────

const BUILDER_SENTINEL = "When the mountain crumbles, Sisyphus does not ask why";
const PLANNER_SENTINEL = "Prometheus does not beg for fire — he calculates the cost";

// ── Mocks ────────────────────────────────────────────────────────────────────

function mockPi() {
  const pi: Record<string, unknown> = {
    setActiveTools(_tools: string[]) {},
    setModel: async () => true,
    setThinkingLevel() {},
    appendEntry(_type: string, _data: unknown) {},
  };
  return pi;
}

function mockCtx() {
  const ctx: Record<string, unknown> = {
    isIdle: () => true,
    ui: { notify(_msg: string, _kind: string) {} },
    modelRegistry: {
      find(_provider: string, _modelId: string) {
        return undefined;
      },
    },
  };
  return ctx;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

let failures = 0;

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    console.error(`        ${(err as Error).message}`);
  }
}

function findPersona(personas: PersonaConfig[], name: string): PersonaConfig {
  const p = personas.find((p) => p.name === name);
  assert.ok(p, `persona "${name}" not found in roster`);
  return p;
}

function resetRoster(): void {
  resetActivePersona();
  loadRoster(process.cwd());
}

// ── Run all tests ────────────────────────────────────────────────────────────

async function run() {
  console.log("\nprimary-agents unit tests\n");

  const result = discoverPersonas(process.cwd(), "both");
  const personas = result.personas;

  // ── Part 1: Roster discovery (task 6) ────────────────────────────────────

  check("roster has exactly 3 personas", () => {
    assert.strictEqual(personas.length, 3, `expected 3, got ${personas.length}`);
    const names = personas.map((p) => p.name).sort();
    assert.deepStrictEqual(names, ["builder", "planner", "unspecified"]);
  });

  check("builder is default:true", () => {
    const builder = findPersona(personas, "builder");
    assert.strictEqual(builder.default, true);
    assert.ok(result.defaultPersona);
    assert.strictEqual(result.defaultPersona!.name, "builder");
  });

  check("builder has tools defined", () => {
    const builder = findPersona(personas, "builder");
    assert.ok(builder.tools);
    assert.ok(builder.tools!.length > 0);
    assert.ok(builder.tools!.includes("read"));
    assert.ok(builder.tools!.includes("write"));
  });

  check("planner has read-mostly tools (no write/edit)", () => {
    const planner = findPersona(personas, "planner");
    assert.ok(planner.tools);
    assert.ok(planner.tools!.length > 0);
    assert.ok(planner.tools!.includes("read"));
    assert.ok(!planner.tools!.includes("write"));
    assert.ok(!planner.tools!.includes("edit"));
  });

  check("planner is not default", () => {
    const planner = findPersona(personas, "planner");
    assert.strictEqual(planner.default, undefined);
  });

  check("unspecified is not default", () => {
    const unspecified = findPersona(personas, "unspecified");
    assert.strictEqual(unspecified.default, undefined);
  });

  check("builder body contains sentinel", () => {
    const builder = findPersona(personas, "builder");
    assert.ok(builder.systemPrompt.includes(BUILDER_SENTINEL));
  });

  check("planner body contains sentinel", () => {
    const planner = findPersona(personas, "planner");
    assert.ok(planner.systemPrompt.includes(PLANNER_SENTINEL));
  });

  check("unspecified has bare (non-empty) body", () => {
    const unspecified = findPersona(personas, "unspecified");
    assert.ok(unspecified.systemPrompt.trim().length > 10);
  });

  check("all personas have a source", () => {
    for (const p of personas) {
      assert.ok(["bundled", "user", "project"].includes(p.source));
    }
  });

  check("all personas have a description", () => {
    for (const p of personas) {
      assert.ok(p.description.length > 0);
    }
  });

  // ── Part 2: Persona switching (task 8) ───────────────────────────────────

  resetRoster();

  await check("switch to planner — getText returns planner sentinel", async () => {
    await switchAgent(mockPi() as any, "planner", mockCtx() as any);
    const active = getActivePersona();
    assert.ok(active);
    assert.strictEqual(active!.name, "planner");
    assert.ok(active!.systemPrompt.includes(PLANNER_SENTINEL));
  });

  await check("switch to builder — getText returns builder sentinel", async () => {
    await switchAgent(mockPi() as any, "builder", mockCtx() as any);
    const active = getActivePersona();
    assert.ok(active);
    assert.strictEqual(active!.name, "builder");
    assert.ok(active!.systemPrompt.includes(BUILDER_SENTINEL));
  });

  await check("switch to unknown name throws", async () => {
    await assert.rejects(() => switchAgent(mockPi() as any, "nonexistent"), /Unknown persona/);
  });

  await check("switch to unspecified is valid", async () => {
    await switchAgent(mockPi() as any, "unspecified", mockCtx() as any);
    const active = getActivePersona();
    assert.ok(active);
    assert.strictEqual(active!.name, "unspecified");
  });

  // ── Part 3: appendEntry & no-op (task 9) ────────────────────────────────

  resetRoster();

  await check("switch records appendEntry", async () => {
    const calls: Array<{ type: string; data: unknown }> = [];
    const pi = {
      setActiveTools() {},
      setModel: async () => true,
      appendEntry(type: string, data: unknown) {
        calls.push({ type, data });
      },
    };
    await switchAgent(pi as any, "planner", mockCtx() as any);
    assert.strictEqual(calls.length, 1, `expected 1 appendEntry, got ${calls.length}`);
    assert.strictEqual(calls[0].type, "active-agent");
    assert.strictEqual((calls[0].data as Record<string, unknown>).name, "planner");
  });

  await check("no-op switch does not double-record", async () => {
    resetRoster();
    const calls: Array<{ type: string; data: unknown }> = [];
    const pi = {
      setActiveTools() {},
      setModel: async () => true,
      appendEntry(type: string, data: unknown) {
        calls.push({ type, data });
      },
    };
    await switchAgent(pi as any, "planner", mockCtx() as any);
    assert.strictEqual(calls.length, 1);
    await switchAgent(pi as any, "planner", mockCtx() as any);
    assert.strictEqual(calls.length, 1, "no-op should not call appendEntry again");
  });

  check("findLastActiveAgent — last-wins across entries", () => {
    const entries = [
      { type: "custom", customType: "active-agent", data: { name: "builder" } },
      { type: "message", customType: "text", data: {} },
      { type: "custom", customType: "active-agent", data: { name: "planner" } },
    ];
    const result = findLastActiveAgent(entries);
    assert.strictEqual(result, "planner");
  });

  check("findLastActiveAgent — empty entries returns null", () => {
    assert.strictEqual(findLastActiveAgent([]), null);
  });

  check("findLastActiveAgent — no active-agent entries returns null", () => {
    const entries = [
      { type: "custom", customType: "goal-state", data: { objective: "x" } },
      { type: "message", customType: "text", data: {} },
    ];
    assert.strictEqual(findLastActiveAgent(entries), null);
  });

  check("findLastActiveAgent — skips entries with missing data.name", () => {
    const entries = [
      { type: "custom", customType: "active-agent", data: {} },
      { type: "custom", customType: "active-agent", data: { name: "builder" } },
    ];
    const result = findLastActiveAgent(entries);
    assert.strictEqual(result, "builder");
  });

  // ── Part 4: Coordinator compose integration ──────────────────────────────

  await check("persona section + dummy marker both survive in compose", async () => {
    // Reset and switch to planner so getText returns planner body.
    resetRoster();
    await switchAgent(mockPi() as any, "planner", mockCtx() as any);

    // Register the persona section (mirrors what coordinator does).
    __sections.set("primary-agents-persona", {
      name: "primary-agents-persona",
      priority: 150,
      getText: () => {
        const active = getActivePersona();
        return active?.systemPrompt;
      },
      order: __sections.size,
    });

    // Register a dummy section (simulates ui-cosmetics or another participant).
    const DUMMY = "<<<DUMMY_SECTION>>>";
    __sections.set("dummy-section", {
      name: "dummy-section",
      priority: 300,
      getText: () => DUMMY,
      order: __sections.size,
    });

    const composed = composeSystemPrompt("BASE");
    assert.ok(composed.includes(PLANNER_SENTINEL), "composed prompt missing planner sentinel");
    assert.ok(composed.includes(DUMMY), "composed prompt missing dummy section");

    // Planner sentinel must appear before dummy (lower priority = earlier).
    const plannerPos = composed.indexOf(PLANNER_SENTINEL);
    const dummyPos = composed.indexOf(DUMMY);
    assert.ok(
      plannerPos < dummyPos,
      `planner sentinel (pos ${plannerPos}) should be before dummy (pos ${dummyPos})`,
    );

    __sections.clear();
  });

  console.log(`\n${failures} failures\n`);
}

run().then(() => {
  if (failures > 0) {
    process.exit(1);
  }
});
