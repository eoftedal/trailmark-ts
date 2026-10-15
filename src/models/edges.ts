/** Edge types for the code graph. */

import type { Attribute, SourceLocation } from "./nodes.js";

export const EDGE_KINDS = [
  "calls",
  "inherits",
  "contains",
  "imports",
  "implements",
  "resolves_to",
  "type_uses",
  "specializes",
  "corresponds_to",
] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export const EDGE_CONFIDENCES = ["certain", "inferred", "uncertain"] as const;
export type EdgeConfidence = (typeof EDGE_CONFIDENCES)[number];

/** A directed edge in the code graph. */
export interface CodeEdge {
  readonly sourceId: string;
  readonly targetId: string;
  readonly kind: EdgeKind;
  readonly confidence: EdgeConfidence;
  readonly location: SourceLocation | null;
  readonly attributes: readonly Attribute[];
}

export function codeEdge(init: {
  sourceId: string;
  targetId: string;
  kind: EdgeKind;
  confidence?: EdgeConfidence;
  location?: SourceLocation | null;
  attributes?: readonly Attribute[];
}): CodeEdge {
  return {
    sourceId: init.sourceId,
    targetId: init.targetId,
    kind: init.kind,
    confidence: init.confidence ?? "certain",
    location: init.location ?? null,
    attributes: init.attributes ?? [],
  };
}

/** Structural equality, matching dataclass ``__eq__``. */
export function edgesEqual(a: CodeEdge, b: CodeEdge): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
