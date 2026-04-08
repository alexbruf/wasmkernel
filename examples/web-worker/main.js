/**
 * Main thread: spawns the worker, forwards parse requests, renders results.
 *
 * The whole point of this example is that the heavy stuff (loading
 * wasmkernel, instantiating oxc-parser, running parseSync per keystroke)
 * happens off-main-thread, leaving the UI thread free.
 */
const statusEl = document.getElementById("status");
const srcEl = document.getElementById("src");
const outEl = document.getElementById("out");

function setStatus(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? "status err" : "status";
}

const worker = new Worker(new URL("./worker.js", import.meta.url), {
  type: "module",
});

let nextId = 1;
const pending = new Map();

worker.addEventListener("message", (e) => {
  const { id, type, payload } = e.data;
  if (type === "ready") {
    setStatus("worker ready — type to parse");
    schedule();
    return;
  }
  if (type === "error" && id == null) {
    setStatus(`worker fatal: ${payload}`, true);
    return;
  }
  const resolver = pending.get(id);
  if (!resolver) return;
  pending.delete(id);
  resolver(payload);
});

function parseInWorker(filename, source) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    worker.postMessage({ id, type: "parse", payload: { filename, source } });
  });
}

let timer = null;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(runParse, 120);
}

async function runParse() {
  const t0 = performance.now();
  const result = await parseInWorker("input.js", srcEl.value);
  const totalMs = (performance.now() - t0).toFixed(2);
  if (result.error) {
    outEl.textContent = result.error;
    setStatus(`parse failed (${totalMs} ms round-trip)`, true);
    return;
  }
  outEl.textContent = JSON.stringify(result.summary, null, 2);
  setStatus(
    `parsed in ${result.summary.parseTimeMs.toFixed(2)} ms (worker), ` +
      `${totalMs} ms total round-trip`
  );
}

srcEl.addEventListener("input", schedule);
