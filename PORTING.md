# Porting guide (Python trailmark → trailmark-ts)

Upstream: https://github.com/trailofbits/trailmark at `f7e19d3ee37c02ca4e897e1bb901fc4868888e21` (v0.5.0).
Goal: **behavioral parity**. Output JSON must be byte-identical to upstream for the same input.

## Mapping

| Python                                                                                  | TypeScript                                                                                                                                                                           |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CodeUnit(...)` dataclass                                                               | `codeUnit({...})` factory (`src/models/nodes.ts`) — always use factories so defaults are filled                                                                                      |
| `CodeEdge(...)`                                                                         | `codeEdge({...})` (`src/models/edges.ts`)                                                                                                                                            |
| `TypeRef(name=..)`, `Parameter`, `TypeParameter`, `BranchInfo`, `SourceLocation`        | `typeRef()`, `parameter()`, `typeParameter()`, `branchInfo()`, `sourceLocation()`                                                                                                    |
| `NodeKind.FUNCTION`, `EdgeKind.CALLS`, `EdgeConfidence.INFERRED`, ...                   | string literals: `"function"`, `"calls"`, `"inferred"` (the enum `.value`)                                                                                                           |
| `dataclasses.replace(edge, target_id=x)`                                                | `{ ...edge, targetId: x }`                                                                                                                                                           |
| snake_case fields (`source_id`, `cyclomatic_complexity`)                                | camelCase (`sourceId`, `cyclomaticComplexity`)                                                                                                                                       |
| `graph.nodes[id] = unit` / `dict`                                                       | `graph.nodes.set(id, unit)` (`Map`, insertion-ordered like dict)                                                                                                                     |
| `graph.annotations`, `entrypoints`, `subgraphs`                                         | `Map`s; subgraph values are `Set<string>`                                                                                                                                            |
| `frozenset({...})` of node types                                                        | `new Set([...])`                                                                                                                                                                     |
| tree-sitter `node.child_by_field_name(f)`                                               | `node.childForFieldName(f)` (returns `null`)                                                                                                                                         |
| `node.children`, `node.type`, `node.named_children`                                     | `node.children`, `node.type`, `node.namedChildren`                                                                                                                                   |
| `node.start_point.row`                                                                  | `node.startPosition.row` (always go through `makeLocation` for locations: it converts columns to UTF-8 bytes)                                                                        |
| `node.parent`, `node.prev_sibling`, `node.next_named_sibling`                           | `node.parent`, `node.previousSibling`, `node.nextNamedSibling`                                                                                                                       |
| `node_text(n)`                                                                          | `nodeText(n)`                                                                                                                                                                        |
| `_common.*` helpers                                                                     | `src/parsers/common.ts` (same names in camelCase)                                                                                                                                    |
| `sorted(strings)`                                                                       | `[...x].sort(pyCompare)` (`src/fs/source.ts`)                                                                                                                                        |
| `s.rsplit(":", 1)[-1]` / `split(x, 1)` / `rsplit(x,1)` / `str.split()` / `strip(chars)` | `rsplitLast`, `splitOnce`, `rsplitOnce`, `pySplitWhitespace`, `pyStrip` (`common.ts`)                                                                                                |
| `repr(s)` in messages                                                                   | `pyRepr(s)` (`src/util/py.ts`)                                                                                                                                                       |
| `json.dumps(...)`                                                                       | `pyJsonDumps(value, indent, sortKeys)` (`src/util/py.ts`)                                                                                                                            |
| `tomllib.loads`                                                                         | `parse` from `smol-toml`                                                                                                                                                             |
| Reading files (`Path.read_text`, `open`)                                                | async via a `FileSource` (`src/fs/source.ts`); never import `node:fs` outside `src/fs/node.ts`, `src/cli.ts`, `src/node.ts`, or `test/`                                              |
| `re` regex                                                                              | JS `RegExp`. Translate `(?P<n>..)`→`(?<n>..)`, `re.match` = anchored at start (use `^` or sticky), `re.fullmatch` = `^(?:..)$`. Python `\w` is Unicode-aware; acceptable difference. |

## Language parsers

A parser is a class implementing `LanguageParser` (`src/parsers/base.ts`): `language`, `extensions`
(upstream `_EXTENSIONS`), `grammars` (WASM grammar names in `grammars/`), and a **synchronous**
`parseFile(filePath, source): CodeGraph`. See `src/parsers/python.ts` as the reference port.

- Get a tree with `parseWithGrammar("<grammar>", source)` and `tree.delete()` in `finally` — WASM memory is not GC'd.
- Do not keep tree-sitter `Node` references after `parseFile` returns.
- `moduleIdFromPath(filePath)` already handles directory-relative module IDs (the driver sets the root).
- Keep the upstream function structure and names (camelCased) so future upstream diffs are easy to port. Keep upstream comments that explain _why_.
- Prefer iterative traversal (explicit stack) where upstream does; WASM stack is limited.

## Verifying parity

- KAT snapshots: `npx vitest run test/kat-parsers.test.ts -t <language>` (fixtures copied verbatim from upstream).
- Reference implementation (Python) for ad-hoc differential checks. One-time setup:
  `git clone https://github.com/trailofbits/trailmark "$UPSTREAM" && git -C "$UPSTREAM" checkout f7e19d3 && (cd "$UPSTREAM" && uv sync --all-groups)`,
  then `cd "$UPSTREAM" && uv run python -c "from trailmark.parse import parse_file; ..."`.
  `$UPSTREAM` is any directory of your choosing outside this repo.
- Port the relevant upstream pytest file (`$UPSTREAM/tests/test_<x>.py`) to `test/<x>.test.ts` (vitest). Skip only tests that depend on
  features not ported yet, with a `it.skip` + reason.
- `npm run typecheck`, `npm run format` (Prettier, 120 cols).
- Some tests (e.g. the entrypoint self-analysis tests) run against an upstream checkout; set `TRAILMARK_UPSTREAM="$UPSTREAM"` to enable them. They skip otherwise.

## Known intentional differences

### Improvements over upstream (default on; `upstreamCompat: true` turns them off)

Parity tests (KAT snapshots, differential runs) must use `upstreamCompat: true` / `--upstream-compat`.
Keep improvements out of the line-by-line ports where possible: parsers only record extra facts when
`options.upstreamCompat` is false, and separate passes act on them.

- **Receiver-type call resolution** (Java). `src/parsers/java-receivers.ts` infers the declared type of a call's
  receiver (locals, parameters, fields, `this`/`super`, `new X().m()`, static `X.m()`), and the Java parser records it
  as the edge attribute `receiver_type`. After merging, `src/analysis/receivers.ts` maps the type name to a class-like
  node (unique name, else same module, else same package) and links the edge to the method on that type or its nearest
  supertype, adding `raw_target` and `resolved_by = receiver_type`. Other languages can opt in by recording
  `receiver_type` the same way.
- **Java declarations upstream skips.** `record` declarations (kind `class`, attribute `java_type_kind = record`) with a
  synthetic accessor method per component (`origin: synthetic`, `synthetic_reason = record_accessor`) unless one is
  declared, compact constructors, nested types (IDs `module:Outer.Inner`, contained by the outer type), and methods
  declared in enum bodies. Receiver types keep nested qualifiers (`Comment.Id`), and the resolver also indexes types by
  their in-module path.

- **JS/TS anonymous callbacks and top-level code** (`src/parsers/js-toplevel.ts`). Function expressions inside
  top-level statements become function nodes `module:<callee>@<line>` (e.g. `server:app.get@6`) with attributes
  `anonymous`, `callback_of`, `route` (leading string argument) and `registered_on_factory` (when the receiver was
  assigned from a top-level call such as `express()`). Calls made directly by top-level statements become calls from
  the module node. Functions upstream already extracts (`const f = () => ...` at top level) are left alone.
- **Express/Fastify route entrypoints.** Implements upstream's documented-but-unimplemented pattern
  (`docs/entrypoint-patterns.md`): callbacks registered via `get/post/put/patch/delete/all/use/options/head` on a
  receiver created by `express()`, `express.Router()`, `Router()` or `fastify()` are `api` / `untrusted_external` /
  `high`. It keys on the parser attributes above, so it never fires on upstream-compatible graphs.

### Other differences

- Entrypoint detection walks up from the parsed directory to find the repo root (`pyproject.toml`,
  `.trailmark/entrypoints.toml`). Sources that implement `FileSource.resolve` (`NodeFileSource`) walk every parent like
  upstream; browser sources cannot see above their root, so the walk stops there.
- Python regexes supplied by users (`name_regex` in `.trailmark/entrypoints.toml`) are translated to JS `RegExp`
  best-effort; `\w`/`\b` are ASCII-only.
- Mermaid diagrams escape `"` in node labels as `#quot;`. Upstream emits them raw, which makes any diagram containing an
  unresolved call with a string argument (e.g. `rs.getString("id")`) fail to parse in Mermaid.
- Unhandled CLI errors print a one-line `Error: ...` instead of a Python traceback (same exit code).
