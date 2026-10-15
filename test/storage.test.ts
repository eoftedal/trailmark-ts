/** Port of upstream tests/test_storage.py. */
import { describe, expect, it } from "vitest";

import {
  codeEdge,
  CodeGraph,
  codeUnit,
  entrypointTag,
  sourceLocation,
  type Annotation,
  type CodeEdge,
  type CodeUnit,
} from "../src/models/index.js";
import { GraphStore } from "../src/storage/graph-store.js";

const LOC = sourceLocation("test.py", 1, 10);

function makeNode(id: string, name: string, complexity: number | null = null): CodeUnit {
  return codeUnit({ id, name, kind: "function", location: LOC, cyclomaticComplexity: complexity });
}

function makeGraph(nodes: CodeUnit[], edges: CodeEdge[] = [], subgraphs: Record<string, string[]> = {}): CodeGraph {
  const graph = new CodeGraph();
  for (const n of nodes) graph.nodes.set(n.id, n);
  graph.edges.push(...edges);
  for (const [name, ids] of Object.entries(subgraphs)) graph.subgraphs.set(name, new Set(ids));
  return graph;
}

const calls = (sourceId: string, targetId: string) => codeEdge({ sourceId, targetId, kind: "calls" });

/** A -> B -> C, A -> D. */
function buildGraph(): [CodeGraph, GraphStore] {
  const graph = makeGraph(
    ["a", "b", "c", "d"].map((x) => makeNode(x, x)),
    [calls("a", "b"), calls("b", "c"), calls("a", "d")],
  );
  return [graph, new GraphStore(graph)];
}

/** A graph where CONTAINS would be a false call bridge. */
function buildContainsBridgeGraph(): [CodeGraph, GraphStore] {
  const graph = makeGraph(
    ["mod", "a", "b"].map((x) => makeNode(x, x)),
    [codeEdge({ sourceId: "mod", targetId: "a", kind: "contains" }), calls("a", "b")],
  );
  return [graph, new GraphStore(graph)];
}

const ids = (units: CodeUnit[]) => new Set(units.map((u) => u.id));

describe("GraphStore callers", () => {
  it("callers of b", () => {
    const callers = buildGraph()[1].callersOf("b");
    expect(callers).toHaveLength(1);
    expect(callers[0]!.id).toBe("a");
    expect(callers[0]!.name).toBe("a");
  });

  it("callers of c", () => {
    const callers = buildGraph()[1].callersOf("c");
    expect(callers.map((c) => c.id)).toEqual(["b"]);
  });

  it("callers of root", () => {
    expect(buildGraph()[1].callersOf("a")).toHaveLength(0);
  });

  it("callers of nonexistent", () => {
    expect(buildGraph()[1].callersOf("zzz")).toEqual([]);
  });
});

describe("GraphStore callees", () => {
  it("callees of a", () => {
    const callees = buildGraph()[1].calleesOf("a");
    expect(ids(callees)).toEqual(new Set(["b", "d"]));
    expect(callees).toHaveLength(2);
  });

  it("callees of b", () => {
    expect(
      buildGraph()[1]
        .calleesOf("b")
        .map((c) => c.id),
    ).toEqual(["c"]);
  });

  it("callees of leaf", () => {
    expect(buildGraph()[1].calleesOf("c")).toEqual([]);
  });

  it("callees of nonexistent", () => {
    expect(buildGraph()[1].calleesOf("zzz")).toEqual([]);
  });

  it("callees differ from callers", () => {
    const store = buildGraph()[1];
    expect(ids(store.calleesOf("b"))).toEqual(new Set(["c"]));
    expect(ids(store.callersOf("b"))).toEqual(new Set(["a"]));
  });

  it("callees only calls edges", () => {
    const graph = makeGraph(
      [makeNode("mod", "mod"), makeNode("f", "f")],
      [codeEdge({ sourceId: "mod", targetId: "f", kind: "contains" })],
    );
    expect(new GraphStore(graph).calleesOf("mod")).toEqual([]);
  });

  it("callers only calls edges", () => {
    const graph = makeGraph(
      [makeNode("mod", "mod"), makeNode("f", "f")],
      [codeEdge({ sourceId: "mod", targetId: "f", kind: "contains" })],
    );
    expect(new GraphStore(graph).callersOf("f")).toEqual([]);
  });
});

describe("GraphStore paths", () => {
  it("a to c", () => {
    expect(buildGraph()[1].pathsBetween("a", "c")).toEqual([["a", "b", "c"]]);
  });

  it("a to d", () => {
    expect(buildGraph()[1].pathsBetween("a", "d")).toEqual([["a", "d"]]);
  });

  it("no path", () => {
    expect(buildGraph()[1].pathsBetween("c", "a")).toEqual([]);
  });

  it("nonexistent src/dst/both", () => {
    const store = buildGraph()[1];
    expect(store.pathsBetween("zzz", "c")).toEqual([]);
    expect(store.pathsBetween("a", "zzz")).toEqual([]);
    expect(store.pathsBetween("zzz", "yyy")).toEqual([]);
  });

  it("max depth too short", () => {
    expect(buildGraph()[1].pathsBetween("a", "c", 1)).toHaveLength(0);
  });

  it("max depth sufficient", () => {
    expect(buildGraph()[1].pathsBetween("a", "c", 3)).toEqual([["a", "b", "c"]]);
  });

  it("default max depth", () => {
    expect(buildGraph()[1].pathsBetween("a", "c")).toHaveLength(1);
  });

  it("default max depth is 20 (behavioral: 20-node path found, 21-node not)", () => {
    const n = 21;
    const names = Array.from({ length: n }, (_, i) => `n${i}`);
    const graph = makeGraph(
      names.map((x) => makeNode(x, x)),
      names.slice(1).map((x, i) => calls(names[i]!, x)),
    );
    const store = new GraphStore(graph);
    expect(store.pathsBetween("n0", "n19")).toHaveLength(1);
    expect(store.pathsBetween("n0", "n20")).toHaveLength(0);
    expect(store.pathsBetween("n0", "n20", 21)).toHaveLength(1);
  });

  it("direct", () => {
    expect(buildGraph()[1].pathsBetween("a", "b")).toEqual([["a", "b"]]);
  });

  it("self", () => {
    expect(buildGraph()[1].pathsBetween("a", "a")).toHaveLength(0);
  });

  it("ignore non-call edges", () => {
    const store = buildContainsBridgeGraph()[1];
    expect(store.pathsBetween("mod", "b")).toEqual([]);
    expect(store.pathsBetween("a", "b")).toEqual([["a", "b"]]);
  });

  it("can use explicit projection", () => {
    const graph = makeGraph(
      ["src", "proxy", "bin"].map((x) => makeNode(x, x)),
      [calls("src", "proxy"), codeEdge({ sourceId: "proxy", targetId: "bin", kind: "corresponds_to" })],
    );
    const store = new GraphStore(graph);
    expect(store.pathsBetween("src", "bin")).toEqual([]);
    expect(store.pathsBetween("src", "bin", 20, new Set(["calls", "corresponds_to"]))).toEqual([
      ["src", "proxy", "bin"],
    ]);
  });
});

describe("GraphStore reachability", () => {
  it("reachable from a", () => {
    expect(buildGraph()[1].reachableFrom("a")).toEqual(new Set(["b", "c", "d"]));
  });

  it("reachable from b", () => {
    expect(buildGraph()[1].reachableFrom("b")).toEqual(new Set(["c"]));
  });

  it("reachable from leaf / d / nonexistent", () => {
    const store = buildGraph()[1];
    expect(store.reachableFrom("c")).toEqual(new Set());
    expect(store.reachableFrom("d")).toEqual(new Set());
    expect(store.reachableFrom("zzz")).toEqual(new Set());
  });

  it("ignores non-call edges", () => {
    const store = buildContainsBridgeGraph()[1];
    expect(store.reachableFrom("mod")).toEqual(new Set());
    expect(store.reachableFrom("a")).toEqual(new Set(["b"]));
  });

  it("can use explicit projection", () => {
    const graph = makeGraph(
      ["a", "b", "c"].map((x) => makeNode(x, x)),
      [codeEdge({ sourceId: "a", targetId: "b", kind: "type_uses" }), calls("b", "c")],
    );
    const store = new GraphStore(graph);
    expect(store.reachableFrom("a")).toEqual(new Set());
    expect(store.reachableFrom("a", new Set(["type_uses", "calls"]))).toEqual(new Set(["b", "c"]));
  });
});

describe("GraphStore ancestors", () => {
  it("ignore non-call edges", () => {
    const store = buildContainsBridgeGraph()[1];
    expect(store.ancestorsOf("b")).toEqual(new Set(["a"]));
    expect(store.ancestorsOf("a")).toEqual(new Set());
  });
});

describe("GraphStore subgraph connections", () => {
  it("subgraph edges induced", () => {
    const graph = makeGraph(
      ["a", "b", "c"].map((x) => makeNode(x, x)),
      [calls("a", "b"), calls("b", "c")],
      { pair: ["a", "b"] },
    );
    const edges = new GraphStore(graph).subgraphEdges("pair");
    expect(edges.map((e) => [e.sourceId, e.targetId])).toEqual([["a", "b"]]);
  });

  it("connect subgraphs", () => {
    const [graph, store] = buildGraph();
    graph.subgraphs.set("sources", new Set(["a"]));
    graph.subgraphs.set("sinks", new Set(["c", "d"]));
    const paths = store.connectSubgraphs("sources", "sinks");
    expect(paths).toContainEqual(["a", "b", "c"]);
    expect(paths).toContainEqual(["a", "d"]);
  });

  it("connect subgraphs overlap", () => {
    const [graph, store] = buildGraph();
    graph.subgraphs.set("left", new Set(["a", "b"]));
    graph.subgraphs.set("right", new Set(["b"]));
    expect(store.connectSubgraphs("left", "right")).toContainEqual(["b"]);
  });

  it("connect subgraphs missing", () => {
    expect(buildGraph()[1].connectSubgraphs("missing", "also_missing")).toEqual([]);
  });
});

describe("GraphStore annotations", () => {
  it("nodes with annotation", () => {
    const [graph] = buildGraph();
    graph.annotations.set("b", [{ kind: "assumption", description: "x > 0", source: "docstring" }]);
    const nodes = new GraphStore(graph).nodesWithAnnotation("assumption");
    expect(nodes.map((n) => n.id)).toEqual(["b"]);
  });

  it("no matching annotations", () => {
    expect(buildGraph()[1].nodesWithAnnotation("assumption")).toHaveLength(0);
  });

  it("annotation wrong kind", () => {
    const [graph] = buildGraph();
    graph.annotations.set("a", [{ kind: "assumption", description: "test", source: "test" }]);
    expect(new GraphStore(graph).nodesWithAnnotation("invariant")).toHaveLength(0);
  });
});

describe("GraphStore entrypoints", () => {
  it("all entrypoints", () => {
    const [graph] = buildGraph();
    graph.entrypoints.set("a", entrypointTag("user_input", { trustLevel: "untrusted_external" }));
    const eps = new GraphStore(graph).allEntrypoints();
    expect(eps).toHaveLength(1);
    expect(eps[0]![0]).toBe("a");
    expect(eps[0]![1].kind).toBe("user_input");
    expect(eps[0]![1].trustLevel).toBe("untrusted_external");
  });

  it("all entrypoints empty", () => {
    expect(buildGraph()[1].allEntrypoints()).toEqual([]);
  });

  function withApiEntry(...epIds: string[]): GraphStore {
    const [graph] = buildGraph();
    for (const id of epIds) graph.entrypoints.set(id, entrypointTag("api"));
    return new GraphStore(graph);
  }

  it("entrypoint paths to", () => {
    expect(withApiEntry("a").entrypointPathsTo("c")).toEqual([["a", "b", "c"]]);
  });

  it("entrypoint paths to direct", () => {
    expect(withApiEntry("a").entrypointPathsTo("b")).toEqual([["a", "b"]]);
  });

  it("entrypoint paths to unreachable", () => {
    expect(withApiEntry("c").entrypointPathsTo("a")).toEqual([]);
  });

  it("entrypoint paths to self", () => {
    expect(withApiEntry("a").entrypointPathsTo("a")).toEqual([]);
  });

  it("entrypoint paths max depth", () => {
    expect(withApiEntry("a").entrypointPathsTo("c", 1)).toEqual([]);
  });

  it("entrypoint paths default max depth is 20 (behavioral)", () => {
    const names = Array.from({ length: 21 }, (_, i) => `n${i}`);
    const graph = makeGraph(
      names.map((x) => makeNode(x, x)),
      names.slice(1).map((x, i) => calls(names[i]!, x)),
    );
    graph.entrypoints.set("n0", entrypointTag("api"));
    const store = new GraphStore(graph);
    expect(store.entrypointPathsTo("n19")).toHaveLength(1);
    expect(store.entrypointPathsTo("n20")).toHaveLength(0);
  });

  it("multiple entrypoints", () => {
    const [graph] = buildGraph();
    graph.entrypoints.set("a", entrypointTag("api"));
    graph.entrypoints.set("b", entrypointTag("user_input"));
    const paths = new GraphStore(graph).entrypointPathsTo("c");
    expect(paths).toHaveLength(2);
    expect(paths).toContainEqual(["a", "b", "c"]);
    expect(paths).toContainEqual(["b", "c"]);
  });

  it("entrypoint paths ignore non-call edges", () => {
    const [graph] = buildContainsBridgeGraph();
    graph.entrypoints.set("mod", entrypointTag("api"));
    expect(new GraphStore(graph).entrypointPathsTo("b")).toEqual([]);
  });
});

describe("GraphStore complexity", () => {
  it("nodes by complexity", () => {
    const [graph] = buildGraph();
    graph.nodes.set("a", makeNode("a", "a", 15));
    graph.nodes.set("b", makeNode("b", "b", 3));
    const hot = new GraphStore(graph).nodesByComplexity(10);
    expect(hot).toHaveLength(1);
    expect(hot[0]!.id).toBe("a");
    expect(hot[0]!.cyclomaticComplexity).toBe(15);
  });

  it("boundary complexity", () => {
    const [graph] = buildGraph();
    graph.nodes.set("a", makeNode("a", "a", 10));
    const store = new GraphStore(graph);
    expect(store.nodesByComplexity(10)).toHaveLength(1);
    expect(store.nodesByComplexity(11)).toHaveLength(0);
  });

  it("none complexity excluded", () => {
    expect(buildGraph()[1].nodesByComplexity(1)).toEqual([]);
  });

  it("multiple matches", () => {
    const graph = makeGraph([makeNode("a", "a", 10), makeNode("b", "b", 20), makeNode("c", "c", 5)]);
    expect(ids(new GraphStore(graph).nodesByComplexity(10))).toEqual(new Set(["a", "b"]));
  });
});

describe("GraphStore findNode", () => {
  it("by exact id", () => {
    const node = buildGraph()[1].findNode("a");
    expect(node?.id).toBe("a");
    expect(node?.name).toBe("a");
  });

  it("by name", () => {
    expect(buildGraph()[1].findNode("b")?.id).toBe("b");
  });

  it("by colon suffix", () => {
    expect(new GraphStore(makeGraph([makeNode("mod:func", "func")])).findNode("func")?.id).toBe("mod:func");
  });

  it("by dot method", () => {
    const store = new GraphStore(makeGraph([makeNode("mod:Cls.method", "method")]));
    expect(store.findNode("method")?.id).toBe("mod:Cls.method");
  });

  it("prefers exact id", () => {
    expect(new GraphStore(makeGraph([makeNode("a", "different_name")])).findNode("a")?.id).toBe("a");
  });

  it("by name without colon suffix", () => {
    expect(new GraphStore(makeGraph([makeNode("opaque_id", "target")])).findNode("target")?.id).toBe("opaque_id");
  });

  it("returns undefined", () => {
    expect(buildGraph()[1].findNode("nonexistent")).toBeUndefined();
  });

  it("findNodeId", () => {
    const store = buildGraph()[1];
    expect(store.findNodeId("a")).toBe("a");
    expect(store.findNodeId("nonexistent")).toBeNull();
  });

  it("findNodeId colon suffix", () => {
    expect(new GraphStore(makeGraph([makeNode("mod:func", "func")])).findNodeId("func")).toBe("mod:func");
  });

  it("findNodeId dot method", () => {
    const store = new GraphStore(makeGraph([makeNode("mod:Cls.method", "method")]));
    expect(store.findNodeId("method")).toBe("mod:Cls.method");
  });
});

describe("GraphStore annotation mutation", () => {
  const ann = (kind: Annotation["kind"], description = "test", source = "test"): Annotation => ({
    kind,
    description,
    source,
  });

  it("add annotation to existing node", () => {
    const store = buildGraph()[1];
    const a = ann("assumption", "x > 0", "llm");
    expect(store.addAnnotation("a", a)).toBe(true);
    expect(store.annotationsFor("a")).toEqual([a]);
  });

  it("add annotation to nonexistent node", () => {
    expect(buildGraph()[1].addAnnotation("zzz", ann("assumption"))).toBe(false);
  });

  it("annotationsFor with data", () => {
    const [graph] = buildGraph();
    graph.annotations.set("b", [ann("precondition", "non-null", "docstring")]);
    const anns = new GraphStore(graph).annotationsFor("b");
    expect(anns).toHaveLength(1);
    expect(anns[0]!.kind).toBe("precondition");
  });

  it("annotationsFor none / nonexistent", () => {
    const store = buildGraph()[1];
    expect(store.annotationsFor("a")).toEqual([]);
    expect(store.annotationsFor("zzz")).toEqual([]);
  });

  it("annotationsFor returns copy", () => {
    const store = buildGraph()[1];
    store.addAnnotation("a", ann("assumption"));
    store.annotationsFor("a").length = 0;
    expect(store.annotationsFor("a")).toHaveLength(1);
  });

  it("clear annotations existing node", () => {
    const store = buildGraph()[1];
    store.addAnnotation("a", ann("assumption"));
    expect(store.clearAnnotations("a")).toBe(true);
    expect(store.annotationsFor("a")).toEqual([]);
  });

  it("clear annotations nonexistent node", () => {
    expect(buildGraph()[1].clearAnnotations("zzz")).toBe(false);
  });

  it("clear annotations by kind", () => {
    const store = buildGraph()[1];
    store.addAnnotation("a", ann("assumption", "assume"));
    store.addAnnotation("a", ann("invariant", "invariant"));
    expect(store.clearAnnotations("a", "assumption")).toBe(true);
    const anns = store.annotationsFor("a");
    expect(anns).toHaveLength(1);
    expect(anns[0]!.kind).toBe("invariant");
  });
});
