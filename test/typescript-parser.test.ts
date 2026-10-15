/** Port of upstream tests/test_typescript_parser.py. */

import { describe, expect, it } from "vitest";

import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { CodeUnit } from "../src/models/nodes.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const SAMPLE_CODE = `import { Observable } from 'rxjs';

interface Serializable {
    serialize(): string;
    deserialize(data: string): void;
}

enum Status {
    Active,
    Inactive,
    Pending,
}

/** Base entity class. */
class Entity {
    constructor(public id: number) {}

    getId(): number {
        return this.id;
    }
}

class User extends Entity implements Serializable {
    constructor(id: number, public name: string) {
        super(id);
    }

    serialize(): string {
        return JSON.stringify({ id: this.getId(), name: this.name });
    }

    deserialize(data: string): void {
        const parsed = JSON.parse(data);
        this.name = parsed.name;
    }

    greet(): string {
        return "Hello, " + this.name;
    }
}

function filterActive(
    users: Array<User>,
    status: Status = Status.Active,
): User[] {
    const results: User[] = [];
    for (const user of users) {
        if (status === Status.Active) {
            results.push(user);
        } else if (status === Status.Pending) {
            continue;
        }
    }
    if (results.length === 0) {
        throw new Error("no active users");
    }
    return results;
}

function getName(user: User): string {
    return user.greet();
}

const transform = (x: number): number => {
    return x * 2;
};
`;

const EXTRA_TS_CODE = `export function exported(): void {
    console.log("hello");
}

export class ExportedClass {
    run(): void {}
}

interface Orderable<T> {
    compare(other: T): number;
}

class Sortable implements Orderable<Sortable> {
    compare(other: Sortable): number {
        return 0;
    }
}

function withOptional(x?: number, y?: string): void {}

`;

const ASSIGN_TS_CODE = `var handler: any;
handler = function(): number { return 1; };
`;

function parseTs(code: string): Promise<CodeGraph> {
  return parseSource("/tmp/sample.ts", code, "typescript");
}

const parseSample = () => parseTs(SAMPLE_CODE);
const parseExtra = () => parseTs(EXTRA_TS_CODE);

const nodes = (g: CodeGraph): CodeUnit[] => [...g.nodes.values()];
const ofKind = (g: CodeGraph, kind: string): CodeUnit[] => nodes(g).filter((n) => n.kind === kind);
const names = (units: CodeUnit[]): Set<string> => new Set(units.map((u) => u.name));
const byName = (g: CodeGraph, name: string): CodeUnit => nodes(g).find((n) => n.name === name)!;

describe("TypeScriptParserNodes", () => {
  it("finds module", async () => {
    expect(ofKind(await parseSample(), "module")).toHaveLength(1);
  });

  it("finds classes", async () => {
    const n = names(ofKind(await parseSample(), "class"));
    expect(n.has("Entity")).toBe(true);
    expect(n.has("User")).toBe(true);
  });

  it("finds interface", async () => {
    expect(names(ofKind(await parseSample(), "interface")).has("Serializable")).toBe(true);
  });

  it("finds enum", async () => {
    expect(names(ofKind(await parseSample(), "enum")).has("Status")).toBe(true);
  });

  it("finds functions", async () => {
    const n = names(ofKind(await parseSample(), "function"));
    expect(n.has("filterActive")).toBe(true);
    expect(n.has("getName")).toBe(true);
  });

  it("finds arrow function", async () => {
    expect(names(ofKind(await parseSample(), "function")).has("transform")).toBe(true);
  });

  it("finds methods", async () => {
    const n = names(ofKind(await parseSample(), "method"));
    expect(n.has("serialize")).toBe(true);
    expect(n.has("deserialize")).toBe(true);
    expect(n.has("getId")).toBe(true);
  });

  it("class jsdoc", async () => {
    const entity = byName(await parseSample(), "Entity");
    expect(entity.docstring).not.toBeNull();
    expect(entity.docstring!.toLowerCase()).toContain("entity");
  });
});

describe("TypeScriptParserParameters", () => {
  it("typed parameter", async () => {
    const getName = byName(await parseSample(), "getName");
    expect(getName.parameters).toHaveLength(1);
    expect(getName.parameters[0]!.name).toBe("user");
    expect(getName.parameters[0]!.typeRef).not.toBeNull();
    expect(getName.parameters[0]!.typeRef!.name).toBe("User");
  });

  it("return type", async () => {
    const getName = byName(await parseSample(), "getName");
    expect(getName.returnType).not.toBeNull();
    expect(getName.returnType!.name).toBe("string");
  });

  it("default parameter", async () => {
    const filterFn = byName(await parseSample(), "filterActive");
    const params = new Set(filterFn.parameters.map((p) => p.name));
    expect(params.has("users")).toBe(true);
    expect(params.has("status")).toBe(true);
  });
});

describe("TypeScriptParserComplexity", () => {
  it("simple method complexity", async () => {
    expect(byName(await parseSample(), "getId").cyclomaticComplexity).toBe(1);
  });

  it("branching function complexity", async () => {
    const filterFn = byName(await parseSample(), "filterActive");
    expect(filterFn.cyclomaticComplexity).not.toBeNull();
    expect(filterFn.cyclomaticComplexity!).toBeGreaterThanOrEqual(4);
  });

  it("branches tracked", async () => {
    expect(byName(await parseSample(), "filterActive").branches.length).toBeGreaterThan(0);
  });
});

describe("TypeScriptParserEdges", () => {
  it("contains edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "contains").length).toBeGreaterThan(0);
  });

  it("inherits edge", async () => {
    const g = await parseSample();
    const inherits = g.edges.filter((e) => e.kind === "inherits");
    expect(inherits.length).toBeGreaterThanOrEqual(1);
    expect(inherits.some((e) => e.targetId.includes("Entity"))).toBe(true);
  });

  it("implements edge", async () => {
    const g = await parseSample();
    const implementsEdges = g.edges.filter((e) => e.kind === "implements");
    expect(implementsEdges.length).toBeGreaterThanOrEqual(1);
    expect(implementsEdges.some((e) => e.targetId.includes("Serializable"))).toBe(true);
  });

  it("call edges", async () => {
    const g = await parseSample();
    expect(g.edges.filter((e) => e.kind === "calls").length).toBeGreaterThan(0);
  });

  it("throw exception type", async () => {
    const filterFn = byName(await parseSample(), "filterActive");
    expect(filterFn.exceptionTypes).toHaveLength(1);
    expect(filterFn.exceptionTypes[0]!.name).toBe("Error");
  });

  it("edge confidence", async () => {
    const g = await parseSample();
    const calls = g.edges.filter((e) => e.kind === "calls");
    const certain = calls.filter((e) => e.confidence === "certain");
    const inferred = calls.filter((e) => e.confidence === "inferred");
    expect(certain.length > 0 || inferred.length > 0).toBe(true);
  });
});

describe("TypeScriptParserDependencies", () => {
  it("imports tracked", async () => {
    expect((await parseSample()).dependencies).toContain("rxjs");
  });
});

describe("TypeScriptExtraFeatures", () => {
  it("export function extracted", async () => {
    expect(names(nodes(await parseExtra())).has("exported")).toBe(true);
  });

  it("export class extracted", async () => {
    expect(names(nodes(await parseExtra())).has("ExportedClass")).toBe(true);
  });

  it("implements generic interface", async () => {
    const g = await parseExtra();
    const implEdges = g.edges.filter((e) => e.kind === "implements");
    expect(implEdges.some((e) => e.targetId.includes("Orderable"))).toBe(true);
  });

  it("generic parameters extracted", async () => {
    const g = await parseTs(
      "interface Box<T extends Entity> {}\nfunction identity<U>(value: U): U { return value; }\n",
    );
    const box = byName(g, "Box");
    const identity = byName(g, "identity");
    expect(box.typeParameters[0]!.name).toBe("T");
    expect(box.typeParameters[0]!.constraints[0]!.name).toBe("Entity");
    expect(identity.typeParameters[0]!.name).toBe("U");
  });

  it("optional parameter", async () => {
    const fn = byName(await parseExtra(), "withOptional");
    expect(fn.parameters).toHaveLength(2);
    expect(fn.parameters[0]!.name).toBe("x");
    expect(fn.parameters[1]!.name).toBe("y");
  });

  it("expression assignment function", async () => {
    expect(names(nodes(await parseTs(ASSIGN_TS_CODE))).has("handler")).toBe(true);
  });
});

describe("TypeScriptParseDirectory", () => {
  it("parses multiple files", async () => {
    const root = "/tmp/tsdir";
    const source = new MemoryFileSource(root, {
      "a.ts": "function fromA(): void {}\n",
      "b.ts": "function fromB(): void {}\n",
    });
    const graph = await parseDirectory(source, "typescript");
    expect(graph.language).toBe("typescript");
    expect(graph.rootPath).toBe(root);
    const n = names(nodes(graph));
    expect(n.has("fromA")).toBe(true);
    expect(n.has("fromB")).toBe(true);
  });

  it("ignores wrong extensions", async () => {
    const source = new MemoryFileSource("/tmp/tsdir2", { "skip.txt": "not source code" });
    const graph = await parseDirectory(source, "typescript");
    expect(graph.nodes.size).toBe(0);
  });
});
