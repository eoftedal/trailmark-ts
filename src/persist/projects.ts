/**
 * Persisted analyzed graphs ("projects"), including annotations, entrypoints
 * and subgraphs, so an audit session survives page reloads.
 */

import type { CodeGraph } from "../models/graph.js";
import { graphFromData, graphToData, type GraphData } from "../serialize.js";
import { IndexedDbKeyValueStore, MemoryKeyValueStore, type KeyValueStore } from "./kv.js";
import { PARSER_CACHE_VERSION, type ParseCache } from "./parse-cache.js";

export interface ProjectMeta {
  id: string;
  name: string;
  language: string;
  rootPath: string;
  nodeCount: number;
  edgeCount: number;
  savedAt: string;
}

export interface ProjectRecord {
  meta: ProjectMeta;
  graph: GraphData;
}

export class ProjectStore {
  constructor(private readonly kv: KeyValueStore<ProjectRecord>) {}

  async save(id: string, graph: CodeGraph, name = id): Promise<ProjectMeta> {
    const meta: ProjectMeta = {
      id,
      name,
      language: graph.language,
      rootPath: graph.rootPath,
      nodeCount: graph.nodes.size,
      edgeCount: graph.edges.length,
      savedAt: new Date().toISOString(),
    };
    await this.kv.set(id, { meta, graph: graphToData(graph) });
    return meta;
  }

  async load(id: string): Promise<CodeGraph | undefined> {
    const rec = await this.kv.get(id);
    return rec === undefined ? undefined : graphFromData(rec.graph);
  }

  async list(): Promise<ProjectMeta[]> {
    const metas: ProjectMeta[] = [];
    for (const key of await this.kv.keys()) {
      const rec = await this.kv.get(key);
      if (rec !== undefined) metas.push(rec.meta);
    }
    return metas.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async delete(id: string): Promise<void> {
    await this.kv.delete(id);
  }
}

/** ``ParseCache`` over any key-value store. */
export class KeyValueParseCache implements ParseCache {
  constructor(private readonly kv: KeyValueStore<GraphData>) {}
  get(key: string): Promise<GraphData | undefined> {
    return this.kv.get(key);
  }
  set(key: string, value: GraphData): Promise<void> {
    return this.kv.set(key, value);
  }
  clear(): Promise<void> {
    return this.kv.clear();
  }
  /** Delete entries written by other parser versions (they can never be hit again). Returns the count. */
  async pruneStale(): Promise<number> {
    let removed = 0;
    for (const key of await this.kv.keys()) {
      if (!key.startsWith(`${PARSER_CACHE_VERSION}|`)) {
        await this.kv.delete(key);
        removed++;
      }
    }
    return removed;
  }
}

/** Browser persistence: projects and parse cache in the ``trailmark`` IndexedDB database. */
export function indexedDbPersistence(dbName = "trailmark"): { projects: ProjectStore; parseCache: KeyValueParseCache } {
  return {
    projects: new ProjectStore(new IndexedDbKeyValueStore<ProjectRecord>("graphs", dbName)),
    parseCache: new KeyValueParseCache(new IndexedDbKeyValueStore<GraphData>("parse-cache", dbName)),
  };
}

/** In-memory persistence (tests, or environments without IndexedDB). */
export function memoryPersistence(): { projects: ProjectStore; parseCache: KeyValueParseCache } {
  return {
    projects: new ProjectStore(new MemoryKeyValueStore()),
    parseCache: new KeyValueParseCache(new MemoryKeyValueStore()),
  };
}
