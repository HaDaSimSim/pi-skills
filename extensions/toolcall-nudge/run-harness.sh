#!/usr/bin/env bash
# Run toolcall-nudge unit tests.
# Imports @earendil-works/pi-coding-agent (no runtime needed, just type resolution),
# so symlink pi's node_modules in, run, then remove.
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
node --experimental-strip-types nudge.test.ts
