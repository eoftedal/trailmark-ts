import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IDBFactory } from "fake-indexeddb";
import { afterAll, describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import { parseDirectory } from "../src/parse.js";
import { FsKeyValueStore } from "../src/persist/fs-kv.js";
import { IndexedDbKeyValueStore, type KeyValueStore } from "../src/persist/kv.js";
import { KeyValueParseCache, memoryPersistence, ProjectStore, type ProjectRecord } from "../src/persist/projects.js";
import { QueryEngine } from "../src/query/api.js";
import { graphFromJsonString, graphToJsonString, type GraphData } from "../src/serialize.js";

const PROJECT = {
  "app/auth.py":
    "class Auth:\n    def verify(self, token: str) -> bool:\n        return self._check(token)\n\n    def _check(self, token):\n        if not token:\n            raise ValueError('x')\n        return True\n",
  "app/main.py": "from app.auth import Auth\n\ndef main():\n    return Auth().verify(read())\n",
};

describe("serialization", () => {
  it("round-trips a graph losslessly, including annotations/entrypoints/subgraphs", async () => {
    const graph = await parseDirectory(new MemoryFileSource("proj", PROJECT), "python");
    graph.addAnnotation("app.auth:Auth.verify", { kind: "assumption", description: "token is jwt", source: "manual" });
    graph.entrypoints.set("app.main:main", {
      kind: "user_input",
      trustLevel: "untrusted_external",
      description: null,
      assetValue: "low",
    });
    graph.subgraphs.set("sinks", new Set(["app.auth:Auth._check"]));
    const restored = graphFromJsonString(graphToJsonString(graph));
    expect(QueryEngine.fromGraph(restored).toJson()).toBe(QueryEngine.fromGraph(graph).toJson());
    expect(restored.annotations).toEqual(graph.annotations);
    expect(restored.entrypoints).toEqual(graph.entrypoints);
    expect(restored.edges).toEqual(graph.edges);
  });
});

describe("parse cache", () => {
  it("reuses per-file results and re-parses only changed files", async () => {
    const { parseCache } = memoryPersistence();
    const source = new MemoryFileSource("proj", PROJECT);
    const first = await parseDirectory(source, "python", { cache: parseCache });
    expect(await parseCacheSize(parseCache)).toBe(2);

    const second = await parseDirectory(source, "python", { cache: parseCache });
    expect(QueryEngine.fromGraph(second).toJson()).toBe(QueryEngine.fromGraph(first).toJson());
    expect(await parseCacheSize(parseCache)).toBe(2);

    source.set("app/main.py", PROJECT["app/main.py"] + "\ndef extra():\n    pass\n");
    const third = await parseDirectory(source, "python", { cache: parseCache });
    expect(await parseCacheSize(parseCache)).toBe(3);
    expect(third.nodes.has("app.main:extra")).toBe(true);
  });
});

async function parseCacheSize(cache: KeyValueParseCache): Promise<number> {
  return (await (cache as unknown as { kv: KeyValueStore<GraphData> }).kv.keys()).length;
}

const backends: [string, () => KeyValueStore<ProjectRecord>][] = [
  ["indexeddb", () => new IndexedDbKeyValueStore<ProjectRecord>("graphs", "trailmark-test", new IDBFactory())],
];
const tmp = mkdtempSync(join(tmpdir(), "trailmark-kv-"));
backends.push(["fs", () => new FsKeyValueStore<ProjectRecord>(tmp)]);
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe.each(backends)("ProjectStore (%s)", (_name, make) => {
  it("saves, lists, loads and deletes projects", async () => {
    const projects = new ProjectStore(make());
    const graph = await parseDirectory(new MemoryFileSource("proj", PROJECT), "python");
    const meta = await projects.save("p1", graph, "My project");
    expect(meta).toMatchObject({ id: "p1", name: "My project", language: "python", nodeCount: graph.nodes.size });
    expect((await projects.list()).map((m) => m.id)).toEqual(["p1"]);
    const loaded = await projects.load("p1");
    expect(loaded).toBeDefined();
    expect(QueryEngine.fromGraph(loaded!).toJson()).toBe(QueryEngine.fromGraph(graph).toJson());
    await projects.delete("p1");
    expect(await projects.list()).toEqual([]);
    expect(await projects.load("p1")).toBeUndefined();
  });
});

describe("parse cache invalidation", () => {
  it("keys include a fingerprint of the parser sources and grammars", async () => {
    const { parseCacheKey, PARSER_CACHE_VERSION } = await import("../src/persist/parse-cache.js");
    const { PARSER_FINGERPRINT } = await import("../src/persist/parser-fingerprint.generated.js");
    expect(PARSER_CACHE_VERSION).toContain(PARSER_FINGERPRINT);
    expect(await parseCacheKey("java", "a/B.java", "a", "class B {}")).toContain(PARSER_FINGERPRINT);
  });

  it("the committed fingerprint matches the current parser sources (run `npm run fingerprint`)", () => {
    const result = spawnSync(process.execPath, ["scripts/parser-fingerprint.mjs", "--check"], { encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("KeyValueParseCache.pruneStale", () => {
  it("removes entries from other parser versions and keeps current ones", async () => {
    const { parseCache } = memoryPersistence();
    const source = new MemoryFileSource("proj", PROJECT);
    await parseDirectory(source, "python", { cache: parseCache });
    const kv = (parseCache as unknown as { kv: KeyValueStore<GraphData> }).kv;
    await kv.set("trailmark-ts/1||python|proj|proj/app/main.py|deadbeef", (await kv.get((await kv.keys())[0]!))!);
    expect(await parseCache.pruneStale()).toBe(1);
    expect((await kv.keys()).length).toBe(2);
  });
});

describe("carryOverAnnotations", () => {
  const ann = (description: string, source = "manual") => ({ kind: "assumption" as const, description, source });

  it("keeps annotations across a re-analysis, skips derived ones, and reports orphans", async () => {
    const { carryOverAnnotations } = await import("../src/analysis/carry-over.js");
    const source = new MemoryFileSource("proj", PROJECT);
    const before = await parseDirectory(source, "python");
    before.addAnnotation("app.auth:Auth.verify", ann("token is a JWT"));
    before.addAnnotation("app.auth:Auth.verify", ann("blast radius 3", "preanalysis"));
    before.addAnnotation("app.main:main", ann("entry from CLI", "llm"));

    // The project changes: main() is renamed, verify() still exists.
    source.set("app/main.py", PROJECT["app/main.py"].replace("def main", "def run"));
    const after = await parseDirectory(source, "python");
    const result = carryOverAnnotations(before, after);

    expect(result.carried).toBe(1);
    expect(after.annotations.get("app.auth:Auth.verify")).toEqual([ann("token is a JWT")]);
    expect([...result.orphaned]).toEqual([["app.main:main", [ann("entry from CLI", "llm")]]]);
    // Orphans stay in the graph so they reattach if the node comes back.
    expect(after.annotations.get("app.main:main")).toEqual([ann("entry from CLI", "llm")]);
    expect(QueryEngine.fromGraph(after).annotationsOf("app.auth:Auth.verify")).toHaveLength(1);
  });

  it("does not duplicate annotations already present in the new graph", async () => {
    const { carryOverAnnotations } = await import("../src/analysis/carry-over.js");
    const source = new MemoryFileSource("proj", PROJECT);
    const before = await parseDirectory(source, "python");
    const after = await parseDirectory(source, "python");
    before.addAnnotation("app.main:main", ann("same note"));
    after.addAnnotation("app.main:main", ann("same note"));
    expect(carryOverAnnotations(before, after).carried).toBe(0);
    expect(after.annotations.get("app.main:main")).toHaveLength(1);
  });
});
