// Strip-only unit test for the `.ohpi/` path resolver.
// Run: node --experimental-strip-types extensions/shared/ohpi-paths.test.ts
// No pi SDK import → no node_modules symlink needed (node builtins only).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ensureDir,
  findOhpiRoot,
  OHPI_ROOT,
  OHPI_SUBDIRS,
  ohpiPaths,
  ohpiSubdir,
} from "./ohpi-paths.ts";

test("ohpiPaths resolves every subdir under <cwd>/.ohpi", () => {
  const cwd = "/project";
  const p = ohpiPaths(cwd);
  assert.equal(p.root, "/project/.ohpi");
  assert.equal(p.specGraph, "/project/.ohpi/spec-graph");
  assert.equal(p.evidence, "/project/.ohpi/evidence");
  assert.equal(p.notepad, "/project/.ohpi/notepad");
  assert.equal(p.primaryAgents, "/project/.ohpi/primary-agents");
  assert.equal(p.config, "/project/.ohpi/config");
  assert.equal(p.plans, "/project/.ohpi/plans");
});

test("spec-graph data-dir constant is .ohpi/spec-graph (task 18 target)", () => {
  assert.equal(OHPI_SUBDIRS.specGraph, "spec-graph");
  assert.equal(ohpiSubdir("/x", "specGraph"), "/x/.ohpi/spec-graph");
});

test("primary-agents dir is .ohpi/primary-agents (task 8 target)", () => {
  assert.equal(OHPI_SUBDIRS.primaryAgents, "primary-agents");
  assert.equal(ohpiSubdir("/x", "primaryAgents"), "/x/.ohpi/primary-agents");
});

test("OHPI_ROOT is the single .ohpi root name", () => {
  assert.equal(OHPI_ROOT, ".ohpi");
});

test("ohpiSubdir matches ohpiPaths for each key", () => {
  const cwd = "/repo/nested/dir";
  const p = ohpiPaths(cwd);
  assert.equal(ohpiSubdir(cwd, "specGraph"), p.specGraph);
  assert.equal(ohpiSubdir(cwd, "evidence"), p.evidence);
  assert.equal(ohpiSubdir(cwd, "notepad"), p.notepad);
  assert.equal(ohpiSubdir(cwd, "primaryAgents"), p.primaryAgents);
  assert.equal(ohpiSubdir(cwd, "config"), p.config);
  assert.equal(ohpiSubdir(cwd, "plans"), p.plans);
});

test("resolution is pure — no directory is created by resolving", () => {
  const base = mkdtempSync(join(tmpdir(), "ohpi-pure-"));
  try {
    const p = ohpiPaths(base);
    assert.throws(() => statSync(p.root), /ENOENT/);
    assert.throws(() => statSync(p.specGraph), /ENOENT/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("ensureDir creates lazily and is idempotent", () => {
  const base = mkdtempSync(join(tmpdir(), "ohpi-mk-"));
  try {
    const p = ohpiPaths(base);
    ensureDir(p.specGraph);
    assert.ok(statSync(p.specGraph).isDirectory());
    // second call must not throw
    ensureDir(p.specGraph);
    assert.ok(statSync(p.specGraph).isDirectory());
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("findOhpiRoot walks up to nearest existing .ohpi, else null", () => {
  const base = mkdtempSync(join(tmpdir(), "ohpi-walk-"));
  try {
    const nested = join(base, "a", "b", "c");
    ensureDir(nested);
    // no .ohpi anywhere yet
    assert.equal(findOhpiRoot(nested), null);
    // create .ohpi at base
    const root = ensureDir(join(base, OHPI_ROOT));
    assert.equal(findOhpiRoot(nested), root);
    assert.equal(findOhpiRoot(base), root);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
