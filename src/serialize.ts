/**
 * Lossless (de)serialization of ``CodeGraph`` for persistence and caching.
 *
 * Distinct from ``QueryEngine.toJson()``, which reproduces upstream's export
 * format but omits annotations, entrypoints and edge locations.
 */

import type { Annotation, EntrypointTag } from "./models/annotations.js";
import type { CodeEdge } from "./models/edges.js";
import { CodeGraph } from "./models/graph.js";
import type { CodeUnit } from "./models/nodes.js";

export const GRAPH_FORMAT = "trailmark-graph/1";

export interface GraphData {
  format: typeof GRAPH_FORMAT;
  language: string;
  rootPath: string;
  nodes: CodeUnit[];
  edges: CodeEdge[];
  annotations: [string, Annotation[]][];
  entrypoints: [string, EntrypointTag][];
  subgraphs: [string, string[]][];
  dependencies: string[];
}

export function graphToData(graph: CodeGraph): GraphData {
  return {
    format: GRAPH_FORMAT,
    language: graph.language,
    rootPath: graph.rootPath,
    nodes: [...graph.nodes.values()],
    edges: [...graph.edges],
    annotations: [...graph.annotations].map(([id, anns]) => [id, [...anns]]),
    entrypoints: [...graph.entrypoints],
    subgraphs: [...graph.subgraphs].map(([name, ids]) => [name, [...ids]]),
    dependencies: [...graph.dependencies],
  };
}

export function graphFromData(data: GraphData): CodeGraph {
  if (data.format !== GRAPH_FORMAT) throw new Error(`Unsupported graph format: ${String(data.format)}`);
  const graph = new CodeGraph({ language: data.language, rootPath: data.rootPath });
  for (const unit of data.nodes) graph.nodes.set(unit.id, unit);
  graph.edges = [...data.edges];
  for (const [id, anns] of data.annotations) graph.annotations.set(id, [...anns]);
  for (const [id, tag] of data.entrypoints) graph.entrypoints.set(id, tag);
  for (const [name, ids] of data.subgraphs) graph.subgraphs.set(name, new Set(ids));
  graph.dependencies = [...data.dependencies];
  return graph;
}

export function graphToJsonString(graph: CodeGraph): string {
  return JSON.stringify(graphToData(graph));
}

export function graphFromJsonString(text: string): CodeGraph {
  return graphFromData(JSON.parse(text) as GraphData);
}
