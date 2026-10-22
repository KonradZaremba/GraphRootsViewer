// Unit tests for the DOM-free comparison logic. No server needed; these always run.

import assert from "node:assert/strict";
import { test } from "node:test";
import { edgeKey, nodeKey, portKey } from "../src/canvas.js";
import { diffMarkdown, diffStatus, fromComparison, nodeLabel, overlayGraph, wireLabel } from "../src/diff.js";
import { compareVersions, describeVersions, isOlder, sortNewestFirst } from "../src/versions.js";

const id = (n) => `${String(n).padStart(8, "0")}-0000-0000-0000-000000000000`;
const stateExt = (value) => [{ key: "gh.stateHash", value }];

const node = (n, name, extra = {}) => ({ nodeId: id(n), name, nickName: name, extensions: stateExt("h"), ...extra });
const port = (n, nodeN, name = "P") => ({ portId: id(n), nodeId: id(nodeN), name });
const edge = (s, t) => ({ sourcePortId: id(s), targetPortId: id(t) });

// before: A(1) -> B(2) via ports 11 -> 22; C(3) with port 33; wire 22 -> 33.
const before = {
  nodes: [node(1, "A"), node(2, "B"), node(3, "C")],
  ports: [port(11, 1, "out"), port(22, 2, "in"), port(23, 2, "out"), port(33, 3, "in")],
  edges: [edge(11, 22), edge(23, 33)],
};
// after: C removed; D(4) added; B changed; wire 11 -> 22 kept, 23 -> 33 removed, 11 -> 44 added.
const after = {
  nodes: [node(1, "A"), node(2, "B", { nickName: "Bee" }), node(4, "D")],
  ports: [port(11, 1, "out"), port(22, 2, "in"), port(23, 2, "out"), port(44, 4, "in")],
  edges: [edge(11, 22), edge(11, 44)],
};
const result = {
  addedNodes: [{ nodeId: id(4) }],
  removedNodes: [{ nodeId: id(3) }],
  changedNodes: [{ after: { nodeId: id(2) }, changes: [{ kind: "NICK_NAME", key: null, before: "B", after: "Bee" }] }],
  addedPorts: [{ portId: id(44) }],
  removedPorts: [{ portId: id(33) }],
  addedEdges: [edge(11, 44)],
  removedEdges: [edge(23, 33)],
};

test("fromComparison resolves added, removed and changed nodes against the right graph", () => {
  const diff = fromComparison(result, before, after);
  assert.deepEqual(diff.added.map((n) => n.name), ["D"]);
  assert.deepEqual(diff.removed.map((n) => n.name), ["C"]);
  assert.equal(diff.changed.length, 1);
  assert.equal(diff.changed[0].before.nickName, "B");
  assert.equal(diff.changed[0].after.nickName, "Bee");
  assert.deepEqual(diff.changed[0].fields, ["NickName ('B' -> 'Bee')"]);
  assert.equal(diff.hasChanges, true);
  assert.equal(diff.comparesState, true);
});

test("fromComparison resolves wires and ports, and drops keys unknown to the graphs", () => {
  const diff = fromComparison({ ...result, addedNodes: [{ nodeId: id(99) }], addedEdges: [edge(11, 44), edge(98, 99)] }, before, after);
  assert.deepEqual(diff.added, []);
  assert.equal(diff.addedEdges.length, 1);
  assert.equal(diff.addedEdges[0].targetPortId, id(44));
  assert.deepEqual(diff.removedEdges.map(edgeKey), [edgeKey(edge(23, 33))]);
  assert.deepEqual(diff.addedPorts.map((p) => p.portId), [id(44)]);
  assert.deepEqual(diff.removedPorts.map((p) => p.portId), [id(33)]);
});

test("fromComparison reports no changes for an empty result", () => {
  const empty = { addedNodes: [], removedNodes: [], changedNodes: [], addedPorts: [], removedPorts: [], addedEdges: [], removedEdges: [] };
  assert.equal(fromComparison(empty, before, before).hasChanges, false);
});

test("overlayGraph adds the removed elements to the after graph", () => {
  const diff = fromComparison(result, before, after);
  const overlay = overlayGraph(diff, after);
  assert.deepEqual(overlay.nodes.map((n) => n.name), ["A", "B", "D", "C"]);
  assert.deepEqual(overlay.ports.map((p) => p.portId), [id(11), id(22), id(23), id(44), id(33)]);
  assert.deepEqual(overlay.edges.map(edgeKey), [edgeKey(edge(11, 22)), edgeKey(edge(11, 44)), edgeKey(edge(23, 33))]);
  assert.equal(after.nodes.length, 3, "the after graph is not modified");
  const status = diffStatus(diff);
  assert.equal(status.get(nodeKey({ nodeId: id(3) })), "removed");
  assert.equal(status.get(portKey({ portId: id(33) })), "removed");
  assert.equal(status.get(edgeKey(edge(23, 33))), "removed");
});

test("diffStatus maps element keys to added, removed or changed", () => {
  const status = diffStatus(fromComparison(result, before, after));
  assert.equal(status.get(`node:${id(4)}`), "added");
  assert.equal(status.get(`node:${id(3)}`), "removed");
  assert.equal(status.get(`node:${id(2)}`), "changed");
  assert.equal(status.get(`port:${id(44)}`), "added");
  assert.equal(status.get(`port:${id(33)}`), "removed");
  assert.equal(status.get(`edge:${id(11)}:${id(44)}`), "added");
  assert.equal(status.get(`edge:${id(23)}:${id(33)}`), "removed");
  assert.equal(status.has(`node:${id(1)}`), false);
  assert.equal(status.size, 7);
});

test("diffMarkdown lays out the summary table and the sections", () => {
  const diff = fromComparison(result, before, after);
  const lines = diffMarkdown(diff, before, after, "v1", "v2").split("\n");
  assert.equal(lines[0], "# Version diff: v1 -> v2");
  assert.equal(lines[2], "| Added | Removed | Changed | +Wires | -Wires |");
  assert.equal(lines[3], "|------:|--------:|--------:|-------:|-------:|");
  assert.equal(lines[4], "| 1 | 1 | 1 | 1 | 1 |");
  assert.equal(lines[5], "");
  assert.deepEqual(lines.slice(6), [
    "## Added",
    "- **Added** D [00000004]",
    "",
    "## Removed",
    "- **Removed** C [00000003]",
    "",
    "## Changed",
    "- **Changed** B \"Bee\" [00000002] [NickName ('B' -> 'Bee')]",
    "",
    "## Added connections",
    "- **Wired** A [00000001].out -> D [00000004].in",
    "",
    "## Removed connections",
    "- **Unwired** B [00000002].out -> C [00000003].in",
    "",
  ]);
});

test("diffMarkdown says so when nothing changed, and notes a missing state hash", () => {
  const empty = { addedNodes: [], removedNodes: [], changedNodes: [], addedPorts: [], removedPorts: [], addedEdges: [], removedEdges: [] };
  const same = diffMarkdown(fromComparison(empty, before, before), before, before, "a", "b");
  assert.equal(same, "# Version diff: a -> b\n\nNo structural changes.");

  const bare = { ...after, nodes: after.nodes.map(({ extensions, ...rest }) => rest) };
  const text = diffMarkdown(fromComparison(result, before, bare), before, bare, "a", "b");
  assert.match(text, /_Settings\/state not compared: re-import both versions to add gh\.stateHash\._\n$/);
});

test("nodeLabel and wireLabel", () => {
  assert.equal(nodeLabel(null), "?");
  assert.equal(nodeLabel({ nodeId: id(7), name: "Sum", nickName: "Sum" }), "Sum [00000007]");
  assert.equal(nodeLabel({ nodeId: id(7), name: " Sum ", nickName: "Total" }), 'Sum "Total" [00000007]');
  assert.equal(nodeLabel({ nodeId: id(7) }), "? [00000007]");
  assert.equal(wireLabel(edge(11, 22), before), "A [00000001].out -> B [00000002].in");
  // Unknown ports fall back to the short id; the stored wire names do not apply without a node.
  assert.equal(wireLabel(edge(77, 22), before), "00000077 -> B [00000002].in");
  // A floating parameter's port id is its node id: no ".port" suffix.
  const floating = { nodes: [node(5, "Slider")], ports: [{ portId: id(5), nodeId: id(5), name: "out" }], edges: [] };
  assert.equal(wireLabel(edge(5, 5), floating), "Slider [00000005] -> Slider [00000005]");
  // Same output for repeated calls on the same graph (cached index).
  assert.equal(wireLabel(edge(11, 22), before), wireLabel(edge(11, 22), before));
});

function fieldsFor(change, beforeNode = before.nodes[1], afterNode = after.nodes[1]) {
  const graphBefore = { ...before, nodes: before.nodes.map((n) => (n === before.nodes[1] ? beforeNode : n)) };
  const graphAfter = { ...after, nodes: after.nodes.map((n) => (n === after.nodes[1] ? afterNode : n)) };
  const changed = [{ after: { nodeId: id(2) }, changes: Array.isArray(change) ? change : [change] }];
  return fromComparison({ ...result, changedNodes: changed }, graphBefore, graphAfter).changed[0]?.fields;
}

test("labels for each change kind", () => {
  assert.deepEqual(fieldsFor({ kind: "TYPE", key: null, before: "t1", after: "t2" }, { ...before.nodes[1], name: "Old" }, { ...after.nodes[1], name: "New" }), ["Type (Old -> New)"]);
  assert.deepEqual(fieldsFor({ kind: "TYPE", key: null, before: "t1", after: "t2" }, undefined, undefined), ["Type (B -> B)"]);
  assert.deepEqual(fieldsFor({ kind: "NICK_NAME", key: null, before: null, after: "x" }), ["NickName ('' -> 'x')"]);
  assert.deepEqual(fieldsFor({ kind: "POSITION", key: null, before: { x: 1.4, y: 2.6 }, after: { x: 10, y: undefined } }), ["Position ((1,3) -> (10,?))"]);
  assert.deepEqual(fieldsFor({ kind: "LOCKED", key: null, before: false, after: true }), ["Locked"]);
  assert.deepEqual(fieldsFor({ kind: "LOCKED", key: null, before: true, after: false }), ["Unlocked"]);
  assert.deepEqual(fieldsFor({ kind: "SOURCE", key: null, before: "a", after: "b" }), ["Script source"]);
  assert.deepEqual(fieldsFor({ kind: "TEXT", key: null, before: "a", after: "b" }), ["Text"]);
  assert.deepEqual(fieldsFor({ kind: "PORTS", key: null, before: ["a", "b"], after: ["b", "c", "d"] }), ["Ports (+2 -1)"]);
  assert.deepEqual(fieldsFor({ kind: "PORTS", key: null, before: null, after: ["a"] }), ["Ports (+1 -0)"]);
  assert.deepEqual(fieldsFor({ kind: "PORT_NAME", key: "p1", before: "Tip", after: "Apex" }), ["Port renamed ('Tip' -> 'Apex')"]);
  assert.deepEqual(fieldsFor({ kind: "PORT_DIRECTION", key: "p1", before: "IN", after: "OUT" }), ["Port direction (IN -> OUT)"]);
  assert.deepEqual(fieldsFor({ kind: "EXTENSION", key: "gh.foo", before: 1, after: 2 }), ["Extension gh.foo"]);
  assert.deepEqual(fieldsFor({ kind: "SOMETHING_NEW", key: null, before: 1, after: 2 }), ["SOMETHING_NEW"]);
});

test("gh.stateHash is labelled Settings/state only when both versions carry it", () => {
  const hash = { kind: "EXTENSION", key: "gh.stateHash", before: "h1", after: "h2" };
  assert.deepEqual(fieldsFor(hash), ["Settings/state"]);
  // A change with nothing else to show is dropped from the diff.
  const bare = { ...after, nodes: after.nodes.map(({ extensions, ...rest }) => rest) };
  const diff = fromComparison({ ...result, changedNodes: [{ after: { nodeId: id(2) }, changes: [hash] }] }, before, bare);
  assert.equal(diff.comparesState, false);
  assert.deepEqual(diff.changed, []);
  // Added or removed hash (one side null) is not reported either.
  assert.equal(fieldsFor({ ...hash, before: null }), undefined);
});

// Versions ordering

const v = (versionId, write, creation) => ({ versionId, fileLastWriteTimeUtc: write, fileCreationTimeUtc: creation });

test("compareVersions orders by last write, then creation time", () => {
  assert.ok(isOlder(v("b", "2026-01-01T00:00:00Z"), v("a", "2026-01-02T00:00:00Z")));
  assert.ok(isOlder(v("b", "2026-01-01T00:00:00Z", "2025-01-01T00:00:00Z"), v("a", "2026-01-01T00:00:00Z", "2025-06-01T00:00:00Z")));
  // Different string formats of the same instant tie rather than sorting by text.
  assert.equal(compareVersions(v("a", "2026-01-01T00:00:00Z"), v("a", "2026-01-01T01:00:00+01:00")), 0);
});

test("a version without times counts as newer", () => {
  const imported = v("z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
  const created = v("a", null, null);
  assert.ok(isOlder(imported, created));
  assert.ok(!isOlder(created, imported));
  assert.equal(compareVersions(v("a", "garbage"), v("a", null)), 0, "unparsable counts as missing");
  assert.ok(isOlder(imported, v("a", "garbage")));
  // Write time missing on one, creation time decides when both are missing.
  assert.ok(isOlder(v("a", null, "2026-01-01T00:00:00Z"), v("b", null, "2026-02-01T00:00:00Z")));
});

test("ties break by versionId, whichever version is open", () => {
  const a = v("aaaa", "2026-01-01T00:00:00Z");
  const b = v("bbbb", "2026-01-01T00:00:00Z");
  assert.ok(isOlder(a, b));
  assert.ok(!isOlder(b, a));
  assert.ok(!isOlder(a, a));
  const neither = [v("m2", null), v("m1", null)];
  assert.deepEqual(sortNewestFirst(neither).map((x) => x.versionId), ["m2", "m1"]);
});

test("ordering and previous/latest tags do not depend on argument order", () => {
  const all = [
    v("c", "2026-03-01T00:00:00Z"),
    v("a", "2026-01-01T00:00:00Z"),
    v("w", null),
    v("b", "2026-02-01T00:00:00Z"),
    v("b2", "2026-02-01T00:00:00Z"),
  ];
  const expected = ["w", "c", "b2", "b", "a"];
  assert.deepEqual(sortNewestFirst(all).map((x) => x.versionId), expected);
  assert.deepEqual(sortNewestFirst([...all].reverse()).map((x) => x.versionId), expected);
  assert.deepEqual(sortNewestFirst([all[2], all[4], all[0], all[3], all[1]]).map((x) => x.versionId), expected);

  const open = describeVersions(all, all[3]); // b
  assert.deepEqual(open.versions.map((x) => x.versionId), ["w", "c", "b2", "a"]);
  assert.equal(open.previous.versionId, "a");
  assert.equal(open.latest.versionId, "w");
  const again = describeVersions([...all].reverse(), all[3]);
  assert.deepEqual(again.versions.map((x) => x.versionId), open.versions.map((x) => x.versionId));

  const newest = describeVersions(all, all[2]); // w, the newest
  assert.equal(newest.latest, null);
  assert.equal(newest.previous.versionId, "c");
  const oldest = describeVersions(all, all[1]); // a
  assert.equal(oldest.previous, null);
  assert.equal(oldest.latest.versionId, "w");
});
