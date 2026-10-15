/**
 * Automatic entrypoint detection (port of ``analysis/entrypoints.py``).
 *
 * Populates ``CodeGraph.entrypoints`` so that ``attackSurface()``, taint
 * propagation, entrypoint enumeration, and privilege-boundary crossing
 * produce meaningful results.
 *
 * Detection layers (later layers override earlier ones):
 *
 * 1. **Generic ``main`` heuristic** — any function named ``main`` in any
 *    language. Tagged ``user_input`` / ``trusted_internal`` / ``low``.
 * 2. **Framework-aware scan** — decorator/attribute patterns per language:
 *
 *    - Python: Flask / FastAPI / aiohttp (``@app.route``, ``@router.get``);
 *      Click / Typer (``@click.command``, ``@app.command``); Celery
 *      (``@app.task``, ``@shared_task``).
 *    - JavaScript / TypeScript: NestJS decorators (``@Get``, ``@Post``,
 *      etc.), Next.js route handlers (App Router ``route.ts`` + HTTP-verb
 *      exports, Pages API ``pages/api/**``), AWS Lambda handlers.
 *    - Java: Spring (``@GetMapping``, ``@PostMapping``, ...), JAX-RS
 *      (``@GET``, ``@POST``), Kafka ``@KafkaListener``, servlet
 *      ``doGet``/``doPost``/... methods.
 *    - C#: ASP.NET Core ``[HttpGet]`` / ``[Route]`` attributes, Azure
 *      Functions ``[Function]`` / ``[FunctionName]``.
 *    - PHP: Symfony ``#[Route(...)]`` attributes and old-style
 *      ``@Route(...)`` annotations.
 *    - Rust: actix-web / rocket handler attributes (``#[get("/")]``, etc.),
 *      FFI exports (``#[no_mangle]``, ``pub extern "C"``),
 *      ``#[tokio::main]`` / ``#[actix_web::main]`` on ``main``.
 *    - Solidity: ``external``/``public`` function visibility, special
 *      ``fallback()`` / ``receive()``.
 *    - Cairo / StarkNet: ``#[external]``, ``#[view]``, ``#[l1_handler]``,
 *      ``#[constructor]`` attributes.
 *    - Circom: files declaring ``component main = ...``.
 *    - Miden Assembly: ``export.<name>`` directives.
 *    - Haskell: top-level ``main ::`` / ``main =`` bindings.
 *    - Erlang: functions listed in ``-export([...])``.
 * 3. **pyproject.toml [project.scripts]** — explicitly declared CLI targets.
 * 4. **Repo-local override file** — ``.trailmark/entrypoints.toml`` at the
 *    repository root. Always the authoritative source.
 *
 * TS port notes:
 *
 * - All file access goes through the async ``FileSource``. Source files are
 *   read up front into a cache (``SourceCache``); detection itself is
 *   synchronous over that cache, mirroring upstream's lazy ``_SourceCache``.
 * - Upstream's ``_find_repo_root`` walks up from the resolved parse path to
 *   the filesystem root. Here the walk is limited to ``source.root``: it
 *   checks ``rootPath`` and each parent directory up to and including
 *   ``source.root`` (files outside the source are not visible).
 * - ``name_regex`` override rules are Python regexes; they are translated to
 *   JS ``RegExp`` best-effort (named groups, leading inline flags). Patterns
 *   JS cannot compile are skipped, like upstream's ``re.error`` handling.
 */

import { parse as parseToml } from "smol-toml";

import type { FileSource } from "../fs/source.js";
import { pyCompare } from "../fs/source.js";
import {
  ASSET_VALUES,
  ENTRYPOINT_KINDS,
  TRUST_LEVELS,
  type AssetValue,
  type EntrypointKind,
  type EntrypointTag,
  type TrustLevel,
} from "../models/annotations.js";
import type { CodeGraph } from "../models/graph.js";
import type { AttributeValue, CodeUnit } from "../models/nodes.js";
import { dirname, posixRelative, rawJoin } from "../util/path.js";

export const OVERRIDE_FILE = ".trailmark/entrypoints.toml";

// How many lines above start_line to scan for decorators/attributes.
const DECORATOR_LOOKBACK = 12;

// Python HTTP web-framework decorator suffix on any receiver.
//   Matches: @app.route(...), @router.get(...), @bp.post(...), @routes.put(...)
//   (Flask, FastAPI, aiohttp, Sanic all share this shape.)
const PY_HTTP_DECORATOR =
  /^\s*@\s*[A-Za-z_][\w.]*\.(route|get|post|put|patch|delete|head|options|websocket|api_route)\s*\(/;

// @click.command / @click.group / @typer_app.command
const PY_CLI_DECORATOR = /^\s*@\s*(click\.(command|group)|[A-Za-z_][\w.]*\.command)\s*\(/;

// @celery_app.task, @shared_task, @app.task
const PY_TASK_DECORATOR = /^\s*@\s*([A-Za-z_][\w.]*\.task|shared_task)\b/;

// Rust proc-macro handler attributes: #[get("/")], #[post("/")], etc.
const RS_HTTP_ATTR = /^\s*#\[\s*(get|post|put|delete|patch|head|options|connect|trace)\s*\(/;

// Rust #[tokio::main] / #[async_std::main] / #[actix_web::main]
const RS_ASYNC_MAIN_ATTR = /^\s*#\[\s*\w+::main\s*\]\s*$/;

// Rust FFI export: #[no_mangle] or `pub extern "C" fn`
const RS_NO_MANGLE = /^\s*#\[\s*no_mangle\s*\]\s*$/;
const RS_EXTERN_C_FN = /\bpub\s+extern\s+"C"\s+fn\b/;

// JS/TS — NestJS method decorators: @Get(), @Post(), @Put(), @Delete(), @Patch(),
// @Options(), @Head(), @All(). Capital first letter distinguishes from free
// functions named `get`/`post`/etc.
const JS_NEST_DECORATOR = /^\s*@\s*(Get|Post|Put|Delete|Patch|Options|Head|All)\s*\(/;

// Java annotations — Spring MVC / WebFlux
const JAVA_SPRING_HANDLER = /^\s*@\s*(Get|Post|Put|Delete|Patch|Request)Mapping\b/;

// Java annotations — JAX-RS
const JAVA_JAXRS_HANDLER = /^\s*@\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*(?:\(|$)/;

// Java — Kafka listener
const JAVA_KAFKA_LISTENER = /^\s*@\s*KafkaListener\b/;

// C# attributes — ASP.NET Core controllers / Minimal APIs / Azure Functions
const CS_HTTP_ATTR = /^\s*\[\s*(HttpGet|HttpPost|HttpPut|HttpDelete|HttpPatch|HttpHead|HttpOptions|Route)\b/;
const CS_AZURE_FUNC_ATTR = /^\s*\[\s*Function(Name)?\s*\(/;

// PHP — Symfony Route attribute (PHP 8+)
const PHP_ROUTE_ATTR = /^\s*#\[\s*Route\s*\(/;

// PHP — Old-style annotation comments: @Route("/path")
const PHP_ROUTE_ANNOTATION = /^\s*\*\s*@Route\s*\(/;

// Cairo/StarkNet attributes
const CAIRO_CONTRACT_ATTR = /^\s*#\[\s*(external|view|l1_handler|constructor)\b/;

// Circom — component main declaration on the signature line
const CIRCOM_MAIN = /^\s*component\s+main\b/;

// Miden Assembly — exported procedures and program begin block
const MASM_EXPORT = /^\s*export\.([A-Za-z_]\w*)/;

// Erlang — -export([...]) declaration
const ERLANG_EXPORT = /^\s*-\s*export\s*\(\s*\[/;

// Haskell — `main :: IO ()` / `main = ...` at column 0
const HASKELL_MAIN = /^main\s*(::|=)/;

// Swift — @main on an App/struct indicates the entry point.
const SWIFT_MAIN_ATTR = /^\s*@main\b/;

// Swift — Vapor route registration: `app.get("/path") { req in ... }`
// and related `.post/.put/.delete/.patch` on any receiver.
const SWIFT_VAPOR_ROUTE = /^\s*[A-Za-z_]\w*\.(get|post|put|patch|delete|on)\s*\(/;

// Objective-C — AppDelegate lifecycle selectors on UIApplicationDelegate
const OBJC_APP_DELEGATE_SELECTORS: ReadonlySet<string> = new Set([
  "application:didFinishLaunchingWithOptions:",
  "application:openURL:options:",
  "application:continueUserActivity:restorationHandler:",
  "application:performFetchWithCompletionHandler:",
]);

// Kotlin — Ktor routing DSL: `get("/path") { ... }`, `post`, etc.
// These appear as call expressions inside a `routing { ... }` block. The
// file-level heuristic matches the verb calls; without block-level context
// we can't distinguish Ktor routes from bare HTTP client calls, so Ktor
// detection is currently disabled in favor of the override file.

// Kotlin — Android Activity lifecycle overrides. Names and signatures
// are stable across Android SDK versions.
const KOTLIN_ANDROID_LIFECYCLE_METHODS: ReadonlySet<string> = new Set([
  "onCreate",
  "onStart",
  "onResume",
  "onNewIntent",
  "onActivityResult",
  "onReceive", // BroadcastReceiver
  "onBind", // Service
  "onHandleIntent", // IntentService
]);

// Dart — `@pragma('vm:entry-point')` marks native-callable functions,
// often FFI or platform-channel callback targets. These are attacker-
// reachable from the host platform.
const DART_VM_ENTRY_POINT = /^\s*@\s*pragma\s*\(\s*['"]vm:entry-point['"]/;

// Go — `http.HandleFunc("/path", handler)` / `http.Handle("/path", h)`.
// The stdlib net/http registrations accept a string path and a handler
// reference.
const GO_HTTP_HANDLE = /\bhttp\.(HandleFunc|Handle)\s*\(\s*"[^"]*"\s*,\s*([A-Za-z_][\w.]*)/g;

// Go — gin/chi/echo/fiber route registration: `<router>.<VERB>("/path", handler)`.
// Matches GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS on any receiver. This is
// looser than the stdlib pattern so it catches most community routers,
// at the cost of possibly matching non-HTTP methods on unrelated types.
const GO_ROUTER_VERB =
  /\b([A-Za-z_]\w*)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Any|Match)\s*\(\s*"[^"]*"\s*,\s*([A-Za-z_][\w.]*)/g;

// Ruby — Rails controller: `class FooController < ApplicationController`
// (or any ActionController base / another controller).
const RUBY_RAILS_CONTROLLER_CLASS =
  /^\s*class\s+(\w+)\s*<\s*(ApplicationController|ActionController::\w+|\w+Controller)\b/;

// Ruby — Sidekiq worker: either `include Sidekiq::Worker` or
// `include Sidekiq::Job` inside a class body.
const RUBY_SIDEKIQ_INCLUDE = /^\s*include\s+Sidekiq::(Worker|Job)\b/;
const RUBY_CLASS_OPEN = /^\s*class\s+(\w+)\b/;

// C / C++ — explicit library export markers on the signature line.
//   extern "C" ...             (C++ C-linkage declaration)
//   __attribute__((visibility("default")))
//   __declspec(dllexport)
const C_EXPORT_MARKERS =
  /\bextern\s+"C"|__attribute__\s*\(\s*\(\s*visibility\s*\(\s*"default"|__declspec\s*\(\s*dllexport\s*\)/;

const SWAY_ABI_FN = /\bfn\s+\w+\s*\(/;

function tag(
  kind: EntrypointKind,
  trustLevel: TrustLevel,
  description: string | null,
  assetValue: AssetValue,
): EntrypointTag {
  return { kind, trustLevel, description, assetValue };
}

/**
 * Return detected entrypoints for ``graph`` rooted at ``rootPath``.
 *
 * Callers typically merge the result into ``graph.entrypoints``.
 *
 * @param graph The parsed code graph.
 * @param source File access for source files, ``pyproject.toml`` and the override file.
 * @param rootPath The directory the parser walked (a full path within ``source``).
 * @returns Mapping of node id -> EntrypointTag. Empty if none are detected.
 */
export async function detectEntrypoints(
  graph: CodeGraph,
  source: FileSource,
  rootPath: string,
): Promise<Map<string, EntrypointTag>> {
  const repoRoot = await findRepoRoot(source, rootPath);
  const cache = await SourceCache.load(source, frameworkSourcePaths(graph));
  const pyproject = await readOptional(source, rawJoin(repoRoot, "pyproject.toml"));
  const override = await readOptional(source, rawJoin(repoRoot, OVERRIDE_FILE));

  // Priority (least to most specific, later layers override earlier):
  //   1. Generic `main` functions — fallback heuristic.
  //   2. Framework-aware decorator/attribute scan.
  //   3. pyproject.toml [project.scripts] — explicitly-declared CLI targets.
  //   4. Override file — hand-curated, authoritative.
  const detected = new Map<string, EntrypointTag>();
  const update = (m: Map<string, EntrypointTag>) => {
    for (const [k, v] of m) detected.set(k, v);
  };
  update(detectMainFunctions(graph));
  update(detectFrameworkEntrypoints(graph, cache));
  update(detectPyprojectScripts(graph, pyproject));
  update(loadOverrideFile(graph, override));
  return detected;
}

async function readOptional(source: FileSource, path: string): Promise<string | null> {
  try {
    if (!(await source.isFile(path))) return null;
    return await source.readText(path);
  } catch {
    return null;
  }
}

/** File paths the framework scan may read (function/method units only). */
function frameworkSourcePaths(graph: CodeGraph): Set<string> {
  const paths = new Set<string>();
  for (const unit of graph.nodes.values()) {
    if (unit.kind !== "function" && unit.kind !== "method") continue;
    if (unit.location.filePath) paths.add(unit.location.filePath);
  }
  return paths;
}

/**
 * Scan source files for framework-specific entrypoint markers.
 *
 * Covers Python web/task/CLI decorators, Rust handler/FFI attributes,
 * and Solidity visibility. Designed to be additive: each node is checked
 * against every language's detectors because files of mixed languages
 * are rare but possible (embedded DSLs, templates).
 */
function detectFrameworkEntrypoints(graph: CodeGraph, cache: SourceCache): Map<string, EntrypointTag> {
  const result = new Map<string, EntrypointTag>();
  for (const [nodeId, unit] of graph.nodes) {
    if (unit.kind !== "function" && unit.kind !== "method") continue;
    const path = unit.location.filePath;
    if (!path) continue;
    const t = detectForUnit(cache, unit, path);
    if (t !== null) result.set(nodeId, t);
  }
  annotateOverriddenSolidityEntrypoints(graph, result);
  return result;
}

function endsWithAny(path: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => path.endsWith(s));
}

function detectForUnit(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  if (path.endsWith(".py")) return detectPython(cache, unit, path);
  if (path.endsWith(".rs")) return detectRust(cache, unit, path);
  if (path.endsWith(".sol")) return detectSolidity(unit);
  if (endsWithAny(path, [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"])) return detectJsTs(cache, unit, path);
  if (path.endsWith(".java")) return detectJava(cache, unit, path);
  if (path.endsWith(".cs")) return detectCsharp(cache, unit, path);
  if (path.endsWith(".php")) return detectPhp(cache, unit, path);
  if (path.endsWith(".cairo")) return detectCairo(cache, unit, path);
  if (path.endsWith(".circom")) return detectCircom(cache, unit, path);
  if (path.endsWith(".masm")) return detectMasm(cache, unit, path);
  if (path.endsWith(".hs")) return detectHaskell(cache, unit, path);
  if (path.endsWith(".erl")) return detectErlang(cache, unit, path);
  if (path.endsWith(".swift")) return detectSwift(cache, unit, path);
  if (endsWithAny(path, [".m", ".mm", ".h"])) return detectObjc(unit);
  if (endsWithAny(path, [".kt", ".kts"])) return detectKotlin(cache, unit, path);
  if (path.endsWith(".dart")) return detectDart(cache, unit, path);
  if (path.endsWith(".move")) return detectMove(cache, unit, path);
  if (path.endsWith(".tact")) return detectTact(unit);
  if (endsWithAny(path, [".fc", ".func"])) return detectFunc(unit);
  if (path.endsWith(".sw")) return detectSway(cache, unit, path);
  if (path.endsWith(".rego")) return detectRego(unit);
  if (path.endsWith(".proto")) return detectProto(unit);
  if (path.endsWith(".thrift")) return detectThrift(unit);
  if (endsWithAny(path, [".graphql", ".gql"])) return detectGraphql(unit);
  if (path.endsWith(".go")) return detectGo(cache, unit, path);
  if (path.endsWith(".rb")) return detectRuby(cache, unit, path);
  if (endsWithAny(path, [".c", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".hh", ".hxx"])) {
    return detectCCpp(cache, unit, path);
  }
  return null;
}

function detectPython(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (PY_HTTP_DECORATOR.test(line)) {
      return tag("api", "untrusted_external", "Python HTTP route decorator", "high");
    }
    if (PY_CLI_DECORATOR.test(line)) {
      return tag("user_input", "untrusted_external", "Python CLI command (Click/Typer)", "medium");
    }
    if (PY_TASK_DECORATOR.test(line)) {
      return tag("third_party", "semi_trusted_external", "Python task queue handler (Celery)", "medium");
    }
  }
  return null;
}

function detectRust(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const decorators = cache.decoratorsAbove(path, unit.location.startLine);
  const signature = cache.line(path, unit.location.startLine);

  for (const line of decorators) {
    if (RS_HTTP_ATTR.test(line)) {
      return tag("api", "untrusted_external", "Rust HTTP handler attribute", "high");
    }
    if (RS_NO_MANGLE.test(line)) {
      return tag("api", "untrusted_external", "Rust FFI export (#[no_mangle])", "high");
    }
    if (RS_ASYNC_MAIN_ATTR.test(line) && unit.name === "main") {
      return tag("user_input", "untrusted_external", "Rust async main (tokio/actix/async-std)", "high");
    }
  }
  if (signature && RS_EXTERN_C_FN.test(signature)) {
    return tag("api", "untrusted_external", 'Rust FFI export (pub extern "C")', "high");
  }
  return null;
}

/** Python ``dict(unit.attributes)``: later duplicate keys win, first position kept. */
function attributeDict(unit: CodeUnit): Map<string, AttributeValue> {
  const m = new Map<string, AttributeValue>();
  for (const [k, v] of unit.attributes) m.set(k, v);
  return m;
}

function detectSolidity(unit: CodeUnit): EntrypointTag | null {
  const attributes = attributeDict(unit);
  if (attributes.get("solidity_container_kind") === "interface") return null;
  if (unit.name === "fallback" || unit.name === "receive") {
    return tag("api", "untrusted_external", "Solidity fallback/receive", "high");
  }
  const visibility = attributes.get("solidity_visibility");
  if (visibility === "external" || visibility === "public") {
    return tag("api", "untrusted_external", "Solidity external/public function", "high");
  }
  return null;
}

/** Annotate base implementations shadowed by a derived Solidity contract. */
function annotateOverriddenSolidityEntrypoints(graph: CodeGraph, detected: Map<string, EntrypointTag>): void {
  const containers = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") {
      const unit = graph.nodes.get(edge.targetId);
      if (unit !== undefined && unit.kind === "method" && unit.location.filePath.endsWith(".sol")) {
        containers.set(edge.targetId, edge.sourceId);
      }
    }
  }

  // Keyed by (name, parameter type names), like upstream's tuple key.
  const methods = new Map<string, Map<string, string>>();
  for (const [methodId, contractId] of containers) {
    const unit = graph.nodes.get(methodId)!;
    const signature = JSON.stringify([unit.name, unit.parameters.map((p) => (p.typeRef ? p.typeRef.name : ""))]);
    let byContract = methods.get(signature);
    if (byContract === undefined) {
      byContract = new Map();
      methods.set(signature, byContract);
    }
    byContract.set(contractId, methodId);
  }

  const bases = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind === "inherits") {
      let set = bases.get(edge.sourceId);
      if (set === undefined) {
        set = new Set();
        bases.set(edge.sourceId, set);
      }
      set.add(edge.targetId);
    }
  }

  for (const byContract of methods.values()) {
    for (const [derived, methodId] of byContract) {
      if (!detected.has(methodId)) continue;
      const stack = [...(bases.get(derived) ?? [])];
      const visited = new Set<string>();
      while (stack.length > 0) {
        const base = stack.pop()!;
        if (visited.has(base)) continue;
        visited.add(base);
        const baseMethod = byContract.get(base);
        if (baseMethod !== undefined) appendOverriddenBy(graph, baseMethod, methodId);
        stack.push(...(bases.get(base) ?? []));
      }
    }
  }
}

function appendOverriddenBy(graph: CodeGraph, baseMethod: string, derivedMethod: string): void {
  const unit = graph.nodes.get(baseMethod);
  if (unit === undefined) return;
  const attributes = attributeDict(unit);
  const current = attributes.get("solidity_overridden_by");
  const currentText = typeof current === "string" ? current : "";
  const existing = new Set<string>();
  for (const item of currentText.split(",")) {
    const s = pyStripWhitespace(item);
    if (s) existing.add(s);
  }
  existing.add(derivedMethod);
  attributes.set("solidity_overridden_by", [...existing].sort(pyCompare).join(","));
  graph.nodes.set(baseMethod, { ...unit, attributes: [...attributes] });
}

function detectJsTs(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  // File-path conventions first (Next.js).
  const nextjsTag = detectNextjsRoute(unit, path);
  if (nextjsTag !== null) return nextjsTag;

  // AWS Lambda — `exports.handler = ...` or `export const handler = ...`
  if (unit.name === "handler" || unit.name === "lambdaHandler") {
    const signature = cache.line(path, unit.location.startLine) ?? "";
    if (signature.includes("exports.handler") || signature.includes("export ")) {
      return tag("api", "untrusted_external", "AWS Lambda handler", "high");
    }
  }

  // NestJS decorators on methods.
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (JS_NEST_DECORATOR.test(line)) {
      return tag("api", "untrusted_external", "NestJS controller method", "high");
    }
  }
  return detectRouteRegistration(unit);
}

/**
 * Not in upstream (its docs list Express/Fastify as planned): route handlers
 * registered as ``app.get("/path", (req, res) => ...)``. Relies on callback
 * attributes the JS/TS parsers add outside ``upstreamCompat`` mode, so it
 * never fires on upstream-compatible graphs. Per upstream's documented
 * pattern and gotcha, the receiver must have been created by a known router
 * factory (``express()``, ``Router()``, ``fastify()``), which keeps unrelated
 * ``x.get(...)`` calls out.
 */
const ROUTER_FACTORIES: ReadonlyMap<string, string> = new Map([
  ["express", "Express"],
  ["express.Router", "Express"],
  ["Router", "Express"],
  ["fastify", "Fastify"],
  ["Fastify", "Fastify"],
]);
const ROUTE_METHODS = /\.(get|post|put|patch|delete|all|use|options|head)$/;

function detectRouteRegistration(unit: CodeUnit): EntrypointTag | null {
  const factory = unitAttr(unit, "registered_on_factory");
  const callee = unitAttr(unit, "callback_of");
  if (factory === null || callee === null) return null;
  const framework = ROUTER_FACTORIES.get(factory);
  const method = ROUTE_METHODS.exec(callee)?.[1];
  if (framework === undefined || method === undefined) return null;
  const route = unitAttr(unit, "route");
  const description =
    method === "use"
      ? `${framework} middleware${route !== null ? ` ${route}` : ""}`
      : `${framework} route ${method.toUpperCase()}${route !== null ? ` ${route}` : ""}`;
  return tag("api", "untrusted_external", description, "high");
}

const NEXTJS_VERBS: ReadonlySet<string> = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]);

/**
 * Detect Next.js route handlers based on file path conventions.
 *
 * - App Router: `app/**\/route.{js,jsx,ts,tsx,mjs,cjs}` — named exports
 *   matching HTTP verbs (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS).
 * - Pages API: `pages/api/**\/*.{js,jsx,ts,tsx}` — any default export
 *   (named `handler` or `default` in Trailmark's node IDs).
 */
function detectNextjsRoute(unit: CodeUnit, path: string): EntrypointTag | null {
  const normalized = path.replaceAll("\\", "/");
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (basename.startsWith("route.") && NEXTJS_VERBS.has(unit.name)) {
    return tag("api", "untrusted_external", "Next.js App Router handler", "high");
  }
  if (normalized.includes("/pages/api/") && (unit.name === "handler" || unit.name === "default")) {
    return tag("api", "untrusted_external", "Next.js Pages API handler", "high");
  }
  return null;
}

const SERVLET_METHODS: ReadonlySet<string> = new Set([
  "doGet",
  "doPost",
  "doPut",
  "doDelete",
  "doHead",
  "doOptions",
  "doTrace",
]);

function detectJava(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (JAVA_SPRING_HANDLER.test(line)) {
      return tag("api", "untrusted_external", "Spring MVC/WebFlux handler", "high");
    }
    if (JAVA_JAXRS_HANDLER.test(line)) {
      return tag("api", "untrusted_external", "JAX-RS handler", "high");
    }
    if (JAVA_KAFKA_LISTENER.test(line)) {
      return tag("third_party", "semi_trusted_external", "Kafka listener", "medium");
    }
  }
  // Servlet convention: method names doGet/doPost/... on an HttpServlet.
  if (SERVLET_METHODS.has(unit.name)) {
    return tag("api", "untrusted_external", "HttpServlet method", "high");
  }
  return null;
}

function detectCsharp(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (CS_HTTP_ATTR.test(line)) {
      return tag("api", "untrusted_external", "ASP.NET Core HTTP handler", "high");
    }
    if (CS_AZURE_FUNC_ATTR.test(line)) {
      return tag("api", "untrusted_external", "Azure Function", "high");
    }
  }
  return null;
}

function detectPhp(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (PHP_ROUTE_ATTR.test(line) || PHP_ROUTE_ANNOTATION.test(line)) {
      return tag("api", "untrusted_external", "Symfony Route attribute", "high");
    }
  }
  return null;
}

function detectCairo(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (CAIRO_CONTRACT_ATTR.test(line)) {
      return tag("api", "untrusted_external", "Cairo/StarkNet contract entrypoint", "high");
    }
  }
  return null;
}

/**
 * Treat the file containing `component main = Template(...)` as an entrypoint.
 *
 * The parser exposes template/function nodes, not `component main` itself;
 * we flag the module node if the file declares a main component.
 */
function detectCircom(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  if (unit.kind !== "module") return null;
  for (const line of cache.iterLines(path)) {
    if (CIRCOM_MAIN.test(line)) {
      return tag("user_input", "untrusted_external", "Circom circuit main component", "high");
    }
  }
  return null;
}

function detectMasm(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const signature = cache.line(path, unit.location.startLine) ?? "";
  if (MASM_EXPORT.test(signature)) {
    return tag("api", "untrusted_external", "Miden Assembly exported procedure", "medium");
  }
  return null;
}

function detectHaskell(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  if (unit.name !== "main") return null;
  // Confirm the file actually declares `main ::` or `main =` at column 0.
  for (const line of cache.iterLines(path)) {
    if (HASKELL_MAIN.test(line)) {
      return tag("user_input", "untrusted_external", "Haskell main", "high");
    }
  }
  return null;
}

/** Mark any function listed in -export([...]) as an entrypoint. */
function detectErlang(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const exported = erlangExportedNames(cache, path);
  if (exported.size === 0) return null;
  if (exported.has(unit.name)) {
    return tag("api", "semi_trusted_external", "Erlang -export declaration", "medium");
  }
  return null;
}

/** Extract the names inside every -export([fn/arity, ...]) in the file. */
function erlangExportedNames(cache: SourceCache, path: string): Set<string> {
  const names = new Set<string>();
  let inExport = false;
  let buf: string[] = [];
  for (const line of cache.iterLines(path)) {
    if (!inExport) {
      const match = ERLANG_EXPORT.exec(line);
      if (match) {
        inExport = true;
        buf = [line.slice(match.index + match[0].length)];
      }
    } else {
      buf.push(line);
    }
    if (inExport && line.includes("]")) {
      const joined = buf.join(" ");
      const listSection = joined.split("]", 1)[0]!;
      for (const raw of listSection.split(",")) {
        const entry = pyStripWhitespace(raw);
        if (!entry || !entry.includes("/")) continue;
        const name = entry.slice(0, entry.indexOf("/"));
        names.add(pyStripWhitespace(name));
      }
      inExport = false;
      buf = [];
    }
  }
  return names;
}

/** Detect Swift entrypoints: @main attribute + Vapor route registration. */
function detectSwift(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (SWIFT_MAIN_ATTR.test(line)) {
      return tag("user_input", "untrusted_external", "Swift @main app entrypoint", "high");
    }
  }
  // Vapor routes are registered inside the function body rather than
  // via a decorator; match handlers whose containing file has at least
  // one `<receiver>.get(...)` / `.post(...)` / etc. call.
  for (const line of cache.iterLines(path)) {
    if (SWIFT_VAPOR_ROUTE.test(line)) {
      // A Vapor file: tag every function as a potential handler entry
      // only if its name matches the handler closure pattern.
      // Without call-graph resolution this is coarse — Vapor-handler
      // detection is best done via the override file for now.
      break;
    }
  }
  return null;
}

/**
 * Detect Kotlin entrypoints.
 *
 * Layers tried in order:
 * 1. Spring MVC / WebFlux annotations (``@GetMapping``, ``@PostMapping``,
 *    etc.) — shared with the Java detector because the annotations are
 *    identical across the two languages.
 * 2. Android Activity / Service / BroadcastReceiver lifecycle method
 *    names. These are attacker-reachable when the component is exported
 *    (``android:exported="true"`` in the manifest) — we over-detect
 *    here and let the override file tighten when appropriate.
 */
function detectKotlin(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (JAVA_SPRING_HANDLER.test(line)) {
      return tag("api", "untrusted_external", "Spring MVC/WebFlux handler (Kotlin)", "high");
    }
  }
  if (KOTLIN_ANDROID_LIFECYCLE_METHODS.has(unit.name)) {
    return tag("api", "untrusted_external", "Android component lifecycle method", "high");
  }
  return null;
}

/**
 * Detect Go entrypoints via call-site route registrations.
 *
 * Go has no annotation syntax for HTTP handlers — they're wired at
 * call sites like ``http.HandleFunc("/path", name)`` or
 * ``r.GET("/path", handler)``. For each file we compile the set of
 * function names referenced as handlers, then tag matching nodes.
 * Registrations that pass anonymous closures or method expressions
 * (``obj.Method``) are also captured — the second form is recorded
 * dotted; we tag any node whose basename matches.
 */
function detectGo(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const handlers = cache.goHttpHandlerNames(path);
  if (handlers.size === 0) return null;
  if (handlers.has(unit.name)) {
    return tag("api", "untrusted_external", "Go HTTP handler (net/http or router DSL)", "high");
  }
  return null;
}

/**
 * Detect Ruby entrypoints: Rails controller actions and Sidekiq workers.
 *
 * Rails controllers are classes that inherit from
 * ``ApplicationController`` / ``ActionController::*`` — every public
 * instance method of such a class is an action. We tag any method
 * whose node id starts with ``<Module>:<ClassName>.`` and whose class
 * name appears in the file's controller set.
 *
 * Sidekiq workers are classes that ``include Sidekiq::Worker`` /
 * ``include Sidekiq::Job``. Their ``perform`` method handles queue
 * messages — only that one method is tagged per worker class.
 */
function detectRuby(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const controllers = cache.rubyRailsControllerClasses(path);
  const workers = cache.rubySidekiqWorkerClasses(path);
  if (controllers.size === 0 && workers.size === 0) return null;

  // Node IDs look like "module:ClassName.method" for methods, or just
  // "module:ClassName" for the class itself. Only tag method nodes.
  if (unit.kind !== "method") return null;
  const nodeId = unit.id;
  if (!nodeId.includes(":") || !nodeId.includes(".")) return null;
  const afterColon = nodeId.slice(nodeId.indexOf(":") + 1);
  const dot = afterColon.indexOf(".");
  const classPart = dot < 0 ? afterColon : afterColon.slice(0, dot);
  if (controllers.has(classPart)) {
    return tag("api", "untrusted_external", "Rails controller action", "high");
  }
  if (workers.has(classPart) && unit.name === "perform") {
    return tag("third_party", "semi_trusted_external", "Sidekiq worker perform method", "medium");
  }
  return null;
}

const C_EXPORT_DESCRIPTION = 'C/C++ exported symbol (extern "C" / visibility / dllexport)';

/**
 * Detect C / C++ library exports by explicit linkage markers.
 *
 * Matches ``extern "C"``, ``__attribute__((visibility("default")))``,
 * and ``__declspec(dllexport)`` on or just above the signature line.
 * Plain non-``static`` functions in headers are NOT flagged by default
 * because that inversion ("everything not static is exported") is too
 * broad for audit purposes — use the override file for projects where
 * that's the intent.
 */
function detectCCpp(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  // Explicit markers sometimes appear on the line above the signature
  // (e.g. `__declspec(dllexport)\nint foo(...)`), so scan both.
  const signature = cache.signatureBlock(path, unit.location.startLine) ?? "";
  if (C_EXPORT_MARKERS.test(signature)) {
    return tag("api", "untrusted_external", C_EXPORT_DESCRIPTION, "high");
  }
  // Also check one line above — some projects put the attribute on its own line.
  const above = cache.line(path, unit.location.startLine - 1) ?? "";
  if (C_EXPORT_MARKERS.test(above)) {
    return tag("api", "untrusted_external", C_EXPORT_DESCRIPTION, "high");
  }
  return null;
}

/**
 * Detect Dart entrypoints.
 *
 * Today covers ``@pragma('vm:entry-point')``, the explicit Dart marker
 * for functions invoked from native code (FFI callbacks, platform-
 * channel handlers, deferred loading targets). Flutter lifecycle
 * methods on ``StatefulWidget`` / ``StatelessWidget`` (``build``,
 * ``initState``, ``dispose``) are not flagged here because they
 * execute in-process and aren't directly attacker-reachable —
 * add them via the override file if you want them surfaced.
 */
function detectDart(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  for (const line of cache.decoratorsAbove(path, unit.location.startLine)) {
    if (DART_VM_ENTRY_POINT.test(line)) {
      return tag("api", "untrusted_external", "Dart @pragma('vm:entry-point') native callback", "high");
    }
  }
  return null;
}

function detectMove(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const signature = cache.signatureBlock(path, unit.location.startLine) ?? "";
  if (unit.kind === "function" && (signature.includes(" entry ") || signature.includes("public"))) {
    return tag("api", "untrusted_external", "Move public/entry function", "high");
  }
  return null;
}

const TACT_ROLES: ReadonlySet<string> = new Set(["init", "receive", "external", "bounced"]);

function detectTact(unit: CodeUnit): EntrypointTag | null {
  const tactRole = unitAttr(unit, "tact_role") || unit.name;
  if (unit.kind === "method" && TACT_ROLES.has(tactRole)) {
    return tag("api", "untrusted_external", "Tact contract receiver/initializer", "high");
  }
  return null;
}

function detectFunc(unit: CodeUnit): EntrypointTag | null {
  if (unit.name === "recv_internal" || unit.name === "recv_external" || unit.name.startsWith("get_")) {
    return tag("api", "untrusted_external", "Func receiver/getter entrypoint", "high");
  }
  return null;
}

function detectSway(cache: SourceCache, unit: CodeUnit, path: string): EntrypointTag | null {
  const signature = cache.signatureBlock(path, unit.location.startLine) ?? "";
  if (unit.kind === "function" && signature.includes("pub fn")) {
    return tag("api", "untrusted_external", "Sway public function", "high");
  }
  if (unit.kind === "method" && SWAY_ABI_FN.test(signature) && signature.includes(";")) {
    return tag("api", "untrusted_external", "Sway ABI method", "high");
  }
  return null;
}

function detectRego(unit: CodeUnit): EntrypointTag | null {
  if (unit.name === "allow" || unit.name === "deny" || unit.name === "violation") {
    return tag("api", "untrusted_external", "Rego policy decision rule", "high");
  }
  return null;
}

function detectProto(unit: CodeUnit): EntrypointTag | null {
  if (unit.kind === "method" && unitAttr(unit, "schema_role") === "rpc") {
    return tag("api", "untrusted_external", "Protocol Buffers service RPC", "high");
  }
  return null;
}

function detectThrift(unit: CodeUnit): EntrypointTag | null {
  if (unit.kind === "method" && unitAttr(unit, "schema_role") === "service_function") {
    return tag("api", "untrusted_external", "Thrift service function", "high");
  }
  return null;
}

function detectGraphql(unit: CodeUnit): EntrypointTag | null {
  if (unit.kind === "method" && unitAttr(unit, "schema_role") === "root_operation") {
    return tag("api", "untrusted_external", "GraphQL root operation field", "high");
  }
  return null;
}

function unitAttr(unit: CodeUnit, key: string): string | null {
  for (const [attrKey, attrValue] of unit.attributes) {
    if (attrKey === key && typeof attrValue === "string") return attrValue;
  }
  return null;
}

/**
 * Detect Objective-C entrypoints: AppDelegate selectors and extern C.
 *
 * AppDelegate protocol selectors are high-value attack surface —
 * ``application:openURL:options:`` handles deep-link invocations and
 * ``application:didFinishLaunchingWithOptions:`` is the first code
 * reached after launch. Their signatures are stable enough that a
 * name match is sufficient.
 */
function detectObjc(unit: CodeUnit): EntrypointTag | null {
  if (OBJC_APP_DELEGATE_SELECTORS.has(unit.name)) {
    return tag("api", "untrusted_external", "Objective-C UIApplicationDelegate lifecycle method", "high");
  }
  return null;
}

// Python ``str.isspace`` characters (``str.strip()`` with no argument).
const PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_WS}]+|[${PY_WS}]+$`, "g");

/** Python ``str.strip()`` (no argument). */
function pyStripWhitespace(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

/** Python ``str.splitlines()``. */
function pySplitlines(text: string): string[] {
  const parts = text.split(PY_LINE_BREAK);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Decode like ``Path.read_text()``: strict UTF-8 (a decode error yields an
 * empty file, as upstream catches ``UnicodeDecodeError``), keeping any BOM.
 */
async function readSourceText(source: FileSource, path: string): Promise<string> {
  try {
    if (source.readBytes !== undefined) {
      const bytes = await source.readBytes(path);
      if (bytes === null) return "";
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return "";
      }
    }
    return (await source.readText(path)) ?? "";
  } catch {
    return "";
  }
}

/** Source files read up front for a detection pass (upstream ``_SourceCache``). */
class SourceCache {
  private readonly scanCache = new Map<string, Set<string>>();

  private constructor(private readonly lines: Map<string, string[]>) {}

  static async load(source: FileSource, paths: Iterable<string>): Promise<SourceCache> {
    const lines = new Map<string, string[]>();
    const all = [...paths];
    const BATCH = 64;
    for (let i = 0; i < all.length; i += BATCH) {
      const chunk = all.slice(i, i + BATCH);
      const texts = await Promise.all(chunk.map((p) => readSourceText(source, p)));
      chunk.forEach((p, j) => lines.set(p, pySplitlines(texts[j]!)));
    }
    return new SourceCache(lines);
  }

  private read(path: string): string[] {
    return this.lines.get(path) ?? [];
  }

  line(path: string, oneIndexed: number): string | null {
    const lines = this.read(path);
    const idx = oneIndexed - 1;
    if (idx >= 0 && idx < lines.length) return lines[idx]!;
    return null;
  }

  /** Return all lines of the file for whole-file scans. */
  iterLines(path: string): readonly string[] {
    return this.read(path);
  }

  /**
   * Extract Go HTTP handler names registered in the file.
   *
   * Scans for ``http.HandleFunc("/path", name)``, ``http.Handle(...)``,
   * and router-DSL shapes like ``r.GET("/path", handler)``. The
   * handler reference is usually a bare identifier (``handler``) but
   * can be a method expression (``obj.Method``); we record the last
   * dotted segment for lookup against Trailmark node names.
   */
  goHttpHandlerNames(path: string): Set<string> {
    const key = `go_handlers::${path}`;
    const cached = this.scanCache.get(key);
    if (cached !== undefined) return cached;
    const names = new Set<string>();
    const lastSegment = (s: string) => s.slice(s.lastIndexOf(".") + 1);
    for (const line of this.read(path)) {
      for (const m of line.matchAll(GO_HTTP_HANDLE)) names.add(lastSegment(m[2]!));
      for (const m of line.matchAll(GO_ROUTER_VERB)) names.add(lastSegment(m[3]!));
    }
    this.scanCache.set(key, names);
    return names;
  }

  /** Extract class names that inherit from Rails controller bases. */
  rubyRailsControllerClasses(path: string): Set<string> {
    const key = `ruby_rails::${path}`;
    const cached = this.scanCache.get(key);
    if (cached !== undefined) return cached;
    const names = new Set<string>();
    for (const line of this.read(path)) {
      const match = RUBY_RAILS_CONTROLLER_CLASS.exec(line);
      if (match) names.add(match[1]!);
    }
    this.scanCache.set(key, names);
    return names;
  }

  /**
   * Return class names whose body contains ``include Sidekiq::Worker``.
   *
   * Tracked by scanning for the include directive and associating it
   * with the most recently opened ``class <Name>`` block. This is a
   * one-level heuristic — nested classes aren't perfectly modeled —
   * but matches idiomatic Sidekiq worker layout.
   */
  rubySidekiqWorkerClasses(path: string): Set<string> {
    const key = `ruby_sidekiq::${path}`;
    const cached = this.scanCache.get(key);
    if (cached !== undefined) return cached;
    const names = new Set<string>();
    const classStack: string[] = [];
    for (const line of this.read(path)) {
      const stripped = pyStripWhitespace(line);
      // Crude class-open / class-close tracking. Good enough for
      // typical worker files, not a general Ruby parser.
      const classOpen = RUBY_CLASS_OPEN.exec(line);
      if (classOpen) {
        classStack.push(classOpen[1]!);
        continue;
      }
      if (stripped === "end" && classStack.length > 0) {
        classStack.pop();
        continue;
      }
      if (classStack.length > 0 && RUBY_SIDEKIQ_INCLUDE.test(line)) {
        names.add(classStack[classStack.length - 1]!);
      }
    }
    this.scanCache.set(key, names);
    return names;
  }

  /**
   * Return decorator-style lines around ``startLine``.
   *
   * Different parsers report different ``startLine`` values for decorated
   * functions: Python points at the ``def`` line (decorators are above),
   * Java/C#/PHP-attribute parsers often point at the decorator line
   * itself (decorators are at or just below). We scan a small window
   * on either side and keep only lines that look like decorators or
   * attributes (``@foo``, ``#[foo]``, or ``[foo]`` — the last for C#).
   */
  decoratorsAbove(path: string, startLine: number): string[] {
    const lines = this.read(path);
    const startIdx = startLine - 1;
    const lo = Math.max(0, startIdx - DECORATOR_LOOKBACK);
    const hi = Math.min(lines.length, startIdx + 4);
    const collected: string[] = [];
    for (let i = lo; i < hi; i++) {
      const stripped = pyStripWhitespace(lines[i]!);
      if (!stripped) continue;
      if (
        stripped.startsWith("@") ||
        stripped.startsWith("#[") ||
        (stripped.startsWith("[") && !stripped.startsWith("[["))
      ) {
        collected.push(lines[i]!);
      }
    }
    return collected;
  }

  /**
   * Return the function signature as a single line.
   *
   * Solidity / Rust signatures can wrap across several lines. Join
   * up to 8 lines starting at ``startLine`` and stop at the first
   * line containing an opening brace.
   */
  signatureBlock(path: string, startLine: number): string | null {
    const lines = this.read(path);
    const idx = startLine - 1;
    if (idx < 0 || idx >= lines.length) return null;
    const parts: string[] = [];
    for (let offset = 0; offset < 8; offset++) {
      if (idx + offset >= lines.length) break;
      parts.push(lines[idx + offset]!);
      if (lines[idx + offset]!.includes("{")) break;
    }
    return parts.join(" ");
  }
}

/** ``rootPath`` and its parents, up to and including ``source.root``. */
function candidateRoots(sourceRoot: string, start: string): string[] {
  const out = [start];
  let current = start;
  for (;;) {
    const rel = posixRelative(sourceRoot, current);
    if (rel === null || rel === ".") break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
    out.push(current);
  }
  return out;
}

/**
 * Walk up until we find a directory with pyproject.toml, or give up.
 *
 * Falls back to ``start`` if nothing is found so the caller still has a
 * sensible base path for the override file lookup. Unlike upstream, the
 * walk stops at ``source.root`` unless the source implements ``resolve``.
 */
async function findRepoRoot(source: FileSource, start: string): Promise<string> {
  // Sources that can read the whole filesystem walk every parent, like upstream.
  const candidates =
    source.resolve !== undefined ? candidateRoots("/", source.resolve(start)) : candidateRoots(source.root, start);
  for (const candidate of candidates) {
    if (await source.isFile(rawJoin(candidate, "pyproject.toml"))) return candidate;
    if (await source.isFile(rawJoin(candidate, OVERRIDE_FILE))) return candidate;
  }
  return start;
}

/**
 * Mark any top-level function named ``main`` as a CLI entrypoint.
 *
 * Uses TRUSTED_INTERNAL because the developer explicitly invoked it —
 * it's an API boundary but not an external attacker surface by default.
 * Users who want a stricter posture can override via the override file.
 */
function detectMainFunctions(graph: CodeGraph): Map<string, EntrypointTag> {
  const result = new Map<string, EntrypointTag>();
  for (const [nodeId, unit] of graph.nodes) {
    if (unit.name !== "main") continue;
    if (unit.kind !== "function" && unit.kind !== "method") continue;
    result.set(nodeId, tag("user_input", "trusted_internal", "CLI main() entrypoint", "low"));
  }
  return result;
}

type TomlTable = Record<string, unknown>;

function isTable(v: unknown): v is TomlTable {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function loadToml(text: string | null): TomlTable | null {
  if (text === null) return null;
  try {
    return parseToml(text) as TomlTable;
  } catch {
    return null;
  }
}

function getOwn(table: TomlTable, key: string): unknown {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * Read ``[project.scripts]`` from pyproject.toml and tag each target.
 *
 * Entries take the form ``name = "module.path:function"``. We first try the
 * matching node ID directly, then fall back to an unambiguous file path suffix
 * match for parses rooted below the import root.
 */
function detectPyprojectScripts(graph: CodeGraph, pyprojectText: string | null): Map<string, EntrypointTag> {
  const result = new Map<string, EntrypointTag>();
  const data = loadToml(pyprojectText);
  if (data === null) return result;
  const project = getOwn(data, "project");
  if (!isTable(project)) return result;
  const scriptsRaw = getOwn(project, "scripts");
  if (!isTable(scriptsRaw)) return result;

  for (const target of Object.values(scriptsRaw)) {
    if (typeof target !== "string" || !target.includes(":")) continue;
    const at = target.lastIndexOf(":");
    const nodeId = resolveScriptTarget(graph, target.slice(0, at), target.slice(at + 1));
    if (nodeId === null) continue;
    result.set(
      nodeId,
      tag("user_input", "untrusted_external", `pyproject.toml [project.scripts] entry (${target})`, "medium"),
    );
  }
  return result;
}

/** Find the node id matching a ``module.path:function`` script target. */
function resolveScriptTarget(graph: CodeGraph, modulePath: string, funcName: string): string | null {
  const exactId = `${modulePath}:${funcName}`;
  const unit = graph.nodes.get(exactId);
  if (unit !== undefined && unit.name === funcName) return exactId;

  const suffix = modulePath.replaceAll(".", "/") + ".py";
  const matches: string[] = [];
  for (const [nodeId, u] of graph.nodes) {
    if (u.name !== funcName) continue;
    if (u.location.filePath.endsWith(suffix)) matches.push(nodeId);
  }
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Parse ``.trailmark/entrypoints.toml`` into EntrypointTag entries.
 *
 * An entry may identify a single node by id or reference, OR declare a
 * rule that matches many nodes at once. Rule-based entries accept any
 * combination of:
 *
 * - ``file_glob``: match ``CodeUnit.location.filePath`` against a
 *   shell glob supporting ``**`` (recursive) and ``*`` (single-segment).
 * - ``param_type``: match functions whose parameter list includes a
 *   declared type with this name (exact ``TypeRef.name`` match).
 * - ``name_regex``: match functions whose ``name`` satisfies the regex.
 *
 * When multiple conditions are supplied in one entry they are combined
 * with AND. Later entries in the file override earlier ones when two
 * rules would tag the same node.
 */
function loadOverrideFile(graph: CodeGraph, overrideText: string | null): Map<string, EntrypointTag> {
  const result = new Map<string, EntrypointTag>();
  const data = loadToml(overrideText);
  if (data === null) return result;
  const entries = getOwn(data, "entrypoint");
  if (!Array.isArray(entries)) return result;
  for (const entry of entries) {
    if (!isTable(entry)) continue;
    for (const [nodeId, t] of entryToMatches(graph, entry)) result.set(nodeId, t);
  }
  return result;
}

/**
 * Produce every (nodeId, tag) pair an override-file entry implies.
 *
 * Returns an empty list if the entry is malformed, references an
 * unknown node, or matches nothing.
 */
function entryToMatches(graph: CodeGraph, entry: TomlTable): [string, EntrypointTag][] {
  const t = entryTag(entry);
  if (t === null) return [];

  const nodeRef = getOwn(entry, "node");
  if (typeof nodeRef === "string") {
    const nodeId = resolveOverrideNode(graph, nodeRef);
    return nodeId === null ? [] : [[nodeId, t]];
  }

  // Rule-based entry — compile match conditions.
  const conditions = compileRuleConditions(entry);
  if (conditions === null) {
    // No recognized rule fields (and no `node`); nothing to do.
    return [];
  }

  const matches: [string, EntrypointTag][] = [];
  for (const [nodeId, unit] of graph.nodes) {
    if (unit.kind !== "function" && unit.kind !== "method") continue;
    if (conditions.every((condition) => condition(unit))) matches.push([nodeId, t]);
  }
  return matches;
}

function lookup<T extends string>(values: readonly T[], name: unknown): T | null {
  return typeof name === "string" && (values as readonly string[]).includes(name) ? (name as T) : null;
}

/** Build the EntrypointTag shared across every match of an entry. */
function entryTag(entry: TomlTable): EntrypointTag | null {
  const kind = lookup(ENTRYPOINT_KINDS, getOwn(entry, "kind") ?? "user_input");
  const trust = lookup(TRUST_LEVELS, getOwn(entry, "trust") ?? "untrusted_external");
  const asset = lookup(ASSET_VALUES, getOwn(entry, "asset_value") ?? "medium");
  if (kind === null || trust === null || asset === null) return null;
  const description = getOwn(entry, "description");
  return tag(kind, trust, typeof description === "string" ? description : null, asset);
}

type Condition = (unit: CodeUnit) => boolean;

/**
 * Translate rule fields into predicates evaluated per CodeUnit.
 *
 * Returns null if the entry contains no recognized rule fields.
 */
function compileRuleConditions(entry: TomlTable): Condition[] | null {
  const conditions: Condition[] = [];
  const fileGlob = getOwn(entry, "file_glob");
  if (typeof fileGlob === "string") {
    let pattern: RegExp;
    try {
      pattern = globToRegex(fileGlob);
    } catch {
      return null;
    }
    conditions.push((unit) => pattern.test((unit.location.filePath || "").replaceAll("\\", "/")));
  }

  const paramType = getOwn(entry, "param_type");
  if (typeof paramType === "string") {
    conditions.push((unit) => unit.parameters.some((p) => p.typeRef !== null && p.typeRef.name === paramType));
  }

  const nameRegex = getOwn(entry, "name_regex");
  if (typeof nameRegex === "string") {
    const pattern = compilePythonRegex(nameRegex);
    if (pattern === null) return null;
    conditions.push((unit) => pattern.test(unit.name));
  }

  return conditions.length > 0 ? conditions : null;
}

/**
 * Best-effort translation of a Python ``re`` pattern to a JS ``RegExp``
 * (non-global, so ``test`` behaves like ``re.search``). Returns null when
 * the pattern cannot be compiled.
 */
function compilePythonRegex(pattern: string): RegExp | null {
  let flags = "";
  let body = pattern;
  // Leading global inline flags, e.g. ``(?i)``.
  const inline = /^\(\?([aiLmsux]+)\)/.exec(body);
  if (inline) {
    for (const f of inline[1]!) if ("ims".includes(f) && !flags.includes(f)) flags += f;
    body = body.slice(inline[0].length);
  }
  body = body
    .replaceAll("(?P<", "(?<")
    .replace(/\(\?P=(\w+)\)/g, "\\k<$1>")
    .replaceAll("\\A", "^")
    .replaceAll("\\Z", "$(?![\\s\\S])");
  try {
    return new RegExp(body, flags);
  } catch {
    return null;
  }
}

/**
 * Translate a shell-style glob with ``**`` support into a regex.
 *
 * - ``**`` (with surrounding slashes) matches zero or more path segments.
 * - ``*`` matches any characters except ``/``.
 * - ``?`` matches one character other than ``/``.
 * - Other regex metacharacters are escaped.
 *
 * Paths are matched against their string form, with both Windows and
 * POSIX separators normalized to ``/`` by the caller.
 */
export function globToRegex(pattern: string): RegExp {
  const out: string[] = [];
  let i = 0;
  const n = pattern.length;
  while (i < n) {
    const c = pattern[i]!;
    if (c === "*" && i + 1 < n && pattern[i + 1] === "*") {
      // `/**/` expands to `(?:/.*)?/` — zero or more segments.
      if (i > 0 && pattern[i - 1] === "/" && i + 2 < n && pattern[i + 2] === "/") {
        // Rewrite the trailing `/` of the preceding segment as
        // part of the globstar expansion.
        out[out.length - 1] = "(?:/.*)?/";
        i += 3;
        continue;
      }
      // Leading `**/` or trailing `/**`.
      if (i + 2 < n && pattern[i + 2] === "/") {
        out.push("(?:.*/)?");
        i += 3;
        continue;
      }
      out.push(".*");
      i += 2;
    } else if (c === "*") {
      out.push("[^/]*");
      i += 1;
    } else if (c === "?") {
      out.push("[^/]");
      i += 1;
    } else if (".+^$()[]{}|\\".includes(c)) {
      out.push("\\" + c);
      i += 1;
    } else {
      out.push(c);
      i += 1;
    }
  }
  // Allow the pattern to match a suffix of the full path — users
  // writing `public_html/**/*.php` shouldn't have to prefix the full
  // absolute path of the project. `re.search` finds the pattern
  // anywhere in the string, so we just anchor the end.
  return new RegExp("(?:^|/)" + out.join("") + "$");
}

/**
 * Resolve an override reference to a concrete node id.
 *
 * Accepts either a literal node id (``cli:main``) or a Python-style
 * ``module.path:function`` reference, which we resolve the same way
 * pyproject.toml scripts are resolved.
 */
function resolveOverrideNode(graph: CodeGraph, reference: string): string | null {
  if (graph.nodes.has(reference)) return reference;
  if (reference.includes(":")) {
    const at = reference.lastIndexOf(":");
    return resolveScriptTarget(graph, reference.slice(0, at), reference.slice(at + 1));
  }
  return null;
}
