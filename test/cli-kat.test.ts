/** Port of upstream tests/test_kat_cli.py: exact stdout snapshots of CLI subcommands. */

import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "./cli-helpers.js";
import { FIXTURE_ROOT } from "./kat-runner.js";

const FIXTURE_DIR = join(FIXTURE_ROOT, "python");
const SNAPSHOT_DIR = join(FIXTURE_ROOT, "cli");
const VERSION_PATTERN = /\bv?\d+\.\d+\.\d+(?:[.\-+][\w.\-+]+)?\b/g;

/** Replace absolute paths and the trailmark version with stable tokens. */
function normalize(text: string): string {
  const here = realpathSync(FIXTURE_DIR);
  return text
    .replaceAll(here, "<FIXTURE_DIR>")
    .replaceAll(FIXTURE_DIR, "<FIXTURE_DIR>")
    .replace(VERSION_PATTERN, "<VERSION>");
}

async function check(name: string, argv: string[]): Promise<void> {
  const { stdout } = await runCli(argv);
  expect(normalize(stdout)).toBe(readFileSync(join(SNAPSHOT_DIR, `${name}.expected.txt`), "utf8"));
}

describe("CLI KAT snapshots", () => {
  it("version subcommand", () => check("version", ["version"]));
  it("analyze --summary", () =>
    check("analyze_summary", ["analyze", FIXTURE_DIR, "--language", "python", "--summary"]));
  it("analyze --complexity 2", () =>
    check("analyze_complexity", ["analyze", FIXTURE_DIR, "--language", "python", "--complexity", "2"]));
  it("analyze --complexity 9999", () =>
    check("analyze_complexity_none", ["analyze", FIXTURE_DIR, "--language", "python", "--complexity", "9999"]));
  it("entrypoints text", () => check("entrypoints_text", ["entrypoints", FIXTURE_DIR, "--language", "python"]));
  it("entrypoints json", () =>
    check("entrypoints_json", ["entrypoints", FIXTURE_DIR, "--language", "python", "--json"]));
  for (const flag of ["--version", "-V"]) {
    it(`top-level ${flag}`, () => check("top_level_version", [flag]));
  }
  it("no command prints help", () => check("no_command_help", []));
});
