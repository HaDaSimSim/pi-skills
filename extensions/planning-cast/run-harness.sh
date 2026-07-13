#!/usr/bin/env bash
# Run the planning-cast gate state machine harness.
# index.ts imports @earendil-works/pi-coding-agent which lives in pi's global install.
# Symlink that node_modules in, run, then remove.
set -euo pipefail
cd "$(dirname "$0")"

PI_NM="$(npm root -g)/@earendil-works/pi-coding-agent/node_modules"
if [ ! -d "$PI_NM" ]; then
  echo "could not locate pi's node_modules at: $PI_NM" >&2
  exit 1
fi

cleanup() { rm -f node_modules; }
trap cleanup EXIT

ln -sfn "$PI_NM" node_modules
node --experimental-strip-types gate.test.ts
