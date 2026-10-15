/** Tests for SARIF and weAudit augmentation (port of tests/test_augment.py). */

import { describe, expect, it } from "vitest";
import {
  augmentFromSarif,
  augmentFromWeaudit,
  clearAugmented,
  findOverlappingNodes,
  normalizePath,
} from "../src/analysis/augment.js";
import { CodeGraph, codeUnit, sourceLocation, type CodeUnit } from "../src/models/index.js";
import { QueryEngine } from "../src/query/api.js";
import { GraphStore } from "../src/storage/graph-store.js";

const ROOT = "/project";

const loc = (path: string, start: number, end: number) => sourceLocation(`${ROOT}/${path}`, start, end);

function node(id: string, path: string, start: number, end: number): CodeUnit {
  return codeUnit({ id, name: id.split(":").at(-1)!, kind: "function", location: loc(path, start, end) });
}

/** A graph with known file locations for matching. */
function buildGraph(): CodeGraph {
  const g = new CodeGraph({ rootPath: ROOT });
  for (const n of [
    node("mod:func_a", "src/handler.py", 10, 30),
    node("mod:func_b", "src/handler.py", 35, 50),
    node("mod:func_c", "src/db.py", 5, 25),
    codeUnit({ id: "mod:module", name: "module", kind: "module", location: loc("src/handler.py", 1, 100) }),
  ]) {
    g.nodes.set(n.id, n);
  }
  return g;
}

// ── Path normalization ──

describe("normalizePath", () => {
  it("relative path", () => {
    expect(normalizePath("src/handler.py", ROOT)).toBe("src/handler.py");
  });

  it("absolute path", () => {
    expect(normalizePath("/project/src/handler.py", ROOT)).toBe("src/handler.py");
  });

  it("file uri", () => {
    expect(normalizePath("file:///project/src/handler.py", ROOT)).toBe("src/handler.py");
  });

  it("unknown scheme returns null", () => {
    expect(normalizePath("https://example.com/file.py", ROOT)).toBeNull();
  });

  it("absolute path outside root", () => {
    const result = normalizePath("/other/file.py", ROOT);
    expect(result).not.toBeNull();
    expect(result).toContain("..");
  });

  it.each([
    ["file://host/project/a%20b.py", "a b.py"],
    ["FILE:///project/x.py?q#f", "x.py"],
    ["/project/../project/src/./a.py", "src/a.py"],
    ["/project", "."],
    ["c:\\x", null],
    ["./src/a.py", "./src/a.py"],
    ["file:src/a.py", "src/a.py"],
    ["/projectx/a.py", "../projectx/a.py"],
    ["//project/a.py", "a.py"],
  ])("matches upstream for %s", (uri, expected) => {
    expect(normalizePath(uri, ROOT)).toBe(expected);
  });
});

// ── Overlapping node matching ──

describe("findOverlappingNodes", () => {
  it("exact match", () => {
    expect(findOverlappingNodes(buildGraph(), "src/handler.py", 10, 30)).toContain("mod:func_a");
  });

  it("partial overlap", () => {
    const nodes = findOverlappingNodes(buildGraph(), "src/handler.py", 25, 40);
    expect(nodes).toContain("mod:func_a");
    expect(nodes).toContain("mod:func_b");
  });

  it("no overlap", () => {
    const nodes = findOverlappingNodes(buildGraph(), "src/handler.py", 51, 60);
    expect(nodes.filter((n) => n.includes("func"))).toEqual([]);
  });

  it("wrong file", () => {
    expect(findOverlappingNodes(buildGraph(), "src/other.py", 10, 30)).toEqual([]);
  });

  it("tightest match first", () => {
    const nodes = findOverlappingNodes(buildGraph(), "src/handler.py", 15, 15);
    expect(nodes[0]).toBe("mod:func_a");
    expect(nodes).toContain("mod:module");
  });

  it("single line finding", () => {
    expect(findOverlappingNodes(buildGraph(), "src/db.py", 10, 10)).toContain("mod:func_c");
  });
});

// ── SARIF augmentation ──

type Obj = Record<string, unknown>;

function minimalSarif(results: Obj[], toolName = "semgrep"): Obj {
  return {
    version: "2.1.0",
    $schema: "https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json",
    runs: [{ tool: { driver: { name: toolName } }, results }],
  };
}

function sarifResult(ruleId: string, message: string, uri: string, startLine: number, level = "warning"): Obj {
  return {
    ruleId,
    level,
    message: { text: message },
    locations: [{ physicalLocation: { artifactLocation: { uri }, region: { startLine, endLine: startLine } } }],
  };
}

describe("augmentFromSarif", () => {
  it("matches finding to node", () => {
    const store = new GraphStore(buildGraph());
    const result = augmentFromSarif(
      store,
      minimalSarif([sarifResult("exec-detected", "Detected exec()", "src/handler.py", 15)]),
    );
    expect(result["matched_findings"]).toBe(1);
    expect(result["unmatched_findings"]).toBe(0);
  });

  it("annotation format", () => {
    const graph = buildGraph();
    augmentFromSarif(
      new GraphStore(graph),
      minimalSarif([sarifResult("exec-detected", "Detected exec()", "src/handler.py", 15)]),
    );
    const finding = (graph.annotations.get("mod:func_a") ?? []).filter((a) => a.kind === "finding");
    expect(finding.length).toBeGreaterThanOrEqual(1);
    const desc = finding[0]!.description;
    expect(desc).toContain("[WARNING]");
    expect(desc).toContain("exec-detected");
    expect(desc).toContain("semgrep");
  });

  it("source field", () => {
    const graph = buildGraph();
    augmentFromSarif(new GraphStore(graph), minimalSarif([sarifResult("r1", "msg", "src/handler.py", 15)], "codeql"));
    expect((graph.annotations.get("mod:func_a") ?? []).some((a) => a.source === "sarif:codeql")).toBe(true);
  });

  it("subgraphs by level", () => {
    const result = augmentFromSarif(
      new GraphStore(buildGraph()),
      minimalSarif([
        sarifResult("r1", "msg", "src/handler.py", 15, "error"),
        sarifResult("r2", "msg", "src/db.py", 10, "note"),
      ]),
    );
    expect(result["subgraphs_created"]).toContain("sarif:error");
    expect(result["subgraphs_created"]).toContain("sarif:note");
    expect(result["subgraphs_created"]).toContain("sarif:semgrep");
  });

  it("unmatched finding", () => {
    const result = augmentFromSarif(
      new GraphStore(buildGraph()),
      minimalSarif([sarifResult("r1", "msg", "src/nonexistent.py", 1)]),
    );
    expect(result["matched_findings"]).toBe(0);
    expect(result["unmatched_findings"]).toBe(1);
  });

  it("multiple runs", () => {
    const result = augmentFromSarif(new GraphStore(buildGraph()), {
      version: "2.1.0",
      runs: [
        { tool: { driver: { name: "tool_a" } }, results: [sarifResult("r1", "m", "src/handler.py", 15)] },
        { tool: { driver: { name: "tool_b" } }, results: [sarifResult("r2", "m", "src/db.py", 10)] },
      ],
    });
    expect(result["matched_findings"]).toBe(2);
    expect(result["subgraphs_created"]).toContain("sarif:tool_a");
    expect(result["subgraphs_created"]).toContain("sarif:tool_b");
  });
});

// ── weAudit augmentation ──

function minimalWeaudit(entries: Obj[]): Obj {
  return {
    clientRemote: "https://github.com/org/repo",
    gitRemote: "https://github.com/org/repo",
    gitSha: "abc123",
    treeEntries: entries,
    resolvedEntries: [],
    auditedFiles: [],
  };
}

function weauditEntry(
  label: string,
  path: string,
  startLine: number,
  endLine: number,
  severity = "High",
  entryType = 0,
): Obj {
  return {
    label,
    entryType,
    author: "alice",
    details: {
      severity,
      difficulty: "Low",
      type: "Data Validation",
      description: `Description for ${label}`,
      exploit: "",
      recommendation: "",
    },
    locations: [{ path, startLine, endLine, label, description: "" }],
  };
}

describe("augmentFromWeaudit", () => {
  it("matches finding with line conversion", () => {
    // 0-indexed line 14 = 1-indexed line 15, inside func_a (10-30)
    const result = augmentFromWeaudit(
      new GraphStore(buildGraph()),
      minimalWeaudit([weauditEntry("SQLi", "src/handler.py", 14, 16)]),
    );
    expect(result["matched_findings"]).toBe(1);
  });

  it("finding annotation kind", () => {
    const graph = buildGraph();
    augmentFromWeaudit(new GraphStore(graph), minimalWeaudit([weauditEntry("SQLi", "src/handler.py", 14, 16)]));
    expect((graph.annotations.get("mod:func_a") ?? []).some((a) => a.kind === "finding")).toBe(true);
  });

  it("note annotation kind", () => {
    const graph = buildGraph();
    augmentFromWeaudit(
      new GraphStore(graph),
      minimalWeaudit([weauditEntry("Review this", "src/handler.py", 14, 16, "High", 1)]),
    );
    expect((graph.annotations.get("mod:func_a") ?? []).some((a) => a.kind === "audit_note")).toBe(true);
  });

  it("source includes author", () => {
    const graph = buildGraph();
    augmentFromWeaudit(new GraphStore(graph), minimalWeaudit([weauditEntry("SQLi", "src/handler.py", 14, 16)]));
    expect((graph.annotations.get("mod:func_a") ?? []).some((a) => a.source === "weaudit:alice")).toBe(true);
  });

  it("severity subgraphs", () => {
    const result = augmentFromWeaudit(
      new GraphStore(buildGraph()),
      minimalWeaudit([
        weauditEntry("High issue", "src/handler.py", 14, 16, "High"),
        weauditEntry("Low issue", "src/db.py", 4, 6, "Low"),
      ]),
    );
    expect(result["subgraphs_created"]).toContain("weaudit:high");
    expect(result["subgraphs_created"]).toContain("weaudit:low");
    expect(result["subgraphs_created"]).toContain("weaudit:findings");
  });

  it("description format", () => {
    const graph = buildGraph();
    augmentFromWeaudit(new GraphStore(graph), minimalWeaudit([weauditEntry("SQLi", "src/handler.py", 14, 16)]));
    const finding = (graph.annotations.get("mod:func_a") ?? []).find((a) => a.kind === "finding")!;
    expect(finding.description).toContain("[HIGH]");
    expect(finding.description).toContain("SQLi");
    expect(finding.description).toContain("[alice]");
  });

  it("resolved entries included", () => {
    const data = minimalWeaudit([]);
    data["resolvedEntries"] = [weauditEntry("Fixed issue", "src/handler.py", 14, 16)];
    expect(augmentFromWeaudit(new GraphStore(buildGraph()), data)["matched_findings"]).toBe(1);
  });
});

// ── Clearing ──

describe("clearAugmented", () => {
  const sarif = () => minimalSarif([sarifResult("r1", "msg", "src/handler.py", 15)]);

  it("clear sarif", () => {
    const graph = buildGraph();
    const store = new GraphStore(graph);
    augmentFromSarif(store, sarif());
    expect(graph.annotations.size).toBeGreaterThan(0);
    clearAugmented(store, "sarif");
    const remaining = [...graph.annotations.values()].flat().filter((a) => a.source.startsWith("sarif"));
    expect(remaining).toEqual([]);
  });

  it("clear removes subgraphs", () => {
    const graph = buildGraph();
    const store = new GraphStore(graph);
    augmentFromSarif(store, sarif());
    expect([...graph.subgraphs.keys()].some((k) => k.startsWith("sarif:"))).toBe(true);
    clearAugmented(store, "sarif");
    expect([...graph.subgraphs.keys()].some((k) => k.startsWith("sarif:"))).toBe(false);
  });

  it("reaugment idempotent", () => {
    const graph = buildGraph();
    const store = new GraphStore(graph);
    const count = () => [...graph.annotations.values()].reduce((n, anns) => n + anns.length, 0);
    augmentFromSarif(store, sarif());
    const first = count();
    augmentFromSarif(store, sarif());
    expect(count()).toBe(first);
  });
});

// ── QueryEngine integration ──

describe("QueryEngine augment", () => {
  it("augment sarif via engine", () => {
    const engine = QueryEngine.fromGraph(buildGraph());
    expect(
      engine.augmentSarif(minimalSarif([sarifResult("r1", "msg", "src/handler.py", 15)]))["matched_findings"],
    ).toBe(1);
  });

  it("augment sarif via engine from JSON text", () => {
    const engine = QueryEngine.fromGraph(buildGraph());
    const text = JSON.stringify(minimalSarif([sarifResult("r1", "msg", "src/handler.py", 15)]));
    expect(engine.augmentSarif(text)["matched_findings"]).toBe(1);
  });

  it("findings method", () => {
    const engine = QueryEngine.fromGraph(buildGraph());
    engine.augmentSarif(minimalSarif([sarifResult("r1", "msg", "src/handler.py", 15, "error")]));
    const findings = engine.findings();
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings[0]).toHaveProperty("findings");
    expect((findings[0]!["findings"] as { kind: string }[])[0]!.kind).toBe("finding");
  });

  it("findings filter by kind", () => {
    const engine = QueryEngine.fromGraph(buildGraph());
    engine.augmentSarif(minimalSarif([sarifResult("r1", "msg", "src/handler.py", 15)]));
    engine.augmentWeaudit(minimalWeaudit([weauditEntry("Note", "src/db.py", 4, 6, "High", 1)]));
    const notes = engine.findings("audit_note");
    const findings = engine.findings("finding");
    expect(notes.length).toBeGreaterThanOrEqual(1);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    for (const f of notes) expect((f["findings"] as { kind: string }[])[0]!.kind).toBe("audit_note");
  });
});

// ── Differential check against upstream output ──

describe("upstream parity", () => {
  it("matches upstream annotations, subgraphs and summaries", () => {
    const graph = buildGraph();
    const store = new GraphStore(graph);
    const sarifSummary = augmentFromSarif(
      store,
      minimalSarif([
        sarifResult("r1", "m1", "src/handler.py", 15, "error"),
        sarifResult("r2", "m2", "file:///project/src/db.py", 10),
        {
          ruleId: "x",
          locations: [
            { physicalLocation: { artifactLocation: { uri: "/project/src/handler.py" }, region: { startLine: 40 } } },
          ],
        },
        { message: {} },
      ]),
    );
    expect(sarifSummary).toEqual({
      matched_findings: 3,
      unmatched_findings: 1,
      subgraphs_created: ["sarif:error", "sarif:semgrep", "sarif:warning"],
    });
    const weauditSummary = augmentFromWeaudit(
      store,
      minimalWeaudit([
        weauditEntry("SQLi", "src/handler.py", 14, 16),
        {
          label: "Note",
          entryType: 1,
          details: { severity: "", description: "line1\nline2" },
          locations: [{ path: "src/db.py", startLine: 4, endLine: 6 }],
        },
      ]),
    );
    expect(weauditSummary).toEqual({
      matched_findings: 2,
      unmatched_findings: 0,
      subgraphs_created: ["weaudit:findings", "weaudit:high", "weaudit:notes"],
    });

    const anns = Object.fromEntries(
      [...graph.annotations].map(([k, v]) => [k, v.map((a) => [a.kind, a.description, a.source])]),
    );
    // Upstream's annotation-dict key order follows Python set iteration (hash-randomized), so compare per node.
    expect(anns).toEqual({
      "mod:module": [
        ["finding", "[ERROR] r1: m1 (semgrep)", "sarif:semgrep"],
        ["finding", "[WARNING] x:  (semgrep)", "sarif:semgrep"],
        ["finding", "[HIGH] SQLi (Data Validation) - Description for SQLi [alice]", "weaudit:alice"],
      ],
      "mod:func_a": [
        ["finding", "[ERROR] r1: m1 (semgrep)", "sarif:semgrep"],
        ["finding", "[HIGH] SQLi (Data Validation) - Description for SQLi [alice]", "weaudit:alice"],
      ],
      "mod:func_c": [
        ["finding", "[WARNING] r2: m2 (semgrep)", "sarif:semgrep"],
        ["audit_note", "[UNSET] Note - line1 [repo]", "weaudit:repo"],
      ],
      "mod:func_b": [["finding", "[WARNING] x:  (semgrep)", "sarif:semgrep"]],
    });
    const subgraphs = Object.fromEntries([...graph.subgraphs].map(([k, v]) => [k, [...v].sort()]));
    expect(subgraphs).toEqual({
      "sarif:error": ["mod:func_a", "mod:module"],
      "sarif:semgrep": ["mod:func_a", "mod:func_b", "mod:func_c", "mod:module"],
      "sarif:warning": ["mod:func_b", "mod:func_c", "mod:module"],
      "weaudit:findings": ["mod:func_a", "mod:module"],
      "weaudit:high": ["mod:func_a", "mod:module"],
      "weaudit:notes": ["mod:func_c"],
    });
  });
});
