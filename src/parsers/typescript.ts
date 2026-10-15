/** TypeScript language parser (port of ``parsers/typescript/parser.py``). */

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
import type { LanguageParser, ParserOptions } from "./base.js";
import { extractTopLevelCode } from "./js-toplevel.js";
import {
  addContainsEdge,
  addModuleNode,
  collectBodyInfo,
  computeComplexity,
  extractTypeParameters,
  makeLocation,
  moduleIdFromPath,
  nodeText,
  splitOnce,
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
const FUNCTION_SCOPE_TYPES = new Set([...FUNCTION_DECL_TYPES, ...FUNCTION_EXPR_TYPES, "method_definition"]);

/** Parses TypeScript source files into CodeGraph. Upstream uses the "typescript" grammar for .ts and .tsx. */
export class TypeScriptParser implements LanguageParser {
  readonly language = "typescript";
  readonly extensions = [".ts", ".tsx"] as const;
  readonly grammars = ["typescript"] as const;

  parseFile(filePath: string, source: string, options: ParserOptions = {}): CodeGraph {
    const tree = parseWithGrammar("typescript", source);
    try {
      const graph = new CodeGraph({ language: "typescript", rootPath: filePath });
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
  } else if (child.type === "interface_declaration") {
    extractInterface(child, filePath, moduleId, graph);
  } else if (child.type === "enum_declaration") {
    extractEnum(child, filePath, moduleId, graph);
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
  if (FUNCTION_EXPR_TYPES.has(valueNode.type)) extractFunctionExpr(valueNode, nameNode, filePath, moduleId, graph);
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

function collectInfo(body: Node | null, filePath: string): [BranchInfo[], TypeRef[], [string, Node][]] {
  const branches: BranchInfo[] = [];
  const exceptionTypes: TypeRef[] = [];
  const calls: [string, Node][] = [];
  if (body !== null) {
    collectBodyInfo(body, filePath, BRANCH_NODE_TYPES, "call_expression", THROW_TYPES, branches, exceptionTypes, calls);
  }
  return [branches, exceptionTypes, calls];
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
  const returnType = extractReturnType(funcNode);
  const [branches, exceptionTypes, calls] = collectInfo(funcNode.childForFieldName("body"), filePath);

  graph.nodes.set(
    funcId,
    codeUnit({
      id: funcId,
      name: funcName,
      kind: "function",
      location: makeLocation(funcNode, filePath),
      parameters: params,
      returnType,
      typeParameters: extractTypeParameters(funcNode),
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
      typeParameters: extractTypeParameters(node),
      docstring: extractJsdoc(node),
    }),
  );
  addContainsEdge(graph, moduleId, classId);

  extractHeritage(node, classId, moduleId, graph);
  extractImplements(node, classId, moduleId, graph);

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

/** Add INHERITS edges from extends clause in class_heritage. */
function addInheritsFromHeritage(heritage: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of heritage.children) {
    if (child.type === "extends_clause") addInheritsFromExtends(child, classId, moduleId, graph);
  }
}

/** Add INHERITS edge from an extends_clause node. */
function addInheritsFromExtends(extendsNode: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of extendsNode.children) {
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

/** Extract IMPLEMENTS edges from implements_clause. */
function extractImplements(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "class_heritage") {
      for (const sub of child.children) {
        if (sub.type === "implements_clause") addImplementsEdges(sub, classId, moduleId, graph);
      }
    }
  }
}

/** Add IMPLEMENTS edges from an implements_clause node. */
function addImplementsEdges(clause: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of clause.children) {
    if (child.type === "type_identifier" || child.type === "identifier") {
      graph.edges.push(
        codeEdge({
          sourceId: classId,
          targetId: `${moduleId}:${nodeText(child)}`,
          kind: "implements",
          confidence: "certain",
        }),
      );
    } else if (child.type === "generic_type") {
      addImplementsFromGeneric(child, classId, moduleId, graph);
    }
  }
}

/** Add IMPLEMENTS edge from a generic_type node. */
function addImplementsFromGeneric(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "type_identifier" || child.type === "identifier") {
      graph.edges.push(
        codeEdge({
          sourceId: classId,
          targetId: `${moduleId}:${nodeText(child)}`,
          kind: "implements",
          confidence: "certain",
        }),
      );
      return;
    }
  }
}

/** Extract an interface declaration. */
function extractInterface(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const ifaceName = nodeText(nameNode);
  const ifaceId = `${moduleId}:${ifaceName}`;

  graph.nodes.set(
    ifaceId,
    codeUnit({
      id: ifaceId,
      name: ifaceName,
      kind: "interface",
      location: makeLocation(node, filePath),
      typeParameters: extractTypeParameters(node),
      docstring: extractJsdoc(node),
    }),
  );
  addContainsEdge(graph, moduleId, ifaceId);

  extractInterfaceMethods(node, filePath, ifaceId, graph);
}

/** Extract method signatures from an interface body. */
function extractInterfaceMethods(node: Node, filePath: string, ifaceId: string, graph: CodeGraph): void {
  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (child.type === "method_signature" || child.type === "property_signature") {
      extractInterfaceMember(child, filePath, ifaceId, graph);
    }
  }
}

/** Extract a single interface member signature. */
function extractInterfaceMember(node: Node, filePath: string, ifaceId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const memberName = nodeText(nameNode);
  const memberId = `${ifaceId}.${memberName}`;
  graph.nodes.set(
    memberId,
    codeUnit({ id: memberId, name: memberName, kind: "method", location: makeLocation(node, filePath) }),
  );
  addContainsEdge(graph, ifaceId, memberId);
}

/** Extract an enum declaration. */
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

/** Extract a method definition from a class body. */
function extractMethod(node: Node, filePath: string, moduleId: string, classId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const methodName = nodeText(nameNode);
  const methodId = `${classId}.${methodName}`;

  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const [branches, exceptionTypes, calls] = collectInfo(node.childForFieldName("body"), filePath);

  graph.nodes.set(
    methodId,
    codeUnit({
      id: methodId,
      name: methodName,
      kind: "method",
      location: makeLocation(node, filePath),
      parameters: params,
      returnType,
      typeParameters: extractTypeParameters(node),
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
  const returnType = extractReturnType(node);
  const [branches, exceptionTypes, calls] = collectInfo(node.childForFieldName("body"), filePath);

  graph.nodes.set(
    funcId,
    codeUnit({
      id: funcId,
      name: funcName,
      kind,
      location: makeLocation(node, filePath),
      parameters: params,
      returnType,
      typeParameters: extractTypeParameters(node),
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
  for (const child of paramsNode.children) processParamChild(child, params);
  return params;
}

/** Process a single child of a formal_parameters node. */
function processParamChild(child: Node, params: Parameter[]): void {
  if (child.type === "identifier") {
    params.push(parameter(nodeText(child)));
  } else if (child.type === "required_parameter") {
    appendTypedParam(child, params);
  } else if (child.type === "optional_parameter") {
    appendOptionalParam(child, params);
  } else if (child.type === "assignment_pattern") {
    const [name, def] = parseAssignmentPattern(child);
    params.push(parameter(name, { default: def }));
  } else if (child.type === "rest_pattern") {
    appendRestParam(child, params);
  }
}

/** Extract a required_parameter with optional type annotation. */
function appendTypedParam(node: Node, params: Parameter[]): void {
  let name = "";
  let type: TypeRef | null = null;
  for (const child of node.children) {
    if (child.type === "identifier" && !name) name = nodeText(child);
    else if (child.type === "type_annotation") type = parseTypeAnnotation(child);
  }
  if (name) params.push(parameter(name, { typeRef: type }));
}

/** Extract an optional_parameter with type and/or default. */
function appendOptionalParam(node: Node, params: Parameter[]): void {
  let name = "";
  let type: TypeRef | null = null;
  let def: string | null = null;
  for (const child of node.children) {
    if (child.type === "identifier" && !name) name = nodeText(child);
    else if (child.type === "type_annotation") type = parseTypeAnnotation(child);
    else if (child.type === "?") continue;
    else if (name && child.type !== ":" && child.type !== "?" && def === null) def = nodeText(child);
  }
  if (name) params.push(parameter(name, { typeRef: type, default: def }));
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

/** Extract a TypeRef from a type_annotation node. */
function parseTypeAnnotation(node: Node): TypeRef | null {
  for (const child of node.children) {
    if (child.type === ":") continue;
    return parseTypeChild(child);
  }
  return null;
}

/** Parse a type node into a TypeRef. */
function parseTypeChild(node: Node): TypeRef {
  if (node.type === "predefined_type") return typeRef(nodeText(node));
  if (node.type === "type_identifier") return typeRef(nodeText(node));
  if (node.type === "generic_type") return parseGenericType(node);
  return typeRef(nodeText(node));
}

/** Parse a generic type like Array<number> into a TypeRef. */
function parseGenericType(node: Node): TypeRef {
  let name = "";
  const args: TypeRef[] = [];
  for (const child of node.children) {
    if (child.type === "type_identifier" || child.type === "identifier") {
      name = nodeText(child);
    } else if (child.type === "type_arguments") {
      for (const sub of child.children) {
        if (sub.type !== "<" && sub.type !== ">" && sub.type !== ",") args.push(parseTypeChild(sub));
      }
    }
  }
  return typeRef(name, { genericArgs: args });
}

/** Extract return type annotation from a function definition. */
function extractReturnType(node: Node): TypeRef | null {
  const returnType = node.childForFieldName("return_type");
  if (returnType !== null) return parseTypeAnnotation(returnType);
  for (const child of node.children) {
    if (child.type === "type_annotation") return parseTypeAnnotation(child);
  }
  return null;
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
    let stripped = pyStripWs(line);
    if (stripped.startsWith("* ")) stripped = stripped.slice(2);
    else if (stripped === "*") stripped = "";
    cleaned.push(stripped);
  }
  return pyStripWs(cleaned.join("\n"));
}

const PY_WS = "[\\t-\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]";
const PY_WS_EDGES = new RegExp(`^${PY_WS}+|${PY_WS}+$`, "g");

/** Python ``str.strip()`` (no args): strips Python whitespace, not JS's wider set. */
function pyStripWs(s: string): string {
  return s.replace(PY_WS_EDGES, "");
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
    const targetId =
      resolveConcreteReceiver(callName, callNode, moduleId) ?? resolveCallTarget(callName, moduleId, classId);
    graph.edges.push(
      codeEdge({
        sourceId,
        targetId,
        kind: "calls",
        confidence: callConfidence(callName),
        location: makeLocation(callNode, filePath),
      }),
    );
  }
}

/**
 * Resolve ``receiver.method()`` when receiver is assigned ``new Class``.
 *
 * This deliberately handles only direct construction/assignment in the
 * enclosing function. Manifest tables and arbitrary dynamic dispatch remain
 * unresolved rather than being guessed.
 */
function resolveConcreteReceiver(callName: string, callNode: Node, moduleId: string): string | null {
  if (callName.split(".").length - 1 !== 1) return null;
  const [receiver, method] = splitOnce(callName, ".") as [string, string];
  if (receiver === "this") return null;
  const scope = nearestFunctionScope(callNode);
  if (scope === null) return null;
  const concreteClass = latestReceiverAssignment(scope, callNode, receiver);
  if (concreteClass === null) return null;
  return `${moduleId}:${concreteClass}.${method}`;
}

function nearestFunctionScope(node: Node): Node | null {
  let current = node.parent;
  while (current !== null && !FUNCTION_SCOPE_TYPES.has(current.type)) current = current.parent;
  return current;
}

function latestReceiverAssignment(scope: Node, callNode: Node, receiver: string): string | null {
  let latest: string | null = null;
  for (const node of walkNodes(scope)) {
    if (node.startIndex >= callNode.startIndex) continue;
    if (nearestFunctionScope(node)?.id !== scope.id) continue;
    const concreteClass = receiverAssignmentClass(node, receiver);
    if (concreteClass !== null) latest = concreteClass;
  }
  return latest;
}

function receiverAssignmentClass(node: Node, receiver: string): string | null {
  let assigned: Node | null;
  let value: Node | null;
  if (node.type === "variable_declarator") {
    assigned = node.childForFieldName("name");
    value = node.childForFieldName("value");
  } else if (node.type === "assignment_expression") {
    assigned = node.childForFieldName("left");
    value = node.childForFieldName("right");
  } else {
    return null;
  }
  if (assigned === null || value === null) return null;
  if (assigned.type !== "identifier" || nodeText(assigned) !== receiver) return null;
  return newExpressionClass(value);
}

function newExpressionClass(node: Node): string | null {
  if (node.type !== "new_expression") return null;
  for (const child of node.namedChildren) {
    if (child.type === "identifier") return nodeText(child);
  }
  return null;
}

function walkNodes(root: Node): Node[] {
  const result: Node[] = [];
  const stack = [...root.namedChildren].reverse();
  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return result;
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
      const [branches, exceptionTypes, calls] = collectInfo(collectFrom, filePath);
      graph.nodes.set(
        funcId,
        codeUnit({
          id: funcId,
          name,
          kind: "function",
          location: makeLocation(fn, filePath),
          parameters: extractParameters(fn),
          returnType: extractReturnType(fn),
          typeParameters: extractTypeParameters(fn),
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
