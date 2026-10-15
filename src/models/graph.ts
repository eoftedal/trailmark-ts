/** Top-level graph container that holds parsed code data. */

import type { Annotation, AnnotationKind, EntrypointTag } from "./annotations.js";
import type { CodeEdge } from "./edges.js";
import type { CodeUnit } from "./nodes.js";

/** A complete code graph for a parsed project or file. Mutable. */
export class CodeGraph {
  nodes = new Map<string, CodeUnit>();
  edges: CodeEdge[] = [];
  annotations = new Map<string, Annotation[]>();
  entrypoints = new Map<string, EntrypointTag>();
  subgraphs = new Map<string, Set<string>>();
  dependencies: string[] = [];
  language: string;
  rootPath: string;

  constructor(init: { language?: string; rootPath?: string } = {}) {
    this.language = init.language ?? "";
    this.rootPath = init.rootPath ?? "";
  }

  /** Append an annotation to the given node. */
  addAnnotation(nodeId: string, annotation: Annotation): void {
    let list = this.annotations.get(nodeId);
    if (list === undefined) {
      list = [];
      this.annotations.set(nodeId, list);
    }
    list.push(annotation);
  }

  /** Remove annotations for a node, optionally filtered by kind. */
  clearAnnotations(nodeId: string, kind: AnnotationKind | null = null): void {
    const list = this.annotations.get(nodeId);
    if (list === undefined) return;
    if (kind === null) {
      this.annotations.delete(nodeId);
      return;
    }
    const kept = list.filter((a) => a.kind !== kind);
    if (kept.length === 0) this.annotations.delete(nodeId);
    else this.annotations.set(nodeId, kept);
  }

  /** Merge another graph into this one. */
  merge(other: CodeGraph): void {
    for (const [id, unit] of other.nodes) this.nodes.set(id, unit);
    for (const edge of other.edges) this.edges.push(edge);
    for (const [id, anns] of other.annotations) {
      for (const ann of anns) this.addAnnotation(id, ann);
    }
    for (const [id, tag] of other.entrypoints) this.entrypoints.set(id, tag);
    for (const [name, ids] of other.subgraphs) {
      let set = this.subgraphs.get(name);
      if (set === undefined) {
        set = new Set();
        this.subgraphs.set(name, set);
      }
      for (const id of ids) set.add(id);
    }
    for (const dep of other.dependencies) {
      if (!this.dependencies.includes(dep)) this.dependencies.push(dep);
    }
  }
}
