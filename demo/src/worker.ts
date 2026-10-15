/// <reference lib="webworker" />
/** Parsing runs off the main thread: tree-sitter WASM + IndexedDB parse cache. */

import { detectEntrypoints } from "../../src/analysis/entrypoints.js";
import {
  DirectoryHandleFileSource,
  MemoryFileSource,
  type DirectoryHandleLike,
  type FileSource,
} from "../../src/fs/source.js";
import { parseDirectory } from "../../src/parse.js";
import type { GraphData } from "../../src/serialize.js";
import { graphToData } from "../../src/serialize.js";
import { indexedDbPersistence, KeyValueParseCache } from "../../src/persist/projects.js";
import type { ParseCache } from "../../src/persist/parse-cache.js";
import { configureTreeSitter } from "../../src/treesitter.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

declare const self: DedicatedWorkerGlobalScope;

let configured = false;
/** WASM assets are served next to the page; the page tells us its base URL. */
function configure(assetBase: string): void {
  if (configured) return;
  configured = true;
  configureTreeSitter({
    grammarBaseUrl: new URL("grammars/", assetBase),
    locateFile: (path) => new URL(path, assetBase).href,
  });
}

const { parseCache } = indexedDbPersistence();
// Entries from older parser versions are never hit again; reclaim the space.
void parseCache.pruneStale().catch(() => undefined);

/** Wraps the cache to count hits for progress reporting. */
class CountingCache implements ParseCache {
  hits = 0;
  constructor(private readonly inner: KeyValueParseCache) {}
  async get(key: string): Promise<GraphData | undefined> {
    const v = await this.inner.get(key);
    if (v !== undefined) this.hits++;
    return v;
  }
  set(key: string, value: GraphData): Promise<void> {
    return this.inner.set(key, value);
  }
}

const post = (msg: WorkerResponse) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  configure(req.assetBase);
  try {
    if (req.type === "clear-cache") {
      await parseCache.clear();
      post({ type: "status", message: "Parse cache cleared" });
      return;
    }
    const started = performance.now();
    let source: FileSource;
    if (req.handle) source = new DirectoryHandleFileSource(req.handle as unknown as DirectoryHandleLike);
    else
      source = new MemoryFileSource(
        req.root ?? "project",
        (req.files ?? []).map((f) => [f.path, new Uint8Array(f.data)]),
      );

    const cache = new CountingCache(parseCache);
    let files = 0;
    post({ type: "status", message: "Scanning files…" });
    const graph = await parseDirectory(source, req.language, {
      cache,
      onProgress: (p) => {
        files++;
        post({ type: "progress", language: p.language, filePath: p.filePath, done: files, cached: cache.hits });
      },
    });
    post({ type: "status", message: "Detecting entrypoints…" });
    for (const [id, tag] of await detectEntrypoints(graph, source, source.root)) graph.entrypoints.set(id, tag);
    post({
      type: "done",
      graph: graphToData(graph),
      elapsedMs: performance.now() - started,
      files,
      cached: cache.hits,
    });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
