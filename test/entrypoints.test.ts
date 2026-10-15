/**
 * Port of upstream tests/test_entrypoints.py and tests/test_detector_tags.py.
 *
 * Python tests run end-to-end through the TS parser. Every other language
 * runs twice:
 *
 * - "[hand graph]": detection over a graph recorded from the upstream Python
 *   parser (test/fixtures/entrypoints/graphs.json, regenerate with
 *   gen-graphs.py). Also checks the full attack surface equals upstream's.
 *   This covers languages whose parser is not ported yet (php, kotlin, ...).
 * - "[parser]": end-to-end through the TS parser, only when that parser is
 *   ported (``supportedLanguages()``) and loads.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { detectEntrypoints, globToRegex } from "../src/analysis/entrypoints.js";
import { NodeFileSource } from "../src/fs/node.js";
import { MemoryFileSource } from "../src/fs/source.js";
import { codeEdge, type EdgeKind } from "../src/models/edges.js";
import { CodeGraph } from "../src/models/graph.js";
import {
  codeUnit,
  parameter,
  sourceLocation,
  typeRef,
  type AttributeValue,
  type NodeKind,
} from "../src/models/nodes.js";
import { parseDirectory, parseSource, supportedLanguages } from "../src/parse.js";
import { QueryEngine } from "../src/query/api.js";
import type { JsonObject } from "../src/query/dicts.js";

const ROOT = "proj";

type Files = Record<string, string>;
type Surface = JsonObject[];

interface GraphSpec {
  language: string;
  files: Files;
  nodes: [string, string, NodeKind, string, number, number, [string, AttributeValue][], (string | null)[]][];
  edges: [string, string, EdgeKind][];
  surface: Surface;
}

const SPECS: Record<string, GraphSpec> = JSON.parse(
  readFileSync(new URL("./fixtures/entrypoints/graphs.json", import.meta.url), "utf8"),
);

function source(files: Files): MemoryFileSource {
  return new MemoryFileSource(ROOT, files);
}

async function engineFor(files: Files, language = "python", detect = true): Promise<QueryEngine> {
  return QueryEngine.fromSource(source(files), { language, detectEntrypoints: detect });
}

async function surfaceOf(files: Files, language = "python"): Promise<Surface> {
  return (await engineFor(files, language)).attackSurface();
}

function ids(surface: Surface): Set<string> {
  return new Set(surface.map((ep) => ep["node_id"] as string));
}

function byId(surface: Surface): Map<string, JsonObject> {
  return new Map(surface.map((ep) => [ep["node_id"] as string, ep]));
}

function descriptions(surface: Surface): string[] {
  return surface.map((ep) => (ep["description"] as string | null) ?? "");
}

/** Rebuild the upstream-recorded graph for ``key`` and run TS detection on it. */
async function handEngine(key: string): Promise<QueryEngine> {
  const spec = SPECS[key]!;
  const graph = new CodeGraph({ language: spec.language, rootPath: ROOT });
  for (const [id, name, kind, file, startLine, endLine, attributes, paramTypes] of spec.nodes) {
    graph.nodes.set(
      id,
      codeUnit({
        id,
        name,
        kind,
        location: sourceLocation(file ? `${ROOT}/${file}` : "", startLine, endLine),
        attributes,
        parameters: paramTypes.map((t, i) => parameter(`p${i}`, { typeRef: t === null ? null : typeRef(t) })),
      }),
    );
  }
  for (const [sourceId, targetId, kind] of spec.edges) graph.edges.push(codeEdge({ sourceId, targetId, kind }));
  for (const [id, tag] of await detectEntrypoints(graph, source(spec.files), ROOT)) graph.entrypoints.set(id, tag);
  return QueryEngine.fromGraph(graph);
}

// Languages whose TS parser is registered and actually loads.
const PROBES: Record<string, [string, string]> = {
  javascript: ["probe.js", "function f() {}\n"],
  typescript: ["probe.ts", "function f() {}\n"],
  c: ["probe.c", "int f(void) { return 0; }\n"],
  cpp: ["probe.cpp", "int f() { return 0; }\n"],
  java: ["Probe.java", "class Probe { void f() {} }\n"],
  go: ["probe.go", "package main\nfunc f() {}\n"],
  rust: ["probe.rs", "fn f() {}\n"],
  solidity: ["Probe.sol", "contract Probe { function f() public {} }\n"],
};
const PARSER_READY = new Set<string>();
for (const lang of supportedLanguages()) {
  const probe = PROBES[lang];
  if (probe === undefined) continue;
  try {
    const g = await parseSource(probe[0], probe[1], lang);
    if ([...g.nodes.values()].some((u) => u.kind === "function" || u.kind === "method")) PARSER_READY.add(lang);
  } catch {
    // not ported yet
  }
}

/**
 * Register a non-Python test against the hand graph and (when available) the
 * TS parser. ``body`` receives the attack surface.
 */
function caseIt(name: string, key: string, body: (surface: Surface, engine: QueryEngine) => void): void {
  const spec = SPECS[key];
  if (spec === undefined) throw new Error(`missing fixture ${key}; regenerate graphs.json`);
  it(`${name} [hand graph]`, async () => {
    const engine = await handEngine(key);
    const surface = engine.attackSurface();
    expect(surface).toEqual(spec.surface);
    body(surface, engine);
  });
  it.runIf(PARSER_READY.has(spec.language))(`${name} [parser]`, async () => {
    const engine = await engineFor(spec.files, spec.language);
    const surface = engine.attackSurface();
    body(surface, engine);
    expect(surface).toEqual(spec.surface);
  });
}

// ---------------------------------------------------------------------------
// test_entrypoints.py
// ---------------------------------------------------------------------------

// Path to an upstream trailmark checkout (see PORTING.md); these tests skip without it.
const UPSTREAM = process.env["TRAILMARK_UPSTREAM"] ?? "";

describe("TestSelfAnalysis", () => {
  // Upstream runs Trailmark on its own Python source; the pyproject.toml is in
  // the parent of the parse directory. Needs an upstream checkout.
  const hasUpstream = UPSTREAM !== "" && existsSync(`${UPSTREAM}/pyproject.toml`);
  let cached: Promise<QueryEngine> | null = null;
  const selfEngine = () =>
    (cached ??= (async () => {
      const src = new NodeFileSource(UPSTREAM);
      const dir = `${UPSTREAM}/src`;
      const graph = await parseDirectory(src, "python", { dir });
      for (const [id, tag] of await detectEntrypoints(graph, src, dir)) graph.entrypoints.set(id, tag);
      return QueryEngine.fromGraph(graph);
    })());

  it.runIf(hasUpstream)("self analysis has entrypoints", async () => {
    expect((await selfEngine()).summary()["entrypoints"]).toBeGreaterThan(0);
  });
  it.runIf(hasUpstream)("self analysis attack surface nonempty", async () => {
    expect((await selfEngine()).attackSurface().length).toBeGreaterThan(0);
  });
  it.runIf(hasUpstream)("self analysis finds pyproject script", async () => {
    expect(ids((await selfEngine()).attackSurface())).toContain("trailmark.cli:main");
  });
});

describe("TestMainHeuristic", () => {
  it("bare main function detected", async () => {
    expect(ids(await surfaceOf({ "tool.py": "def main():\n    return 0\n" }))).toContain("tool:main");
  });

  it("main gets trusted_internal by default", async () => {
    const surface = await surfaceOf({ "tool.py": "def main():\n    pass\n" });
    expect(surface).toHaveLength(1);
    expect(surface[0]!["trust_level"]).toBe("trusted_internal");
  });

  it("non-main function not detected", async () => {
    expect(await surfaceOf({ "tool.py": "def helper():\n    pass\n" })).toEqual([]);
  });
});

describe("TestNewLanguageEntrypoints", () => {
  caseIt("move public entry detected", "move_public_entry", (s) => {
    expect(ids(s)).toContain("m:0x1::m:main");
  });
  caseIt("tact receivers detected", "tact_receivers", (s) => {
    expect(ids(s)).toContain("wallet:Wallet.init");
    expect(ids(s)).toContain("wallet:Wallet.receive");
  });
  caseIt("func receivers and getters detected", "func_receivers", (s) => {
    expect(ids(s)).toContain("wallet:recv_internal");
    expect(ids(s)).toContain("wallet:get_balance");
  });
  caseIt("sway abi and public functions detected", "sway_abi", (s) => {
    expect(ids(s)).toContain("wallet:Wallet.deposit");
    expect(ids(s)).toContain("wallet:helper");
  });
  caseIt("rego policy rules detected", "rego_rules", (s) => {
    expect(ids(s)).toContain("example.auth:allow");
    expect(ids(s)).toContain("example.auth:deny");
  });
  caseIt("schema entrypoints detect operations only (proto)", "schema_proto", (s) => {
    expect(ids(s)).toEqual(new Set(["example.auth:Auth.Login"]));
  });
  caseIt("schema entrypoints detect operations only (thrift)", "schema_thrift", (s) => {
    expect(ids(s)).toEqual(new Set(["example.auth:Auth.login"]));
  });
  caseIt("schema entrypoints detect operations only (graphql)", "schema_graphql", (s) => {
    expect(ids(s)).toEqual(new Set(["schema:Query.user"]));
  });
});

describe("TestPyprojectScripts", () => {
  it("pyproject script overrides main heuristic", async () => {
    const surface = await surfaceOf({
      "pyproject.toml": '[project]\nname = "demo"\nversion = "0.0.0"\n[project.scripts]\ndemo = "demo:main"\n',
      "demo.py": "def main():\n    pass\n",
    });
    expect(surface).toHaveLength(1);
    const [ep] = surface;
    expect(ep!["node_id"]).toBe("demo:main");
    expect(ep!["trust_level"]).toBe("untrusted_external");
    expect(ep!["asset_value"]).toBe("medium");
    expect(ep!["description"]).toBe("pyproject.toml [project.scripts] entry (demo:main)");
  });

  it("pyproject script in parent is discovered", async () => {
    // Upstream parses `pkg/` and walks up the filesystem. Here the walk is
    // bounded by the FileSource root, so parse a subdirectory of the source.
    const src = source({
      "pyproject.toml": '[project]\nname = "demo"\nversion = "0.0.0"\n[project.scripts]\ndemo = "pkg.app:main"\n',
      "pkg/app.py": "def main():\n    pass\n",
    });
    const dir = `${ROOT}/pkg`;
    const graph = await parseDirectory(src, "python", { dir });
    const detected = await detectEntrypoints(graph, src, dir);
    expect(detected.has("app:main")).toBe(true);
    expect(detected.get("app:main")!.trustLevel).toBe("untrusted_external");
  });

  it("pyproject script ambiguous suffix is skipped", async () => {
    const surface = byId(
      await surfaceOf({
        "pyproject.toml": '[project]\nname = "demo"\nversion = "0.0.0"\n[project.scripts]\ndemo = "pkg.app:main"\n',
        "src/pkg/app.py": "def main():\n    pass\n",
        "tests/pkg/app.py": "def main():\n    pass\n",
      }),
    );
    expect(surface.get("src.pkg.app:main")!["trust_level"]).toBe("trusted_internal");
    expect(surface.get("tests.pkg.app:main")!["trust_level"]).toBe("trusted_internal");
  });

  it("malformed pyproject is tolerated", async () => {
    const surface = await surfaceOf({
      "pyproject.toml": "this is not valid toml = [",
      "tool.py": "def main():\n    pass\n",
    });
    expect(surface.length).toBeGreaterThan(0);
  });
});

describe("TestOverrideFile", () => {
  const OVERRIDE = ".trailmark/entrypoints.toml";

  it("override adds entrypoint", async () => {
    const surface = await surfaceOf({
      "app.py": "def handle_request(req):\n    pass\n",
      [OVERRIDE]:
        '[[entrypoint]]\nnode = "app:handle_request"\nkind = "api"\ntrust = "untrusted_external"\n' +
        'asset_value = "high"\ndescription = "HTTP handler"\n',
    });
    expect(surface).toEqual([
      {
        node_id: "app:handle_request",
        trust_level: "untrusted_external",
        kind: "api",
        asset_value: "high",
        description: "HTTP handler",
      },
    ]);
  });

  it("override beats pyproject and main", async () => {
    const surface = await surfaceOf({
      "pyproject.toml": '[project]\nname = "x"\nversion = "0"\n[project.scripts]\nx = "app:main"\n',
      "app.py": "def main():\n    pass\n",
      [OVERRIDE]:
        '[[entrypoint]]\nnode = "app:main"\nkind = "api"\ntrust = "untrusted_external"\nasset_value = "high"\n',
    });
    expect(surface).toHaveLength(1);
    expect(surface[0]!["kind"]).toBe("api");
    expect(surface[0]!["asset_value"]).toBe("high");
  });

  it("override accepts module reference", async () => {
    const surface = await surfaceOf({
      "pkg/app.py": "def serve():\n    pass\n",
      [OVERRIDE]: '[[entrypoint]]\nnode = "pkg.app:serve"\nkind = "api"\n',
    });
    expect(ids(surface)).toContain("pkg.app:serve");
  });

  it("override ambiguous module reference is skipped", async () => {
    const surface = await surfaceOf({
      "src/pkg/app.py": "def serve():\n    pass\n",
      "tests/pkg/app.py": "def serve():\n    pass\n",
      [OVERRIDE]: '[[entrypoint]]\nnode = "pkg.app:serve"\nkind = "api"\n',
    });
    expect(surface).toEqual([]);
  });

  it("override unknown node is skipped", async () => {
    const surface = await surfaceOf({
      "app.py": "def real():\n    pass\n",
      [OVERRIDE]: '[[entrypoint]]\nnode = "nonexistent:func"\nkind = "api"\n',
    });
    expect(surface).toEqual([]);
  });

  it("override invalid enum is skipped", async () => {
    const surface = await surfaceOf({
      "app.py": "def main():\n    pass\n",
      [OVERRIDE]: '[[entrypoint]]\nnode = "app:main"\nkind = "not-a-real-kind"\n',
    });
    expect(surface).toHaveLength(1);
    expect(surface[0]!["trust_level"]).toBe("trusted_internal");
  });

  it("malformed override toml is tolerated", async () => {
    const surface = await surfaceOf({
      "app.py": "def main():\n    pass\n",
      [OVERRIDE]: "this is not valid toml = [",
    });
    expect(surface.length).toBeGreaterThan(0);
  });
});

describe("TestOptOut", () => {
  it("detection can be disabled", async () => {
    const engine = await engineFor({ "tool.py": "def main():\n    pass\n" }, "python", false);
    expect(engine.attackSurface()).toEqual([]);
  });
});

describe("TestDirectAPI", () => {
  it("returns mapping of node id to tag", async () => {
    const src = source({ "tool.py": "def main():\n    pass\n" });
    const graph = await parseDirectory(src, "python");
    const detected = await detectEntrypoints(graph, src, ROOT);
    expect(detected.get("tool:main")).toEqual({
      kind: "user_input",
      trustLevel: "trusted_internal",
      description: "CLI main() entrypoint",
      assetValue: "low",
    });
  });
});

describe("TestPythonFrameworks", () => {
  it("flask route detected", async () => {
    const ep = byId(
      await surfaceOf({
        "app.py":
          "from flask import Flask\napp = Flask(__name__)\n\n@app.route('/login', methods=['POST'])\n" +
          "def login():\n    return 'ok'\n",
      }),
    ).get("app:login");
    expect(ep).toBeDefined();
    expect(ep!["kind"]).toBe("api");
    expect(ep!["trust_level"]).toBe("untrusted_external");
    expect(ep!["asset_value"]).toBe("high");
  });

  it("fastapi post detected", async () => {
    const surface = await surfaceOf({
      "api.py":
        "from fastapi import FastAPI\napp = FastAPI()\n\n@app.post('/auth')\nasync def auth(body: dict):\n    return body\n",
    });
    expect(ids(surface)).toContain("api:auth");
  });

  it("fastapi router detected", async () => {
    const surface = await surfaceOf({
      "routes.py":
        "from fastapi import APIRouter\nrouter = APIRouter()\n\n@router.get('/users/{id}')\n" +
        "def get_user(id: int):\n    return {'id': id}\n",
    });
    expect(ids(surface)).toContain("routes:get_user");
  });

  it("click command detected", async () => {
    const ep = byId(await surfaceOf({ "tool.py": "import click\n\n@click.command()\ndef run():\n    pass\n" })).get(
      "tool:run",
    );
    expect(ep!["kind"]).toBe("user_input");
    expect(ep!["asset_value"]).toBe("medium");
  });

  it("typer command detected", async () => {
    const surface = await surfaceOf({
      "cli.py": "import typer\napp = typer.Typer()\n\n@app.command()\ndef hello(name: str):\n    pass\n",
    });
    expect(ids(surface)).toContain("cli:hello");
  });

  it("celery task detected", async () => {
    const ep = byId(
      await surfaceOf({
        "tasks.py":
          "from celery import Celery\ncelery_app = Celery()\n\n@celery_app.task\ndef send_email(to, body):\n    pass\n",
      }),
    ).get("tasks:send_email");
    expect(ep!["kind"]).toBe("third_party");
    expect(ep!["trust_level"]).toBe("semi_trusted_external");
  });

  it("undecorated function not detected", async () => {
    expect(await surfaceOf({ "mod.py": "def helper():\n    pass\n" })).toEqual([]);
  });
});

describe("TestRustFrameworks", () => {
  caseIt("actix web get detected", "rust_actix_get", (s) => {
    expect([...ids(s)].some((id) => id.includes("get_user"))).toBe(true);
  });
  caseIt("no_mangle ffi detected", "rust_no_mangle", (s) => {
    expect([...ids(s)].some((id) => id.includes("add_one"))).toBe(true);
    expect(s.some((ep) => ep["asset_value"] === "high")).toBe(true);
  });
});

describe("TestSolidity", () => {
  caseIt("external function detected", "sol_external", (s) => {
    expect([...ids(s)].some((id) => id.includes("withdraw"))).toBe(true);
  });
  caseIt("public function detected", "sol_public", (s) => {
    expect([...ids(s)].some((id) => id.includes("balanceOf"))).toBe(true);
  });
  caseIt("internal function not detected", "sol_internal", (s) => {
    expect(s).toEqual([]);
  });
  caseIt("fallback and receive detected when parser emits them", "sol_fallback_receive", (s) => {
    expect(ids(s)).toContain("Wallet:Wallet.receive");
    expect(ids(s)).toContain("Wallet:Wallet.fallback");
  });
});

describe("TestJavaScriptFrameworks", () => {
  caseIt("nestjs controller method detected", "ts_nestjs", (s) => {
    expect(descriptions(s).some((d) => d.includes("NestJS"))).toBe(true);
  });
  caseIt("nextjs app router detected", "ts_nextjs_app_router", (s) => {
    expect(descriptions(s).some((d) => d.includes("Next.js App Router"))).toBe(true);
  });
});

describe("TestJavaFrameworks", () => {
  caseIt("spring get mapping detected", "java_spring", (s) => {
    expect(descriptions(s).some((d) => d.includes("Spring"))).toBe(true);
  });
  caseIt("jaxrs get detected", "java_jaxrs", (s) => {
    expect(descriptions(s).some((d) => d.includes("JAX-RS"))).toBe(true);
  });
});

describe("TestCSharpFrameworks", () => {
  caseIt("aspnet core http get detected", "cs_aspnet", (s) => {
    expect(descriptions(s).some((d) => d.includes("ASP.NET"))).toBe(true);
  });
});

describe("TestPhpFrameworks", () => {
  caseIt("symfony route attribute detected", "php_symfony", (s) => {
    expect(descriptions(s).some((d) => d.includes("Symfony"))).toBe(true);
  });
});

describe("TestErlang", () => {
  caseIt("exported function detected", "erlang_export", (s) => {
    const names = new Set(s.map((ep) => (ep["node_id"] as string).split(":").slice(1).join(":")));
    expect(names).toContain("login");
    expect(names).toContain("logout");
    expect(names).not.toContain("internal_only");
  });
});

describe("TestSwift", () => {
  caseIt("at main attribute detected", "swift_main", (s) => {
    expect(descriptions(s).some((d) => d.includes("Swift @main"))).toBe(true);
  });
});

describe("TestObjectiveC", () => {
  caseIt("app delegate selector detected", "objc_app_delegate", (s) => {
    expect(descriptions(s).some((d) => d.includes("UIApplicationDelegate"))).toBe(true);
  });
  caseIt("non app method not flagged", "objc_non_app", (s) => {
    expect(s).toEqual([]);
  });
});

describe("TestKotlin", () => {
  caseIt("spring annotation detected", "kotlin_spring", (s) => {
    expect(descriptions(s).some((d) => d.includes("Spring"))).toBe(true);
  });
  caseIt("android lifecycle method detected", "kotlin_android", (s) => {
    expect(descriptions(s).some((d) => d.includes("Android"))).toBe(true);
  });
  caseIt("helper method not flagged", "kotlin_helper", (s) => {
    expect(s).toEqual([]);
  });
});

describe("TestDart", () => {
  caseIt("vm entry point detected", "dart_vm_entry", (s) => {
    expect(descriptions(s).some((d) => d.includes("vm:entry-point"))).toBe(true);
  });
  caseIt("plain function not flagged", "dart_plain", (s) => {
    expect(s).toEqual([]);
  });
  caseIt("main still detected", "dart_main", (s) => {
    expect(ids(s)).toContain("app:main");
  });
});

describe("TestGo", () => {
  caseIt("http handlefunc detected", "go_handlefunc", (s) => {
    expect(descriptions(s).some((d) => d.includes("Go HTTP handler"))).toBe(true);
  });
  caseIt("gin route detected", "go_gin", (s) => {
    expect([...ids(s)].some((id) => id.includes("getUser"))).toBe(true);
  });
});

describe("TestRuby", () => {
  caseIt("rails controller action detected", "ruby_rails", (s) => {
    expect(descriptions(s).some((d) => d.includes("Rails controller"))).toBe(true);
  });
  caseIt("non controller class not flagged", "ruby_util", (s) => {
    expect(s).toEqual([]);
  });
  caseIt("sidekiq worker perform detected", "ruby_sidekiq", (s) => {
    expect(descriptions(s).some((d) => d.includes("Sidekiq"))).toBe(true);
  });
});

describe("TestCCpp", () => {
  caseIt("extern C detected", "cpp_extern_c", (s) => {
    expect(descriptions(s).some((d) => d.includes('extern "C"') || d.includes("exported"))).toBe(true);
  });
  caseIt("dllexport detected", "c_dllexport", (s) => {
    expect(descriptions(s).some((d) => d.includes("dllexport") || d.includes("exported"))).toBe(true);
  });
  caseIt("plain c function not flagged", "c_plain", (s) => {
    expect([...ids(s)].some((id) => id.includes("helper"))).toBe(false);
  });
});

describe("TestBulkOverrideRules", () => {
  const OVERRIDE = ".trailmark/entrypoints.toml";

  caseIt("file glob marks every matching function", "php_glob", (s) => {
    const nodeIds = [...ids(s)];
    expect(nodeIds.some((id) => id.endsWith(":index"))).toBe(true);
    expect(nodeIds.some((id) => id.endsWith(":login"))).toBe(true);
    expect(nodeIds.some((id) => id.endsWith(":helper"))).toBe(false);
  });

  it("file glob single star does not cross directories", async () => {
    const nodeIds = [
      ...ids(
        await surfaceOf({
          "public/index.py": "def index(): pass\n",
          "public/admin/deep.py": "def deep(): pass\n",
          [OVERRIDE]: '[[entrypoint]]\nfile_glob = "public/*.py"\nkind = "api"\ntrust = "untrusted_external"\n',
        }),
      ),
    ];
    expect(nodeIds.some((id) => id.endsWith(":index"))).toBe(true);
    expect(nodeIds.some((id) => id.endsWith(":deep"))).toBe(false);
  });

  it("param type matches psr7", async () => {
    const surface = byId(
      await surfaceOf({
        "handlers.py":
          "def handle_login(req: ServerRequestInterface) -> None:\n    pass\n\ndef unrelated(x: int) -> None:\n    pass\n",
        [OVERRIDE]:
          '[[entrypoint]]\nparam_type = "ServerRequestInterface"\nkind = "api"\ntrust = "untrusted_external"\n' +
          'asset_value = "high"\ndescription = "PSR-7 HTTP handler"\n',
      }),
    );
    expect(surface.get("handlers:handle_login")!["description"]).toBe("PSR-7 HTTP handler");
    expect([...surface.keys()].some((id) => id.endsWith(":unrelated"))).toBe(false);
  });

  it("name regex matches", async () => {
    const s = ids(
      await surfaceOf({
        "api.py":
          "def handle_login(req):\n    pass\n\ndef handle_logout(req):\n    pass\n\ndef internal_helper(x):\n    pass\n",
        [OVERRIDE]: '[[entrypoint]]\nname_regex = "^handle_"\nkind = "api"\ntrust = "untrusted_external"\n',
      }),
    );
    expect(s).toContain("api:handle_login");
    expect(s).toContain("api:handle_logout");
    expect(s).not.toContain("api:internal_helper");
  });

  it("conditions compose with and", async () => {
    const s = ids(
      await surfaceOf({
        "public/web.py": "def handle_login(req):\n    pass\n",
        "public/util.py": "def helper(x):\n    pass\n",
        "internal.py": "def handle_internal(x):\n    pass\n",
        [OVERRIDE]:
          '[[entrypoint]]\nfile_glob = "public/*.py"\nname_regex = "^handle_"\nkind = "api"\ntrust = "untrusted_external"\n',
      }),
    );
    expect(s).toContain("public.web:handle_login");
    expect(s).not.toContain("util:helper");
    expect(s).not.toContain("internal:handle_internal");
  });

  it("rule overrides heuristic", async () => {
    const surface = await surfaceOf({
      "tool.py": "def main(): pass\n",
      [OVERRIDE]:
        '[[entrypoint]]\nname_regex = "^main$"\nkind = "api"\ntrust = "untrusted_external"\nasset_value = "high"\n',
    });
    expect(surface).toHaveLength(1);
    expect(surface[0]!["kind"]).toBe("api");
    expect(surface[0]!["trust_level"]).toBe("untrusted_external");
    expect(surface[0]!["asset_value"]).toBe("high");
  });

  it("malformed glob does not crash", async () => {
    const surface = await surfaceOf({
      "app.py": "def main(): pass\n",
      [OVERRIDE]: '[[entrypoint]]\nfile_glob = "public/["\nkind = "api"\n',
    });
    expect(surface.length).toBeGreaterThan(0);
  });

  it("rule matching zero nodes is noop", async () => {
    const surface = await surfaceOf({
      "app.py": "def real(): pass\n",
      [OVERRIDE]: '[[entrypoint]]\nname_regex = "^never_matches$"\nkind = "api"\n',
    });
    expect(surface).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// test_detector_tags.py
// ---------------------------------------------------------------------------

function single(s: Surface): JsonObject {
  expect(s).toHaveLength(1);
  return s[0]!;
}

function named(s: Surface, name: string): JsonObject {
  const matches = s.filter((ep) => (ep["node_id"] as string).includes(name));
  expect(matches.length).toBeGreaterThan(0);
  return matches[0]!;
}

function expectTag(ep: JsonObject, kind: string, trust: string, asset: string, description?: string): void {
  expect(ep["kind"]).toBe(kind);
  expect(ep["trust_level"]).toBe(trust);
  expect(ep["asset_value"]).toBe(asset);
  if (description !== undefined) expect(ep["description"]).toBe(description);
}

describe("TestPythonDetectorTags", () => {
  for (const verb of ["route", "get", "post", "put", "patch", "delete"]) {
    it(`flask http decorator tag fields (${verb})`, async () => {
      const ep = single(
        await surfaceOf({
          "app.py": `from flask import Flask\napp = Flask(__name__)\n\n@app.${verb}('/')\ndef handler():\n    return 'ok'\n`,
        }),
      );
      expectTag(ep, "api", "untrusted_external", "high", "Python HTTP route decorator");
    });
  }

  it("click command tag", async () => {
    const ep = single(await surfaceOf({ "cli.py": "import click\n@click.command()\ndef run(): pass\n" }));
    expectTag(ep, "user_input", "untrusted_external", "medium", "Python CLI command (Click/Typer)");
  });

  it("celery task tag", async () => {
    const ep = single(
      await surfaceOf({ "tasks.py": "from celery import Celery\napp = Celery()\n@app.task\ndef send(): pass\n" }),
    );
    expectTag(ep, "third_party", "semi_trusted_external", "medium", "Python task queue handler (Celery)");
  });
});

describe("TestJavaDetectorTags", () => {
  for (const a of ["GetMapping", "PostMapping", "PutMapping", "DeleteMapping", "PatchMapping", "RequestMapping"]) {
    caseIt(`spring mapping tags (${a})`, `tags_java_${a}`, (s) => {
      expectTag(named(s, ".f"), "api", "untrusted_external", "high", "Spring MVC/WebFlux handler");
    });
  }
  for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
    caseIt(`jaxrs verb tags (${verb})`, `tags_jaxrs_${verb}`, (s) => {
      const ep = named(s, ".f");
      expect(ep["kind"]).toBe("api");
      expect(ep["description"]).toBe("JAX-RS handler");
    });
  }
  caseIt("kafka listener tag", "tags_kafka", (s) => {
    expectTag(named(s, ".consume"), "third_party", "semi_trusted_external", "medium", "Kafka listener");
  });
  for (const m of ["doGet", "doPost", "doPut", "doDelete", "doHead", "doOptions", "doTrace"]) {
    caseIt(`servlet method tag (${m})`, `tags_servlet_${m}`, (s) => {
      expectTag(named(s, `.${m}`), "api", "untrusted_external", "high", "HttpServlet method");
    });
  }
});

describe("TestRustDetectorTags", () => {
  for (const verb of ["get", "post", "put", "patch", "delete", "head", "options"]) {
    caseIt(`actix web handler tags (${verb})`, `tags_actix_${verb}`, (s) => {
      expectTag(named(s, "handler"), "api", "untrusted_external", "high", "Rust HTTP handler attribute");
    });
  }
  caseIt("no_mangle ffi tag", "tags_no_mangle", (s) => {
    const ep = named(s, "expose");
    expectTag(ep, "api", "untrusted_external", "high");
    expect(ep["description"]).toContain("FFI export");
  });
});

describe("TestCSharpDetectorTags", () => {
  for (const attr of ["HttpGet", "HttpPost", "HttpPut", "HttpDelete", "HttpPatch"]) {
    caseIt(`aspnet attribute tags (${attr})`, `tags_aspnet_${attr}`, (s) => {
      expectTag(named(s, ".F"), "api", "untrusted_external", "high", "ASP.NET Core HTTP handler");
    });
  }
  caseIt("azure function tag", "tags_azure", (s) => {
    const ep = named(s, ".Run");
    expect(ep["kind"]).toBe("api");
    expect(ep["description"]).toBe("Azure Function");
  });
});

describe("TestSolidityDetectorTags", () => {
  for (const vis of ["external", "public"]) {
    caseIt(`function visibility tags (${vis})`, `tags_sol_${vis}`, (s) => {
      expectTag(named(s, ".act"), "api", "untrusted_external", "high", "Solidity external/public function");
    });
  }
  caseIt("interface methods are not entrypoints", "tags_sol_interface", (s) => {
    expect(s).toEqual([]);
  });
  caseIt("mutability is preserved on entrypoint node", "tags_sol_mutability", (s, engine) => {
    const ep = named(s, ".inspect");
    expect(ep["kind"]).toBe("api");
    expect(ep["attributes"]).toEqual({
      solidity_container_kind: "contract",
      solidity_mutability: "view",
      solidity_visibility: "external",
    });
    const unit = engine.store.unit("C:C.inspect");
    expect(unit).toBeDefined();
    expect(unit!.attributes).toContainEqual(["solidity_visibility", "external"]);
    expect(unit!.attributes).toContainEqual(["solidity_mutability", "view"]);
  });
  caseIt("derived override annotates base entrypoint", "tags_sol_override", (s, engine) => {
    expect(ids(s)).toContain("C:Derived.act");
    expect(ids(s)).toContain("C:Base.act");
    const base = engine.store.unit("C:Base.act");
    expect(base).toBeDefined();
    expect(base!.attributes).toContainEqual(["solidity_overridden_by", "C:Derived.act"]);
  });
});

describe("TestNextJsDetectorTags", () => {
  for (const verb of ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
    caseIt(`app router verb tags (${verb})`, `tags_nextjs_${verb}`, (s) => {
      expectTag(named(s, verb), "api", "untrusted_external", "high", "Next.js App Router handler");
    });
  }
});

describe("TestSwiftDetectorTags", () => {
  caseIt("at main tag", "tags_swift_main", (s) => {
    expectTag(named(s, ".main"), "user_input", "untrusted_external", "high", "Swift @main app entrypoint");
  });
});

describe("TestObjCDetectorTags", () => {
  caseIt("url handler tag", "tags_objc_openurl", (s) => {
    expectTag(
      named(s, "application:openURL:options:"),
      "api",
      "untrusted_external",
      "high",
      "Objective-C UIApplicationDelegate lifecycle method",
    );
  });
});

describe("TestKotlinDetectorTags", () => {
  caseIt("spring tag", "tags_kotlin_spring", (s) => {
    const ep = named(s, ".f");
    expect(ep["kind"]).toBe("api");
    expect(ep["asset_value"]).toBe("high");
    expect(ep["description"]).toBe("Spring MVC/WebFlux handler (Kotlin)");
  });
  for (const m of [
    "onCreate",
    "onStart",
    "onResume",
    "onNewIntent",
    "onActivityResult",
    "onReceive",
    "onBind",
    "onHandleIntent",
  ]) {
    caseIt(`android lifecycle tags (${m})`, `tags_android_${m}`, (s) => {
      expectTag(named(s, `.${m}`), "api", "untrusted_external", "high", "Android component lifecycle method");
    });
  }
});

describe("TestDartDetectorTags", () => {
  caseIt("vm entry point tag", "tags_dart_vm", (s) => {
    expectTag(named(s, ":fn"), "api", "untrusted_external", "high", "Dart @pragma('vm:entry-point') native callback");
  });
});

describe("TestCCppDetectorTags", () => {
  caseIt("extern C tag", "tags_cpp_extern_c", (s) => {
    const ep = named(s, "expose");
    expectTag(ep, "api", "untrusted_external", "high");
    expect(ep["description"]).toContain("exported symbol");
  });
});

// ---------------------------------------------------------------------------
// TS-port-specific checks
// ---------------------------------------------------------------------------

describe("globToRegex (parity with upstream _glob_to_regex)", () => {
  const PATHS = [
    "root/public_html/index.php",
    "root/public_html/a/b/c.php",
    "public_html/x.php",
    "root/public/index.py",
    "root/public/admin/deep.py",
    "a/b.py",
    "b.py",
    "src/x/y",
    "proj/src",
    "abc.py",
    "a/c.py",
    "a/x.(y)+[z]{1}|w$^.py",
    "q/b/c.go",
    "q/b/r/s/c.go",
    "lib/x/y.rs",
    "lib/1/x/2/3/y.rs",
    "zlib/x/y.rs",
  ];
  // Recorded from upstream: {glob: matching paths}.
  const EXPECTED: Record<string, string[]> = {
    "public_html/**/*.php": ["root/public_html/index.php", "root/public_html/a/b/c.php", "public_html/x.php"],
    "public/*.py": ["root/public/index.py"],
    "**/*.py": [
      "root/public/index.py",
      "root/public/admin/deep.py",
      "a/b.py",
      "b.py",
      "abc.py",
      "a/c.py",
      "a/x.(y)+[z]{1}|w$^.py",
    ],
    "src/**": ["src/x/y"],
    "a?c.py": ["abc.py"],
    "x.(y)+[z]{1}|w$^.py": ["a/x.(y)+[z]{1}|w$^.py"],
    "**": PATHS,
    "*/b/**/c.go": ["q/b/c.go", "q/b/r/s/c.go"],
    "lib/**/x/**/y.rs": ["lib/x/y.rs", "lib/1/x/2/3/y.rs"],
  };
  for (const [glob, expected] of Object.entries(EXPECTED)) {
    it(glob, () => {
      const re = globToRegex(glob);
      expect(PATHS.filter((p) => re.test(p))).toEqual(expected);
    });
  }
});

describe("repo root discovery (TS: bounded by FileSource root)", () => {
  it("override file in a subdirectory root takes precedence over parent pyproject", async () => {
    const src = source({
      "pyproject.toml": '[project]\nname = "demo"\n[project.scripts]\ndemo = "app:main"\n',
      "pkg/app.py": "def main():\n    pass\n",
      "pkg/.trailmark/entrypoints.toml": '[[entrypoint]]\nnode = "app:main"\nkind = "api"\n',
    });
    const dir = `${ROOT}/pkg`;
    const graph = await parseDirectory(src, "python", { dir });
    const tag = (await detectEntrypoints(graph, src, dir)).get("app:main");
    // pkg/ is the repo root (override marker), so the parent pyproject is not read.
    expect(tag).toEqual({ kind: "api", trustLevel: "untrusted_external", description: null, assetValue: "medium" });
  });
});
