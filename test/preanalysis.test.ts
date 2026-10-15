/** Tests for the pre-analysis passes (port of tests/test_preanalysis.py). */

import { describe, expect, it } from "vitest";
import {
  CodeGraph,
  codeEdge,
  codeUnit,
  entrypointTag,
  sourceLocation,
  type CodeEdge,
  type CodeUnit,
  type EntrypointTag,
  type NodeKind,
} from "../src/models/index.js";
import type { JsonObject } from "../src/query/dicts.js";
import { QueryEngine } from "../src/query/api.js";

const LOC = sourceLocation("test.py", 1, 10);

function node(id: string, name: string, complexity: number | null = null, kind: NodeKind = "function"): CodeUnit {
  return codeUnit({ id, name, kind, location: LOC, cyclomaticComplexity: complexity });
}

function makeGraph(nodes: CodeUnit[], edges: CodeEdge[], entrypoints: [string, EntrypointTag][] = []): CodeGraph {
  const g = new CodeGraph();
  for (const n of nodes) g.nodes.set(n.id, n);
  g.edges.push(...edges);
  for (const [id, tag] of entrypoints) g.entrypoints.set(id, tag);
  return g;
}

const calls = (s: string, t: string) => codeEdge({ sourceId: s, targetId: t, kind: "calls" });

/** ep_untrusted -> handler -> db_query -> logger; ep_untrusted is an untrusted entrypoint. */
function buildChainGraph(): QueryEngine {
  return QueryEngine.fromGraph(
    makeGraph(
      [
        node("ep_untrusted", "ep_untrusted", 2),
        node("handler", "handler", 12),
        node("db_query", "db_query", 8),
        node("logger", "logger", 1),
      ],
      [calls("ep_untrusted", "handler"), calls("handler", "db_query"), calls("handler", "logger")],
      [["ep_untrusted", entrypointTag("user_input", { trustLevel: "untrusted_external" })]],
    ),
  );
}

/** ep_untrusted -> shared_handler -> db_write; ep_trusted -> shared_handler -> db_write. */
function buildMixedTrustGraph(): QueryEngine {
  return QueryEngine.fromGraph(
    makeGraph(
      [
        node("ep_untrusted", "ep_untrusted", 2),
        node("ep_trusted", "ep_trusted", 1),
        node("shared_handler", "shared_handler", 6),
        node("db_write", "db_write", 3),
      ],
      [
        calls("ep_untrusted", "shared_handler"),
        calls("ep_trusted", "shared_handler"),
        calls("shared_handler", "db_write"),
      ],
      [
        ["ep_untrusted", entrypointTag("user_input", { trustLevel: "untrusted_external" })],
        ["ep_trusted", entrypointTag("api", { trustLevel: "trusted_internal" })],
      ],
    ),
  );
}

function buildNoEntrypointsGraph(): QueryEngine {
  return QueryEngine.fromGraph(makeGraph([node("a", "a", 3), node("b", "b", 5)], [calls("a", "b")]));
}

const sub = (r: JsonObject, key: string) => r[key] as JsonObject;
const ids = (items: JsonObject[]) => new Set(items.map((n) => n["id"]));

describe("preanalysis returns summary", () => {
  it("returns all keys", () => {
    const result = buildChainGraph().preanalysis();
    expect(Object.keys(result)).toEqual(["blast_radius", "entrypoints", "privilege_boundaries", "taint_propagation"]);
  });
});

describe("blast radius", () => {
  it("annotates all nodes", () => {
    expect(sub(buildChainGraph().preanalysis(), "blast_radius")["annotated_nodes"]).toBe(4);
  });

  it("high blast radius subgraph", () => {
    const nodes = [node("ep", "ep", 1)];
    const edges: CodeEdge[] = [];
    for (let i = 0; i < 12; i++) {
      nodes.push(node(`f${i}`, `f${i}`, 1));
      edges.push(calls("ep", `f${i}`));
    }
    const engine = QueryEngine.fromGraph(
      makeGraph(nodes, edges, [["ep", entrypointTag("user_input", { trustLevel: "untrusted_external" })]]),
    );
    engine.preanalysis();
    expect(ids(engine.subgraph("high_blast_radius")).has("ep")).toBe(true);
  });

  it("max radius", () => {
    expect(sub(buildChainGraph().preanalysis(), "blast_radius")["max_radius"]).toBe(3);
  });

  it("blast radius annotation content", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const anns = engine.annotationsOf("ep_untrusted", "blast_radius");
    expect(anns).toHaveLength(1);
    expect(anns[0]!["description"]).toContain("downstream");
    expect(anns[0]!["description"]).toContain("upstream");
  });

  it("critical descendants in annotation", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const anns = engine.annotationsOf("ep_untrusted", "blast_radius");
    expect(anns[0]!["description"]).toContain("handler");
    // Upstream text (sorted by (cc, id) descending).
    expect(anns[0]!["description"]).toBe("3 downstream, 0 upstream; critical: handler, db_query, logger");
  });

  it("blast radius ignores non-call edges", () => {
    const engine = QueryEngine.fromGraph(
      makeGraph(
        [node("mod", "mod", null, "module"), node("f", "f", 7)],
        [codeEdge({ sourceId: "mod", targetId: "f", kind: "contains" })],
      ),
    );
    const result = engine.preanalysis();
    expect(sub(result, "blast_radius")["max_radius"]).toBe(0);
    const anns = engine.annotationsOf("mod", "blast_radius");
    expect((anns[0]!["description"] as string).startsWith("0 downstream, 0 upstream")).toBe(true);
  });
});

describe("entrypoint enumeration", () => {
  it("entrypoints subgraph", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    expect(ids(engine.subgraph("entrypoints"))).toEqual(new Set(["ep_untrusted"]));
  });

  it("reachable subgraph", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const r = ids(engine.subgraph("entrypoint_reachable"));
    expect(r.has("handler")).toBe(true);
    expect(r.has("db_query")).toBe(true);
    expect(r.has("ep_untrusted")).toBe(true);
  });

  it("by trust level subgraph", () => {
    const engine = buildMixedTrustGraph();
    engine.preanalysis();
    const untrusted = engine.subgraph("entrypoints:untrusted_external");
    expect(untrusted).toHaveLength(1);
    expect(untrusted[0]!["id"]).toBe("ep_untrusted");
  });

  it("summary counts", () => {
    const ep = sub(buildMixedTrustGraph().preanalysis(), "entrypoints");
    expect(ep["total_entrypoints"]).toBe(2);
    expect(ep["reachable_nodes"] as number).toBeGreaterThanOrEqual(4);
    expect(ep["by_trust_level"]).toEqual({ untrusted_external: 1, trusted_internal: 1 });
  });

  it("no entrypoints", () => {
    const ep = sub(buildNoEntrypointsGraph().preanalysis(), "entrypoints");
    expect(ep["total_entrypoints"]).toBe(0);
    expect(ep["reachable_nodes"]).toBe(0);
  });
});

describe("privilege boundary", () => {
  it("detects boundary in mixed trust", () => {
    expect(sub(buildMixedTrustGraph().preanalysis(), "privilege_boundaries")["boundary_nodes"]).toBeGreaterThan(0);
  });

  it("boundary subgraph populated", () => {
    const engine = buildMixedTrustGraph();
    engine.preanalysis();
    expect(engine.subgraph("privilege_boundary").length).toBeGreaterThan(0);
  });

  it("no boundary with single trust", () => {
    expect(sub(buildChainGraph().preanalysis(), "privilege_boundaries")["boundary_nodes"]).toBe(0);
  });

  it("boundary annotation content", () => {
    const engine = buildMixedTrustGraph();
    engine.preanalysis();
    const boundary = engine.subgraph("privilege_boundary");
    expect(boundary.length).toBeGreaterThan(0);
    const anns = engine.annotationsOf(boundary[0]!["id"] as string, "privilege_boundary");
    expect(anns.length).toBeGreaterThanOrEqual(1);
    expect(anns[0]!["description"]).toContain("trust transition");
  });

  it("matches upstream annotation text", () => {
    const engine = buildMixedTrustGraph();
    engine.preanalysis();
    expect(engine.annotationsOf("ep_untrusted", "privilege_boundary")).toEqual([
      {
        kind: "privilege_boundary",
        description: "trust transition across call: untrusted_external -> trusted_internal+untrusted_external",
        source: "preanalysis",
      },
    ]);
  });
});

describe("taint propagation", () => {
  it("tainted subgraph", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const t = ids(engine.subgraph("tainted"));
    expect(t.has("ep_untrusted")).toBe(true);
    expect(t.has("handler")).toBe(true);
    expect(t.has("db_query")).toBe(true);
  });

  it("taint annotation content", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const anns = engine.annotationsOf("handler", "taint_propagation");
    expect(anns).toHaveLength(1);
    expect(anns[0]!["description"]).toContain("ep_untrusted");
  });

  it("trusted entrypoint not taint source", () => {
    const engine = QueryEngine.fromGraph(
      makeGraph(
        [node("ep_trusted", "ep_trusted", 1), node("internal", "internal", 2)],
        [calls("ep_trusted", "internal")],
        [["ep_trusted", entrypointTag("api", { trustLevel: "trusted_internal" })]],
      ),
    );
    expect(sub(engine.preanalysis(), "taint_propagation")["tainted_nodes"]).toBe(0);
  });

  it("semi trusted does taint", () => {
    const engine = QueryEngine.fromGraph(
      makeGraph(
        [node("ep_semi", "ep_semi", 1), node("target", "target", 2)],
        [calls("ep_semi", "target")],
        [["ep_semi", entrypointTag("third_party", { trustLevel: "semi_trusted_external" })]],
      ),
    );
    expect(sub(engine.preanalysis(), "taint_propagation")["tainted_nodes"]).toBe(2);
  });

  it("no entrypoints no taint", () => {
    expect(sub(buildNoEntrypointsGraph().preanalysis(), "taint_propagation")["tainted_nodes"]).toBe(0);
  });

  it("taint source count", () => {
    expect(sub(buildMixedTrustGraph().preanalysis(), "taint_propagation")["taint_sources"]).toBe(1);
  });
});

describe("subgraph API", () => {
  it("subgraph names populated", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const names = engine.subgraphNames();
    expect(names).toContain("entrypoints");
    expect(names).toContain("tainted");
    expect(names).toContain("high_blast_radius");
  });

  it("subgraph empty name", () => {
    expect(buildChainGraph().subgraph("nonexistent")).toEqual([]);
  });

  it("subgraphs in json", () => {
    const engine = buildChainGraph();
    engine.preanalysis();
    const data = JSON.parse(engine.toJson());
    expect(data).toHaveProperty("subgraphs");
    expect(data.subgraphs).toHaveProperty("tainted");
  });

  it("matches upstream output for mixed trust graph", () => {
    const engine = buildMixedTrustGraph();
    expect(engine.preanalysis()).toEqual({
      blast_radius: { annotated_nodes: 4, high_blast_count: 0, max_radius: 2, threshold: 10 },
      entrypoints: {
        total_entrypoints: 2,
        reachable_nodes: 4,
        by_trust_level: { untrusted_external: 1, trusted_internal: 1 },
      },
      privilege_boundaries: { boundary_nodes: 3 },
      taint_propagation: { tainted_nodes: 3, taint_sources: 1 },
    });
    const pa = "preanalysis";
    expect(engine.annotationsOf("shared_handler")).toEqual([
      { kind: "blast_radius", description: "1 downstream, 2 upstream; critical: db_write", source: pa },
      {
        kind: "privilege_boundary",
        description: "trust transition across call: untrusted_external -> trusted_internal+untrusted_external",
        source: pa,
      },
      {
        kind: "privilege_boundary",
        description: "trust transition across call: trusted_internal -> trusted_internal+untrusted_external",
        source: pa,
      },
      { kind: "taint_propagation", description: "tainted via: ep_untrusted", source: pa },
    ]);
  });

  it("is idempotent across repeated runs", () => {
    const engine = buildMixedTrustGraph();
    const first = engine.preanalysis();
    const json1 = engine.toJson();
    const anns1 = engine.annotationsOf("shared_handler");
    expect(engine.preanalysis()).toEqual(first);
    expect(engine.toJson()).toBe(json1);
    expect(engine.annotationsOf("shared_handler")).toEqual(anns1);
  });
});
