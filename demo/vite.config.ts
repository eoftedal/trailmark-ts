import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { defineConfig, type Plugin } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));

/** Serve (dev) and emit (build) the tree-sitter runtime and grammar WASM files. */
function wasmAssets(): Plugin {
  const files = new Map<string, string>();
  files.set("web-tree-sitter.wasm", `${root}/node_modules/web-tree-sitter/web-tree-sitter.wasm`);
  for (const f of readdirSync(`${root}/grammars`)) {
    if (f.endsWith(".wasm")) files.set(`grammars/${f}`, `${root}/grammars/${f}`);
  }
  return {
    name: "trailmark-wasm-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? "").split("?")[0]!.replace(/^\//, "");
        const file = files.get(path);
        if (file === undefined) return next();
        res.setHeader("Content-Type", "application/wasm");
        res.end(readFileSync(file));
      });
    },
    generateBundle() {
      for (const [fileName, file] of files) {
        this.emitFile({ type: "asset", fileName, source: readFileSync(file) });
      }
    },
  };
}

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [wasmAssets()],
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true, target: "es2022" },
});
