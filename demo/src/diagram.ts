/** Render upstream-compatible Mermaid diagrams to SVG with mermaid.js. */

import mermaid from "mermaid";

import { DIAGRAM_TYPES, renderDiagram, type DiagramType } from "../../src/diagram.js";
import type { QueryEngine } from "../../src/query/api.js";

export { DIAGRAM_TYPES };

const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "default", maxTextSize: 2_000_000, maxEdges: 5000 });

let counter = 0;

export async function renderMermaid(
  engine: QueryEngine,
  opts: { type: string; focus: string | null; depth: number; direction: "TB" | "LR" },
): Promise<{ source: string; svg: string }> {
  const warnings: string[] = [];
  const source = renderDiagram(
    engine,
    {
      diagramType: opts.type as DiagramType,
      focus: opts.focus,
      depth: opts.depth,
      direction: opts.direction,
      threshold: 10,
    },
    (line) => warnings.push(line),
  );
  const { svg } = await mermaid.render(`tm-diagram-${++counter}`, source);
  const note = warnings.length
    ? `<p class="muted">${warnings.map((w) => w.replace(/</g, "&lt;")).join("<br>")}</p>`
    : "";
  return { source, svg: note + svg };
}
