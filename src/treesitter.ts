/**
 * web-tree-sitter runtime: one-time WASM init plus lazily loaded grammars.
 *
 * Grammar loading is async (WASM fetch/compile); parsing is synchronous once a
 * grammar is loaded. The parse driver awaits ``loadGrammar`` for every grammar
 * a language parser declares before calling its synchronous ``parseFile``.
 */

import { Language, Parser, type Node, type Tree } from "web-tree-sitter";

export type { Node, Tree };

/** Resolves a grammar name (e.g. ``"python"``) to WASM bytes or a URL/path. */
export type GrammarLoader = (name: string) => Promise<Uint8Array | string>;

export interface TreeSitterConfig {
  /** Custom grammar loader. Defaults to the bundled ``grammars/`` directory. */
  grammarLoader?: GrammarLoader;
  /** Base URL for grammar WASM files when running in a browser. */
  grammarBaseUrl?: string | URL;
  /** Passed to web-tree-sitter's ``Parser.init`` to locate ``web-tree-sitter.wasm``. */
  locateFile?: (path: string, prefix: string) => string;
}

let config: TreeSitterConfig = {};
let initPromise: Promise<void> | null = null;
const languages = new Map<string, Promise<Language>>();
const loaded = new Map<string, Language>();
const parsers = new Map<string, Parser>();

/** Configure grammar/runtime locations. Must be called before the first parse. */
export function configureTreeSitter(next: TreeSitterConfig): void {
  config = { ...config, ...next };
}

function isNode(): boolean {
  return typeof process !== "undefined" && process.versions?.node !== undefined;
}

async function init(): Promise<void> {
  if (initPromise === null) {
    const opts = config.locateFile ? { locateFile: config.locateFile } : undefined;
    initPromise = Parser.init(opts);
  }
  return initPromise;
}

function grammarFileName(name: string): string {
  return `tree-sitter-${name}.wasm`;
}

async function defaultLoader(name: string): Promise<Uint8Array | string> {
  const file = grammarFileName(name);
  if (config.grammarBaseUrl !== undefined) {
    const url = new URL(file, config.grammarBaseUrl);
    if (url.protocol === "file:" && isNode()) {
      const { readFile } = await import("node:fs/promises");
      return new Uint8Array(await readFile(url));
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to fetch grammar ${name}: ${res.status} ${url}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  // Works from both src/ (tsx/vitest) and dist/ since both sit one level below the package root.
  const url = new URL(`../grammars/${file}`, import.meta.url);
  if (isNode()) {
    const { readFile } = await import("node:fs/promises");
    return new Uint8Array(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch grammar ${name}: ${res.status} ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Load (once) and return the grammar with the given name. */
export async function loadGrammar(name: string): Promise<Language> {
  let pending = languages.get(name);
  if (pending === undefined) {
    pending = (async () => {
      await init();
      const loader = config.grammarLoader ?? defaultLoader;
      const lang = await Language.load(await loader(name));
      loaded.set(name, lang);
      return lang;
    })();
    languages.set(name, pending);
    pending.catch(() => languages.delete(name));
  }
  return pending;
}

/** Whether ``loadGrammar(name)`` has completed. */
export function isGrammarLoaded(name: string): boolean {
  return loaded.has(name);
}

/** Parse ``source`` with an already-loaded grammar. Caller must ``tree.delete()``. */
export function parseWithGrammar(name: string, source: string): Tree {
  const lang = loaded.get(name);
  if (lang === undefined) {
    throw new Error(`Grammar not loaded: ${name} (await loadGrammar("${name}") first)`);
  }
  let parser = parsers.get(name);
  if (parser === undefined) {
    parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(name, parser);
  }
  const tree = parser.parse(source);
  if (tree === null) throw new Error(`tree-sitter failed to parse with grammar ${name}`);
  return tree;
}
