import { describe, expect, it } from "vitest";

import { main } from "../src/cli.js";
import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeEdge } from "../src/models/edges.js";
import { parseDirectory, parseSource } from "../src/parse.js";
import { MemoryParseCache } from "../src/persist/parse-cache.js";
import { QueryEngine } from "../src/query/api.js";

const attr = (e: CodeEdge, key: string) => e.attributes.find(([k]) => k === key)?.[1];

/** Call edges from ``source`` (a method id suffix) keyed by raw call text → resolved target. */
function callsFrom(edges: CodeEdge[], source: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of edges) {
    if (e.kind !== "calls" || !e.sourceId.endsWith(source)) continue;
    out[String(attr(e, "raw_target") ?? e.targetId)] = e.targetId;
  }
  return out;
}

const REPO = `
class Repo {
  Item find(Id id) { return null; }
  static Repo create() { return new Repo(); }
  void close() {}
}
class Base { void audit() {} }
class Svc extends Base {
  private final Repo repo;
  private Repo other, third;
  Svc(Repo repo) { this.repo = repo; }
  void run(Repo param, java.util.List<Repo> repos) {
    repo.find(null);           // field (via unqualified name)
    this.other.find(null);     // this.field
    param.find(null);          // parameter
    Repo local = Repo.create();// static call on class name
    local.close();             // typed local
    var made = new Repo();
    made.close();              // var + new
    new Repo().close();        // receiver is a creation expression
    for (Repo r : repos) r.close();          // enhanced for
    try (Repo res = Repo.create()) { res.close(); } catch (IllegalStateException e) { e.printStackTrace(); }
    repos.forEach(x -> x.close());           // untyped lambda param: unknown
    this.helper();             // this.method
    super.audit();             // super.method
    audit();                   // inherited, unqualified (left to upstream logic)
  }
  void shadow() {
    String repo = "";
    repo.find(null);           // local String shadows the Repo field: must not resolve to Repo.find
  }
  void helper() {}
}`;

describe("Java receiver-type call resolution (not in upstream)", () => {
  it("resolves receivers from fields, params, locals, var/new, static, loops and resources", async () => {
    const graph = await parseSource("Svc.java", REPO, "java");
    const calls = callsFrom(graph.edges, "Svc.run");
    expect(calls["repo.find"]).toBe("Svc:Repo.find");
    expect(calls["this.other.find"]).toBe("Svc:Repo.find");
    expect(calls["param.find"]).toBe("Svc:Repo.find");
    expect(calls["Repo.create"]).toBe("Svc:Repo.create");
    expect(calls["local.close"]).toBe("Svc:Repo.close");
    expect(calls["made.close"]).toBe("Svc:Repo.close");
    expect(calls["new Repo().close"]).toBe("Svc:Repo.close");
    expect(calls["r.close"]).toBe("Svc:Repo.close");
    expect(calls["res.close"]).toBe("Svc:Repo.close");
    expect(calls["this.helper"]).toBe("Svc:Svc.helper");
    expect(calls["super.audit"]).toBe("Svc:Base.audit");
    // Unknown receiver types stay unresolved proxies, as upstream.
    expect(calls["x.close"]).toBe("proxy.unresolved:x.close");
    expect(calls["e.printStackTrace"]).toBe("proxy.unresolved:e.printStackTrace");
  });

  it("tags resolved edges and keeps their confidence", async () => {
    const graph = await parseSource("Svc.java", REPO, "java");
    const edge = graph.edges.find((e) => e.sourceId === "Svc:Svc.run" && e.targetId === "Svc:Repo.find")!;
    expect(attr(edge, "receiver_type")).toBe("Repo");
    expect(attr(edge, "resolved_by")).toBe("receiver_type");
    expect(edge.confidence).toBe("inferred");
  });

  it("respects shadowing: a local declared in the method wins over a field", async () => {
    const graph = await parseSource("Svc.java", REPO, "java");
    expect(callsFrom(graph.edges, "Svc.shadow")["repo.find"]).toBe("proxy.unresolved:repo.find");
  });

  it("links across files and through inherited methods", async () => {
    const source = new MemoryFileSource("proj", {
      "repo/BaseRepository.java": "package repo; public class BaseRepository { public void save(Object o) {} }",
      "repo/ProductRepository.java":
        "package repo; public class ProductRepository extends BaseRepository { public Object getProduct(String id) { return null; } }",
      "web/ProductController.java": `package web;
        public class ProductController {
          private ProductRepository repo;
          public Object byId(String id) { var p = repo.getProduct(id); repo.save(p); return p; }
        }`,
    });
    const engine = QueryEngine.fromGraph(await parseDirectory(source, "java"));
    expect(engine.callersOf("repo.ProductRepository:ProductRepository.getProduct").map((u) => u["id"])).toEqual([
      "web.ProductController:ProductController.byId",
    ]);
    expect(engine.callersOf("repo.BaseRepository:BaseRepository.save").map((u) => u["id"])).toEqual([
      "web.ProductController:ProductController.byId",
    ]);
  });

  it("does not guess between same-named types in unrelated packages", async () => {
    const source = new MemoryFileSource("proj", {
      "a/Repo.java": "package a; class Repo { void go() {} }",
      "b/Repo.java": "package b; class Repo { void go() {} }",
      "c/Use.java": "package c; class Use { Repo r; void m() { r.go(); } }",
    });
    const graph = await parseDirectory(source, "java");
    expect(callsFrom(graph.edges, "Use.m")["r.go"]).toBe("proxy.unresolved:r.go");
  });

  it("upstreamCompat reproduces upstream exactly: no receiver attributes, no resolution", async () => {
    const graph = await parseSource("Svc.java", REPO, "java", { upstreamCompat: true });
    expect(graph.edges.some((e) => attr(e, "receiver_type") !== undefined)).toBe(false);
    expect(callsFrom(graph.edges, "Svc.run")["repo.find"]).toBe("proxy.unresolved:repo.find");
  });

  it("keeps compat and default parses apart in the parse cache", async () => {
    const cache = new MemoryParseCache();
    const source = new MemoryFileSource("proj", { "Svc.java": REPO });
    await parseDirectory(source, "java", { cache, upstreamCompat: true });
    const graph = await parseDirectory(source, "java", { cache });
    expect(cache.size).toBe(2);
    expect(callsFrom(graph.edges, "Svc.run")["repo.find"]).toBe("Svc:Repo.find");
  });
});

describe("--upstream-compat CLI flag", () => {
  const run = async (argv: string[]) => {
    let out = "";
    const code = await main(argv, { stdout: (t) => (out += t), stderr: (t) => (out += t), columns: 80 });
    return { code, out };
  };

  it("is accepted but hidden from help (help text stays identical to upstream)", async () => {
    const help = await run(["analyze", "--help"]);
    expect(help.out).not.toContain("upstream");
    expect((await run(["analyze", "--upstream-compat", "--help"])).code).toBe(0);
  });
});

const RECORDS = `
public record Comment(Id id, Body body) implements java.io.Serializable {
  public Comment {
    if (id == null) throw new IllegalArgumentException("id");
  }
  public Body body() { return body; }          // explicit accessor wins over the synthetic one
  public static record Id(String value) {
    public static Id generate() { return new Id("x"); }
  }
  public record Body(String text) {}
  class Inner { void m() { Comment.Id.generate(); this.n(); } void n() {} }
}
enum Color { RED, GREEN; int code() { return Util.f(); } }
class Util { static int f() { return 0; } }
class Use {
  void go(Comment c, Comment.Id id) { c.id(); c.body(); id.value(); Comment.Id.generate(); }
}`;

describe("Java records, nested types and enum methods (not in upstream)", () => {
  it("extracts records with synthetic accessors and compact constructors", async () => {
    const graph = await parseSource("Comment.java", RECORDS, "java");
    const record = graph.nodes.get("Comment:Comment")!;
    expect(record.kind).toBe("class");
    expect(record.attributes).toContainEqual(["java_type_kind", "record"]);
    const accessor = graph.nodes.get("Comment:Comment.id")!;
    expect(accessor).toMatchObject({ kind: "method", origin: "synthetic", returnType: { name: "Id" } });
    expect(graph.nodes.get("Comment:Comment.body")!.origin).toBe("source");
    expect(graph.nodes.get("Comment:Comment.Comment")!.exceptionTypes.map((t) => t.name)).toEqual([
      "IllegalArgumentException",
    ]);
  });

  it("extracts nested types as module:Outer.Inner with contains edges", async () => {
    const graph = await parseSource("Comment.java", RECORDS, "java");
    for (const id of ["Comment:Comment.Id", "Comment:Comment.Body", "Comment:Comment.Inner"]) {
      expect(graph.nodes.has(id)).toBe(true);
    }
    expect(graph.nodes.has("Comment:Comment.Id.generate")).toBe(true);
    expect(graph.nodes.has("Comment:Comment.Id.value")).toBe(true);
    expect(
      graph.edges.some(
        (e) => e.kind === "contains" && e.sourceId === "Comment:Comment" && e.targetId === "Comment:Comment.Id",
      ),
    ).toBe(true);
  });

  it("extracts methods declared in enum bodies", async () => {
    const graph = await parseSource("Comment.java", RECORDS, "java");
    expect(graph.nodes.get("Comment:Color.code")!.kind).toBe("method");
    expect(callsFrom(graph.edges, "Color.code")["Util.f"]).toBe("Comment:Util.f");
  });

  it("resolves calls on records, accessors and qualified nested types", async () => {
    const graph = await parseSource("Comment.java", RECORDS, "java");
    const use = callsFrom(graph.edges, "Use.go");
    expect(use["c.id"]).toBe("Comment:Comment.id");
    expect(use["c.body"]).toBe("Comment:Comment.body");
    expect(use["id.value"]).toBe("Comment:Comment.Id.value");
    expect(use["Comment.Id.generate"]).toBe("Comment:Comment.Id.generate");
    const inner = callsFrom(graph.edges, "Inner.m");
    expect(inner["Comment.Id.generate"]).toBe("Comment:Comment.Id.generate");
    expect(inner["this.n"]).toBe("Comment:Comment.Inner.n");
  });

  it("upstreamCompat skips records, nested types and enum-body methods like upstream", async () => {
    const graph = await parseSource("Comment.java", RECORDS, "java", { upstreamCompat: true });
    const ids = [...graph.nodes.keys()].filter((id) => !id.startsWith("proxy."));
    expect(ids).toEqual([
      "Comment",
      "Comment:Color",
      "Comment:Util",
      "Comment:Util.f",
      "Comment:Use",
      "Comment:Use.go",
    ]);
  });
});

describe("Java receiver resolution edge cases", () => {
  it("finds fields declared in enum bodies", async () => {
    const code = `class Helper { void help() {} }
enum Mode { A, B; static Helper H = new Helper(); void run() { H.help(); } }`;
    const graph = await parseSource("Mode.java", code, "java");
    expect(callsFrom(graph.edges, "Mode.run")["H.help"]).toBe("Mode:Helper.help");
  });

  it("resolves partially qualified nested type paths", async () => {
    const code = `class Outer {
  static class Inner { static class Deep { static void stat() {} } }
  void m() { Inner.Deep.stat(); Outer.Inner.Deep.stat(); }
}`;
    const graph = await parseSource("Outer.java", code, "java");
    const calls = callsFrom(graph.edges, "Outer.m");
    expect(calls["Inner.Deep.stat"]).toBe("Outer:Outer.Inner.Deep.stat");
    expect(calls["Outer.Inner.Deep.stat"]).toBe("Outer:Outer.Inner.Deep.stat");
  });
});
