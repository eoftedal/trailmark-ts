/** Solidity language parser (port of ``parsers/solidity/parser.py``). */

import { codeEdge, type EdgeConfidence } from "../models/edges.js";
import { CodeGraph } from "../models/graph.js";
import {
  codeUnit,
  parameter,
  typeRef,
  type Attribute,
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
  makeLocation,
  moduleIdFromPath,
  nodeText,
  pyStrip,
  rsplitLast,
  type Node,
} from "./common.js";

const BRANCH_NODE_TYPES = new Set(["if_statement", "for_statement", "while_statement"]);

const THROW_TYPES = new Set(["revert_statement"]);

const CONTRACT_NODE_KINDS = new Map<string, NodeKind>([
  ["contract_declaration", "contract"],
  ["interface_declaration", "interface"],
  ["library_declaration", "library"],
]);

const FUNCTION_TYPES = new Set([
  "function_definition",
  "constructor_definition",
  "modifier_definition",
  "fallback_receive_definition",
]);

/** Parses Solidity source files into CodeGraph using tree-sitter. */
export class SolidityParser implements LanguageParser {
  readonly language = "solidity";
  readonly extensions = [".sol"] as const;
  readonly grammars = ["solidity"] as const;

  parseFile(filePath: string, source: string): CodeGraph {
    const tree = parseWithGrammar("solidity", source);
    try {
      const graph = new CodeGraph({ language: "solidity", rootPath: filePath });
      visitModule(tree.rootNode, filePath, moduleIdFromPath(filePath), graph);
      return graph;
    } finally {
      tree.delete();
    }
  }
}

/** Walk the top-level of a Solidity file, extracting nodes and edges. */
function visitModule(root: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  addModuleNode(root, filePath, moduleId, graph);
  for (const child of root.children) visitTopLevel(child, filePath, moduleId, graph);
}

/** Dispatch a single top-level node. */
function visitTopLevel(child: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  if (CONTRACT_NODE_KINDS.has(child.type)) extractContract(child, filePath, moduleId, graph);
  else if (child.type === "struct_declaration") extractStruct(child, filePath, moduleId, graph);
  else if (child.type === "enum_declaration") extractEnum(child, filePath, moduleId, graph);
  else if (child.type === "function_definition") extractFunction(child, filePath, moduleId, null, graph);
  else if (child.type === "import_directive") extractImport(child, graph);
}

/** Extract a contract, interface, or library declaration. */
function extractContract(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const contractName = nodeText(nameNode);
  const contractId = `${moduleId}:${contractName}`;
  const kind = CONTRACT_NODE_KINDS.get(node.type)!;

  graph.nodes.set(
    contractId,
    codeUnit({
      id: contractId,
      name: contractName,
      kind,
      location: makeLocation(node, filePath),
      docstring: extractDocstring(node),
    }),
  );
  addContainsEdge(graph, moduleId, contractId);
  extractInheritance(node, contractId, moduleId, graph);
  visitContractBody(node, filePath, moduleId, contractId, graph);
}

/** Add INHERITS edges from inheritance_specifier children. */
function extractInheritance(node: Node, contractId: string, moduleId: string, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type !== "inheritance_specifier") continue;
    for (const sub of child.children) {
      if (sub.type !== "user_defined_type") continue;
      const baseName = extractTypeName(sub);
      if (baseName) {
        graph.edges.push(
          codeEdge({
            sourceId: contractId,
            targetId: `${moduleId}:${baseName}`,
            kind: "inherits",
            confidence: "inferred",
          }),
        );
      }
    }
  }
}

/** Extract a type name from a user_defined_type or identifier node. */
function extractTypeName(node: Node): string {
  for (const child of node.children) {
    if (child.type === "identifier") return nodeText(child);
  }
  return nodeText(node);
}

/** Walk the body of a contract, interface, or library. */
function visitContractBody(node: Node, filePath: string, moduleId: string, contractId: string, graph: CodeGraph): void {
  const body = node.childForFieldName("body");
  if (body === null) return;
  for (const child of body.children) {
    if (FUNCTION_TYPES.has(child.type)) {
      extractFunction(child, filePath, moduleId, contractId, graph, graph.nodes.get(contractId)!.kind);
    } else if (child.type === "struct_declaration") {
      extractStruct(child, filePath, moduleId, graph);
    } else if (child.type === "enum_declaration") {
      extractEnum(child, filePath, moduleId, graph);
    }
  }
}

/** Extract a struct declaration. */
function extractStruct(node: Node, filePath: string, moduleId: string, graph: CodeGraph): void {
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return;
  const structName = nodeText(nameNode);
  const structId = `${moduleId}:${structName}`;
  graph.nodes.set(
    structId,
    codeUnit({ id: structId, name: structName, kind: "struct", location: makeLocation(node, filePath) }),
  );
  addContainsEdge(graph, moduleId, structId);
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

/** Extract a function, constructor, or modifier definition. */
function extractFunction(
  node: Node,
  filePath: string,
  moduleId: string,
  contractId: string | null,
  graph: CodeGraph,
  containerKind: NodeKind | null = null,
): void {
  const funcName = getFunctionName(node);
  if (!funcName) return;

  let funcId: string;
  let kind: NodeKind;
  let owner: string;
  if (contractId !== null) {
    funcId = `${contractId}.${funcName}`;
    kind = "method";
    owner = contractId;
  } else {
    funcId = `${moduleId}:${funcName}`;
    kind = "function";
    owner = moduleId;
  }

  const params = extractParameters(node);
  const returnType = extractReturnType(node);
  const body = node.childForFieldName("body");

  const [branches, exceptionTypes, calls] = collectFuncBody(body, filePath);
  const complexity = computeComplexity(branches);
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
      cyclomaticComplexity: complexity,
      branches,
      docstring,
      attributes: functionAttributes(node, containerKind),
    }),
  );
  addContainsEdge(graph, owner, funcId);

  addCallEdges(calls, funcId, moduleId, contractId, filePath, graph);
}

/** Extract the function name from a definition node. */
function getFunctionName(node: Node): string {
  if (node.type === "constructor_definition") return "constructor";
  if (node.type === "fallback_receive_definition") {
    for (const child of node.children) {
      if (child.type === "fallback" || child.type === "receive") return child.type;
    }
  }
  const nameNode = node.childForFieldName("name");
  if (nameNode === null) return "";
  return nodeText(nameNode);
}

/** Record Solidity semantics needed by entrypoint consumers. */
function functionAttributes(node: Node, containerKind: NodeKind | null): Attribute[] {
  const attributes: Attribute[] = [];
  for (const child of node.children) {
    if (child.type === "visibility") attributes.push(["solidity_visibility", nodeText(child)]);
    else if (child.type === "state_mutability") attributes.push(["solidity_mutability", nodeText(child)]);
    else if (child.type === "override_specifier") attributes.push(["solidity_override", "true"]);
  }
  if (containerKind !== null) attributes.push(["solidity_container_kind", containerKind]);
  return attributes;
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

/** Extract parameters from a function definition. */
function extractParameters(node: Node): Parameter[] {
  const params: Parameter[] = [];
  for (const child of node.children) {
    if (child.type === "parameter") extractSingleParam(child, params);
  }
  return params;
}

/** Extract name and type from a Solidity parameter node. */
function extractSingleParam(param: Node, params: Parameter[]): void {
  const typeNode = param.childForFieldName("type");
  const nameNode = param.childForFieldName("name");
  if (nameNode === null) return;
  const name = nodeText(nameNode);
  const type = typeNode !== null ? typeRef(nodeText(typeNode)) : null;
  params.push(parameter(name, { typeRef: type }));
}

/** Extract the return type from a Solidity function definition. */
function extractReturnType(node: Node): TypeRef | null {
  const rt = node.childForFieldName("return_type");
  if (rt === null) return null;
  for (const child of rt.children) {
    if (child.type === "parameter") {
      const typeNode = child.childForFieldName("type");
      if (typeNode !== null) return typeRef(nodeText(typeNode));
    }
  }
  return null;
}

/** Extract NatSpec (///) comments preceding a node. */
function extractDocstring(node: Node): string | null {
  const lines: string[] = [];
  let prev = node.previousNamedSibling;
  while (prev !== null && prev.type === "comment") {
    const text = nodeText(prev);
    if (!text.startsWith("///")) break;
    lines.push(text.slice(3).trim());
    prev = prev.previousNamedSibling;
  }
  if (lines.length === 0) return null;
  lines.reverse();
  return lines.join("\n");
}

/** Add CALLS edges for all collected call expressions. */
function addCallEdges(
  calls: [string, Node][],
  sourceId: string,
  moduleId: string,
  contractId: string | null,
  filePath: string,
  graph: CodeGraph,
): void {
  for (const [callName, callNode] of calls) {
    graph.edges.push(
      codeEdge({
        sourceId,
        targetId: resolveCallTarget(callName, moduleId, contractId),
        kind: "calls",
        confidence: callConfidence(callName),
        location: makeLocation(callNode, filePath),
      }),
    );
  }
}

/** Determine confidence for a Solidity call expression. */
function callConfidence(callName: string): EdgeConfidence {
  return callName.includes(".") ? "inferred" : "certain";
}

/** Resolve a call name to a target node ID. */
function resolveCallTarget(callName: string, moduleId: string, _contractId: string | null): string {
  if (!callName.includes(".")) return `${moduleId}:${callName}`;
  return callName;
}

/** Extract import directives as dependency info. */
function extractImport(node: Node, graph: CodeGraph): void {
  for (const child of node.children) {
    if (child.type === "string") {
      const raw = pyStrip(nodeText(child), "\"'");
      let dep = rsplitLast(raw, "/");
      if (dep.endsWith(".sol")) dep = dep.slice(0, -4);
      if (dep && !graph.dependencies.includes(dep)) graph.dependencies.push(dep);
      return;
    }
  }
}
