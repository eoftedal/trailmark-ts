/** JavaScript language parser (port of ``parsers/javascript/parser.py``). */

import { codeEdge, type EdgeConfidence } from "../models/edges.js";
import { CodeGraph } from "../models/graph.js";
import { codeUnit, parameter, type BranchInfo, type NodeKind, type Parameter, type TypeRef } from "../models/nodes.js";
import { parseWithGrammar } from "../treesitter.js";
import type { LanguageParser, ParserOptions } from "./base.js";
import { extractTopLevelCode } from "./js-toplevel.js";
import {
  addContainsEdge,
  addModuleNode,
  collectBodyInfo,
  computeComplexity,
  makeLocation,
  moduleIdFromPath,
  nodeText,
  type Node,
} from "./common.js";

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
]);

const THROW_TYPES = new Set(["throw_statement"]);

const FUNCTION_DECL_TYPES = new Set(["function_declaration", "generator_function_declaration"]);

const FUNCTION_EXPR_TYPES = new Set(["arrow_function", "function", "function_expression"]);

export class JavaScriptParser implements LanguageParser {
  readonly language = "javascript";
  readonly extensions = [".js", ".jsx", ".mjs", ".cjs"] as const;
  readonly grammars = ["javascript"] as const;

  parseFile(filePath: string, source: string, options: ParserOptions = {}): CodeGraph {
    const tree = parseWithGrammar("javascript", source);
    try {
      const graph = new CodeGraph({ language: "javascript", rootPath: filePath });
      const moduleId = moduleIdFromPath(filePath);
      visitModule(tree.rootNode, filePath, moduleId, graph);
      // Not in upstream: anonymous callbacks and top-level calls (see js-toplevel.ts).
      if (!options.upstreamCompat) extractTopLevel(tree.rootNode, filePath, moduleId, graph);
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
  if (FUNCTION_DECL_TYPES.has(child.type)) {
    extractFunction(child, filePath, moduleId, null, graph);
  } else if (child.type === "class_declaration") {
    extractClass(child, filePath, moduleId, graph);
  } else if (child.type === "import_statement") {
    extractImport(child, graph);
  } else if (child.type === "export_statement") {
    visitExport(child, filePath, moduleId, graph);
  } else if (child.type === "lexical_declaration" || child.type === "variable_declaration") {
    visitLexicalDecl(child, filePath, moduleId, graph);
  } else if (child.type === "expression_statement") {
    visitExpressionStmt(child, filePath, moduleId, graph);
  }
}

/** Handle export statements that wrap declarations. */
function visitExport(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) visitTopLevelNode(child, filePath, moduleId, graph);
}

/** Handle const/let/var declarations that may assign functions. */
function visitLexicalDecl(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "variable_declarator") tryExtractFuncFromDeclarator(child, filePath, moduleId, graph);
  }
}

/** Handle expression statements containing assignments. */
function visitExpressionStmt(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "assignment_expression") tryExtractFuncFromAssignment(child, filePath, moduleId, graph);
  }
}

/** Extract a function from `const name = () => ...`. */
function tryExtractFuncFromDeclarator(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  const valueNode = node.childForFieldName("value");
  if (nameNode === null || valueNode === null) return;
  if (FUNCTION_EXPR_TYPES.has(valueNode.type)) {
    extractFunctionExpr(valueNode, nameNode, filePath, moduleId, graph);
  }
}

/** Extract a function from `name = function() {...}`. */
function tryExtractFuncFromAssignment(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left === null || right === null) return;
  if (left.type === "identifier" && FUNCTION_EXPR_TYPES.has(right.type)) {
    extractFunctionExpr(right, left, filePath, moduleId, graph);
  }
}

function collectBody(body: Node | null, filePath: string) {
  const branches: BranchInfo[] = [];
  const exceptionTypes: TypeRef[] = [];
  const calls: [string, Node][] = [];
  if (body !== null) {
    collectBodyInfo(body, filePath, BRANCH_NODE_TYPES, "call_expression", THROW_TYPES, branches, exceptionTypes, calls);
  }
  return { branches, exceptionTypes, calls };
}

/** Extract a function expression assigned to a named variable. */
function extractFunctionExpr(
  funcNode: Node,
  nameNode: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
): void {
  const funcName = nodeText(nameNode);
  const funcId = `${moduleId}:${funcName}`;
  const params = extractParameters(funcNode);
  const { branches, exceptionTypes, calls } = collectBody(funcNode.childForFieldName("body"), filePath);

  graph.nodes.set(
    funcId,
    codeUnit({
      id: funcId,
      name: funcName,
      kind: "function",
      location: makeLocation(funcNode, filePath),
      parameters: params,
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      exceptionTypes,
      docstring: extractJsdoc(funcNode),
    }),
  );
  addContainsEdge(graph, moduleId, funcId);
  addCallEdges(calls, funcId, moduleId, null, filePath, graph);
}

/** Extract a class declaration and its methods. */
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
      docstring: extractJsdoc(node),
    }),
  );
  addContainsEdge(graph, moduleId, classId);

  extractHeritage(node, classId, moduleId, graph);

  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (child.type === "method_definition") extractMethod(child, filePath, moduleId, classId, graph);
  }
}

/** Extract inheritance from class_heritage. */
function extractHeritage(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "class_heritage") addInheritsFromHeritage(child, classId, moduleId, graph);
  }
}

/** Add INHERITS edges from a class_heritage node. */
function addInheritsFromHeritage(heritage: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of heritage.children) {
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

/** Extract a method definition from a class body. */
function extractMethod(node: Node, filePath: string, moduleId: string, classId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const methodName = nodeText(nameNode);
  const methodId = `${classId}.${methodName}`;

  const params = extractParameters(node);
  const { branches, exceptionTypes, calls } = collectBody(node.childForFieldName("body"), filePath);

  graph.nodes.set(
    methodId,
    codeUnit({
      id: methodId,
      name: methodName,
      kind: "method",
      location: makeLocation(node, filePath),
      parameters: params,
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      exceptionTypes,
      docstring: extractJsdoc(node),
    }),
  );
  addContainsEdge(graph, classId, methodId);
  addCallEdges(calls, methodId, moduleId, classId, filePath, graph);
}

/** Extract a function or generator function declaration. */
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
  const { branches, exceptionTypes, calls } = collectBody(node.childForFieldName("body"), filePath);

  graph.nodes.set(
    funcId,
    codeUnit({
      id: funcId,
      name: funcName,
      kind,
      location: makeLocation(node, filePath),
      parameters: params,
      cyclomaticComplexity: computeComplexity(branches),
      branches,
      exceptionTypes,
      docstring: extractJsdoc(node),
    }),
  );
  addContainsEdge(graph, containerId, funcId);
  addCallEdges(calls, funcId, moduleId, classId, filePath, graph);
}

/** Extract parameters from a function or method. */
function extractParameters(node: Node): Parameter[] {
  const paramsNode = node.childForFieldName("parameters");
  if (paramsNode === null) return [];
  const params: Parameter[] = [];
  for (const child of paramsNode.children) {
    if (child.type === "identifier") {
      params.push(parameter(nodeText(child)));
    } else if (child.type === "assignment_pattern") {
      const [name, def] = parseAssignmentPattern(child);
      params.push(parameter(name, { default: def }));
    } else if (child.type === "rest_pattern") {
      appendRestParam(child, params);
    }
  }
  return params;
}

/** Parse name and default from an assignment_pattern node. */
function parseAssignmentPattern(node: Node): [string, string] {
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  return [left ? nodeText(left) : "", right ? nodeText(right) : ""];
}

/** Append a rest parameter (...args) to the params list. */
function appendRestParam(node: Node, params: Parameter[]): void {
  for (const child of node.children) {
    if (child.type === "identifier") params.push(parameter(`...${nodeText(child)}`));
  }
}

/** Extract JSDoc comment preceding a definition node. */
function extractJsdoc(node: Node): string | null {
  const prev = node.previousNamedSibling;
  if (prev !== null && prev.type === "comment") {
    const text = nodeText(prev);
    if (text.startsWith("/**")) return cleanJsdoc(text);
  }
  return null;
}

/** Strip JSDoc delimiters and leading asterisks. */
function cleanJsdoc(text: string): string {
  let t = text;
  if (t.startsWith("/**")) t = t.slice(3);
  if (t.endsWith("*/")) t = t.slice(0, -2);
  const cleaned: string[] = [];
  for (const line of t.split("\n")) {
    let stripped = line.trim();
    if (stripped.startsWith("* ")) stripped = stripped.slice(2);
    else if (stripped === "*") stripped = "";
    cleaned.push(stripped);
  }
  return cleaned.join("\n").trim();
}

/** Add CALLS edges from collected call information. */
function addCallEdges(
  calls: [string, Node][],
  sourceId: string,
  moduleId: string,
  classId: string | null,
  filePath: string,
  graph: CodeGraph,
): void {
  for (const [callName, callNode] of calls) {
    graph.edges.push(
      codeEdge({
        sourceId,
        targetId: resolveCallTarget(callName, moduleId, classId),
        kind: "calls",
        confidence: callConfidence(callName),
        location: makeLocation(callNode, filePath),
      }),
    );
  }
}

/** Determine confidence level for a call. */
function callConfidence(callName: string): EdgeConfidence {
  if (!callName.includes(".")) return "certain";
  if (callName.startsWith("this.")) return "certain";
  return "inferred";
}

/** Resolve a call name to a target node ID (best effort). */
function resolveCallTarget(callName: string, moduleId: string, classId: string | null): string {
  if (callName.startsWith("this.") && classId !== null) return `${classId}.${callName.slice(5)}`;
  if (!callName.includes(".")) return `${moduleId}:${callName}`;
  return callName;
}

/** Extract import statements as dependency info. */
function extractImport(node: Node, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "string") {
      addDependency(stripQuotes(nodeText(child)), graph);
      return;
    }
  }
}

/** Remove surrounding quotes from a string literal. */
function stripQuotes(text: string): string {
  if (text.length >= 2 && (text[0] === '"' || text[0] === "'" || text[0] === "`")) return text.slice(1, -1);
  return text;
}

/** Add a module dependency if not already present. */
function addDependency(moduleName: string, graph: CodeGraph): void {
  const base = moduleName.split("/")[0]!;
  if (base && !graph.dependencies.includes(base)) graph.dependencies.push(base);
}

/** Beyond upstream: extract anonymous callbacks and top-level calls via ``extractTopLevelCode``. */
function extractTopLevel(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  extractTopLevelCode(root, moduleId, graph, {
    addCallback(fn, funcId, name, attributes) {
      // Expression-bodied arrows (``x => x.go()``) have no block; collect from the function itself.
      const body = fn.childForFieldName("body");
      const collectFrom = body !== null && body.type === "statement_block" ? body : fn;
      const { branches, exceptionTypes, calls } = collectBody(collectFrom, filePath);
      graph.nodes.set(
        funcId,
        codeUnit({
          id: funcId,
          name,
          kind: "function",
          location: makeLocation(fn, filePath),
          parameters: extractParameters(fn),
          cyclomaticComplexity: computeComplexity(branches),
          branches,
          exceptionTypes,
          docstring: extractJsdoc(fn),
          attributes,
        }),
      );
      addContainsEdge(graph, moduleId, funcId);
      addCallEdges(calls, funcId, moduleId, null, filePath, graph);
    },
    addModuleCalls(calls) {
      addCallEdges(calls, moduleId, moduleId, null, filePath, graph);
    },
  });
}
