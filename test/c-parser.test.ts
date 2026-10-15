/** Tests for the C language parser (port of upstream tests/test_c_parser.py). */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `\
#include <stdio.h>
#include "myheader.h"

typedef struct {
    int x;
    int y;
} Point;

struct Color {
    int r;
    int g;
    int b;
};

enum Direction {
    NORTH,
    SOUTH,
    EAST,
    WEST
};

/** Compute the distance between two points. */
int distance(int x1, int y1, int x2, int y2) {
    int dx = x2 - x1;
    int dy = y2 - y1;
    if (dx < 0) {
        dx = -dx;
    }
    if (dy < 0) {
        dy = -dy;
    }
    return dx + dy;
}

int process(int *items, int count) {
    int total = 0;
    for (int i = 0; i < count; i++) {
        if (items[i] > 0) {
            total += items[i];
        } else {
            total -= items[i];
        }
    }
    while (total > 100) {
        total = total / 2;
    }
    return total;
}

void run(void) {
    int d = distance(0, 0, 3, 4);
    int result = process(&d, 1);
    printf("result: %d\\n", result);
}
`;

const parseSample = (): Promise<CodeGraph> => parseSource("/tmp/sample.c", SAMPLE_CODE, "c");

const nodes = (g: CodeGraph): CodeUnit[] => [...g.nodes.values()];
const namesOfKind = (g: CodeGraph, kind: string): Set<string> =>
  new Set(
    nodes(g)
      .filter((n) => n.kind === kind)
      .map((n) => n.name),
  );
const byName = (g: CodeGraph, name: string): CodeUnit => nodes(g).find((n) => n.name === name)!;

describe("CParser nodes", () => {
  it("finds module", async () => {
    const g = await parseSample();
    expect(nodes(g).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds functions", async () => {
    const names = namesOfKind(await parseSample(), "function");
    expect(names).toContain("distance");
    expect(names).toContain("process");
    expect(names).toContain("run");
  });

  it("finds struct", async () => {
    expect(namesOfKind(await parseSample(), "struct")).toContain("Color");
  });

  it("finds enum", async () => {
    expect(namesOfKind(await parseSample(), "enum")).toContain("Direction");
  });

  it("function docstring", async () => {
    const dist = byName(await parseSample(), "distance");
    expect(dist.docstring).not.toBeNull();
    expect(dist.docstring!.toLowerCase()).toContain("distance");
  });
});

describe("CParser parameters", () => {
  it("function parameters", async () => {
    const dist = byName(await parseSample(), "distance");
    expect(dist.parameters).toHaveLength(4);
    const names = new Set(dist.parameters.map((p) => p.name));
    for (const n of ["x1", "y1", "x2", "y2"]) expect(names).toContain(n);
  });

  it("parameter types", async () => {
    const dist = byName(await parseSample(), "distance");
    for (const p of dist.parameters) {
      expect(p.typeRef).not.toBeNull();
      expect(p.typeRef!.name).toBe("int");
    }
  });

  it("return type", async () => {
    const dist = byName(await parseSample(), "distance");
    expect(dist.returnType?.name).toBe("int");
  });
});

describe("CParser complexity", () => {
  it("simple function complexity", async () => {
    expect(byName(await parseSample(), "run").cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const proc = byName(await parseSample(), "process");
    expect(proc.cyclomaticComplexity).not.toBeNull();
    expect(proc.cyclomaticComplexity!).toBeGreaterThanOrEqual(4);
  });

  it("branches tracked", async () => {
    expect(byName(await parseSample(), "process").branches.length).toBeGreaterThan(0);
  });
});

describe("CParser edges", () => {
  it("contains edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("call edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("call edge targets", async () => {
    const g = await parseSample();
    const targets = g.edges.filter((e) => e.kind === "calls").map((e) => e.targetId);
    expect(targets.some((t) => t.includes("distance"))).toBe(true);
    expect(targets.some((t) => t.includes("process"))).toBe(true);
  });

  it("edge confidence", async () => {
    const g = await parseSample();
    const certain = g.edges.filter((e) => e.kind === "calls" && e.confidence === "certain");
    expect(certain.length).toBeGreaterThan(0);
  });
});

describe("CParser dependencies", () => {
  it("includes tracked", async () => {
    const g = await parseSample();
    expect(g.dependencies).toContain("stdio.h");
    expect(g.dependencies).toContain("myheader.h");
  });
});

const PREPROC_GUARDED_CODE = `\
void before_guard(void) {}

#ifdef USE_FEATURE
void feature_a(int x) {
    x = x + 1;
}
#else
void feature_b(int x) {
    x = x - 1;
}
#endif

void after_guard(void) {}
`;

const PREPROC_SPLIT_SIGNATURE_CODE = `\
void before_split(void) {}

#if defined(_WIN32)
unsigned int __stdcall thread_worker(void * arg)
#else
void * thread_worker(void * arg)
#endif
{
    return 0;
}

void after_split(void) {
    thread_worker(0);
}
`;

describe("CParser preprocessor recovery", () => {
  it("finds functions inside ifdef branches", async () => {
    const names = namesOfKind(await parseSource("/tmp/guarded.c", PREPROC_GUARDED_CODE, "c"), "function");
    expect(names).toContain("before_guard");
    expect(names).toContain("after_guard");
    expect(names.has("feature_a") || names.has("feature_b")).toBe(true);
  });

  it("finds functions after split signature", async () => {
    const names = namesOfKind(await parseSource("/tmp/split.c", PREPROC_SPLIT_SIGNATURE_CODE, "c"), "function");
    expect(names).toContain("before_split");
    expect(names).toContain("after_split");
  });
});

describe("C parseDirectory", () => {
  it("parses multiple files", async () => {
    const source = new MemoryFileSource("/proj", { "a.c": "void fromA(void) {}\n", "b.c": "void fromB(void) {}\n" });
    const g = await parseDirectory(source, "c");
    expect(g.language).toBe("c");
    expect(g.rootPath).toBe("/proj");
    const names = new Set(nodes(g).map((n) => n.name));
    expect(names).toContain("fromA");
    expect(names).toContain("fromB");
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/proj", { "skip.txt": "not source code" });
    const g = await parseDirectory(source, "c");
    expect(g.nodes.size).toBe(0);
  });
});
