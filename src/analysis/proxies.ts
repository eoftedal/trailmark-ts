/** Normalize unresolved graph references into explicit proxy nodes. */

import { codeEdge, type CodeEdge } from "../models/edges.js";
import type { CodeGraph } from "../models/graph.js";
import { codeUnit, sourceLocation, type CodeUnit, type SourceLocation, type TypeRef } from "../models/nodes.js";
import { rsplitLast } from "../parsers/common.js";

const PROXY_MODULE = "proxy";
const PROXY_FILE = "<proxy>";

/** Create concrete proxy nodes for unresolved references. Mutates and returns ``graph``. */
export function ensureProxyNodes(graph: CodeGraph): CodeGraph {
  materializeUnresolvedCalls(graph);
  materializeTypeUseEdges(graph);
  return graph;
}

function materializeUnresolvedCalls(graph: CodeGraph): void {
  const newEdges: CodeEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "calls" || graph.nodes.has(edge.targetId)) {
      newEdges.push(edge);
      continue;
    }
    const proxyId = proxyIdFor("unresolved", edge.targetId);
    addProxyNode(graph, proxyId, edge.targetId, "unresolved", edge.location);
    newEdges.push({
      ...edge,
      targetId: proxyId,
      attributes: [...edge.attributes, ["raw_target", edge.targetId]],
    });
  }
  graph.edges = newEdges;
}

function materializeTypeUseEdges(graph: CodeGraph): void {
  const key = (s: string, t: string) => `${s}\u0000${t}`;
  const existing = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "type_uses") existing.add(key(edge.sourceId, edge.targetId));
  }
  const index = typeIndex(graph);
  const newEdges: CodeEdge[] = [];
  for (const unit of graph.nodes.values()) {
    for (const ref of iterUnitTypes(unit)) {
      const targetId = resolveTypeRef(ref, index);
      if (targetId === null) continue;
      const k = key(unit.id, targetId);
      if (existing.has(k)) continue;
      existing.add(k);
      newEdges.push(
        codeEdge({
          sourceId: unit.id,
          targetId,
          kind: "type_uses",
          attributes: [["type_name", ref.name]],
        }),
      );
    }
  }
  graph.edges.push(...newEdges);
}

function addProxyNode(
  graph: CodeGraph,
  proxyId: string,
  rawSymbol: string,
  proxyKind: string,
  location: SourceLocation | null,
): void {
  if (graph.nodes.has(proxyId)) return;
  graph.nodes.set(
    proxyId,
    codeUnit({
      id: proxyId,
      name: rawSymbol,
      kind: "proxy",
      location: location ?? sourceLocation(graph.rootPath || PROXY_FILE, 0, 0),
      origin: "proxy",
      attributes: [
        ["raw_symbol", rawSymbol],
        ["proxy_kind", proxyKind],
      ],
    }),
  );
}

export function proxyIdFor(kind: string, rawSymbol: string): string {
  return `${PROXY_MODULE}.${kind}:${escapeProxySymbol(rawSymbol)}`;
}

export function escapeProxySymbol(rawSymbol: string): string {
  let text = rawSymbol.trim() || "unknown";
  text = text.replace(/\s+/g, "_");
  return text.replace(/[^0-9A-Za-z_.@$:-]+/g, "_");
}

/**
 * Map every lookup key (id, name, ``:``-suffix, ``.``-suffix) to a node ID, or
 * ``null`` when the key is ambiguous.
 */
function typeIndex(graph: CodeGraph): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const [nodeId, node] of graph.nodes) {
    const keys = new Set([nodeId, node.name, rsplitLast(nodeId, ":"), rsplitLast(nodeId, ".")]);
    for (const k of keys) {
      if (index.has(k)) {
        const existing = index.get(k);
        if (existing === null) continue;
        if (existing !== nodeId) index.set(k, null);
      } else {
        index.set(k, nodeId);
      }
    }
  }
  return index;
}

function resolveTypeRef(ref: TypeRef, index: Map<string, string | null>): string | null {
  const candidates = [ref.name];
  if (ref.module) candidates.unshift(`${ref.module}:${ref.name}`, `${ref.module}.${ref.name}`);
  for (const c of candidates) {
    const target = index.get(c);
    if (target !== undefined && target !== null) return target;
  }
  return null;
}

/** Every type reference a unit mentions (params, return, exceptions, generic bounds), flattened. */
export function iterUnitTypes(unit: CodeUnit): TypeRef[] {
  const refs: TypeRef[] = [];
  for (const p of unit.parameters) if (p.typeRef !== null) refs.push(...flattenTypeRef(p.typeRef));
  if (unit.returnType !== null) refs.push(...flattenTypeRef(unit.returnType));
  for (const exc of unit.exceptionTypes) refs.push(...flattenTypeRef(exc));
  for (const tp of unit.typeParameters) {
    for (const c of tp.constraints) refs.push(...flattenTypeRef(c));
    if (tp.default !== null) refs.push(...flattenTypeRef(tp.default));
  }
  return refs;
}

export function flattenTypeRef(ref: TypeRef): TypeRef[] {
  const out = [ref];
  for (const arg of ref.genericArgs) out.push(...flattenTypeRef(arg));
  return out;
}
