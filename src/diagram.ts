/**
 * Generate Mermaid diagrams from Trailmark code graphs (port of ``diagram.py``).
 *
 * Browser-safe: building an engine from a directory is the caller's job (the
 * CLI uses ``NodeFileSource``). Upstream's ``print(..., file=sys.stderr)``
 * warnings go through an injectable ``warn`` callback, and upstream's
 * ``SystemExit(1)`` on an unknown focus node becomes a thrown ``DiagramError``.
 */

import { ArgumentParser, type Namespace } from "./argparse.js";
import type { QueryEngine } from "./query/api.js";

const MAX_NODES = 100;

export const DIAGRAM_TYPES = [
  "call-graph",
  "class-hierarchy",
  "module-deps",
  "containment",
  "complexity",
  "data-flow",
] as const;

export type DiagramType = (typeof DIAGRAM_TYPES)[number];

const CONTAINER_KINDS = new Set(["class", "struct", "interface", "trait", "enum"]);

const MEMBER_KINDS = new Set(["function", "method"]);

/** Receives one warning line (upstream prints these to stderr). */
export type WarnFn = (line: string) => void;

const defaultWarn: WarnFn = (line) => console.error(line);

/** Raised where upstream prints an error and exits with status 1. */
export class DiagramError extends Error {
  readonly exitCode = 1;
  constructor(message: string) {
    super(message);
    this.name = "DiagramError";
  }
}

type NodeDict = Record<string, unknown>;
type GraphDict = { nodes?: Record<string, NodeDict>; edges?: NodeDict[] };
type EdgeTuple = [string, string, string];

/** Python ``dict.get(key, fallback)``: a present key wins even if its value is null. */
function get(d: NodeDict, key: string, fallback: unknown = null): unknown {
  return Object.hasOwn(d, key) ? d[key] : fallback;
}

/** Python ``str()`` of a JSON value, as used in f-strings. */
function pyStr(value: unknown): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

/** Python truthiness for JSON values. */
function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

/** Convert a Trailmark node ID to a Mermaid-safe identifier. */
export function sanitizeId(nodeId: string): string {
  // Python's ``re.sub`` works per code point, so astral characters become one ``_``.
  const safe = nodeId.replace(/[^a-zA-Z0-9_]/gu, "_");
  if (!safe) return "n_empty";
  // ``str.isdigit`` on the first character (ASCII here since the rest were replaced).
  if (/^[0-9]/.test(safe)) return `n_${safe}`;
  return safe;
}

/** Build a human-readable label for a graph node. */
export function nodeLabel(node: NodeDict): string {
  const name = get(node, "name", get(node, "id", "?"));
  const kind = get(node, "kind", "");
  const cc = get(node, "cyclomatic_complexity");
  const parts = [pyStr(name)];
  if (truthy(kind)) parts.push(pyStr(kind));
  if (cc !== null && cc !== undefined) parts.push(`CC=${pyStr(cc)}`);
  return parts.join(", ");
}

/**
 * ``nodeLabel`` escaped for a quoted Mermaid flowchart label (``id["..."]``).
 *
 * Divergence from upstream: upstream emits the raw label, so any ``"`` (common
 * in unresolved-call proxy names such as ``rs.getString("id")``) makes the
 * whole diagram fail to parse. Mermaid decodes ``#quot;`` back to ``"``.
 */
export function mermaidLabel(node: NodeDict): string {
  return nodeLabel(node).replaceAll('"', "#quot;");
}

/** Return a Mermaid arrow based on edge confidence. */
export function edgeStyle(confidence: string): string {
  if (confidence === "inferred") return "-.->";
  if (confidence === "uncertain") return "-..->";
  return "-->";
}

/** Map cyclomatic complexity to a Mermaid style class name. */
export function complexityClass(cc: number | null | undefined): string {
  if (cc === null || cc === undefined || cc < 5) return "low";
  if (cc <= 10) return "medium";
  return "high";
}

/** Parse the engine's full JSON export into a dict. */
function loadGraph(engine: QueryEngine): GraphDict {
  return JSON.parse(engine.toJson()) as GraphDict;
}

function graphNodes(graph: GraphDict): Record<string, NodeDict> {
  return graph.nodes ?? {};
}

function graphEdges(graph: GraphDict): NodeDict[] {
  return graph.edges ?? [];
}

/** Return a comma-separated sample of available node names. */
function suggestFocus(graph: GraphDict, limit = 20): string {
  return Object.entries(graphNodes(graph))
    .slice(0, limit)
    .map(([nid, n]) => pyStr(get(n, "name", nid)))
    .join(", ");
}

/** Resolve a focus name to a node ID, or null. */
function findFocusNode(graph: GraphDict, focus: string): string | null {
  const nodes = graphNodes(graph);
  if (Object.hasOwn(nodes, focus)) return focus;
  for (const [nid, node] of Object.entries(nodes)) {
    if (get(node, "name") === focus || nid.endsWith(`:${focus}`)) return nid;
    if (nid.endsWith(`.${focus}`)) return nid;
  }
  return null;
}

/** Resolve a focus name or throw a ``DiagramError`` with a helpful message. */
function requireFocusNode(graph: GraphDict, focus: string): string {
  const nid = findFocusNode(graph, focus);
  if (nid !== null) return nid;
  throw new DiagramError(`Error: node '${focus}' not found.\nAvailable: ${suggestFocus(graph)}`);
}

function confidenceOf(e: NodeDict): string {
  return pyStr(get(e, "confidence", "certain"));
}

// ── BFS neighbor collection ─────────────────────────────────────

/** BFS from focus node collecting nodes and call edges. */
export function collectNeighbors(
  engine: QueryEngine,
  focusName: string,
  depth: number,
): [Record<string, NodeDict>, EdgeTuple[]] {
  const graph = loadGraph(engine);
  const focusId = requireFocusNode(graph, focusName);

  const nodesMap = graphNodes(graph);
  const callFwd = new Map<string, [string, string][]>();
  const callRev = new Map<string, [string, string][]>();
  for (const e of graphEdges(graph)) {
    if (get(e, "kind") !== "calls") continue;
    const src = e["source"] as string;
    const tgt = e["target"] as string;
    const conf = confidenceOf(e);
    if (!callFwd.has(src)) callFwd.set(src, []);
    callFwd.get(src)!.push([tgt, conf]);
    if (!callRev.has(tgt)) callRev.set(tgt, []);
    callRev.get(tgt)!.push([src, conf]);
  }

  const collected: Record<string, NodeDict> = {};
  const collectedEdges: EdgeTuple[] = [];
  const queue: [string, number][] = [[focusId, 0]];
  const visited = new Set([focusId]);

  for (let qi = 0; qi < queue.length; qi++) {
    const [nid, d] = queue[qi]!;
    if (Object.hasOwn(nodesMap, nid)) collected[nid] = nodesMap[nid]!;
    if (d >= depth) continue;
    for (const [tgt, conf] of callFwd.get(nid) ?? []) {
      collectedEdges.push([nid, tgt, conf]);
      if (!visited.has(tgt)) {
        visited.add(tgt);
        queue.push([tgt, d + 1]);
      }
    }
    for (const [src, conf] of callRev.get(nid) ?? []) {
      collectedEdges.push([src, nid, conf]);
      if (!visited.has(src)) {
        visited.add(src);
        queue.push([src, d + 1]);
      }
    }
  }

  return [collected, collectedEdges];
}

// ── Emitters ─────────────────────────────────────────────────────

/** Emit a Mermaid flowchart of call relationships. */
export function emitCallGraph(
  engine: QueryEngine,
  focus: string | null,
  depth: number,
  direction: string,
  warn: WarnFn = defaultWarn,
): string {
  let nodes: Record<string, NodeDict>;
  let edges: EdgeTuple[];
  if (focus) {
    [nodes, edges] = collectNeighbors(engine, focus, depth);
  } else {
    const graph = loadGraph(engine);
    nodes = graphNodes(graph);
    edges = graphEdges(graph)
      .filter((e) => get(e, "kind") === "calls")
      .map((e) => [e["source"] as string, e["target"] as string, confidenceOf(e)]);
    warnIfLarge(nodes, warn);
  }
  return renderFlowchart(nodes, edges, direction);
}

/** Emit a Mermaid classDiagram of inheritance relationships. */
export function emitClassHierarchy(engine: QueryEngine, direction: string): string {
  const graph = loadGraph(engine);
  const nodes = graphNodes(graph);
  const edges = graphEdges(graph);

  const typeNodes = new Map(Object.entries(nodes).filter(([, n]) => CONTAINER_KINDS.has(get(n, "kind") as string)));
  if (typeNodes.size === 0) return emptyDiagram("classDiagram", "No classes found");

  const lines = ["classDiagram"];
  for (const [nid, n] of typeNodes) {
    lines.push(`    class ${sanitizeId(nid)} {\n        ${pyStr(get(n, "kind", ""))}\n    }`);
  }

  for (const e of edges) {
    const src = get(e, "source") as string;
    const tgt = get(e, "target") as string;
    const kind = get(e, "kind");
    if (kind === "inherits" && typeNodes.has(src) && typeNodes.has(tgt)) {
      lines.push(`    ${sanitizeId(tgt)} <|-- ${sanitizeId(src)}`);
    } else if (kind === "implements" && typeNodes.has(src) && typeNodes.has(tgt)) {
      lines.push(`    ${sanitizeId(tgt)} <|.. ${sanitizeId(src)}`);
    }
  }

  return lines.join("\n");
}

/** Emit a Mermaid flowchart of module import relationships. */
export function emitModuleDeps(engine: QueryEngine, direction: string, warn: WarnFn = defaultWarn): string {
  const graph = loadGraph(engine);
  const nodes = graphNodes(graph);
  const importEdges: EdgeTuple[] = graphEdges(graph)
    .filter((e) => get(e, "kind") === "imports")
    .map((e) => [e["source"] as string, e["target"] as string, confidenceOf(e)]);
  if (importEdges.length === 0) return emptyDiagram(`flowchart ${direction}`, "No import edges found");

  const involved = new Set<string>();
  for (const [src, tgt] of importEdges) {
    involved.add(src);
    involved.add(tgt);
  }
  const modNodes = Object.fromEntries(Object.entries(nodes).filter(([nid]) => involved.has(nid)));
  warnIfLarge(modNodes, warn);
  return renderFlowchart(modNodes, importEdges, direction);
}

/** Emit a Mermaid classDiagram showing class members. */
export function emitContainment(engine: QueryEngine, direction: string): string {
  const graph = loadGraph(engine);
  const nodes = graphNodes(graph);
  const edges = graphEdges(graph);

  const containers = new Map<string, string[]>();
  for (const e of edges) {
    if (get(e, "kind") !== "contains") continue;
    const parent = e["source"] as string;
    const child = e["target"] as string;
    const parentNode = nodes[parent] ?? {};
    const childNode = nodes[child] ?? {};
    if (CONTAINER_KINDS.has(get(parentNode, "kind") as string) && MEMBER_KINDS.has(get(childNode, "kind") as string)) {
      if (!containers.has(parent)) containers.set(parent, []);
      containers.get(parent)!.push(child);
    }
  }

  if (containers.size === 0) return emptyDiagram("classDiagram", "No containment found");

  const lines = ["classDiagram"];
  for (const [parentId, children] of containers) {
    const sid = sanitizeId(parentId);
    lines.push(`    class ${sid} {`);
    for (const childId of children) {
      const child = nodes[childId] ?? {};
      const cname = pyStr(get(child, "name", childId));
      let ret = "";
      const rt = get(child, "return_type");
      if (truthy(rt)) {
        ret =
          rt !== null && typeof rt === "object" && !Array.isArray(rt)
            ? ` ${pyStr(get(rt as NodeDict, "name", ""))}`
            : ` ${pyStr(rt)}`;
      }
      lines.push(`        +${cname}()${ret}`);
    }
    lines.push("    }");
  }

  return lines.join("\n");
}

/** Emit a flowchart with nodes color-coded by complexity. */
export function emitComplexity(
  engine: QueryEngine,
  threshold: number,
  direction: string,
  warn: WarnFn = defaultWarn,
): string {
  const graph = loadGraph(engine);
  const nodes = graphNodes(graph);
  const edges = graphEdges(graph);

  const ccNodes = Object.fromEntries(
    Object.entries(nodes).filter(([, n]) => ((get(n, "cyclomatic_complexity") as number | null) || 0) >= threshold),
  );
  if (Object.keys(ccNodes).length === 0) {
    return emptyDiagram(`flowchart ${direction}`, `No nodes with CC >= ${threshold}`);
  }

  const ccIds = new Set(Object.keys(ccNodes));
  const callEdges: EdgeTuple[] = edges
    .filter((e) => get(e, "kind") === "calls" && ccIds.has(e["source"] as string) && ccIds.has(e["target"] as string))
    .map((e) => [e["source"] as string, e["target"] as string, confidenceOf(e)]);

  warnIfLarge(ccNodes, warn);
  const lines = [`flowchart ${direction}`];
  for (const [nid, n] of Object.entries(ccNodes)) {
    const sid = sanitizeId(nid);
    const label = mermaidLabel(n);
    const cls = complexityClass(get(n, "cyclomatic_complexity") as number | null);
    lines.push(`    ${sid}["${label}"]:::${cls}`);
  }

  for (const [src, tgt, conf] of callEdges) {
    lines.push(`    ${sanitizeId(src)} ${edgeStyle(conf)} ${sanitizeId(tgt)}`);
  }

  lines.push("    classDef low fill:rgba(40,167,69,0.2),stroke:#28a745,color:#28a745");
  lines.push("    classDef medium fill:rgba(255,193,7,0.2),stroke:#e6a817,color:#e6a817");
  lines.push("    classDef high fill:rgba(220,53,69,0.2),stroke:#dc3545,color:#dc3545");

  return lines.join("\n");
}

/** Emit a flowchart showing paths from entrypoints. */
export function emitDataFlow(
  engine: QueryEngine,
  focus: string | null,
  depth: number,
  direction: string,
  warn: WarnFn = defaultWarn,
): string {
  const surface = engine.attackSurface();
  if (surface.length === 0) return emptyDiagram(`flowchart ${direction}`, "No entrypoints found");

  const graph = loadGraph(engine);
  const nodes = graphNodes(graph);
  // Upstream uses a set here (hash-ordered); insertion order is used instead.
  const epIds = new Set(surface.map((ep) => ep["node_id"] as string));

  const allPathNodes: Record<string, NodeDict> = {};
  const allPathEdges: EdgeTuple[] = [];

  const targets = resolveDataFlowTargets(engine, graph, focus, epIds);

  for (const epId of epIds) {
    for (const tgtId of targets) {
      for (const path of engine.pathsBetween(epId, tgtId)) collectPath(path, nodes, allPathNodes, allPathEdges);
    }
  }

  if (Object.keys(allPathNodes).length === 0) {
    return emptyDiagram(`flowchart ${direction}`, "No paths from entrypoints to targets");
  }

  warnIfLarge(allPathNodes, warn);
  const lines = [`flowchart ${direction}`];
  for (const [nid, n] of Object.entries(allPathNodes)) {
    const sid = sanitizeId(nid);
    const label = mermaidLabel(n);
    if (epIds.has(nid)) lines.push(`    ${sid}(["${label}"]):::entrypoint`);
    else lines.push(`    ${sid}["${label}"]`);
  }

  const seenEdges = new Set<string>();
  for (const [src, tgt, conf] of allPathEdges) {
    const key = JSON.stringify([src, tgt]);
    if (!seenEdges.has(key)) {
      seenEdges.add(key);
      lines.push(`    ${sanitizeId(src)} ${edgeStyle(conf)} ${sanitizeId(tgt)}`);
    }
  }

  lines.push("    classDef entrypoint fill:rgba(0,123,255,0.2),stroke:#007bff,color:#007bff");

  return lines.join("\n");
}

/** Determine target node IDs for data-flow diagrams. */
function resolveDataFlowTargets(
  engine: QueryEngine,
  graph: GraphDict,
  focus: string | null,
  epIds: Set<string>,
): string[] {
  if (focus) return [requireFocusNode(graph, focus)];
  const hotspots = engine.complexityHotspots(10);
  return hotspots
    .map((h) => h["id"] as string)
    .filter((id) => !epIds.has(id))
    .slice(0, 10);
}

/** Add nodes and edges from a single path to collectors. */
function collectPath(
  path: string[],
  nodes: Record<string, NodeDict>,
  outNodes: Record<string, NodeDict>,
  outEdges: EdgeTuple[],
): void {
  for (const nid of path) {
    if (!Object.hasOwn(outNodes, nid) && Object.hasOwn(nodes, nid)) outNodes[nid] = nodes[nid]!;
  }
  for (let i = 0; i < path.length - 1; i++) outEdges.push([path[i]!, path[i + 1]!, "certain"]);
}

// ── Shared rendering helpers ─────────────────────────────────────

/** Render a generic Mermaid flowchart from nodes and edges. */
function renderFlowchart(nodes: Record<string, NodeDict>, edges: EdgeTuple[], direction: string): string {
  const lines = [`flowchart ${direction}`];
  for (const [nid, n] of Object.entries(nodes)) {
    lines.push(`    ${sanitizeId(nid)}["${mermaidLabel(n)}"]`);
  }
  for (const [src, tgt, conf] of edges) {
    lines.push(`    ${sanitizeId(src)} ${edgeStyle(conf)} ${sanitizeId(tgt)}`);
  }
  return lines.join("\n");
}

/** Return a minimal diagram with a note about missing data. */
function emptyDiagram(header: string, message: string): string {
  const sid = sanitizeId(message.replaceAll(" ", "_"));
  return `${header}\n    ${sid}[${message}]`;
}

/** Warn if the node set exceeds the cap. */
export function warnIfLarge(nodes: Record<string, unknown> | Map<string, unknown>, warn: WarnFn = defaultWarn): void {
  const size = nodes instanceof Map ? nodes.size : Object.keys(nodes).length;
  if (size > MAX_NODES) {
    warn(`Warning: ${size} nodes exceeds ${MAX_NODES}. Consider using --focus to scope the diagram.`);
  }
}

// ── CLI argument handling ────────────────────────────────────────

export interface DiagramOptions {
  diagramType: DiagramType;
  focus: string | null;
  depth: number;
  direction: string;
  threshold: number;
}

/**
 * Register the diagram CLI options on a parser or subparser.
 *
 * Shared by the standalone diagram parser and the ``trailmark diagram``
 * subcommand so both expose an identical interface.
 */
export function addDiagramArguments(parser: ArgumentParser): void {
  parser.addArgument(["--target", "-t"], { required: true, help: "Directory to analyze" });
  parser.addArgument(["--language", "-l"], { default: "python", help: "Source language" });
  parser.addArgument(["--type", "-T"], {
    required: true,
    choices: DIAGRAM_TYPES,
    dest: "diagram_type",
    help: "Diagram type",
  });
  parser.addArgument(["--focus", "-f"], { default: null, help: "Focus node name" });
  parser.addArgument(["--depth", "-d"], { type: "int", default: 2, help: "BFS depth" });
  parser.addArgument("--direction", { default: "TB", choices: ["TB", "LR"], help: "Layout direction" });
  parser.addArgument("--threshold", { type: "int", default: 10, help: "Complexity threshold" });
}

/** Build the standalone diagram argument parser (upstream ``python -m trailmark.diagram``). */
export function buildDiagramParser(prog = "diagram.py", columns?: number): ArgumentParser {
  const p = new ArgumentParser({ prog, description: "Generate Mermaid diagrams from Trailmark graphs.", columns });
  addDiagramArguments(p);
  return p;
}

/** Parse command-line arguments. Throws ``ArgParseExit`` on help/errors. */
export function parseArgs(argv: readonly string[]): Namespace {
  return buildDiagramParser().parseArgs(argv);
}

/** Convert a parsed argparse namespace into ``DiagramOptions``. */
export function diagramOptionsFromArgs(args: Namespace): DiagramOptions {
  return {
    diagramType: args["diagram_type"] as DiagramType,
    focus: (args["focus"] as string | null) ?? null,
    depth: args["depth"] as number,
    direction: args["direction"] as string,
    threshold: args["threshold"] as number,
  };
}

/** Dispatch to the emitter for ``options.diagramType`` and return Mermaid text. */
export function renderDiagram(engine: QueryEngine, options: DiagramOptions, warn: WarnFn = defaultWarn): string {
  switch (options.diagramType) {
    case "call-graph":
      return emitCallGraph(engine, options.focus, options.depth, options.direction, warn);
    case "complexity":
      return emitComplexity(engine, options.threshold, options.direction, warn);
    case "data-flow":
      return emitDataFlow(engine, options.focus, options.depth, options.direction, warn);
    case "class-hierarchy":
      return emitClassHierarchy(engine, options.direction);
    case "module-deps":
      return emitModuleDeps(engine, options.direction, warn);
    default:
      return emitContainment(engine, options.direction);
  }
}
