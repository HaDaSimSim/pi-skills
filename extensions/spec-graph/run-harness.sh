#!/usr/bin/env bash
# Integration test for the spec-graph extension.
# Tests: graph-exists detection, init, validate, and absent-CLI handling.
# Shells out to the real spec-graph CLI — no mocks.
set -euo pipefail
cd "$(dirname "$0")"

cleanup() {
  rm -rf "$TMPDIR"
  rm -rf node_modules
}
trap cleanup EXIT

TMPDIR="$(mktemp -d /tmp/sg-harness-XXXXXX)"
echo "=== spec-graph harness ==="
echo "Temp dir: $TMPDIR"

# Run the TypeScript test directly. Node 22+ strips types natively.
# The spec-graph extension has no pi-specific deps; it only uses node builtins
# and the local symlinked ohpi-paths.ts.
node --experimental-strip-types spec-graph.test.ts "$TMPDIR"
