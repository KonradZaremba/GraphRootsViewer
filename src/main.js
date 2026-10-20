import { listDocuments, listVersions, loadDocument } from "./api.js";
import { GraphCanvas, edgeKey, nodeKey } from "./canvas.js";
import { diffGraphs, diffMarkdown, diffStatus, nodeLabel, overlayGraph, wireLabel } from "./diff.js";
import { GraphView } from "./graph-view.js";

const DEFAULT_API = "/graphql";

const apiUrlInput = document.querySelector("#api-url");
const apiStatus = document.querySelector("#api-status");
const refreshButton = document.querySelector("#refresh");
const docList = document.querySelector("#doc-list");
const docSummary = document.querySelector("#doc-summary");
const docFilter = document.querySelector("#doc-filter");
const inspector = document.querySelector("#inspector");
const inspectorTitle = document.querySelector("#inspector-title");
const graphMeta = document.querySelector("#graph-meta");
const canvasHint = document.querySelector("#canvas-hint");
const nodeFilter = document.querySelector("#node-filter");
const fitButton = document.querySelector("#fit");
const canvasWrap = document.querySelector(".canvas-wrap");
const viewHint = document.querySelector("#view-hint");
const viewCanvasButton = document.querySelector("#view-canvas");
const viewGraphButton = document.querySelector("#view-graph");
const compareSelect = document.querySelector("#compare-select");

const VIEW_KEY = "graphroots.viewMode";
const canvas = new GraphCanvas(document.querySelector("#canvas"));
const graphView = new GraphView(document.querySelector("#graph"));
const storedEdges = new Map();
let documents = [];
let activeKey = null;
let currentDocument = null;
let versions = [];
// { diff, before, after, overlay, status, changes } while a version comparison is drawn.
let comparison = null;
let viewMode = localStorage.getItem(VIEW_KEY) === "graph" ? "graph" : "canvas";

apiUrlInput.value = localStorage.getItem("graphroots.graphqlUrl") || DEFAULT_API;

canvas.onSelect = showSelection;
graphView.onSelect = showSelection;

function showSelection(selection) {
  if (!selection) {
    if (comparison) showComparison();
    else if (currentDocument) showDocument(currentDocument);
    return;
  }
  if (selection.type === "edge") {
    const edge = storedEdges.get(edgeKey(selection.value)) ?? selection.value;
    showEdge(edge);
    return;
  }
  if (selection.type === "node") {
    showNode(selection.value);
    return;
  }
  showEntity(capitalize(selection.type), selection.value);
}

refreshButton.addEventListener("click", () => refreshDocuments());
docFilter.addEventListener("input", () => renderDocumentList());
apiUrlInput.addEventListener("change", () => {
  localStorage.setItem("graphroots.graphqlUrl", apiUrlInput.value.trim());
  refreshDocuments();
});
nodeFilter.addEventListener("input", () => {
  canvas.setFilter(nodeFilter.value);
  graphView.setFilter(nodeFilter.value);
});
fitButton.addEventListener("click", () => activeView().fit());
viewCanvasButton.addEventListener("click", () => setViewMode("canvas"));
viewGraphButton.addEventListener("click", () => setViewMode("graph"));
compareSelect.addEventListener("change", () => compareWith(compareSelect.value));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") activeView().select(null);
});

setViewMode(viewMode);
refreshDocuments();

function activeView() {
  return viewMode === "graph" ? graphView : canvas;
}

function setViewMode(mode) {
  const previous = activeView();
  viewMode = mode === "graph" ? "graph" : "canvas";
  localStorage.setItem(VIEW_KEY, viewMode);
  canvasWrap.dataset.view = viewMode;
  const canvasOn = viewMode === "canvas";
  viewCanvasButton.classList.toggle("is-active", canvasOn);
  viewGraphButton.classList.toggle("is-active", !canvasOn);
  viewCanvasButton.setAttribute("aria-pressed", String(canvasOn));
  viewGraphButton.setAttribute("aria-pressed", String(!canvasOn));
  viewHint.textContent = canvasOn
    ? "Drag a node to move it"
    : "Click a node or edge to inspect · drag to pin · double-click to release";
  const incoming = activeView();
  if (previous !== incoming && previous.selectedKey) incoming.select(previous.selectedKey, true);
  if (incoming.needsFit) incoming.fit();
}

function apiUrl() {
  return apiUrlInput.value.trim() || DEFAULT_API;
}

async function refreshDocuments() {
  setStatus("idle", "Loading…");
  docSummary.textContent = "Loading…";
  try {
    const data = await listDocuments(apiUrl());
    documents = data.documents.nodes;
    setStatus("ok", `${data.documents.totalCount} documents`);
    renderDocumentList();
    if (!documents.length) {
      docSummary.textContent = "Database is empty. Import a GH/GHX file through GraphApi first.";
      clearGraph("No documents in the store.");
      showMessage("Properties", "Nothing to inspect yet.");
      return;
    }
    const next = documents.find((doc) => docKey(doc) === activeKey) ?? documents[0];
    await openDocument(next);
  } catch (error) {
    documents = [];
    setStatus("error", "API unreachable");
    docSummary.textContent = error.message;
    docList.replaceChildren();
    clearGraph("Could not reach GraphApi.");
    showMessage("Properties", error.message);
  }
}

function renderDocumentList() {
  const query = docFilter.value.trim().toLowerCase();
  const visible = query ? documents.filter((doc) => documentHaystack(doc).includes(query)) : documents;

  if (documents.length) {
    docSummary.textContent = query
      ? `${visible.length} of ${documents.length} definition${documents.length === 1 ? "" : "s"}`
      : `${documents.length} stored version${documents.length === 1 ? "" : "s"}`;
  }

  if (documents.length && !visible.length) {
    const empty = document.createElement("li");
    empty.className = "is-empty";
    empty.textContent = "No matching definitions.";
    docList.replaceChildren(empty);
    return;
  }

  docList.replaceChildren(
    ...visible.map((doc) => {
      const item = document.createElement("li");
      item.classList.toggle("is-active", docKey(doc) === activeKey);
      item.innerHTML = `
        <strong>${escapeHtml(doc.fileName || "Untitled document")}</strong>
        <small>${escapeHtml(shortId(doc.documentId))} · ${doc.stats.nodeCount} nodes · ${doc.stats.edgeCount} edges</small>
        <div class="badges">
          <span class="badge">${escapeHtml(doc.origin)}</span>
          ${doc.isNested ? '<span class="badge">nested</span>' : ""}
          ${doc.committed ? '<span class="badge">committed</span>' : ""}
        </div>
      `;
      item.addEventListener("click", () => openDocument(doc));
      return item;
    }),
  );
}

async function openDocument(doc) {
  activeKey = docKey(doc);
  comparison = null;
  renderDocumentList();
  canvasHint.textContent = "Loading graph…";
  canvasHint.classList.remove("is-hidden");
  try {
    const data = await loadDocument(apiUrl(), doc.documentId, doc.versionId);
    currentDocument = data.document;
    renderGraph(currentDocument.graph);
    canvasHint.classList.add("is-hidden");
    graphMeta.textContent = documentMeta(currentDocument);
    showDocument(currentDocument);
    await loadVersions(currentDocument);
  } catch (error) {
    clearGraph(error.message);
    showMessage("Properties", error.message);
  }
}

// Views get a copy: dragging on the canvas writes x/y into the node objects, and the stored graph
// must stay as loaded so a later comparison does not see the drag as a move.
function renderGraph(graph, status = new Map()) {
  const drawn = structuredClone(graph);
  storedEdges.clear();
  for (const edge of drawn.edges) {
    storedEdges.set(edgeKey(edge), edge);
  }
  canvas.setGraph(drawn);
  graphView.setGraph(drawn);
  canvas.setFilter(nodeFilter.value);
  graphView.setFilter(nodeFilter.value);
  for (const svg of [canvas.svg, graphView.svg]) applyDiff(svg, status);
  canvasWrap.dataset.compare = status.size ? "on" : "off";
  if (activeView().needsFit) activeView().fit();
}

function applyDiff(svg, status) {
  for (const el of svg.querySelectorAll("[data-key]")) {
    const state = status.get(el.dataset.key);
    for (const name of ["added", "removed", "changed"]) el.classList.toggle(`diff-${name}`, state === name);
  }
}

async function loadVersions(doc) {
  versions = [];
  try {
    const data = await listVersions(apiUrl(), doc.documentId);
    if (currentDocument !== doc) return;
    versions = data.documents.nodes
      .filter((version) => version.versionId !== doc.versionId)
      .sort((a, b) => (isOlder(a, b) ? 1 : isOlder(b, a) ? -1 : 0));
  } catch {
    // Comparison stays unavailable; the document itself is already shown.
  }
  const previous = versions.find((version) => isOlder(version, doc));
  const latest = versions[0] && isOlder(doc, versions[0]) ? versions[0] : null;
  compareSelect.replaceChildren(
    new Option(versions.length ? "No comparison" : "No other versions", ""),
    ...versions.map((version) => {
      const tag = version === previous ? " · previous" : version === latest ? " · latest" : "";
      return new Option(`${versionName(version)} · ${formatTime(version.fileLastWriteTimeUtc)}${tag}`, version.versionId);
    }),
  );
  compareSelect.disabled = !versions.length;
}

async function compareWith(versionId) {
  const doc = currentDocument;
  if (!doc) return;
  if (!versionId) {
    comparison = null;
    renderGraph(doc.graph);
    graphMeta.textContent = documentMeta(doc);
    showDocument(doc);
    return;
  }
  canvasHint.textContent = "Loading comparison…";
  canvasHint.classList.remove("is-hidden");
  try {
    const other = (await loadDocument(apiUrl(), doc.documentId, versionId)).document;
    if (currentDocument !== doc) return;
    const [before, after] = isOlder(other, doc) ? [other, doc] : [doc, other];
    const diff = diffGraphs(before.graph, after.graph);
    comparison = {
      diff,
      before,
      after,
      overlay: overlayGraph(diff, before.graph, after.graph),
      status: diffStatus(diff),
      changes: new Map(diff.changed.map((change) => [change.after.nodeId, change])),
    };
    renderGraph(comparison.overlay, comparison.status);
    canvasHint.classList.add("is-hidden");
    graphMeta.textContent = `+${diff.added.length} −${diff.removed.length} ~${diff.changed.length} · wires +${diff.addedEdges.length} −${diff.removedEdges.length}`;
    showComparison();
  } catch (error) {
    canvasHint.classList.add("is-hidden");
    showMessage("Comparison", error.message);
  }
}

function showComparison() {
  const { diff, before, after } = comparison;
  inspectorTitle.textContent = "Comparison";
  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copy as Markdown";
  copy.addEventListener("click", async () => {
    const markdown = diffMarkdown(diff, before.graph, after.graph, versionName(before), versionName(after));
    try {
      await navigator.clipboard.writeText(markdown);
      copy.textContent = "Copied";
    } catch {
      const pre = document.createElement("pre");
      pre.className = "markdown";
      pre.textContent = markdown;
      inspector.append(pre);
    }
  });
  inspector.replaceChildren(
    countsRow([
      ["Added", diff.added.length],
      ["Removed", diff.removed.length],
      ["Changed", diff.changed.length],
      ["+Wires", diff.addedEdges.length],
      ["−Wires", diff.removedEdges.length],
    ]),
    table({ before: `${versionName(before)} · ${formatTime(before.fileLastWriteTimeUtc)}`, after: `${versionName(after)} · ${formatTime(after.fileLastWriteTimeUtc)}` }),
    copy,
    ...(diff.hasChanges ? [] : [emptyNote("No structural changes.")]),
    ...changeSection("Added", "added", diff.added.map((node) => [nodeLabel(node), nodeKey(node)])),
    ...changeSection("Removed", "removed", diff.removed.map((node) => [nodeLabel(node), nodeKey(node)])),
    ...changeSection("Changed", "changed", diff.changed.map((change) => [`${nodeLabel(change.after)} — ${change.fields.join("; ")}`, nodeKey(change.after)])),
    ...changeSection("Added wires", "added", diff.addedEdges.map((edge) => [wireLabel(edge, after.graph), edgeKey(edge)])),
    ...changeSection("Removed wires", "removed", diff.removedEdges.map((edge) => [wireLabel(edge, before.graph), edgeKey(edge)])),
    ...(diff.comparesState ? [] : [emptyNote("Settings/state not compared: re-import both versions so nodes carry gh.stateHash.")]),
  );
}

function changeSection(title, state, items) {
  if (!items.length) return [];
  const list = document.createElement("ul");
  list.className = "change-list";
  for (const [label, key] of items) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `diff-${state}`;
    button.textContent = label;
    button.addEventListener("click", () => activeView().select(key));
    item.append(button);
    list.append(item);
  }
  return [heading(`${title} (${items.length})`), list];
}

function comparisonNote(key, nodeId) {
  if (!comparison) return [];
  const change = nodeId ? comparison.changes.get(nodeId) : null;
  return [
    heading("Comparison"),
    table({ status: comparison.status.get(key) ?? "unchanged", ...(change ? { changes: change.fields.join("; ") } : {}) }),
  ];
}

function documentMeta(doc) {
  return `${doc.stats.nodeCount} nodes · ${doc.stats.portCount} ports · ${doc.stats.edgeCount} edges`;
}

function versionName(doc) {
  return `${doc.fileName || "Untitled document"} [${doc.versionId.slice(0, 8)}]`;
}

function isOlder(a, b) {
  return (a.fileLastWriteTimeUtc ?? "") < (b.fileLastWriteTimeUtc ?? "");
}

function formatTime(value) {
  return value ? new Date(value).toLocaleString() : "unknown time";
}

function showDocument(doc) {
  inspectorTitle.textContent = "Document";
  inspector.replaceChildren(
    statsRow(doc.stats),
    heading("Identity"),
    table({
      fileName: doc.fileName,
      documentId: doc.documentId,
      versionId: doc.versionId,
      origin: doc.origin,
      committed: doc.committed,
      isNested: doc.isNested,
      filePath: doc.filePath,
      fileCreationTimeUtc: doc.fileCreationTimeUtc,
      fileLastWriteTimeUtc: doc.fileLastWriteTimeUtc,
    }),
    heading("Counts by kind"),
    table(Object.fromEntries((doc.stats.countsByKind ?? []).map((item) => [item.key, item.count]))),
    heading("Counts by type"),
    table(Object.fromEntries((doc.stats.countsByTypeId ?? []).map((item) => [item.key, item.count]))),
    heading("Libraries"),
    tableFromList(doc.libraries ?? [], (lib) => ({
      name: lib.name || lib.library?.name,
      libraryId: lib.libraryId,
      version: lib.version,
      assemblyVersion: lib.assemblyVersion,
      origin: lib.origin,
    })),
    heading("Extensions"),
    extensionsTable(doc.extensions),
  );
}

function showNode(node) {
  inspectorTitle.textContent = "Node";
  const { extensions, ...fields } = node;
  const ports = (comparison?.overlay.ports ?? currentDocument?.graph.ports ?? []).filter((port) => port.nodeId === node.nodeId);
  inspector.replaceChildren(
    ...comparisonNote(nodeKey(node), node.nodeId),
    heading("Node"),
    table(fields),
    heading("Ports"),
    tableFromList(ports, (port) => ({
      name: port.name,
      direction: port.direction,
      access: port.access,
      portId: port.portId,
    })),
    heading("Extensions"),
    extensionsTable(extensions),
  );
}

function showEdge(edge) {
  inspectorTitle.textContent = "Edge";
  const { extensions, ...fields } = edge;
  const ports = comparison?.overlay.ports ?? currentDocument?.graph.ports ?? [];
  const source = ports.find((port) => port.portId === edge.sourcePortId);
  const target = ports.find((port) => port.portId === edge.targetPortId);
  inspector.replaceChildren(
    ...comparisonNote(edgeKey(edge)),
    heading("Edge"),
    table({
      ...fields,
      sourceNodeId: source?.nodeId,
      targetNodeId: target?.nodeId,
    }),
    heading("Source port"),
    source ? table(source) : emptyNote("Unresolved"),
    heading("Target port"),
    target ? table(target) : emptyNote("Unresolved"),
    heading("Extensions"),
    extensionsTable(extensions),
  );
}

function showEntity(title, value) {
  inspectorTitle.textContent = title;
  const { extensions, ...fields } = value;
  inspector.replaceChildren(
    heading(title),
    table(fields),
    heading("Extensions"),
    extensionsTable(extensions),
  );
}

function showMessage(title, message) {
  inspectorTitle.textContent = title;
  inspector.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
}

function clearGraph(message) {
  currentDocument = null;
  comparison = null;
  versions = [];
  compareSelect.replaceChildren(new Option("No other versions", ""));
  compareSelect.disabled = true;
  canvasWrap.dataset.compare = "off";
  storedEdges.clear();
  canvas.clear();
  graphView.clear();
  graphMeta.textContent = "";
  canvasHint.textContent = message;
  canvasHint.classList.remove("is-hidden");
}

function setStatus(state, text) {
  apiStatus.dataset.state = state;
  apiStatus.textContent = text;
}

function statsRow(stats) {
  return countsRow([
    ["Nodes", stats.nodeCount],
    ["Ports", stats.portCount],
    ["Edges", stats.edgeCount],
  ]);
}

function countsRow(counts) {
  const wrap = document.createElement("div");
  wrap.className = "stats";
  for (const [label, value] of counts) {
    const item = document.createElement("div");
    item.className = "stat";
    item.innerHTML = `<b>${value}</b><span class="muted">${label}</span>`;
    wrap.append(item);
  }
  return wrap;
}

function heading(text) {
  const el = document.createElement("h3");
  el.textContent = text;
  return el;
}

function table(record) {
  if (!record || !Object.keys(record).length) return emptyNote("None");
  const el = document.createElement("table");
  el.className = "kv";
  el.innerHTML = Object.entries(record)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${formatCell(value)}</td></tr>`)
    .join("");
  return el;
}

function tableFromList(items, mapFn) {
  if (!items.length) return emptyNote("None");
  const wrap = document.createElement("div");
  for (const item of items) wrap.append(table(mapFn(item)));
  return wrap;
}

function extensionsTable(extensions) {
  if (!extensions?.length) return emptyNote("None");
  return table(Object.fromEntries(extensions.map((item) => [item.key, item.value])));
}

function emptyNote(text) {
  const el = document.createElement("p");
  el.className = "muted";
  el.textContent = text;
  return el;
}

function formatCell(value) {
  if (value == null || value === "") return "—";
  if (typeof value === "object") return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
  return escapeHtml(String(value));
}

function documentHaystack(doc) {
  return [
    doc.fileName,
    doc.filePath,
    doc.origin,
    doc.documentId,
    doc.versionId,
    doc.isNested ? "nested" : "",
    doc.committed ? "committed" : "",
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function docKey(doc) {
  return `${doc.documentId}:${doc.versionId}`;
}

function shortId(value) {
  return value.length > 12 ? `${value.slice(0, 8)}…` : value;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
