#!/usr/bin/env sh
# Proves the Linux fence on this machine's own kernel: that an agent nuza
# starts cannot read the home folder (so not a vault, nor ~/.ssh), and cannot
# write anywhere but its own state and scratch folder.
#
#   scripts/test-linux-sandbox.sh          the fence's tests, against this kernel
#   scripts/test-linux-sandbox.sh --real   and a real Claude Code turn inside it
#
# Fails, rather than skipping, on a kernel without Landlock.
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "This checks the Linux fence; run it on Linux." >&2
  exit 1
fi

cd "$(dirname "$0")/.."

if [ -r /sys/kernel/security/lsm ]; then
  echo "Security modules: $(cat /sys/kernel/security/lsm)"
fi

NUZA_REQUIRE_LANDLOCK=1 cargo test --manifest-path src-tauri/Cargo.toml agent::confine -- --nocapture

if [ "${1:-}" = "--real" ]; then
  cargo test --manifest-path src-tauri/Cargo.toml real_claude -- --ignored --nocapture
fi
