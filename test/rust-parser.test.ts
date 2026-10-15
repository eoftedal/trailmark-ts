/** Port of upstream tests/test_rust_parser.py. */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `use std::collections::HashMap;
use std::fmt;

/// A 2D point in space.
struct Point {
    x: f64,
    y: f64,
}

/// Something that can describe itself.
trait Describable {
    fn describe(&self) -> String;
}

enum Color {
    Red,
    Green,
    Blue,
}

impl Describable for Point {
    fn describe(&self) -> String {
        format!("({}, {})", self.x, self.y)
    }
}

impl Point {
    fn new(x: f64, y: f64) -> Point {
        Point { x, y }
    }

    fn distance(&self, other: &Point) -> f64 {
        let dx = self.x - other.x;
        let dy = self.y - other.y;
        (dx * dx + dy * dy).sqrt()
    }

    fn translate(&mut self, dx: f64, dy: f64) {
        self.x += dx;
        self.y += dy;
    }
}

fn abs(x: f64) -> f64 {
    if x < 0.0 {
        -x
    } else {
        x
    }
}

fn process(items: Vec<i32>) -> i32 {
    let mut total = 0;
    for item in items.iter() {
        if *item > 0 {
            total += item;
        }
    }
    match total {
        0 => println!("zero"),
        1..=10 => println!("small"),
        _ => println!("big"),
    }
    total
}

fn greet(name: &str) -> String {
    let msg = format!("Hello, {}", name);
    msg.to_uppercase()
}
`;

const parseSample = (): Promise<CodeGraph> => parseSource("/tmp/sample.rs", SAMPLE_CODE, "rust");

const nodes = (g: CodeGraph): CodeUnit[] => [...g.nodes.values()];
const namesOfKind = (g: CodeGraph, kind: string): Set<string> =>
  new Set(
    nodes(g)
      .filter((n) => n.kind === kind)
      .map((n) => n.name),
  );
const byName = (g: CodeGraph, name: string): CodeUnit => {
  const n = nodes(g).find((u) => u.name === name);
  if (n === undefined) throw new Error(`no node named ${name}`);
  return n;
};

describe("RustParser nodes", () => {
  it("finds module", async () => {
    expect(nodes(await parseSample()).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds struct", async () => {
    expect(namesOfKind(await parseSample(), "struct").has("Point")).toBe(true);
  });

  it("finds trait", async () => {
    expect(namesOfKind(await parseSample(), "trait").has("Describable")).toBe(true);
  });

  it("finds enum", async () => {
    expect(namesOfKind(await parseSample(), "enum").has("Color")).toBe(true);
  });

  it("finds functions", async () => {
    const names = namesOfKind(await parseSample(), "function");
    for (const n of ["abs", "process", "greet"]) expect(names.has(n)).toBe(true);
  });

  it("finds methods", async () => {
    const names = namesOfKind(await parseSample(), "method");
    for (const n of ["new", "distance", "translate", "describe"]) expect(names.has(n)).toBe(true);
  });

  it("method id includes type", async () => {
    const ids = nodes(await parseSample())
      .filter((n) => n.kind === "method")
      .map((n) => n.id);
    expect(ids.some((id) => id.includes("Point"))).toBe(true);
  });

  it("struct docstring", async () => {
    const point = byName(await parseSample(), "Point");
    expect(point.docstring).not.toBeNull();
    expect(point.docstring).toContain("2D");
  });
});

describe("RustParser parameters", () => {
  it("function params", async () => {
    const greet = byName(await parseSample(), "greet");
    expect(greet.parameters).toHaveLength(1);
    expect(greet.parameters[0]!.name).toBe("name");
  });

  it("param type", async () => {
    const greet = byName(await parseSample(), "greet");
    expect(greet.parameters[0]!.typeRef?.name).toBe("&str");
  });

  it("method params skip self", async () => {
    const distance = byName(await parseSample(), "distance");
    expect(distance.parameters).toHaveLength(1);
    expect(distance.parameters[0]!.name).toBe("other");
  });

  it("multiple params", async () => {
    const newFn = byName(await parseSample(), "new");
    expect(newFn.parameters).toHaveLength(2);
    const names = new Set(newFn.parameters.map((p) => p.name));
    expect(names.has("x")).toBe(true);
    expect(names.has("y")).toBe(true);
  });

  it("return type", async () => {
    expect(byName(await parseSample(), "abs").returnType?.name).toBe("f64");
  });
});

describe("RustParser complexity", () => {
  it("simple function complexity", async () => {
    expect(byName(await parseSample(), "greet").cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const process = byName(await parseSample(), "process");
    expect(process.cyclomaticComplexity).not.toBeNull();
    expect(process.cyclomaticComplexity!).toBeGreaterThanOrEqual(3);
  });

  it("branches tracked", async () => {
    expect(byName(await parseSample(), "process").branches.length).toBeGreaterThan(0);
  });

  it("if/else complexity", async () => {
    const absFn = byName(await parseSample(), "abs");
    expect(absFn.cyclomaticComplexity).not.toBeNull();
    expect(absFn.cyclomaticComplexity!).toBeGreaterThanOrEqual(2);
  });
});

describe("RustParser edges", () => {
  it("contains edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("implements edge", async () => {
    const g = await parseSample();
    const implementsEdges = g.edges.filter((e) => e.kind === "implements");
    expect(implementsEdges).toHaveLength(1);
    expect(implementsEdges[0]!.sourceId).toContain("Point");
    expect(implementsEdges[0]!.targetId).toContain("Describable");
  });

  it("call edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("call confidence", async () => {
    const g = await parseSample();
    const calls = g.edges.filter((e) => e.kind === "calls");
    const certain = calls.filter((e) => e.confidence === "certain");
    const inferred = calls.filter((e) => e.confidence === "inferred");
    expect(certain.length > 0 || inferred.length > 0).toBe(true);
  });

  it("method contained by type", async () => {
    const g = await parseSample();
    const pointContains = g.edges.filter((e) => e.kind === "contains" && e.sourceId.includes("Point"));
    expect(pointContains.length).toBeGreaterThan(0);
  });
});

describe("RustParser dependencies", () => {
  it("imports tracked", async () => {
    expect((await parseSample()).dependencies).toContain("std");
  });
});

describe("Rust parseDirectory", () => {
  it("parses multiple files", async () => {
    const root = "/tmp/rustdir";
    const source = new MemoryFileSource(root, {
      "a.rs": "fn from_a() {}\n",
      "b.rs": "fn from_b() {}\n",
    });
    const graph = await parseDirectory(source, "rust");
    expect(graph.language).toBe("rust");
    expect(graph.rootPath).toBe(root);
    const names = new Set(nodes(graph).map((n) => n.name));
    expect(names.has("from_a")).toBe(true);
    expect(names.has("from_b")).toBe(true);
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/tmp/rustdir2", { "skip.txt": "not source code" });
    const graph = await parseDirectory(source, "rust");
    expect(graph.nodes.size).toBe(0);
  });
});
