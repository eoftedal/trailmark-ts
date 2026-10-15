/** Port of upstream tests/test_go_parser.py. */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `package main

import (
\t"fmt"
\t"strings"
)

// Point represents a 2D coordinate.
type Point struct {
\tX int
\tY int
}

// Mover defines something that can move.
type Mover interface {
\tMove(dx int, dy int)
}

// Translate shifts a point by dx and dy.
func (p *Point) Translate(dx int, dy int) {
\tp.X += dx
\tp.Y += dy
}

// Distance returns the Manhattan distance from origin.
func (p *Point) Distance() int {
\tresult := p.X + p.Y
\tif result < 0 {
\t\tresult = -result
\t}
\treturn result
}

func abs(x int) int {
\tif x < 0 {
\t\treturn -x
\t}
\treturn x
}

func process(items []int) int {
\ttotal := 0
\tfor _, item := range items {
\t\tif item > 0 {
\t\t\ttotal += item
\t\t}
\t}
\tswitch {
\tcase total > 100:
\t\tfmt.Println("big")
\tcase total > 10:
\t\tfmt.Println("medium")
\tdefault:
\t\tfmt.Println("small")
\t}
\treturn total
}

func greet(name string) string {
\t_ = abs(0)
\tmsg := fmt.Sprintf("Hello, %s", name)
\treturn strings.ToUpper(msg)
}
`;

function parseSample(): Promise<CodeGraph> {
  return parseSource("/tmp/sample.go", SAMPLE_CODE, "go");
}

function nodes(graph: CodeGraph): CodeUnit[] {
  return [...graph.nodes.values()];
}

function namesOfKind(graph: CodeGraph, kind: string): Set<string> {
  return new Set(
    nodes(graph)
      .filter((n) => n.kind === kind)
      .map((n) => n.name),
  );
}

function named(graph: CodeGraph, name: string): CodeUnit {
  const unit = nodes(graph).find((n) => n.name === name);
  if (unit === undefined) throw new Error(`no node named ${name}`);
  return unit;
}

describe("GoParser nodes", () => {
  it("finds module", async () => {
    expect(nodes(await parseSample()).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds struct", async () => {
    expect(namesOfKind(await parseSample(), "struct").has("Point")).toBe(true);
  });

  it("finds interface", async () => {
    expect(namesOfKind(await parseSample(), "interface").has("Mover")).toBe(true);
  });

  it("finds functions", async () => {
    const names = namesOfKind(await parseSample(), "function");
    for (const n of ["abs", "process", "greet"]) expect(names.has(n)).toBe(true);
  });

  it("finds methods", async () => {
    const names = namesOfKind(await parseSample(), "method");
    expect(names.has("Translate")).toBe(true);
    expect(names.has("Distance")).toBe(true);
  });

  it("method id includes receiver", async () => {
    const ids = nodes(await parseSample())
      .filter((n) => n.kind === "method")
      .map((n) => n.id);
    expect(ids.some((id) => id.includes("Point"))).toBe(true);
  });

  it("struct docstring", async () => {
    const point = named(await parseSample(), "Point");
    expect(point.docstring).not.toBeNull();
    expect(point.docstring!).toContain("2D");
  });
});

describe("GoParser parameters", () => {
  it("function params", async () => {
    const greet = named(await parseSample(), "greet");
    expect(greet.parameters).toHaveLength(1);
    expect(greet.parameters[0]!.name).toBe("name");
  });

  it("param type", async () => {
    const greet = named(await parseSample(), "greet");
    expect(greet.parameters[0]!.typeRef).not.toBeNull();
    expect(greet.parameters[0]!.typeRef!.name).toBe("string");
  });

  it("method params", async () => {
    const translate = named(await parseSample(), "Translate");
    expect(translate.parameters).toHaveLength(2);
    const names = new Set(translate.parameters.map((p) => p.name));
    expect(names.has("dx")).toBe(true);
    expect(names.has("dy")).toBe(true);
  });

  it("return type", async () => {
    const absFn = named(await parseSample(), "abs");
    expect(absFn.returnType).not.toBeNull();
    expect(absFn.returnType!.name).toBe("int");
  });
});

describe("GoParser complexity", () => {
  it("simple function complexity", async () => {
    expect(named(await parseSample(), "greet").cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const process = named(await parseSample(), "process");
    expect(process.cyclomaticComplexity).not.toBeNull();
    expect(process.cyclomaticComplexity!).toBeGreaterThanOrEqual(4);
  });

  it("branches tracked", async () => {
    expect(named(await parseSample(), "process").branches.length).toBeGreaterThan(0);
  });
});

describe("GoParser edges", () => {
  it("contains edges", async () => {
    expect((await parseSample()).edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("method contained by struct", async () => {
    const contains = (await parseSample()).edges.filter((e) => e.kind === "contains");
    expect(contains.filter((e) => e.sourceId.includes("Point")).length).toBeGreaterThan(0);
  });

  it("call edges", async () => {
    expect((await parseSample()).edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("call confidence certain", async () => {
    const calls = (await parseSample()).edges.filter((e) => e.kind === "calls");
    expect(calls.filter((e) => e.confidence === "certain").length).toBeGreaterThan(0);
  });

  it("call confidence inferred", async () => {
    const calls = (await parseSample()).edges.filter((e) => e.kind === "calls");
    expect(calls.filter((e) => e.confidence === "inferred").length).toBeGreaterThan(0);
  });
});

describe("GoParser dependencies", () => {
  it("imports tracked", async () => {
    const deps = (await parseSample()).dependencies;
    expect(deps).toContain("fmt");
    expect(deps).toContain("strings");
  });
});

describe("GoParser parse directory", () => {
  it("parses multiple files", async () => {
    const source = new MemoryFileSource("/proj", {
      "a.go": "package main\n\nfunc fromA() {}\n",
      "b.go": "package main\n\nfunc fromB() {}\n",
    });
    const graph = await parseDirectory(source, "go");
    expect(graph.language).toBe("go");
    expect(graph.rootPath).toBe("/proj");
    const names = new Set(nodes(graph).map((n) => n.name));
    expect(names.has("fromA")).toBe(true);
    expect(names.has("fromB")).toBe(true);
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/proj", { "skip.txt": "not source code" });
    const graph = await parseDirectory(source, "go");
    expect(graph.nodes.size).toBe(0);
  });
});
