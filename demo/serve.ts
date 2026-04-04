// Simple static file server for the demo
const port = 3847;

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname;
    if (path === "/") path = "/index.html";

    // Serve from project root for build/ and tests/ paths
    const projectRoot = import.meta.dir + "/..";
    let filePath: string;
    if (path.startsWith("/build/") || path.startsWith("/tests/")) {
      filePath = projectRoot + path;
    } else {
      filePath = import.meta.dir + path;
    }

    const file = Bun.file(filePath);
    if (await file.exists()) {
      const headers: Record<string, string> = {};
      if (filePath.endsWith(".wasm")) headers["Content-Type"] = "application/wasm";
      if (filePath.endsWith(".js") || filePath.endsWith(".mjs")) headers["Content-Type"] = "application/javascript";
      return new Response(file, { headers });
    }
    return new Response("Not found", { status: 404 });
  },
});

console.log(`Demo server: http://localhost:${port}`);
