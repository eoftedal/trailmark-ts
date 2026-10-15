/** Load explicit cross-language and external links from ``.trailmark/links.toml``. */

import { parse as parseToml } from "smol-toml";

import type { FileSource } from "../fs/source.js";
import {
  codeEdge,
  EDGE_CONFIDENCES,
  EDGE_KINDS,
  edgesEqual,
  type Attribute,
  type CodeGraph,
  type EdgeConfidence,
  type EdgeKind,
} from "../models/index.js";
import { codeUnit, sourceLocation } from "../models/nodes.js";
import { pyCompare } from "../fs/source.js";
import { rawJoin } from "../util/path.js";
import { pyRepr } from "../util/py.js";

export const LINKS_FILE = ".trailmark/links.toml";

/**
 * Add links declared in ``.trailmark/links.toml`` below ``rootPath``.
 *
 * Invalid configuration is rejected (throws) rather than silently weakening the
 * graph. Unresolved endpoints are accepted only when explicitly marked with
 * ``source_external`` or ``target_external``.
 */
export async function applyRepositoryLinks(graph: CodeGraph, source: FileSource, rootPath: string): Promise<void> {
  const configPath = rawJoin(rootPath, LINKS_FILE);
  if (!(await source.isFile(configPath))) return;
  const text = await source.readText(configPath);
  if (text === null) return;
  applyRepositoryLinksText(graph, text, configPath);
}

/** Apply a links.toml document that has already been read. */
export function applyRepositoryLinksText(graph: CodeGraph, text: string, configPath: string): void {
  let data: Record<string, unknown>;
  try {
    data = parseToml(text) as Record<string, unknown>;
  } catch (exc) {
    throw new Error(`Invalid ${LINKS_FILE}: ${(exc as Error).message}`);
  }
  const unknown = Object.keys(data)
    .filter((k) => k !== "link")
    .sort(pyCompare);
  if (unknown.length > 0) {
    invalid(0, `unknown top-level key ${pyRepr(unknown[0]!)}; only 'link' is valid`);
  }
  const entries = data["link"] ?? [];
  if (!Array.isArray(entries)) {
    throw new Error(`Invalid ${LINKS_FILE}: 'link' must be an array of tables`);
  }
  entries.forEach((raw, i) => applyLink(graph, raw, i + 1, configPath));
}

const ALLOWED_KEYS = new Set([
  "source",
  "target",
  "kind",
  "confidence",
  "description",
  "source_external",
  "target_external",
]);

function applyLink(graph: CodeGraph, raw: unknown, index: number, configPath: string): void {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) invalid(index, "entry must be a table");
  const entry = raw as Record<string, unknown>;
  const unknown = Object.keys(entry)
    .filter((k) => !ALLOWED_KEYS.has(k))
    .sort(pyCompare);
  if (unknown.length > 0) invalid(index, `unknown key ${pyRepr(unknown[0]!)}`);

  const sourceRef = requiredString(entry, "source", index);
  const targetRef = requiredString(entry, "target", index);
  const sourceExternal = optionalBool(entry, "source_external", index);
  const targetExternal = optionalBool(entry, "target_external", index);

  const sourceId = resolveEndpoint(graph, sourceRef, sourceExternal, "source_external", index, configPath);
  const targetId = resolveEndpoint(graph, targetRef, targetExternal, "target_external", index, configPath);
  const kind = edgeKind(entry["kind"] ?? "calls", index);
  const confidence = edgeConfidence(entry["confidence"] ?? "inferred", index);
  const description = entry["description"];
  if (description !== undefined && typeof description !== "string") invalid(index, "'description' must be a string");

  const attributes: Attribute[] = [["configured_by", LINKS_FILE]];
  if (description) attributes.push(["description", description as string]);
  const edge = codeEdge({ sourceId, targetId, kind, confidence, attributes });
  if (!graph.edges.some((e) => edgesEqual(e, edge))) graph.edges.push(edge);
}

function requiredString(entry: Record<string, unknown>, key: string, index: number): string {
  const value = entry[key];
  if (typeof value !== "string" || !value.trim()) invalid(index, `'${key}' must be a non-empty string`);
  return (value as string).trim();
}

function optionalBool(entry: Record<string, unknown>, key: string, index: number): boolean {
  const value = entry[key] ?? false;
  if (typeof value !== "boolean") invalid(index, `'${key}' must be a boolean`);
  return value as boolean;
}

function resolveEndpoint(
  graph: CodeGraph,
  reference: string,
  external: boolean,
  flagName: string,
  index: number,
  configPath: string,
): string {
  if (graph.nodes.has(reference)) return reference;
  const matches: string[] = [];
  for (const [nodeId, unit] of graph.nodes) {
    if (unit.name === reference || nodeId.endsWith(`:${reference}`) || nodeId.endsWith(`.${reference}`)) {
      matches.push(nodeId);
    }
  }
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    invalid(index, `endpoint ${pyRepr(reference)} is ambiguous: ${[...matches].sort(pyCompare).join(", ")}`);
  }
  if (!external) {
    invalid(index, `endpoint ${pyRepr(reference)} does not exist (set ${flagName} = true to proxy it)`);
  }
  return addExternalProxy(graph, reference, configPath);
}

function addExternalProxy(graph: CodeGraph, reference: string, configPath: string): string {
  const escaped = reference.trim().replace(/[^0-9A-Za-z_.@$:-]+/g, "_") || "unknown";
  const nodeId = `proxy.external:${escaped}`;
  if (!graph.nodes.has(nodeId)) {
    graph.nodes.set(
      nodeId,
      codeUnit({
        id: nodeId,
        name: reference,
        kind: "proxy",
        location: sourceLocation(configPath, 0, 0),
        origin: "proxy",
        attributes: [
          ["raw_symbol", reference],
          ["proxy_kind", "external"],
        ],
      }),
    );
  }
  return nodeId;
}

function edgeKind(value: unknown, index: number): EdgeKind {
  if (typeof value !== "string") invalid(index, "'kind' must be a string");
  if (!(EDGE_KINDS as readonly string[]).includes(value as string)) {
    invalid(index, `invalid kind ${pyRepr(value as string)}; expected one of: ${EDGE_KINDS.join(", ")}`);
  }
  return value as EdgeKind;
}

function edgeConfidence(value: unknown, index: number): EdgeConfidence {
  if (typeof value !== "string") invalid(index, "'confidence' must be a string");
  if (!(EDGE_CONFIDENCES as readonly string[]).includes(value as string)) {
    invalid(index, `invalid confidence ${pyRepr(value as string)}; expected one of: ${EDGE_CONFIDENCES.join(", ")}`);
  }
  return value as EdgeConfidence;
}

function invalid(index: number, detail: string): never {
  throw new Error(`Invalid ${LINKS_FILE} [[link]] #${index}: ${detail}`);
}
