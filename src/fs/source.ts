/**
 * Virtual file access so parsing works the same in Node and the browser.
 *
 * A ``FileSource`` exposes a tree of files under ``root``. All paths it hands
 * out and accepts are "full" paths of the form ``<root>/<relative>`` (exactly
 * what upstream's ``os.path.join(dir_path, ...)`` produced), and these are the
 * paths recorded in ``SourceLocation.filePath``.
 */

import { basename, normalize, posixRelative, rawJoin } from "../util/path.js";

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export interface FileSource {
  /** Root path as it should appear in graph locations (e.g. ``path/to/project``). */
  readonly root: string;
  /** List a directory (full path). Order is not significant; callers sort. */
  readDir(path: string): Promise<DirEntry[]>;
  /** Read a file as UTF-8 text, or ``null`` if it does not exist. */
  readText(path: string): Promise<string | null>;
  /** Read raw bytes, or ``null`` if it does not exist. */
  readBytes?(path: string): Promise<Uint8Array | null>;
  /** Whether ``path`` is an existing file. */
  isFile(path: string): Promise<boolean>;
  /**
   * Optional: resolve ``path`` to an absolute path. Only sources that can read
   * anywhere on the filesystem (``NodeFileSource``) implement it; lookups that
   * upstream does above the analyzed directory (e.g. the repo root holding
   * ``pyproject.toml``) are then unbounded, as in upstream.
   */
  resolve?(path: string): string;
}

/**
 * Walk ``dir`` top-down like ``os.walk`` with sorted directories and files,
 * skipping directories rejected by ``skipDir``. Yields full file paths.
 */
export async function* walkFiles(
  source: FileSource,
  dir: string,
  skipDir: (name: string) => boolean,
): AsyncGenerator<string> {
  const entries = await source.readDir(dir);
  const files = entries.filter((e) => e.kind === "file").map((e) => e.name);
  const dirs = entries.filter((e) => e.kind === "directory" && !skipDir(e.name)).map((e) => e.name);
  files.sort(pyCompare);
  dirs.sort(pyCompare);
  for (const f of files) yield rawJoin(dir, f);
  for (const d of dirs) yield* walkFiles(source, rawJoin(dir, d), skipDir);
}

/** Code-point string ordering, matching Python's ``sorted`` on ``str``. */
export function pyCompare(a: string, b: string): number {
  if (a === b) return 0;
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done) return y.done ? 0 : -1;
    if (y.done) return 1;
    const cx = x.value.codePointAt(0)!;
    const cy = y.value.codePointAt(0)!;
    if (cx !== cy) return cx - cy;
  }
}

/** In-memory file tree, keyed by path relative to ``root``. Works everywhere. */
export class MemoryFileSource implements FileSource {
  readonly root: string;
  private readonly files = new Map<string, string | Uint8Array>();

  constructor(root: string, files: Iterable<[string, string | Uint8Array]> | Record<string, string | Uint8Array> = {}) {
    this.root = root;
    const entries =
      Symbol.iterator in files ? (files as Iterable<[string, string | Uint8Array]>) : Object.entries(files);
    for (const [rel, content] of entries) this.set(rel, content);
  }

  /** Add or replace a file (path relative to root). */
  set(relPath: string, content: string | Uint8Array): void {
    this.files.set(normalize(relPath), content);
  }

  delete(relPath: string): void {
    this.files.delete(normalize(relPath));
  }

  /** Relative paths of every file. */
  relativePaths(): string[] {
    return [...this.files.keys()];
  }

  private rel(path: string): string | null {
    const r = posixRelative(this.root, path);
    return r === null ? null : r;
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const rel = this.rel(path);
    if (rel === null) return [];
    const prefix = rel === "." ? "" : rel + "/";
    const seen = new Map<string, DirEntry["kind"]>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const slash = rest.indexOf("/");
      if (slash < 0) seen.set(rest, "file");
      else if (!seen.has(rest.slice(0, slash))) seen.set(rest.slice(0, slash), "directory");
    }
    return [...seen].map(([name, kind]) => ({ name, kind }));
  }

  async readText(path: string): Promise<string | null> {
    const rel = this.rel(path);
    if (rel === null) return null;
    const content = this.files.get(rel);
    if (content === undefined) return null;
    return typeof content === "string" ? content : new TextDecoder().decode(content);
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const rel = this.rel(path);
    if (rel === null) return null;
    const content = this.files.get(rel);
    if (content === undefined) return null;
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  }

  async isFile(path: string): Promise<boolean> {
    const rel = this.rel(path);
    return rel !== null && this.files.has(rel);
  }
}

/** Browser: build a source from an ``<input type=file webkitdirectory>`` FileList. */
export async function fileSourceFromFileList(
  files: ArrayLike<File & { webkitRelativePath?: string }>,
): Promise<MemoryFileSource> {
  const list = Array.from(files);
  const first = list[0]?.webkitRelativePath ?? "";
  const root = first.includes("/") ? first.slice(0, first.indexOf("/")) : "project";
  const source = new MemoryFileSource(root);
  await Promise.all(
    list.map(async (f) => {
      const rel = f.webkitRelativePath ? f.webkitRelativePath.slice(root.length + 1) : f.name;
      source.set(rel, new Uint8Array(await f.arrayBuffer()));
    }),
  );
  return source;
}

/** Minimal structural type for the File System Access API directory handle. */
export interface DirectoryHandleLike {
  readonly kind: "directory";
  readonly name: string;
  values(): AsyncIterable<
    | DirectoryHandleLike
    | { readonly kind: "file"; readonly name: string; getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> }
  >;
}

/**
 * Browser: lazily read from a ``FileSystemDirectoryHandle`` (from
 * ``showDirectoryPicker()`` or a drag-and-drop ``getAsFileSystemHandle()``).
 */
export class DirectoryHandleFileSource implements FileSource {
  readonly root: string;

  constructor(private readonly handle: DirectoryHandleLike) {
    this.root = handle.name;
  }

  private async lookup(
    path: string,
  ): Promise<
    DirectoryHandleLike | { kind: "file"; getFile(): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }> } | null
  > {
    const rel = posixRelative(this.root, path);
    if (rel === null) return null;
    let current: DirectoryHandleLike = this.handle;
    const parts = rel === "." ? [] : rel.split("/");
    for (let i = 0; i < parts.length; i++) {
      let next = null;
      for await (const entry of current.values()) {
        if (entry.name === parts[i]) {
          next = entry;
          break;
        }
      }
      if (next === null) return null;
      if (i === parts.length - 1) return next;
      if (next.kind !== "directory") return null;
      current = next;
    }
    return current;
  }

  async readDir(path: string): Promise<DirEntry[]> {
    const dir = await this.lookup(path);
    if (dir === null || dir.kind !== "directory") return [];
    const out: DirEntry[] = [];
    for await (const entry of dir.values()) out.push({ name: entry.name, kind: entry.kind });
    return out;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const file = await this.lookup(path);
    if (file === null || file.kind !== "file") return null;
    return new Uint8Array(await (await file.getFile()).arrayBuffer());
  }

  async readText(path: string): Promise<string | null> {
    const bytes = await this.readBytes(path);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }

  async isFile(path: string): Promise<boolean> {
    const f = await this.lookup(path);
    return f !== null && f.kind === "file";
  }
}

export { basename };
