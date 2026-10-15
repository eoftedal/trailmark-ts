/** Go language parser (port of ``parsers/go/parser.py``). */

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
  pyStrip,
  type Node,
} from "./common.js";

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "select_statement",
  "expression_case",
  "type_case",
  "default_case",
  "communication_case",
]);

const THROW_TYPES: ReadonlySet<string> = new Set();

const GO_TYPE_NODES = new Set([
  "type_identifier",
  "pointer_type",
  "slice_type",
  "map_type",
  "array_type",
  "qualified_type",
]);

export class GoParser implements LanguageParser {
  readonly language = "go";
  readonly extensions = [".go"] as const;
  readonly grammars = ["go"] as const;

  parseFile(filePath: string, source: string): CodeGraph {
    const tree = parseWithGrammar("go", source);
    try {
      const graph = new CodeGraph({ language: "go", rootPath: filePath });
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
  if (child.type === "function_declaration") extractFunction(child, filePath, moduleId, graph);
  else if (child.type === "method_declaration") extractMethod(child, filePath, moduleId, graph);
  else if (child.type === "type_declaration") extractTypeDeclaration(child, filePath, moduleId, graph);
  else if (child.type === "import_declaration") extractImport(child, graph);
}

/** Extract struct or interface from a type_declaration. */
function extractTypeDeclaration(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "type_spec") extractTypeSpec(child, node, filePath, moduleId, graph);
  }
}

/** Extract a single type_spec (struct or interface). */
function extractTypeSpec(spec: Node, decl: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = spec.childForFieldName("name");
  const typeNode = spec.childForFieldName("type");
  if (nameNode === null || typeNode === null) return;

  const typeName = nodeText(nameNode);
  const typeId = `${moduleId}:${typeName}`;
  const kind = kindFromTypeNode(typeNode);
  if (kind === null) return;

  graph.nodes.set(
    typeId,
    codeUnit({
      id: typeId,
      name: typeName,
      kind,
      location: makeLocation(spec, filePath),
      typeParameters: extractTypeParameters(spec),
      docstring: extractDocstring(decl),
    }),
  );
  addContainsEdge(graph, moduleId, typeId);
}

/** Map a Go type node to a NodeKind. */
function kindFromTypeNode(typeNode: Node): NodeKind | null {
  if (typeNode.type === "struct_type") return "struct";
  if (typeNode.type === "interface_type") return "interface";
  return null;
}

/** Extract a standalone function declaration. */
function extractFunction(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const funcName = nodeText(nameNode);
  const funcId = `${moduleId}:${funcName}`;

  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const [branches, exceptionTypes, calls] = collectFuncBody(node.childForFieldName("body"), filePath);

  graph.nodes.set(
    funcId,
    codeUnit({
      id: funcId,
      name: funcName,
      kind: "function",
      location: makeLocation(node, filePath),
      parameters: params,
      returnType,
      exceptionTypes,
      typeParameters: extractTypeParameters(node),
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, moduleId, funcId);
  addCallEdges(calls, funcId, moduleId, null, filePath, graph);
}

/** Extract a method declaration (has a receiver). */
function extractMethod(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const methodName = nodeText(nameNode);
  const receiverType = extractReceiverType(node);

  const typeId = receiverType ? `${moduleId}:${receiverType}` : moduleId;
  const methodId = `${typeId}.${methodName}`;

  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const [branches, exceptionTypes, calls] = collectFuncBody(node.childForFieldName("body"), filePath);

  graph.nodes.set(
    methodId,
    codeUnit({
      id: methodId,
      name: methodName,
      kind: "method",
      location: makeLocation(node, filePath),
      parameters: params,
      returnType,
      exceptionTypes,
      typeParameters: extractTypeParameters(node),
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, typeId, methodId);
  addCallEdges(calls, methodId, moduleId, typeId, filePath, graph);
}

/** Extract the receiver type name from a method declaration. */
function extractReceiverType(node: Node): string {
  const receiver = node.childForFieldName("receiver");
  if (receiver === null) return "";
  return findTypeIdentifier(receiver);
}

/** Find the first type_identifier (pre-order) in a receiver node. */
function findTypeIdentifier(root: Node): string {
  // Iterative pre-order DFS (upstream recurses; receivers are small).
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "type_identifier") {
      const text = nodeText(node);
      if (text) return text;
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return "";
}

/** Collect branches, exceptions, and calls from a function body. */
function collectFuncBody(body: Node | null, filePath: string): [BranchInfo[], TypeRef[], [string, Node][]] {
  const branches: BranchInfo[] = [];
  const exceptionTypes: TypeRef[] = [];
  const calls: [string, Node][] = [];
  if (body !== null) {
    collectBodyInfo(body, filePath, BRANCH_NODE_TYPES, "call_expression", THROW_TYPES, branches, exceptionTypes, calls);
  }
  return [branches, exceptionTypes, calls];
}

/** Extract parameters from a function/method declaration. */
function extractParameters(node: Node): Parameter[] {
  const paramsNode = node.childForFieldName("parameters");
  if (paramsNode === null) return [];
  const params: Parameter[] = [];
  for (const child of paramsNode.children) {
    if (child.type === "parameter_declaration") extractSingleParam(child, params);
  }
  return params;
}

/** Extract name and type from a parameter_declaration. */
function extractSingleParam(decl: Node, params: Parameter[]): void {
  let name = "";
  let type: TypeRef | null = null;
  for (const child of decl.children) {
    if (child.type === "identifier" && !name) name = nodeText(child);
    else if (GO_TYPE_NODES.has(child.type)) type = typeRef(nodeText(child));
  }
  if (name) params.push(parameter(name, { typeRef: type }));
}

/** Extract the return type from a function declaration. */
function extractReturnType(node: Node): TypeRef | null {
  const result = node.childForFieldName("result");
  if (result === null) return null;
  return typeRef(nodeText(result));
}

/** Extract a doc comment immediately preceding the node. */
function extractDocstring(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev !== null && prev.type === "comment") return cleanGoComment(nodeText(prev));
  return null;
}

/** Strip comment markers from a Go comment. */
function cleanGoComment(text: string): string {
  if (text.startsWith("//")) return text.slice(2).trim();
  if (text.startsWith("/*") && text.endsWith("*/")) return text.slice(2, -2).trim();
  return text.trim();
}

/** Add CALLS edges for all collected call expressions. */
function addCallEdges(
  calls: [string, Node][],
  sourceId: string,
  moduleId: string,
  _typeId: string | null,
  filePath: string,
  graph: CodeGraph,
): void {
  for (const [callName, callNode] of calls) {
    graph.edges.push(
      codeEdge({
        sourceId,
        targetId: resolveCallTarget(callName, moduleId),
        kind: "calls",
        confidence: callConfidence(callName),
        location: makeLocation(callNode, filePath),
      }),
    );
  }
}

/** Determine confidence for a Go call expression. */
function callConfidence(callName: string): EdgeConfidence {
  return callName.includes(".") ? "inferred" : "certain";
}

/** Resolve a call name to a target node ID. */
function resolveCallTarget(callName: string, moduleId: string): string {
  if (!callName.includes(".")) return `${moduleId}:${callName}`;
  return callName;
}

/** Extract import declarations as dependency info. */
function extractImport(node: Node, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "import_spec") {
      extractImportSpec(child, graph);
    } else if (child.type === "import_spec_list") {
      for (const spec of child.children) {
        if (spec.type === "import_spec") extractImportSpec(spec, graph);
      }
    }
  }
}

/** Extract a single import spec path. */
function extractImportSpec(spec: Node, graph: CodeGraph): void {
  const pathNode = spec.childForFieldName("path");
  if (pathNode === null) return;
  const raw = pyStrip(nodeText(pathNode), '"');
  const parts = raw.split("/");
  const dep = parts[parts.length - 1]!;
  if (dep && !graph.dependencies.includes(dep)) graph.dependencies.push(dep);
}
