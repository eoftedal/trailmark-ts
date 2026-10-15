# trailmark-ts

A TypeScript port of [Trail of Bits' Trailmark](https://github.com/trailofbits/trailmark): parse source code into
queryable graphs of functions, classes, calls, and semantic annotations for security analysis — in **Node.js or
directly in the browser**.

- **Same output as upstream, when you want it.** Parsers are line-by-line ports, and the grammars are built from the
  exact commits that upstream's `tree-sitter-language-pack` pins. In upstream-compat mode, the upstream known-answer
  snapshots are part of this test suite and must match byte for byte.
- **Runs in the browser.** Grammars are compiled to WASM (`web-tree-sitter`), files come from a folder picker or
  drag-and-drop, and nothing leaves the machine.
- **Persistent.** Analyzed graphs (including your annotations) and a per-file parse cache are stored in IndexedDB, so
  re-analysis only re-parses changed files.
- **Improvements over upstream, on by default.** Pass `upstreamCompat: true` (library) or `--upstream-compat` /
  `TRAILMARK_UPSTREAM_COMPAT=1` (CLI) for byte-identical upstream output.
  - Java calls through typed receivers (`repo.getProduct()` where `repo` is a `ProductRepository` field, parameter or
    local) are linked to the method, across files and through superclasses. Upstream leaves them unresolved.
  - Java records, nested types and enum-body methods are extracted. Upstream skips them.
  - JS/TS anonymous callbacks (such as Express route handlers) and top-level calls are extracted, and Express/Fastify
    routes are detected as entrypoints. Upstream extracts neither, and lists Express/Fastify as not yet implemented.

Ported from upstream v0.5.0 (`f7e19d3`).

## Status

| Area                                                                                                                                                                | Status                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Models, graph store, query engine, proxies, repository links                                                                                                        | ported                                                            |
| Parsers: Python, JavaScript, TypeScript, C, C++, Java, Go, Rust, Solidity                                                                                           | ported, byte-identical on upstream KAT snapshots                  |
| Entrypoint detection, pre-analysis, diff, SARIF/weAudit/binary augmentation                                                                                         | ported                                                            |
| Mermaid diagrams, Node CLI                                                                                                                                          | ported                                                            |
| Parsers: PHP, Ruby, C#, Kotlin, Swift, Dart, Haskell, Erlang, Cairo, Circom, Move, Tact, Func, Sway, Rego, Proto, Thrift, GraphQL, Objective-C, Miden Assembly, SQL | not yet (grammars are already pinned in `grammars/manifest.json`) |

## Install

```bash
npm install trailmark-ts
```

The package ships prebuilt grammar WASM files in `grammars/`.

## Usage

### Node

```ts
import { engineFromPath } from "trailmark-ts/node";

const engine = await engineFromPath("path/to/project", { language: "auto" });
engine.summary();
engine.callersOf("handle_request");
engine.ancestorsOf("Auth._check_sig"); // everything that can reach a sink
engine.entrypointPathsTo("Auth._check_sig");
engine.complexityHotspots(10);
engine.annotate("handle_request", "assumption", "Caller already authenticated", "llm");
console.log(engine.toJson()); // same JSON as upstream `trailmark analyze`
```

### CLI

The CLI matches upstream's commands, flags and output:

```bash
npx trailmark-ts analyze --language auto path/to/project
npx trailmark-ts analyze --summary path/to/project
npx trailmark-ts entrypoints --json path/to/project
npx trailmark-ts diff --repo . main HEAD
npx trailmark-ts diagram -t path/to/project -T call-graph -f parse_file --depth 3
```

### Browser

```ts
import { DirectoryHandleFileSource, QueryEngine, configureTreeSitter, indexedDbPersistence } from "trailmark-ts";

// Serve `grammars/*.wasm` and `web-tree-sitter/web-tree-sitter.wasm` as static assets, then:
configureTreeSitter({
  grammarBaseUrl: new URL("/grammars/", location.href),
  locateFile: (file) => new URL(`/${file}`, location.href).href,
});

const { projects, parseCache } = indexedDbPersistence();
const dir = await window.showDirectoryPicker();
const engine = await QueryEngine.fromSource(new DirectoryHandleFileSource(dir), {
  language: "auto",
  cache: parseCache, // per-file, content-hashed: unchanged files are not re-parsed
  onProgress: (p) => console.log(p.filePath),
});
await projects.save(dir.name, engine.graph); // later: QueryEngine.fromGraph(await projects.load(dir.name))
```

Other file sources: `MemoryFileSource` (any environment), `fileSourceFromFileList` (an `<input webkitdirectory>`), and
`NodeFileSource` (`trailmark-ts/node`). Implement `FileSource` to read from anywhere else, such as a zip archive or a git
host API.

Parsing is synchronous once grammars are loaded. For large repositories, run it in a Web Worker as the demo does.

### Demo app

```bash
npm run demo        # dev server
npm run demo:build  # static build in demo/dist
```

Open a folder to get an overview (summary, attack surface, complexity hotspots), explore callers, callees and
entrypoint paths per node, add annotations (saved to IndexedDB), and render Mermaid diagrams.

## API differences from upstream

| Upstream (Python)                                      | trailmark-ts                                                                                                 |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `QueryEngine.from_directory(path, language=...)`       | `await QueryEngine.fromSource(fileSource, { language })`, or `engineFromPath(path)` in Node                  |
| `parse_file(path)` / `parse_directory(path, language)` | `parseFile(source, path)`, `parseSource(path, text)`, `parseDirectory(source, language)` (all async)         |
| `engine.augment_sarif(path)`                           | `engine.augmentSarif(jsonTextOrObject)` (and likewise for weAudit and binary graphs)                         |
| Enums (`AnnotationKind.FINDING`)                       | string literals (`"finding"`)                                                                                |
| Output always identical to upstream                    | Identical with `upstreamCompat: true`; by default some extra calls are resolved (edges tagged `resolved_by`) |
| snake_case attributes                                  | camelCase on model objects; the JSON output keeps upstream's snake_case                                      |

Graphs serialize losslessly with `graphToData` / `graphFromData` (unlike `toJson()`, this keeps annotations,
entrypoints and edge locations).

## Development

```bash
npm install
npm test               # vitest, including upstream KAT snapshots
npm run typecheck
npm run format         # prettier
npm run build:grammars # rebuild grammars/*.wasm from grammars/manifest.json (needs git; downloads wasi-sdk)
```

See [PORTING.md](PORTING.md) for porting conventions and how to check parity against the Python implementation.

## License

Apache-2.0, like upstream. Test fixtures in `test/fixtures/kat` are copied from upstream Trailmark. See `LICENSE` and
`NOTICE.upstream`.
