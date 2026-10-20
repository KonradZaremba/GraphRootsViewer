# GraphRoots Viewer

A small browser explorer for graphs stored through [GraphRootsApi](../GraphRootsApi). It does not talk to Neo4j directly. It calls the GraphQL API, which reads the `GraphRoots` database.

## Run

1. Start Neo4j and GraphApi as described in `GraphRootsApi/README.md`.
2. Import at least one Grasshopper file so the store is not empty.
3. From this folder:

```bash
npm install
npm run dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). In development the viewer proxies `/graphql` to GraphApi at `http://127.0.0.1:5088/graphql`. You can also point the GraphQL field at that URL directly after GraphApi is restarted with localhost CORS.

The page lists stored documents, draws the selected document using canvas `x`/`y` when present, and shows document / node / port / edge properties on the right. Drag to pan, scroll to zoom, and use **Fit** to frame the graph.

## Tests

`npm test` runs integration tests for version comparison (`test/compare.test.js`). They import small documents through a real GraphApi, so they need one running on a **disposable** database; without `GRAPHROOTS_TEST_GRAPHQL_URL` they are skipped. From `GraphRootsApi`, start the Compose test database and a second GraphApi on it:

```bash
docker compose -f docker/neo4j/compose.yaml up -d --wait neo4j-test
NEO4J_URI=bolt://127.0.0.1:17687 NEO4J_DATABASE=graphtest NEO4J_PASSWORD=graphroots-test \
  dotnet run --project GraphApi -- --urls http://127.0.0.1:5099
```

Then, from this folder:

```bash
GRAPHROOTS_TEST_GRAPHQL_URL=http://127.0.0.1:5099/graphql npm test
```

The GraphRootsApi live tests purge `graphtest` before each case, so don't run them at the same time.
