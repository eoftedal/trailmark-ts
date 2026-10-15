/** Port of upstream tests/test_java_parser.py. */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `import java.util.List;
import java.io.IOException;

/** Defines animal behavior. */
interface Animal {
    String speak();
}

/** A dog that extends Pet and implements Animal. */
class Dog extends Pet implements Animal {

    private String name;

    public Dog(String name) {
        this.name = name;
    }

    public String speak() {
        return "woof";
    }

    public boolean fetch(String item, int count) {
        if (item == null || item.isEmpty()) {
            throw new IllegalArgumentException("empty");
        }
        for (int i = 0; i < count; i++) {
            System.out.println(item);
        }
        while (count > 10) {
            count--;
        }
        return true;
    }
}

class Puppy extends Dog {

    public Puppy(String name) {
        super(name);
    }

    public String play() {
        if (name != null) {
            return "playing";
        }
        return "sleeping";
    }
}

enum AnimalType {
    DOG,
    CAT,
    BIRD
}
`;

const GENERIC_JAVA_CODE = `import java.util.List;
import java.util.Map;

class Container {
    public List<String> getItems(Map<String, Integer> lookup) {
        return null;
    }
}
`;

const parseSample = (): Promise<CodeGraph> => parseSource("/tmp/sample.java", SAMPLE_CODE, "java");
const parseGeneric = (): Promise<CodeGraph> => parseSource("/tmp/generic.java", GENERIC_JAVA_CODE, "java");

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

describe("JavaParser nodes", () => {
  it("finds module", async () => {
    const g = await parseSample();
    expect(nodes(g).filter((n) => n.kind === "module")).toHaveLength(1);
  });

  it("finds interface", async () => {
    expect(namesOfKind(await parseSample(), "interface").has("Animal")).toBe(true);
  });

  it("finds classes", async () => {
    const names = namesOfKind(await parseSample(), "class");
    expect(names.has("Dog")).toBe(true);
    expect(names.has("Puppy")).toBe(true);
  });

  it("finds enum", async () => {
    expect(namesOfKind(await parseSample(), "enum").has("AnimalType")).toBe(true);
  });

  it("finds methods", async () => {
    const names = namesOfKind(await parseSample(), "method");
    for (const n of ["speak", "fetch", "play"]) expect(names.has(n)).toBe(true);
  });
});

describe("JavaParser parameters", () => {
  it("typed parameters", async () => {
    const fetch = byName(await parseSample(), "fetch");
    expect(fetch.parameters).toHaveLength(2);
    const names = new Set(fetch.parameters.map((p) => p.name));
    expect(names.has("item")).toBe(true);
    expect(names.has("count")).toBe(true);
  });

  it("parameter types", async () => {
    const fetch = byName(await parseSample(), "fetch");
    const params = new Map(fetch.parameters.map((p) => [p.name, p]));
    expect(params.get("item")!.typeRef?.name).toBe("String");
    expect(params.get("count")!.typeRef?.name).toBe("int");
  });

  it("return type", async () => {
    const fetch = byName(await parseSample(), "fetch");
    expect(fetch.returnType?.name).toBe("boolean");
  });
});

describe("JavaParser complexity", () => {
  it("simple method complexity", async () => {
    const g = await parseSample();
    const speak = nodes(g).filter((n) => n.name === "speak" && n.kind === "method")[0]!;
    expect(speak.cyclomaticComplexity).toBe(1);
  });

  it("branching method complexity", async () => {
    const fetch = byName(await parseSample(), "fetch");
    expect(fetch.cyclomaticComplexity).not.toBeNull();
    expect(fetch.cyclomaticComplexity!).toBeGreaterThanOrEqual(4);
  });

  it("branches tracked", async () => {
    expect(byName(await parseSample(), "fetch").branches.length).toBeGreaterThan(0);
  });
});

describe("JavaParser edges", () => {
  it("contains edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("inherits edge", async () => {
    const g = await parseSample();
    const inherits = g.edges.filter((e) => e.kind === "inherits");
    expect(inherits.length).toBeGreaterThanOrEqual(1);
    const targets = new Set(inherits.map((e) => e.targetId));
    expect([...targets].filter((t) => t.endsWith(":Pet")).length).toBeGreaterThanOrEqual(1);
  });

  it("implements edge", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "implements").length).toBeGreaterThanOrEqual(1);
  });

  it("call edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("exception type", async () => {
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

describe("JavaParser dependencies", () => {
  it("imports tracked", async () => {
    expect((await parseSample()).dependencies).toContain("java");
  });
});

describe("Java generic types", () => {
  it("generic parameter type", async () => {
    const getItems = byName(await parseGeneric(), "getItems");
    expect(getItems.parameters).toHaveLength(1);
    const param = getItems.parameters[0]!;
    expect(param.typeRef?.name).toBe("Map");
    expect(param.typeRef!.genericArgs).toHaveLength(2);
  });

  it("generic return type", async () => {
    const getItems = byName(await parseGeneric(), "getItems");
    expect(getItems.returnType?.name).toBe("List");
    expect(getItems.returnType!.genericArgs).toHaveLength(1);
  });
});

describe("Java parseDirectory", () => {
  it("parses multiple files", async () => {
    const root = "/tmp/javadir";
    const source = new MemoryFileSource(root, {
      "a.java": "class FromA {}\n",
      "b.java": "class FromB {}\n",
    });
    const graph = await parseDirectory(source, "java");
    expect(graph.language).toBe("java");
    expect(graph.rootPath).toBe(root);
    const names = new Set(nodes(graph).map((n) => n.name));
    expect(names.has("FromA")).toBe(true);
    expect(names.has("FromB")).toBe(true);
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/tmp/javadir2", { "skip.txt": "not source code" });
    const graph = await parseDirectory(source, "java");
    expect(graph.nodes.size).toBe(0);
  });
});
