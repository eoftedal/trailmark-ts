/** Annotations, entrypoint tags, and asset values for the code graph. */

export const ANNOTATION_KINDS = [
  "assumption",
  "precondition",
  "postcondition",
  "invariant",
  "blast_radius",
  "privilege_boundary",
  "taint_propagation",
  "finding",
  "audit_note",
] as const;
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number];

/** A semantic annotation attached to a code unit. */
export interface Annotation {
  readonly kind: AnnotationKind;
  readonly description: string;
  readonly source: string;
}

export const ASSET_VALUES = ["high", "medium", "low"] as const;
export type AssetValue = (typeof ASSET_VALUES)[number];

export const TRUST_LEVELS = ["untrusted_external", "semi_trusted_external", "trusted_internal"] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export const ENTRYPOINT_KINDS = ["user_input", "api", "database", "file_system", "third_party"] as const;
export type EntrypointKind = (typeof ENTRYPOINT_KINDS)[number];

/** Tags a code unit as an entrypoint for external data. */
export interface EntrypointTag {
  readonly kind: EntrypointKind;
  readonly trustLevel: TrustLevel;
  readonly description: string | null;
  readonly assetValue: AssetValue;
}

export function entrypointTag(
  kind: EntrypointKind,
  opts: { trustLevel?: TrustLevel; description?: string | null; assetValue?: AssetValue } = {},
): EntrypointTag {
  return {
    kind,
    trustLevel: opts.trustLevel ?? "untrusted_external",
    description: opts.description ?? null,
    assetValue: opts.assetValue ?? "low",
  };
}
