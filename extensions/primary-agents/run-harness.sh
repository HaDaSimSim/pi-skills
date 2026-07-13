#!/usr/bin/env bash
# Run the primary-agents persona discovery test.
# agents.ts imports @earendil-works/pi-coding-agent which lives in pi's global install.
# Symlink that node_modules in, run, then remove.
set -euo pipefail
cd "$(dirname "$0")"

PI_GLOBAL="$(npm root -g)"
PI_PKG="$PI_GLOBAL/@earendil-works/pi-coding-agent"
if [ ! -d "$PI_PKG" ]; then
  echo "could not locate pi at: $PI_PKG" >&2
  exit 1
fi

cleanup() { rm -rf node_modules; }
trap cleanup EXIT

# Symlink pi's own node_modules (for its deps: pi-ai, pi-tui, typebox, etc.)
ln -sfn "$PI_PKG/node_modules" node_modules
# Also symlink pi-coding-agent itself so import "@earendil-works/pi-coding-agent" resolves.
mkdir -p node_modules/@earendil-works
ln -sfn "$PI_PKG" node_modules/@earendil-works/pi-coding-agent

node --experimental-strip-types agents.test.ts
