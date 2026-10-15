/**
 * Top-level code and anonymous callbacks in JavaScript/TypeScript modules.
 *
 * Not in upstream trailmark (skipped with ``upstreamCompat``). Upstream only
 * extracts named functions, methods and functions assigned to a variable, so
 * in a typical Express module
 *
 *     const app = express()
 *     app.get('/product/:id', (req, res) => { ... getProductById(id) ... })
 *     app.listen(3000)
 *
 * nothing is extracted at all. This pass, run after the upstream visitor:
 * - turns each function expression found in a top-level statement into a
 *   function node ``module:<callee>@<line>`` (e.g. ``server:app.get@6``),
 *   tagged with ``anonymous``, ``callback_of`` (the callee it is passed to),
 *   ``route`` (a leading string argument, e.g. ``/product/:id``), and
 *   ``registered_on_factory`` when the callee's receiver was assigned from a
 *   call like ``express()`` / ``Router()`` at top level;
 * - records calls made directly by top-level statements as calls from the
 *   module node.
 * Calls inside a callback belong to that callback (nested callbacks included,
 * matching how upstream attributes calls inside named functions).
 */

import type { CodeGraph } from "../models/graph.js";
import type { Attribute } from "../models/nodes.js";
import { extractCallName, nodeText, type Node } from "./common.js";

const FUNCTION_EXPR_TYPES = new Set(["arrow_function", "function", "function_expression", "generator_function"]);
/** Function expression types upstream's visitor extracts when assigned to a name (not generators). */
const UPSTREAM_EXPR_TYPES = new Set(["arrow_function", "function", "function_expression"]);
const DECLARATION_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "import_statement",
  "ambient_declaration",
  "module",
  "internal_module",
]);
const STRING_TYPES = new Set(["string", "template_string"]);

export interface TopLevelHooks {
  /** Create a function node for ``funcNode`` with the given id/name/attributes, including its call edges. */
  addCallback(funcNode: Node, funcId: string, name: string, attributes: Attribute[]): void;
  /** Add call edges from the module node. */
  addModuleCalls(calls: [string, Node][]): void;
}

export function extractTopLevelCode(root: Node, moduleId: string, graph: CodeGraph, hooks: TopLevelHooks): void {
  const factories = factoryAssignments(root);
  const moduleCalls: [string, Node][] = [];
  for (const statement of topLevelStatements(root)) {
    const stack: Node[] = [statement];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (FUNCTION_EXPR_TYPES.has(node.type) || isObjectMethod(node)) {
        if (!extractedByUpstream(node)) addCallback(node, moduleId, graph, factories, hooks);
        continue; // the callback (or upstream's function) owns everything inside it
      }
      if (node.type === "class" || node.type === "class_declaration") continue;
      if (node.type === "call_expression") {
        const name = extractCallName(node);
        if (name) moduleCalls.push([name, node]);
      }
      const children = node.children;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
    }
  }
  if (moduleCalls.length > 0) hooks.addModuleCalls(moduleCalls);
}

/** Top-level statements that may contain code, unwrapping ``export``. */
function topLevelStatements(root: Node): Node[] {
  const out: Node[] = [];
  for (const child of root.namedChildren) {
    if (child.type === "export_statement") {
      for (const inner of child.namedChildren) {
        if (!DECLARATION_TYPES.has(inner.type)) out.push(inner);
      }
    } else if (!DECLARATION_TYPES.has(child.type) && child.type !== "comment") {
      out.push(child);
    }
  }
  return out;
}

/**
 * Upstream already extracts ``const name = () => ...`` and ``name = function () {}``
 * (identifier targets) as named functions.
 */
function extractedByUpstream(fn: Node): boolean {
  const parent = fn.parent;
  if (parent === null || !UPSTREAM_EXPR_TYPES.has(fn.type)) return false;
  if (parent.type === "variable_declarator") {
    // Only declarations that are themselves top-level statements (optionally exported).
    return (
      parent.childForFieldName("value")?.id === fn.id &&
      parent.childForFieldName("name") !== null &&
      isTopLevel(parent.parent)
    );
  }
  if (parent.type === "assignment_expression") {
    return (
      parent.childForFieldName("right")?.id === fn.id &&
      parent.childForFieldName("left")?.type === "identifier" &&
      parent.parent?.type === "expression_statement" &&
      isTopLevel(parent.parent)
    );
  }
  return false;
}

function isTopLevel(statement: Node | null): boolean {
  const container = statement?.parent;
  if (container === null || container === undefined) return false;
  return (
    container.type === "program" || (container.type === "export_statement" && container.parent?.type === "program")
  );
}

/** ``{ get(id) { ... } }``: a method in an object literal (class bodies are skipped before we get here). */
function isObjectMethod(node: Node): boolean {
  return node.type === "method_definition" && node.parent?.type === "object";
}

/**
 * ``const app = express()`` → ``app`` ↦ ``express`` (top-level declarations only).
 * CommonJS factories are normalized to the module name: ``require('express')()``
 * → ``express``, ``require('express').Router()`` → ``express.Router``.
 */
function factoryAssignments(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (decl: Node) => {
    for (const d of decl.namedChildren) {
      if (d.type !== "variable_declarator") continue;
      const name = d.childForFieldName("name");
      let value = d.childForFieldName("value");
      if (value?.type === "await_expression") value = value.namedChildren[0] ?? null;
      if (name?.type === "identifier" && value?.type === "call_expression") {
        const callee = factoryName(value);
        if (callee) out.set(name.text, callee);
      }
    }
  };
  for (const child of root.namedChildren) {
    if (child.type === "lexical_declaration" || child.type === "variable_declaration") visit(child);
    if (child.type === "export_statement") {
      for (const inner of child.namedChildren) {
        if (inner.type === "lexical_declaration" || inner.type === "variable_declaration") visit(inner);
      }
    }
  }
  return out;
}

function factoryName(call: Node): string {
  const fn = call.childForFieldName("function");
  if (fn?.type === "call_expression") {
    const required = requiredModule(fn);
    if (required !== null) return required;
  }
  const callee = compact(fn?.text ?? "");
  const m = /^require\((['"`])([^'"`]+)\1\)\.(.+)$/.exec(callee);
  return m !== null ? `${m[2]}.${m[3]}` : extractCallName(call);
}

/** ``require('x')`` → ``x``; anything else → ``null``. */
function requiredModule(call: Node): string | null {
  if (call.childForFieldName("function")?.text !== "require") return null;
  const args = call.childForFieldName("arguments")?.namedChildren ?? [];
  return args.length === 1 && STRING_TYPES.has(args[0]!.type) ? stripQuotes(args[0]!.text) : null;
}

function addCallback(
  fn: Node,
  moduleId: string,
  graph: CodeGraph,
  factories: Map<string, string>,
  hooks: TopLevelHooks,
): void {
  const line = fn.startPosition.row + 1;
  const attributes: Attribute[] = [["anonymous", true]];
  let label = "<anonymous>";
  const parent = fn.parent;
  if (parent?.type === "arguments" && parent.parent?.type === "call_expression") {
    const call = parent.parent;
    const callee = compact(nodeText(call.childForFieldName("function")));
    label = callee || label;
    attributes.push(["callback_of", callee]);
    const first = parent.namedChildren[0];
    if (first !== undefined && first.id !== fn.id && STRING_TYPES.has(first.type)) {
      attributes.push(["route", stripQuotes(first.text)]);
    }
    const receiver = callee.includes(".") ? callee.slice(0, callee.indexOf(".")) : null;
    const factory = receiver === null ? undefined : factories.get(receiver);
    if (factory !== undefined) attributes.push(["registered_on_factory", factory]);
  } else if (fn.type === "method_definition") {
    label = keyLabel(fn.childForFieldName("name")) || label;
  } else if (parent?.type === "pair") {
    label = keyLabel(parent.childForFieldName("key")) || label;
  } else if (parent?.type === "variable_declarator") {
    label = compact(nodeText(parent.childForFieldName("name"))) || label;
  } else if (parent?.type === "assignment_expression") {
    label = compact(nodeText(parent.childForFieldName("left"))) || label;
  } else if (parent?.type === "parenthesized_expression" && parent.parent?.type === "call_expression") {
    label = "<iife>";
  }
  // ``export default <function>`` is named ``default``, like upstream names default
  // exports (and as the Next.js Pages API detector expects).
  if (parent?.type === "export_statement") {
    let funcId = `${moduleId}:default`;
    for (let n = 2; graph.nodes.has(funcId); n++) funcId = `${moduleId}:default#${n}`;
    hooks.addCallback(fn, funcId, funcId.slice(moduleId.length + 1), attributes);
    return;
  }
  let funcId = `${moduleId}:${label}@${line}`;
  for (let n = 2; graph.nodes.has(funcId); n++) funcId = `${moduleId}:${label}@${line}#${n}`;
  hooks.addCallback(fn, funcId, funcId.slice(moduleId.length + 1), attributes);
}

/** Object keys: ``'quoted key'`` → ``quoted key``; computed and other keys verbatim (compacted). */
function keyLabel(key: Node | null): string {
  if (key === null) return "";
  return STRING_TYPES.has(key.type) ? stripQuotes(key.text) : compact(key.text);
}

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

function stripQuotes(text: string): string {
  return text.length >= 2 ? text.slice(1, -1) : text;
}
