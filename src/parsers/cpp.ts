/** C++ language parser (port of ``parsers/cpp/parser.py``). */

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
  "while_statement",
  "do_statement",
  "case_statement",
  "conditional_expression",
  "catch_clause",
]);

const THROW_TYPES = new Set(["throw_statement"]);

export class CppParser implements LanguageParser {
  readonly language = "cpp";
  readonly extensions = [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx"] as const;
  readonly grammars = ["cpp"] as const;

  parseFile(filePath: string, source: string): CodeGraph {
    const tree = parseWithGrammar("cpp", source);
    try {
      const graph = new CodeGraph({ language: "cpp", rootPath: filePath });
      visitModule(tree.rootNode, filePath, moduleIdFromPath(filePath), graph);
      return graph;
    } finally {
      tree.delete();
    }
  }
}

function visitModule(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  addModuleNode(root, filePath, moduleId, graph);
  for (const child of root.children) visitTopLevelNode(child, filePath, moduleId, null, graph);
}

const NESTED_CONTAINER_TYPES = new Set([
  "linkage_specification",
  "preproc_if",
  "preproc_ifdef",
  "preproc_else",
  "preproc_elif",
  "ERROR",
]);

function visitTopLevelNode(
  child: Node,
  filePath: string,
  moduleId: string,
  classId: string | null,
  graph: CodeGraph,
): void {
  if (child.type === "function_definition") {
    extractFunction(child, filePath, moduleId, classId, graph);
  } else if (child.type === "preproc_include") {
    extractInclude(child, graph);
  } else if (child.type === "namespace_definition") {
    extractNamespace(child, filePath, moduleId, graph);
  } else if (child.type === "type_definition" || child.type === "declaration") {
    extractTypeDef(child, filePath, moduleId, graph);
  } else if (NESTED_CONTAINER_TYPES.has(child.type)) {
    for (const nested of child.children) visitTopLevelNode(nested, filePath, moduleId, classId, graph);
  } else if (child.type === "class_specifier") {
    extractClass(child, filePath, moduleId, graph);
  } else if (child.type === "struct_specifier") {
    extractStruct(child, filePath, moduleId, graph);
  } else if (child.type === "enum_specifier") {
    extractEnum(child, filePath, moduleId, graph);
  } else if (child.type === "template_declaration") {
    visitTemplateBody(child, filePath, moduleId, classId, graph);
  }
}

/** Visit the body of a template_declaration. */
function visitTemplateBody(
  node: Node,
  filePath: string,
  moduleId: string,
  classId: string | null,
  graph: CodeGraph,
): void {
  for (const child of node.children) {
    if (child.type === "function_definition") {
      extractFunction(child, filePath, moduleId, classId, graph, node);
    } else if (child.type === "class_specifier") {
      extractClass(child, filePath, moduleId, graph, node);
    } else if (child.type === "struct_specifier") {
      extractStruct(child, filePath, moduleId, graph, node);
    } else if (child.type === "declaration" || child.type === "type_definition") {
      visitTopLevelNode(child, filePath, moduleId, classId, graph);
    }
  }
}

/** Extract a namespace definition and its contents. */
function extractNamespace(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const nsName = nodeText(nameNode);
  const nsId = `${moduleId}:${nsName}`;
  graph.nodes.set(
    nsId,
    codeUnit({ id: nsId, name: nsName, kind: "namespace", location: makeLocation(node, filePath) }),
  );
  addContainsEdge(graph, moduleId, nsId);

  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) visitTopLevelNode(child, filePath, moduleId, null, graph);
}

/** Extract class, struct, or enum from a declaration. */
function extractTypeDef(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "class_specifier") extractClass(child, filePath, moduleId, graph);
    else if (child.type === "struct_specifier") extractStruct(child, filePath, moduleId, graph);
    else if (child.type === "enum_specifier") extractEnum(child, filePath, moduleId, graph);
  }
}

/** Extract a class definition and its methods. */
function extractClass(
  node: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
  genericNode: Node | null = null,
): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const className = nodeText(nameNode);
  const classId = `${moduleId}:${className}`;
  graph.nodes.set(
    classId,
    codeUnit({
      id: classId,
      name: className,
      kind: "class",
      location: makeLocation(node, filePath),
      typeParameters: extractTypeParameters(genericNode ?? node),
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, moduleId, classId);

  extractBaseClasses(node, classId, moduleId, graph);
  visitClassBody(node, filePath, moduleId, classId, graph);
}

/** Extract INHERITS edges from base_class_clause. */
function extractBaseClasses(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "base_class_clause") {
      processBaseClause(child, classId, moduleId, graph);
      return;
    }
  }
}

function processBaseClause(clause: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of clause.children) {
    if (child.type === "type_identifier") {
      graph.edges.push(
        codeEdge({
          sourceId: classId,
          targetId: `${moduleId}:${nodeText(child)}`,
          kind: "inherits",
          confidence: "inferred",
        }),
      );
    }
  }
}

/** Visit children of a class body for methods. */
function visitClassBody(node: Node, filePath: string, moduleId: string, classId: string, graph: CodeGraph): void {
  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (child.type === "function_definition") {
      extractFunction(child, filePath, moduleId, classId, graph);
    } else if (child.type === "declaration") {
      checkInlineMethod(child, filePath, moduleId, classId, graph);
    }
  }
}

/** Check if a declaration contains an inline method. */
function checkInlineMethod(node: Node, filePath: string, moduleId: string, classId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "function_definition") extractFunction(child, filePath, moduleId, classId, graph);
  }
}

function extractStruct(
  node: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
  genericNode: Node | null = null,
): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const structName = nodeText(nameNode);
  const structId = `${moduleId}:${structName}`;
  graph.nodes.set(
    structId,
    codeUnit({
      id: structId,
      name: structName,
      kind: "struct",
      location: makeLocation(node, filePath),
      typeParameters: extractTypeParameters(genericNode ?? node),
    }),
  );
  addContainsEdge(graph, moduleId, structId);
}

function extractEnum(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const enumName = nodeText(nameNode);
  const enumId = `${moduleId}:${enumName}`;
  graph.nodes.set(
    enumId,
    codeUnit({ id: enumId, name: enumName, kind: "enum", location: makeLocation(node, filePath) }),
  );
  addContainsEdge(graph, moduleId, enumId);
}

/** Extract a C++ function or method definition. */
function extractFunction(
  node: Node,
  filePath: string,
  moduleId: string,
  classId: string | null,
  graph: CodeGraph,
  genericNode: Node | null = null,
): void {
  const funcName = getFunctionName(node);
  if (!funcName) return;

  let funcId: string;
  let kind: NodeKind;
  let containerId: string;
  if (classId !== null) {
    funcId = `${classId}.${funcName}`;
    kind = "method";
    containerId = classId;
  } else {
    funcId = `${moduleId}:${funcName}`;
    kind = "function";
    containerId = moduleId;
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
      typeParameters: extractTypeParameters(genericNode ?? node),
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, containerId, funcId);

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
  if (callName.includes(".") || callName.includes("->") || callName.includes("::")) return "inferred";
  return "certain";
}

function resolveCallTarget(callName: string, moduleId: string): string {
  if (callName.includes("::") || callName.includes(".") || callName.includes("->")) return callName;
  return `${moduleId}:${callName}`;
}

/**
 * Extract function name from a C++ function_definition.
 *
 * Handles nested declarator structures including function_declarator,
 * pointer_declarator, and reference_declarator.
 */
function getFunctionName(node: Node): string {
  const declarator = node.childForFieldName("declarator");
  if (declarator === null) return "";
  return digIdentifier(declarator);
}

/** Recursively dig through declarator nodes for the name. */
function digIdentifier(node: Node): string {
  if (node.type === "identifier") return nodeText(node);
  if (node.type === "field_identifier") return nodeText(node);
  if (node.type === "qualified_identifier" || node.type === "scoped_identifier") return nodeText(node);
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
 * Extract a doc comment preceding a function or class.
 *
 * Looks for /** ... *\/ or /// style comments immediately before the node.
 */
function extractDocstring(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev === null || prev.type !== "comment") return null;
  const text = nodeText(prev);
  if (text.startsWith("/**") || text.startsWith("///")) return cleanCppDocstring(text);
  return null;
}

/** Strip C++ doc-comment delimiters. */
function cleanCppDocstring(text: string): string {
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
