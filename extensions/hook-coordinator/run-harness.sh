#!/usr/bin/env bash
# Run the hook-coordinator dual-marker QA harness.
# index.ts imports @earendil-works/pi-coding-agent which lives in pi's global install.
# Symlink that node_modules in, run, then remove.
#
# REUSABLE GATE: W2/W3 tasks re-run this harness as their hook-composition gate.
#   cd ~/projects/pi-skills/extensions/hook-coordinator && bash run-harness.sh
# If it passes, both hooks (before_agent_start + agent_end) are correctly composed
# through the coordinator — downstream persona/loop/ultrawork features are safe to land.
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
node --experimental-strip-types harness.test.ts
