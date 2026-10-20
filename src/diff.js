// Structural comparison of two stored versions of one document, after GrasshopperDigestor's
// GhVersionDiff. Nodes are matched by nodeId (the GH InstanceGuid, stable across saves) and wires by
// their port pair. Settings/state changes come from the importer's gh.stateHash extension.

import { edgeKey, nodeKey, portKey } from "./canvas.js";

const STATE_HASH = "gh.stateHash";

export function diffGraphs(before, after) {
  const beforeNodes = byKey(before.nodes, (node) => node.nodeId);
  const afterNodes = byKey(after.nodes, (node) => node.nodeId);
  const beforePorts = portIdsByNode(before.ports);
  const afterPorts = portIdsByNode(after.ports);

  const changed = [];
  for (const node of after.nodes) {
    const old = beforeNodes.get(node.nodeId);
    if (!old) continue;
    const fields = changedFields(old, node, beforePorts.get(node.nodeId), afterPorts.get(node.nodeId));
    if (fields.length) changed.push({ before: old, after: node, fields });
  }

  const beforeEdges = byKey(before.edges, edgeKey);
  const afterEdges = byKey(after.edges, edgeKey);
  const afterPortIds = new Set(after.ports.map((port) => port.portId));
  const beforePortIds = new Set(before.ports.map((port) => port.portId));

  const diff = {
    added: after.nodes.filter((node) => !beforeNodes.has(node.nodeId)),
    removed: before.nodes.filter((node) => !afterNodes.has(node.nodeId)),
    changed,
    addedEdges: after.edges.filter((edge) => !beforeEdges.has(edgeKey(edge))),
    removedEdges: before.edges.filter((edge) => !afterEdges.has(edgeKey(edge))),
    addedPorts: after.ports.filter((port) => !beforePortIds.has(port.portId)),
    removedPorts: before.ports.filter((port) => !afterPortIds.has(port.portId)),
    // gh.stateHash is missing on documents imported before it existed; settings are then not compared.
    comparesState: [before, after].every((graph) => graph.nodes.some((node) => extension(node, STATE_HASH))),
  };
  diff.hasChanges = diff.added.length + diff.removed.length + diff.changed.length
    + diff.addedEdges.length + diff.removedEdges.length > 0;
  return diff;
}

/** The after graph plus everything the before graph had and the after graph lost, for one overlay drawing. */
export function overlayGraph(diff, before, after) {
  return {
    nodes: [...after.nodes, ...diff.removed],
    ports: [...after.ports, ...diff.removedPorts],
    edges: [...after.edges, ...diff.removedEdges],
  };
}

/** Element key (as used by the canvas and graph views) to "added" | "removed" | "changed". */
export function diffStatus(diff) {
  const status = new Map();
  for (const node of diff.added) status.set(nodeKey(node), "added");
  for (const node of diff.removed) status.set(nodeKey(node), "removed");
  for (const change of diff.changed) status.set(nodeKey(change.after), "changed");
  for (const port of diff.addedPorts) status.set(portKey(port), "added");
  for (const port of diff.removedPorts) status.set(portKey(port), "removed");
  for (const edge of diff.addedEdges) status.set(edgeKey(edge), "added");
  for (const edge of diff.removedEdges) status.set(edgeKey(edge), "removed");
  return status;
}

/** Markdown report in the layout of GhDiffReport.FormatMarkdown, with wires named down to the port. */
export function diffMarkdown(diff, before, after, beforeName, afterName) {
  const lines = [`# Version diff: ${beforeName} -> ${afterName}`, ""];
  if (!diff.hasChanges) {
    lines.push("No structural changes.");
    return lines.join("\n");
  }

  lines.push(
    "| Added | Removed | Changed | +Wires | -Wires |",
    "|------:|--------:|--------:|-------:|-------:|",
    `| ${diff.added.length} | ${diff.removed.length} | ${diff.changed.length} | ${diff.addedEdges.length} | ${diff.removedEdges.length} |`,
    "",
  );

  const section = (title, items, line) => {
    if (!items.length) return;
    lines.push(`## ${title}`, ...items.map(line), "");
  };
  section("Added", diff.added, (node) => `- **Added** ${nodeLabel(node)}`);
  section("Removed", diff.removed, (node) => `- **Removed** ${nodeLabel(node)}`);
  section("Changed", diff.changed, (change) => `- **Changed** ${nodeLabel(change.after)} [${change.fields.join("; ")}]`);
  section("Added connections", diff.addedEdges, (edge) => `- **Wired** ${wireLabel(edge, after)}`);
  section("Removed connections", diff.removedEdges, (edge) => `- **Unwired** ${wireLabel(edge, before)}`);
  if (!diff.comparesState) lines.push("_Settings/state not compared: re-import both versions to add gh.stateHash._", "");
  return lines.join("\n");
}

/** `Component Name "NickName" [abcd1234]`, the label GhDiffReport uses. */
export function nodeLabel(node) {
  if (!node) return "?";
  const name = node.name?.trim() || "?";
  const nick = node.nickName?.trim() && node.nickName !== name ? ` "${node.nickName}"` : "";
  return `${name}${nick} [${node.nodeId.slice(0, 8)}]`;
}

export function wireLabel(edge, graph) {
  const end = (portId, fallbackName) => {
    const port = graph.ports.find((item) => item.portId === portId);
    const node = port && graph.nodes.find((item) => item.nodeId === port.nodeId);
    const portName = port?.name || fallbackName;
    return node ? `${nodeLabel(node)}${portName && port.portId !== node.nodeId ? `.${portName}` : ""}` : portId.slice(0, 8);
  };
  return `${end(edge.sourcePortId, edge.sourceName)} -> ${end(edge.targetPortId, edge.targetName)}`;
}

function changedFields(a, b, portsA = new Set(), portsB = new Set()) {
  const fields = [];
  if (a.typeId !== b.typeId) fields.push(`Type (${a.name ?? a.typeId} -> ${b.name ?? b.typeId})`);
  if ((a.nickName ?? "") !== (b.nickName ?? "")) fields.push(`NickName ('${a.nickName ?? ""}' -> '${b.nickName ?? ""}')`);
  if (moved(a, b)) fields.push(`Position ((${round(a.x)},${round(a.y)}) -> (${round(b.x)},${round(b.y)}))`);
  if (Boolean(a.locked) !== Boolean(b.locked)) fields.push(b.locked ? "Locked" : "Unlocked");
  if ((a.source ?? "") !== (b.source ?? "")) fields.push("Script source");
  if ((a.text ?? "") !== (b.text ?? "")) fields.push("Text");
  const portsAdded = [...portsB].filter((id) => !portsA.has(id)).length;
  const portsRemoved = [...portsA].filter((id) => !portsB.has(id)).length;
  if (portsAdded || portsRemoved) fields.push(`Ports (+${portsAdded} -${portsRemoved})`);
  const hashA = extension(a, STATE_HASH);
  const hashB = extension(b, STATE_HASH);
  if (hashA && hashB && hashA !== hashB) fields.push("Settings/state");
  return fields;
}

// Same 0.5 canvas-unit tolerance as GhVersionDiff.
function moved(a, b) {
  if (!Number.isFinite(a.x) || !Number.isFinite(b.x)) return false;
  return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : "?";
}

function extension(entity, key) {
  return entity.extensions?.find((item) => item.key === key)?.value ?? null;
}

function portIdsByNode(ports) {
  const map = new Map();
  for (const port of ports) {
    if (!map.has(port.nodeId)) map.set(port.nodeId, new Set());
    map.get(port.nodeId).add(port.portId);
  }
  return map;
}

function byKey(items, keyFn) {
  return new Map(items.map((item) => [keyFn(item), item]));
}
