/**
 * Pre-analysis passes that enrich code graphs before downstream skills.
 *
 * Runs four passes over the graph:
 * 1. Blast radius estimation — how many nodes are affected per function
 * 2. Entry point enumeration — systematic entrypoint + reachability mapping
 * 3. Privilege boundary crossing — where trust levels change across calls
 * 4. Taint propagation — untrusted data flow through the call graph
 */

import { pyCompare } from "../fs/source.js";
import type { Annotation, TrustLevel } from "../models/annotations.js";
import type { CodeGraph } from "../models/graph.js";
import type { JsonObject } from "../query/dicts.js";
import type { GraphStore } from "../storage/graph-store.js";

const BLAST_RADIUS_THRESHOLD = 10;
const PREANALYSIS_SOURCE = "preanalysis";
const PREANALYSIS_SUBGRAPHS: ReadonlySet<string> = new Set([
  "high_blast_radius",
  "entrypoints",
  "entrypoint_reachable",
  "privilege_boundary",
  "tainted",
]);

/** Remove annotations and subgraphs from a previous preanalysis run. */
function clearPriorPreanalysis(store: GraphStore): void {
  const graph = store.graph;
  for (const [nodeId, anns] of [...graph.annotations]) {
    const kept = anns.filter((a) => a.source !== PREANALYSIS_SOURCE);
    if (kept.length === 0) graph.annotations.delete(nodeId);
    else graph.annotations.set(nodeId, kept);
  }
  for (const name of [...graph.subgraphs.keys()]) {
    if (PREANALYSIS_SUBGRAPHS.has(name) || name.startsWith("entrypoints:")) graph.subgraphs.delete(name);
  }
}

/**
 * Run all pre-analysis passes and return a summary.
 *
 * Mutates the graph by adding annotations and subgraphs. Safe to call multiple
 * times: clears prior preanalysis annotations before recomputing.
 */
export function runPreanalysis(store: GraphStore): JsonObject {
  clearPriorPreanalysis(store);
  const blast = computeBlastRadius(store);
  const entry = enumerateEntrypoints(store);
  const priv = detectPrivilegeBoundaries(store);
  const taint = propagateTaint(store);
  return {
    blast_radius: blast,
    entrypoints: entry,
    privilege_boundaries: priv,
    taint_propagation: taint,
  };
}

/**
 * Annotate each node with its downstream blast radius.
 *
 * Blast radius = number of nodes reachable via call edges.
 * Nodes above the threshold are collected in a subgraph.
 */
function computeBlastRadius(store: GraphStore): JsonObject {
  const graph = store.graph;
  const highBlast = new Set<string>();
  let maxRadius = 0;
  let annotated = 0;

  for (const nodeId of [...graph.nodes.keys()]) {
    const descendants = store.reachableFrom(nodeId);
    const downstream = descendants.size;
    const upstream = store.ancestorsOf(nodeId).size;

    const critical = topCriticalDescendants(descendants, graph);
    let desc = `${downstream} downstream, ${upstream} upstream`;
    if (critical.length > 0) desc += `; critical: ${critical.join(", ")}`;

    const ann: Annotation = { kind: "blast_radius", description: desc, source: PREANALYSIS_SOURCE };
    graph.addAnnotation(nodeId, ann);
    annotated += 1;

    if (downstream >= BLAST_RADIUS_THRESHOLD) highBlast.add(nodeId);
    maxRadius = Math.max(maxRadius, downstream);
  }

  store.addSubgraph("high_blast_radius", highBlast);
  return {
    annotated_nodes: annotated,
    high_blast_count: highBlast.size,
    max_radius: maxRadius,
    threshold: BLAST_RADIUS_THRESHOLD,
  };
}

/** Pick the highest-complexity descendants as critical. */
function topCriticalDescendants(descendants: Set<string>, graph: CodeGraph, limit = 5): string[] {
  const scored: [number, string][] = [];
  for (const dId of descendants) {
    const node = graph.nodes.get(dId);
    if (node === undefined) continue;
    const cc = node.cyclomaticComplexity ?? 0;
    if (cc > 0) scored.push([cc, dId]);
  }
  // sorted(reverse=True) on (cc, id) tuples.
  scored.sort((a, b) => b[0] - a[0] || pyCompare(b[1], a[1]));
  return scored.slice(0, limit).map(([, name]) => name);
}

/** Build subgraphs for entrypoints and their reachable nodes. */
function enumerateEntrypoints(store: GraphStore): JsonObject {
  const graph = store.graph;
  const epIds = new Set<string>();
  const reachableAll = new Set<string>();
  const byTrust = new Map<string, Set<string>>();

  for (const [epId, tag] of graph.entrypoints) {
    epIds.add(epId);
    let set = byTrust.get(tag.trustLevel);
    if (set === undefined) {
      set = new Set();
      byTrust.set(tag.trustLevel, set);
    }
    set.add(epId);
    for (const id of store.reachableFrom(epId)) reachableAll.add(id);
    reachableAll.add(epId);
  }

  store.addSubgraph("entrypoints", epIds);
  store.addSubgraph("entrypoint_reachable", reachableAll);
  for (const [trustKey, ids] of byTrust) store.addSubgraph(`entrypoints:${trustKey}`, ids);

  const byTrustCounts: JsonObject = {};
  for (const [k, v] of byTrust) byTrustCounts[k] = v.size;
  return {
    total_entrypoints: epIds.size,
    reachable_nodes: reachableAll.size,
    by_trust_level: byTrustCounts,
  };
}

/**
 * Find nodes where trust levels change across call edges.
 *
 * A privilege boundary exists where a node reachable from an untrusted
 * entrypoint calls into a node reachable only from trusted entrypoints
 * (or not tagged at all).
 */
function detectPrivilegeBoundaries(store: GraphStore): JsonObject {
  const graph = store.graph;
  const untrusted = reachableFromTrust(store, "untrusted_external");
  const semiTrusted = reachableFromTrust(store, "semi_trusted_external");
  const trusted = reachableFromTrust(store, "trusted_internal");

  const boundaryNodes = new Set<string>();

  for (const edge of [...graph.edges]) {
    if (edge.kind !== "calls") continue;
    const src = edge.sourceId;
    const tgt = edge.targetId;
    const srcTrust = nodeTrustSet(src, untrusted, semiTrusted, trusted);
    const tgtTrust = nodeTrustSet(tgt, untrusted, semiTrusted, trusted);
    if (!sameSet(srcTrust, tgtTrust) && srcTrust.size > 0 && tgtTrust.size > 0) {
      boundaryNodes.add(src);
      boundaryNodes.add(tgt);
      for (const nodeId of [src, tgt]) {
        graph.addAnnotation(nodeId, {
          kind: "privilege_boundary",
          description: `trust transition across call: ${trustLabel(srcTrust)} -> ${trustLabel(tgtTrust)}`,
          source: PREANALYSIS_SOURCE,
        });
      }
    }
  }

  store.addSubgraph("privilege_boundary", boundaryNodes);
  return { boundary_nodes: boundaryNodes.size };
}

/** Return all nodes reachable from entrypoints at a trust level. */
function reachableFromTrust(store: GraphStore, trust: TrustLevel): Set<string> {
  const result = new Set<string>();
  for (const [epId, tag] of store.graph.entrypoints) {
    if (tag.trustLevel === trust) {
      result.add(epId);
      for (const id of store.reachableFrom(epId)) result.add(id);
    }
  }
  return result;
}

/** Return the set of trust levels that can reach a node. */
function nodeTrustSet(nodeId: string, untrusted: Set<string>, semi: Set<string>, trusted: Set<string>): Set<string> {
  const levels = new Set<string>();
  if (untrusted.has(nodeId)) levels.add("untrusted_external");
  if (semi.has(nodeId)) levels.add("semi_trusted_external");
  if (trusted.has(nodeId)) levels.add("trusted_internal");
  return levels;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function trustLabel(levels: Set<string>): string {
  if (levels.size === 0) return "none";
  return [...levels].sort(pyCompare).join("+");
}

/**
 * Propagate taint from untrusted entrypoints through calls.
 *
 * Marks all reachable nodes as tainted and annotates each with the
 * entrypoint source that taints it.
 */
function propagateTaint(store: GraphStore): JsonObject {
  const graph = store.graph;
  const taintedAll = new Set<string>();
  const taintSources = new Map<string, string[]>();

  for (const [epId, tag] of graph.entrypoints) {
    if (tag.trustLevel === "trusted_internal") continue;
    const reachable = store.reachableFrom(epId);
    reachable.add(epId);
    for (const nodeId of reachable) {
      taintedAll.add(nodeId);
      let list = taintSources.get(nodeId);
      if (list === undefined) {
        list = [];
        taintSources.set(nodeId, list);
      }
      list.push(epId);
    }
  }

  for (const [nodeId, sources] of taintSources) {
    const unique = [...new Set(sources)].sort(pyCompare);
    graph.addAnnotation(nodeId, {
      kind: "taint_propagation",
      description: `tainted via: ${unique.join(", ")}`,
      source: PREANALYSIS_SOURCE,
    });
  }

  store.addSubgraph("tainted", taintedAll);
  let taintSourceCount = 0;
  for (const tag of graph.entrypoints.values()) if (tag.trustLevel !== "trusted_internal") taintSourceCount += 1;
  return { tainted_nodes: taintedAll.size, taint_sources: taintSourceCount };
}
