/** Node.js filesystem-backed ``FileSource``. Import from ``trailmark-ts/node``. */

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import type { DirEntry, FileSource } from "./source.js";

export class NodeFileSource implements FileSource {
  /** ``root`` is kept verbatim (relative or absolute), like upstream's ``dir_path``. */
  constructor(readonly root: string) {}

  async readDir(path: string): Promise<DirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      // Like os.walk(followlinks=False): symlinked dirs are not descended into,
      // but symlinked (and broken) file links are still yielded.
      const out: DirEntry[] = [];
      for (const e of entries) {
        if (e.isDirectory()) out.push({ name: e.name, kind: "directory" });
        else if (e.isFile()) out.push({ name: e.name, kind: "file" });
        else if (e.isSymbolicLink()) {
          const target = await stat(`${path}/${e.name}`).catch(() => null);
          if (target === null || !target.isDirectory()) out.push({ name: e.name, kind: "file" });
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  async readText(path: string): Promise<string | null> {
    try {
      return await readFile(path, "utf8");
    } catch {
      return null;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await readFile(path));
    } catch {
      return null;
    }
  }

  resolve(path: string): string {
    return resolve(path);
  }

  async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }
}
