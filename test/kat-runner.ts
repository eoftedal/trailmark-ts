/**
 * Known-answer snapshot tests shared with upstream (tests/kat_runner.py).
 * The expected JSON files are copied verbatim from upstream trailmark, so a
 * passing test means byte-identical output to the Python implementation.
 */

import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseSource } from "../src/parse.js";
import { QueryEngine } from "../src/query/api.js";
import type { Json } from "../src/query/dicts.js";
import { pyJsonDumps } from "../src/util/py.js";

export const FIXTURE_ROOT = fileURLToPath(new URL("./fixtures/kat/", import.meta.url));

function rewriteFilePaths(obj: Json, name: string): void {
  if (Array.isArray(obj)) {
    for (const item of obj) rewriteFilePaths(item, name);
  } else if (obj !== null && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "file_path" && typeof value === "string") obj[key] = name;
      else rewriteFilePaths(value, name);
    }
  }
}

export async function parseToCanonical(fixture: string, language?: string): Promise<string> {
  const text = readFileSync(fixture, "utf8");
  // Snapshots are upstream's output, so compare in upstream-compat mode.
  const graph = await parseSource(fixture, text, language, { upstreamCompat: true });
  const data = QueryEngine.fromGraph(graph).toDict();
  data["root_path"] = basename(fixture);
  rewriteFilePaths(data, basename(fixture));
  return pyJsonDumps(data, 2, true) + "\n";
}

export function fixturePair(language: string, base: string): [string, string] {
  const dir = join(FIXTURE_ROOT, language);
  const sources = readdirSync(dir).filter((f) => f.startsWith(`${base}.`) && !f.endsWith(".expected.json"));
  if (sources.length !== 1) throw new Error(`Expected one fixture for ${language}/${base}, got ${sources}`);
  return [join(dir, sources[0]!), join(dir, `${base}.expected.json`)];
}
