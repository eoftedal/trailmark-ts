/** Port of upstream tests/test_javascript_parser.py. */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `import { EventEmitter } from 'events';

/** Base shape class. */
class Shape extends EventEmitter {
    constructor(name) {
        super();
        this.name = name;
    }

    /** Calculate area. */
    area() {
        return 0;
    }
}

class Circle extends Shape {
    constructor(radius) {
        super("circle");
        this.radius = radius;
    }

    area() {
        return Math.PI * this.radius * this.radius;
    }
}

function processShapes(shapes, threshold = 10) {
    const results = [];
    for (const shape of shapes) {
        if (shape.area() > threshold) {
            results.push(shape);
        }
    }
    if (results.length === 0) {
        throw new Error("no shapes above threshold");
    }
    return results;
}

function greet(name) {
    return "hello " + name;
}

const double = (x) => {
    return x * 2;
};

function run() {
    const shapes = [];
    greet("world");
    processShapes(shapes);
}
`;

const EXTRA_JS_CODE = `export function exported() {
    return 42;
}

export class ExportedWidget {
    render() { return "html"; }
}

function withRest(...args) {
    return args.length;
}
`;

const ASSIGN_JS_CODE = `var handler;
handler = function() { return 1; };
`;

function parseSnippet(code: string): Promise<CodeGraph> {
  return parseSource("/tmp/sample.js", code, "javascript");
}

const parseSample = () => parseSnippet(SAMPLE_CODE);
const parseExtra = () => parseSnippet(EXTRA_JS_CODE);

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

function allNames(graph: CodeGraph): Set<string> {
  return new Set(nodes(graph).map((n) => n.name));
}

describe("JavaScriptParser nodes", () => {
  it("finds module", async () => {
    expect(nodes(await parseSample()).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds classes", async () => {
    const names = namesOfKind(await parseSample(), "class");
    expect(names.has("Shape")).toBe(true);
    expect(names.has("Circle")).toBe(true);
  });

  it("finds functions", async () => {
    const names = namesOfKind(await parseSample(), "function");
    for (const n of ["processShapes", "greet", "run"]) expect(names.has(n)).toBe(true);
  });

  it("finds arrow function", async () => {
    expect(namesOfKind(await parseSample(), "function").has("double")).toBe(true);
  });

  it("finds methods", async () => {
    const names = namesOfKind(await parseSample(), "method");
    expect(names.has("constructor")).toBe(true);
    expect(names.has("area")).toBe(true);
  });

  it("class jsdoc", async () => {
    const shape = named(await parseSample(), "Shape");
    expect(shape.docstring).not.toBeNull();
    expect(shape.docstring!.toLowerCase()).toContain("shape");
  });
});

describe("JavaScriptParser parameters", () => {
  it("simple parameter", async () => {
    const greet = named(await parseSample(), "greet");
    expect(greet.parameters).toHaveLength(1);
    expect(greet.parameters[0]!.name).toBe("name");
  });

  it("default parameter", async () => {
    const process = named(await parseSample(), "processShapes");
    const params = new Map(process.parameters.map((p) => [p.name, p]));
    expect(params.has("shapes")).toBe(true);
    expect(params.get("threshold")?.default).toBe("10");
  });

  it("no return type", async () => {
    expect(named(await parseSample(), "greet").returnType).toBeNull();
  });
});

describe("JavaScriptParser complexity", () => {
  it("simple function complexity", async () => {
    expect(named(await parseSample(), "greet").cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const process = named(await parseSample(), "processShapes");
    expect(process.cyclomaticComplexity).not.toBeNull();
    expect(process.cyclomaticComplexity!).toBeGreaterThanOrEqual(3);
  });

  it("branches tracked", async () => {
    expect(named(await parseSample(), "processShapes").branches.length).toBeGreaterThan(0);
  });
});

describe("JavaScriptParser edges", () => {
  it("contains edges", async () => {
    expect((await parseSample()).edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("inherits edge", async () => {
    const inherits = (await parseSample()).edges.filter((e) => e.kind === "inherits");
    expect(inherits.length).toBeGreaterThanOrEqual(1);
    expect(inherits.some((e) => e.targetId.includes("Shape"))).toBe(true);
  });

  it("call edges", async () => {
    expect((await parseSample()).edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("throw exception type", async () => {
    const process = named(await parseSample(), "processShapes");
    expect(process.exceptionTypes).toHaveLength(1);
    expect(process.exceptionTypes[0]!.name).toBe("Error");
  });

  it("edge confidence", async () => {
    const calls = (await parseSample()).edges.filter((e) => e.kind === "calls");
    const certain = calls.filter((e) => e.confidence === "certain");
    const inferred = calls.filter((e) => e.confidence === "inferred");
    expect(certain.length > 0 || inferred.length > 0).toBe(true);
  });
});

describe("JavaScriptParser dependencies", () => {
  it("imports tracked", async () => {
    expect((await parseSample()).dependencies).toContain("events");
  });
});

describe("JavaScript extra features", () => {
  it("export function extracted", async () => {
    expect(allNames(await parseExtra()).has("exported")).toBe(true);
  });

  it("export class extracted", async () => {
    expect(allNames(await parseExtra()).has("ExportedWidget")).toBe(true);
  });
});

describe("JavaScriptParser extensions", () => {
  it("parse directory includes mjs and cjs", async () => {
    const source = new MemoryFileSource("/proj", {
      "alpha.mjs": "export function alpha() { return 1; }\n",
      "beta.cjs": "function beta() { return 2; }\n",
    });
    const names = allNames(await parseDirectory(source, "javascript"));
    expect(names.has("alpha")).toBe(true);
    expect(names.has("beta")).toBe(true);
  });

  it("rest parameter", async () => {
    const fn = named(await parseExtra(), "withRest");
    expect(fn.parameters).toHaveLength(1);
    expect(fn.parameters[0]!.name).toBe("...args");
  });

  it("expression assignment function", async () => {
    expect(allNames(await parseSnippet(ASSIGN_JS_CODE)).has("handler")).toBe(true);
  });
});

describe("JavaScriptParser parse directory", () => {
  it("parses multiple files", async () => {
    const source = new MemoryFileSource("/proj", {
      "a.js": "function fromA() {}\n",
      "b.js": "function fromB() {}\n",
    });
    const graph = await parseDirectory(source, "javascript");
    expect(graph.language).toBe("javascript");
    expect(graph.rootPath).toBe("/proj");
    const names = allNames(graph);
    expect(names.has("fromA")).toBe(true);
    expect(names.has("fromB")).toBe(true);
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/proj", { "skip.txt": "not source code" });
    const graph = await parseDirectory(source, "javascript");
    expect(graph.nodes.size).toBe(0);
  });
});
