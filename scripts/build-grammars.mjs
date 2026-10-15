#!/usr/bin/env node
// Build tree-sitter WASM grammars pinned in grammars/manifest.json.
// Usage: node scripts/build-grammars.mjs [name ...]   (default: all)
// Requires git, and either emcc on PATH or a running Docker daemon.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "grammars/manifest.json"), "utf8"));
const work = join(root, ".grammar-build");
const cli = join(root, "node_modules/.bin/tree-sitter");
mkdirSync(work, { recursive: true });

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

const names = process.argv.slice(2);
const selected = names.length ? names : Object.keys(manifest.grammars);
for (const name of selected) {
  const spec = manifest.grammars[name];
  if (!spec) throw new Error(`Unknown grammar: ${name}`);
  const out = join(root, "grammars", `tree-sitter-${name}.wasm`);
  const repoDir = join(work, spec.repo.split("/").pop());
  if (!existsSync(repoDir)) {
    run("git", ["init", "-q", repoDir]);
    run("git", ["remote", "add", "origin", spec.repo], repoDir);
  }
  run("git", ["fetch", "-q", "--depth", "1", "origin", spec.rev], repoDir);
  run("git", ["checkout", "-q", "--force", spec.rev], repoDir);
  const grammarDir = spec.directory ? join(repoDir, spec.directory) : repoDir;
  if (!existsSync(join(grammarDir, "src/parser.c"))) {
    run(cli, ["generate"], grammarDir);
  }
  console.log(`building ${name} -> ${out}`);
  run(cli, ["build", "--wasm", "-o", out, grammarDir], root);
}
