/** Python language parser (port of ``parsers/python/parser.py``). */

import { codeEdge } from "../models/edges.js";
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
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "with_statement",
  "boolean_operator",
  "conditional_expression",
  "case_clause",
]);

const THROW_TYPES = new Set(["raise_statement"]);

export class PythonParser implements LanguageParser {
  readonly language = "python";
  readonly extensions = [".py"] as const;
  readonly grammars = ["python"] as const;

  parseFile(filePath: string, source: string): CodeGraph {
    const tree = parseWithGrammar("python", source);
    try {
      const graph = new CodeGraph({ language: "python", rootPath: filePath });
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

function visitTopLevelNode(child: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  if (child.type === "decorated_definition") {
    for (const sub of child.children) {
      if (sub.type === "function_definition" || sub.type === "class_definition") {
        visitTopLevelNode(sub, filePath, moduleId, graph);
      }
    }
  } else if (child.type === "function_definition") {
    extractFunction(child, filePath, moduleId, null, graph);
  } else if (child.type === "class_definition") {
    extractClass(child, filePath, moduleId, graph);
  } else if (child.type === "import_statement" || child.type === "import_from_statement") {
    extractImport(child, graph);
  }
}

function extractClass(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
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
      typeParameters: extractTypeParameters(node),
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, moduleId, classId);
  extractBaseClasses(node, classId, moduleId, graph);

  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    let actual: Node | null = child;
    if (child.type === "decorated_definition") {
      actual = child.children.find((sub) => sub.type === "function_definition") ?? null;
      if (actual === null) continue;
    }
    if (actual.type === "function_definition") extractFunction(actual, filePath, moduleId, classId, graph);
  }
}

function extractBaseClasses(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  const argList = node.childForFieldName("superclasses");
  if (argList === null) return;
  for (const child of argList.children) {
    if (child.type === "identifier") {
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

function extractFunction(
  node: Node,
  filePath: string,
  moduleId: string,
  classId: string | null,
  graph: CodeGraph,
): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const funcName = nodeText(nameNode);

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
    collectBodyInfo(body, filePath, BRANCH_NODE_TYPES, "call", THROW_TYPES, branches, exceptionTypes, calls);
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
      typeParameters: extractTypeParameters(node),
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, containerId, funcId);

  for (const [callName, callNode] of calls) {
    const confidence = !callName.includes(".") || callName.startsWith("self.") ? "certain" : "inferred";
    graph.edges.push(
      codeEdge({
        sourceId: funcId,
        targetId: resolveCallTarget(callName, moduleId, classId),
        kind: "calls",
        confidence,
        location: makeLocation(callNode, filePath),
      }),
    );
  }
}

function extractParameters(node: Node): Parameter[] {
  const paramsNode = node.childForFieldName("parameters");
  if (paramsNode === null) return [];
  const params: Parameter[] = [];
  for (const child of paramsNode.children) {
    if (child.type === "identifier") {
      const name = nodeText(child);
      if (name !== "self" && name !== "cls") params.push(parameter(name));
    } else if (child.type === "typed_parameter") {
      params.push(parameter(paramNameFromTyped(child), { typeRef: typeFromAnnotation(child) }));
    } else if (child.type === "default_parameter") {
      const [name, def] = parseDefaultParam(child);
      params.push(parameter(name, { default: def }));
    } else if (child.type === "typed_default_parameter") {
      const [name, type, def] = parseTypedDefault(child);
      params.push(parameter(name, { typeRef: type, default: def }));
    }
  }
  return params;
}

function paramNameFromTyped(node: Node): string {
  for (const child of node.children) if (child.type === "identifier") return nodeText(child);
  return "";
}

function typeFromAnnotation(node: Node): TypeRef | null {
  for (const child of node.children) if (child.type === "type") return parseTypeNode(child);
  return null;
}

function parseTypeNode(typeNode: Node): TypeRef {
  if (typeNode.children.length === 1) {
    const inner = typeNode.children[0]!;
    if (inner.type === "identifier") return typeRef(nodeText(inner));
    if (inner.type === "none") return typeRef("None");
    if (inner.type === "generic_type") return parseGenericType(inner);
    if (inner.type === "union_type") return typeRef(nodeText(typeNode));
  }
  return typeRef(nodeText(typeNode));
}

function parseGenericType(node: Node): TypeRef {
  let name = "";
  const args: TypeRef[] = [];
  for (const child of node.children) {
    if (child.type === "identifier") name = nodeText(child);
    else if (child.type === "type_parameter") {
      for (const sub of child.children) if (sub.type === "type") args.push(parseTypeNode(sub));
    }
  }
  return typeRef(name, { genericArgs: args });
}

function parseDefaultParam(node: Node): [string, string] {
  let name = "";
  let def = "";
  for (const child of node.children) {
    if (child.type === "identifier" && !name) name = nodeText(child);
    else if (child.type === "=") continue;
    else if (name) def = nodeText(child);
  }
  return [name, def];
}

function parseTypedDefault(node: Node): [string, TypeRef | null, string] {
  let name = "";
  let type: TypeRef | null = null;
  let def = "";
  let seenEq = false;
  for (const child of node.children) {
    if (child.type === "identifier" && !name) name = nodeText(child);
    else if (child.type === "type") type = parseTypeNode(child);
    else if (child.type === "=") seenEq = true;
    else if (seenEq) def = nodeText(child);
  }
  return [name, type, def];
}

function extractReturnType(node: Node): TypeRef | null {
  const rt = node.childForFieldName("return_type");
  return rt === null ? null : parseTypeNode(rt);
}

function extractDocstring(node: Node): string | null {
  const body = node.childForFieldName("body");
  if (body === null || body.children.length === 0) return null;
  const first = body.children[0]!;
  if (first.type === "expression_statement") {
    const expr = first.children[0];
    if (expr !== undefined && expr.type === "string") return cleanDocstring(nodeText(expr));
  }
  if (first.type === "string") return cleanDocstring(nodeText(first));
  return null;
}

function cleanDocstring(text: string): string {
  let t = text;
  if (t.startsWith('"""') || t.startsWith("'''")) t = t.slice(3, -3);
  else if (t.startsWith('"') || t.startsWith("'")) t = t.slice(1, -1);
  return t.trim();
}

function resolveCallTarget(callName: string, moduleId: string, classId: string | null): string {
  if (callName.startsWith("self.") && classId !== null) return `${classId}.${callName.slice(5)}`;
  if (!callName.includes(".")) return `${moduleId}:${callName}`;
  return callName;
}

function extractImport(node: Node, graph: CodeGraph): void {
  const parts = nodeText(node).split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    const moduleName = parts[1]!.split(".")[0]!;
    if (!graph.dependencies.includes(moduleName)) graph.dependencies.push(moduleName);
  }
}
