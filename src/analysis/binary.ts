/**
 * Import external binary-analysis graphs into Trailmark graphs.
 *
 * Unlike upstream (which takes a file path and ``json.load``s it), callers pass
 * already-parsed JSON plus the original ``graphPath`` (used for the artifact key
 * fallback and default artifact path).
 */

import { pyCompare } from "../fs/source.js";
import { codeEdge, EDGE_CONFIDENCES, type EdgeConfidence } from "../models/edges.js";
import {
  codeUnit,
  sourceLocation,
  type Attribute,
  type AttributeValue,
  type CodeUnit,
  type NodeKind,
} from "../models/nodes.js";
import type { JsonObject } from "../query/dicts.js";
import type { GraphStore } from "../storage/graph-store.js";
import { stem } from "../util/path.js";
import { pyJsonDumps, pyRepr } from "../util/py.js";
import { pyNormpath, pyRelpath } from "./augment.js";
import { ensureProxyNodes } from "./proxies.js";

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Python ``dict.get``; raises like Python when ``obj`` is not a dict. */
function get(obj: unknown, key: string, dflt: unknown = undefined): unknown {
  if (!isDict(obj)) throw new TypeError("object has no attribute 'get'");
  return Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : dflt;
}

function list(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (isDict(value)) return Object.keys(value);
  if (typeof value === "string") return [...value];
  throw new TypeError("object is not iterable");
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** ``a or b``. */
function or(a: unknown, b: unknown): unknown {
  return pyTruthy(a) ? a : b;
}

/** Python ``str(value)`` for JSON values. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  if (typeof value === "bigint") return value.toString();
  return pyReprValue(value);
}

/** Python ``repr()`` of a parsed-JSON container (``str(dict)`` / ``str(list)``). */
function pyReprValue(value: unknown): string {
  if (typeof value === "string") return pyRepr(value);
  if (Array.isArray(value)) return `[${value.map(pyReprValue).join(", ")}]`;
  if (isDict(value)) {
    return `{${Object.entries(value)
      .map(([k, v]) => `${pyRepr(k)}: ${pyReprValue(v)}`)
      .join(", ")}}`;
  }
  return pyStr(value);
}

/**
 * Import a Trailmark binary graph JSON document.
 *
 * Expected shape is intentionally small: an ``artifact`` object, a
 * ``functions`` list, and a ``calls`` list. Unknown fields are ignored.
 */
export function augmentFromBinaryGraph(
  store: GraphStore,
  data: unknown,
  options: { graphPath: string; connectSources: boolean },
): JsonObject {
  const graphPath = options.graphPath;
  const graph = store.graph;
  const artifact = get(data, "artifact", {});
  const artifactKey = artifactKeyFor(artifact, graphPath);
  const architecture = optionalStr(or(get(artifact, "architecture"), get(artifact, "arch")));
  const artifactHash = optionalStr(or(get(artifact, "hash"), get(artifact, "sha256")));
  const artifactPath = optionalStr(get(artifact, "path")) || graphPath;

  const functions = list(get(data, "functions", []));
  const refCounts = functionRefCounts(functions);
  const refToId = new Map<string, string>();
  const binaryIds: string[] = [];

  for (const fn of functions) {
    const nodeId = binaryNodeId(artifactKey, fn, refCounts);
    binaryIds.push(nodeId);
    graph.nodes.set(nodeId, binaryUnit(nodeId, artifactPath, fn, architecture, artifactHash));
    for (const ref of functionRefs(fn)) {
      if ((refCounts.get(ref) ?? 0) > 1) continue;
      refToId.set(ref, nodeId);
    }
  }

  let callEdges = 0;
  let externalProxies = 0;
  for (const call of list(get(data, "calls", []))) {
    const sourceId = resolveCallRef(get(call, "source"), refToId);
    let targetId = resolveCallRef(get(call, "target"), refToId);
    if (sourceId === null) continue;
    if (targetId === null) {
      const targetRaw = refText(get(call, "target"));
      if (!targetRaw) continue;
      targetId = externalProxyId(targetRaw);
      if (!graph.nodes.has(targetId)) {
        graph.nodes.set(targetId, externalProxy(targetId, targetRaw, artifactPath));
        externalProxies += 1;
      }
    }
    graph.edges.push(
      codeEdge({
        sourceId,
        targetId,
        kind: "calls",
        confidence: confidenceOf(get(call, "confidence")),
        attributes: callAttributes(call),
      }),
    );
    callEdges += 1;
  }

  let correspondences = 0;
  if (options.connectSources) correspondences = connectSourceNodes(store, binaryIds, data, artifactKey);

  store.addSubgraph(`binary:${artifactKey}`, new Set(binaryIds));
  ensureProxyNodes(graph);
  store.rebuildIndex();
  return {
    artifact: artifactKey,
    binary_nodes: binaryIds.length,
    call_edges: callEdges,
    external_proxies: externalProxies,
    correspondences,
    subgraphs_created: [`binary:${artifactKey}`],
  };
}

function artifactKeyFor(artifact: unknown, graphPath: string): string {
  const raw = or(or(get(artifact, "key"), get(artifact, "name")), stem(graphPath) || "binary");
  return sanitizeIdentifier(pyStr(raw));
}

function binaryNodeId(artifactKey: string, fn: unknown, refCounts: Map<string, number>): string {
  const symbol = functionSymbol(fn);
  if (symbol && refCounts.get(symbol) === 1) return `bin.${artifactKey}:${sanitizeIdentifier(symbol)}`;
  let address = intValue(get(fn, "rva"));
  if (address === null) address = intValue(get(fn, "address"));
  let n: bigint;
  if (address === null) {
    const digest = sha256Hex(pyJsonDumps(fn, null, true));
    n = BigInt(parseInt(digest.slice(0, 8), 16));
  } else {
    n = address.value;
  }
  return `bin.${artifactKey}:sub_${n.toString(16)}`;
}

function binaryUnit(
  nodeId: string,
  artifactPath: string,
  fn: unknown,
  architecture: string | null,
  artifactHash: string | null,
): CodeUnit {
  const symbol = functionSymbol(fn) || nodeId.slice(nodeId.lastIndexOf(":") + 1);
  return codeUnit({
    id: nodeId,
    name: symbol,
    kind: "function",
    location: sourceLocation(artifactPath, 0, 0),
    origin: "binary",
    attributes: functionAttributes(fn, architecture, artifactHash),
  });
}

function hasKey(obj: unknown, key: string): boolean {
  if (isDict(obj)) return Object.prototype.hasOwnProperty.call(obj, key);
  return list(obj).includes(key);
}

function functionAttributes(fn: unknown, architecture: string | null, artifactHash: string | null): Attribute[] {
  const attrs: Attribute[] = [];
  for (const key of ["address", "rva", "size", "section"]) {
    if (hasKey(fn, key)) attrs.push([key, get(fn, key) as AttributeValue]);
  }
  if (architecture !== null) attrs.push(["architecture", architecture]);
  if (artifactHash !== null) attrs.push(["artifact_hash", artifactHash]);
  return attrs;
}

function callAttributes(call: unknown): Attribute[] {
  const attrs: Attribute[] = [];
  for (const key of ["address", "callsite", "kind"]) {
    if (hasKey(call, key)) attrs.push([key, get(call, key) as AttributeValue]);
  }
  return attrs;
}

function functionRefCounts(functions: unknown[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const fn of functions) {
    for (const ref of functionRefs(fn)) counts.set(ref, (counts.get(ref) ?? 0) + 1);
  }
  return counts;
}

function functionSymbol(fn: unknown): string | null {
  return optionalStr(or(get(fn, "symbol"), get(fn, "name")));
}

function functionRefs(fn: unknown): Set<string> {
  const refs = new Set<string>();
  for (const key of ["id", "symbol", "name"]) {
    const value = optionalStr(get(fn, key));
    if (value) refs.add(value);
  }
  for (const key of ["address", "rva"]) {
    const value = intValue(get(fn, key));
    if (value !== null) {
      refs.add(value.text);
      refs.add(pyHex(value.value));
    }
  }
  return refs;
}

function resolveCallRef(value: unknown, refToId: Map<string, string>): string | null {
  if (isDict(value)) {
    for (const key of ["id", "symbol", "name", "address", "rva"]) {
      const resolved = resolveCallRef(value[key], refToId);
      if (resolved !== null) return resolved;
    }
    return null;
  }
  const text = refText(value);
  if (!text) return null;
  return refToId.get(text) ?? null;
}

function refText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return pyStr(value);
}

function externalProxyId(rawSymbol: string): string {
  return `proxy.external:${sanitizeIdentifier(rawSymbol)}`;
}

function externalProxy(nodeId: string, rawSymbol: string, artifactPath: string): CodeUnit {
  return codeUnit({
    id: nodeId,
    name: rawSymbol,
    kind: "proxy",
    location: sourceLocation(artifactPath, 0, 0),
    origin: "proxy",
    attributes: [
      ["raw_symbol", rawSymbol],
      ["proxy_kind", "external"],
    ],
  });
}

function connectSourceNodes(store: GraphStore, binaryIds: string[], data: unknown, artifactKey: string): number {
  const graph = store.graph;
  let connected = 0;
  const functions = list(get(data, "functions", []));
  const n = Math.min(functions.length, binaryIds.length);
  for (let i = 0; i < n; i++) {
    const sourceId = sourceNodeId(store, functions[i]);
    if (sourceId === null || !graph.nodes.has(sourceId)) continue;
    graph.edges.push(
      codeEdge({
        sourceId,
        targetId: binaryIds[i]!,
        kind: "corresponds_to",
        confidence: "inferred",
        attributes: [["artifact", artifactKey]],
      }),
    );
    connected += 1;
  }
  return connected;
}

function sourceNodeId(store: GraphStore, fn: unknown): string | null {
  const source = get(fn, "source");
  if (isDict(source)) {
    const explicit = optionalStr(get(source, "node_id"));
    if (explicit && isSourceNode(store, explicit)) return explicit;
    const symbol = optionalStr(or(get(source, "symbol"), get(source, "name")));
    if (symbol) {
      const found = findSourceNodeId(store, symbol);
      if (found !== null) return found;
    }
    const path = optionalStr(or(get(source, "file"), get(source, "path")));
    const line = intValue(or(get(source, "line"), get(source, "start_line")));
    if (path && line !== null) return nodeAtSourceLine(store, path, Number(line.value));
  }
  const symbol = functionSymbol(fn);
  if (symbol) return findSourceNodeId(store, symbol);
  return null;
}

function isSourceNode(store: GraphStore, nodeId: string): boolean {
  const node = store.graph.nodes.get(nodeId);
  return node !== undefined && node.origin === "source";
}

function findSourceNodeId(store: GraphStore, name: string): string | null {
  const candidates: [number, number, string][] = [];
  for (const [nodeId, node] of store.graph.nodes) {
    if (node.origin !== "source") continue;
    const rank = sourceNameMatchRank(nodeId, node, name);
    if (rank === null) continue;
    candidates.push([rank, sourceMappingKindRank(node.kind), nodeId]);
  }
  if (candidates.length === 0) return null;
  candidates.sort(compareTriples);
  const [bestRank, bestKindRank, bestId] = candidates[0]!;
  const ties = candidates.filter(([r, k]) => r === bestRank && k === bestKindRank).length;
  if (ties > 1) return null;
  return bestId;
}

function compareTriples(a: [number, number, string], b: [number, number, string]): number {
  return a[0] - b[0] || a[1] - b[1] || pyCompare(a[2], b[2]);
}

function sourceNameMatchRank(nodeId: string, node: CodeUnit, name: string): number | null {
  if (nodeId === name) return 0;
  if (node.name === name) return 1;
  if (nodeId.endsWith(`:${name}`)) return 2;
  if (nodeId.endsWith(`.${name}`)) return 3;
  return null;
}

function nodeAtSourceLine(store: GraphStore, path: string, line: number): string | null {
  const root = store.graph.rootPath;
  const matches: [number, number, string][] = [];
  for (const [nodeId, node] of store.graph.nodes) {
    if (node.origin !== "source") continue;
    const loc = node.location;
    if (samePath(loc.filePath, path, root) && loc.startLine <= line && line <= loc.endLine) {
      matches.push([Math.max(loc.endLine - loc.startLine, 0), sourceMappingKindRank(node.kind), nodeId]);
    }
  }
  if (matches.length === 0) return null;
  matches.sort(compareTriples);
  return matches[0]![2];
}

/** Prefer executable source nodes over broader containers for line mappings. */
function sourceMappingKindRank(kind: NodeKind): number {
  if (kind === "function" || kind === "method") return 0;
  if (kind === "class" || kind === "struct" || kind === "interface" || kind === "trait" || kind === "contract") {
    return 1;
  }
  if (kind === "module" || kind === "namespace") return 2;
  return 1;
}

function samePath(left: string, right: string, root: string): boolean {
  const leftNorm = pyNormpath(left);
  const rightNorm = pyNormpath(right);
  if (leftNorm === rightNorm) return true;
  if (root) return pyNormpath(pyRelpath(leftNorm, root)) === rightNorm;
  return false;
}

function confidenceOf(value: unknown): EdgeConfidence {
  if (typeof value === "string") {
    return (EDGE_CONFIDENCES as readonly string[]).includes(value) ? (value as EdgeConfidence) : "uncertain";
  }
  return "certain";
}

function optionalStr(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = pyStr(value);
  return text ? text : null;
}

/** An integer value plus its Python ``str()`` (``bool`` is an ``int`` subclass upstream). */
interface PyInt {
  value: bigint;
  text: string;
}

const PY_INT_LITERAL =
  /^[+-]?(?:0[xX](?:_?[0-9a-fA-F])+|0[oO](?:_?[0-7])+|0[bB](?:_?[01])+|0(?:_?0)*|[1-9](?:_?[0-9])*)$/;

/** Python ``int(value, 0)`` for strings; ints pass through; floats and others are ``None``. */
function intValue(value: unknown): PyInt | null {
  if (typeof value === "boolean") return { value: value ? 1n : 0n, text: value ? "True" : "False" };
  if (typeof value === "number") {
    if (!Number.isInteger(value)) return null;
    const v = BigInt(value);
    return { value: v, text: v.toString() };
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!PY_INT_LITERAL.test(s)) return null;
    let body = s.replaceAll("_", "");
    let neg = false;
    if (body[0] === "+" || body[0] === "-") {
      neg = body[0] === "-";
      body = body.slice(1);
    }
    const lower = body.toLowerCase();
    // BigInt() accepts 0x/0o/0b prefixes but not a sign together with them.
    const v = lower.startsWith("0x") || lower.startsWith("0o") || lower.startsWith("0b") ? BigInt(lower) : BigInt(body);
    const signed = neg ? -v : v;
    return { value: signed, text: signed.toString() };
  }
  return null;
}

/** Python ``hex()``. */
function pyHex(v: bigint): string {
  return v < 0n ? `-0x${(-v).toString(16)}` : `0x${v.toString(16)}`;
}

function sanitizeIdentifier(value: string): string {
  const text = value.trim() || "unknown";
  return text.replace(/[^0-9A-Za-z_.@$-]+/g, "_");
}

// ── SHA-256 (synchronous, browser-safe) ──

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
  0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
  0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
  0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
  0xc67178f2,
]);

function sha256Hex(text: string): string {
  const msg = new TextEncoder().encode(text);
  const bitLen = msg.length * 8;
  const total = Math.ceil((msg.length + 9) / 64) * 64;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[msg.length] = 0x80;
  const view = new DataView(buf.buffer);
  view.setUint32(total - 8, Math.floor(bitLen / 0x100000000));
  view.setUint32(total - 4, bitLen >>> 0);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = h[0]! + a;
    h[1] = h[1]! + b;
    h[2] = h[2]! + c;
    h[3] = h[3]! + d;
    h[4] = h[4]! + e;
    h[5] = h[5]! + f;
    h[6] = h[6]! + g;
    h[7] = h[7]! + hh;
  }
  return [...h].map((x) => x.toString(16).padStart(8, "0")).join("");
}
