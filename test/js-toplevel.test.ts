import { describe, expect, it } from "vitest";

import { detectEntrypoints } from "../src/analysis/entrypoints.js";
import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import { parseDirectory, parseSource } from "../src/parse.js";

const attrs = (graph: CodeGraph, id: string) => Object.fromEntries(graph.nodes.get(id)?.attributes ?? []);
const callsFrom = (graph: CodeGraph, id: string) =>
  graph.edges.filter((e) => e.kind === "calls" && e.sourceId === id).map((e) => e.targetId);

const SERVER = `import express, { Request, Response } from 'express'
import { getProductById } from './db'

const app = express()
const router = express.Router()
const cache = makeCache()

app.get('/product/:id', (req: Request, res: Response) => {
  const row = getProductById(req.params.id)
  return res.send(row)
})
router.post('/login', async function (req, res) { audit(req) })
app.use((req, res, next) => next())
cache.get('/not-a-route', (v) => v.trim())
app.listen(3000)
`;

const DB = `export function getProductById(id: string) { return query(id) }
function query(id: string) { return id }
`;

async function parseProject(files: Record<string, string>, language: string, upstreamCompat = false) {
  const source = new MemoryFileSource("proj", files);
  const graph = await parseDirectory(source, language, { upstreamCompat });
  for (const [id, tag] of await detectEntrypoints(graph, source, source.root)) graph.entrypoints.set(id, tag);
  return graph;
}

describe("JS/TS anonymous callbacks and top-level calls (not in upstream)", () => {
  it.each(["typescript", "javascript"])("%s: extracts route callbacks with callee, route and factory", async (lang) => {
    const ext = lang === "typescript" ? "ts" : "js";
    const code = lang === "typescript" ? SERVER : SERVER.replace("(req: Request, res: Response)", "(req, res)");
    const graph = await parseProject({ [`server.${ext}`]: code, [`db.${ext}`]: DB }, lang);
    expect(attrs(graph, "server:app.get@8")).toEqual({
      anonymous: true,
      callback_of: "app.get",
      route: "/product/:id",
      registered_on_factory: "express",
    });
    expect(callsFrom(graph, "server:app.get@8")).toContain("db:getProductById");
    expect(attrs(graph, "server:router.post@12")["registered_on_factory"]).toBe("express.Router");
    expect(graph.nodes.has("server:app.use@13")).toBe(true);
    expect(graph.nodes.get("server:app.get@8")!.kind).toBe("function");
  });

  it("records calls made by top-level statements as calls from the module", async () => {
    const graph = await parseProject({ "server.ts": SERVER, "db.ts": DB }, "typescript");
    const raw = graph.edges
      .filter((e) => e.kind === "calls" && e.sourceId === "server")
      .map((e) => String(e.attributes.find(([k]) => k === "raw_target")?.[1] ?? e.targetId));
    expect(raw).toEqual(
      expect.arrayContaining(["server:express", "express.Router", "server:makeCache", "app.get", "app.listen"]),
    );
    // Calls inside callbacks belong to the callback, not the module.
    expect(raw).not.toContain("server:getProductById");
    expect(raw).not.toContain("db:getProductById");
  });

  it("tags Express/Fastify route registrations as API entrypoints, and nothing else", async () => {
    const fastify = `import Fastify from 'fastify'
const server = Fastify()
server.post('/items', async (request) => { return save(request.body) })`;
    const graph = await parseProject({ "server.ts": SERVER, "db.ts": DB, "f.ts": fastify }, "typescript");
    const surface = Object.fromEntries([...graph.entrypoints].map(([id, t]) => [id, t.description]));
    expect(surface).toEqual({
      "server:app.get@8": "Express route GET /product/:id",
      "server:router.post@12": "Express route POST /login",
      "server:app.use@13": "Express middleware",
      "f:server.post@3": "Fastify route POST /items",
    });
    expect(graph.entrypoints.get("server:app.get@8")).toMatchObject({
      kind: "api",
      trustLevel: "untrusted_external",
      assetValue: "high",
    });
  });

  it("names other anonymous functions by their context", async () => {
    const code = `
module.exports.handler = async (event) => { work(event) }
export default () => boot()
;(function () { init() })()
const routes = { list: () => fetchAll() }
if (flag) { const nested = () => go() }
[1, 2].map((x) => x * 2); [3].map((x) => x)
`;
    const graph = await parseSource("m.ts", code, "typescript");
    const ids = [...graph.nodes.keys()].filter((id) => id.startsWith("m:") && !id.startsWith("proxy"));
    expect(ids).toEqual(
      expect.arrayContaining([
        "m:module.exports.handler@2",
        "m:default",
        "m:<iife>@4",
        "m:list@5",
        "m:nested@6",
        "m:[1,2].map@7",
        "m:[3].map@7",
      ]),
    );
    // Expression-bodied arrows still record their call.
    expect(callsFrom(graph, "m:list@5")).toEqual(["proxy.unresolved:m:fetchAll"]);
  });

  it("extracts top-level generator expressions, which upstream does not", async () => {
    const graph = await parseSource("m.ts", "const gen = function* () { yield step() }\n", "typescript");
    expect(callsFrom(graph, "m:gen@1")).toEqual(["proxy.unresolved:m:step"]);
  });

  it("extracts methods in top-level object literals and strips quotes from keys", async () => {
    const code = "const repo = {\n  get(id) { return fetchOne(id) },\n  'quoted key': () => other(),\n}\n";
    const graph = await parseSource("m.js", code, "javascript");
    expect(callsFrom(graph, "m:get@2")).toEqual(["proxy.unresolved:m:fetchOne"]);
    expect(graph.nodes.get("m:get@2")!.parameters.map((p) => p.name)).toEqual(["id"]);
    expect(callsFrom(graph, "m:quoted key@3")).toEqual(["proxy.unresolved:m:other"]);
    expect(callsFrom(graph, "m")).not.toContain("proxy.unresolved:m:fetchOne");
  });

  it.each([
    ["export default async (req, res) => { handle(req) }", "m:default"],
    ["export default function () { handle() }", "m:default"],
    ["export default async function* () { handle() }", "m:default"],
  ])("names anonymous default exports 'default': %s", async (code, id) => {
    const graph = await parseSource("m.ts", code, "typescript");
    expect(callsFrom(graph, id)).toEqual(["proxy.unresolved:m:handle"]);
  });

  it("leaves functions upstream already extracts alone", async () => {
    const graph = await parseSource(
      "m.ts",
      "export const handler = (e) => run(e)\nfunction named() {}\n",
      "typescript",
    );
    expect([...graph.nodes.keys()].filter((id) => !id.startsWith("proxy"))).toEqual(["m", "m:handler", "m:named"]);
  });

  it("recognizes CommonJS router factories", async () => {
    const code = `const app = require('express')()
const router = require('express').Router()
const fastify = require('fastify')({ logger: true })
app.get('/a', (req, res) => res.end())
router.post('/b', (req, res) => res.end())
fastify.put('/c', async (request) => request.body)
`;
    const graph = await parseProject({ "server.js": code }, "javascript");
    expect(attrs(graph, "server:app.get@4")["registered_on_factory"]).toBe("express");
    expect(attrs(graph, "server:router.post@5")["registered_on_factory"]).toBe("express.Router");
    expect(attrs(graph, "server:fastify.put@6")["registered_on_factory"]).toBe("fastify");
    expect([...graph.entrypoints.values()].map((t) => t.description)).toEqual([
      "Express route GET /a",
      "Express route POST /b",
      "Fastify route PUT /c",
    ]);
  });

  it("detects an anonymous default export under pages/api as a Next.js handler", async () => {
    const graph = await parseProject(
      { "pages/api/user.ts": "export default async (req, res) => { res.json(load(req)) }" },
      "typescript",
    );
    expect(graph.entrypoints.get("pages.api.user:default")?.description).toBe("Next.js Pages API handler");
  });

  it("upstreamCompat extracts none of it, like upstream", async () => {
    const graph = await parseProject({ "server.ts": SERVER, "db.ts": DB }, "typescript", true);
    expect([...graph.nodes.keys()].filter((id) => id.startsWith("server") && !id.startsWith("proxy"))).toEqual([
      "server",
    ]);
    expect(graph.edges.some((e) => e.kind === "calls" && e.sourceId === "server")).toBe(false);
    expect(graph.entrypoints.size).toBe(0);
  });
});
