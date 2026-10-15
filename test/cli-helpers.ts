import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach } from "vitest";

import { main } from "../src/cli.js";

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run the CLI in-process with captured output (80-column help, like argparse's fallback). */
export async function runCli(argv: string[]): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, {
    stdout: (t) => (stdout += t),
    stderr: (t) => (stderr += t),
    columns: 80,
  });
  return { code, stdout, stderr };
}

/** Per-test temporary directory (like pytest's ``tmp_path``), removed after each test. */
export function useTmpPath(): () => string {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  return () => {
    const d = mkdtempSync(join(tmpdir(), "trailmark-test-"));
    dirs.push(d);
    return d;
  };
}
