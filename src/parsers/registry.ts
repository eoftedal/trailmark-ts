/** Language → parser registry. Parsers are imported lazily so browser bundles can code-split. */

import type { LanguageParser } from "./base.js";

type ParserFactory = () => Promise<LanguageParser>;

const PARSERS: Record<string, ParserFactory> = {
  python: async () => new (await import("./python.js")).PythonParser(),
  javascript: async () => new (await import("./javascript.js")).JavaScriptParser(),
  typescript: async () => new (await import("./typescript.js")).TypeScriptParser(),
  c: async () => new (await import("./c.js")).CParser(),
  cpp: async () => new (await import("./cpp.js")).CppParser(),
  java: async () => new (await import("./java.js")).JavaParser(),
  go: async () => new (await import("./go.js")).GoParser(),
  rust: async () => new (await import("./rust.js")).RustParser(),
  solidity: async () => new (await import("./solidity.js")).SolidityParser(),
};

/**
 * Extensions used for language auto-detection, in upstream registration order
 * (which is also the detection result order). Languages without a ported parser
 * yet are listed so the table stays aligned with upstream; ``detectLanguages``
 * only reports implemented ones.
 */
export const LANGUAGE_EXTENSIONS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["python", [".py"]],
  ["javascript", [".js", ".jsx", ".mjs", ".cjs"]],
  ["typescript", [".ts", ".tsx"]],
  ["php", [".php"]],
  ["ruby", [".rb"]],
  ["c", [".c"]],
  ["cpp", [".cpp", ".cc", ".cxx", ".hpp", ".hh", ".hxx"]],
  ["c_sharp", [".cs"]],
  ["java", [".java"]],
  ["go", [".go"]],
  ["rust", [".rs"]],
  ["solidity", [".sol"]],
  ["cairo", [".cairo"]],
  ["circom", [".circom"]],
  ["haskell", [".hs"]],
  ["erlang", [".erl"]],
  ["masm", [".masm"]],
  ["swift", [".swift"]],
  // `.h` can be C, ObjC, or C++; auto-detect only fires on .m/.mm.
  ["objc", [".m", ".mm"]],
  ["kotlin", [".kt", ".kts"]],
  ["dart", [".dart"]],
  ["move", [".move"]],
  ["tact", [".tact"]],
  ["func", [".fc", ".func"]],
  ["sway", [".sw"]],
  ["rego", [".rego"]],
  ["proto", [".proto"]],
  ["thrift", [".thrift"]],
  ["graphql", [".graphql", ".gql"]],
  ["sql", [".sql"]],
];

/** Languages with a ported parser, in upstream registration order. */
export function supportedLanguages(): string[] {
  return LANGUAGE_EXTENSIONS.map(([lang]) => lang).filter((lang) => lang in PARSERS);
}

export function isSupportedLanguage(language: string): boolean {
  return Object.hasOwn(PARSERS, language);
}

const instances = new Map<string, Promise<LanguageParser>>();

/** Instantiate (once) the parser for ``language``. Throws on unsupported languages. */
export function getParser(language: string): Promise<LanguageParser> {
  const factory = Object.hasOwn(PARSERS, language) ? PARSERS[language] : undefined;
  if (factory === undefined) return Promise.reject(new Error(`Unsupported language: ${language}`));
  let p = instances.get(language);
  if (p === undefined) {
    p = factory();
    instances.set(language, p);
  }
  return p;
}
