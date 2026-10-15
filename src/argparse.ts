/**
 * A small subset of Python's ``argparse`` (3.13 semantics), sufficient for the
 * Trailmark CLI. Help, usage and error text match argparse byte-for-byte for the
 * features used here (store / store_true / append / int type / choices /
 * required / positionals / subparsers / version), including line wrapping.
 *
 * Browser-safe: never prints or exits. Help/version/errors are reported by
 * throwing ``ArgParseExit`` carrying the text and exit code.
 */

export class ArgParseExit extends Error {
  constructor(
    readonly code: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(stderr || stdout);
    this.name = "ArgParseExit";
  }
}

export type Namespace = Record<string, unknown>;

type ActionKind = "store" | "store_true" | "append" | "help" | "version" | "parsers";

/** ``argparse.SUPPRESS``: an option with this help text is left out of usage and help. */
export const SUPPRESS = "==SUPPRESS==";

export interface ArgumentOptions {
  action?: "store" | "store_true" | "append" | "help" | "version";
  dest?: string;
  type?: "int";
  choices?: readonly string[];
  default?: unknown;
  required?: boolean;
  help?: string;
  metavar?: string;
  version?: string;
}

export interface Action {
  kind: ActionKind;
  optionStrings: string[];
  dest: string;
  type?: "int";
  choices?: readonly string[];
  default: unknown;
  required: boolean;
  help?: string;
  metavar?: string;
  version?: string;
  /** Subparsers only. */
  parsers?: Map<string, { parser: ArgumentParser; help?: string }>;
}

const MAX_HELP_POSITION = 24;

export class ArgumentParser {
  readonly prog: string;
  readonly description: string | undefined;
  /** Help width (``COLUMNS - 2`` in argparse). */
  width: number;
  private readonly actions: Action[] = [];

  constructor(options: { prog: string; description?: string; columns?: number }) {
    this.prog = options.prog;
    this.description = options.description;
    this.width = (options.columns ?? 80) - 2;
    this.addArgument(["-h", "--help"], { action: "help", help: "show this help message and exit" });
  }

  addArgument(names: string | string[], options: ArgumentOptions = {}): void {
    const list = typeof names === "string" ? [names] : names;
    const positional = !list[0]!.startsWith("-");
    const kind: ActionKind = options.action ?? "store";
    let dest = options.dest;
    if (dest === undefined) {
      if (positional) dest = list[0]!;
      else {
        const long = list.find((s) => s.startsWith("--")) ?? list[0]!;
        dest = long.replace(/^-+/, "").replaceAll("-", "_");
      }
    }
    let def = options.default;
    if (def === undefined)
      def = kind === "store_true" ? false : kind === "help" || kind === "version" ? undefined : null;
    this.actions.push({
      kind,
      optionStrings: positional ? [] : list,
      dest,
      type: options.type,
      choices: options.choices,
      default: def,
      required: positional ? true : (options.required ?? false),
      help: options.help ?? (kind === "version" ? "show program's version number and exit" : undefined),
      metavar: options.metavar,
      version: options.version,
    });
  }

  /** ``add_subparsers(dest=...)``; returns a function adding a named sub-parser. */
  addSubparsers(options: { dest: string }): (name: string, opts?: { help?: string }) => ArgumentParser {
    const parsers = new Map<string, { parser: ArgumentParser; help?: string }>();
    this.actions.push({
      kind: "parsers",
      optionStrings: [],
      dest: options.dest,
      default: null,
      required: false,
      parsers,
    });
    return (name, opts = {}) => {
      const parser = new ArgumentParser({ prog: `${this.prog} ${name}`, columns: this.width + 2 });
      parsers.set(name, { parser, help: opts.help });
      return parser;
    };
  }

  /** Sub-parsers by name (for introspection). */
  subparsers(): Map<string, ArgumentParser> {
    const action = this.actions.find((a) => a.kind === "parsers");
    return new Map([...(action?.parsers ?? new Map())].map(([k, v]) => [k, v.parser]));
  }

  /** Introspection: the action registered with option string or positional dest ``name``. */
  action(name: string): Readonly<Action> | undefined {
    return this.actions.find(
      (a) => a.optionStrings.includes(name) || (a.optionStrings.length === 0 && a.dest === name),
    );
  }

  private setWidth(width: number): void {
    this.width = width;
    for (const p of this.subparsers().values()) p.setWidth(width);
  }

  setColumns(columns: number): void {
    this.setWidth(columns - 2);
  }

  // ── Formatting ───────────────────────────────────────────────────

  private metavar(a: Action): string {
    if (a.metavar !== undefined) return a.metavar;
    if (a.choices !== undefined) return `{${a.choices.join(",")}}`;
    if (a.kind === "parsers") return `{${[...a.parsers!.keys()].join(",")}}`;
    return a.optionStrings.length === 0 ? a.dest : a.dest.toUpperCase();
  }

  private takesValue(a: Action): boolean {
    return a.kind === "store" || a.kind === "append";
  }

  private usagePart(a: Action): string {
    if (a.optionStrings.length === 0) {
      return a.kind === "parsers" ? `${this.metavar(a)} ...` : this.metavar(a);
    }
    let part = a.optionStrings[0]!;
    if (this.takesValue(a)) part += ` ${this.metavar(a)}`;
    return a.required ? part : `[${part}]`;
  }

  /** Actions shown in usage/help (``help=SUPPRESS`` ones are hidden, as in argparse). */
  private visibleActions(): Action[] {
    return this.actions.filter((a) => a.help !== SUPPRESS);
  }

  formatUsage(): string {
    const prefix = "usage: ";
    const optionals = this.visibleActions().filter((a) => a.optionStrings.length > 0);
    const positionals = this.visibleActions().filter((a) => a.optionStrings.length === 0);
    const optParts = optionals.map((a) => this.usagePart(a));
    const posParts = positionals.map((a) => this.usagePart(a));
    let usage = [this.prog, ...optParts, ...posParts].join(" ");
    const textWidth = this.width;
    if (prefix.length + usage.length > textWidth) {
      const getLines = (parts: string[], indent: string, pre?: string): string[] => {
        const lines: string[] = [];
        let line: string[] = [];
        let lineLen = pre !== undefined ? pre.length - 1 : indent.length - 1;
        for (const part of parts) {
          if (lineLen + 1 + part.length > textWidth && line.length > 0) {
            lines.push(indent + line.join(" "));
            line = [];
            lineLen = indent.length - 1;
          }
          line.push(part);
          lineLen += part.length + 1;
        }
        if (line.length > 0) lines.push(indent + line.join(" "));
        if (pre !== undefined && lines.length > 0) lines[0] = lines[0]!.slice(indent.length);
        return lines;
      };
      let lines: string[];
      if (prefix.length + this.prog.length <= 0.75 * textWidth) {
        const indent = " ".repeat(prefix.length + this.prog.length + 1);
        if (optParts.length > 0) {
          lines = getLines([this.prog, ...optParts], indent, prefix);
          lines.push(...getLines(posParts, indent));
        } else if (posParts.length > 0) {
          lines = getLines([this.prog, ...posParts], indent, prefix);
        } else lines = [this.prog];
      } else {
        const indent = " ".repeat(prefix.length);
        const parts = [...optParts, ...posParts];
        lines = getLines(parts, indent);
        if (lines.length > 1) {
          lines = [...getLines(optParts, indent), ...getLines(posParts, indent)];
        }
        lines = [this.prog, ...lines];
      }
      usage = lines.join("\n");
    }
    return `${prefix}${usage}\n`;
  }

  private invocation(a: Action): string {
    if (a.optionStrings.length === 0) return this.metavar(a);
    const opts = a.optionStrings.join(", ");
    return this.takesValue(a) ? `${opts} ${this.metavar(a)}` : opts;
  }

  formatHelp(): string {
    const optionals = this.visibleActions().filter((a) => a.optionStrings.length > 0);
    const positionals = this.visibleActions().filter((a) => a.optionStrings.length === 0);

    // Like HelpFormatter._action_max_length: over every invocation, incl. sub-actions.
    let maxLen = 0;
    for (const a of this.visibleActions()) {
      maxLen = Math.max(maxLen, this.invocation(a).length + 2);
      if (a.kind === "parsers") for (const name of a.parsers!.keys()) maxLen = Math.max(maxLen, name.length + 4);
    }
    const helpPosition = Math.min(maxLen + 2, MAX_HELP_POSITION);
    const helpWidth = Math.max(this.width - helpPosition, 11);

    const formatItem = (indent: number, header: string, help: string | undefined): string => {
      const actionWidth = helpPosition - indent - 2;
      let out: string;
      let indentFirst: number;
      if (!help) return " ".repeat(indent) + header + "\n";
      if (header.length <= actionWidth) {
        out = " ".repeat(indent) + header.padEnd(actionWidth) + "  ";
        indentFirst = 0;
      } else {
        out = " ".repeat(indent) + header + "\n";
        indentFirst = helpPosition;
      }
      const lines = wrapText(help, helpWidth);
      out += " ".repeat(indentFirst) + (lines[0] ?? "") + "\n";
      for (const line of lines.slice(1)) out += " ".repeat(helpPosition) + line + "\n";
      return out;
    };

    const formatAction = (a: Action): string => {
      let out = formatItem(2, this.invocation(a), a.help);
      if (a.kind === "parsers") {
        for (const [name, { help }] of a.parsers!) out += formatItem(4, name, help);
      }
      return out;
    };

    const sections: string[] = [this.formatUsage().trimEnd()];
    if (this.description) sections.push(wrapText(this.description, Math.max(this.width, 11)).join("\n"));
    if (positionals.length > 0) {
      sections.push("positional arguments:\n" + positionals.map(formatAction).join("").trimEnd());
    }
    if (optionals.length > 0) sections.push("options:\n" + optionals.map(formatAction).join("").trimEnd());
    return sections.join("\n\n") + "\n";
  }

  /** ``parser.error(message)``: usage + message on stderr, exit status 2. */
  error(message: string): never {
    throw new ArgParseExit(2, "", `${this.formatUsage()}${this.prog}: error: ${message}\n`);
  }

  // ── Parsing ──────────────────────────────────────────────────────

  /** ``parse_args``: errors on leftover arguments. */
  parseArgs(argv: readonly string[]): Namespace {
    const [ns, extras] = this.parseKnownArgs(argv);
    if (extras.length > 0) this.error(`unrecognized arguments: ${extras.join(" ")}`);
    return ns;
  }

  private actionName(a: Action): string {
    if (a.optionStrings.length > 0) return a.optionStrings.join("/");
    if (a.metavar !== undefined) return a.metavar;
    return a.dest;
  }

  private convert(a: Action, value: string): unknown {
    let result: unknown = value;
    if (a.type === "int") {
      if (!/^\s*[+-]?\d+(?:_\d+)*\s*$/.test(value)) {
        this.error(`argument ${this.actionName(a)}: invalid int value: ${pyStrRepr(value)}`);
      }
      result = Number.parseInt(value.trim().replaceAll("_", ""), 10);
    }
    if (a.choices !== undefined && !a.choices.includes(value)) {
      const choices = a.choices.map(pyStrRepr).join(", ");
      this.error(`argument ${this.actionName(a)}: invalid choice: ${pyStrRepr(value)} (choose from ${choices})`);
    }
    return result;
  }

  private looksLikeOption(arg: string): boolean {
    if (!arg.startsWith("-") || arg === "-") return false;
    if (/^-\d+$|^-\d*\.\d+$/.test(arg)) return false;
    return true;
  }

  private resolveOption(arg: string): { action: Action; explicit: string | null } | null {
    const optionals = this.actions.filter((a) => a.optionStrings.length > 0);
    const exact = optionals.find((a) => a.optionStrings.includes(arg));
    if (exact) return { action: exact, explicit: null };
    if (arg.includes("=")) {
      const eq = arg.indexOf("=");
      const name = arg.slice(0, eq);
      const found = optionals.find((a) => a.optionStrings.includes(name));
      if (found) return { action: found, explicit: arg.slice(eq + 1) };
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      const name = eq >= 0 ? arg.slice(0, eq) : arg;
      const explicit = eq >= 0 ? arg.slice(eq + 1) : null;
      const matches: [Action, string][] = [];
      for (const a of optionals) {
        for (const s of a.optionStrings) if (s.startsWith("--") && s.startsWith(name)) matches.push([a, s]);
      }
      if (matches.length > 1) {
        const opts = matches.map(([, s]) => s).join(", ");
        this.error(`ambiguous option: ${name} could match ${opts}`);
      }
      if (matches.length === 1) return { action: matches[0]![0], explicit };
      return null;
    }
    // Single-dash short option with attached value, e.g. ``-c2`` / ``-lpython``.
    const short = arg.slice(0, 2);
    const found = optionals.find((a) => a.optionStrings.includes(short));
    if (found) return { action: found, explicit: arg.slice(2) };
    return null;
  }

  parseKnownArgs(argv: readonly string[]): [Namespace, string[]] {
    const ns: Namespace = {};
    for (const a of this.actions) {
      if (a.kind === "help" || a.kind === "version") continue;
      ns[a.dest] = Array.isArray(a.default) ? [...a.default] : a.default;
    }
    const extras: string[] = [];
    const seen = new Set<Action>();
    const positionals = this.actions.filter((a) => a.optionStrings.length === 0);
    let posIndex = 0;
    let onlyPositionals = false;

    const args = [...argv];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (!onlyPositionals && arg === "--") {
        onlyPositionals = true;
        continue;
      }
      if (!onlyPositionals && this.looksLikeOption(arg)) {
        const resolved = this.resolveOption(arg);
        if (resolved === null) {
          extras.push(arg);
          continue;
        }
        let { action, explicit } = resolved;
        if (!this.takesValue(action)) {
          if (explicit !== null && explicit !== "") {
            if (arg.startsWith("--") || arg.includes("=")) {
              this.error(`argument ${this.actionName(action)}: ignored explicit argument ${pyStrRepr(explicit)}`);
            }
            // Combined short flags (``-sx``): re-queue the remainder.
            args.splice(i + 1, 0, `-${explicit}`);
          }
          seen.add(action);
          this.takeFlag(action, ns);
          continue;
        }
        let value: string;
        if (explicit !== null && (explicit !== "" || arg.includes("="))) value = explicit;
        else {
          const next = args[i + 1];
          if (next === undefined || (this.looksLikeOption(next) && !onlyPositionals) || next === "--") {
            this.error(`argument ${this.actionName(action)}: expected one argument`);
          }
          value = next;
          i++;
        }
        seen.add(action);
        const converted = this.convert(action, value);
        if (action.kind === "append") (ns[action.dest] as unknown[]).push(converted);
        else ns[action.dest] = converted;
        continue;
      }
      // Positional.
      const action = positionals[posIndex];
      if (action === undefined) {
        extras.push(arg);
        continue;
      }
      posIndex++;
      seen.add(action);
      if (action.kind === "parsers") {
        const entry = action.parsers!.get(arg);
        if (entry === undefined) {
          const choices = [...action.parsers!.keys()].map(pyStrRepr).join(", ");
          this.error(`argument ${action.dest}: invalid choice: ${pyStrRepr(arg)} (choose from ${choices})`);
        }
        ns[action.dest] = arg;
        const [subNs, subExtras] = entry.parser.parseKnownArgs(args.slice(i + 1));
        Object.assign(ns, subNs);
        extras.push(...subExtras);
        break;
      }
      ns[action.dest] = this.convert(action, arg);
    }

    const missing = this.actions.filter((a) => a.required && !seen.has(a)).map((a) => this.actionName(a));
    if (missing.length > 0) this.error(`the following arguments are required: ${missing.join(", ")}`);
    return [ns, extras];
  }

  private takeFlag(action: Action, ns: Namespace): void {
    if (action.kind === "help") throw new ArgParseExit(0, this.formatHelp(), "");
    if (action.kind === "version") throw new ArgParseExit(0, `${action.version ?? ""}\n`, "");
    ns[action.dest] = true;
  }
}

/** Python ``repr()`` of a plain string (simple cases). */
function pyStrRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  return quote + s.replaceAll("\\", "\\\\").replaceAll(quote, "\\" + quote) + quote;
}

/**
 * ``textwrap.wrap(" ".join(text.split()), width)`` with break_on_hyphens and
 * break_long_words, approximated: chunks are whitespace-separated words, further
 * split after hyphens between letters.
 */
export function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks: string[] = [];
  for (const w of words) {
    if (chunks.length > 0) chunks.push(" ");
    chunks.push(...w.split(/(?<=[A-Za-z]-)(?=[A-Za-z])/));
  }
  const lines: string[] = [];
  let line = "";
  for (const chunk of chunks) {
    if (chunk === " ") {
      if (line !== "") line += " ";
      continue;
    }
    if (line.length + chunk.length <= width) {
      line += chunk;
      continue;
    }
    const trimmed = line.trimEnd();
    if (trimmed !== "") lines.push(trimmed);
    let rest = chunk;
    while (rest.length > width) {
      lines.push(rest.slice(0, width));
      rest = rest.slice(width);
    }
    line = rest;
  }
  if (line.trimEnd() !== "") lines.push(line.trimEnd());
  return lines;
}
