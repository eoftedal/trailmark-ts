/** Port of upstream tests/test_cli.py. */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli, useTmpPath } from "./cli-helpers.js";

const tmpPath = useTmpPath();

function write(dir: string, name: string, text: string): void {
  writeFileSync(join(dir, name), text);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

describe("main with no args", () => {
  it("prints help and exits 1", async () => {
    expect((await runCli([])).code).toBe(1);
  });

  it("shows usage", async () => {
    const { stdout } = await runCli([]);
    expect(stdout).toContain("trailmark");
    expect(stdout).toContain("analyze");
  });

  it("unknown command exits", async () => {
    const r = await runCli(["notanalyze"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("trailmark: error: argument command: invalid choice: 'notanalyze'");
  });
});

describe("help text", () => {
  it("prog name", async () => {
    const r = await runCli(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("trailmark");
  });

  it("description", async () => {
    expect((await runCli(["--help"])).stdout).toContain("queryable graphs");
  });

  it("analyze help", async () => {
    const { stdout } = await runCli(["analyze", "--help"]);
    expect(stdout).toContain("Directory to analyze");
    expect(stdout).toContain("python");
    expect(stdout.toLowerCase()).toContain("summary");
    expect(stdout.toLowerCase()).toContain("complexity");
  });

  it("analyze argument aliases", async () => {
    const { stdout } = await runCli(["analyze", "--help"]);
    expect(stdout).toContain("-l");
    expect(stdout).toContain("-s");
    expect(stdout).toContain("-c");
  });
});

describe("analyze command", () => {
  it("JSON output", async () => {
    const dir = tmpPath();
    write(dir, "hello.py", "def greet():\n    return 'hi'\n");
    const data = JSON.parse((await runCli(["analyze", dir])).stdout);
    expect(data.language).toBe("python");
    expect(data).toHaveProperty("nodes");
    expect(data).toHaveProperty("edges");
    expect(data).toHaveProperty("summary");
    expect(data.root_path).toBe(dir);
    const names = Object.values(data.nodes as Record<string, { name: string }>).map((n) => n.name);
    expect(names).toContain("greet");
  });

  it("JSON full structure", async () => {
    const dir = tmpPath();
    write(dir, "a.py", "def f():\n    pass\n");
    const data = JSON.parse((await runCli(["analyze", dir])).stdout);
    expect(new Set(Object.keys(data))).toEqual(
      new Set(["language", "root_path", "summary", "nodes", "edges", "subgraphs"]),
    );
    expect(new Set(Object.keys(data.summary))).toEqual(
      new Set(["total_nodes", "functions", "classes", "proxies", "call_edges", "dependencies", "entrypoints"]),
    );
    expect(Array.isArray(data.nodes)).toBe(false);
    expect(typeof data.nodes).toBe("object");
    expect(Array.isArray(data.edges)).toBe(true);
  });

  it("summary exact format", async () => {
    const dir = tmpPath();
    write(dir, "app.py", "class Foo:\n    pass\n\ndef bar():\n    pass\n");
    const lines = (await runCli(["analyze", dir, "--summary"])).stdout.trim().split("\n");
    expect(lines).toEqual([
      "Nodes: 3",
      "  Functions: 1",
      "  Classes: 1",
      "  Proxies: 0",
      "Call edges: 0",
      "Dependencies: ",
      "Entrypoints: 0",
    ]);
  });

  it("summary with dependencies", async () => {
    const dir = tmpPath();
    write(dir, "app.py", "import os\nfrom pathlib import Path\n");
    const lines = (await runCli(["analyze", dir, "--summary"])).stdout.trim().split("\n");
    const depLine = lines[5]!;
    expect(depLine.startsWith("Dependencies: ")).toBe(true);
    expect(depLine).toContain("os");
    expect(depLine).toContain("pathlib");
  });

  it("summary line prefixes", async () => {
    const dir = tmpPath();
    write(dir, "x.py", "def f(): pass\n");
    const lines = (await runCli(["analyze", dir, "--summary"])).stdout.trim().split("\n");
    const prefixes = [
      "Nodes: ",
      "  Functions: ",
      "  Classes: ",
      "  Proxies: ",
      "Call edges: ",
      "Dependencies: ",
      "Entrypoints: ",
    ];
    prefixes.forEach((p, i) => expect(lines[i]!.startsWith(p)).toBe(true));
  });

  it("summary short flag", async () => {
    const dir = tmpPath();
    write(dir, "s.py", "def f():\n    pass\n");
    const { stdout } = await runCli(["analyze", dir, "-s"]);
    expect(stdout).toContain("Nodes:");
    expect(stdout).toContain("Functions:");
    expect(stdout).toContain("Classes:");
  });

  it("complexity exact output", async () => {
    const dir = tmpPath();
    write(
      dir,
      "complex.py",
      "def branchy(x):\n" +
        "    if x > 0:\n" +
        "        if x > 10:\n" +
        "            return 1\n" +
        "        elif x > 5:\n" +
        "            return 2\n" +
        "    return 0\n",
    );
    const { stdout } = await runCli(["analyze", dir, "--complexity", "2"]);
    expect(stdout).toContain("complexity=");
    expect(stdout).toContain("branchy");
    expect(stdout).toContain("complex.py:");
    const lines = stdout.split("\n").filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    for (const line of lines) {
      expect(line.startsWith("  ")).toBe(true);
      expect(line).toContain("complexity=");
      expect(line.trim().split("  ")).toHaveLength(3);
    }
  });

  it("complexity short flag", async () => {
    const dir = tmpPath();
    write(dir, "c.py", "def f(x):\n    if x: return 1\n    return 0\n");
    expect((await runCli(["analyze", dir, "-c", "1"])).stdout).toContain("complexity=");
  });

  it("complexity no hotspots", async () => {
    const dir = tmpPath();
    write(dir, "simple.py", "def noop():\n    pass\n");
    const { stdout } = await runCli(["analyze", dir, "--complexity", "100"]);
    expect(stdout.trim()).toBe("No functions with complexity >= 100");
  });

  it("default language is python", async () => {
    const dir = tmpPath();
    write(dir, "m.py", "x = 1\n");
    expect(JSON.parse((await runCli(["analyze", dir])).stdout).language).toBe("python");
  });

  it("explicit language flag", async () => {
    const dir = tmpPath();
    write(dir, "x.py", "y = 1\n");
    expect(JSON.parse((await runCli(["analyze", dir, "--language", "python"])).stdout).language).toBe("python");
  });

  it("language short flag", async () => {
    const dir = tmpPath();
    write(dir, "z.py", "z = 1\n");
    expect(JSON.parse((await runCli(["analyze", dir, "-l", "python"])).stdout).language).toBe("python");
  });

  it("summary takes priority over JSON", async () => {
    const dir = tmpPath();
    write(dir, "t.py", "def t(): pass\n");
    const { stdout } = await runCli(["analyze", dir, "--summary"]);
    expect(isJson(stdout)).toBe(false);
    expect(stdout).toContain("Nodes:");
  });

  it("complexity takes priority over JSON", async () => {
    const dir = tmpPath();
    write(dir, "t2.py", "def f(x):\n    if x: return 1\n    return 0\n");
    expect(isJson((await runCli(["analyze", dir, "--complexity", "1"])).stdout)).toBe(false);
  });

  it("path argument passed", async () => {
    const dir = tmpPath();
    write(dir, "p.py", "def p(): pass\n");
    expect(JSON.parse((await runCli(["analyze", dir])).stdout).root_path).toBe(dir);
  });

  it("complexity zero means JSON", async () => {
    const dir = tmpPath();
    write(dir, "c0.py", "def f(): pass\n");
    expect(JSON.parse((await runCli(["analyze", dir])).stdout)).toHaveProperty("nodes");
  });

  it("complexity one not JSON", async () => {
    const dir = tmpPath();
    write(dir, "c1.py", "def f(x):\n    if x: return 1\n    return 0\n");
    const { stdout } = await runCli(["analyze", dir, "-c", "1"]);
    expect(stdout).toContain("complexity=");
    expect(isJson(stdout)).toBe(false);
  });

  it("unsupported language reports error with exit 1", async () => {
    const r = await runCli(["analyze", tmpPath(), "-l", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Unsupported language: nope");
  });
});

describe("diagram command", () => {
  function writeCallChain(dir: string): void {
    write(dir, "app.py", "def helper():\n    return 1\n\ndef main():\n    return helper()\n");
  }

  it("call graph emits flowchart", async () => {
    const dir = tmpPath();
    writeCallChain(dir);
    const { stdout } = await runCli(["diagram", "-t", dir, "-T", "call-graph"]);
    expect(stdout.startsWith("flowchart TB")).toBe(true);
    expect(stdout).toContain("helper");
  });

  it("direction flag changes header", async () => {
    const dir = tmpPath();
    writeCallChain(dir);
    const { stdout } = await runCli(["diagram", "-t", dir, "-T", "call-graph", "--direction", "LR"]);
    expect(stdout.startsWith("flowchart LR")).toBe(true);
  });

  it("missing type exits", async () => {
    const r = await runCli(["diagram", "-t", tmpPath()]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("the following arguments are required: --type/-T");
  });

  it("unknown focus exits 1 with suggestions", async () => {
    const dir = tmpPath();
    writeCallChain(dir);
    const r = await runCli(["diagram", "-t", dir, "-T", "call-graph", "-f", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("Error: node 'nope' not found.\nAvailable: app, helper, main\n");
  });
});

describe("diff command", () => {
  it("reports no changes for identical directories", async () => {
    const dir = tmpPath();
    write(dir, "a.py", "def f():\n    pass\n");
    const r = await runCli(["diff", dir, dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("No structural changes.\n");
  });

  it("emits JSON diff", async () => {
    const before = tmpPath();
    const after = tmpPath();
    write(before, "a.py", "def f():\n    pass\n");
    write(after, "a.py", "def f():\n    pass\n\ndef g():\n    return f()\n");
    const data = JSON.parse((await runCli(["diff", before, after, "--json"])).stdout);
    expect(Object.keys(data)).toEqual(["summary_delta", "nodes", "edges", "entrypoints"]);
  });

  it("non-directory side outside a git repo fails", async () => {
    const r = await runCli(["diff", "no-such-before", "no-such-after", "--repo", tmpPath()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Not a git repository");
  });
});
