/**
 * Augment code graphs with external findings from SARIF and weAudit files.
 *
 * Parses SARIF 2.1.0 static analysis results and weAudit audit annotations,
 * matches findings to graph nodes by file path and line range overlap, and
 * stores them as annotations and named subgraphs.
 *
 * Unlike upstream (which takes a file path and ``json.load``s it), callers pass
 * already-parsed JSON.
 */

import { pyCompare } from "../fs/source.js";
import type { Annotation, AnnotationKind } from "../models/annotations.js";
import type { CodeGraph } from "../models/graph.js";
import type { JsonObject } from "../query/dicts.js";
import type { GraphStore } from "../storage/graph-store.js";

type Dict = Record<string, unknown>;

/** Python ``dict.get(key, default)``; raises like Python when ``obj`` is not a dict. */
function get(obj: unknown, key: string, dflt: unknown = undefined): unknown {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new TypeError(`'${pyTypeName(obj)}' object has no attribute 'get'`);
  }
  return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Dict)[key] : dflt;
}

function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return "NoneType";
  if (Array.isArray(v)) return "list";
  if (typeof v === "string") return "str";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
  return "dict";
}

/** Iterate a JSON list (``for x in value``). */
function iter(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value !== null && typeof value === "object") return Object.keys(value);
  if (typeof value === "string") return [...value];
  throw new TypeError(`'${pyTypeName(value)}' object is not iterable`);
}

/**
 * Parse a SARIF document and augment the graph with findings.
 *
 * Maps results to graph nodes by file/line overlap, creates annotations and
 * subgraphs by severity and tool. Returns a summary dict with match statistics.
 */
export function augmentFromSarif(store: GraphStore, data: unknown): JsonObject {
  clearAugmented(store, "sarif");
  const graph = store.graph;
  let matched = 0;
  let unmatched = 0;
  const subgraphSets = new Map<string, Set<string>>();

  for (const run of iter(get(data, "runs", []))) {
    const toolName = sarifToolName(run);
    for (const result of iter(get(run, "results", []))) {
      const nodeIds = processSarifResult(result, toolName, graph);
      if (nodeIds.size > 0) {
        matched += 1;
        addToSubgraphs(subgraphSets, nodeIds, result, toolName);
      } else {
        unmatched += 1;
      }
    }
  }

  for (const [name, ids] of subgraphSets) store.addSubgraph(name, ids);

  return {
    matched_findings: matched,
    unmatched_findings: unmatched,
    subgraphs_created: [...subgraphSets.keys()].sort(pyCompare),
  };
}

/**
 * Parse a weAudit document and augment the graph with findings.
 *
 * Maps entries to graph nodes by file/line overlap (converting 0-indexed to
 * 1-indexed lines), creates annotations and subgraphs by severity and entry type.
 */
export function augmentFromWeaudit(store: GraphStore, data: unknown): JsonObject {
  clearAugmented(store, "weaudit");
  const graph = store.graph;
  let matched = 0;
  let unmatched = 0;
  const subgraphSets = new Map<string, Set<string>>();

  const entries = [...iter(get(data, "treeEntries", [])), ...iter(get(data, "resolvedEntries", []))];

  for (const entry of entries) {
    const nodeIds = processWeauditEntry(entry, data, graph);
    if (nodeIds.size > 0) {
      matched += 1;
      addWeauditToSubgraphs(subgraphSets, nodeIds, entry);
    } else {
      unmatched += 1;
    }
  }

  for (const [name, ids] of subgraphSets) store.addSubgraph(name, ids);

  return {
    matched_findings: matched,
    unmatched_findings: unmatched,
    subgraphs_created: [...subgraphSets.keys()].sort(pyCompare),
  };
}

/**
 * Remove annotations and subgraphs from a prior augmentation run.
 *
 * Filters annotations whose source starts with the given prefix and deletes
 * subgraphs whose name starts with that prefix followed by a colon.
 */
export function clearAugmented(store: GraphStore, sourcePrefix: string): void {
  const graph = store.graph;
  for (const [nodeId, anns] of [...graph.annotations]) {
    const kept = anns.filter((a) => !a.source.startsWith(sourcePrefix));
    if (kept.length === 0) graph.annotations.delete(nodeId);
    else graph.annotations.set(nodeId, kept);
  }
  const sgPrefix = `${sourcePrefix}:`;
  for (const name of [...graph.subgraphs.keys()]) {
    if (name.startsWith(sgPrefix)) graph.subgraphs.delete(name);
  }
}

// ── POSIX path helpers (Python ``posixpath`` semantics, browser-safe) ──

/** Python ``posixpath.normpath``. */
export function pyNormpath(path: string): string {
  if (path === "") return ".";
  let initialSlashes = path.startsWith("/") ? 1 : 0;
  // POSIX allows one or two initial slashes, but treats three or more as a single slash.
  if (initialSlashes && path.startsWith("//") && !path.startsWith("///")) initialSlashes = 2;
  const newComps: string[] = [];
  for (const comp of path.split("/")) {
    if (comp === "" || comp === ".") continue;
    if (
      comp !== ".." ||
      (!initialSlashes && newComps.length === 0) ||
      (newComps.length > 0 && newComps[newComps.length - 1] === "..")
    ) {
      newComps.push(comp);
    } else if (newComps.length > 0) {
      newComps.pop();
    }
  }
  const joined = "/".repeat(initialSlashes) + newComps.join("/");
  return joined || ".";
}

function currentDir(): string {
  // Browser-safe: use the process cwd when running under Node, else "/".
  const proc = (globalThis as { process?: { cwd?: () => string } }).process;
  return typeof proc?.cwd === "function" ? proc.cwd() : "/";
}

function pyAbspath(path: string): string {
  return pyNormpath(path.startsWith("/") ? path : `${currentDir()}/${path}`);
}

/** Python ``posixpath.relpath`` (throws on an empty ``path`` like upstream). */
export function pyRelpath(path: string, start: string): string {
  if (path === "") throw new Error("no path specified");
  const startList = pyAbspath(start)
    .split("/")
    .filter((x) => x !== "");
  const pathList = pyAbspath(path)
    .split("/")
    .filter((x) => x !== "");
  let i = 0;
  while (i < startList.length && i < pathList.length && startList[i] === pathList[i]) i++;
  const relList = [...Array<string>(startList.length - i).fill(".."), ...pathList.slice(i)];
  return relList.length === 0 ? "." : relList.join("/");
}

const SCHEME_CHARS = /^[A-Za-z0-9+\-.]+$/;

/** ``urllib.parse.urlparse(uri)`` reduced to ``(scheme, path)``. */
function urlSchemeAndPath(uri: string): [string, string] {
  // eslint-disable-next-line no-control-regex
  let url = uri.replace(/^[\x00-\x20]+/, "").replace(/[\t\r\n]/g, "");
  let scheme = "";
  const i = url.indexOf(":");
  if (i > 0 && /^[A-Za-z]/.test(url) && SCHEME_CHARS.test(url.slice(0, i))) {
    scheme = url.slice(0, i).toLowerCase();
    url = url.slice(i + 1);
  }
  if (url.startsWith("//")) {
    let end = url.length;
    for (const c of "/?#") {
      const at = url.indexOf(c, 2);
      if (at >= 0) end = Math.min(end, at);
    }
    url = url.slice(end);
  }
  const hash = url.indexOf("#");
  if (hash >= 0) url = url.slice(0, hash);
  const q = url.indexOf("?");
  if (q >= 0) url = url.slice(0, q);
  return [scheme, url];
}

/** ``urllib.parse.unquote`` (UTF-8, errors="replace"). */
function unquote(s: string): string {
  if (!s.includes("%")) return s;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(run.slice(k * 3 + 1, k * 3 + 3), 16);
    return new TextDecoder("utf-8").decode(bytes);
  });
}

/**
 * Normalize a URI or file path to be relative to ``rootPath``.
 *
 * Handles file:// URIs, absolute paths, and relative paths. Returns null if
 * the path cannot be resolved.
 */
export function normalizePath(uri: string, rootPath: string): string | null {
  let path = uri;
  const [scheme, parsedPath] = urlSchemeAndPath(uri);
  if (scheme === "file") path = unquote(parsedPath);
  else if (scheme !== "") return null;

  if (path.startsWith("/")) return pyRelpath(path, rootPath);
  return path;
}

/**
 * Find graph nodes whose source location overlaps the given range.
 * Returns node IDs sorted by span size (tightest match first).
 */
export function findOverlappingNodes(graph: CodeGraph, relPath: string, startLine: number, endLine: number): string[] {
  const root = graph.rootPath;
  const matches: [number, string][] = [];
  for (const [nodeId, node] of graph.nodes) {
    const loc = node.location;
    const nodeRel = normalizePath(loc.filePath, root);
    if (nodeRel === null || nodeRel !== relPath) continue;
    if (loc.startLine <= endLine && loc.endLine >= startLine) matches.push([loc.endLine - loc.startLine, nodeId]);
  }
  // Array.prototype.sort is stable, like Python's sort with a key.
  matches.sort((a, b) => a[0] - b[0]);
  return matches.map(([, id]) => id);
}

/** Python ``str(value)`` for JSON-ish values (used in f-strings). */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Python ``a + b`` for line numbers. */
function addInt(a: unknown, b: number): number {
  if (typeof a === "number") return a + b;
  if (typeof a === "boolean") return Number(a) + b;
  throw new TypeError(`can only concatenate ${pyTypeName(a)} (not "int") to ${pyTypeName(a)}`);
}

// ── SARIF processing ──

function sarifToolName(run: unknown): string {
  const tool = get(run, "tool", {});
  const driver = get(tool, "driver", {});
  return get(driver, "name", "unknown") as string;
}

function sarifLevel(result: unknown): string {
  return get(result, "level", "warning") as string;
}

/** Build a compact single-line description from a SARIF result. */
function formatSarifDescription(result: unknown, toolName: string): string {
  const level = pyStr(sarifLevel(result)).toUpperCase();
  const ruleId = get(result, "ruleId", "unknown");
  const message = get(get(result, "message", {}), "text", "");
  return `[${level}] ${pyStr(ruleId)}: ${pyStr(message)} (${pyStr(toolName)})`;
}

/** Map a single SARIF result to graph nodes and annotate them. */
function processSarifResult(result: unknown, toolName: string, graph: CodeGraph): Set<string> {
  const description = formatSarifDescription(result, toolName);
  const source = `sarif:${pyStr(toolName)}`;
  const allNodeIds = new Set<string>();
  for (const loc of iter(get(result, "locations", []))) {
    const phys = get(loc, "physicalLocation", {});
    for (const id of nodesFromPhysicalLocation(phys, graph)) allNodeIds.add(id);
  }
  annotateNodes(graph, allNodeIds, description, source);
  return allNodeIds;
}

/** Resolve a SARIF physicalLocation to overlapping graph nodes. */
function nodesFromPhysicalLocation(phys: unknown, graph: CodeGraph): string[] {
  const artifact = get(phys, "artifactLocation", {});
  const uri = get(artifact, "uri", "");
  if (!pyTruthy(uri)) return [];

  const region = get(phys, "region", {});
  const startLine = get(region, "startLine", 1) as number;
  const endLine = get(region, "endLine", startLine) as number;

  const relPath = normalizePath(uri as string, graph.rootPath);
  if (relPath === null) return [];
  return findOverlappingNodes(graph, relPath, startLine, endLine);
}

function addTo(sets: Map<string, Set<string>>, key: string, ids: Iterable<string>): void {
  let set = sets.get(key);
  if (set === undefined) {
    set = new Set();
    sets.set(key, set);
  }
  for (const id of ids) set.add(id);
}

/** Add node IDs to SARIF-derived subgraphs by level and tool. */
function addToSubgraphs(sets: Map<string, Set<string>>, nodeIds: Set<string>, result: unknown, toolName: string): void {
  addTo(sets, `sarif:${pyStr(sarifLevel(result))}`, nodeIds);
  addTo(sets, `sarif:${pyStr(toolName)}`, nodeIds);
}

// ── weAudit processing ──

/** Extract a default author from the weAudit file metadata. */
function weauditAuthor(data: unknown): string {
  const remote = get(data, "clientRemote", "") as string;
  if (remote.includes("/")) return remote.slice(remote.lastIndexOf("/") + 1);
  return "unknown";
}

/** Build a compact single-line description from a weAudit entry. */
function formatWeauditDescription(entry: unknown, author: string): string {
  const details = get(entry, "details", {});
  const severity = (get(details, "severity", "") as string).toUpperCase() || "UNSET";
  const label = get(entry, "label", "untitled");
  const findingType = get(details, "type", "");
  const desc = get(details, "description", "");

  const parts = [`[${severity}] ${pyStr(label)}`];
  if (pyTruthy(findingType)) parts.push(`(${pyStr(findingType)})`);
  if (pyTruthy(desc)) {
    const s = desc as string;
    const nl = s.indexOf("\n");
    parts.push(`- ${nl >= 0 ? s.slice(0, nl) : s}`);
  }
  parts.push(`[${pyStr(author)}]`);
  return parts.join(" ");
}

/** Map a single weAudit entry to graph nodes and annotate them. */
function processWeauditEntry(entry: unknown, data: unknown, graph: CodeGraph): Set<string> {
  // Upstream evaluates the default eagerly: entry.get("author", _weaudit_author(data)).
  const author = get(entry, "author", weauditAuthor(data)) as string;
  const description = formatWeauditDescription(entry, author);
  const entryType = get(entry, "entryType", 0);
  const kind: AnnotationKind = entryType === 1 || entryType === true ? "audit_note" : "finding";
  const source = `weaudit:${pyStr(author)}`;
  const allNodeIds = new Set<string>();
  for (const loc of iter(get(entry, "locations", []))) {
    for (const id of nodesFromWeauditLocation(loc, graph)) allNodeIds.add(id);
  }
  annotateNodes(graph, allNodeIds, description, source, kind);
  return allNodeIds;
}

/** Resolve a weAudit location (0-indexed lines) to overlapping graph nodes. */
function nodesFromWeauditLocation(loc: unknown, graph: CodeGraph): string[] {
  const path = get(loc, "path", "");
  if (!pyTruthy(path)) return [];
  const startLine = addInt(get(loc, "startLine", 0), 1);
  const endLine = addInt(get(loc, "endLine", 0), 1);
  const relPath = normalizePath(path as string, graph.rootPath);
  if (relPath === null) return [];
  return findOverlappingNodes(graph, relPath, startLine, endLine);
}

/** Add node IDs to weAudit-derived subgraphs. */
function addWeauditToSubgraphs(sets: Map<string, Set<string>>, nodeIds: Set<string>, entry: unknown): void {
  const entryType = get(entry, "entryType", 0);
  addTo(sets, entryType === 0 || entryType === false ? "weaudit:findings" : "weaudit:notes", nodeIds);
  const details = get(entry, "details", {});
  const severity = (get(details, "severity", "") as string).toLowerCase();
  if (severity) addTo(sets, `weaudit:${severity}`, nodeIds);
}

// ── Shared helpers ──

function annotateNodes(
  graph: CodeGraph,
  nodeIds: Set<string>,
  description: string,
  source: string,
  kind: AnnotationKind = "finding",
): void {
  const ann: Annotation = { kind, description, source };
  for (const nodeId of nodeIds) graph.addAnnotation(nodeId, ann);
}
