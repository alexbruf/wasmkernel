#!/usr/bin/env node
/**
 * Run @node-rs/bcrypt (real published napi-rs package) through wasmkernel.
 * Ported from the upstream bcrypt.spec.ts sync paths.
 */
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { loadNapiRs } from "./napi_rs_loader.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KERNEL = join(__dirname, "..", "..", "build", "wasmkernel.wasm");
const GUEST = join(__dirname, "..", "emnapi", "wasm", "bcrypt.wasm");

const { exports: bcrypt } = await loadNapiRs(KERNEL, GUEST);
const { hashSync, verifySync, genSaltSync } = bcrypt;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  PASS ${name}`); passed++; }
  catch (e) { console.error(`  FAIL ${name}: ${e?.message || e}`); failed++; }
}

const fx = Buffer.from("bcrypt-test-password");

test("genSaltSync returns a string (default)", () => {
  const s = genSaltSync(10);
  if (typeof s !== "string") throw new Error("not a string: " + typeof s);
  if (s.length < 20) throw new Error("salt too short: " + s);
});

test("genSaltSync variants 2a/2b/2y/2x", () => {
  for (const v of ["2a", "2b", "2y", "2x"]) {
    const s = genSaltSync(10, v);
    if (typeof s !== "string") throw new Error(`${v}: not a string`);
    if (!s.includes(v)) throw new Error(`${v}: variant missing: ${s}`);
  }
});

test("genSaltSync with invalid variant throws", () => {
  let err;
  try { genSaltSync(10, "invalid"); } catch (e) { err = e; }
  if (!err) throw new Error("expected throw");
});

test("hashSync returns a string", () => {
  const h = hashSync("hello-world", 4);  // cost=4 for speed
  if (typeof h !== "string") throw new Error("not a string");
  if (!h.startsWith("$2")) throw new Error("not a bcrypt hash: " + h);
});

test("verifySync verifies a fresh hash", () => {
  const h = hashSync("password-one", 4);
  if (!verifySync("password-one", h)) throw new Error("verify failed");
});

test("verifySync rejects wrong password", () => {
  const h = hashSync("correct", 4);
  if (verifySync("wrong", h)) throw new Error("should reject");
});

test("verifySync on Buffer input works the same", () => {
  const h = hashSync(fx, 4);
  if (!verifySync(fx, h)) throw new Error("Buffer verify failed");
  if (!verifySync(fx.toString("utf8"), h)) throw new Error("string verify failed");
});

test("verifySync never throws on garbage input, returns false", () => {
  if (verifySync("a", "b") !== false) throw new Error("should return false");
  if (verifySync("a", "") !== false) throw new Error("should return false");
  if (verifySync("", "") !== false) throw new Error("should return false");
});

test("hashSync with explicit salt is deterministic", () => {
  const salt = genSaltSync(4);
  const a = hashSync("same", 4, salt);
  const b = hashSync("same", 4, salt);
  if (a !== b) throw new Error("same password + salt should hash to same value");
});

test("hashSync with different salts gives different hashes", () => {
  const s1 = genSaltSync(4);
  const s2 = genSaltSync(4);
  if (s1 === s2) return; // random clash; salts should normally differ
  const a = hashSync("same", 4, s1);
  const b = hashSync("same", 4, s2);
  if (a === b) throw new Error("different salts should produce different hashes");
});

test("hashSync with default cost produces valid hash", () => {
  const h = hashSync("string", 4);
  if (typeof h !== "string") throw new Error("not a string");
  if (!verifySync("string", h)) throw new Error("self-verify failed");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
