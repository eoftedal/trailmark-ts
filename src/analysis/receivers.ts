/**
 * Resolve ``receiver.method()`` calls using receiver types recorded by parsers.
 *
 * Not in upstream trailmark (skipped when ``upstreamCompat`` is set). Parsers
 * attach ``receiver_type`` (a simple type name) to call edges whose receiver
 * type they could infer. After all files are merged, this pass maps the type
 * name to a class-like node and rewrites the edge to the method on that type
 * or the nearest supertype that declares it. Rewritten edges keep their
 * confidence and gain ``raw_target`` (the original call text, as on unresolved
 * proxies) and ``resolved_by = receiver_type``; anything ambiguous is
 * left untouched (and later becomes an unresolved proxy, as upstream).
 */

import type { CodeEdge } from "../models/edges.js";
import type { CodeGraph } from "../models/graph.js";
import type { NodeKind } from "../models/nodes.js";
import { rsplitLast } from "../parsers/common.js";

export const RECEIVER_TYPE_ATTR = "receiver_type";
export const RESOLVED_BY_ATTR = "resolved_by";

const TYPE_KINDS: ReadonlySet<NodeKind> = new Set([
  "class",
  "interface",
  "enum",
  "struct",
  "trait",
  "contract",
  "library",
]);

function moduleOf(nodeId: string): string {
  const at = nodeId.indexOf(":");
  return at < 0 ? nodeId : nodeId.slice(0, at);
}

function packageOf(moduleId: string): string {
  const at = moduleId.lastIndexOf(".");
  return at < 0 ? "" : moduleId.slice(0, at);
}

export function resolveReceiverTypes(graph: CodeGraph): void {
  // Index by simple name and by (partial) type path within the module (``Outer.Inner`` for nested types).
  const typesByName = new Map<string, string[]>();
  const add = (key: string, id: string) => {
    const list = typesByName.get(key);
    if (list === undefined) typesByName.set(key, [id]);
    else if (!list.includes(id)) list.push(id);
  };
  for (const [id, unit] of graph.nodes) {
    if (!TYPE_KINDS.has(unit.kind)) continue;
    add(unit.name, id);
    // Every trailing part of the in-module path, so ``Inner.Deep`` finds ``Outer.Inner.Deep``.
    const parts = id.slice(id.indexOf(":") + 1).split(".");
    for (let i = 0; i < parts.length - 1; i++) add(parts.slice(i).join("."), id);
  }
  if (typesByName.size === 0) return;

  const supertypes = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "inherits" && edge.kind !== "implements") continue;
    const list = supertypes.get(edge.sourceId);
    if (list === undefined) supertypes.set(edge.sourceId, [edge.targetId]);
    else list.push(edge.targetId);
  }

  /** Pick the type named ``name`` as seen from ``fromId``: unique, else same module, else same package. */
  const resolveType = (name: string, fromId: string): string | null => {
    const candidates = typesByName.get(name);
    if (candidates === undefined) return null;
    if (candidates.length === 1) return candidates[0]!;
    const module = moduleOf(fromId);
    const sameModule = candidates.filter((c) => moduleOf(c) === module);
    if (sameModule.length === 1) return sameModule[0]!;
    const pkg = packageOf(module);
    const samePackage = candidates.filter((c) => packageOf(moduleOf(c)) === pkg);
    return samePackage.length === 1 ? samePackage[0]! : null;
  };

  /** Breadth-first over the type and its supertypes for a member named ``method``. */
  const findMethod = (typeId: string, method: string): string | null => {
    const queue = [typeId];
    const seen = new Set(queue);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const candidate = `${current}.${method}`;
      const unit = graph.nodes.get(candidate);
      if (unit !== undefined && (unit.kind === "method" || unit.kind === "function")) return candidate;
      for (const sup of supertypes.get(current) ?? []) {
        // Parsers point supertypes at ``<own module>:<Name>``; follow it across files by name.
        const supId = graph.nodes.has(sup) ? sup : resolveType(rsplitLast(rsplitLast(sup, ":"), "."), current);
        if (supId !== null && !seen.has(supId)) {
          seen.add(supId);
          queue.push(supId);
        }
      }
    }
    return null;
  };

  graph.edges = graph.edges.map((edge): CodeEdge => {
    if (edge.kind !== "calls" || graph.nodes.has(edge.targetId)) return edge;
    const typeName = edge.attributes.find(([k]) => k === RECEIVER_TYPE_ATTR)?.[1];
    if (typeof typeName !== "string") return edge;
    const typeId = resolveType(typeName, edge.sourceId);
    if (typeId === null) return edge;
    const target = findMethod(typeId, rsplitLast(edge.targetId, "."));
    if (target === null) return edge;
    return {
      ...edge,
      targetId: target,
      attributes: [...edge.attributes, ["raw_target", edge.targetId], [RESOLVED_BY_ATTR, "receiver_type"]],
    };
  });
}
