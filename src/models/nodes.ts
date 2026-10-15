/** Core node types for the code graph. */

export type AttributeValue = string | number | boolean | null;
export type Attribute = readonly [string, AttributeValue];

export const NODE_KINDS = [
  "function",
  "method",
  "class",
  "module",
  "struct",
  "interface",
  "trait",
  "enum",
  "namespace",
  "contract",
  "library",
  "template",
  "schema",
  "table",
  "view",
  "procedure",
  "proxy",
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_ORIGINS = ["source", "proxy", "binary", "synthetic"] as const;
export type NodeOrigin = (typeof NODE_ORIGINS)[number];

/** A span of source code in a file. Lines are 1-based, columns are 0-based UTF-8 byte offsets. */
export interface SourceLocation {
  readonly filePath: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly startCol: number | null;
  readonly endCol: number | null;
}

/** A reference to a type, possibly with generic arguments. */
export interface TypeRef {
  readonly name: string;
  readonly module: string | null;
  readonly genericArgs: readonly TypeRef[];
}

/** A generic type parameter declared by a code unit. */
export interface TypeParameter {
  readonly name: string;
  readonly constraints: readonly TypeRef[];
  readonly default: TypeRef | null;
  readonly variance: string | null;
}

/** A function or method parameter. */
export interface Parameter {
  readonly name: string;
  readonly typeRef: TypeRef | null;
  readonly default: string | null;
}

/** Metadata about a branch within a function. */
export interface BranchInfo {
  readonly location: SourceLocation;
  readonly condition: string;
  readonly complexityContribution: number;
}

/** A node in the code graph: function, method, class, module, ... */
export interface CodeUnit {
  readonly id: string;
  readonly name: string;
  readonly kind: NodeKind;
  readonly location: SourceLocation;
  readonly parameters: readonly Parameter[];
  readonly returnType: TypeRef | null;
  readonly exceptionTypes: readonly TypeRef[];
  readonly typeParameters: readonly TypeParameter[];
  readonly cyclomaticComplexity: number | null;
  readonly branches: readonly BranchInfo[];
  readonly docstring: string | null;
  readonly origin: NodeOrigin;
  readonly attributes: readonly Attribute[];
}

type Optional<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;

export function sourceLocation(
  filePath: string,
  startLine: number,
  endLine: number,
  startCol: number | null = null,
  endCol: number | null = null,
): SourceLocation {
  return { filePath, startLine, endLine, startCol, endCol };
}

export function typeRef(
  name: string,
  opts: { module?: string | null; genericArgs?: readonly TypeRef[] } = {},
): TypeRef {
  return { name, module: opts.module ?? null, genericArgs: opts.genericArgs ?? [] };
}

export function typeParameter(
  name: string,
  opts: { constraints?: readonly TypeRef[]; default?: TypeRef | null; variance?: string | null } = {},
): TypeParameter {
  return {
    name,
    constraints: opts.constraints ?? [],
    default: opts.default ?? null,
    variance: opts.variance ?? null,
  };
}

export function parameter(name: string, opts: { typeRef?: TypeRef | null; default?: string | null } = {}): Parameter {
  return { name, typeRef: opts.typeRef ?? null, default: opts.default ?? null };
}

export function branchInfo(location: SourceLocation, condition: string, complexityContribution = 1): BranchInfo {
  return { location, condition, complexityContribution };
}

export type CodeUnitInit = Optional<
  CodeUnit,
  | "parameters"
  | "returnType"
  | "exceptionTypes"
  | "typeParameters"
  | "cyclomaticComplexity"
  | "branches"
  | "docstring"
  | "origin"
  | "attributes"
>;

/** Build a CodeUnit, filling defaults like the upstream frozen dataclass. */
export function codeUnit(init: CodeUnitInit): CodeUnit {
  return {
    id: init.id,
    name: init.name,
    kind: init.kind,
    location: init.location,
    parameters: init.parameters ?? [],
    returnType: init.returnType ?? null,
    exceptionTypes: init.exceptionTypes ?? [],
    typeParameters: init.typeParameters ?? [],
    cyclomaticComplexity: init.cyclomaticComplexity ?? null,
    branches: init.branches ?? [],
    docstring: init.docstring ?? null,
    origin: init.origin ?? "source",
    attributes: init.attributes ?? [],
  };
}
