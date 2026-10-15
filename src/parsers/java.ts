/** Java language parser (port of ``parsers/java/parser.py``). */

import { codeEdge, type EdgeConfidence } from "../models/edges.js";
import { CodeGraph } from "../models/graph.js";
import {
  branchInfo,
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
import {
  addContainsEdge,
  addModuleNode,
  computeComplexity,
  extractTypeParameters,
  makeLocation,
  moduleIdFromPath,
  nodeText,
  type Node,
} from "./common.js";
import { javaReceiverType } from "./java-receivers.js";

const BRANCH_NODE_TYPES = new Set([
  "if_statement",
  "for_statement",
  "enhanced_for_statement",
  "while_statement",
  "do_statement",
  "switch_block_statement_group",
  "catch_clause",
  "ternary_expression",
  "conditional_expression",
]);

const THROW_TYPES = new Set(["throw_statement"]);

const CLASS_NODE_KINDS: ReadonlyMap<string, NodeKind> = new Map<string, NodeKind>([
  ["class_declaration", "class"],
  ["interface_declaration", "interface"],
  ["enum_declaration", "enum"],
]);

const FUNCTION_TYPES = new Set(["method_declaration", "constructor_declaration"]);

export class JavaParser implements LanguageParser {
  readonly language = "java";
  readonly extensions = [".java"] as const;
  readonly grammars = ["java"] as const;

  parseFile(filePath: string, source: string, options: ParserOptions = {}): CodeGraph {
    const tree = parseWithGrammar("java", source);
    beyondUpstream = !options.upstreamCompat;
    try {
      const graph = new CodeGraph({ language: "java", rootPath: filePath });
      visitModule(tree.rootNode, filePath, moduleIdFromPath(filePath), graph);
      return graph;
    } finally {
      beyondUpstream = false;
      tree.delete();
    }
  }
}

/**
 * Not in upstream; set when ``upstreamCompat`` is off. Enables:
 * - ``receiver_type`` attributes on call edges, for ``resolveReceiverTypes``;
 * - records (with synthetic accessor methods and compact constructors), nested
 *   types (``module:Outer.Inner``) and methods declared in enum bodies, all of
 *   which upstream skips.
 * Parsing is synchronous, so module state scoped to ``parseFile`` is safe.
 */
let beyondUpstream = false;

const RECORD_DECLARATION = "record_declaration";

/** Class-like declaration kinds; records only beyond upstream. */
function classKind(nodeType: string): NodeKind | undefined {
  if (beyondUpstream && nodeType === RECORD_DECLARATION) return "class";
  return CLASS_NODE_KINDS.get(nodeType);
}

/** Walk the top-level of a module, extracting nodes and edges. */
function visitModule(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  addModuleNode(root, filePath, moduleId, graph);
  for (const child of root.children) visitTopLevel(child, filePath, moduleId, graph);
}

/** Dispatch a single top-level node. */
function visitTopLevel(child: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  if (classKind(child.type) !== undefined) {
    extractClass(child, filePath, moduleId, graph);
  } else if (FUNCTION_TYPES.has(child.type)) {
    extractFunction(child, filePath, moduleId, null, graph);
  } else if (child.type === "import_declaration") {
    extractImport(child, graph);
  }
}

/** Extract a class, interface, or enum declaration. */
function extractClass(
  node: Node,
  filePath: string,
  moduleId: string,
  graph: CodeGraph,
  parentId: string | null = null,
): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const className = nodeText(nameNode);
  // Nested types (beyond upstream only) are ``module:Outer.Inner``.
  const classId = parentId === null ? `${moduleId}:${className}` : `${parentId}.${className}`;
  const kind = classKind(node.type) ?? "class";

  graph.nodes.set(
    classId,
    codeUnit({
      id: classId,
      name: className,
      kind,
      location: makeLocation(node, filePath),
      typeParameters: extractTypeParameters(node),
      docstring: extractDocstring(node),
      attributes: node.type === RECORD_DECLARATION ? [["java_type_kind", "record"]] : [],
    }),
  );
  addContainsEdge(graph, parentId ?? moduleId, classId);

  extractInheritance(node, classId, moduleId, graph);
  extractImplements(node, classId, moduleId, graph);
  visitClassBody(node, filePath, moduleId, classId, graph);
  if (node.type === RECORD_DECLARATION) addRecordAccessors(node, filePath, classId, graph);
}

/** Visit children of a class body. */
function visitClassBody(node: Node, filePath: string, moduleId: string, classId: string, graph: CodeGraph): void {
  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (FUNCTION_TYPES.has(child.type)) extractFunction(child, filePath, moduleId, classId, graph);
    else if (beyondUpstream) visitExtraMember(child, filePath, moduleId, classId, graph);
  }
}

/** Members upstream skips: nested types, compact constructors, enum-body methods. */
function visitExtraMember(child: Node, filePath: string, moduleId: string, classId: string, graph: CodeGraph): void {
  if (classKind(child.type) !== undefined) {
    extractClass(child, filePath, moduleId, graph, classId);
  } else if (child.type === "compact_constructor_declaration") {
    extractFunction(child, filePath, moduleId, classId, graph);
  } else if (child.type === "enum_body_declarations") {
    for (const member of child.children) {
      if (FUNCTION_TYPES.has(member.type)) extractFunction(member, filePath, moduleId, classId, graph);
      else visitExtraMember(member, filePath, moduleId, classId, graph);
    }
  }
}

/** Records get an implicit accessor per component unless one is declared explicitly. */
function addRecordAccessors(node: Node, filePath: string, classId: string, graph: CodeGraph): void {
  const components = node.childForFieldName("parameters");
  for (const component of components?.namedChildren ?? []) {
    if (component.type !== "formal_parameter") continue;
    const name = nodeText(component.childForFieldName("name"));
    const accessorId = `${classId}.${name}`;
    if (!name || graph.nodes.has(accessorId)) continue;
    const typeNode = component.childForFieldName("type");
    graph.nodes.set(
      accessorId,
      codeUnit({
        id: accessorId,
        name,
        kind: "method",
        location: makeLocation(component, filePath),
        returnType: typeNode === null ? null : parseTypeNode(typeNode),
        origin: "synthetic",
        attributes: [["synthetic_reason", "record_accessor"]],
      }),
    );
    addContainsEdge(graph, classId, accessorId);
  }
}

/** Extract INHERITS edge from superclass field. */
function extractInheritance(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  const superclass = node.childForFieldName("superclass");
  if (superclass === null) return;
  for (const child of superclass.children) {
    if (child.type === "type_identifier") {
      graph.edges.push(
        codeEdge({
          sourceId: classId,
          targetId: `${moduleId}:${nodeText(child)}`,
          kind: "inherits",
          confidence: "inferred",
        }),
      );
      return;
    }
  }
}

/** Extract IMPLEMENTS edges from interfaces field. */
function extractImplements(node: Node, classId: string, moduleId: string, graph: CodeGraph): void {
  const interfaces = node.childForFieldName("interfaces");
  if (interfaces === null) return;
  for (const child of interfaces.children) {
    const ifaceName = interfaceTypeName(child);
    if (ifaceName) {
      graph.edges.push(
        codeEdge({
          sourceId: classId,
          targetId: `${moduleId}:${ifaceName}`,
          kind: "implements",
          confidence: "inferred",
        }),
      );
    }
  }
}

/** Extract interface name from a type_list child. */
function interfaceTypeName(node: Node): string {
  if (node.type === "type_identifier" || node.type === "generic_type") return nodeText(node);
  for (const child of node.children) {
    if (child.type === "type_identifier" || child.type === "generic_type") return nodeText(child);
  }
  return "";
}

/** Extract a method or constructor declaration. */
function extractFunction(
  node: Node,
  filePath: string,
  moduleId: string,
  classId: string | null,
  graph: CodeGraph,
): void {
  const funcName = getFuncName(node);
  if (!funcName) return;

  const [funcId, kind, containerId] = funcIdentity(funcName, moduleId, classId);
  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const body = node.childForFieldName("body");
  const [branches, exceptionTypes, calls] = walkBody(body, filePath);

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

  addCallEdges(calls, funcId, moduleId, classId, filePath, graph);
}

/** Get function name from a method or constructor node. */
function getFuncName(node: Node): string {
  const nameNode = node.childForFieldName("name");
  return nameNode !== null ? nodeText(nameNode) : "";
}

/** Return (funcId, kind, containerId) for a function. */
function funcIdentity(funcName: string, moduleId: string, classId: string | null): [string, NodeKind, string] {
  if (classId !== null) return [`${classId}.${funcName}`, "method", classId];
  return [`${moduleId}:${funcName}`, "function", moduleId];
}

/** Walk a function body collecting branches, throws, calls. */
function walkBody(body: Node | null, filePath: string): [BranchInfo[], TypeRef[], [string, Node][]] {
  const branches: BranchInfo[] = [];
  const exceptionTypes: TypeRef[] = [];
  const calls: [string, Node][] = [];
  if (body !== null) visitNode(body, filePath, branches, exceptionTypes, calls);
  return [branches, exceptionTypes, calls];
}

/**
 * Visit a node and its descendants (pre-order), collecting body info.
 * Upstream recurses; an explicit stack keeps the same visiting order.
 */
function visitNode(
  root: Node,
  filePath: string,
  branches: BranchInfo[],
  exceptionTypes: TypeRef[],
  calls: [string, Node][],
): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (BRANCH_NODE_TYPES.has(node.type)) {
      const cond = node.childForFieldName("condition");
      const condText = cond !== null ? nodeText(cond) : node.type;
      branches.push(branchInfo(makeLocation(node, filePath), condText));
    }

    if (THROW_TYPES.has(node.type)) collectThrow(node, exceptionTypes);

    if (node.type === "method_invocation") {
      const callName = extractCallName(node);
      if (callName) calls.push([callName, node]);
    }

    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
}

/** Extract function name from a method_invocation node. */
function extractCallName(node: Node): string {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return "";
  const objNode = node.childForFieldName("object");
  if (objNode !== null) return `${nodeText(objNode)}.${nodeText(nameNode)}`;
  return nodeText(nameNode);
}

/** Extract exception type from a throw statement. */
function collectThrow(node: Node, exceptionTypes: TypeRef[]): void {
  for (const child of node.children) {
    if (child.type === "object_creation_expression") {
      collectCreationType(child, exceptionTypes);
      return;
    }
    if (child.type === "identifier") {
      exceptionTypes.push(typeRef(nodeText(child)));
      return;
    }
  }
}

/** Extract type name from an object_creation_expression. */
function collectCreationType(node: Node, exceptionTypes: TypeRef[]): void {
  const typeNode = node.childForFieldName("type");
  if (typeNode !== null) {
    exceptionTypes.push(typeRef(nodeText(typeNode)));
    return;
  }
  for (const child of node.children) {
    if (child.type === "type_identifier" || child.type === "scoped_type_id") {
      exceptionTypes.push(typeRef(nodeText(child)));
      return;
    }
  }
}

/** Determine call confidence based on call form. */
function callConfidence(callName: string): EdgeConfidence {
  return callName.includes(".") ? "inferred" : "certain";
}

/** Add CALLS edges for each collected call. */
function addCallEdges(
  calls: [string, Node][],
  funcId: string,
  moduleId: string,
  classId: string | null,
  filePath: string,
  graph: CodeGraph,
): void {
  for (const [callName, callNode] of calls) {
    graph.edges.push(
      codeEdge({
        sourceId: funcId,
        targetId: resolveCallTarget(callName, moduleId, classId),
        kind: "calls",
        confidence: callConfidence(callName),
        location: makeLocation(callNode, filePath),
        attributes: receiverAttributes(callNode),
      }),
    );
  }
}

function receiverAttributes(callNode: Node): [string, string][] {
  if (!beyondUpstream) return [];
  const type = javaReceiverType(callNode);
  return type === null ? [] : [["receiver_type", type]];
}

/** Extract parameters from a method declaration. */
function extractParameters(node: Node): Parameter[] {
  const paramsNode = node.childForFieldName("parameters");
  if (paramsNode === null) return [];
  const params: Parameter[] = [];
  for (const child of paramsNode.children) {
    if (child.type === "formal_parameter") {
      const param = parseSingleParam(child);
      if (param !== null) params.push(param);
    }
  }
  return params;
}

/** Parse a single formal_parameter node into a Parameter. */
function parseSingleParam(node: Node): Parameter | null {
  const nameNode = node.childForFieldName("name");
  const typeNode = node.childForFieldName("type");
  if (nameNode === null) return null;
  return parameter(nodeText(nameNode), { typeRef: typeNode !== null ? parseTypeNode(typeNode) : null });
}

/** Parse a Java type node into a TypeRef. */
function parseTypeNode(typeNode: Node): TypeRef {
  if (typeNode.type === "generic_type") return parseGenericType(typeNode);
  if (typeNode.type === "array_type") {
    const inner = typeNode.children[0];
    if (inner !== undefined) return typeRef(`${parseTypeNode(inner).name}[]`);
    return typeRef(nodeText(typeNode));
  }
  return typeRef(nodeText(typeNode));
}

/** Parse a generic type like List<Integer> into a TypeRef. */
function parseGenericType(node: Node): TypeRef {
  let name = "";
  const args: TypeRef[] = [];
  for (const child of node.children) {
    if (child.type === "type_identifier") {
      name = nodeText(child);
    } else if (child.type === "type_arguments") {
      for (const sub of child.children) {
        if (sub.isNamed && sub.type !== ",") args.push(parseTypeNode(sub));
      }
    }
  }
  return typeRef(name, { genericArgs: args });
}

/** Extract return type from a method declaration. */
function extractReturnType(node: Node): TypeRef | null {
  const typeNode = node.childForFieldName("type");
  return typeNode === null ? null : parseTypeNode(typeNode);
}

/** Extract Javadoc comments (/** ... *\/) preceding a node. */
function extractDocstring(node: Node): string | null {
  const sibling = node.previousNamedSibling;
  if (sibling === null) return null;
  if (sibling.type === "block_comment" || sibling.type === "comment") {
    const text = nodeText(sibling);
    if (text.startsWith("/**")) return cleanJavadoc(text);
  }
  return null;
}

/** Strip Javadoc delimiters and leading asterisks. */
function cleanJavadoc(raw: string): string {
  let text = raw.slice(3);
  if (text.endsWith("*/")) text = text.slice(0, -2);
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    let stripped = line.trim();
    if (stripped.startsWith("*")) stripped = stripped.slice(1).trim();
    lines.push(stripped);
  }
  return lines
    .filter((line) => line)
    .join("\n")
    .trim();
}

/** Resolve a call name to a target node ID (best effort). */
function resolveCallTarget(callName: string, moduleId: string, classId: string | null): string {
  if (!callName.includes(".")) {
    if (classId !== null) return `${classId}.${callName}`;
    return `${moduleId}:${callName}`;
  }
  return callName;
}

/** Extract import declarations as dependency info. */
function extractImport(node: Node, graph: CodeGraph): void {
  const parts: string[] = [];
  for (const child of node.children) {
    if (child.isNamed) parts.push(nodeText(child));
  }
  if (parts.length > 0) {
    const pkgName = parts[0]!.split(".")[0]!;
    if (!graph.dependencies.includes(pkgName)) graph.dependencies.push(pkgName);
  }
}
