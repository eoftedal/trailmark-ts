/**
 * Indexed in-memory graph store (replaces upstream's rustworkx ``PyDiGraph``).
 *
 * Traversal order mirrors rustworkx/petgraph: neighbors are visited in reverse
 * edge-insertion order, and parallel edges yield duplicate simple paths.
 */

import type { Annotation, AnnotationKind, EntrypointTag } from "../models/annotations.js";
import type { CodeEdge, EdgeKind } from "../models/edges.js";
import type { CodeGraph } from "../models/graph.js";
import type { CodeUnit } from "../models/nodes.js";
import { pyCompare } from "../fs/source.js";

const CALL_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set(["calls"]);

interface Projection {
  /** node id → outgoing edges (insertion order). */
  out: Map<string, CodeEdge[]>;
  /** node id → incoming edges (insertion order). */
  in: Map<string, CodeEdge[]>;
}

function kindsKey(kinds: ReadonlySet<EdgeKind>): string {
  return [...kinds].sort().join(",");
}

export class GraphStore {
  private full!: Projection;
  private projectionCache = new Map<string, Projection>();

  constructor(readonly graph: CodeGraph) {
    this.rebuildIndex();
  }

  /** Rebuild indexes after graph nodes or edges change. */
  rebuildIndex(): void {
    this.projectionCache = new Map();
    this.full = this.buildProjection(null);
  }

  private buildProjection(kinds: ReadonlySet<EdgeKind> | null): Projection {
    const out = new Map<string, CodeEdge[]>();
    const inn = new Map<string, CodeEdge[]>();
    for (const id of this.graph.nodes.keys()) {
      out.set(id, []);
      inn.set(id, []);
    }
    for (const edge of this.graph.edges) {
      if (kinds !== null && !kinds.has(edge.kind)) continue;
      const o = out.get(edge.sourceId);
      const i = inn.get(edge.targetId);
      if (o === undefined || i === undefined) continue;
      o.push(edge);
      i.push(edge);
    }
    return { out, in: inn };
  }

  private projectionFor(kinds: ReadonlySet<EdgeKind> | null | undefined): Projection {
    const key = kindsKey(kinds ?? CALL_EDGE_KINDS);
    let p = this.projectionCache.get(key);
    if (p === undefined) {
      p = this.buildProjection(kinds ?? CALL_EDGE_KINDS);
      this.projectionCache.set(key, p);
    }
    return p;
  }

  unit(nodeId: string): CodeUnit | undefined {
    return this.graph.nodes.get(nodeId);
  }

  /** Unique neighbor ids in reverse edge-insertion order (petgraph semantics). */
  private neighbors(edges: readonly CodeEdge[], pick: (e: CodeEdge) => string): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (let i = edges.length - 1; i >= 0; i--) {
      const id = pick(edges[i]!);
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  /** All nodes that call the given node. */
  callersOf(nodeId: string): CodeUnit[] {
    const incoming = this.full.in.get(nodeId);
    if (incoming === undefined) return [];
    return this.neighbors(incoming, (e) => e.sourceId)
      .filter((src) => incoming.some((e) => e.sourceId === src && e.kind === "calls"))
      .flatMap((id) => this.unit(id) ?? []);
  }

  /** All nodes called by the given node. */
  calleesOf(nodeId: string): CodeUnit[] {
    const outgoing = this.full.out.get(nodeId);
    if (outgoing === undefined) return [];
    return this.neighbors(outgoing, (e) => e.targetId)
      .filter((tgt) => outgoing.some((e) => e.targetId === tgt && e.kind === "calls"))
      .flatMap((id) => this.unit(id) ?? []);
  }

  /**
   * All simple paths from ``srcId`` to ``dstId`` with at most ``maxDepth`` nodes,
   * over CALLS edges by default.
   */
  pathsBetween(srcId: string, dstId: string, maxDepth = 20, edgeKinds?: ReadonlySet<EdgeKind> | null): string[][] {
    const proj = this.projectionFor(edgeKinds);
    if (!proj.out.has(srcId) || !proj.out.has(dstId) || srcId === dstId) return [];
    const paths: string[][] = [];
    const path = [srcId];
    const onPath = new Set([srcId]);
    // Iterative DFS: each frame holds the outgoing edges still to try (reversed).
    const stack: CodeEdge[][] = [[...proj.out.get(srcId)!].reverse()];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const edge = frame.shift();
      if (edge === undefined) {
        stack.pop();
        onPath.delete(path.pop()!);
        continue;
      }
      const next = edge.targetId;
      if (onPath.has(next)) continue;
      if (next === dstId) {
        if (path.length + 1 <= maxDepth) paths.push([...path, next]);
        continue;
      }
      if (path.length + 1 >= maxDepth) continue;
      path.push(next);
      onPath.add(next);
      stack.push([...proj.out.get(next)!].reverse());
    }
    return paths;
  }

  /** Node ids reachable from ``nodeId`` (excluding itself unless on a cycle), CALLS by default. */
  reachableFrom(nodeId: string, edgeKinds?: ReadonlySet<EdgeKind> | null): Set<string> {
    return this.bfs(nodeId, this.projectionFor(edgeKinds).out, (e) => e.targetId);
  }

  /** Node ids that can reach ``nodeId``, CALLS by default. */
  ancestorsOf(nodeId: string, edgeKinds?: ReadonlySet<EdgeKind> | null): Set<string> {
    return this.bfs(nodeId, this.projectionFor(edgeKinds).in, (e) => e.sourceId);
  }

  private bfs(start: string, adj: Map<string, CodeEdge[]>, pick: (e: CodeEdge) => string): Set<string> {
    const result = new Set<string>();
    if (!adj.has(start)) return result;
    const queue = [start];
    const visited = new Set([start]);
    while (queue.length > 0) {
      const id = queue.shift()!;
      for (const e of adj.get(id) ?? []) {
        const n = pick(e);
        if (!visited.has(n)) {
          visited.add(n);
          result.add(n);
          queue.push(n);
        }
      }
    }
    // rustworkx.descendants/ancestors never include the start node itself.
    result.delete(start);
    return result;
  }

  nodesWithAnnotation(kind: AnnotationKind): CodeUnit[] {
    const result: CodeUnit[] = [];
    for (const [nodeId, anns] of this.graph.annotations) {
      if (anns.some((a) => a.kind === kind)) {
        const node = this.unit(nodeId);
        if (node !== undefined) result.push(node);
      }
    }
    return result;
  }

  allEntrypoints(): [string, EntrypointTag][] {
    return [...this.graph.entrypoints];
  }

  entrypointPathsTo(nodeId: string, maxDepth = 20, edgeKinds?: ReadonlySet<EdgeKind> | null): string[][] {
    const all: string[][] = [];
    for (const epId of this.graph.entrypoints.keys()) all.push(...this.pathsBetween(epId, nodeId, maxDepth, edgeKinds));
    return all;
  }

  nodesByComplexity(minComplexity: number): CodeUnit[] {
    return [...this.graph.nodes.values()].filter(
      (n) => n.cyclomaticComplexity !== null && n.cyclomaticComplexity >= minComplexity,
    );
  }

  /** Add an annotation to an existing node. Returns false if the node does not exist. */
  addAnnotation(nodeId: string, annotation: Annotation): boolean {
    if (!this.graph.nodes.has(nodeId)) return false;
    this.graph.addAnnotation(nodeId, annotation);
    return true;
  }

  annotationsFor(nodeId: string): Annotation[] {
    return [...(this.graph.annotations.get(nodeId) ?? [])];
  }

  clearAnnotations(nodeId: string, kind: AnnotationKind | null = null): boolean {
    if (!this.graph.nodes.has(nodeId)) return false;
    this.graph.clearAnnotations(nodeId, kind);
    return true;
  }

  /**
   * Find a node by exact ID, then the first node whose name matches or whose ID
   * ends with ``:name`` or ``.name``.
   */
  findNode(name: string): CodeUnit | undefined {
    const exact = this.graph.nodes.get(name);
    if (exact !== undefined) return exact;
    for (const [nodeId, node] of this.graph.nodes) {
      if (node.name === name || nodeId.endsWith(`:${name}`) || nodeId.endsWith(`.${name}`)) return node;
    }
    return undefined;
  }

  findNodeId(name: string): string | null {
    return this.findNode(name)?.id ?? null;
  }

  addSubgraph(name: string, nodeIds: Set<string>): void {
    this.graph.subgraphs.set(name, nodeIds);
  }

  subgraph(name: string): Set<string> {
    return this.graph.subgraphs.get(name) ?? new Set();
  }

  allSubgraphs(): Map<string, Set<string>> {
    return new Map(this.graph.subgraphs);
  }

  /** Induced edges whose endpoints are both in the named subgraph. */
  subgraphEdges(name: string, edgeKinds: ReadonlySet<EdgeKind> | null = null): CodeEdge[] {
    const ids = this.subgraph(name);
    if (ids.size === 0) return [];
    return this.graph.edges.filter(
      (e) => ids.has(e.sourceId) && ids.has(e.targetId) && (edgeKinds === null || edgeKinds.has(e.kind)),
    );
  }

  /** Paths connecting any node in one subgraph to any node in another. */
  connectSubgraphs(
    source: string,
    target: string,
    maxDepth = 20,
    edgeKinds?: ReadonlySet<EdgeKind> | null,
  ): string[][] {
    const sourceIds = this.subgraph(source);
    const targetIds = this.subgraph(target);
    if (sourceIds.size === 0 || targetIds.size === 0) return [];
    const paths: string[][] = [];
    const seen = new Set<string>();
    const sortedTargets = [...targetIds].sort(pyCompare);
    for (const srcId of [...sourceIds].sort(pyCompare)) {
      if (targetIds.has(srcId)) {
        const key = JSON.stringify([srcId]);
        if (!seen.has(key)) {
          seen.add(key);
          paths.push([srcId]);
        }
      }
      for (const dstId of sortedTargets) {
        if (srcId === dstId) continue;
        for (const path of this.pathsBetween(srcId, dstId, maxDepth, edgeKinds)) {
          const key = JSON.stringify(path);
          if (!seen.has(key)) {
            seen.add(key);
            paths.push(path);
          }
        }
      }
    }
    return paths;
  }
}
