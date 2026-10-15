/**
 * Node.js entry point (``trailmark-ts/node``): filesystem-backed helpers on top of
 * the browser-safe core.
 */

import { NodeFileSource } from "./fs/node.js";
import type { CodeGraph } from "./models/graph.js";
import { parseDirectory, type ParseOptions } from "./parse.js";
import { QueryEngine, type FromSourceOptions } from "./query/api.js";

export * from "./index.js";
export { NodeFileSource } from "./fs/node.js";
export { FsKeyValueStore } from "./persist/fs-kv.js";
export { withGitWorktree, CalledProcessError } from "./git-worktree.js";

/** Parse a directory on disk (upstream ``parse_directory(path, language)``). */
export function parseDirectoryFromPath(
  path: string,
  language = "python",
  options: ParseOptions = {},
): Promise<CodeGraph> {
  return parseDirectory(new NodeFileSource(path), language, options);
}

/** Build a ``QueryEngine`` from a directory on disk (upstream ``QueryEngine.from_directory``). */
export function engineFromPath(path: string, options: FromSourceOptions = {}): Promise<QueryEngine> {
  return QueryEngine.fromSource(new NodeFileSource(path), options);
}
