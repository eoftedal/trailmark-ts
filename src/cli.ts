#!/usr/bin/env node
/** Trailmark CLI entry point (port of ``cli.py``). Node-only. */

import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { formatDiff } from "./analysis/diff.js";
import { ArgParseExit, ArgumentParser, SUPPRESS, type Namespace } from "./argparse.js";
import { addDiagramArguments, DiagramError, diagramOptionsFromArgs, renderDiagram } from "./diagram.js";
import { withGitWorktree } from "./git-worktree.js";
import { engineFromPath } from "./node.js";
import type { JsonObject } from "./query/dicts.js";
import type { QueryEngine } from "./query/api.js";
import { pyJsonDumps } from "./util/py.js";
import { version } from "./version.js";

const VERSION_STRING = `trailmark ${version}`;

/** Output sinks for ``main``; injectable so tests can run the CLI in-process. */
export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Terminal width used for help text (argparse uses ``COLUMNS``, default 80). */
  columns?: number;
}

function defaultColumns(): number {
  const env = Number.parseInt(process.env["COLUMNS"] ?? "", 10);
  if (env > 0) return env;
  return process.stdout.columns || 80;
}

export const processIO: CliIO = {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
};

/** Construct the Trailmark CLI's argument parser tree. */
export function buildParser(columns = 80): ArgumentParser {
  const parser = new ArgumentParser({
    prog: "trailmark",
    description: `Parse source code into queryable graphs (v${version})`,
    columns,
  });
  parser.addArgument(["--version", "-V"], { action: "version", version: VERSION_STRING });
  const addParser = parser.addSubparsers({ dest: "command" });

  addParser("version", { help: "Print the Trailmark version and exit" });

  const analyze = addParser("analyze", { help: "Analyze a directory and output the code graph" });
  analyze.addArgument("path", { help: "Directory to analyze" });
  analyze.addArgument(["--language", "-l"], { default: "python", help: "Source language (default: python)" });
  analyze.addArgument(["--summary", "-s"], { action: "store_true", help: "Print summary instead of full graph" });
  analyze.addArgument(["--complexity", "-c"], {
    type: "int",
    default: 0,
    help: "Show functions with complexity >= threshold",
  });

  const diffCmd = addParser("diff", { help: "Structural diff between two code graphs" });
  diffCmd.addArgument("before", { help: "Path or git ref for the 'before' snapshot" });
  diffCmd.addArgument("after", { help: "Path or git ref for the 'after' snapshot" });
  diffCmd.addArgument(["--language", "-l"], { default: "python", help: "Source language (default: python)" });
  diffCmd.addArgument("--repo", {
    default: ".",
    help:
      "Repository root used to resolve git refs (default: cwd). " +
      "Ignored when BEFORE and AFTER are directory paths.",
  });
  diffCmd.addArgument("--json", {
    action: "store_true",
    help: "Emit the structured diff as JSON instead of a report",
  });

  const entrypoints = addParser("entrypoints", {
    help: "List detected entrypoints and their trust classification",
  });
  entrypoints.addArgument("path", { help: "Directory to analyze" });
  entrypoints.addArgument(["--language", "-l"], { default: "python", help: "Source language (default: python)" });
  entrypoints.addArgument("--json", {
    action: "store_true",
    help: "Emit entrypoints as JSON instead of a human-readable list",
  });

  const augment = addParser("augment", { help: "Augment a code graph with SARIF or weAudit findings" });
  augment.addArgument("path", { help: "Directory to analyze" });
  augment.addArgument(["--language", "-l"], { default: "python", help: "Source language (default: python)" });
  augment.addArgument("--sarif", {
    action: "append",
    default: [],
    help: "SARIF file(s) to augment with (repeatable)",
  });
  augment.addArgument("--weaudit", {
    action: "append",
    default: [],
    help: "weAudit file(s) to augment with (repeatable)",
  });
  augment.addArgument("--json", { action: "store_true", help: "Output full augmented graph as JSON" });

  const diagram = addParser("diagram", { help: "Generate a Mermaid diagram from the code graph" });
  addDiagramArguments(diagram);

  // Not in upstream (hidden so --help stays identical): reproduce upstream output exactly.
  for (const sub of [analyze, diffCmd, entrypoints, augment, diagram]) {
    sub.addArgument("--upstream-compat", { action: "store_true", help: SUPPRESS });
  }

  return parser;
}

/** Run the Trailmark CLI; resolves to the process exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2), io: CliIO = processIO): Promise<number> {
  const parser = buildParser(io.columns ?? defaultColumns());
  const print = (text = "") => io.stdout(text + "\n");
  let args: Namespace;
  try {
    args = parser.parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgParseExit) {
      if (err.stdout) io.stdout(err.stdout);
      if (err.stderr) io.stderr(err.stderr);
      return err.code;
    }
    throw err;
  }

  if (args["command"] === null) {
    io.stdout(parser.formatHelp());
    return 1;
  }
  upstreamCompat = args["upstream_compat"] === true || envUpstreamCompat();

  try {
    switch (args["command"]) {
      case "version":
        print(VERSION_STRING);
        break;
      case "analyze":
        await runAnalyze(args, print);
        break;
      case "augment":
        await runAugment(args, print);
        break;
      case "entrypoints":
        await runEntrypoints(args, print);
        break;
      case "diff":
        await runDiff(args, print);
        break;
      case "diagram":
        await runDiagram(args, io);
        break;
    }
  } catch (err) {
    if (err instanceof DiagramError) {
      io.stderr(err.message + "\n");
      return err.exitCode;
    }
    // Upstream lets the exception escape (traceback, exit status 1).
    const e = err instanceof Error ? err : new Error(String(err));
    io.stderr(`${e.name}: ${e.message}\n`);
    return 1;
  }
  return 0;
}

type Print = (text?: string) => void;

function str(args: Namespace, key: string): string {
  return args[key] as string;
}

/**
 * ``--upstream-compat`` / ``TRAILMARK_UPSTREAM_COMPAT=1``: skip analyses that go
 * beyond upstream (receiver-type call resolution) for byte-identical output.
 * Set per ``main`` invocation; commands run one at a time.
 */
let upstreamCompat = false;

function envUpstreamCompat(): boolean {
  const v = typeof process !== "undefined" ? process.env["TRAILMARK_UPSTREAM_COMPAT"] : undefined;
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

function fromDirectory(path: string, language: string): Promise<QueryEngine> {
  return engineFromPath(path, { language, upstreamCompat });
}

/** Execute the analyze subcommand. */
async function runAnalyze(args: Namespace, print: Print): Promise<void> {
  const engine = await fromDirectory(str(args, "path"), str(args, "language"));
  const complexity = args["complexity"] as number;
  if (args["summary"]) printSummary(engine, print);
  else if (complexity > 0) printComplexity(engine, complexity, print);
  else print(engine.toJson());
}

/** Print a graph summary. */
function printSummary(engine: QueryEngine, print: Print): void {
  const summary = engine.summary();
  print(`Nodes: ${summary["total_nodes"]}`);
  print(`  Functions: ${summary["functions"]}`);
  print(`  Classes: ${summary["classes"]}`);
  print(`  Proxies: ${summary["proxies"]}`);
  print(`Call edges: ${summary["call_edges"]}`);
  print(`Dependencies: ${(summary["dependencies"] as string[]).join(", ")}`);
  print(`Entrypoints: ${summary["entrypoints"]}`);
}

/** Print complexity hotspots. */
function printComplexity(engine: QueryEngine, threshold: number, print: Print): void {
  const hotspots = engine.complexityHotspots(threshold);
  if (hotspots.length === 0) {
    print(`No functions with complexity >= ${threshold}`);
    return;
  }
  for (const h of hotspots) {
    const loc = h["location"] as JsonObject;
    print(`  ${h["id"]}  complexity=${h["cyclomatic_complexity"]}  ${loc["file_path"]}:${loc["start_line"]}`);
  }
}

/** Execute the augment subcommand. */
async function runAugment(args: Namespace, print: Print): Promise<void> {
  const engine = await fromDirectory(str(args, "path"), str(args, "language"));

  for (const sarifPath of args["sarif"] as string[]) {
    const result = engine.augmentSarif(await readFile(sarifPath, "utf8"));
    printAugmentResult("SARIF", sarifPath, result, print);
  }

  for (const weauditPath of args["weaudit"] as string[]) {
    const result = engine.augmentWeaudit(await readFile(weauditPath, "utf8"));
    printAugmentResult("weAudit", weauditPath, result, print);
  }

  if (args["json"]) print(engine.toJson());
}

/** Execute the diagram subcommand. */
async function runDiagram(args: Namespace, io: CliIO): Promise<void> {
  const engine = await fromDirectory(str(args, "target"), str(args, "language"));
  const warn = (line: string) => io.stderr(line + "\n");
  io.stdout(renderDiagram(engine, diagramOptionsFromArgs(args), warn) + "\n");
}

/** Print a summary of an augmentation result. */
function printAugmentResult(label: string, path: string, result: JsonObject, print: Print): void {
  print(`${label}: ${path}`);
  print(`  Matched: ${result["matched_findings"]}`);
  print(`  Unmatched: ${result["unmatched_findings"]}`);
  const subgraphs = (result["subgraphs_created"] ?? []) as unknown[];
  if (subgraphs.length > 0) print(`  Subgraphs: ${subgraphs.map(String).join(", ")}`);
}

/** Execute the entrypoints subcommand. */
async function runEntrypoints(args: Namespace, print: Print): Promise<void> {
  const engine = await fromDirectory(str(args, "path"), str(args, "language"));
  const surface = engine.attackSurface();

  if (args["json"]) {
    print(pyJsonDumps(surface, 2));
    return;
  }

  if (surface.length === 0) {
    print("No entrypoints detected.");
    print("Hint: declare entrypoints manually in .trailmark/entrypoints.toml");
    return;
  }

  print(`${surface.length} entrypoint(s) detected:`);
  for (const ep of surface) {
    print(`  ${ep["node_id"]}  kind=${ep["kind"]}  trust=${ep["trust_level"]}  asset=${ep["asset_value"]}`);
    if (ep["description"]) print(`    ${ep["description"]}`);
  }
}

/** Execute the diff subcommand. */
async function runDiff(args: Namespace, print: Print): Promise<void> {
  const language = str(args, "language");
  const repo = str(args, "repo");
  const beforeEngine = await loadDiffSide(str(args, "before"), language, repo);
  const afterEngine = await loadDiffSide(str(args, "after"), language, repo);
  const diff = afterEngine.diffAgainst(beforeEngine);

  if (args["json"]) {
    print(pyJsonDumps(diff, 2));
    return;
  }
  print(formatDiff(diff));
}

/** Build a QueryEngine for a path or git ref. */
async function loadDiffSide(side: string, language: string, repo: string): Promise<QueryEngine> {
  const candidate = pyPathStr(side);
  if (existsSync(candidate) && statSync(candidate).isDirectory()) return fromDirectory(candidate, language);
  return withGitWorktree(repo, side, (worktree) => fromDirectory(worktree, language));
}

/** ``str(pathlib.PurePosixPath(p))``: collapse ``//`` and ``.`` parts, drop trailing ``/``. */
export function pyPathStr(p: string): string {
  if (p === "") return ".";
  const lead = p.startsWith("//") && !p.startsWith("///") ? "//" : p.startsWith("/") ? "/" : "";
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  const body = parts.join("/");
  return lead + body || ".";
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
