/**
 * Trailmark (TypeScript): parse source code into queryable graphs for security analysis.
 *
 * This entry point is browser-safe. Node-only helpers (filesystem sources,
 * filesystem persistence) live in ``trailmark-ts/node``.
 */

export * from "./models/index.js";
export { detectLanguages, parseDirectory, parseFile, parseSource, supportedLanguages } from "./parse.js";
export type { ParseOptions, ParseProgress } from "./parse.js";
export type { LanguageParser } from "./parsers/base.js";
export { QueryEngine, type FromSourceOptions } from "./query/api.js";
export type { Json, JsonObject } from "./query/dicts.js";
export { GraphStore } from "./storage/graph-store.js";
export {
  DirectoryHandleFileSource,
  fileSourceFromFileList,
  MemoryFileSource,
  type DirectoryHandleLike,
  type DirEntry,
  type FileSource,
} from "./fs/source.js";
export { configureTreeSitter, loadGrammar, type GrammarLoader, type TreeSitterConfig } from "./treesitter.js";
export { graphFromData, graphFromJsonString, graphToData, graphToJsonString, type GraphData } from "./serialize.js";
export { MemoryParseCache, PARSER_CACHE_VERSION, type ParseCache } from "./persist/parse-cache.js";
export { IndexedDbKeyValueStore, MemoryKeyValueStore, type KeyValueStore } from "./persist/kv.js";
export {
  indexedDbPersistence,
  KeyValueParseCache,
  memoryPersistence,
  ProjectStore,
  type ProjectMeta,
  type ProjectRecord,
} from "./persist/projects.js";
export { applyRepositoryLinks, applyRepositoryLinksText } from "./analysis/links.js";
export { ensureProxyNodes } from "./analysis/proxies.js";
export { detectEntrypoints } from "./analysis/entrypoints.js";
export { runPreanalysis } from "./analysis/preanalysis.js";
export { computeDiff, formatDiff } from "./analysis/diff.js";
export {
  DIAGRAM_TYPES,
  DiagramError,
  emitCallGraph,
  emitClassHierarchy,
  emitComplexity,
  emitContainment,
  emitDataFlow,
  emitModuleDeps,
  renderDiagram,
  type DiagramOptions,
  type DiagramType,
} from "./diagram.js";
export { version } from "./version.js";
