/**
 * Carry annotations from a previous analysis of a project into a fresh one.
 *
 * Not in upstream trailmark. Re-parsing produces a graph without the
 * annotations people (or tools) added, so without this every re-analysis
 * would silently discard audit notes, assumptions and findings.
 *
 * Annotations are keyed by node ID, which is stable across re-parses as long
 * as the function/class keeps its module and name. Annotations whose node no
 * longer exists are kept anyway (they reattach if the node comes back) and
 * reported as orphaned so callers can surface them.
 */

import type { Annotation } from "../models/annotations.js";
import type { CodeGraph } from "../models/graph.js";

/** Annotation sources that are recomputed by analysis passes rather than authored. */
export const DERIVED_ANNOTATION_SOURCES: ReadonlySet<string> = new Set(["preanalysis"]);

export interface CarryOverResult {
  /** Annotations attached to nodes that exist in the new graph. */
  carried: number;
  /** Annotations kept for node IDs that no longer exist, by node ID. */
  orphaned: Map<string, Annotation[]>;
}

export function carryOverAnnotations(
  previous: CodeGraph,
  next: CodeGraph,
  options: { skipSources?: ReadonlySet<string> } = {},
): CarryOverResult {
  const skip = options.skipSources ?? DERIVED_ANNOTATION_SOURCES;
  const result: CarryOverResult = { carried: 0, orphaned: new Map() };
  for (const [nodeId, annotations] of previous.annotations) {
    const existing = next.annotations.get(nodeId) ?? [];
    for (const ann of annotations) {
      if (skip.has(ann.source)) continue;
      if (existing.some((e) => e.kind === ann.kind && e.description === ann.description && e.source === ann.source)) {
        continue;
      }
      next.addAnnotation(nodeId, ann);
      if (next.nodes.has(nodeId)) {
        result.carried++;
      } else {
        const list = result.orphaned.get(nodeId);
        if (list === undefined) result.orphaned.set(nodeId, [ann]);
        else list.push(ann);
      }
    }
  }
  return result;
}
