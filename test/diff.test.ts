/** Tests for structural diff between two code graphs (port of tests/test_diff.py). */

import { describe, expect, it } from "vitest";
import { computeDiff, formatDiff } from "../src/analysis/diff.js";
import { MemoryFileSource } from "../src/fs/source.js";
import type { CodeGraph } from "../src/models/graph.js";
import type { Json, JsonObject } from "../src/query/dicts.js";
import { QueryEngine } from "../src/query/api.js";

async function build(root: string, files: Record<string, string>): Promise<QueryEngine> {
  return QueryEngine.fromSource(new MemoryFileSource(root, files), { language: "python" });
}

async function graphs(before: Record<string, string>, after: Record<string, string>): Promise<[CodeGraph, CodeGraph]> {
  return [(await build("/before", before)).graph, (await build("/after", after)).graph];
}

const section = (d: JsonObject, a: string, b: string) => (d[a] as JsonObject)[b] as JsonObject[];

describe("node diff", () => {
  it("added node shows up", async () => {
    const diff = computeDiff(
      ...(await graphs(
        { "app.py": "def existing():\n    pass\n" },
        { "app.py": "def existing():\n    pass\n\ndef new_function():\n    pass\n" },
      )),
    );
    expect(section(diff, "nodes", "added").map((n) => n["id"])).toContain("app:new_function");
  });

  it("removed node shows up", async () => {
    const diff = computeDiff(
      ...(await graphs(
        { "app.py": "def keep():\n    pass\n\ndef doomed():\n    pass\n" },
        { "app.py": "def keep():\n    pass\n" },
      )),
    );
    expect(section(diff, "nodes", "removed").map((n) => n["id"])).toContain("app:doomed");
  });

  it("complexity change is flagged", async () => {
    const diff = computeDiff(
      ...(await graphs(
        { "app.py": "def f(x):\n    return x\n" },
        {
          "app.py":
            "def f(x):\n    if x > 0:\n        if x > 10:\n            return 2\n        return 1\n    return 0\n",
        },
      )),
    );
    const modified = new Map(section(diff, "nodes", "modified").map((m) => [m["id"], m]));
    const changes = modified.get("app:f")!["changes"] as JsonObject;
    expect(changes).toHaveProperty("cyclomatic_complexity");
    const cc = changes["cyclomatic_complexity"] as JsonObject;
    expect(cc["after"] as number).toBeGreaterThan(cc["before"] as number);
  });

  it("parameter change is flagged", async () => {
    const diff = computeDiff(
      ...(await graphs({ "app.py": "def f(x):\n    pass\n" }, { "app.py": "def f(x, y, z):\n    pass\n" })),
    );
    const modified = new Map(section(diff, "nodes", "modified").map((m) => [m["id"], m]));
    const changes = modified.get("app:f")!["changes"] as JsonObject;
    expect((changes["parameters"] as JsonObject)["after"]).toEqual(["x", "y", "z"]);
  });
});

describe("edge diff", () => {
  it("new call edge detected", async () => {
    const diff = computeDiff(
      ...(await graphs(
        { "app.py": "def main():\n    pass\n\ndef helper():\n    return 1\n" },
        { "app.py": "def main():\n    return helper()\n\ndef helper():\n    return 1\n" },
      )),
    );
    expect(section(diff, "edges", "added")).toContainEqual({ source: "app:main", target: "app:helper", kind: "calls" });
  });
});

describe("entrypoint diff", () => {
  it("new entrypoint tracked", async () => {
    const diff = computeDiff(
      ...(await graphs(
        { "app.py": "def helper():\n    pass\n" },
        {
          "app.py":
            "from flask import Flask\napp = Flask(__name__)\n\n@app.route('/login')\ndef login():\n    return 'ok'\n",
        },
      )),
    );
    const login = section(diff, "entrypoints", "added").find((ep) => ep["id"] === "app:login");
    expect(login).toBeDefined();
    expect(login!["kind"]).toBe("api");
    expect(login!["trust_level"]).toBe("untrusted_external");
  });

  it("removed entrypoint tracked", async () => {
    const diff = computeDiff(
      ...(await graphs(
        {
          "app.py":
            "from flask import Flask\napp = Flask(__name__)\n\n@app.route('/old')\ndef old():\n    return 'ok'\n",
        },
        { "app.py": "from flask import Flask\napp = Flask(__name__)\n\ndef old():\n    return 'ok'\n" },
      )),
    );
    expect(section(diff, "entrypoints", "removed").map((ep) => ep["id"])).toContain("app:old");
  });

  it("trust level change detected", async () => {
    const svc = "def dispatch(req):\n    return req\n";
    const toml = (trust: string, asset: string) =>
      `[[entrypoint]]\nnode = "svc:dispatch"\nkind = "api"\ntrust = "${trust}"\nasset_value = "${asset}"\n`;
    const diff = computeDiff(
      ...(await graphs(
        { "svc.py": svc, ".trailmark/entrypoints.toml": toml("semi_trusted_external", "low") },
        { "svc.py": svc, ".trailmark/entrypoints.toml": toml("untrusted_external", "high") },
      )),
    );
    const mod = section(diff, "entrypoints", "modified").find((m) => m["id"] === "svc:dispatch");
    expect(mod).toBeDefined();
    expect((mod!["before"] as JsonObject)["trust_level"]).toBe("semi_trusted_external");
    expect((mod!["after"] as JsonObject)["trust_level"]).toBe("untrusted_external");
  });
});

describe("QueryEngine integration", () => {
  it("diffAgainst method", async () => {
    const before = await build("/before", { "app.py": "def a():\n    pass\n" });
    const after = await build("/after", { "app.py": "def a():\n    pass\n\ndef b():\n    pass\n" });
    expect(section(after.diffAgainst(before), "nodes", "added").map((n) => n["id"])).toContain("app:b");
  });

  it("matches upstream output exactly", async () => {
    const before = await build("/before", { "app.py": "def a(x):\n    pass\n\ndef gone():\n    pass\n" });
    const after = await build("/after", {
      "app.py":
        "from flask import Flask\napp = Flask(__name__)\n\ndef a(x, y):\n    if x:\n        return b()\n    return 0\n\n" +
        "@app.route('/b')\ndef b():\n    pass\n",
    });
    const diff = after.diffAgainst(before);
    // Generated with upstream trailmark (paths rewritten to /before and /after).
    expect(JSON.stringify(diff)).toBe(
      JSON.stringify({
        summary_delta: { edges: { before: 2, after: 3, delta: 1 }, entrypoints: { before: 0, after: 1, delta: 1 } },
        nodes: {
          added: [{ id: "app:b", name: "b", kind: "function", file: "/after/app.py", cyclomatic_complexity: 1 }],
          removed: [
            { id: "app:gone", name: "gone", kind: "function", file: "/before/app.py", cyclomatic_complexity: 1 },
          ],
          modified: [
            { id: "app", changes: { line_span: { before: 6, after: 12 } } },
            {
              id: "app:a",
              changes: {
                cyclomatic_complexity: { before: 1, after: 2 },
                parameters: { before: ["x"], after: ["x", "y"] },
                line_span: { before: 2, after: 4 },
              },
            },
          ],
        },
        edges: {
          added: [
            { source: "app:a", target: "app:b", kind: "calls" },
            { source: "app", target: "app:b", kind: "contains" },
          ],
          removed: [{ source: "app", target: "app:gone", kind: "contains" }],
        },
        entrypoints: {
          added: [
            {
              id: "app:b",
              kind: "api",
              trust_level: "untrusted_external",
              asset_value: "high",
              description: "Python HTTP route decorator",
            },
          ],
          removed: [],
          modified: [],
        },
      }),
    );
    expect(formatDiff(diff)).toBe(
      "Summary:\n  edges: 2 -> 3 (+1)\n  entrypoints: 0 -> 1 (+1)\n\nAdded nodes (1):\n  + app:b  (function, /after/app.py)\n\n" +
        "Removed nodes (1):\n  - app:gone  (function, /before/app.py)\n\nModified nodes (2):\n  ~ app  (line_span)\n" +
        "  ~ app:a  (cyclomatic_complexity, parameters, line_span)\n      complexity: 1 -> 2\n\n" +
        "Attack surface:\n  + entrypoint app:b  (api, trust=untrusted_external, asset=high)\n\nEdges: +2  -1",
    );
  });
});

function emptyDiff(overrides: { [key: string]: Json } = {}): JsonObject {
  return {
    summary_delta: {},
    nodes: { added: [], removed: [], modified: [] },
    edges: { added: [], removed: [] },
    entrypoints: { added: [], removed: [], modified: [] },
    ...overrides,
  };
}

const nodesOf = (o: Partial<Record<"added" | "removed" | "modified", Json[]>>): Json => ({
  added: [],
  removed: [],
  modified: [],
  ...o,
});
const epsOf = nodesOf;

describe("formatDiff", () => {
  it("empty diff returns no changes", () => {
    expect(formatDiff({})).toBe("No structural changes.");
  });

  it("empty dict with no changes returns no changes", () => {
    expect(formatDiff(emptyDiff())).toBe("No structural changes.");
  });

  it("summary header present", () => {
    expect(formatDiff(emptyDiff({ summary_delta: { nodes: { before: 1, after: 2, delta: 1 } } }))).toContain(
      "Summary:",
    );
  });

  it("summary renders each metric", () => {
    const out = formatDiff(
      emptyDiff({
        summary_delta: {
          nodes: { before: 10, after: 12, delta: 2 },
          edges: { before: 5, after: 3, delta: -2 },
          entrypoints: { before: 0, after: 4, delta: 4 },
        },
      }),
    );
    expect(out).toContain("nodes: 10 -> 12 (+2)");
    expect(out).toContain("edges: 5 -> 3 (-2)");
    expect(out).toContain("entrypoints: 0 -> 4 (+4)");
  });

  it("positive delta gets plus sign", () => {
    expect(formatDiff(emptyDiff({ summary_delta: { nodes: { before: 1, after: 3, delta: 2 } } }))).toContain("(+2)");
  });

  it("zero delta still shown with plus", () => {
    expect(formatDiff(emptyDiff({ summary_delta: { nodes: { before: 5, after: 5, delta: 0 } } }))).toContain("(+0)");
  });

  it("negative delta has no extra plus", () => {
    const out = formatDiff(emptyDiff({ summary_delta: { nodes: { before: 5, after: 3, delta: -2 } } }));
    expect(out).toContain("(-2)");
    expect(out).not.toContain("(+-2)");
  });

  it("added nodes section", () => {
    const out = formatDiff(
      emptyDiff({ nodes: nodesOf({ added: [{ id: "mod:new", kind: "function", file: "mod.py" }] }) }),
    );
    expect(out).toContain("Added nodes (1):");
    expect(out).toContain("+ mod:new  (function, mod.py)");
  });

  it("removed nodes section", () => {
    const out = formatDiff(
      emptyDiff({ nodes: nodesOf({ removed: [{ id: "mod:gone", kind: "method", file: "old.py" }] }) }),
    );
    expect(out).toContain("Removed nodes (1):");
    expect(out).toContain("- mod:gone  (method, old.py)");
  });

  it("modified nodes section with complexity", () => {
    const out = formatDiff(
      emptyDiff({
        nodes: nodesOf({
          modified: [{ id: "mod:grew", changes: { cyclomatic_complexity: { before: 2, after: 9 } } }],
        }),
      }),
    );
    expect(out).toContain("Modified nodes (1):");
    expect(out).toContain("~ mod:grew  (cyclomatic_complexity)");
    expect(out).toContain("complexity: 2 -> 9");
  });

  it("modified nodes truncates after twenty", () => {
    const modified = Array.from({ length: 25 }, (_, i) => ({
      id: `mod:n${i}`,
      changes: { parameters: { before: [], after: [] } },
    }));
    const out = formatDiff(emptyDiff({ nodes: nodesOf({ modified }) }));
    expect(out).toContain("Modified nodes (25):");
    expect(out).toContain("... and 5 more");
    expect(out).toContain("~ mod:n19  ");
    expect(out).not.toContain("~ mod:n20  ");
  });

  it("added nodes truncates after twenty", () => {
    const added = Array.from({ length: 22 }, (_, i) => ({ id: `mod:a${i}`, kind: "function", file: "f.py" }));
    const out = formatDiff(emptyDiff({ nodes: nodesOf({ added }) }));
    expect(out).toContain("Added nodes (22):");
    expect(out).toContain("... and 2 more");
  });

  it("entrypoint added section", () => {
    const out = formatDiff(
      emptyDiff({
        entrypoints: epsOf({
          added: [{ id: "app:login", kind: "api", trust_level: "untrusted_external", asset_value: "high" }],
        }),
      }),
    );
    expect(out).toContain("Attack surface:");
    expect(out).toContain("+ entrypoint app:login  (api, trust=untrusted_external, asset=high)");
  });

  it("entrypoint removed section", () => {
    const out = formatDiff(
      emptyDiff({
        entrypoints: epsOf({
          removed: [{ id: "app:old", kind: "user_input", trust_level: "trusted_internal", asset_value: "low" }],
        }),
      }),
    );
    expect(out).toContain("Attack surface:");
    expect(out).toContain("- entrypoint app:old  (user_input, trust=trusted_internal, asset=low)");
  });

  it("entrypoint modified trust change", () => {
    const out = formatDiff(
      emptyDiff({
        entrypoints: epsOf({
          modified: [
            {
              id: "svc:dispatch",
              before: { kind: "api", trust_level: "semi_trusted_external", asset_value: "low" },
              after: { kind: "api", trust_level: "untrusted_external", asset_value: "low" },
            },
          ],
        }),
      }),
    );
    expect(out).toContain("~ entrypoint svc:dispatch");
    expect(out).toContain("trust: semi_trusted_external -> untrusted_external");
    expect(out).not.toContain("asset:");
  });

  it("entrypoint modified asset change", () => {
    const out = formatDiff(
      emptyDiff({
        entrypoints: epsOf({
          modified: [
            {
              id: "svc:upgrade",
              before: { kind: "api", trust_level: "untrusted_external", asset_value: "low" },
              after: { kind: "api", trust_level: "untrusted_external", asset_value: "high" },
            },
          ],
        }),
      }),
    );
    expect(out).toContain("asset: low -> high");
    expect(out).not.toContain("trust:");
  });

  it("edges count line", () => {
    const out = formatDiff(
      emptyDiff({
        edges: {
          added: [
            { source: "a", target: "b", kind: "calls" },
            { source: "a", target: "c", kind: "calls" },
          ],
          removed: [{ source: "x", target: "y", kind: "calls" }],
        },
      }),
    );
    expect(out).toContain("Edges: +2  -1");
  });

  it("output has no trailing whitespace", () => {
    const out = formatDiff(emptyDiff({ summary_delta: { nodes: { before: 1, after: 2, delta: 1 } } }));
    expect(out).toBe(out.trimEnd());
    expect(out.endsWith("\n")).toBe(false);
  });

  it("full output exact match", () => {
    const diff: JsonObject = {
      summary_delta: {
        nodes: { before: 10, after: 12, delta: 2 },
        edges: { before: 5, after: 3, delta: -2 },
        entrypoints: { before: 0, after: 1, delta: 1 },
      },
      nodes: {
        added: [{ id: "mod:f", kind: "function", file: "f.py" }],
        removed: [{ id: "mod:g", kind: "function", file: "g.py" }],
        modified: [
          {
            id: "mod:h",
            changes: { cyclomatic_complexity: { before: 3, after: 7 }, parameters: { before: 1, after: 2 } },
          },
        ],
      },
      edges: {
        added: [
          { source: "mod:a", target: "mod:b", kind: "calls" },
          { source: "mod:a", target: "mod:c", kind: "calls" },
        ],
        removed: [{ source: "mod:x", target: "mod:y", kind: "calls" }],
      },
      entrypoints: {
        added: [{ id: "mod:in", kind: "http", trust_level: "untrusted", asset_value: "high" }],
        removed: [{ id: "mod:out", kind: "cli", trust_level: "trusted", asset_value: "low" }],
        modified: [
          {
            id: "mod:m",
            before: { trust_level: "trusted", asset_value: "low" },
            after: { trust_level: "untrusted", asset_value: "high" },
          },
        ],
      },
    };
    const expected =
      "Summary:\n" +
      "  nodes: 10 -> 12 (+2)\n" +
      "  edges: 5 -> 3 (-2)\n" +
      "  entrypoints: 0 -> 1 (+1)\n" +
      "\n" +
      "Added nodes (1):\n" +
      "  + mod:f  (function, f.py)\n" +
      "\n" +
      "Removed nodes (1):\n" +
      "  - mod:g  (function, g.py)\n" +
      "\n" +
      "Modified nodes (1):\n" +
      "  ~ mod:h  (cyclomatic_complexity, parameters)\n" +
      "      complexity: 3 -> 7\n" +
      "\n" +
      "Attack surface:\n" +
      "  + entrypoint mod:in  (http, trust=untrusted, asset=high)\n" +
      "  - entrypoint mod:out  (cli, trust=trusted, asset=low)\n" +
      "  ~ entrypoint mod:m\n" +
      "      trust: trusted -> untrusted\n" +
      "      asset: low -> high\n" +
      "\n" +
      "Edges: +2  -1";
    expect(formatDiff(diff)).toBe(expected);
  });

  it("added nodes truncation message exact", () => {
    const added = Array.from({ length: 25 }, (_, i) => ({ id: `mod:n${i}`, kind: "function", file: "x.py" }));
    const out = formatDiff(emptyDiff({ nodes: nodesOf({ added }) }));
    expect(out).toContain("  ... and 5 more");
    expect(out + "\n").toContain("  ... and 5 more\n");
  });

  it("removed nodes truncation message", () => {
    const removed = Array.from({ length: 23 }, (_, i) => ({ id: `mod:n${i}`, kind: "class", file: "x.py" }));
    const out = formatDiff(emptyDiff({ nodes: nodesOf({ removed }) }));
    expect(out).toContain("Removed nodes (23):");
    expect(out).toContain("  ... and 3 more");
  });

  it("entrypoints with only modified renders attack surface", () => {
    const out = formatDiff(
      emptyDiff({
        entrypoints: epsOf({
          modified: [
            {
              id: "mod:ep",
              before: { trust_level: "low", asset_value: "low" },
              after: { trust_level: "low", asset_value: "low" },
            },
          ],
        }),
      }),
    );
    expect(out.startsWith("Attack surface:\n")).toBe(true);
    expect(out).toContain("  ~ entrypoint mod:ep");
  });

  it("modified entrypoint only asset change", () => {
    const out = formatDiff(
      emptyDiff({
        entrypoints: epsOf({
          modified: [
            {
              id: "mod:ep",
              before: { trust_level: "trusted", asset_value: "low" },
              after: { trust_level: "trusted", asset_value: "critical" },
            },
          ],
        }),
      }),
    );
    expect(out).toContain("      asset: low -> critical");
    expect(out).not.toContain("trust:");
  });

  it("renders None for missing complexity like Python", () => {
    const out = formatDiff(
      emptyDiff({
        nodes: nodesOf({ modified: [{ id: "m", changes: { cyclomatic_complexity: { before: null, after: 3 } } }] }),
      }),
    );
    expect(out).toContain("complexity: None -> 3");
  });
});

// git_worktree tests live in test/git-worktree.test.ts (Node-only helper).
