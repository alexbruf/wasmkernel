'use strict';
/**
 * CJS wrapper for napi_runtime.js.
 *
 * The ESM file (napi_runtime.js) is a single class definition with a
 * single `export class NapiRuntime`. We load its source, strip the
 * `export` keyword, and eval it in this module's scope so both CJS
 * and ESM consumers share the same class definition without duplication.
 *
 * Rationale for not maintaining two copies: the class is ~3000 lines
 * and any divergence would be painful to catch.
 */
const fs = require('node:fs');
const path = require('node:path');

const srcPath = path.join(__dirname, 'napi_runtime.js');
let src = fs.readFileSync(srcPath, 'utf8');
// Strip the ESM-only `export` keyword on the class.
src = src.replace(/^export class NapiRuntime/m, 'class NapiRuntime');

// Eval and expose. We use new Function() to keep strict mode and a
// controlled scope, and return the class at the end.
// eslint-disable-next-line no-new-func
const NapiRuntime = (new Function(
  `"use strict"; ${src}; return NapiRuntime;`
))();

module.exports = { NapiRuntime };
