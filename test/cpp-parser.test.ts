/** Tests for the C++ language parser (port of upstream tests/test_cpp_parser.py). */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `\
#include <iostream>
#include "utils.hpp"

namespace geometry {

struct Point {
    double x;
    double y;
};

enum Shape {
    CIRCLE,
    SQUARE,
    TRIANGLE
};

/** Base class for all animals. */
class Animal {
public:
    virtual void speak() {
        return;
    }

    int age() {
        return 0;
    }
};

class Dog : public Animal {
public:
    void speak() {
        return;
    }

    bool fetch(int item) {
        if (item <= 0) {
            throw std::invalid_argument("bad item");
        }
        return true;
    }
};

}

int compute(int a, int b) {
    int result = a + b;
    if (result > 100) {
        result = 100;
    }
    for (int i = 0; i < b; i++) {
        if (a > i) {
            result += i;
        }
    }
    while (result < 0) {
        result += 10;
    }
    return result;
}

void run_all(void) {
    int val = compute(10, 20);
    std::cout << val << std::endl;
}
`;

const EXTRA_CPP_CODE = `\
template<typename T>
T identity(T x) {
    return x;
}

template<typename T>
class Box {
public:
    T value;
    T get() { return value; }
};

typedef struct TypedefPoint {
    int x;
    int y;
} TypedefPoint;

typedef enum TypedefColor {
    RED,
    GREEN,
    BLUE
} TypedefColor;

class WithInline {
public:
    static void staticHelper() { return; }
};
`;

const parseSample = (): Promise<CodeGraph> => parseSource("/tmp/sample.cpp", SAMPLE_CODE, "cpp");
const parseExtra = (): Promise<CodeGraph> => parseSource("/tmp/extra.cpp", EXTRA_CPP_CODE, "cpp");

const nodes = (g: CodeGraph): CodeUnit[] => [...g.nodes.values()];
const names = (g: CodeGraph): Set<string> => new Set(nodes(g).map((n) => n.name));
const namesOfKind = (g: CodeGraph, kind: string): Set<string> =>
  new Set(
    nodes(g)
      .filter((n) => n.kind === kind)
      .map((n) => n.name),
  );
const byName = (g: CodeGraph, name: string): CodeUnit => nodes(g).find((n) => n.name === name)!;

describe("CppParser nodes", () => {
  it("finds module", async () => {
    expect(nodes(await parseSample()).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds namespace", async () => {
    expect(namesOfKind(await parseSample(), "namespace")).toContain("geometry");
  });

  it("finds classes", async () => {
    const n = namesOfKind(await parseSample(), "class");
    expect(n).toContain("Animal");
    expect(n).toContain("Dog");
  });

  it("finds struct", async () => {
    expect(namesOfKind(await parseSample(), "struct")).toContain("Point");
  });

  it("finds enum", async () => {
    expect(namesOfKind(await parseSample(), "enum")).toContain("Shape");
  });

  it("finds functions", async () => {
    const n = namesOfKind(await parseSample(), "function");
    expect(n).toContain("compute");
    expect(n).toContain("run_all");
  });

  it("finds methods", async () => {
    const n = namesOfKind(await parseSample(), "method");
    expect(n).toContain("speak");
    expect(n).toContain("fetch");
  });

  it("class docstring", async () => {
    const animal = byName(await parseSample(), "Animal");
    expect(animal.docstring).not.toBeNull();
    expect(animal.docstring!.toLowerCase()).toContain("animal");
  });
});

describe("CppParser parameters", () => {
  it("function parameters", async () => {
    const comp = byName(await parseSample(), "compute");
    expect(comp.parameters).toHaveLength(2);
    const n = new Set(comp.parameters.map((p) => p.name));
    expect(n).toContain("a");
    expect(n).toContain("b");
  });

  it("parameter types", async () => {
    const comp = byName(await parseSample(), "compute");
    for (const p of comp.parameters) {
      expect(p.typeRef).not.toBeNull();
      expect(p.typeRef!.name).toBe("int");
    }
  });

  it("return type", async () => {
    expect(byName(await parseSample(), "compute").returnType?.name).toBe("int");
  });

  it("method parameters", async () => {
    const fetch = byName(await parseSample(), "fetch");
    expect(fetch.parameters).toHaveLength(1);
    expect(fetch.parameters[0]!.name).toBe("item");
  });
});

describe("CppParser complexity", () => {
  it("simple function complexity", async () => {
    expect(byName(await parseSample(), "run_all").cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const comp = byName(await parseSample(), "compute");
    expect(comp.cyclomaticComplexity).not.toBeNull();
    expect(comp.cyclomaticComplexity!).toBeGreaterThanOrEqual(4);
  });

  it("branches tracked", async () => {
    expect(byName(await parseSample(), "compute").branches.length).toBeGreaterThan(0);
  });
});

describe("CppParser edges", () => {
  it("contains edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("inherits edge", async () => {
    const g = await parseSample();
    const inherits = g.edges.filter((e) => e.kind === "inherits");
    expect(inherits.length).toBeGreaterThanOrEqual(1);
    expect(inherits.some((e) => e.targetId.includes("Animal"))).toBe(true);
  });

  it("call edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("exception type from throw", async () => {
    expect(byName(await parseSample(), "fetch").exceptionTypes.length).toBeGreaterThanOrEqual(1);
  });

  it("edge confidence", async () => {
    const g = await parseSample();
    const calls = g.edges.filter((e) => e.kind === "calls");
    const certain = calls.filter((e) => e.confidence === "certain");
    const inferred = calls.filter((e) => e.confidence === "inferred");
    expect(certain.length > 0 || inferred.length > 0).toBe(true);
  });
});

describe("CppParser dependencies", () => {
  it("includes tracked", async () => {
    const g = await parseSample();
    expect(g.dependencies).toContain("iostream");
    expect(g.dependencies).toContain("utils.hpp");
  });
});

describe("CppParser extra features", () => {
  it("template function extracted", async () => {
    expect(names(await parseExtra())).toContain("identity");
  });

  it("template class extracted", async () => {
    expect(names(await parseExtra())).toContain("Box");
  });

  it("template class method", async () => {
    expect(names(await parseExtra())).toContain("get");
  });

  it("typedef struct extracted", async () => {
    expect(namesOfKind(await parseExtra(), "struct")).toContain("TypedefPoint");
  });

  it("typedef enum extracted", async () => {
    expect(namesOfKind(await parseExtra(), "enum")).toContain("TypedefColor");
  });

  it("inline declaration method", async () => {
    expect(names(await parseExtra())).toContain("WithInline");
  });
});

describe("Cpp parseDirectory", () => {
  it("parses multiple files", async () => {
    const source = new MemoryFileSource("/proj", { "a.cpp": "void fromA() {}\n", "b.cpp": "void fromB() {}\n" });
    const g = await parseDirectory(source, "cpp");
    expect(g.language).toBe("cpp");
    expect(g.rootPath).toBe("/proj");
    const n = names(g);
    expect(n).toContain("fromA");
    expect(n).toContain("fromB");
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/proj", { "skip.txt": "not source code" });
    const g = await parseDirectory(source, "cpp");
    expect(g.nodes.size).toBe(0);
  });
});
