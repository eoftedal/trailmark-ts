/** Port of upstream tests/test_cli_parser.py (argparse surface of the CLI). */

import { describe, expect, it } from "vitest";

import { ArgParseExit, type ArgumentParser } from "../src/argparse.js";
import { buildParser } from "../src/cli.js";
import { version } from "../src/node.js";
import { runCli } from "./cli-helpers.js";

const parser = buildParser();
const subparsers = parser.subparsers();

function sub(name: string): ArgumentParser {
  const p = subparsers.get(name);
  if (p === undefined) throw new Error(`No subparser ${name}`);
  return p;
}

function option(p: ArgumentParser, flag: string) {
  const a = p.action(flag);
  if (a === undefined || a.optionStrings.length === 0) throw new Error(`Option ${flag} not found`);
  return a;
}

function positional(p: ArgumentParser, name: string) {
  const a = p.action(name);
  if (a === undefined || a.optionStrings.length > 0) throw new Error(`Positional ${name} not found`);
  return a;
}

function exitOf(fn: () => unknown): ArgParseExit {
  try {
    fn();
  } catch (e) {
    if (e instanceof ArgParseExit) return e;
    throw e;
  }
  throw new Error("expected ArgParseExit");
}

describe("top-level parser", () => {
  it("prog name", () => expect(parser.prog).toBe("trailmark"));
  it("command dest", () => expect(parser.parseArgs(["version"])["command"]).toBe("version"));
  it("all subcommands registered", () => {
    expect(new Set(subparsers.keys())).toEqual(
      new Set(["analyze", "augment", "entrypoints", "diff", "diagram", "version"]),
    );
  });
});

describe("version flag", () => {
  for (const flag of ["--version", "-V"]) {
    it(`${flag} prints and exits`, () => {
      const e = exitOf(() => parser.parseArgs([flag]));
      expect(e.code).toBe(0);
      expect(e.stdout.trim()).toBe(`trailmark ${version}`);
    });
  }
  it("version subcommand registered", () => expect(subparsers.has("version")).toBe(true));
  it("version subcommand parses", () => expect(parser.parseArgs(["version"])["command"]).toBe("version"));
});

describe("analyze subparser", () => {
  const p = sub("analyze");
  it("path is positional", () => expect(positional(p, "path").optionStrings).toEqual([]));
  it("language default python", () => expect(option(p, "--language").default).toBe("python"));
  it("language has -l", () => expect(option(p, "--language").optionStrings).toContain("-l"));
  it("summary is store_true", () => {
    expect(option(p, "--summary").kind).toBe("store_true");
    expect(option(p, "--summary").default).toBe(false);
  });
  it("summary has -s", () => expect(option(p, "--summary").optionStrings).toContain("-s"));
  it("complexity int default 0", () => {
    expect(option(p, "--complexity").type).toBe("int");
    expect(option(p, "--complexity").default).toBe(0);
  });
  it("complexity has -c", () => expect(option(p, "--complexity").optionStrings).toContain("-c"));
});

describe("diff subparser", () => {
  const p = sub("diff");
  it("positional before and after", () => {
    expect(positional(p, "before")).toBeDefined();
    expect(positional(p, "after")).toBeDefined();
  });
  it("language default python", () => expect(option(p, "--language").default).toBe("python"));
  it("repo defaults to cwd", () => expect(option(p, "--repo").default).toBe("."));
  it("json is store_true", () => {
    expect(option(p, "--json").kind).toBe("store_true");
    expect(option(p, "--json").default).toBe(false);
  });
});

describe("entrypoints subparser", () => {
  const p = sub("entrypoints");
  it("path is positional", () => expect(positional(p, "path").optionStrings).toEqual([]));
  it("language default python", () => expect(option(p, "--language").default).toBe("python"));
  it("json is store_true", () => {
    expect(option(p, "--json").kind).toBe("store_true");
    expect(option(p, "--json").default).toBe(false);
  });
});

describe("augment subparser", () => {
  const p = sub("augment");
  it("path is positional", () => expect(positional(p, "path").optionStrings).toEqual([]));
  it("language default python", () => expect(option(p, "--language").default).toBe("python"));
  it("sarif is repeatable", () => expect(option(p, "--sarif").default).toEqual([]));
  it("weaudit is repeatable", () => expect(option(p, "--weaudit").default).toEqual([]));
  it("json is store_true", () => {
    expect(option(p, "--json").kind).toBe("store_true");
    expect(option(p, "--json").default).toBe(false);
  });
});

describe("diagram subparser", () => {
  const p = sub("diagram");
  it("target required with -t", () => {
    expect(option(p, "--target").required).toBe(true);
    expect(option(p, "--target").optionStrings).toContain("-t");
  });
  it("type required with choices", () => {
    const a = option(p, "--type");
    expect(a.required).toBe(true);
    expect(a.dest).toBe("diagram_type");
    expect(a.optionStrings).toContain("-T");
    expect(a.choices).toContain("call-graph");
  });
  it("language default python", () => expect(option(p, "--language").default).toBe("python"));
  it("depth int default 2", () => {
    expect(option(p, "--depth").type).toBe("int");
    expect(option(p, "--depth").default).toBe(2);
  });
  it("direction default TB", () => {
    expect(option(p, "--direction").default).toBe("TB");
    expect(new Set(option(p, "--direction").choices)).toEqual(new Set(["TB", "LR"]));
  });
});

describe("parse behavior", () => {
  it("analyze path summary", () => {
    const args = parser.parseArgs(["analyze", "scratch-dir", "--summary"]);
    expect(args).toMatchObject({
      command: "analyze",
      path: "scratch-dir",
      summary: true,
      language: "python",
      complexity: 0,
    });
  });
  it("analyze short flags", () => {
    const args = parser.parseArgs(["analyze", "p", "-l", "rust", "-c", "10"]);
    expect(args["language"]).toBe("rust");
    expect(args["complexity"]).toBe(10);
  });
  it("diff positionals", () => {
    expect(parser.parseArgs(["diff", "before/", "after/"])).toMatchObject({
      command: "diff",
      before: "before/",
      after: "after/",
      repo: ".",
      json: false,
    });
  });
  it("entrypoints json flag", () => expect(parser.parseArgs(["entrypoints", "p", "--json"])["json"]).toBe(true));
  it("augment repeatable sarif", () => {
    expect(parser.parseArgs(["augment", "p", "--sarif", "a.sarif", "--sarif", "b.sarif"])["sarif"]).toEqual([
      "a.sarif",
      "b.sarif",
    ]);
  });
  it("diagram target and type", () => {
    expect(parser.parseArgs(["diagram", "-t", "src/", "-T", "call-graph"])).toMatchObject({
      command: "diagram",
      target: "src/",
      diagram_type: "call-graph",
      language: "python",
      direction: "TB",
      depth: 2,
    });
  });
  it("diagram requires type", () => {
    expect(exitOf(() => parser.parseArgs(["diagram", "-t", "src/"])).code).toBe(2);
  });
  it("abbreviated and attached option forms", () => {
    expect(parser.parseArgs(["analyze", "--lang=rust", "--complexity=3", "-s", "p"])).toMatchObject({
      language: "rust",
      complexity: 3,
      summary: true,
    });
    expect(parser.parseArgs(["analyze", "-c3", "-lgo", "p"])).toMatchObject({ language: "go", complexity: 3 });
  });
});

describe("argparse error text", () => {
  it("invalid int", () => {
    const e = exitOf(() => parser.parseArgs(["analyze", "-c", "x", "p"]));
    expect(e.code).toBe(2);
    expect(e.stderr).toBe(
      "usage: trailmark analyze [-h] [--language LANGUAGE] [--summary]\n" +
        "                         [--complexity COMPLEXITY]\n" +
        "                         path\n" +
        "trailmark analyze: error: argument --complexity/-c: invalid int value: 'x'\n",
    );
  });
  it("unrecognized arguments are reported by the top-level parser", () => {
    const e = exitOf(() => parser.parseArgs(["analyze", "p", "--foo", "bar"]));
    expect(e.stderr).toBe(
      "usage: trailmark [-h] [--version]\n" +
        "                 {version,analyze,diff,entrypoints,augment,diagram} ...\n" +
        "trailmark: error: unrecognized arguments: --foo bar\n",
    );
  });
  it("missing option value", () => {
    const e = exitOf(() => parser.parseArgs(["analyze", "p", "--language"]));
    expect(e.stderr.endsWith("trailmark analyze: error: argument --language/-l: expected one argument\n")).toBe(true);
  });
  it("invalid choice", () => {
    const e = exitOf(() => parser.parseArgs(["diagram", "-t", "x", "-T", "call-graph", "--direction", "XX"]));
    expect(e.stderr.endsWith("error: argument --direction: invalid choice: 'XX' (choose from 'TB', 'LR')\n")).toBe(
      true,
    );
  });
  it("diagram help matches argparse", () => {
    const e = exitOf(() => parser.parseArgs(["diagram", "--help"]));
    expect(e.stdout).toBe(
      [
        "usage: trailmark diagram [-h] --target TARGET [--language LANGUAGE]",
        "                         --type {call-graph,class-hierarchy,module-deps,containment,complexity,data-flow}",
        "                         [--focus FOCUS] [--depth DEPTH] [--direction {TB,LR}]",
        "                         [--threshold THRESHOLD]",
        "",
        "options:",
        "  -h, --help            show this help message and exit",
        "  --target, -t TARGET   Directory to analyze",
        "  --language, -l LANGUAGE",
        "                        Source language",
        "  --type, -T {call-graph,class-hierarchy,module-deps,containment,complexity,data-flow}",
        "                        Diagram type",
        "  --focus, -f FOCUS     Focus node name",
        "  --depth, -d DEPTH     BFS depth",
        "  --direction {TB,LR}   Layout direction",
        "  --threshold THRESHOLD",
        "                        Complexity threshold",
        "",
      ].join("\n"),
    );
  });
  it("diff help wraps long help text", () => {
    const e = exitOf(() => parser.parseArgs(["diff", "-h"]));
    expect(e.stdout).toContain(
      "  --repo REPO           Repository root used to resolve git refs (default:\n" +
        "                        cwd). Ignored when BEFORE and AFTER are directory\n" +
        "                        paths.\n",
    );
  });
});

describe("version subcommand execution", () => {
  it("main version prints version", async () => {
    const r = await runCli(["version"]);
    expect(r.stdout.trim()).toBe(`trailmark ${version}`);
    expect(r.code).toBe(0);
  });
});
