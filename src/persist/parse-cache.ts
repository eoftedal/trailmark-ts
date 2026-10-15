/** Content-addressed cache of per-file parse results. */

import type { CodeGraph } from "../models/graph.js";
import { graphFromData, graphToData, type GraphData } from "../serialize.js";
import { PARSER_FINGERPRINT } from "./parser-fingerprint.generated.js";

/**
 * Part of every cache key. The fingerprint is a hash of the parser sources,
 * models and grammars (``scripts/parser-fingerprint.mjs``), so any change to
 * what a parser produces invalidates old entries automatically.
 */
export const PARSER_CACHE_VERSION = `trailmark-ts/2/${PARSER_FINGERPRINT}`;

export interface ParseCache {
  get(key: string): Promise<GraphData | undefined>;
  set(key: string, value: GraphData): Promise<void>;
}

/** In-memory parse cache (default when none is given is no caching). */
export class MemoryParseCache implements ParseCache {
  private readonly map = new Map<string, GraphData>();
  async get(key: string): Promise<GraphData | undefined> {
    return this.map.get(key);
  }
  async set(key: string, value: GraphData): Promise<void> {
    this.map.set(key, value);
  }
  get size(): number {
    return this.map.size;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Cache key for one file. A per-file graph depends on the language, the file
 * path (recorded in locations), the directory root (module IDs), and content.
 */
export async function parseCacheKey(
  language: string,
  filePath: string,
  root: string | null,
  text: string,
  mode = "",
): Promise<string> {
  return `${PARSER_CACHE_VERSION}|${mode}|${language}|${root ?? ""}|${filePath}|${await sha256Hex(text)}`;
}

export async function cachedParse(
  cache: ParseCache | undefined,
  language: string,
  filePath: string,
  root: string | null,
  text: string,
  parse: () => CodeGraph,
  mode = "",
): Promise<CodeGraph> {
  if (cache === undefined) return parse();
  const key = await parseCacheKey(language, filePath, root, text, mode);
  const hit = await cache.get(key);
  if (hit !== undefined) return graphFromData(hit);
  const graph = parse();
  await cache.set(key, graphToData(graph));
  return graph;
}
