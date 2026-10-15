/** Public parse-only API for building raw Trailmark code graphs. */

import { applyRepositoryLinks } from "./analysis/links.js";
import { ensureProxyNodes } from "./analysis/proxies.js";
import { walkFiles, type FileSource } from "./fs/source.js";
import { CodeGraph } from "./models/graph.js";
import { resolveReceiverTypes } from "./analysis/receivers.js";
import type { LanguageParser, ParserOptions } from "./parsers/base.js";
import { linkCrossFileCalls, shouldSkipDir, withDirectoryRoot, withSource } from "./parsers/common.js";
import { getParser, isSupportedLanguage, LANGUAGE_EXTENSIONS, supportedLanguages } from "./parsers/registry.js";
import { cachedParse, type ParseCache } from "./persist/parse-cache.js";
import { loadGrammar } from "./treesitter.js";
import { basename, normalize } from "./util/path.js";

export { supportedLanguages };

export interface ParseProgress {
  language: string;
  filePath: string;
  /** Files finished so far for this language. */
  done: number;
}

export interface ParseOptions extends ParserOptions {
  /** Per-file parse cache (e.g. ``IndexedDbParseCache``) for incremental re-analysis. */
  cache?: ParseCache;
  onProgress?: (p: ParseProgress) => void;
}

/** Parse one file's text with the given language. Grammars are loaded on demand. */
export async function parseSource(
  filePath: string,
  text: string,
  language?: string,
  options: ParserOptions = {},
): Promise<CodeGraph> {
  const lang = resolveFileLanguage(filePath, language);
  const parser = await readyParser(lang);
  const graph = runParser(parser, filePath, text, null, options);
  if (!options.upstreamCompat) resolveReceiverTypes(graph);
  return ensureProxyNodes(graph);
}

/** Parse a single file from ``source`` into a raw ``CodeGraph``. */
export async function parseFile(
  source: FileSource,
  path: string,
  language?: string,
  options: ParserOptions = {},
): Promise<CodeGraph> {
  const text = await source.readText(path);
  if (text === null) throw new Error(`File not found: ${path}`);
  return parseSource(path, text, language, options);
}

/**
 * Parse a directory into a raw ``CodeGraph``.
 *
 * ``language`` accepts a language name (``"python"``), ``"auto"`` to detect and
 * merge every supported language, or a comma-separated list (``"python,rust"``).
 * ``dir`` defaults to ``source.root``.
 */
export async function parseDirectory(
  source: FileSource,
  language = "python",
  options: ParseOptions & { dir?: string } = {},
): Promise<CodeGraph> {
  const dir = options.dir ?? source.root;
  const languages = await resolveDirectoryLanguages(source, dir, language);
  if (languages.length === 1) {
    const graph = await parseLanguageDirectory(languages[0]!, source, dir, options);
    await applyRepositoryLinks(graph, source, dir);
    return ensureProxyNodes(graph);
  }
  const merged = new CodeGraph({ language: "polyglot", rootPath: dir });
  for (const lang of languages) merged.merge(await parseLanguageDirectory(lang, source, dir, options));
  merged.language = "polyglot";
  await applyRepositoryLinks(merged, source, dir);
  return ensureProxyNodes(merged);
}

/** Return the supported languages with at least one file under ``dir``, in registration order. */
export async function detectLanguages(source: FileSource, dir: string = source.root): Promise<string[]> {
  const extToLanguage = new Map<string, string>();
  for (const [lang, exts] of LANGUAGE_EXTENSIONS) {
    if (!isSupportedLanguage(lang)) continue;
    for (const ext of exts) if (!extToLanguage.has(ext)) extToLanguage.set(ext, lang);
  }
  const found = new Set<string>();
  for await (const file of walkFiles(source, dir, shouldSkipDir)) {
    const lang = extToLanguage.get(fileExtension(basename(file)));
    if (lang !== undefined) found.add(lang);
  }
  return LANGUAGE_EXTENSIONS.map(([lang]) => lang).filter((lang) => found.has(lang));
}

async function readyParser(language: string): Promise<LanguageParser> {
  const parser = await getParser(language);
  await Promise.all(parser.grammars.map(loadGrammar));
  return parser;
}

function runParser(
  parser: LanguageParser,
  filePath: string,
  text: string,
  root: string | null,
  options: ParserOptions,
): CodeGraph {
  const parserOptions: ParserOptions = { upstreamCompat: options.upstreamCompat ?? false };
  const run = () => withSource(text, () => parser.parseFile(filePath, text, parserOptions));
  return root === null ? run() : withDirectoryRoot(normalize(root), run);
}

/** Port of ``_common.parse_directory``: walk, parse each file, merge, link, proxy. */
async function parseLanguageDirectory(
  language: string,
  source: FileSource,
  dir: string,
  options: ParseOptions,
): Promise<CodeGraph> {
  const parser = await readyParser(language);
  const merged = new CodeGraph({ language, rootPath: dir });
  let done = 0;
  for await (const filePath of walkFiles(source, dir, shouldSkipDir)) {
    const name = basename(filePath);
    if (!parser.extensions.some((ext) => name.endsWith(ext))) continue;
    const text = await source.readText(filePath);
    if (text === null) continue;
    const fileGraph = await cachedParse(
      options.cache,
      language,
      filePath,
      dir,
      text,
      () => runParser(parser, filePath, text, dir, options),
      options.upstreamCompat ? "compat" : "",
    );
    merged.merge(fileGraph);
    options.onProgress?.({ language, filePath, done: ++done });
  }
  linkCrossFileCalls(merged);
  // Not in upstream: resolve ``receiver.method()`` calls using receiver types.
  if (!options.upstreamCompat) resolveReceiverTypes(merged);
  return ensureProxyNodes(merged);
}

function resolveFileLanguage(path: string, language: string | undefined): string {
  if (language === undefined || language === "auto") {
    const detected = detectFileLanguage(path);
    if (detected === null) throw new Error(`Could not infer supported language from file extension: ${path}`);
    return detected;
  }
  if (language.includes(",")) throw new Error(`Single-file parse requires one language, got: ${language}`);
  if (!isSupportedLanguage(language)) throw new Error(`Unsupported language: ${language}`);
  return language;
}

async function resolveDirectoryLanguages(source: FileSource, dir: string, spec: string): Promise<string[]> {
  if (spec === "auto") {
    const detected = await detectLanguages(source, dir);
    if (detected.length === 0) throw new Error(`No supported languages detected under ${dir}`);
    return detected;
  }
  const names = spec.includes(",")
    ? spec
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean)
    : [spec];
  for (const name of names) if (!isSupportedLanguage(name)) throw new Error(`Unsupported language: ${name}`);
  return names;
}

function detectFileLanguage(path: string): string | null {
  const ext = fileExtension(basename(path));
  for (const [lang, exts] of LANGUAGE_EXTENSIONS) {
    if (exts.includes(ext) && isSupportedLanguage(lang)) return lang;
  }
  return null;
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot).toLowerCase();
}
