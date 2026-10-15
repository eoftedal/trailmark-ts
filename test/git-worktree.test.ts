import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withGitWorktree } from "../src/git-worktree.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "trailmark-wt-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: "pipe" });

describe("withGitWorktree (upstream git_worktree)", () => {
  it("materializes a ref in a detached worktree and cleans it up", async () => {
    const repo = join(tmp(), "repo");
    mkdirSync(repo);
    git(repo, "init", "-q");
    git(repo, "config", "user.email", "test@example.com");
    git(repo, "config", "user.name", "Test");
    writeFileSync(join(repo, "app.py"), "def main():\n    pass\n");
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "initial");

    let seen = "";
    await withGitWorktree(repo, "HEAD", async (worktree) => {
      seen = worktree;
      expect(readFileSync(join(worktree, "app.py"), "utf8")).toBe("def main():\n    pass\n");
    });
    expect(existsSync(seen)).toBe(false);
  });

  it("rejects a directory that is not a git repository", async () => {
    await expect(withGitWorktree(tmp(), "HEAD", async () => undefined)).rejects.toThrow(/Not a git repository/);
  });
});
