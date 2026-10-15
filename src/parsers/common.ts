/** Shared utilities for tree-sitter language parsers (port of ``parsers/_common.py``). */

import { codeEdge, type CodeEdge } from "../models/edges.js";
import { CodeGraph } from "../models/graph.js";
import {
  branchInfo,
  codeUnit,
  sourceLocation,
  typeParameter,
  typeRef,
  type BranchInfo,
  type SourceLocation,
  type TypeParameter,
  type TypeRef,
} from "../models/nodes.js";
import type { Node } from "../treesitter.js";
import { basename, posixRelative, stem } from "../util/path.js";

export type { Node };

// ---------------------------------------------------------------------------
// Per-parse state. Parsing a file is synchronous, so module-level state set by
// the driver around each ``parseFile`` call is safe (mirrors the upstream
// ContextVar for the directory root).
// ---------------------------------------------------------------------------

interface SourceState {
  text: string;
  ascii: boolean;
  lineStarts: number[] | null;
}

let currentSource: SourceState | null = null;
let directoryParseRoot: string | null = null;

/** Run ``fn`` with ``text`` registered as the source being parsed (for UTF-8 columns). */
export function withSource<T>(text: string, fn: () => T): T {
  const prev = currentSource;
  // eslint-disable-next-line no-control-regex
  currentSource = { text, ascii: /^[\x00-\x7f]*$/.test(text), lineStarts: null };
  try {
    return fn();
  } finally {
    currentSource = prev;
  }
}

/** Run ``fn`` with a directory root active, so module IDs are root-relative dotted paths. */
export function withDirectoryRoot<T>(root: string, fn: () => T): T {
  const prev = directoryParseRoot;
  directoryParseRoot = root;
  try {
    return fn();
  } finally {
    directoryParseRoot = prev;
  }
}

/** Async variant of ``withDirectoryRoot`` for the parse driver. */
export async function withDirectoryRootAsync<T>(root: string, fn: () => Promise<T>): Promise<T> {
  const prev = directoryParseRoot;
  directoryParseRoot = root;
  try {
    return await fn();
  } finally {
    directoryParseRoot = prev;
  }
}

export function currentDirectoryRoot(): string | null {
  return directoryParseRoot;
}

const encoder = new TextEncoder();

/** Convert a tree-sitter (UTF-16) column to the UTF-8 byte column upstream reports. */
function utf8Column(row: number, column: number): number {
  const src = currentSource;
  if (src === null || src.ascii || column === 0) return column;
  if (src.lineStarts === null) {
    const starts = [0];
    const text = src.text;
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    src.lineStarts = starts;
  }
  const start = src.lineStarts[row] ?? 0;
  const prefix = src.text.slice(start, start + column);
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(prefix)) return column;
  return encoder.encode(prefix).length;
}

/** Get the text content of a tree-sitter node. */
export function nodeText(node: Node | null | undefined): string {
  return node ? node.text : "";
}

/** Create a SourceLocation from a tree-sitter node. */
export function makeLocation(node: Node, filePath: string): SourceLocation {
  const s = node.startPosition;
  const e = node.endPosition;
  return sourceLocation(filePath, s.row + 1, e.row + 1, utf8Column(s.row, s.column), utf8Column(e.row, e.column));
}

/**
 * Derive a module ID from a file path.
 *
 * Single-file parsing preserves the historical filename-stem ID. Directory
 * parsing uses a root-relative dotted path so same-named files in different
 * directories do not overwrite each other when merged.
 */
export function moduleIdFromPath(filePath: string): string {
  const root = directoryParseRoot;
  if (root !== null) {
    const rel = posixRelative(root, filePath);
    if (rel !== null) {
      const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
      const last = parts[parts.length - 1] ?? "";
      let moduleParts: string[];
      if (stem(last) === "__init__") {
        moduleParts = parts.slice(0, -1);
        if (moduleParts.length === 0) return escapeModulePathPart(basename(root));
      } else {
        moduleParts = [...parts.slice(0, -1), stem(last)];
      }
      return moduleParts.map(escapeModulePathPart).join(".");
    }
  }
  const s = stem(basename(filePath));
  if (s !== "__init__") return s;
  const parts = filePath.split("/");
  return parts.length >= 2 ? (parts[parts.length - 2] ?? "") : "";
}

function escapeModulePathPart(part: string): string {
  return part.replaceAll("\\", "\\\\").replaceAll(".", "\\.");
}

const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  "build",
  "dist",
  ".eggs",
  "vendor",
]);

/** Return whether a directory should be skipped during source walks. */
export function shouldSkipDir(dirname: string): boolean {
  return EXCLUDED_DIRS.has(dirname) || dirname.startsWith(".");
}

/**
 * Collect branches, exceptions, and calls from a function body.
 * Uses an explicit stack to avoid recursion on deeply nested ASTs.
 */
export function collectBodyInfo(
  body: Node,
  filePath: string,
  branchTypes: ReadonlySet<string>,
  callType: string,
  throwTypes: ReadonlySet<string>,
  branches: BranchInfo[],
  exceptionTypes: TypeRef[],
  calls: [string, Node][],
): void {
  const stack: Node[] = [...body.children].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (branchTypes.has(node.type)) {
      branches.push(branchInfo(makeLocation(node, filePath), extractConditionText(node)));
    }
    if (throwTypes.has(node.type)) collectThrowType(node, exceptionTypes);
    if (node.type === callType) {
      const callName = extractCallName(node);
      if (callName) calls.push([callName, node]);
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}

function extractConditionText(node: Node): string {
  if (node.type === "boolean_operator") return "boolean_operator";
  const condition = node.childForFieldName("condition");
  if (condition !== null) return nodeText(condition);
  return node.type;
}

function collectThrowType(node: Node, exceptionTypes: TypeRef[]): void {
  for (const child of node.children) {
    if (child.type === "call" || child.type === "call_expression") {
      const func = child.childForFieldName("function");
      if (func !== null) exceptionTypes.push(typeRef(nodeText(func)));
      return;
    }
    if (child.type === "new_expression") {
      const ctor = child.childForFieldName("constructor");
      if (ctor !== null) exceptionTypes.push(typeRef(nodeText(ctor)));
      return;
    }
    if (child.type === "identifier") {
      exceptionTypes.push(typeRef(nodeText(child)));
      return;
    }
  }
}

const CALL_NAME_TYPES = new Set([
  "identifier",
  "attribute",
  "field_expression",
  "member_expression",
  "scoped_identifier",
  "selector_expression",
  "simple_identifier", // Swift
  "navigation_expression", // Swift dot access (e.g. self.method)
]);

/** Extract the function/method name from a call node. */
export function extractCallName(node: Node): string {
  const func = node.childForFieldName("function");
  if (func === null) {
    // Grammars that don't label the callable (e.g. Swift): first matching child.
    for (const child of node.children) {
      if (CALL_NAME_TYPES.has(child.type)) return nodeText(child);
    }
    return "";
  }
  if (CALL_NAME_TYPES.has(func.type)) return nodeText(func);
  // Unwrap wrapper nodes (e.g., Solidity wraps in "expression").
  for (const child of func.children) {
    if (CALL_NAME_TYPES.has(child.type)) return nodeText(child);
  }
  return "";
}

/** Compute cyclomatic complexity from collected branches. */
export function computeComplexity(branches: readonly BranchInfo[]): number {
  return 1 + branches.length;
}

/** Create a MODULE node and add it to the graph. */
export function addModuleNode(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  graph.nodes.set(
    moduleId,
    codeUnit({ id: moduleId, name: moduleId, kind: "module", location: makeLocation(root, filePath) }),
  );
}

/** Add a CONTAINS edge from container to child. */
export function addContainsEdge(graph: CodeGraph, containerId: string, childId: string): void {
  graph.edges.push(codeEdge({ sourceId: containerId, targetId: childId, kind: "contains" }));
}

/** Return the first direct child of ``node`` whose type matches. */
export function firstChildByType(node: Node, typeName: string): Node | null {
  for (const child of node.children) {
    if (child.type === typeName) return child;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Generic type parameter extraction (best effort, text based).
// ---------------------------------------------------------------------------

/** Best-effort extraction of generic parameter declarations. */
export function extractTypeParameters(node: Node): TypeParameter[] {
  const raw = genericParameterBlock(nodeText(node));
  if (raw === null) return [];
  const params: TypeParameter[] = [];
  for (const part of splitTopLevel(raw)) {
    const p = parseTypeParameter(part);
    if (p !== null) params.push(p);
  }
  return params;
}

interface OpenMatch {
  openIndex: number;
  open: string;
}

function genericParameterBlock(text: string): string | null {
  const template = /\btemplate\s*<(?<params>[^<>]*)>/.exec(text);
  if (template !== null) return template.groups!["params"]!;

  const header = text.split("{")[0]!.split("=>")[0]!;
  const leading = /^\s*(?:[\w@[\]().,"']+\s+)*</.exec(header);
  if (leading !== null) {
    const result = delimitedBlockAt(header, leading.index + leading[0].length - 1, "<", ">");
    if (result !== null) return result;
  }

  const declaration = matchOpen(
    /\b(?:class|interface|struct|enum|trait|protocol|extension|type)\s+[A-Za-z_$][\w$]*\s*(<|\[)/,
    header,
  );
  if (declaration !== null) return blockFromMatch(header, declaration);

  const fn = matchOpen(/\b(?:def|fn|func|function|fun)\s+[A-Za-z_$][\w$]*\s*(<|\[)/, header);
  if (fn !== null) return blockFromMatch(header, fn);

  const method = matchOpen(/\b[A-Za-z_$][\w$]*\s*(<|\[)\s*[^\]>\n]*[\]>]\s*\(/, header);
  if (method !== null) return blockFromMatch(header, method);

  const arrow = matchOpen(/^\s*(<|\[)/, header);
  if (arrow !== null) {
    const result = blockFromMatch(header, arrow);
    if (result !== null) return result;
  }
  return null;
}

/** Match ``re`` (whose first capture group is the opener) and report the opener's index. */
function matchOpen(re: RegExp, text: string): OpenMatch | null {
  const withIndices = new RegExp(re.source, re.flags.includes("d") ? re.flags : re.flags + "d");
  const m = withIndices.exec(text);
  if (m === null || m.indices === undefined) return null;
  const span = m.indices[1];
  if (span === undefined) return null;
  return { openIndex: span[0], open: m[1]! };
}

function blockFromMatch(text: string, match: OpenMatch): string | null {
  const closer = match.open === "<" ? ">" : "]";
  return delimitedBlockAt(text, match.openIndex, match.open, closer);
}

function delimitedBlockAt(text: string, start: number, opener: string, closer: string): string | null {
  let depth = 0;
  for (let idx = start; idx < text.length; idx++) {
    const ch = text[idx];
    if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, idx);
    }
  }
  return null;
}

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  const openers = new Set(["<", "[", "("]);
  const closers = new Set([">", "]", ")"]);
  for (let idx = 0; idx < text.length; idx++) {
    const ch = text[idx]!;
    if (openers.has(ch)) depth += 1;
    else if (closers.has(ch) && depth > 0) depth -= 1;
    else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, idx).trim());
      start = idx + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function parseTypeParameter(text: string): TypeParameter | null {
  let item = text.trim();
  if (!item) return null;

  item = item.replace(/^(typename|class|const|in|out)\s+/, "");
  item = item.replace(/^\?\s*(extends|super)\s+/, "");

  let defaultRef: TypeRef | null = null;
  const eq = item.indexOf("=");
  if (eq >= 0) {
    defaultRef = typeRef(item.slice(eq + 1).trim());
    item = item.slice(0, eq);
  }

  let constraints: TypeRef[] = [];
  for (const marker of [" extends ", " super ", " implements ", ":"]) {
    const at = item.indexOf(marker);
    if (at >= 0) {
      const rawConstraints = item.slice(at + marker.length);
      constraints = rawConstraints
        .split(/[&|+]/)
        .filter((c) => c.trim())
        .map((c) => typeRef(c.trim()));
      item = item.slice(0, at);
      break;
    }
  }

  const tokens = item.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const name = tokens[0]!;
  if (tokens.length > 1 && constraints.length === 0) {
    constraints = [typeRef(tokens.slice(1).join(" "))];
  }
  return typeParameter(name, { constraints, default: defaultRef });
}

// ---------------------------------------------------------------------------
// Cross-file call linking (run after merging per-file graphs).
// ---------------------------------------------------------------------------

/**
 * Rewrite dangling call edges to point at definitions in other modules.
 *
 * Per-file parsers resolve bare calls like ``foo()`` as ``current_module:foo``.
 * After merging, if ``foo`` is defined in another module, rewrite the edge to
 * the actual definition site.
 */
export function linkCrossFileCalls(graph: CodeGraph): void {
  const defined = graph.nodes;
  const nameToIds = new Map<string, string[]>();
  for (const [nodeId, unit] of defined) {
    if (unit.kind === "function" || unit.kind === "method") {
      let list = nameToIds.get(unit.name);
      if (list === undefined) {
        list = [];
        nameToIds.set(unit.name, list);
      }
      list.push(nodeId);
    }
  }

  const newEdges: CodeEdge[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "calls" || defined.has(edge.targetId)) {
      newEdges.push(edge);
      continue;
    }
    const target = edge.targetId;
    if (target.includes("::") || target.includes("->")) {
      newEdges.push(edge);
      continue;
    }
    const bareName = rsplitLast(target, ":");
    if (bareName.includes(".") || bareName.includes("->")) {
      newEdges.push(edge);
      continue;
    }
    const candidates = nameToIds.get(bareName);
    if (candidates === undefined || candidates.length === 0) {
      newEdges.push(edge);
      continue;
    }
    if (candidates.length === 1) {
      newEdges.push({ ...edge, targetId: candidates[0]! });
      continue;
    }
    // Ambiguous: prefer a single cross-file candidate when a same-file
    // declaration is also present; never invent an arbitrary target.
    const srcModule = edge.sourceId.includes(":") ? edge.sourceId.slice(0, edge.sourceId.lastIndexOf(":")) : "";
    const cross = candidates.filter((c) => !c.startsWith(srcModule + ":"));
    if (cross.length === 1) newEdges.push({ ...edge, targetId: cross[0]! });
    else newEdges.push({ ...edge, confidence: "uncertain" });
  }
  graph.edges = newEdges;
}

/** ``s.rsplit(sep, 1)[-1]`` */
export function rsplitLast(s: string, sep: string): string {
  const at = s.lastIndexOf(sep);
  return at < 0 ? s : s.slice(at + sep.length);
}

/** ``s.split(sep, 1)`` → ``[head, tail]`` or ``[s]``. */
export function splitOnce(s: string, sep: string): [string] | [string, string] {
  const at = s.indexOf(sep);
  return at < 0 ? [s] : [s.slice(0, at), s.slice(at + sep.length)];
}

/** ``s.rsplit(sep, 1)`` → ``[head, tail]`` or ``[s]``. */
export function rsplitOnce(s: string, sep: string): [string] | [string, string] {
  const at = s.lastIndexOf(sep);
  return at < 0 ? [s] : [s.slice(0, at), s.slice(at + sep.length)];
}

/** Python ``str.split()`` with no arguments. */
export function pySplitWhitespace(s: string): string[] {
  return s.split(/\s+/).filter((t) => t !== "");
}

/** Python ``str.strip(chars)``. */
export function pyStrip(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a]!)) a++;
  while (b > a && chars.includes(s[b - 1]!)) b--;
  return s.slice(a, b);
}

export function emptyGraph(language: string, rootPath: string): CodeGraph {
  return new CodeGraph({ language, rootPath });
}
