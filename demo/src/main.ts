import { carryOverAnnotations } from "../../src/analysis/carry-over.js";
import { supportedLanguages } from "../../src/parse.js";
import { indexedDbPersistence } from "../../src/persist/projects.js";
import { QueryEngine } from "../../src/query/api.js";
import type { JsonObject } from "../../src/query/dicts.js";
import { graphFromData } from "../../src/serialize.js";
import { DIAGRAM_TYPES, renderMermaid } from "./diagram.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import { SAMPLE_FILES, SAMPLE_ROOT } from "./sample.js";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );

const { projects } = indexedDbPersistence();
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const assetBase = new URL("./", document.baseURI).href;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
const send = (req: DistributiveOmit<WorkerRequest, "assetBase">) =>
  worker.postMessage({ ...req, assetBase } as WorkerRequest);

let engine: QueryEngine | null = null;
let projectId = "";
let selected: string | null = null;
/** Project id of the analysis currently running in the worker. */
let pendingProject = "";

// ---------------------------------------------------------------- controls

const languageSelect = $<HTMLSelectElement>("language");
languageSelect.innerHTML =
  `<option value="auto">Auto-detect</option>` +
  supportedLanguages()
    .map((l) => `<option value="${l}">${l}</option>`)
    .join("");

$("open").addEventListener("click", async () => {
  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (picker) {
    try {
      const handle = await picker.call(window);
      startAnalysis({ handle, projectId: handle.name });
    } catch (err) {
      if ((err as Error).name !== "AbortError") showStatus(String(err), "error");
    }
  } else {
    $<HTMLInputElement>("picker").click();
  }
});

$<HTMLInputElement>("picker").addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const list = Array.from(input.files ?? []);
  if (list.length === 0) return;
  const root = list[0]!.webkitRelativePath.split("/")[0] || "project";
  const skip = /(^|\/)(node_modules|\.git|dist|build|vendor|\.venv|venv)\//;
  const files = await Promise.all(
    list
      .filter((f) => !skip.test(f.webkitRelativePath))
      .map(async (f) => ({ path: f.webkitRelativePath.slice(root.length + 1), data: await f.arrayBuffer() })),
  );
  startAnalysis({ files, root, projectId: root });
  input.value = "";
});

$("clear-cache").addEventListener("click", () => send({ type: "clear-cache" }));

function analyzeSample(): void {
  const enc = new TextEncoder();
  const files = Object.entries(SAMPLE_FILES).map(([path, text]) => ({
    path,
    data: enc.encode(text).buffer as ArrayBuffer,
  }));
  languageSelect.value = "auto";
  startAnalysis({ files, root: SAMPLE_ROOT, projectId: SAMPLE_ROOT });
}
$("sample").addEventListener("click", analyzeSample);
if (new URLSearchParams(location.search).has("sample")) analyzeSample();

const projectSelect = $<HTMLSelectElement>("projects");
projectSelect.addEventListener("change", async () => {
  if (!projectSelect.value) return;
  const graph = await projects.load(projectSelect.value);
  if (graph) loadEngine(projectSelect.value, QueryEngine.fromGraph(graph));
});
$("delete-project").addEventListener("click", async () => {
  if (!projectId || !confirm(`Delete saved project "${projectId}"?`)) return;
  await projects.delete(projectId);
  projectId = "";
  engine = null;
  $("app").hidden = true;
  $("empty").hidden = false;
  await refreshProjects();
});

async function refreshProjects(): Promise<void> {
  const metas = await projects.list();
  projectSelect.innerHTML =
    `<option value="">Saved projects (${metas.length})</option>` +
    metas
      .map(
        (m) =>
          `<option value="${esc(m.id)}" ${m.id === projectId ? "selected" : ""}>${esc(m.name)} · ${m.nodeCount} nodes</option>`,
      )
      .join("");
  $<HTMLButtonElement>("delete-project").disabled = !projectId;
}

// ---------------------------------------------------------------- analysis

function startAnalysis(req: {
  projectId: string;
  handle?: FileSystemDirectoryHandle;
  files?: { path: string; data: ArrayBuffer }[];
  root?: string;
}) {
  showStatus("Starting…");
  pendingProject = req.projectId;
  send({ type: "analyze", language: languageSelect.value, ...req });
}

worker.onmessage = async (e: MessageEvent<WorkerResponse>) => {
  const msg = e.data;
  if (msg.type === "status") showStatus(msg.message, msg.message.includes("cleared") ? "done" : "busy");
  else if (msg.type === "progress") showStatus(`${msg.done} files (${msg.cached} from cache) · ${msg.filePath}`);
  else if (msg.type === "error") showStatus(msg.message, "error");
  else if (msg.type === "done") {
    const graph = graphFromData(msg.graph);
    // Keep annotations from the previous analysis of this project.
    const previous = await projects.load(pendingProject);
    const kept = previous === undefined ? null : carryOverAnnotations(previous, graph);
    await projects.save(pendingProject, graph, pendingProject);
    const orphaned = kept === null ? 0 : [...kept.orphaned.values()].reduce((n, list) => n + list.length, 0);
    const notes =
      kept === null || kept.carried + orphaned === 0
        ? ""
        : ` · kept ${kept.carried} annotation(s)` +
          (orphaned > 0 ? `, ${orphaned} on nodes that no longer exist (kept in case they return)` : "");
    showStatus(
      `Parsed ${msg.files} files in ${(msg.elapsedMs / 1000).toFixed(1)}s (${msg.cached} from cache) · ${graph.nodes.size} nodes, ${graph.edges.length} edges${notes}`,
      "done",
    );
    loadEngine(pendingProject, QueryEngine.fromGraph(graph));
  }
};

function showStatus(text: string, state: "busy" | "done" | "error" = "busy"): void {
  const el = $("status");
  el.hidden = false;
  el.classList.toggle("done", state !== "busy");
  el.querySelector("p")!.textContent = text;
  (el.querySelector(".progress") as HTMLElement).style.visibility = state === "error" ? "hidden" : "visible";
}

async function persist(): Promise<void> {
  if (engine && projectId) await projects.save(projectId, engine.graph, projectId);
}

function loadEngine(id: string, next: QueryEngine): void {
  engine = next;
  projectId = id;
  selected = null;
  $("empty").hidden = true;
  $("app").hidden = false;
  renderOverview();
  renderResults("");
  $("detail").innerHTML = `<p class="muted">Select a node.</p>`;
  void refreshProjects();
}

// ---------------------------------------------------------------- tabs

document
  .querySelectorAll<HTMLButtonElement>(".tabs button")
  .forEach((btn) => btn.addEventListener("click", () => showTab(btn.dataset["tab"]!)));
function showTab(tab: string): void {
  document
    .querySelectorAll<HTMLButtonElement>(".tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset["tab"] === tab));
  document.querySelectorAll<HTMLElement>(".tab").forEach((s) => (s.hidden = s.id !== `tab-${tab}`));
}

const nodeLink = (id: string) => `<a class="node" data-node="${esc(id)}">${esc(id)}</a>`;
document.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("a.node");
  if (a?.dataset["node"]) {
    showTab("explore");
    selectNode(a.dataset["node"]);
  }
});

// ---------------------------------------------------------------- overview

function renderOverview(): void {
  if (!engine) return;
  const s = engine.summary();
  const card = (label: string, value: unknown) => `<div class="card"><b>${esc(value)}</b><span>${label}</span></div>`;
  $("summary").innerHTML =
    card("nodes", s["total_nodes"]) +
    card("functions", s["functions"]) +
    card("classes", s["classes"]) +
    card("call edges", s["call_edges"]) +
    card("entrypoints", s["entrypoints"]) +
    card("unresolved proxies", s["proxies"]) +
    card("language", engine.graph.language);

  const surface = engine.attackSurface();
  $("surface").innerHTML = surface.length
    ? `<div class="table-wrap"><table><tr><th>Entrypoint</th><th>Kind</th><th>Trust</th><th>Asset</th></tr>${surface
        .map(
          (e) =>
            `<tr><td>${nodeLink(String(e["node_id"]))}${e["description"] ? `<div class="muted">${esc(e["description"])}</div>` : ""}</td><td>${esc(e["kind"])}</td><td>${esc(e["trust_level"])}</td><td>${esc(e["asset_value"])}</td></tr>`,
        )
        .join("")}</table></div>`
    : `<p class="muted">No entrypoints detected.</p>`;

  const hot = engine.complexityHotspots(5).slice(0, 50);
  $("hotspots").innerHTML = hot.length
    ? `<div class="table-wrap"><table><tr><th>Function</th><th>Location</th><th class="num">CC</th></tr>${hot
        .map(
          (u) =>
            `<tr><td>${nodeLink(String(u["id"]))}</td><td class="muted mono">${esc(loc(u))}</td><td class="num">${esc(u["cyclomatic_complexity"])}</td></tr>`,
        )
        .join("")}</table></div>`
    : `<p class="muted">Nothing with complexity ≥ 5.</p>`;
}

function loc(u: JsonObject): string {
  const l = u["location"] as JsonObject;
  return `${l["file_path"]}:${l["start_line"]}`;
}

// ---------------------------------------------------------------- explore

$<HTMLInputElement>("search").addEventListener("input", (e) => renderResults((e.target as HTMLInputElement).value));

function renderResults(query: string): void {
  if (!engine) return;
  const q = query.trim().toLowerCase();
  const items: string[] = [];
  for (const unit of engine.graph.nodes.values()) {
    if (unit.kind === "module" || unit.kind === "proxy") continue;
    if (q && !unit.id.toLowerCase().includes(q)) continue;
    items.push(
      `<li data-node="${esc(unit.id)}" class="${unit.id === selected ? "sel" : ""}"><span class="id">${esc(unit.id)}</span><span class="pill">${unit.kind}</span></li>`,
    );
    if (items.length >= 300) break;
  }
  $("results").innerHTML = items.join("") || `<li class="muted">No matches</li>`;
}
$("results").addEventListener("click", (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>("li[data-node]");
  if (li) selectNode(li.dataset["node"]!);
});

function selectNode(id: string): void {
  if (!engine) return;
  selected = id;
  document
    .querySelectorAll("#results li")
    .forEach((li) => li.classList.toggle("sel", (li as HTMLElement).dataset["node"] === id));
  const unit = engine.graph.nodes.get(id);
  if (!unit) return;
  const list = (units: JsonObject[], empty: string) =>
    units.length
      ? `<ul>${units.map((u) => `<li>${nodeLink(String(u["id"]))}</li>`).join("")}</ul>`
      : `<p class="muted">${empty}</p>`;
  const callers = engine.callersOf(id);
  const callees = engine.calleesOf(id);
  const reach = engine.reachableFrom(id).length;
  const ancestors = engine.ancestorsOf(id).length;
  const paths = engine.entrypointPathsTo(id, 8).slice(0, 20);
  const anns = engine.annotationsOf(id);
  const tag = engine.graph.entrypoints.get(id);
  $("detail").innerHTML = `
    <h3>${esc(unit.id)}</h3>
    <span class="pill">${unit.kind}</span> ${tag ? `<span class="pill">entrypoint · ${esc(tag.trustLevel)}</span>` : ""}
    <dl class="kv">
      <dt>Location</dt><dd class="mono">${esc(unit.location.filePath)}:${unit.location.startLine}–${unit.location.endLine}</dd>
      ${unit.parameters.length ? `<dt>Parameters</dt><dd class="mono">${esc(unit.parameters.map((p) => p.name + (p.typeRef ? `: ${p.typeRef.name}` : "")).join(", "))}</dd>` : ""}
      ${unit.returnType ? `<dt>Returns</dt><dd class="mono">${esc(unit.returnType.name)}</dd>` : ""}
      ${unit.cyclomaticComplexity !== null ? `<dt>Complexity</dt><dd>${unit.cyclomaticComplexity}</dd>` : ""}
      ${unit.exceptionTypes.length ? `<dt>Raises</dt><dd class="mono">${esc(unit.exceptionTypes.map((t) => t.name).join(", "))}</dd>` : ""}
      <dt>Reachability</dt><dd>${ancestors} upstream · ${reach} downstream</dd>
      ${unit.docstring ? `<dt>Doc</dt><dd>${esc(unit.docstring)}</dd>` : ""}
    </dl>
    <section><h2>Callers (${callers.length})</h2>${list(callers, "No callers.")}</section>
    <section><h2>Callees (${callees.length})</h2>${list(callees, "No callees.")}</section>
    <section><h2>Entrypoint paths</h2>${
      paths.length
        ? `<ul>${paths.map((p) => `<li>${p.map(nodeLink).join(" → ")}</li>`).join("")}</ul>`
        : `<p class="muted">No entrypoint reaches this node.</p>`
    }</section>
    <section><h2>Annotations</h2>${
      anns.length
        ? `<ul>${anns.map((a) => `<li><span class="pill">${esc(a["kind"])}</span> ${esc(a["description"])} <span class="muted">(${esc(a["source"])})</span></li>`).join("")}</ul>`
        : `<p class="muted">None yet.</p>`
    }
      <form class="annotate" id="annotate">
        <select name="kind">${["assumption", "precondition", "postcondition", "invariant", "finding", "audit_note"].map((k) => `<option>${k}</option>`).join("")}</select>
        <input name="description" placeholder="Note…" required />
        <button class="primary">Add</button>
      </form>
    </section>
    <section><button id="focus-diagram">Show call graph around this node</button></section>`;
  $("annotate").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = new FormData(e.target as HTMLFormElement);
    engine!.annotate(id, form.get("kind") as never, String(form.get("description")), "manual");
    await persist();
    selectNode(id);
  });
  $("focus-diagram").addEventListener("click", () => {
    $<HTMLSelectElement>("diagram-type").value = "call-graph";
    $<HTMLInputElement>("diagram-focus").value = id;
    showTab("diagram");
    void renderDiagram();
  });
}

// ---------------------------------------------------------------- diagram

$<HTMLSelectElement>("diagram-type").innerHTML = DIAGRAM_TYPES.map((t) => `<option>${t}</option>`).join("");
$("render").addEventListener("click", () => void renderDiagram());

async function renderDiagram(): Promise<void> {
  if (!engine) return;
  const out = $("diagram");
  try {
    const { source, svg } = await renderMermaid(engine, {
      type: $<HTMLSelectElement>("diagram-type").value,
      focus: $<HTMLInputElement>("diagram-focus").value.trim() || null,
      depth: Number($<HTMLInputElement>("diagram-depth").value) || 2,
      direction: $<HTMLSelectElement>("diagram-direction").value as "TB" | "LR",
    });
    $("diagram-src").textContent = source;
    out.innerHTML = svg;
  } catch (err) {
    out.innerHTML = `<p class="muted">${esc((err as Error).message)}</p>`;
  }
}

void refreshProjects();
