/** Minimal POSIX path helpers that work in the browser (no ``node:path``). */

/** Normalize separators to ``/`` and collapse ``.``/``..``/duplicate slashes lexically. */
export function normalize(p: string): string {
  const s = p.replaceAll("\\", "/");
  const absolute = s.startsWith("/");
  const out: string[] = [];
  for (const part of s.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join("/");
  if (absolute) return "/" + joined;
  return joined === "" ? "." : joined;
}

export function join(...parts: string[]): string {
  const filtered = parts.filter((p) => p !== "");
  if (filtered.length === 0) return ".";
  return normalize(filtered.join("/"));
}

/** Python ``os.path.join(a, b)`` without normalization (keeps ``a`` verbatim). */
export function rawJoin(dir: string, name: string): string {
  if (dir === "") return name;
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function basename(p: string): string {
  const s = p.replaceAll("\\", "/").replace(/\/+$/, "");
  const at = s.lastIndexOf("/");
  return at < 0 ? s : s.slice(at + 1);
}

export function dirname(p: string): string {
  const s = p.replaceAll("\\", "/").replace(/\/+$/, "");
  const at = s.lastIndexOf("/");
  if (at < 0) return ".";
  if (at === 0) return "/";
  return s.slice(0, at);
}

/** Python ``PurePath.suffix``. */
export function suffix(name: string): string {
  const base = basename(name);
  const at = base.lastIndexOf(".");
  if (at <= 0 || at === base.length - 1) return "";
  return base.slice(at);
}

/** Python ``PurePath.stem``. */
export function stem(name: string): string {
  const base = basename(name);
  const suf = suffix(base);
  return suf ? base.slice(0, -suf.length) : base;
}

/**
 * Return ``target`` relative to ``root`` (lexically), or ``null`` when it is not
 * underneath ``root``. Both are normalized first.
 */
export function posixRelative(root: string, target: string): string | null {
  const r = normalize(root);
  const t = normalize(target);
  if (r === ".") return t.startsWith("/") || t.startsWith("..") ? null : t;
  if (t === r) return ".";
  const prefix = r.endsWith("/") ? r : r + "/";
  return t.startsWith(prefix) ? t.slice(prefix.length) : null;
}
