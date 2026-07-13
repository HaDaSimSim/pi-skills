#!/usr/bin/env bash
# run-harness.sh — run evidence extension tests.
#
# No pi node_modules symlink needed — tests use only node builtins + shell out
# to jq, no @earendil-works/pi-coding-agent imports.
#
# Usage: bash run-harness.sh
# Prerequisites: jq on PATH, node >= 22 (for --experimental-strip-types)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "=== evidence extension tests ==="
echo ""

node --experimental-strip-types evidence.test.ts
