#!/usr/bin/env node
/**
 * Run @node-rs/argon2 (real published napi-rs package) through wasmkernel.
 * Uses the sync API only — the test suite covers everything the async
 * version does via hashSync/verifySync.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes } from "crypto";
import { loadNapiRs } from "./napi_rs_loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(__dirname, "..", "..", "build", "wasmkernel.wasm");
const GUEST = join(__dirname, "..", "emnapi", "wasm", "argon2_real.wasm");

const { exports: argon2 } = await loadNapiRs(KERNEL, GUEST);
const { Algorithm, Version, hashSync, verifySync, hashRawSync } = argon2;

let passed = 0, failed = 0;
const passwordString = "some_string123";
const passwordBuffer = Buffer.from(passwordString);

function test(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e?.message || e}`); failed++; }
}

test("allow buffer input", () => {
  const h = hashSync(passwordBuffer);
  if (!verifySync(h, passwordString)) throw new Error("verify failed");
});

test("allow changing timeCost", () => {
  const h = hashSync(passwordString, { timeCost: 5 });
  if (!verifySync(h, passwordString)) throw new Error("verify failed");
});

test("allow changing memoryCost", () => {
  const h = hashSync(passwordString, { memoryCost: 16384 });
  if (!verifySync(h, passwordString)) throw new Error("verify failed");
});

test("allow changing parallelism", () => {
  const h = hashSync(passwordString, { memoryCost: 65536, parallelism: 2 });
  if (!verifySync(h, passwordString)) throw new Error("verify failed");
});

test("hash string (plain)", () => {
  hashSync("whatever");
});

test("hash string with secret", () => {
  hashSync("whatever", { secret: randomBytes(32) });
});

test("hash string with defined salt (deterministic)", () => {
  const salt = randomBytes(32);
  const a = hashSync("whatever", { salt });
  const b = hashSync("whatever", { salt });
  if (a !== b) throw new Error("same salt → different hash");
});

test("hashRawSync with secret and salt", () => {
  hashRawSync("whatever", { secret: randomBytes(32), salt: randomBytes(32) });
});

test("verify round-trip with default args", () => {
  const PASSWORD = "Argon2_is_the_best_algorithm_ever";
  if (!verifySync(hashSync(PASSWORD), PASSWORD)) throw new Error("default");
});

test("verify round-trip with Argon2d", () => {
  const PASSWORD = "Argon2_is_the_best_algorithm_ever";
  if (!verifySync(hashSync(PASSWORD, { algorithm: Algorithm.Argon2d }), PASSWORD))
    throw new Error("Argon2d");
});

test("verify round-trip with Argon2i", () => {
  const PASSWORD = "Argon2_is_the_best_algorithm_ever";
  if (!verifySync(hashSync(PASSWORD, { algorithm: Algorithm.Argon2i }), PASSWORD))
    throw new Error("Argon2i");
});

test("verify round-trip with v0x10 and secret", () => {
  const PASSWORD = "Argon2_is_the_best_algorithm_ever";
  const secret = randomBytes(32);
  const h = hashSync(PASSWORD, {
    algorithm: Algorithm.Argon2d,
    version: Version.V0x10,
    secret,
  });
  if (!verifySync(h, PASSWORD, { secret })) throw new Error("v0x10");
});

test("memoryCost error", () => {
  let err;
  try { hashSync(passwordString, { timeCost: 2, memoryCost: 1, parallelism: 1 }); }
  catch (e) { err = e; }
  if (!err) throw new Error("expected error");
  if (!err.message.includes("memory cost is too small"))
    throw new Error("unexpected message: " + err.message);
});

test("timeCost error", () => {
  let err;
  try { hashSync(passwordString, { timeCost: 0.6 }); }
  catch (e) { err = e; }
  if (!err) throw new Error("expected error");
  if (!err.message.includes("time cost is too small"))
    throw new Error("unexpected message: " + err.message);
});

test("parallelism error", () => {
  let err;
  try { hashSync(passwordString, { timeCost: 3, parallelism: 0 }); }
  catch (e) { err = e; }
  if (!err) throw new Error("expected error");
  if (!err.message.includes("not enough threads"))
    throw new Error("unexpected message: " + err.message);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
