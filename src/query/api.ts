/** High-level query API for Trailmark code graphs (port of ``query/api.py``). */

import { augmentFromSarif, augmentFromWeaudit } from "../analysis/augment.js";
import { augmentFromBinaryGraph } from "../analysis/binary.js";
import { computeDiff } from "../analysis/diff.js";
import { detectEntrypoints } from "../analysis/entrypoints.js";
import { runPreanalysis } from "../analysis/preanalysis.js";
import { ensureProxyNodes, flattenTypeRef } from "../analysis/proxies.js";
import type { FileSource } from "../fs/source.js";
import { pyCompare } from "../fs/source.js";
import type { AnnotationKind } from "../models/annotations.js";
import { EDGE_KINDS, type EdgeKind } from "../models/edges.js";
import type { CodeGraph } from "../models/graph.js";
import type { CodeUnit, TypeRef } from "../models/nodes.js";
import { parseDirectory, type ParseOptions } from "../parse.js";
import { GraphStore } from "../storage/graph-store.js";
import { pyJsonDumps } from "../util/py.js";
import {
  annotationToDict,
  attributesToDict,
  edgeToDict,
  typeParameterToDict,
  typeRefToDict,
  unitToDict,
  type JsonObject,
} from "./dicts.js";

export interface FromSourceOptions extends ParseOptions {
  /** Directory to parse, inside ``source`` (default ``source.root``). */
  dir?: string;
  /** Language spec: a name, ``"auto"``, or a comma-separated list. Default ``"python"``. */
  language?: string;
  /** Run entrypoint detection (default true). */
  detectEntrypoints?: boolean;
}

export class QueryEngine {
  constructor(readonly store: GraphStore) {}

  /** The underlying (mutable) graph. */
  get graph(): CodeGraph {
    return this.store.graph;
  }

  /** Parse a directory and return a ready-to-query engine. */
  static async fromSource(source: FileSource, options: FromSourceOptions = {}): Promise<QueryEngine> {
    const graph = await parseDirectory(source, options.language ?? "python", options);
    if (options.detectEntrypoints ?? true) {
      const dir = options.dir ?? source.root;
      for (const [id, tag] of await detectEntrypoints(graph, source, dir)) graph.entrypoints.set(id, tag);
    }
    return new QueryEngine(new GraphStore(graph));
  }

  /** Create an engine from a pre-built CodeGraph. */
  static fromGraph(graph: CodeGraph): QueryEngine {
    return new QueryEngine(new GraphStore(ensureProxyNodes(graph)));
  }

  /** Structured diff of ``this`` (after) relative to ``other`` (before). */
  diffAgainst(other: QueryEngine): JsonObject {
    return computeDiff(other.graph, this.graph);
  }

  callersOf(name: string): JsonObject[] {
    const id = this.store.findNodeId(name);
    return id === null ? [] : this.store.callersOf(id).map(unitToDict);
  }

  calleesOf(name: string): JsonObject[] {
    const id = this.store.findNodeId(name);
    return id === null ? [] : this.store.calleesOf(id).map(unitToDict);
  }

  /** Every function/method that can transitively reach ``name`` (upward slice). */
  ancestorsOf(name: string): JsonObject[] {
    const id = this.store.findNodeId(name);
    if (id === null) return [];
    return this.unitsFor(this.store.ancestorsOf(id));
  }

  /** Every function/method transitively reachable from ``name``. */
  reachableFrom(name: string): JsonObject[] {
    const id = this.store.findNodeId(name);
    if (id === null) return [];
    return this.unitsFor(this.store.reachableFrom(id));
  }

  private unitsFor(ids: Iterable<string>): JsonObject[] {
    const out: JsonObject[] = [];
    for (const id of ids) {
      const unit = this.graph.nodes.get(id);
      if (unit !== undefined) out.push(unitToDict(unit));
    }
    return out;
  }

  pathsBetween(src: string, dst: string): string[][] {
    const s = this.store.findNodeId(src);
    const d = this.store.findNodeId(dst);
    if (s === null || d === null) return [];
    return this.store.pathsBetween(s, d);
  }

  connectSubgraphs(
    source: string,
    target: string,
    options: { maxDepth?: number; edgeKinds?: readonly (EdgeKind | string)[] } = {},
  ): string[][] {
    return this.store.connectSubgraphs(
      source,
      target,
      options.maxDepth ?? 20,
      coerceEdgeKinds(options.edgeKinds ?? ["calls"]),
    );
  }

  /** Call paths from any detected entrypoint to ``name``. */
  entrypointPathsTo(name: string, maxDepth = 20): string[][] {
    const id = this.store.findNodeId(name);
    return id === null ? [] : this.store.entrypointPathsTo(id, maxDepth);
  }

  nodesWithAnnotation(kind: AnnotationKind): JsonObject[] {
    return this.store.nodesWithAnnotation(kind).map(unitToDict);
  }

  /** Functions whose parser-detected exception list includes ``exceptionName``. */
  functionsThatRaise(exceptionName: string): JsonObject[] {
    const out: JsonObject[] = [];
    for (const unit of this.graph.nodes.values()) {
      if (unit.exceptionTypes.some((e) => e.name === exceptionName)) out.push(unitToDict(unit));
    }
    return out;
  }

  /** All entrypoints with trust level, kind, asset value and node attributes. */
  attackSurface(): JsonObject[] {
    return this.store.allEntrypoints().map(([nodeId, tag]) => {
      const item: JsonObject = {
        node_id: nodeId,
        trust_level: tag.trustLevel,
        kind: tag.kind,
        asset_value: tag.assetValue,
        description: tag.description,
      };
      const unit = this.store.unit(nodeId);
      if (unit !== undefined && unit.attributes.length > 0) item["attributes"] = attributesToDict(unit.attributes);
      return item;
    });
  }

  /** Functions with cyclomatic complexity >= threshold, most complex first. */
  complexityHotspots(threshold = 10): JsonObject[] {
    return sortByComplexity(this.store.nodesByComplexity(threshold)).map(unitToDict);
  }

  annotate(name: string, kind: AnnotationKind, description: string, source = "manual"): boolean {
    const id = this.store.findNodeId(name);
    if (id === null) return false;
    return this.store.addAnnotation(id, { kind, description, source });
  }

  annotationsOf(name: string, kind: AnnotationKind | null = null): JsonObject[] {
    const id = this.store.findNodeId(name);
    if (id === null) return [];
    let anns = this.store.annotationsFor(id);
    if (kind !== null) anns = anns.filter((a) => a.kind === kind);
    return anns.map(annotationToDict);
  }

  clearAnnotations(name: string, kind: AnnotationKind | null = null): boolean {
    const id = this.store.findNodeId(name);
    if (id === null) return false;
    return this.store.clearAnnotations(id, kind);
  }

  summary(): JsonObject {
    const nodes = [...this.graph.nodes.values()];
    return {
      total_nodes: nodes.length,
      functions: nodes.filter((n) => n.kind === "function" || n.kind === "method").length,
      classes: nodes.filter((n) => n.kind === "class").length,
      proxies: nodes.filter((n) => n.kind === "proxy").length,
      call_edges: this.graph.edges.filter((e) => e.kind === "calls").length,
      dependencies: this.graph.dependencies,
      entrypoints: this.graph.entrypoints.size,
    };
  }

  /** Run the pre-analysis passes; results are stored as annotations and subgraphs. */
  preanalysis(): JsonObject {
    return runPreanalysis(this.store);
  }

  /** Merge SARIF findings (JSON text or parsed object) into the graph. */
  augmentSarif(sarif: string | unknown): JsonObject {
    return augmentFromSarif(this.store, typeof sarif === "string" ? JSON.parse(sarif) : sarif);
  }

  /** Merge weAudit findings (JSON text or parsed object) into the graph. */
  augmentWeaudit(weaudit: string | unknown): JsonObject {
    return augmentFromWeaudit(this.store, typeof weaudit === "string" ? JSON.parse(weaudit) : weaudit);
  }

  /** Import an external binary-analysis graph (JSON text or parsed object). */
  augmentBinary(graph: string | unknown, options: { graphPath?: string; connectSources?: boolean } = {}): JsonObject {
    return augmentFromBinaryGraph(this.store, typeof graph === "string" ? JSON.parse(graph) : graph, {
      graphPath: options.graphPath ?? "",
      connectSources: options.connectSources ?? true,
    });
  }

  /** Nodes with finding/audit_note annotations (or only ``kind``). */
  findings(kind: AnnotationKind | null = null): JsonObject[] {
    const kinds = new Set<AnnotationKind>(kind === null ? ["finding", "audit_note"] : [kind]);
    const out: JsonObject[] = [];
    for (const [nodeId, anns] of this.graph.annotations) {
      const matching = anns.filter((a) => kinds.has(a.kind));
      if (matching.length === 0) continue;
      const node = this.graph.nodes.get(nodeId);
      if (node === undefined) continue;
      const entry = unitToDict(node);
      entry["findings"] = matching.map(annotationToDict);
      out.push(entry);
    }
    return out;
  }

  subgraph(name: string): JsonObject[] {
    return [...this.store.subgraph(name)].sort(pyCompare).flatMap((id) => {
      const unit = this.graph.nodes.get(id);
      return unit === undefined ? [] : [unitToDict(unit)];
    });
  }

  subgraphEdges(name: string, options: { edgeKinds?: readonly (EdgeKind | string)[] } = {}): JsonObject[] {
    const kinds = options.edgeKinds === undefined ? null : coerceEdgeKinds(options.edgeKinds);
    return this.store.subgraphEdges(name, kinds).map(edgeToDict);
  }

  subgraphNames(): string[] {
    return [...this.store.allSubgraphs().keys()].sort(pyCompare);
  }

  genericParameters(name: string): JsonObject[] {
    const unit = this.lookup(name);
    return unit === undefined ? [] : unit.typeParameters.map(typeParameterToDict);
  }

  typeReferences(name: string): JsonObject[] {
    const unit = this.lookup(name);
    return unit === undefined ? [] : unitTypeRefs(unit).map(typeRefToDict);
  }

  private lookup(name: string): CodeUnit | undefined {
    const id = this.store.findNodeId(name);
    return id === null ? undefined : this.graph.nodes.get(id);
  }

  /** The upstream-compatible JSON export object. */
  toDict(): JsonObject {
    const g = this.graph;
    const nodes: JsonObject = {};
    for (const [id, node] of g.nodes) nodes[id] = unitToDict(node);
    const subgraphs: JsonObject = {};
    for (const [name, ids] of g.subgraphs) subgraphs[name] = [...ids].sort(pyCompare);
    return {
      language: g.language,
      root_path: g.rootPath,
      summary: this.summary(),
      nodes,
      edges: g.edges.map(edgeToDict),
      subgraphs,
    };
  }

  /** Serialize the full graph to JSON, byte-compatible with upstream ``to_json``. */
  toJson(indent = 2): string {
    return pyJsonDumps(this.toDict(), indent);
  }
}

function coerceEdgeKinds(values: readonly (EdgeKind | string)[]): Set<EdgeKind> {
  for (const v of values) {
    if (!(EDGE_KINDS as readonly string[]).includes(v)) throw new Error(`'${v}' is not a valid EdgeKind`);
  }
  return new Set(values as EdgeKind[]);
}

function unitTypeRefs(unit: CodeUnit): TypeRef[] {
  const refs: TypeRef[] = [];
  for (const p of unit.parameters) if (p.typeRef !== null) refs.push(...flattenTypeRef(p.typeRef));
  if (unit.returnType !== null) refs.push(...flattenTypeRef(unit.returnType));
  for (const e of unit.exceptionTypes) refs.push(...flattenTypeRef(e));
  for (const tp of unit.typeParameters) {
    for (const c of tp.constraints) refs.push(...flattenTypeRef(c));
    if (tp.default !== null) refs.push(...flattenTypeRef(tp.default));
  }
  return refs;
}

function sortByComplexity(nodes: CodeUnit[]): CodeUnit[] {
  // Python's sorted(reverse=True) is stable: equal keys keep their original order.
  return nodes
    .map((n, i) => [n, i] as const)
    .sort((a, b) => (b[0].cyclomaticComplexity ?? 0) - (a[0].cyclomaticComplexity ?? 0) || a[1] - b[1])
    .map(([n]) => n);
}
