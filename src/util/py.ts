/** Helpers that reproduce Python formatting where output text must match upstream. */

/** Python ``repr()`` of a ``str``. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = quote;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + quote;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp === 0x7f) out += "\\x" + cp.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + quote;
}

/**
 * ``json.dumps(value, indent=indent, sort_keys=sortKeys)`` with Python's default
 * ``ensure_ascii=True``. Floats that are integral are still emitted as integers
 * (JS cannot distinguish ``1.0`` from ``1``).
 */
export function pyJsonDumps(value: unknown, indent: number | null = null, sortKeys = false): string {
  const json =
    indent === null
      ? JSON.stringify(sortKeys ? sortDeep(value) : value)
          // Python's compact separators are ", " and ": ".
          .replace(/("(?:[^"\\]|\\.)*")|([,:])/g, (_m, str: string | undefined, sep: string | undefined) =>
            str !== undefined ? str : sep === "," ? ", " : ": ",
          )
      : JSON.stringify(sortKeys ? sortDeep(value) : value, null, indent);
  return asciiEscape(json);
}

function asciiEscape(json: string): string {
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (c > 0x7f) out += "\\u" + c.toString(16).padStart(4, "0");
    else out += json[i];
  }
  return out;
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort(codeUnitCompare);
    const out: Record<string, unknown> = {};
    for (const k of keys) out[k] = sortDeep((value as Record<string, unknown>)[k]);
    return out;
  }
  return value;
}

function codeUnitCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
