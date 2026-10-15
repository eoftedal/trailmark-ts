/** Port of upstream tests/test_diagram_script.py and tests/test_kat_diagram.py. */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ArgParseExit } from "../src/argparse.js";
import * as diagram from "../src/diagram.js";
import { entrypointTag } from "../src/models/annotations.js";
import { codeEdge, type EdgeKind } from "../src/models/edges.js";
import { CodeGraph } from "../src/models/graph.js";
import { codeUnit, sourceLocation, type CodeUnit, type NodeKind } from "../src/models/nodes.js";
import { parseSource } from "../src/parse.js";
import { QueryEngine } from "../src/query/api.js";
import { FIXTURE_ROOT } from "./kat-runner.js";

const LOC = sourceLocation("test.py", 1, 10);

function makeNode(id: string, name: string, kind: NodeKind = "function", complexity: number | null = null): CodeUnit {
  return codeUnit({ id, name, kind, location: LOC, cyclomaticComplexity: complexity });
}

function engineOf(nodes: CodeUnit[], edges: [string, string, EdgeKind][], configure?: (g: CodeGraph) => void) {
  const graph = new CodeGraph();
  for (const n of nodes) graph.nodes.set(n.id, n);
  for (const [sourceId, targetId, kind] of edges) graph.edges.push(codeEdge({ sourceId, targetId, kind }));
  configure?.(graph);
  return QueryEngine.fromGraph(graph);
}

/** Engine with call chain: entry -> handler -> db_query. */
const buildCallGraphEngine = () =>
  engineOf(
    [
      makeNode("mod:entry", "entry", "function", 2),
      makeNode("mod:handler", "handler", "function", 12),
      makeNode("mod:db_query", "db_query", "function", 3),
    ],
    [
      ["mod:entry", "mod:handler", "calls"],
      ["mod:handler", "mod:db_query", "calls"],
    ],
    (g) => g.entrypoints.set("mod:entry", entrypointTag("user_input", { trustLevel: "untrusted_external" })),
  );

/** Engine with inheritance: Child inherits Parent, Impl implements Iface. */
const buildClassHierarchyEngine = () =>
  engineOf(
    [
      makeNode("mod:Parent", "Parent", "class"),
      makeNode("mod:Child", "Child", "class"),
      makeNode("mod:Iface", "Iface", "interface"),
      makeNode("mod:Impl", "Impl", "class"),
    ],
    [
      ["mod:Child", "mod:Parent", "inherits"],
      ["mod:Impl", "mod:Iface", "implements"],
    ],
  );

/** Engine with a class containing methods. */
const buildContainmentEngine = () =>
  engineOf(
    [
      makeNode("mod:MyClass", "MyClass", "class"),
      makeNode("mod:MyClass.do_thing", "do_thing", "method"),
      makeNode("mod:MyClass.other", "other", "method"),
    ],
    [
      ["mod:MyClass", "mod:MyClass.do_thing", "contains"],
      ["mod:MyClass", "mod:MyClass.other", "contains"],
    ],
  );

/** Engine with import edges between modules. */
const buildModuleDepsEngine = () =>
  engineOf(
    [makeNode("mod_a", "mod_a", "module"), makeNode("mod_b", "mod_b", "module"), makeNode("mod_c", "mod_c", "module")],
    [
      ["mod_a", "mod_b", "imports"],
      ["mod_b", "mod_c", "imports"],
    ],
  );

// ── Utility function tests ───────────────────────────────────────

describe("sanitizeId", () => {
  it("dots and colons", () => expect(diagram.sanitizeId("mod:Class.method")).toBe("mod_Class_method"));
  it("leading digit", () => expect(diagram.sanitizeId("3rdparty:init")).toBe("n_3rdparty_init"));
  it("already safe", () => expect(diagram.sanitizeId("simple_name")).toBe("simple_name"));
  it("empty string", () => expect(diagram.sanitizeId("")).toBe("n_empty"));
  it("slashes and hyphens", () => expect(diagram.sanitizeId("a/b-c")).toBe("a_b_c"));
});

describe("nodeLabel", () => {
  it("basic", () => expect(diagram.nodeLabel({ name: "foo", kind: "function" })).toBe("foo, function"));
  it("with complexity", () =>
    expect(diagram.nodeLabel({ name: "bar", kind: "method", cyclomatic_complexity: 15 })).toBe("bar, method, CC=15"));
  it("no complexity", () => expect(diagram.nodeLabel({ name: "baz", kind: "function" })).toBe("baz, function"));
  it("fallback to id", () => expect(diagram.nodeLabel({ id: "mod:thing" })).toBe("mod:thing"));
  it("no name no id", () => expect(diagram.nodeLabel({})).toBe("?"));
  it("no kind omits kind", () => expect(diagram.nodeLabel({ name: "solo" })).toBe("solo"));
  it("name only with cc", () => expect(diagram.nodeLabel({ name: "x", cyclomatic_complexity: 3 })).toBe("x, CC=3"));
});

describe("edgeStyle", () => {
  it("certain", () => expect(diagram.edgeStyle("certain")).toBe("-->"));
  it("inferred", () => expect(diagram.edgeStyle("inferred")).toBe("-.->"));
  it("uncertain", () => expect(diagram.edgeStyle("uncertain")).toBe("-..->"));
});

describe("complexityClass", () => {
  it("none", () => expect(diagram.complexityClass(null)).toBe("low"));
  it("low", () => expect(diagram.complexityClass(3)).toBe("low"));
  it("medium", () => expect(diagram.complexityClass(7)).toBe("medium"));
  it("high", () => expect(diagram.complexityClass(15)).toBe("high"));
  it("boundary 5", () => expect(diagram.complexityClass(5)).toBe("medium"));
  it("boundary 10", () => expect(diagram.complexityClass(10)).toBe("medium"));
  it("boundary 11", () => expect(diagram.complexityClass(11)).toBe("high"));
});

// ── Emitter tests ────────────────────────────────────────────────

describe("emitCallGraph", () => {
  it("with focus", () => {
    const result = diagram.emitCallGraph(buildCallGraphEngine(), "handler", 2, "TB");
    expect(result.startsWith("flowchart TB")).toBe(true);
    expect(result).toContain("mod_handler");
    expect(result).toContain("-->");
  });
  it("without focus", () => {
    const result = diagram.emitCallGraph(buildCallGraphEngine(), null, 2, "TB");
    expect(result.startsWith("flowchart TB")).toBe(true);
    expect(result).toContain("mod_entry");
    expect(result).toContain("mod_db_query");
  });
  it("direction LR", () => {
    expect(diagram.emitCallGraph(buildCallGraphEngine(), null, 2, "LR").startsWith("flowchart LR")).toBe(true);
  });
  it("unknown focus throws DiagramError", () => {
    expect(() => diagram.emitCallGraph(buildCallGraphEngine(), "nope", 2, "TB")).toThrow(
      "Error: node 'nope' not found.\nAvailable: entry, handler, db_query",
    );
  });
});

describe("emitClassHierarchy", () => {
  it("inherits and implements", () => {
    const result = diagram.emitClassHierarchy(buildClassHierarchyEngine(), "TB");
    expect(result).toContain("classDiagram");
    expect(result).toContain("<|--");
    expect(result).toContain("<|..");
  });
  it("no classes", () => {
    expect(diagram.emitClassHierarchy(buildCallGraphEngine(), "TB")).toContain("No classes found");
  });
});

describe("emitModuleDeps", () => {
  it("imports", () => {
    const result = diagram.emitModuleDeps(buildModuleDepsEngine(), "LR");
    expect(result.startsWith("flowchart LR")).toBe(true);
    expect(result).toContain("mod_a");
    expect(result).toContain("mod_b");
  });
  it("no imports", () => {
    expect(diagram.emitModuleDeps(buildCallGraphEngine(), "TB")).toContain("No import edges found");
  });
});

describe("emitContainment", () => {
  it("class members", () => {
    const result = diagram.emitContainment(buildContainmentEngine(), "TB");
    expect(result).toContain("classDiagram");
    expect(result).toContain("do_thing");
    expect(result).toContain("other");
  });
  it("no containment", () => {
    expect(diagram.emitContainment(buildModuleDepsEngine(), "TB")).toContain("No containment found");
  });
});

describe("emitComplexity", () => {
  it("above threshold", () => {
    const result = diagram.emitComplexity(buildCallGraphEngine(), 10, "TB");
    expect(result.startsWith("flowchart TB")).toBe(true);
    expect(result).toContain("handler");
    expect(result).toContain(":::high");
    expect(result).toContain("classDef high");
  });
  it("below threshold", () => {
    expect(diagram.emitComplexity(buildCallGraphEngine(), 20, "TB")).toContain("No nodes with CC >= 20");
  });
});

describe("emitDataFlow", () => {
  it("with focus", () => {
    const result = diagram.emitDataFlow(buildCallGraphEngine(), "db_query", 5, "TB");
    expect(result.startsWith("flowchart TB")).toBe(true);
    expect(result).toContain("entrypoint");
  });
  it("without focus", () => {
    expect(diagram.emitDataFlow(buildCallGraphEngine(), null, 5, "TB").startsWith("flowchart TB")).toBe(true);
  });
  it("no entrypoints", () => {
    expect(diagram.emitDataFlow(buildClassHierarchyEngine(), null, 5, "TB")).toContain("No entrypoints found");
  });
});

// ── CLI argument parsing ─────────────────────────────────────────

describe("parseArgs", () => {
  it("required args", () => {
    const args = diagram.parseArgs(["--target", "/some/dir", "--type", "call-graph"]);
    expect(args["target"]).toBe("/some/dir");
    expect(args["diagram_type"]).toBe("call-graph");
    expect(args["language"]).toBe("python");
    expect(args["direction"]).toBe("TB");
    expect(args["depth"]).toBe(2);
  });

  it("all options", () => {
    const args = diagram.parseArgs([
      "--target",
      "/src",
      "--language",
      "rust",
      "--type",
      "complexity",
      "--focus",
      "parse",
      "--depth",
      "3",
      "--direction",
      "LR",
      "--threshold",
      "5",
    ]);
    expect(args["language"]).toBe("rust");
    expect(args["diagram_type"]).toBe("complexity");
    expect(args["focus"]).toBe("parse");
    expect(args["depth"]).toBe(3);
    expect(args["direction"]).toBe("LR");
    expect(args["threshold"]).toBe(5);
  });

  it("invalid type rejected", () => {
    expect(() => diagram.parseArgs(["--target", "/some/dir", "--type", "invalid"])).toThrow(ArgParseExit);
  });
});

// ── Large graph warning ──────────────────────────────────────────

describe("warnIfLarge", () => {
  it("no warning for small", () => {
    const warnings: string[] = [];
    diagram.warnIfLarge({ a: 1, b: 2 }, (l) => warnings.push(l));
    expect(warnings).toEqual([]);
  });
  it("warning for large", () => {
    const warnings: string[] = [];
    const big = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [String(i), i]));
    diagram.warnIfLarge(big, (l) => warnings.push(l));
    expect(warnings.join("\n")).toContain("150 nodes exceeds 100");
  });
});

// ── KAT snapshots (tests/test_kat_diagram.py) ────────────────────

describe("diagram KAT snapshots", () => {
  const fixture = join(FIXTURE_ROOT, "python", "taxonomy.py");
  const snapshotDir = join(FIXTURE_ROOT, "diagram");

  async function engine(): Promise<QueryEngine> {
    return QueryEngine.fromGraph(await parseSource(fixture, readFileSync(fixture, "utf8"), "python"));
  }

  function check(name: string, actual: string): void {
    let norm = actual.replaceAll(fixture, "taxonomy.py");
    if (!norm.endsWith("\n")) norm += "\n";
    expect(norm).toBe(readFileSync(join(snapshotDir, `${name}.expected.mmd`), "utf8"));
  }

  for (const direction of ["LR", "TD"]) {
    it(`call graph ${direction}`, async () => {
      check(`call_graph_${direction}`, diagram.emitCallGraph(await engine(), null, 2, direction));
    });
  }
  it("call graph focused", async () => {
    check("call_graph_focus_bark", diagram.emitCallGraph(await engine(), "bark", 1, "LR"));
  });
  it("class hierarchy", async () => {
    check("class_hierarchy", diagram.emitClassHierarchy(await engine(), "TB"));
  });
  it("module deps", async () => {
    check("module_deps", diagram.emitModuleDeps(await engine(), "LR"));
  });
  it("containment", async () => {
    check("containment", diagram.emitContainment(await engine(), "LR"));
  });
  it("complexity", async () => {
    check("complexity_t2", diagram.emitComplexity(await engine(), 2, "LR"));
  });
  it("data flow", async () => {
    check("data_flow_branchy", diagram.emitDataFlow(await engine(), "branchy", 2, "LR"));
  });
});

// Not in upstream: upstream emits labels unescaped, so a `"` in a node name
// (e.g. an unresolved call `rs.getString("id")`) produces Mermaid that fails to parse.
describe("quotes in labels (divergence from upstream)", () => {
  it("escapes double quotes as #quot; in quoted flowchart labels", () => {
    expect(diagram.mermaidLabel({ name: 'rs.getString("id").trim', kind: "proxy" })).toBe(
      "rs.getString(#quot;id#quot;).trim, proxy",
    );
    expect(diagram.nodeLabel({ name: 'f("x")', kind: "proxy" })).toBe('f("x"), proxy');
  });

  it.each([
    [
      "Repo.java",
      "java",
      'class Repo { User map(ResultSet rs) { return new User(UserId.of(rs.getString("id")).value()); } }',
      "Repo.map",
    ],
    ["repo.go", "go", 'package repo\nfunc Map(rs Rows) User { return NewUser(ParseID(rs.Get("id")).String()) }', "Map"],
    ["repo.py", "python", 'def load(rs):\n    return User(parse_id(rs.get("id")).hex())\n', "load"],
  ])("never puts a raw quote inside a quoted label (%s)", async (file, lang, code, focus) => {
    const engine = QueryEngine.fromGraph(await parseSource(file, code, lang));
    const warn = () => {};
    const outputs = [
      diagram.renderDiagram(
        engine,
        { diagramType: "call-graph", focus, depth: 3, direction: "TB", threshold: 10 },
        warn,
      ),
      diagram.renderDiagram(
        engine,
        { diagramType: "call-graph", focus: null, depth: 3, direction: "TB", threshold: 10 },
        warn,
      ),
      diagram.renderDiagram(
        engine,
        { diagramType: "complexity", focus: null, depth: 3, direction: "TB", threshold: 1 },
        warn,
      ),
    ];
    for (const out of outputs) {
      for (const label of out.matchAll(/\["(.*)"\]/g)) expect(label[1]).not.toContain('"');
    }
    expect(outputs[0]).toContain("#quot;id#quot;");
  });
});
