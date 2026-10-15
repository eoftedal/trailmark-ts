/** Port of upstream tests/test_query_edge_cases.py. */
import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import { codeEdge, CodeGraph, codeUnit, sourceLocation, type CodeUnit } from "../src/models/index.js";
import { QueryEngine } from "../src/query/api.js";

const LOC = sourceLocation("test.py", 1, 10);

function makeNode(id: string, name: string): CodeUnit {
  return codeUnit({ id, name, kind: "function", location: LOC });
}

function simpleEngine(): QueryEngine {
  const graph = new CodeGraph();
  graph.nodes.set("a", makeNode("a", "a"));
  graph.nodes.set("b", makeNode("b", "b"));
  graph.edges.push(codeEdge({ sourceId: "a", targetId: "b", kind: "calls" }));
  return QueryEngine.fromGraph(graph);
}

describe("QueryEngine edge cases", () => {
  it("from directory with bad language", async () => {
    await expect(QueryEngine.fromSource(new MemoryFileSource("."), { language: "cobol" })).rejects.toThrow(
      /Unsupported language/,
    );
  });

  it("callees of nonexistent", () => {
    expect(simpleEngine().calleesOf("nonexistent")).toEqual([]);
  });

  it("paths with missing src", () => {
    expect(simpleEngine().pathsBetween("zzz", "b")).toEqual([]);
  });

  it("paths with missing dst", () => {
    expect(simpleEngine().pathsBetween("a", "zzz")).toEqual([]);
  });

  it("from graph materializes unresolved call proxy", () => {
    const graph = new CodeGraph();
    graph.nodes.set("a", makeNode("a", "a"));
    graph.edges.push(codeEdge({ sourceId: "a", targetId: "missing:target", kind: "calls" }));
    const reachable = QueryEngine.fromGraph(graph).reachableFrom("a");
    expect(new Set(reachable.map((n) => n["id"]))).toEqual(new Set(["proxy.unresolved:missing:target"]));
    const proxy = reachable[0]!;
    expect(proxy["kind"]).toBe("proxy");
    expect(proxy["origin"]).toBe("proxy");
    expect((proxy["attributes"] as Record<string, unknown>)["raw_symbol"]).toBe("missing:target");
  });

  it("unresolved proxy id escapes operator characters", () => {
    const graph = new CodeGraph();
    graph.nodes.set("a", makeNode("a", "a"));
    graph.edges.push(codeEdge({ sourceId: "a", targetId: "mod:func<T>", kind: "calls" }));
    const reachable = QueryEngine.fromGraph(graph).reachableFrom("a");
    expect(reachable[0]!["id"]).toBe("proxy.unresolved:mod:func_T_");
    expect((reachable[0]!["attributes"] as Record<string, unknown>)["raw_symbol"]).toBe("mod:func<T>");
  });
});
