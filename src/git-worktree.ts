/**
 * Node-only port of upstream ``analysis/diff.py::git_worktree``: materialize a
 * git ref as a temporary worktree for the duration of a callback.
 */

import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** Mirrors Python's ``subprocess.CalledProcessError`` message. */
export class CalledProcessError extends Error {
  constructor(
    readonly cmd: string[],
    readonly returncode: number,
    readonly stderr: string,
  ) {
    super(`Command '[${cmd.map((c) => `'${c}'`).join(", ")}]' returned non-zero exit status ${returncode}.`);
    this.name = "CalledProcessError";
  }
}

function run(cmd: string[], cwd: string): Promise<{ code: number; stderr: string }> {
  return new Promise((done) => {
    execFile(cmd[0]!, cmd.slice(1), { cwd }, (error, _stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === "number" ? error.code : 1;
      done({ code, stderr: String(stderr) });
    });
  });
}

/**
 * Materialize ``ref`` from ``repo`` as a temporary worktree and call ``fn`` with its path.
 *
 * Uses ``git worktree add`` which is non-destructive to the primary working
 * tree. The worktree is removed when ``fn`` settles.
 */
export async function withGitWorktree<T>(repo: string, ref: string, fn: (worktree: string) => Promise<T>): Promise<T> {
  let repoPath = resolve(repo);
  try {
    repoPath = realpathSync(repoPath);
  } catch {
    // Path.resolve() is non-strict: keep the lexical path.
  }
  if (!existsSync(join(repoPath, ".git"))) throw new Error(`Not a git repository: ${repoPath}`);
  const tmp = await mkdtemp(join(tmpdir(), "trailmark-worktree-"));
  try {
    const worktreePath = join(tmp, "wt");
    const addCmd = ["git", "worktree", "add", "--detach", worktreePath, ref];
    const added = await run(addCmd, repoPath);
    if (added.code !== 0) throw new CalledProcessError(addCmd, added.code, added.stderr);
    try {
      return await fn(worktreePath);
    } finally {
      await run(["git", "worktree", "remove", "--force", worktreePath], repoPath);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
