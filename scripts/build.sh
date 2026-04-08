#!/bin/bash
# Convenience wrapper: build the kernel + all guest tests + sync the
# package + run the test suite in one go. Use this for local dev. CI
# calls the individual pieces separately so each step has its own log
# section.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

./scripts/build-kernel.sh
./scripts/build-guests.sh
./scripts/sync-package.sh

echo ""
echo "=== running tests ==="
bun test tests/
