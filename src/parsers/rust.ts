/** Rust language parser (port of ``parsers/rust/parser.py``). */

import { codeEdge, type EdgeConfidence } from "../models/edges.js";
import { CodeGraph } from "../models/graph.js";
import {
  codeUnit,
  parameter,
  typeRef,
  type BranchInfo,
  type NodeKind,
  type Parameter,
  type TypeRef,
} from "../models/nodes.js";
import { parseWithGrammar } from "../treesitter.js";
import type { LanguageParser } from "./base.js";
import {
  addContainsEdge,
  addModuleNode,
  collectBodyInfo,
  computeComplexity,
  extractTypeParameters,
  makeLocation,
  moduleIdFromPath,
  nodeText,
  type Node,
} from "./common.js";

const BRANCH_NODE_TYPES = new Set([
  "if_expression",
  "for_expression",
  "while_expression",
  "loop_expression",
  "match_arm",
  "else_clause",
  "conditional_expression",
]);

const THROW_TYPES: ReadonlySet<string> = new Set();

export class RustParser implements LanguageParser {
  readonly language = "rust";
  readonly extensions = [".rs"] as const;
  readonly grammars = ["rust"] as const;

  parseFile(filePath: string, source: string): CodeGraph {
    const tree = parseWithGrammar("rust", source);
    try {
      const graph = new CodeGraph({ language: "rust", rootPath: filePath });
      visitModule(tree.rootNode, filePath, moduleIdFromPath(filePath), graph);
      return graph;
    } finally {
      tree.delete();
    }
  }
}

/** Walk the top-level of a module, extracting nodes and edges. */
function visitModule(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  addModuleNode(root, filePath, moduleId, graph);
  for (const child of root.children) visitTopLevelNode(child, filePath, moduleId, graph);
}

/** Dispatch a single top-level node. */
function visitTopLevelNode(child: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  switch (child.type) {
    case "function_item":
      extractFunction(child, filePath, moduleId, null, graph);
      break;
    case "struct_item":
      extractStruct(child, filePath, moduleId, graph);
      break;
    case "trait_item":
      extractTrait(child, filePath, moduleId, graph);
      break;
    case "enum_item":
      extractEnum(child, filePath, moduleId, graph);
      break;
    case "impl_item":
      extractImpl(child, filePath, moduleId, graph);
      break;
    case "use_declaration":
      extractImport(child, graph);
      break;
  }
}

/**
 * Add a named type-like item node (upstream ``_extract_struct`` / ``_extract_enum``,
 * which are identical apart from the kind). Returns the new node's ID.
 */
function extractTypeItem(
  node: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
  kind: NodeKind,
): string | null {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return null;
  const name = nodeText(nameNode);
  const id = `${moduleId}:${name}`;
  const docstring = extractDocstring(node);
  graph.nodes.set(
    id,
    codeUnit({
      id,
      name,
      kind,
      location: makeLocation(node, filePath),
      typeParameters: extractTypeParameters(node),
      docstring,
    }),
  );
  addContainsEdge(graph, moduleId, id);
  return id;
}

/** Extract a struct definition. */
function extractStruct(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  extractTypeItem(node, filePath, moduleId, graph, "struct");
}

/** Extract an enum definition. */
function extractEnum(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  extractTypeItem(node, filePath, moduleId, graph, "enum");
}

/** Extract a trait definition and its method signatures. */
function extractTrait(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const traitId = extractTypeItem(node, filePath, moduleId, graph, "trait");
  if (traitId === null) return;
  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (child.type === "function_item") extractFunction(child, filePath, moduleId, traitId, graph);
  }
}

/** Extract an impl block, with optional trait implementation. */
function extractImpl(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const typeName = extractImplTypeName(node);
  if (!typeName) return;
  const typeId = `${moduleId}:${typeName}`;

  const traitNode = node.childForFieldName("trait");
  if (traitNode !== null) addImplementsEdge(traitNode, typeId, moduleId, graph);

  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (child.type === "function_item") extractFunction(child, filePath, moduleId, typeId, graph);
  }
}

/** Extract the type name from an impl block. */
function extractImplTypeName(node: Node): string {
  const typeNode = node.childForFieldName("type");
  if (typeNode === null) return "";
  if (typeNode.type === "type_identifier") return nodeText(typeNode);
  if (typeNode.type === "generic_type") {
    for (const child of typeNode.children) {
      if (child.type === "type_identifier") return nodeText(child);
    }
  }
  return nodeText(typeNode);
}

/** Add an IMPLEMENTS edge from type to trait. */
function addImplementsEdge(traitNode: Node, typeId: string, moduleId: string, graph: CodeGraph): void {
  graph.edges.push(
    codeEdge({
      sourceId: typeId,
      targetId: `${moduleId}:${nodeText(traitNode)}`,
      kind: "implements",
      confidence: "certain",
    }),
  );
}

/** Extract a function or method definition. */
function extractFunction(
  node: Node,
  filePath: string,
  moduleId: string,
  containerId: string | null,
  graph: CodeGraph,
): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const funcName = nodeText(nameNode);

  let funcId: string;
  let kind: NodeKind;
  let owner: string;
  if (containerId !== null) {
    funcId = `${containerId}.${funcName}`;
    kind = "method";
    owner = containerId;
  } else {
    funcId = `${moduleId}:${funcName}`;
    kind = "function";
    owner = moduleId;
  }

  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const body = node.childForFieldName("body");

  const branches: BranchInfo[] = [];
  const exceptionTypes: TypeRef[] = [];
  const calls: [string, Node][] = [];
  if (body !== null) {
    collectBodyInfo(body, filePath, BRANCH_NODE_TYPES, "call_expression", THROW_TYPES, branches, exceptionTypes, calls);
  }
  const docstring = extractDocstring(node);

  graph.nodes.set(
    funcId,
    codeUnit({
      id: funcId,
      name: funcName,
      kind,
      location: makeLocation(node, filePath),
      parameters: params,
      returnType,
      exceptionTypes,
      typeParameters: extractTypeParameters(node),
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      docstring,
    }),
  );
  addContainsEdge(graph, owner, funcId);

  for (const [callName, callNode] of calls) {
    graph.edges.push(
      codeEdge({
        sourceId: funcId,
        targetId: resolveCallTarget(callName, moduleId),
        kind: "calls",
        confidence: callConfidence(callName),
        location: makeLocation(callNode, filePath),
      }),
    );
  }
}

/** Extract parameters from a function definition. */
function extractParameters(node: Node): Parameter[] {
  const paramsNode = node.childForFieldName("parameters");
  if (paramsNode === null) return [];
  const params: Parameter[] = [];
  for (const child of paramsNode.children) {
    if (child.type === "parameter") extractSingleParam(child, params);
  }
  return params;
}

/** Extract name and type from a parameter node. */
function extractSingleParam(param: Node, params: Parameter[]): void {
  const pattern = param.childForFieldName("pattern");
  const typeNode = param.childForFieldName("type");
  if (pattern === null) return;
  params.push(parameter(nodeText(pattern), { typeRef: typeNode !== null ? typeRef(nodeText(typeNode)) : null }));
}

/** Extract the return type from a function definition. */
function extractReturnType(node: Node): TypeRef | null {
  const returnType = node.childForFieldName("return_type");
  return returnType === null ? null : typeRef(nodeText(returnType));
}

/** Extract doc comments (///) preceding a node. */
function extractDocstring(node: Node): string | null {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev !== null && prev.type === "line_comment") {
    const text = nodeText(prev);
    if (text.startsWith("///") || text.startsWith("//!")) {
      lines.push(text.slice(3).trim());
      prev = prev.previousNamedSibling;
    } else {
      break;
    }
  }
  if (lines.length === 0) return null;
  lines.reverse();
  return lines.join("\n");
}

/** Determine confidence for a Rust call expression. */
function callConfidence(callName: string): EdgeConfidence {
  return callName.includes(".") || callName.includes("::") ? "inferred" : "certain";
}

/** Resolve a call name to a target node ID. */
function resolveCallTarget(callName: string, moduleId: string): string {
  if (!callName.includes(".") && !callName.includes("::")) return `${moduleId}:${callName}`;
  return callName;
}

const IMPORT_PATH_TYPES = new Set(["scoped_identifier", "identifier", "scoped_use_list", "use_wildcard"]);

/** Extract use declarations as dependency info. */
function extractImport(node: Node, graph: CodeGraph): void {
  for (const child of node.children) {
    if (IMPORT_PATH_TYPES.has(child.type)) {
      const dep = firstPathSegment(child);
      if (dep && !graph.dependencies.includes(dep)) graph.dependencies.push(dep);
      return;
    }
  }
}

/** Extract the first path segment from a use path. */
function firstPathSegment(node: Node): string {
  if (node.type === "identifier") return nodeText(node);
  for (const child of node.children) {
    if (child.type === "identifier") return nodeText(child);
    if (child.type === "scoped_identifier") return firstPathSegment(child);
  }
  return "";
}
