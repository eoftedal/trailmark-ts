/** Port of upstream tests/test_query.py. */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NodeFileSource } from "../src/fs/node.js";
import {
  codeEdge,
  CodeGraph,
  codeUnit,
  entrypointTag,
  sourceLocation,
  typeParameter,
  typeRef,
  type CodeEdge,
  type CodeUnit,
  type NodeKind,
} from "../src/models/index.js";
import { QueryEngine } from "../src/query/api.js";
import { annotationToDict, edgeToDict, unitToDict, type JsonObject } from "../src/query/dicts.js";

const LOC = sourceLocation("test.py", 1, 10);

function makeNode(id: string, name: string, complexity: number | null = null, kind: NodeKind = "function"): CodeUnit {
  return codeUnit({ id, name, kind, location: LOC, cyclomaticComplexity: complexity });
}

function makeGraph(nodes: CodeUnit[], edges: CodeEdge[] = [], subgraphs: Record<string, string[]> = {}): CodeGraph {
  const graph = new CodeGraph();
  for (const n of nodes) graph.nodes.set(n.id, n);
  graph.edges.push(...edges);
  for (const [name, ids] of Object.entries(subgraphs)) graph.subgraphs.set(name, new Set(ids));
  return graph;
}

const calls = (sourceId: string, targetId: string) => codeEdge({ sourceId, targetId, kind: "calls" });

/** entry -> handler -> db_query. */
function buildEngine(): QueryEngine {
  const graph = makeGraph(
    [makeNode("entry", "entry", 2), makeNode("handler", "handler", 12), makeNode("db_query", "db_query", 3)],
    [calls("entry", "handler"), calls("handler", "db_query")],
  );
  graph.entrypoints.set("entry", entrypointTag("user_input", { trustLevel: "untrusted_external" }));
  graph.dependencies = ["flask", "sqlalchemy"];
  return QueryEngine.fromGraph(graph);
}

describe("QueryEngine callers/callees", () => {
  it("callers of", () => {
    const callers = buildEngine().callersOf("handler");
    expect(callers).toHaveLength(1);
    expect(callers[0]!["name"]).toBe("entry");
    expect(callers[0]!["id"]).toBe("entry");
    expect(callers[0]!["kind"]).toBe("function");
  });

  it("callers of missing", () => {
    expect(buildEngine().callersOf("nonexistent")).toEqual([]);
  });

  it("callees of", () => {
    const callees = buildEngine().calleesOf("entry");
    expect(callees).toHaveLength(1);
    expect(callees[0]!["name"]).toBe("handler");
    expect(callees[0]!["id"]).toBe("handler");
    expect(callees[0]!["kind"]).toBe("function");
  });

  it("callees of missing", () => {
    expect(buildEngine().calleesOf("nonexistent")).toEqual([]);
  });
});

describe("QueryEngine paths", () => {
  it("paths between", () => {
    expect(buildEngine().pathsBetween("entry", "db_query")).toEqual([["entry", "handler", "db_query"]]);
  });

  it("paths direct", () => {
    expect(buildEngine().pathsBetween("entry", "handler")).toEqual([["entry", "handler"]]);
  });

  it("missing src/dst/both, no reverse", () => {
    const engine = buildEngine();
    expect(engine.pathsBetween("zzz", "db_query")).toEqual([]);
    expect(engine.pathsBetween("entry", "zzz")).toEqual([]);
    expect(engine.pathsBetween("zzz", "yyy")).toEqual([]);
    expect(engine.pathsBetween("db_query", "entry")).toEqual([]);
  });
});

describe("QueryEngine subgraphs", () => {
  it("subgraph edges", () => {
    const graph = makeGraph(
      ["a", "b", "c"].map((x) => makeNode(x, x)),
      [calls("a", "b"), calls("b", "c")],
      { pair: ["a", "b"] },
    );
    expect(QueryEngine.fromGraph(graph).subgraphEdges("pair")).toEqual([
      { source: "a", target: "b", kind: "calls", confidence: "certain" },
    ]);
  });

  it("connect subgraphs with bridge edges", () => {
    const graph = makeGraph(
      ["src", "proxy", "resolved", "bin"].map((x) => makeNode(x, x)),
      [
        calls("src", "proxy"),
        codeEdge({ sourceId: "proxy", targetId: "resolved", kind: "resolves_to" }),
        codeEdge({ sourceId: "resolved", targetId: "bin", kind: "corresponds_to" }),
      ],
      { source: ["src"], binary: ["bin"] },
    );
    const engine = QueryEngine.fromGraph(graph);
    expect(engine.connectSubgraphs("source", "binary")).toEqual([]);
    expect(
      engine.connectSubgraphs("source", "binary", { edgeKinds: ["calls", "resolves_to", "corresponds_to"] }),
    ).toEqual([["src", "proxy", "resolved", "bin"]]);
  });
});

describe("QueryEngine types", () => {
  it("generic parameters", () => {
    const node = codeUnit({
      id: "mod:Box",
      name: "Box",
      kind: "class",
      location: LOC,
      typeParameters: [typeParameter("T", { constraints: [typeRef("Sized")] })],
    });
    const engine = QueryEngine.fromGraph(makeGraph([node]));
    expect(engine.genericParameters("Box")).toEqual([
      {
        name: "T",
        constraints: [{ name: "Sized", module: null, generic_args: [] }],
        default: null,
        variance: null,
      },
    ]);
  });

  it("type references", () => {
    const node = codeUnit({
      id: "mod:make_box",
      name: "make_box",
      kind: "function",
      location: LOC,
      returnType: typeRef("Box", { genericArgs: [typeRef("int")] }),
    });
    const engine = QueryEngine.fromGraph(makeGraph([node]));
    expect(engine.typeReferences("make_box")).toEqual([
      { name: "Box", module: null, generic_args: [{ name: "int", module: null, generic_args: [] }] },
      { name: "int", module: null, generic_args: [] },
    ]);
  });
});

describe("QueryEngine attack surface", () => {
  it("exact", () => {
    const surface = buildEngine().attackSurface();
    expect(surface).toHaveLength(1);
    expect(surface[0]).toEqual({
      node_id: "entry",
      trust_level: "untrusted_external",
      kind: "user_input",
      asset_value: "low",
      description: null,
    });
  });

  it("with description", () => {
    const graph = makeGraph([makeNode("ep", "ep")]);
    graph.entrypoints.set("ep", entrypointTag("api", { trustLevel: "trusted_internal", description: "REST endpoint" }));
    const ep = QueryEngine.fromGraph(graph).attackSurface()[0]!;
    expect(ep["node_id"]).toBe("ep");
    expect(ep["trust_level"]).toBe("trusted_internal");
    expect(ep["kind"]).toBe("api");
    expect(ep["description"]).toBe("REST endpoint");
  });

  it("empty", () => {
    expect(QueryEngine.fromGraph(makeGraph([makeNode("a", "a")])).attackSurface()).toEqual([]);
  });
});

describe("QueryEngine complexity", () => {
  it("hotspots", () => {
    const hotspots = buildEngine().complexityHotspots(10);
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]!["name"]).toBe("handler");
    expect(hotspots[0]!["cyclomatic_complexity"]).toBe(12);
  });

  it("multiple sorted", () => {
    const engine = QueryEngine.fromGraph(
      makeGraph([makeNode("a", "a", 5), makeNode("b", "b", 15), makeNode("c", "c", 10)]),
    );
    const hotspots = engine.complexityHotspots(4);
    expect(hotspots.map((h) => h["cyclomatic_complexity"])).toEqual([15, 10, 5]);
    expect(hotspots.map((h) => h["name"])).toEqual(["b", "c", "a"]);
  });

  it("none excluded", () => {
    const engine = QueryEngine.fromGraph(makeGraph([makeNode("a", "a", null), makeNode("b", "b", 10)]));
    expect(engine.complexityHotspots(5).map((h) => h["name"])).toEqual(["b"]);
  });

  it("no hotspots", () => {
    expect(buildEngine().complexityHotspots(100)).toEqual([]);
  });

  it("default threshold", () => {
    const hotspots = buildEngine().complexityHotspots();
    expect(hotspots).toHaveLength(1);
    expect(hotspots[0]!["cyclomatic_complexity"]).toBe(12);
  });
});

describe("QueryEngine summary", () => {
  it("exact", () => {
    expect(buildEngine().summary()).toEqual({
      total_nodes: 3,
      functions: 3,
      classes: 0,
      proxies: 0,
      call_edges: 2,
      dependencies: ["flask", "sqlalchemy"],
      entrypoints: 1,
    });
  });

  it("with classes", () => {
    const engine = QueryEngine.fromGraph(
      makeGraph([
        makeNode("f", "f", null, "function"),
        makeNode("c", "c", null, "class"),
        makeNode("m", "m", null, "method"),
      ]),
    );
    const s = engine.summary();
    expect(s["total_nodes"]).toBe(3);
    expect(s["functions"]).toBe(2);
    expect(s["classes"]).toBe(1);
  });

  it("methods counted as functions", () => {
    const s = QueryEngine.fromGraph(makeGraph([makeNode("m", "m", null, "method")])).summary();
    expect(s["functions"]).toBe(1);
    expect(s["classes"]).toBe(0);
  });

  it("only calls counted", () => {
    const graph = makeGraph(
      [makeNode("a", "a"), makeNode("b", "b")],
      [calls("a", "b"), codeEdge({ sourceId: "a", targetId: "b", kind: "contains" })],
    );
    expect(QueryEngine.fromGraph(graph).summary()["call_edges"]).toBe(1);
  });
});

describe("QueryEngine toJson", () => {
  const data = () => JSON.parse(buildEngine().toJson()) as Record<string, any>;

  it("structure", () => {
    const d = data();
    expect(new Set(Object.keys(d))).toEqual(
      new Set(["language", "root_path", "summary", "nodes", "edges", "subgraphs"]),
    );
    expect(Object.keys(d["nodes"])).toHaveLength(3);
    expect(d["edges"]).toHaveLength(2);
  });

  it("edge dict exact", () => {
    const d = data();
    for (const edge of d["edges"]) {
      expect(new Set(Object.keys(edge))).toEqual(new Set(["source", "target", "kind", "confidence"]));
      expect(edge["kind"]).toBe("calls");
      expect(edge["confidence"]).toBe("certain");
    }
    const sources = new Set(d["edges"].map((e: JsonObject) => e["source"]));
    const targets = new Set(d["edges"].map((e: JsonObject) => e["target"]));
    expect(sources).toEqual(new Set(["entry", "handler"]));
    expect(targets).toEqual(new Set(["handler", "db_query"]));
  });

  it("node dict exact", () => {
    for (const [nid, node] of Object.entries(data()["nodes"] as Record<string, JsonObject>)) {
      expect(node["kind"]).toBe("function");
      expect(node["name"]).toBe(nid);
      expect(node["id"]).toBe(nid);
    }
  });

  it("language and root", () => {
    const d = data();
    expect(d["language"]).not.toBeNull();
    expect("root_path" in d).toBe(true);
  });

  it("summary embedded", () => {
    const engine = buildEngine();
    const d = JSON.parse(engine.toJson());
    const s = engine.summary();
    expect(d["summary"]["total_nodes"]).toBe(s["total_nodes"]);
    expect(d["summary"]["functions"]).toBe(s["functions"]);
    expect(d["summary"]["call_edges"]).toBe(s["call_edges"]);
  });

  it("indent default and custom", () => {
    expect(buildEngine().toJson()).toContain("\n  ");
    expect(buildEngine().toJson(4)).toContain("\n    ");
  });

  it("roundtrip", () => {
    expect(typeof data()).toBe("object");
  });
});

describe("dict conversions", () => {
  it("unitToDict keys", () => {
    const d = unitToDict(makeNode("x", "x", 5));
    expect(d["id"]).toBe("x");
    expect(d["name"]).toBe("x");
    expect(d["kind"]).toBe("function");
    expect(d["cyclomatic_complexity"]).toBe(5);
  });

  it("unitToDict class/method", () => {
    expect(unitToDict(makeNode("c", "c", null, "class"))["kind"]).toBe("class");
    expect(unitToDict(makeNode("m", "m", null, "method"))["kind"]).toBe("method");
  });

  it("edgeToDict calls", () => {
    expect(edgeToDict(calls("a", "b"))).toEqual({ source: "a", target: "b", kind: "calls", confidence: "certain" });
  });

  it("edgeToDict contains", () => {
    expect(edgeToDict(codeEdge({ sourceId: "mod", targetId: "func", kind: "contains" }))).toEqual({
      source: "mod",
      target: "func",
      kind: "contains",
      confidence: "certain",
    });
  });

  it("edgeToDict inherits", () => {
    const d = edgeToDict(codeEdge({ sourceId: "child", targetId: "parent", kind: "inherits", confidence: "inferred" }));
    expect(d).toEqual({ source: "child", target: "parent", kind: "inherits", confidence: "inferred" });
  });

  it("annotationToDict", () => {
    expect(annotationToDict({ kind: "assumption", description: "x > 0", source: "llm" })).toEqual({
      kind: "assumption",
      description: "x > 0",
      source: "llm",
    });
    expect(
      new Set(Object.keys(annotationToDict({ kind: "precondition", description: "test", source: "manual" }))),
    ).toEqual(new Set(["kind", "description", "source"]));
  });
});

describe("QueryEngine annotate", () => {
  it("existing node", () => {
    expect(buildEngine().annotate("handler", "assumption", "input is sanitized", "llm")).toBe(true);
  });

  it("nonexistent node", () => {
    expect(buildEngine().annotate("nonexistent", "assumption", "test")).toBe(false);
  });

  it("default source", () => {
    const engine = buildEngine();
    engine.annotate("handler", "assumption", "test");
    expect(engine.annotationsOf("handler")[0]!["source"]).toBe("manual");
  });

  it("annotationsOf with data", () => {
    const engine = buildEngine();
    engine.annotate("handler", "assumption", "input is sanitized", "llm");
    expect(engine.annotationsOf("handler")).toEqual([
      { kind: "assumption", description: "input is sanitized", source: "llm" },
    ]);
  });

  it("annotationsOf filtered by kind", () => {
    const engine = buildEngine();
    engine.annotate("handler", "assumption", "a");
    engine.annotate("handler", "invariant", "b");
    const anns = engine.annotationsOf("handler", "assumption");
    expect(anns.map((a) => a["kind"])).toEqual(["assumption"]);
  });

  it("annotationsOf nonexistent / empty", () => {
    const engine = buildEngine();
    expect(engine.annotationsOf("nonexistent")).toEqual([]);
    expect(engine.annotationsOf("handler")).toEqual([]);
  });

  it("clear all", () => {
    const engine = buildEngine();
    engine.annotate("handler", "assumption", "a");
    engine.annotate("handler", "invariant", "b");
    expect(engine.clearAnnotations("handler")).toBe(true);
    expect(engine.annotationsOf("handler")).toEqual([]);
  });

  it("clear by kind", () => {
    const engine = buildEngine();
    engine.annotate("handler", "assumption", "a");
    engine.annotate("handler", "invariant", "b");
    expect(engine.clearAnnotations("handler", "assumption")).toBe(true);
    expect(engine.annotationsOf("handler").map((a) => a["kind"])).toEqual(["invariant"]);
  });

  it("clear nonexistent node", () => {
    expect(buildEngine().clearAnnotations("nonexistent")).toBe(false);
  });
});

describe("QueryEngine fromSource", () => {
  it("from directory", async () => {
    // Upstream parses src/trailmark/models; use the Python KAT fixture directory instead.
    const dir = fileURLToPath(new URL("./fixtures/kat/python", import.meta.url));
    const engine = await QueryEngine.fromSource(new NodeFileSource(dir));
    const s = engine.summary();
    expect(s["total_nodes"] as number).toBeGreaterThan(5);
    expect(s["classes"] as number).toBeGreaterThan(0);
  });
});
