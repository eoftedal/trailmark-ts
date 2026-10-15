/**
 * Conversions to upstream's JSON-serializable dict shapes (snake_case keys,
 * dataclass field order) so exported JSON matches Python trailmark exactly.
 */

import type { Annotation } from "../models/annotations.js";
import type { CodeEdge } from "../models/edges.js";
import type {
  Attribute,
  AttributeValue,
  BranchInfo,
  CodeUnit,
  Parameter,
  SourceLocation,
  TypeParameter,
  TypeRef,
} from "../models/nodes.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export function locationToDict(loc: SourceLocation): JsonObject {
  return {
    file_path: loc.filePath,
    start_line: loc.startLine,
    end_line: loc.endLine,
    start_col: loc.startCol,
    end_col: loc.endCol,
  };
}

export function typeRefToDict(ref: TypeRef): JsonObject {
  return { name: ref.name, module: ref.module, generic_args: ref.genericArgs.map(typeRefToDict) };
}

export function typeParameterToDict(tp: TypeParameter): JsonObject {
  return {
    name: tp.name,
    constraints: tp.constraints.map(typeRefToDict),
    default: tp.default === null ? null : typeRefToDict(tp.default),
    variance: tp.variance,
  };
}

function parameterToDict(p: Parameter): JsonObject {
  return { name: p.name, type_ref: p.typeRef === null ? null : typeRefToDict(p.typeRef), default: p.default };
}

function branchToDict(b: BranchInfo): JsonObject {
  return {
    location: locationToDict(b.location),
    condition: b.condition,
    complexity_contribution: b.complexityContribution,
  };
}

export function attributesToDict(attrs: readonly Attribute[]): { [key: string]: AttributeValue } {
  const out: { [key: string]: AttributeValue } = {};
  for (const [k, v] of attrs) out[k] = v;
  return out;
}

/** Port of ``_unit_to_dict``. */
export function unitToDict(unit: CodeUnit): JsonObject {
  const d: JsonObject = {
    id: unit.id,
    name: unit.name,
    kind: unit.kind,
    location: locationToDict(unit.location),
    parameters: unit.parameters.map(parameterToDict),
    return_type: unit.returnType === null ? null : typeRefToDict(unit.returnType),
    exception_types: unit.exceptionTypes.map(typeRefToDict),
  };
  if (unit.typeParameters.length > 0) d["type_parameters"] = unit.typeParameters.map(typeParameterToDict);
  d["cyclomatic_complexity"] = unit.cyclomaticComplexity;
  d["branches"] = unit.branches.map(branchToDict);
  d["docstring"] = unit.docstring;
  if (unit.origin !== "source") d["origin"] = unit.origin;
  if (unit.attributes.length > 0) d["attributes"] = attributesToDict(unit.attributes);
  return d;
}

/** Port of ``_edge_to_dict``. */
export function edgeToDict(edge: CodeEdge): JsonObject {
  const d: JsonObject = {
    source: edge.sourceId,
    target: edge.targetId,
    kind: edge.kind,
    confidence: edge.confidence,
  };
  if (edge.attributes.length > 0) d["attributes"] = attributesToDict(edge.attributes);
  return d;
}

export function annotationToDict(ann: Annotation): JsonObject {
  return { kind: ann.kind, description: ann.description, source: ann.source };
}
