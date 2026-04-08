#!/bin/bash
# Smoke test the local wrangler dev endpoint.
set -e

URL="${1:-http://localhost:8787}"

echo "=== GET / (health) ==="
curl -s "$URL/"

echo
echo "=== POST / (parse JS) ==="
curl -s -X POST "$URL/" -d 'const x = 1 + 2; class Counter { #n = 0; bump() { return ++this.#n; } }'

echo
echo "=== POST /?filename=foo.ts (parse TS) ==="
curl -s -X POST "$URL/?filename=foo.ts" -d 'interface X { y: number } const a: X = { y: 1 };'
echo
