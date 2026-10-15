/** Port of upstream tests/test_models.py. */
import { describe, expect, it } from "vitest";

import {
  branchInfo,
  codeEdge,
  CodeGraph,
  codeUnit,
  EDGE_KINDS,
  entrypointTag,
  parameter,
  sourceLocation,
  typeParameter,
  typeRef,
  type Annotation,
  type CodeUnit,
  type NodeKind,
  type SourceLocation,
} from "../src/models/index.js";

function makeLocation(filePath = "test.py", startLine = 1, endLine = 10): SourceLocation {
  return sourceLocation(filePath, startLine, endLine);
}

function makeUnit(nodeId = "mod:func", name = "func", kind: NodeKind = "function"): CodeUnit {
  return codeUnit({ id: nodeId, name, kind, location: makeLocation() });
}

describe("SourceLocation", () => {
  it("basic creation", () => {
    const loc = makeLocation("foo.py", 5, 10);
    expect(loc.filePath).toBe("foo.py");
    expect(loc.startLine).toBe(5);
    expect(loc.endLine).toBe(10);
    expect(loc.startCol).toBeNull();
  });

  it("with columns", () => {
    const loc = sourceLocation("f.py", 1, 1, 0, 10);
    expect(loc.startCol).toBe(0);
    expect(loc.endCol).toBe(10);
  });

  it("frozen (compile-time readonly in TS)", () => {
    const loc = makeLocation();
    const mutate = () => {
      // @ts-expect-error -- readonly field
      loc.filePath = "other.py";
    };
    expect(typeof mutate).toBe("function");
  });
});

describe("TypeRef", () => {
  it("simple type", () => {
    const t = typeRef("int");
    expect(t.name).toBe("int");
    expect(t.module).toBeNull();
    expect(t.genericArgs).toEqual([]);
  });

  it("generic type", () => {
    const t = typeRef("list", { genericArgs: [typeRef("int")] });
    expect(t.genericArgs).toHaveLength(1);
    expect(t.genericArgs[0]!.name).toBe("int");
  });
});

describe("TypeParameter", () => {
  it("defaults", () => {
    const p = typeParameter("T");
    expect(p.name).toBe("T");
    expect(p.constraints).toEqual([]);
    expect(p.default).toBeNull();
    expect(p.variance).toBeNull();
  });

  it("with constraint", () => {
    const p = typeParameter("T", { constraints: [typeRef("Sized")] });
    expect(p.constraints[0]!.name).toBe("Sized");
  });
});

describe("Parameter", () => {
  it("untyped", () => {
    const p = parameter("x");
    expect(p.name).toBe("x");
    expect(p.typeRef).toBeNull();
    expect(p.default).toBeNull();
  });

  it("typed with default", () => {
    const p = parameter("x", { typeRef: typeRef("int"), default: "42" });
    expect(p.typeRef!.name).toBe("int");
    expect(p.default).toBe("42");
  });
});

describe("CodeUnit", () => {
  it("function", () => {
    const unit = makeUnit();
    expect(unit.kind).toBe("function");
    expect(unit.origin).toBe("source");
    expect(unit.typeParameters).toEqual([]);
    expect(unit.attributes).toEqual([]);
    expect(unit.cyclomaticComplexity).toBeNull();
    expect(unit.branches).toEqual([]);
  });

  it("with complexity", () => {
    const unit = codeUnit({
      id: "mod:f",
      name: "f",
      kind: "function",
      location: makeLocation(),
      cyclomaticComplexity: 5,
      branches: [branchInfo(makeLocation(), "x > 0")],
    });
    expect(unit.cyclomaticComplexity).toBe(5);
    expect(unit.branches).toHaveLength(1);
  });

  it("proxy node", () => {
    const unit = codeUnit({
      id: "proxy.unresolved:mod:missing",
      name: "mod:missing",
      kind: "proxy",
      location: makeLocation(),
      origin: "proxy",
      attributes: [["raw_symbol", "mod:missing"]],
    });
    expect(unit.kind).toBe("proxy");
    expect(unit.origin).toBe("proxy");
    expect(unit.attributes[0]).toEqual(["raw_symbol", "mod:missing"]);
  });
});

describe("CodeEdge", () => {
  it("call edge", () => {
    expect(codeEdge({ sourceId: "mod:a", targetId: "mod:b", kind: "calls" }).confidence).toBe("certain");
  });

  it("uncertain edge", () => {
    const edge = codeEdge({ sourceId: "mod:a", targetId: "mod:b", kind: "calls", confidence: "uncertain" });
    expect(edge.confidence).toBe("uncertain");
  });

  it("new edge kinds and attributes", () => {
    const edge = codeEdge({
      sourceId: "src:f",
      targetId: "bin.app:f",
      kind: "corresponds_to",
      attributes: [["artifact", "app"]],
    });
    expect(edge.kind).toBe("corresponds_to");
    expect(edge.attributes).toEqual([["artifact", "app"]]);
  });
});

describe("EdgeKind values", () => {
  it("all graph model edge kinds", () => {
    for (const k of ["resolves_to", "type_uses", "specializes", "corresponds_to"]) {
      expect(EDGE_KINDS as readonly string[]).toContain(k);
    }
  });
});

describe("Annotations", () => {
  it("annotation", () => {
    const ann: Annotation = { kind: "assumption", description: "x is positive", source: "docstring" };
    expect(ann.kind).toBe("assumption");
  });

  it("entrypoint tag defaults", () => {
    const tag = entrypointTag("user_input");
    expect(tag.trustLevel).toBe("untrusted_external");
    expect(tag.assetValue).toBe("low");
  });
});

describe("CodeGraph", () => {
  it("empty graph", () => {
    const g = new CodeGraph();
    expect(g.nodes.size).toBe(0);
    expect(g.edges).toHaveLength(0);
  });

  it("add annotation", () => {
    const g = new CodeGraph();
    g.nodes.set("a", makeUnit("a", "a"));
    const ann: Annotation = { kind: "assumption", description: "x > 0", source: "test" };
    g.addAnnotation("a", ann);
    expect(g.annotations.get("a")).toHaveLength(1);
    expect(g.annotations.get("a")![0]).toEqual(ann);
  });

  it("add annotation creates list", () => {
    const g = new CodeGraph();
    const ann: Annotation = { kind: "precondition", description: "not null", source: "test" };
    g.addAnnotation("x", ann);
    expect(g.annotations.has("x")).toBe(true);
    expect(g.annotations.get("x")).toEqual([ann]);
  });

  it("add annotation appends", () => {
    const g = new CodeGraph();
    g.addAnnotation("n", { kind: "assumption", description: "first", source: "test" });
    g.addAnnotation("n", { kind: "invariant", description: "second", source: "test" });
    expect(g.annotations.get("n")).toHaveLength(2);
  });

  it("clear annotations all", () => {
    const g = new CodeGraph();
    g.addAnnotation("a", { kind: "assumption", description: "test", source: "test" });
    g.clearAnnotations("a");
    expect(g.annotations.has("a")).toBe(false);
  });

  it("clear annotations by kind", () => {
    const g = new CodeGraph();
    g.addAnnotation("a", { kind: "assumption", description: "assume", source: "test" });
    g.addAnnotation("a", { kind: "invariant", description: "invariant", source: "test" });
    g.clearAnnotations("a", "assumption");
    expect(g.annotations.get("a")).toHaveLength(1);
    expect(g.annotations.get("a")![0]!.kind).toBe("invariant");
  });

  it("clear annotations nonexistent node", () => {
    expect(() => new CodeGraph().clearAnnotations("nonexistent")).not.toThrow();
  });

  it("clear annotations removes empty list", () => {
    const g = new CodeGraph();
    g.addAnnotation("a", { kind: "assumption", description: "test", source: "test" });
    g.clearAnnotations("a", "assumption");
    expect(g.annotations.has("a")).toBe(false);
  });

  it("merge", () => {
    const g1 = new CodeGraph();
    g1.nodes.set("a", makeUnit("a", "a"));
    g1.dependencies = ["foo"];
    const g2 = new CodeGraph();
    g2.nodes.set("b", makeUnit("b", "b"));
    g2.dependencies = ["foo", "bar"];
    g1.merge(g2);
    expect(g1.nodes.size).toBe(2);
    expect(g1.dependencies).toContain("bar");
    expect(g1.dependencies.filter((d) => d === "foo")).toHaveLength(1);
  });
});
