/** C language parser (port of ``parsers/c/parser.py``). */

import { codeEdge, type EdgeConfidence } from "../models/edges.js";
import { CodeGraph } from "../models/graph.js";
import { codeUnit, parameter, typeRef, type BranchInfo, type Parameter, type TypeRef } from "../models/nodes.js";
import { parseWithGrammar } from "../treesitter.js";
import type { LanguageParser } from "./base.js";
import {
  addContainsEdge,
  addModuleNode,
  collectBodyInfo,
  computeComplexity,
  makeLocation,
  moduleIdFromPath,
  nodeText,
  pyStrip,
  type Node,
} from "./common.js";

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "while_statement",
  "do_statement",
  "case_statement",
  "conditional_expression",
]);

const THROW_TYPES: ReadonlySet<string> = new Set();

export class CParser implements LanguageParser {
  readonly language = "c";
  readonly extensions = [".c", ".h"] as const;
  readonly grammars = ["c"] as const;

  parseFile(filePath: string, source: string): CodeGraph {
    const tree = parseWithGrammar("c", source);
    try {
      const graph = new CodeGraph({ language: "c", rootPath: filePath });
      visitModule(tree.rootNode, filePath, moduleIdFromPath(filePath), graph);
      return graph;
    } finally {
      tree.delete();
    }
  }
}

function visitModule(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  addModuleNode(root, filePath, moduleId, graph);
  for (const child of root.children) visitTopLevelNode(child, filePath, moduleId, graph);
}

const PREPROC_CONTAINER_TYPES = new Set(["preproc_if", "preproc_ifdef", "preproc_else", "preproc_elif", "ERROR"]);

function visitTopLevelNode(child: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  if (child.type === "function_definition") {
    extractFunction(child, filePath, moduleId, graph);
  } else if (child.type === "preproc_include") {
    extractInclude(child, graph);
  } else if (child.type === "type_definition" || child.type === "declaration") {
    extractTypeDef(child, filePath, moduleId, graph);
  } else if (child.type === "struct_specifier") {
    extractStruct(child, filePath, moduleId, graph);
  } else if (child.type === "enum_specifier") {
    extractEnum(child, filePath, moduleId, graph);
  } else if (PREPROC_CONTAINER_TYPES.has(child.type)) {
    for (const nested of child.children) visitTopLevelNode(nested, filePath, moduleId, graph);
  }
}

/** Extract struct or enum from a type_definition or declaration. */
function extractTypeDef(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const typedefName = getTypedefName(node);
  for (const child of node.children) {
    if (child.type === "struct_specifier") {
      extractStruct(child, filePath, moduleId, graph, typedefName);
    } else if (child.type === "enum_specifier") {
      extractEnum(child, filePath, moduleId, graph, typedefName);
    }
  }
}

/** Get the typedef alias name from a type_definition node. */
function getTypedefName(node: Node): string | null {
  for (const child of node.children) {
    if (child.type === "type_identifier") return nodeText(child);
  }
  return null;
}

function extractStruct(
  node: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
  fallbackName: string | null = null,
): void {
  const nameNode = node.childForFieldName("name");
  const structName = nameNode ? nodeText(nameNode) : fallbackName;
  if (!structName) return;
  const structId = `${moduleId}:${structName}`;
  graph.nodes.set(
    structId,
    codeUnit({ id: structId, name: structName, kind: "struct", location: makeLocation(node, filePath) }),
  );
  addContainsEdge(graph, moduleId, structId);
}

function extractEnum(
  node: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
  fallbackName: string | null = null,
): void {
  const nameNode = node.childForFieldName("name");
  const enumName = nameNode ? nodeText(nameNode) : fallbackName;
  if (!enumName) return;
  const enumId = `${moduleId}:${enumName}`;
  graph.nodes.set(
    enumId,
    codeUnit({ id: enumId, name: enumName, kind: "enum", location: makeLocation(node, filePath) }),
  );
  addContainsEdge(graph, moduleId, enumId);
}

function extractFunction(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const funcName = getFunctionName(node);
  if (!funcName) return;
  const funcId = `${moduleId}:${funcName}`;

  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const body = node.childForFieldName("body");

  const branches: BranchInfo[] = [];
  const exceptionTypes: TypeRef[] = [];
  const calls: [string, Node][] = [];
  if (body !== null) {
    collectBodyInfo(body, filePath, BRANCH_NODE_TYPES, "call_expression", THROW_TYPES, branches, exceptionTypes, calls);
  }

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
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, moduleId, funcId);

  addCallEdges(calls, funcId, moduleId, filePath, graph);
}

/** Create CALLS edges from collected call expressions. */
function addCallEdges(
  calls: [string, Node][],
  funcId: string,
  moduleId: string,
  filePath: string,
  graph: CodeGraph,
): void {
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

function callConfidence(callName: string): EdgeConfidence {
  if (callName.includes(".") || callName.includes("->")) return "inferred";
  return "certain";
}

function resolveCallTarget(callName: string, moduleId: string): string {
  if (!callName.includes(".") && !callName.includes("->")) return `${moduleId}:${callName}`;
  return callName;
}

/**
 * Extract function name from a C function_definition.
 *
 * Handles nested declarator structures: the declarator may be a
 * function_declarator, pointer_declarator, or nested combination thereof.
 */
function getFunctionName(node: Node): string {
  const declarator = node.childForFieldName("declarator");
  if (declarator === null) return "";
  return digIdentifier(declarator);
}

/** Recursively dig through declarator nodes to find the name. */
function digIdentifier(node: Node): string {
  if (node.type === "identifier") return nodeText(node);
  if (node.type === "field_identifier") return nodeText(node);
  const declarator = node.childForFieldName("declarator");
  if (declarator !== null) return digIdentifier(declarator);
  for (const child of node.children) {
    if (child.type === "identifier" || child.type === "field_identifier") return nodeText(child);
  }
  for (const child of node.children) {
    const result = digIdentifier(child);
    if (result) return result;
  }
  return "";
}

function extractParameters(node: Node): Parameter[] {
  const declarator = node.childForFieldName("declarator");
  const funcDecl = findFuncDeclarator(declarator);
  if (funcDecl === null) return [];

  const paramsNode = funcDecl.childForFieldName("parameters");
  if (paramsNode === null) return [];

  const params: Parameter[] = [];
  for (const child of paramsNode.children) {
    if (child.type === "parameter_declaration") {
      const param = parseParamDeclaration(child);
      if (param !== null) params.push(param);
    }
  }
  return params;
}

/** Find the function_declarator inside a declarator chain. */
function findFuncDeclarator(node: Node | null): Node | null {
  if (node === null) return null;
  if (node.type === "function_declarator") return node;
  const declarator = node.childForFieldName("declarator");
  if (declarator !== null) return findFuncDeclarator(declarator);
  for (const child of node.children) {
    if (child.type === "function_declarator") return child;
  }
  return null;
}

function parseParamDeclaration(node: Node): Parameter | null {
  const typeNode = node.childForFieldName("type");
  const typeName = typeNode ? nodeText(typeNode) : null;
  const ref = typeName ? typeRef(typeName) : null;

  const decl = node.childForFieldName("declarator");
  if (decl !== null) {
    const name = digIdentifier(decl);
    if (name) return parameter(name, { typeRef: ref });
  }
  return null;
}

function extractReturnType(node: Node): TypeRef | null {
  const typeNode = node.childForFieldName("type");
  if (typeNode === null) return null;
  const text = nodeText(typeNode);
  return text ? typeRef(text) : null;
}

/**
 * Extract a doc comment preceding a function definition.
 *
 * Looks for /** ... *\/ or /// style comments immediately before the function node.
 */
function extractDocstring(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev === null || prev.type !== "comment") return null;
  const text = nodeText(prev);
  if (text.startsWith("/**") || text.startsWith("///")) return cleanCDocstring(text);
  return null;
}

/** Strip C doc-comment delimiters. */
function cleanCDocstring(text: string): string {
  let t = text;
  if (t.startsWith("/**")) {
    t = t.slice(3);
    if (t.endsWith("*/")) t = t.slice(0, -2);
  } else if (t.startsWith("///")) {
    t = t.slice(3);
  }
  return t.trim();
}

/** Extract #include directives as dependencies. */
function extractInclude(node: Node, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "string_literal" || child.type === "system_lib_string") {
      const path = pyStrip(pyStrip(pyStrip(nodeText(child), '"'), "<"), ">");
      if (path && !graph.dependencies.includes(path)) graph.dependencies.push(path);
      return;
    }
  }
}
