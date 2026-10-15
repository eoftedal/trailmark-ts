/** Tests for importing external binary-analysis graphs (port of tests/test_binary_import.py). */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CodeGraph, codeUnit, sourceLocation, type CodeUnit } from "../src/models/index.js";
import type { JsonObject } from "../src/query/dicts.js";
import { QueryEngine } from "../src/query/api.js";

const LOC = sourceLocation("src/main.c", 1, 20);

function graphOf(nodes: CodeUnit[], rootPath = ""): CodeGraph {
  const g = new CodeGraph({ rootPath });
  for (const n of nodes) g.nodes.set(n.id, n);
  return g;
}

function sourceEngine(): QueryEngine {
  return QueryEngine.fromGraph(
    graphOf([codeUnit({ id: "src.main:main", name: "main", kind: "function", location: LOC })], "."),
  );
}

const edgesOf = (engine: QueryEngine, kind: string) =>
  (JSON.parse(engine.toJson()).edges as JsonObject[]).filter((e) => e["kind"] === kind);

/** src.main (module, 1-100) containing src.main:main (function, 10-20). */
function moduleAndMain(): CodeGraph {
  return graphOf(
    [
      codeUnit({ id: "src.main", name: "src.main", kind: "module", location: sourceLocation("src/main.c", 1, 100) }),
      codeUnit({ id: "src.main:main", name: "main", kind: "function", location: sourceLocation("src/main.c", 10, 20) }),
    ],
    ".",
  );
}

describe("binary import", () => {
  it("imports nodes, calls and correspondence", () => {
    const binaryGraph = {
      artifact: { key: "app", architecture: "x86_64", hash: "abc123", path: "build/app" },
      functions: [
        { name: "main", address: "0x1000", size: 32, section: ".text", source: { symbol: "main" } },
        { name: "helper", address: "0x1040", size: 16 },
      ],
      calls: [
        { source: "main", target: "helper", confidence: "certain" },
        { source: "helper", target: "puts", confidence: "uncertain" },
      ],
    };
    const engine = sourceEngine();
    const result = engine.augmentBinary(JSON.stringify(binaryGraph), { graphPath: "/tmp/binary.json" });

    expect(result["binary_nodes"]).toBe(2);
    expect(result["call_edges"]).toBe(2);
    expect(result["external_proxies"]).toBe(1);
    expect(result["correspondences"]).toBe(1);
    expect(engine.subgraphNames()).toContain("binary:app");

    const data = JSON.parse(engine.toJson());
    expect(data.nodes).toHaveProperty(["bin.app:main"]);
    expect(data.nodes["bin.app:main"].origin).toBe("binary");
    expect(data.nodes["bin.app:main"].attributes.architecture).toBe("x86_64");
    expect(data.nodes).toHaveProperty(["proxy.external:puts"]);
    expect(data.edges.some((e: JsonObject) => e["kind"] === "corresponds_to")).toBe(true);
  });

  it("duplicate binary symbols fall back to rva ids", () => {
    const engine = sourceEngine();
    engine.augmentBinary(
      {
        artifact: { key: "dup" },
        functions: [
          { name: "thunk", rva: 16 },
          { name: "thunk", rva: 32 },
        ],
        calls: [],
      },
      { graphPath: "binary.json", connectSources: false },
    );
    const data = JSON.parse(engine.toJson());
    expect(data.nodes).toHaveProperty(["bin.dup:sub_10"]);
    expect(data.nodes).toHaveProperty(["bin.dup:sub_20"]);
  });

  it("duplicate binary symbols do not resolve by ambiguous name", () => {
    const engine = QueryEngine.fromGraph(new CodeGraph());
    engine.augmentBinary(
      {
        artifact: { key: "dup" },
        functions: [
          { name: "thunk", rva: 16 },
          { name: "thunk", rva: 32 },
        ],
        calls: [{ source: { rva: 16 }, target: "thunk" }],
      },
      { graphPath: "binary.json", connectSources: false },
    );
    expect(edgesOf(engine, "calls")).toEqual([
      { source: "bin.dup:sub_10", target: "proxy.external:thunk", kind: "calls", confidence: "certain" },
    ]);
  });

  it("duplicate binary aliases do not resolve by ambiguous name", () => {
    const engine = QueryEngine.fromGraph(new CodeGraph());
    engine.augmentBinary(
      {
        artifact: { key: "dup" },
        functions: [
          { symbol: "_Z1av", name: "shared", rva: 16 },
          { symbol: "_Z1bv", name: "shared", rva: 32 },
        ],
        calls: [{ source: "_Z1av", target: "shared" }],
      },
      { graphPath: "binary.json", connectSources: false },
    );
    expect(edgesOf(engine, "calls")).toEqual([
      { source: "bin.dup:_Z1av", target: "proxy.external:shared", kind: "calls", confidence: "certain" },
    ]);
  });

  it("file/line source mapping prefers tightest node", () => {
    const engine = QueryEngine.fromGraph(moduleAndMain());
    engine.augmentBinary(
      {
        artifact: { key: "app" },
        functions: [{ name: "main", rva: 16, source: { file: "src/main.c", line: 12 } }],
        calls: [],
      },
      { graphPath: "binary.json" },
    );
    expect(edgesOf(engine, "corresponds_to")[0]!["source"]).toBe("src.main:main");
  });

  it("symbol source mapping prefers function over container", () => {
    const engine = QueryEngine.fromGraph(moduleAndMain());
    engine.augmentBinary(
      { artifact: { key: "app" }, functions: [{ name: "main", rva: 16, source: { symbol: "main" } }], calls: [] },
      { graphPath: "binary.json" },
    );
    expect(edgesOf(engine, "corresponds_to")[0]!["source"]).toBe("src.main:main");
  });

  it("symbol source mapping skips ambiguous functions", () => {
    const engine = QueryEngine.fromGraph(
      graphOf([
        codeUnit({ id: "a:main", name: "main", kind: "function", location: sourceLocation("a.c", 1, 5) }),
        codeUnit({ id: "b:main", name: "main", kind: "function", location: sourceLocation("b.c", 1, 5) }),
      ]),
    );
    const result = engine.augmentBinary(
      { artifact: { key: "app" }, functions: [{ name: "main", rva: 16, source: { symbol: "main" } }], calls: [] },
      { graphPath: "binary.json" },
    );
    expect(result["correspondences"]).toBe(0);
    expect(edgesOf(engine, "corresponds_to")).toEqual([]);
  });

  it("matches upstream JSON for edge cases (stem key, sha256 ids, int parsing, repr'd targets)", () => {
    const input = JSON.parse(readFileSync(new URL("./fixtures/binary-import-input.json", import.meta.url), "utf8"));
    const expected = JSON.parse(
      readFileSync(new URL("./fixtures/binary-import-expected.json", import.meta.url), "utf8"),
    );
    const engine = sourceEngine();
    const result = engine.augmentBinary(input, { graphPath: "/data/my firmware.v2.json" });
    expect(JSON.stringify({ result, graph: engine.toDict() })).toBe(JSON.stringify(expected));
  });
});
