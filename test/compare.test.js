// Integration test for version comparison: imports two versions of a small document through a real
// GraphApi, then lists, loads and compares them through compareDocuments and the viewer's presentation.
// GRAPHROOTS_TEST_GRAPHQL_URL must point at a GraphApi whose database is disposable (README: Tests).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { compareDocuments, graphql, listVersions, loadDocument } from "../src/api.js";
import { diffMarkdown, diffStatus, fromComparison, overlayGraph } from "../src/diff.js";

const url = process.env.GRAPHROOTS_TEST_GRAPHQL_URL;
const skip = !url && "set GRAPHROOTS_TEST_GRAPHQL_URL to a GraphApi on a disposable database";

const IMPORT = `
mutation Import($input: ImportSnapshotInput!) {
  importSnapshot(input: $input) { document { versionId } }
}
`;

const node = (nodeId, name, { kind = "OPERATOR", nickName = name, x = 0, y = 0, hash, ports = [] }) =>
  ({ nodeId, name, kind, nickName, x, y, hash, ports });

// slider: value edited · add: renamed and one input added · mover: moved · jitter: moved by less than the
// 0.5 tolerance · panel: untouched · neg: removed · extra: added, and the slider is rewired from neg to extra.
const BEFORE = {
  fileName: "compare_v1.ghx",
  time: "2026-01-01T10:00:00Z",
  nodes: [
    node("slider", "Number Slider", { kind: "PARAMETER", hash: "slider-0.25", ports: [["slider", "OUT"]] }),
    node("add", "Addition", { nickName: "A", x: 200, hash: "add", ports: [["add.a", "IN"], ["add.b", "IN"], ["add.r", "OUT"]] }),
    node("panel", "Panel", { kind: "PARAMETER", x: 400, hash: "panel", ports: [["panel", "IN"]] }),
    node("neg", "Negative", { x: 200, y: 150, hash: "neg", ports: [["neg.x", "IN"], ["neg.y", "OUT"]] }),
    node("mover", "Multiplication", { y: 300, hash: "mover" }),
    node("jitter", "Division", { x: 400, y: 300, hash: "jitter" }),
  ],
  edges: [["slider", "add.a"], ["add.r", "panel"], ["slider", "neg.x"]],
};

const AFTER = {
  fileName: "compare_v2.ghx",
  time: "2026-01-02T10:00:00Z",
  nodes: [
    node("slider", "Number Slider", { kind: "PARAMETER", hash: "slider-0.75", ports: [["slider", "OUT"]] }),
    node("add", "Addition", { nickName: "Sum", x: 200, hash: "add", ports: [["add.a", "IN"], ["add.b", "IN"], ["add.c", "IN"], ["add.r", "OUT"]] }),
    node("panel", "Panel", { kind: "PARAMETER", x: 400, hash: "panel", ports: [["panel", "IN"]] }),
    node("mover", "Multiplication", { x: 50, y: 300, hash: "mover" }),
    node("jitter", "Division", { x: 400.4, y: 300, hash: "jitter" }),
    node("extra", "Subtraction", { x: 200, y: 450, hash: "extra", ports: [["extra.a", "IN"], ["extra.r", "OUT"]] }),
  ],
  edges: [["slider", "add.a"], ["add.r", "panel"], ["slider", "extra.a"]],
};

async function importVersion(documentId, version, { withHashes = true } = {}) {
  const base = { documentId, versionId: randomUUID() };
  const typeId = (n) => `viewer-test.${n.name.replaceAll(" ", "").toLowerCase()}`;
  await graphql(url, IMPORT, {
    input: {
      documents: [{ ...base, origin: "GRASSHOPPER", fileName: version.fileName, fileLastWriteTimeUtc: version.time }],
      nodeTypes: version.nodes.map((n) => ({ origin: "GRASSHOPPER", typeId: typeId(n), name: n.name })),
      nodes: version.nodes.map((n) => ({
        ...base,
        origin: "GRASSHOPPER",
        nodeId: n.nodeId,
        typeId: typeId(n),
        name: n.name,
        nickName: n.nickName,
        kind: n.kind,
        x: n.x,
        y: n.y,
        extensions: withHashes ? [{ key: "gh.stateHash", equals: n.hash }] : null,
      })),
      ports: version.nodes.flatMap((n) => n.ports.map(([portId, direction]) => ({
        ...base,
        nodeId: n.nodeId,
        portId,
        name: portId.split(".")[1] ?? portId,
        direction,
      }))),
      edges: version.edges.map(([sourcePortId, targetPortId]) => ({ ...base, sourcePortId, targetPortId })),
    },
  });
  return base.versionId;
}

async function importPair(options) {
  const documentId = `viewer-compare-${randomUUID()}`;
  const beforeId = await importVersion(documentId, BEFORE, options);
  const afterId = await importVersion(documentId, AFTER, options);
  const [before, after] = await Promise.all(
    [beforeId, afterId].map(async (versionId) => (await loadDocument(url, documentId, versionId)).document),
  );
  return { documentId, beforeId, afterId, before, after };
}

async function compare(before, after) {
  return fromComparison((await compareDocuments(url, before, after)).compareDocuments, before.graph, after.graph);
}

const ids = (items, key) => items.map((item) => item[key]).sort();
const wires = (edges) => edges.map((edge) => `${edge.sourcePortId}>${edge.targetPortId}`).sort();

test("lists both stored versions of a document", { skip }, async () => {
  const { documentId, beforeId, afterId } = await importPair();
  const versions = (await listVersions(url, documentId)).documents.nodes;
  assert.deepEqual(ids(versions, "versionId"), [beforeId, afterId].sort());
  assert.deepEqual(ids(versions, "fileLastWriteTimeUtc"), [BEFORE.time, AFTER.time].map((t) => new Date(t).toISOString()));
});

test("compareDocuments returns structured changes with before and after values", { skip }, async () => {
  const { before, after } = await importPair();
  const result = (await compareDocuments(url, before, after)).compareDocuments;
  const changes = Object.fromEntries(result.changedNodes.map((change) => [change.after.nodeId, change.changes]));

  assert.deepEqual(changes.slider, [{ kind: "EXTENSION", key: "gh.stateHash", before: "slider-0.25", after: "slider-0.75" }]);
  assert.deepEqual(changes.mover, [{ kind: "POSITION", key: null, before: { x: 0, y: 300 }, after: { x: 50, y: 300 } }]);
  assert.deepEqual(changes.add, [
    { kind: "NICK_NAME", key: null, before: "A", after: "Sum" },
    { kind: "PORTS", key: null, before: ["add.a", "add.b", "add.r"], after: ["add.a", "add.b", "add.c", "add.r"] },
  ]);
  assert.equal(changes.jitter, undefined, "a 0.4 move is within the default 0.5 tolerance");
});

test("reports every kind of change between two imported versions", { skip }, async () => {
  const { before, after } = await importPair();
  const diff = await compare(before, after);

  assert.equal(diff.hasChanges, true);
  assert.equal(diff.comparesState, true);
  assert.deepEqual(ids(diff.added, "nodeId"), ["extra"]);
  assert.deepEqual(ids(diff.removed, "nodeId"), ["neg"]);
  assert.deepEqual(Object.fromEntries(diff.changed.map((change) => [change.after.nodeId, change.fields])), {
    slider: ["Settings/state"],
    add: ["NickName ('A' -> 'Sum')", "Ports (+1 -0)"],
    mover: ["Position ((0,300) -> (50,300))"],
  });
  assert.deepEqual(wires(diff.addedEdges), ["slider>extra.a"]);
  assert.deepEqual(wires(diff.removedEdges), ["slider>neg.x"]);
  assert.deepEqual(ids(diff.addedPorts, "portId"), ["add.c", "extra.a", "extra.r"]);
  assert.deepEqual(ids(diff.removedPorts, "portId"), ["neg.x", "neg.y"]);
});

test("overlays the removed parts onto the newer version and marks each element", { skip }, async () => {
  const { before, after } = await importPair();
  const diff = await compare(before, after);
  const overlay = overlayGraph(diff, after.graph);
  const status = diffStatus(diff);

  assert.deepEqual(ids(overlay.nodes, "nodeId"), ["add", "extra", "jitter", "mover", "neg", "panel", "slider"]);
  assert.ok(overlay.ports.some((port) => port.portId === "neg.x"));
  assert.ok(wires(overlay.edges).includes("slider>neg.x"));

  assert.equal(status.get("node:extra"), "added");
  assert.equal(status.get("node:neg"), "removed");
  assert.equal(status.get("node:slider"), "changed");
  assert.equal(status.get("port:add.c"), "added");
  assert.equal(status.get("port:neg.y"), "removed");
  assert.equal(status.get("edge:slider:extra.a"), "added");
  assert.equal(status.get("edge:slider:neg.x"), "removed");
  for (const unchanged of ["node:panel", "node:jitter", "edge:slider:add.a"]) assert.equal(status.get(unchanged), undefined);
});

test("writes the Markdown report in the GhDiffReport layout", { skip }, async () => {
  const { before, after } = await importPair();
  const markdown = diffMarkdown(await compare(before, after), before.graph, after.graph, "v1", "v2");

  for (const line of [
    "# Version diff: v1 -> v2",
    "| 1 | 1 | 3 | 1 | 1 |",
    "- **Added** Subtraction [extra]",
    "- **Removed** Negative [neg]",
    "- **Changed** Addition \"Sum\" [add] [NickName ('A' -> 'Sum'); Ports (+1 -0)]",
    "- **Wired** Number Slider [slider] -> Subtraction [extra].a",
    "- **Unwired** Number Slider [slider] -> Negative [neg].x",
  ]) {
    assert.ok(markdown.split("\n").includes(line), `missing line: ${line}\n\n${markdown}`);
  }
});

test("skips the settings check when the versions carry no gh.stateHash", { skip }, async () => {
  const { before, after } = await importPair({ withHashes: false });
  const diff = await compare(before, after);

  assert.equal(diff.comparesState, false);
  assert.ok(!diff.changed.some((change) => change.fields.includes("Settings/state")));
  assert.ok(!diff.changed.some((change) => change.after.nodeId === "slider"), "slider changed only its state");
  assert.match(diffMarkdown(diff, before.graph, after.graph, "v1", "v2"), /Settings\/state not compared/);
});
