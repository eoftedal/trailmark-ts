/** Interface every language parser implements. */

import type { CodeGraph } from "../models/graph.js";

export interface ParserOptions {
  /**
   * Produce exactly upstream trailmark's output. When false (the default),
   * parsers may record extra facts (such as ``receiver_type`` on call edges)
   * that post-merge passes use to resolve more calls than upstream does.
   */
  upstreamCompat?: boolean;
}

export interface LanguageParser {
  /** The language this parser handles (e.g. ``"python"``). */
  readonly language: string;
  /** File extensions the directory walk includes (upstream ``_EXTENSIONS``). */
  readonly extensions: readonly string[];
  /** Grammar names (``grammars/tree-sitter-<name>.wasm``) that must be loaded before parsing. */
  readonly grammars: readonly string[];
  /**
   * Parse one file's text into a code graph. Synchronous: the driver loads the
   * grammars first. ``filePath`` is recorded verbatim in source locations.
   */
  parseFile(filePath: string, source: string, options?: ParserOptions): CodeGraph;
}
