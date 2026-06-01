#!/usr/bin/env bash
# Run the superpi state-machine harness.
#
# index.ts imports `typebox` and `@earendil-works/*`, which live inside pi's
# global install (this repo has no node_modules). We temporarily symlink that
# install's node_modules in here so Node's ESM resolver finds the packages,
# run the harness, then remove the link.
set -euo pipefail
cd "$(dirname "$0")"

PI_NM="$(npm root -g)/@earendil-works/pi-coding-agent/node_modules"
if [ ! -d "$PI_NM" ]; then
  echo "could not locate pi's node_modules at: $PI_NM" >&2
  echo "(pi must be installed; this harness borrows its typebox/@earendil-works types)" >&2
  exit 1
fi

cleanup() { rm -f node_modules; }
trap cleanup EXIT

ln -sfn "$PI_NM" node_modules
node --experimental-strip-types harness.test.ts
