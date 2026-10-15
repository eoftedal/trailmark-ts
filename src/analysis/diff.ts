/**
 * Structural diff between two Trailmark code graphs.
 *
 * Used by the ``trailmark diff`` CLI and programmatically via
 * ``QueryEngine.diffAgainst``. Operates on ``CodeGraph`` objects directly, so
 * callers don't have to export to JSON first.
 *
 * Produces a security-oriented diff: what nodes, edges, and entrypoints changed
 * between two snapshots. Designed for PR-review / release-audit workflows where
 * "did my attack surface change?" is the question.
 *
 * (Upstream's ``git_worktree`` helper is Node/CLI-only and lives with the CLI.)
 */

import { pyCompare } from "../fs/source.js";
import type { EntrypointTag } from "../models/annotations.js";
import type { CodeEdge } from "../models/edges.js";
import type { CodeGraph } from "../models/graph.js";
import type { CodeUnit } from "../models/nodes.js";
import type { Json, JsonObject } from "../query/dicts.js";

/**
 * Return a structured diff between two graphs.
 *
 * Fields:
 * - ``summary_delta``: counts (nodes, edges, entrypoints) with before/after/delta.
 * - ``nodes``: ``{added, removed, modified}`` node entries.
 * - ``edges``: ``{added, removed}`` edge entries.
 * - ``entrypoints``: ``{added, removed, modified}`` entrypoint entries with trust/asset before/after.
 */
export function computeDiff(before: CodeGraph, after: CodeGraph): JsonObject {
  return {
    summary_delta: diffSummary(before, after),
    nodes: diffNodes(before, after),
    edges: diffEdges(before, after),
    entrypoints: diffEntrypoints(before, after),
  };
}

function diffSummary(before: CodeGraph, after: CodeGraph): JsonObject {
  const metrics: [string, number, number][] = [
    ["nodes", before.nodes.size, after.nodes.size],
    ["edges", before.edges.length, after.edges.length],
    ["entrypoints", before.entrypoints.size, after.entrypoints.size],
  ];
  const delta: JsonObject = {};
  for (const [key, b, a] of metrics) {
    if (b !== a) delta[key] = { before: b, after: a, delta: a - b };
  }
  return delta;
}

function setDiff(a: Iterable<string>, b: { has(x: string): boolean }): string[] {
  return [...a].filter((x) => !b.has(x)).sort(pyCompare);
}

function diffNodes(before: CodeGraph, after: CodeGraph): JsonObject {
  const addedIds = setDiff(after.nodes.keys(), before.nodes);
  const removedIds = setDiff(before.nodes.keys(), after.nodes);
  const sharedIds = [...before.nodes.keys()].filter((id) => after.nodes.has(id)).sort(pyCompare);

  const modified: JsonObject[] = [];
  for (const nid of sharedIds) {
    const changes = compareUnits(before.nodes.get(nid)!, after.nodes.get(nid)!);
    if (Object.keys(changes).length > 0) modified.push({ id: nid, changes });
  }

  return {
    added: addedIds.map((n) => unitSummary(after.nodes.get(n)!)),
    removed: removedIds.map((n) => unitSummary(before.nodes.get(n)!)),
    modified,
  };
}

function unitSummary(unit: CodeUnit): JsonObject {
  return {
    id: unit.id,
    name: unit.name,
    kind: unit.kind,
    file: unit.location.filePath,
    cyclomatic_complexity: unit.cyclomaticComplexity,
  };
}

function compareUnits(before: CodeUnit, after: CodeUnit): JsonObject {
  const changes: JsonObject = {};
  if (before.cyclomaticComplexity !== after.cyclomaticComplexity) {
    changes["cyclomatic_complexity"] = { before: before.cyclomaticComplexity, after: after.cyclomaticComplexity };
  }
  const bParams = before.parameters.map((p) => p.name);
  const aParams = after.parameters.map((p) => p.name);
  if (bParams.length !== aParams.length || bParams.some((p, i) => p !== aParams[i])) {
    changes["parameters"] = { before: bParams, after: aParams };
  }
  const bSpan = Math.max(0, before.location.endLine - before.location.startLine + 1);
  const aSpan = Math.max(0, after.location.endLine - after.location.startLine + 1);
  if (bSpan !== aSpan) changes["line_span"] = { before: bSpan, after: aSpan };
  return changes;
}

function diffEdges(before: CodeGraph, after: CodeGraph): JsonObject {
  const beforeSet = new Set(before.edges.map(edgeKey));
  const afterSet = new Set(after.edges.map(edgeKey));
  return {
    added: setDiff(afterSet, beforeSet).map(parseEdgeKey),
    removed: setDiff(beforeSet, afterSet).map(parseEdgeKey),
  };
}

function edgeKey(edge: CodeEdge): string {
  return `${edge.sourceId}|${edge.targetId}|${edge.kind}`;
}

/** ``key.split("|", 2)``: the kind part keeps any extra separators. */
function parseEdgeKey(key: string): JsonObject {
  const i = key.indexOf("|");
  const j = key.indexOf("|", i + 1);
  return { source: key.slice(0, i), target: key.slice(i + 1, j), kind: key.slice(j + 1) };
}

function diffEntrypoints(before: CodeGraph, after: CodeGraph): JsonObject {
  const addedIds = setDiff(after.entrypoints.keys(), before.entrypoints);
  const removedIds = setDiff(before.entrypoints.keys(), after.entrypoints);
  const sharedIds = [...before.entrypoints.keys()].filter((id) => after.entrypoints.has(id)).sort(pyCompare);

  const modified: JsonObject[] = [];
  for (const nid of sharedIds) {
    const bTag = before.entrypoints.get(nid)!;
    const aTag = after.entrypoints.get(nid)!;
    if (
      bTag.kind !== aTag.kind ||
      bTag.trustLevel !== aTag.trustLevel ||
      bTag.description !== aTag.description ||
      bTag.assetValue !== aTag.assetValue
    ) {
      modified.push({ id: nid, before: epSummary(bTag), after: epSummary(aTag) });
    }
  }

  return {
    added: addedIds.map((nid) => ({ id: nid, ...epSummary(after.entrypoints.get(nid)!) })),
    removed: removedIds.map((nid) => ({ id: nid, ...epSummary(before.entrypoints.get(nid)!) })),
    modified,
  };
}

function epSummary(tag: EntrypointTag): JsonObject {
  return {
    kind: tag.kind,
    trust_level: tag.trustLevel,
    asset_value: tag.assetValue,
    description: tag.description,
  };
}

/** Python ``str()``/f-string rendering of a JSON value. */
function fmt(value: Json | undefined): string {
  if (value === null || value === undefined) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  return String(value);
}

function obj(value: Json | undefined): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function arr(value: Json | undefined): JsonObject[] {
  return Array.isArray(value) ? (value as JsonObject[]) : [];
}

/** Render a structured diff as a human-readable report. */
export function formatDiff(diff: JsonObject): string {
  const lines: string[] = [];

  const summary = obj(diff["summary_delta"]);
  if (Object.keys(summary).length > 0) {
    lines.push("Summary:");
    for (const key of ["nodes", "edges", "entrypoints"]) {
      if (key in summary) {
        const s = obj(summary[key]);
        const sign = (s["delta"] as number) >= 0 ? "+" : "";
        lines.push(`  ${key}: ${fmt(s["before"])} -> ${fmt(s["after"])} (${sign}${fmt(s["delta"])})`);
      }
    }
    lines.push("");
  }

  const nodes = obj(diff["nodes"]);
  const addedNodes = arr(nodes["added"]);
  const removedNodes = arr(nodes["removed"]);
  const modifiedNodes = arr(nodes["modified"]);

  if (addedNodes.length > 0) {
    lines.push(`Added nodes (${addedNodes.length}):`);
    for (const n of addedNodes.slice(0, 20)) lines.push(`  + ${fmt(n["id"])}  (${fmt(n["kind"])}, ${fmt(n["file"])})`);
    if (addedNodes.length > 20) lines.push(`  ... and ${addedNodes.length - 20} more`);
    lines.push("");
  }

  if (removedNodes.length > 0) {
    lines.push(`Removed nodes (${removedNodes.length}):`);
    for (const n of removedNodes.slice(0, 20)) {
      lines.push(`  - ${fmt(n["id"])}  (${fmt(n["kind"])}, ${fmt(n["file"])})`);
    }
    if (removedNodes.length > 20) lines.push(`  ... and ${removedNodes.length - 20} more`);
    lines.push("");
  }

  if (modifiedNodes.length > 0) {
    lines.push(`Modified nodes (${modifiedNodes.length}):`);
    for (const m of modifiedNodes.slice(0, 20)) {
      const changes = obj(m["changes"]);
      lines.push(`  ~ ${fmt(m["id"])}  (${Object.keys(changes).join(", ")})`);
      if ("cyclomatic_complexity" in changes) {
        const cc = obj(changes["cyclomatic_complexity"]);
        lines.push(`      complexity: ${fmt(cc["before"])} -> ${fmt(cc["after"])}`);
      }
    }
    if (modifiedNodes.length > 20) lines.push(`  ... and ${modifiedNodes.length - 20} more`);
    lines.push("");
  }

  const eps = obj(diff["entrypoints"]);
  const addedEps = arr(eps["added"]);
  const removedEps = arr(eps["removed"]);
  const modifiedEps = arr(eps["modified"]);

  if (addedEps.length > 0 || removedEps.length > 0 || modifiedEps.length > 0) {
    lines.push("Attack surface:");
    for (const ep of addedEps) {
      lines.push(
        `  + entrypoint ${fmt(ep["id"])}  ` +
          `(${fmt(ep["kind"])}, trust=${fmt(ep["trust_level"])}, asset=${fmt(ep["asset_value"])})`,
      );
    }
    for (const ep of removedEps) {
      lines.push(
        `  - entrypoint ${fmt(ep["id"])}  ` +
          `(${fmt(ep["kind"])}, trust=${fmt(ep["trust_level"])}, asset=${fmt(ep["asset_value"])})`,
      );
    }
    for (const m of modifiedEps) {
      lines.push(`  ~ entrypoint ${fmt(m["id"])}`);
      const b = obj(m["before"]);
      const a = obj(m["after"]);
      if (b["trust_level"] !== a["trust_level"]) {
        lines.push(`      trust: ${fmt(b["trust_level"])} -> ${fmt(a["trust_level"])}`);
      }
      if (b["asset_value"] !== a["asset_value"]) {
        lines.push(`      asset: ${fmt(b["asset_value"])} -> ${fmt(a["asset_value"])}`);
      }
    }
    lines.push("");
  }

  const edges = obj(diff["edges"]);
  const addedEdges = arr(edges["added"]);
  const removedEdges = arr(edges["removed"]);
  if (addedEdges.length > 0 || removedEdges.length > 0) {
    lines.push(`Edges: +${addedEdges.length}  -${removedEdges.length}`);
    lines.push("");
  }

  if (lines.length === 0) return "No structural changes.";
  return lines.join("\n").trimEnd();
}
