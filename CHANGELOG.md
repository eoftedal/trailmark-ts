# Changelog

## [0.5.0]

First release: a TypeScript port of [Trail of Bits' Trailmark](https://github.com/trailofbits/trailmark) v0.5.0
(Python, `f7e19d3`) that runs in Node.js and in the browser.

### Port of the Python version

- Parsers for Python, JavaScript, TypeScript, C, C++, Java, Go, Rust and Solidity, ported line by line. The tree-sitter
  grammars are compiled to WASM from the exact commits upstream pins, so parse output matches upstream byte for byte
  (verified against upstream's known-answer snapshots and on real code bases).
- Graph model, graph store and query engine (callers/callees, ancestors, reachability, paths, attack surface,
  complexity hotspots, annotations, subgraphs), proxy nodes for unresolved calls, and `.trailmark/links.toml`
  repository links.
- Entrypoint detection for all 30 upstream languages' frameworks, pre-analysis passes, structural diff, and SARIF,
  weAudit and binary-graph augmentation.
- Mermaid diagrams (call graph, class hierarchy, module dependencies, containment, complexity, data flow).
- `trailmark` CLI with the same commands, options, help text and exit codes as upstream (`analyze`, `entrypoints`,
  `diff` including git refs, `augment`, `diagram`, `version`).
- Browser support: files from a folder picker, drag-and-drop or any custom `FileSource`; nothing is uploaded.
- Persistence: analyzed graphs (with annotations) and a content-hashed per-file parse cache in IndexedDB, in memory, or
  on disk in Node. The cache key includes a fingerprint of the parsers and grammars, so it invalidates itself when
  parser output changes.
- A browser demo app: overview, node explorer with annotations, and Mermaid diagrams, with parsing in a Web Worker.

### Improvements over upstream

These are on by default. `upstreamCompat: true` (library) or `--upstream-compat` / `TRAILMARK_UPSTREAM_COMPAT=1` (CLI)
turns them off for byte-identical upstream output.

- Java: calls through typed receivers (`repo.getProduct()` where `repo` is a field, parameter or local of type
  `ProductRepository`) are linked to the method on that type or its nearest supertype, across files. Upstream leaves
  them as unresolved proxies. Covers locals, parameters, fields, `this`/`super`, `new T().m()`, static `T.m()` and
  nested `Outer.Inner.m()`.
- Java: records (with their implicit accessor methods), compact constructors, nested types and methods declared in enum
  bodies are extracted. Upstream skips them.
- JavaScript/TypeScript: anonymous callbacks in top-level code (such as `app.get('/path', (req, res) => ...)`),
  object-literal methods and top-level generator expressions become function nodes, and calls made by top-level
  statements are recorded from the module. Upstream extracts none of them.
- JavaScript/TypeScript: Express and Fastify route handlers (including the CommonJS `require('express')()` forms) are
  detected as API entrypoints, as described in upstream's entrypoint patterns but not implemented there. Anonymous
  `export default` handlers under `pages/api` are detected as Next.js Pages API handlers.

### Bugfixes

- Mermaid diagrams no longer fail to render when a node label contains `"` (for example an unresolved call like
  `rs.getString("id")`). Upstream emits such labels unescaped.
