# cf-paged-do

Cloudflare Worker + Durable Object demonstrating wasmkernel's paged guest
memory against the DO's synchronous SQLite API. Cold pages spill to
SQLite; hot window is capped at 100 pages (~6.4 MB) so heavy napi-rs
guests (oxc-parser 1.7 MB, rolldown 12 MB) fit under the 128 MB isolate
cap.

## Setup

The guest binaries are not committed (rolldown is 12 MB). Copy them in
before running:

```
cp ../../tests/emnapi/wasm/oxc_parser.wasm ./src/oxc-parser.wasm.bin
# rolldown — needs scripts/install-rolldown.sh first from repo root
cp ../../tests/pkgs/rolldown/package/rolldown-binding.wasm32-wasi.wasm \
   ./src/rolldown.wasm.bin
bun install
```

## Run locally

```
bunx wrangler dev
curl -X POST http://localhost:8787/oxc -d 'const x = 1 + 2;'
curl -X POST http://localhost:8787/rolldown \
     -d 'const greeting: string = "hi"; export default greeting;'
```

Both responses include a `paging` field reporting `residentAfterLoad` —
if paging is working, this is a small number (4 for oxc, a few hundred
for rolldown) rather than the full `logicalPages` count.

## Deploy

```
bunx wrangler deploy
```
