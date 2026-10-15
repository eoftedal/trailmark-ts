/** Port of upstream tests/test_storage_edge_cases.py. */
import { describe, expect, it } from "vitest";

import { codeEdge, CodeGraph, codeUnit, sourceLocation, type CodeUnit } from "../src/models/index.js";
import { GraphStore } from "../src/storage/graph-store.js";

const LOC = sourceLocation("test.py", 1, 10);

function makeNode(id: string, name: string): CodeUnit {
  return codeUnit({ id, name, kind: "function", location: LOC });
}

function buildStore(): GraphStore {
  const graph = new CodeGraph();
  for (const [id, name] of [
    ["mod:a", "a"],
    ["mod:b", "b"],
    ["mod:Cls.method", "method"],
  ] as const) {
    graph.nodes.set(id, makeNode(id, name));
  }
  graph.edges.push(codeEdge({ sourceId: "mod:a", targetId: "mod:b", kind: "calls" }));
  return new GraphStore(graph);
}

describe("GraphStore edge cases", () => {
  it("callees of missing node", () => {
    expect(buildStore().calleesOf("nonexistent")).toEqual([]);
  });

  it("paths missing src", () => {
    expect(buildStore().pathsBetween("zzz", "mod:b")).toEqual([]);
  });

  it("paths missing dst", () => {
    expect(buildStore().pathsBetween("mod:a", "zzz")).toEqual([]);
  });

  it("reachable missing node", () => {
    expect(buildStore().reachableFrom("zzz")).toEqual(new Set());
  });

  it("find by method name", () => {
    expect(buildStore().findNode("method")?.id).toBe("mod:Cls.method");
  });

  it("find returns undefined", () => {
    expect(buildStore().findNode("nonexistent")).toBeUndefined();
  });
});
