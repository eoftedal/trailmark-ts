/** Node filesystem key-value store (one JSON file per key). Exported from ``trailmark-ts/node``. */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { KeyValueStore } from "./kv.js";

// Keys can be long (parse-cache keys embed file paths), so files are named by hash
// and the key is stored alongside the value.
const fileFor = (key: string) => createHash("sha256").update(key).digest("hex") + ".json";

interface Entry<V> {
  key: string;
  value: V;
}

export class FsKeyValueStore<V> implements KeyValueStore<V> {
  constructor(private readonly dir: string) {}

  private async read(file: string): Promise<Entry<V> | undefined> {
    try {
      return JSON.parse(await readFile(join(this.dir, file), "utf8")) as Entry<V>;
    } catch {
      return undefined;
    }
  }

  async get(key: string): Promise<V | undefined> {
    const entry = await this.read(fileFor(key));
    return entry?.key === key ? entry.value : undefined;
  }
  async set(key: string, value: V): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, fileFor(key)), JSON.stringify({ key, value } satisfies Entry<V>));
  }
  async delete(key: string): Promise<void> {
    await rm(join(this.dir, fileFor(key)), { force: true });
  }
  async keys(): Promise<string[]> {
    let files: string[];
    try {
      files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
    } catch {
      return [];
    }
    const keys: string[] = [];
    for (const f of files) {
      const entry = await this.read(f);
      if (entry !== undefined) keys.push(entry.key);
    }
    return keys;
  }
  async clear(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
