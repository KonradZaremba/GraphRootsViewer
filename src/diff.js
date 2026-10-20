// Presentation of GraphApi's compareDocuments result: resolves its keys against the two loaded graphs,
// turns the structured changes into labels, and builds the overlay drawing and the Markdown report.
// The comparison itself runs server-side (GraphDb DocumentComparer).
//
// Origin: GrasshopperDigestor (GraphHop, https://github.com/graphhop/GrasshopperDigestor). The labels and
// report layout follow GhVersionDiff.cs and GhDiffReport.FormatMarkdown in SharedRhino/, Konrad Zaremba's
// modification in his copy of that project (https://github.com/KonradZaremba/GrasshopperDigestor).

import { edgeKey, nodeKey, portKey } from "./canvas.js";

const STATE_HASH = "gh.stateHash";

/** The viewer's diff model from a compareDocuments result and the before/after graphs it refers to. */
export function fromComparison(result, before, after) {
  const beforeNodes = byKey(before.nodes, (node) => node.nodeId);
  const afterNodes = byKey(after.nodes, (node) => node.nodeId);
  const resolve = (items, graph, keyFn) => {
    const index = byKey(graph, keyFn);
    return items.map((item) => index.get(keyFn(item))).filter(Boolean);
  };
  // gh.stateHash is missing on documents imported before it existed; settings are then not compared.
  const comparesState = [before, after].every((graph) => graph.nodes.some((node) => extension(node, STATE_HASH)));

  const changed = result.changedNodes
    .map((change) => {
      const old = beforeNodes.get(change.after.nodeId);
      const node = afterNodes.get(change.after.nodeId);
      return { before: old, after: node, fields: change.changes.map((field) => fieldLabel(field, comparesState, old, node)).filter(Boolean) };
    })
    .filter((change) => change.before && change.after && change.fields.length);

  const diff = {
    added: resolve(result.addedNodes, after.nodes, (node) => node.nodeId),
    removed: resolve(result.removedNodes, before.nodes, (node) => node.nodeId),
    changed,
    addedPorts: resolve(result.addedPorts, after.ports, (port) => port.portId),
    removedPorts: resolve(result.removedPorts, before.ports, (port) => port.portId),
    addedEdges: resolve(result.addedEdges, after.edges, edgeKey),
    removedEdges: resolve(result.removedEdges, before.edges, edgeKey),
    comparesState,
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

// Labels in GhVersionDiff's wording. Returns null for a change the viewer does not show.
function fieldLabel({ kind, key, before, after }, comparesState, oldNode, newNode) {
  switch (kind) {
    case "TYPE":
      return `Type (${oldNode?.name ?? before} -> ${newNode?.name ?? after})`;
    case "NICK_NAME":
      return `NickName ('${before ?? ""}' -> '${after ?? ""}')`;
    case "POSITION":
      return `Position ((${round(before?.x)},${round(before?.y)}) -> (${round(after?.x)},${round(after?.y)}))`;
    case "LOCKED":
      return after ? "Locked" : "Unlocked";
    case "SOURCE":
      return "Script source";
    case "TEXT":
      return "Text";
    case "PORTS": {
      const added = (after ?? []).filter((id) => !(before ?? []).includes(id)).length;
      const removed = (before ?? []).filter((id) => !(after ?? []).includes(id)).length;
      return `Ports (+${added} -${removed})`;
    }
    case "EXTENSION":
      if (key !== STATE_HASH) return `Extension ${key}`;
      return comparesState && before != null && after != null ? "Settings/state" : null;
    default:
      return kind;
  }
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value) : "?";
}

function extension(entity, key) {
  return entity.extensions?.find((item) => item.key === key)?.value ?? null;
}

function byKey(items, keyFn) {
  return new Map(items.map((item) => [keyFn(item), item]));
}
