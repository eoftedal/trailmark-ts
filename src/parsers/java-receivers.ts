/**
 * Receiver type inference for Java ``method_invocation`` nodes.
 *
 * Not in upstream trailmark: upstream records ``repo.getProduct()`` with the raw
 * target ``repo.getProduct`` and never resolves it. This finds the declared type
 * of the receiver (``ProductRepository``) so ``resolveReceiverTypes`` can link
 * the call to ``ProductRepository.getProduct`` after all files are merged.
 *
 * Purely syntactic and scope-based: locals, parameters, fields (including
 * outer classes), ``this``/``super``, ``new X().m()`` and static ``X.m()``.
 * Inferred types are simple names (generics and package qualifiers dropped).
 */

import type { Node } from "./common.js";

const CLASS_LIKE = new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]);
const METHOD_LIKE = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);
const BLOCK_LIKE = new Set(["block", "constructor_body", "switch_block_statement_group", "switch_rule"]);

/** Declared simple type name of the receiver of a ``method_invocation``, or ``null``. */
export function javaReceiverType(call: Node): string | null {
  const obj = call.childForFieldName("object");
  if (obj === null) return null;
  switch (obj.type) {
    case "this":
      return enclosingClassName(call);
    case "super":
      return enclosingSuperclass(call);
    case "identifier": {
      const name = obj.text;
      const found = lookupVariable(name, call);
      if (found !== undefined) return found;
      // Not a variable in scope: by Java convention an upper-case identifier is a class (static call).
      return /^[A-Z]/.test(name) ? name : null;
    }
    case "field_access": {
      const target = obj.childForFieldName("object");
      const field = obj.childForFieldName("field");
      if (target?.type === "this" && field !== null) return fieldType(field.text, call) ?? null;
      // ``Outer.Inner.m()``: a static call on a nested type, unless ``Outer`` is a variable.
      const path = obj.text.replace(/\s+/g, "");
      if (/^[A-Z]\w*(\.[A-Z]\w*)+$/.test(path) && lookupVariable(path.split(".")[0]!, call) === undefined) {
        return path;
      }
      return null;
    }
    case "object_creation_expression":
      return simpleTypeName(obj.childForFieldName("type"));
    case "parenthesized_expression": {
      const inner = obj.namedChildren[0];
      return inner?.type === "object_creation_expression" ? simpleTypeName(inner.childForFieldName("type")) : null;
    }
    default:
      return null;
  }
}

/**
 * ``List<Foo>`` → ``List``; ``a.b.Foo`` → ``Foo``; ``Outer.Inner`` → ``Outer.Inner``
 * (trailing capitalized segments are kept, as they name nested types);
 * primitives, arrays and ``var`` → ``null``.
 */
export function simpleTypeName(type: Node | null | undefined): string | null {
  if (type === null || type === undefined) return null;
  switch (type.type) {
    case "type_identifier":
      return type.text === "var" ? null : type.text;
    case "generic_type":
      return simpleTypeName(type.namedChildren.find((c) => c.type !== "type_arguments"));
    case "scoped_type_identifier": {
      const parts = type.text.replace(/\s+/g, "").split(".");
      let start = parts.length - 1;
      while (start > 0 && /^[A-Z]/.test(parts[start - 1]!)) start--;
      return parts.slice(start).join(".") || null;
    }
    case "annotated_type":
      return simpleTypeName(type.namedChildren[type.namedChildren.length - 1]);
    default:
      return null;
  }
}

/**
 * Type of a declaration's variable: the declared type, or for ``var x = new T()``
 * the constructed type. ``undefined`` = unknown (``var`` with other initializers).
 */
function declaredType(type: Node | null, declarator: Node | null): string | null | undefined {
  if (type?.type === "type_identifier" && type.text === "var") {
    const value = declarator?.childForFieldName("value");
    if (value?.type === "object_creation_expression") return simpleTypeName(value.childForFieldName("type"));
    return undefined;
  }
  return simpleTypeName(type);
}

function typeChild(node: Node): Node | null {
  return node.childForFieldName("type");
}

/**
 * Find ``name``'s type by walking outwards from ``from``: block locals declared
 * before the use, loop/catch/resource/lambda variables, parameters, then fields
 * of each enclosing class. Returns ``undefined`` if no declaration is found and
 * ``null`` if one is found but its type is unknown or not a class type.
 */
function lookupVariable(name: string, from: Node): string | null | undefined {
  let child = from;
  for (let scope = from.parent; scope !== null; child = scope, scope = scope.parent) {
    if (BLOCK_LIKE.has(scope.type)) {
      let found: string | null | undefined;
      for (const stmt of scope.namedChildren) {
        if (stmt.startIndex >= child.startIndex) break;
        if (stmt.type !== "local_variable_declaration") continue;
        for (const decl of stmt.childrenForFieldName("declarator")) {
          if (decl.childForFieldName("name")?.text === name) found = declaredType(typeChild(stmt), decl) ?? null;
        }
      }
      if (found !== undefined) return found;
    } else if (scope.type === "for_statement") {
      const init = scope.childForFieldName("init");
      if (init?.type === "local_variable_declaration") {
        for (const decl of init.childrenForFieldName("declarator")) {
          if (decl.childForFieldName("name")?.text === name) return declaredType(typeChild(init), decl) ?? null;
        }
      }
    } else if (scope.type === "enhanced_for_statement") {
      if (scope.childForFieldName("name")?.text === name) return declaredType(typeChild(scope), null) ?? null;
    } else if (scope.type === "catch_clause") {
      const param = scope.namedChildren.find((c) => c.type === "catch_formal_parameter");
      if (param?.childForFieldName("name")?.text === name) {
        const types = param.namedChildren.find((c) => c.type === "catch_type")?.namedChildren ?? [];
        return types.length === 1 ? simpleTypeName(types[0]) : null;
      }
    } else if (scope.type === "try_with_resources_statement") {
      const spec = scope.childForFieldName("resources");
      for (const res of spec?.namedChildren ?? []) {
        if (res.type === "resource" && res.childForFieldName("name")?.text === name) {
          return declaredType(typeChild(res), res) ?? null;
        }
      }
    } else if (scope.type === "lambda_expression") {
      const params = scope.childForFieldName("parameters");
      if (params?.type === "identifier") {
        if (params.text === name) return null;
      } else {
        for (const p of params?.namedChildren ?? []) {
          if (p.type === "identifier" && p.text === name) return null;
          if (p.type === "formal_parameter" && p.childForFieldName("name")?.text === name) {
            return simpleTypeName(typeChild(p));
          }
        }
      }
    } else if (METHOD_LIKE.has(scope.type)) {
      const params = scope.childForFieldName("parameters");
      for (const p of params?.namedChildren ?? []) {
        if (p.type === "formal_parameter" && p.childForFieldName("name")?.text === name) {
          return simpleTypeName(typeChild(p));
        }
        if (p.type === "spread_parameter") {
          const decl = p.namedChildren.find((c) => c.type === "variable_declarator");
          if (decl?.childForFieldName("name")?.text === name) return null; // varargs are arrays
        }
      }
    } else if (CLASS_LIKE.has(scope.type)) {
      const t = classFieldType(scope, name);
      if (t !== undefined) return t;
    }
  }
  return undefined;
}

/** Field (or record component) ``name`` declared directly in ``cls``. */
function classFieldType(cls: Node, name: string): string | null | undefined {
  if (cls.type === "record_declaration") {
    const params = cls.namedChildren.find((c) => c.type === "formal_parameters");
    for (const p of params?.namedChildren ?? []) {
      if (p.type === "formal_parameter" && p.childForFieldName("name")?.text === name) {
        return simpleTypeName(typeChild(p));
      }
    }
  }
  const body = cls.childForFieldName("body");
  // Enum fields live inside ``enum_body_declarations`` rather than directly in the body.
  const members = (body?.namedChildren ?? []).flatMap((m) =>
    m.type === "enum_body_declarations" ? m.namedChildren : [m],
  );
  for (const member of members) {
    if (member.type !== "field_declaration" && member.type !== "constant_declaration") continue;
    for (const decl of member.childrenForFieldName("declarator")) {
      if (decl.childForFieldName("name")?.text === name) return declaredType(typeChild(member), decl) ?? null;
    }
  }
  return undefined;
}

/** ``this.name``: a field of the innermost enclosing class (then outer classes). */
function fieldType(name: string, from: Node): string | null | undefined {
  for (let scope = from.parent; scope !== null; scope = scope.parent) {
    if (CLASS_LIKE.has(scope.type)) return classFieldType(scope, name);
  }
  return undefined;
}

function enclosingClass(from: Node): Node | null {
  for (let scope = from.parent; scope !== null; scope = scope.parent) {
    if (CLASS_LIKE.has(scope.type)) return scope;
    // Anonymous class bodies change what ``this`` means; give up rather than guess.
    if (scope.type === "class_body" && scope.parent?.type === "object_creation_expression") return null;
  }
  return null;
}

/** Name of the enclosing class, qualified by enclosing types (``Comment.Id``). */
function enclosingClassName(from: Node): string | null {
  const names: string[] = [];
  for (let cls = enclosingClass(from); cls !== null; cls = enclosingClass(cls)) {
    const name = cls.childForFieldName("name")?.text;
    if (name === undefined) return null;
    names.unshift(name);
  }
  return names.length > 0 ? names.join(".") : null;
}

function enclosingSuperclass(from: Node): string | null {
  const superclass = enclosingClass(from)?.childForFieldName("superclass");
  return simpleTypeName(superclass?.namedChildren[0]);
}
