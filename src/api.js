const DOCUMENTS_QUERY = `
query ViewerDocuments($first: Int) {
  documents(first: $first, sort: { field: FILE_NAME, direction: ASC }) {
    totalCount
    nodes {
      documentId
      versionId
      origin
      committed
      fileName
      filePath
      isNested
      fileCreationTimeUtc
      fileLastWriteTimeUtc
      stats {
        nodeCount
        portCount
        edgeCount
        countsByKind { key count }
      }
    }
  }
}
`;

const DOCUMENT_QUERY = `
query ViewerDocument($documentId: ID!, $versionId: ID!) {
  document(documentId: $documentId, versionId: $versionId) {
    documentId
    versionId
    origin
    committed
    fileName
    filePath
    isNested
    fileCreationTimeUtc
    fileLastWriteTimeUtc
    extensions { key value }
    libraries {
      name
      version
      assemblyVersion
      origin
      libraryId
      library { name libraryId origin }
    }
    stats {
      nodeCount
      portCount
      edgeCount
      countsByKind { key count }
      countsByTypeId { key count }
    }
    graph {
      nodes {
        nodeId
        name
        nickName
        kind
        typeId
        origin
        locked
        x
        y
        source
        language
        text
        extensions { key value }
      }
      ports {
        portId
        nodeId
        name
        direction
        access
        extensions { key value }
      }
      edges {
        sourcePortId
        targetPortId
        sourceName
        targetName
        extensions { key value }
      }
    }
  }
}
`;

const VERSIONS_QUERY = `
query ViewerVersions($documentId: ID!, $first: Int) {
  documents(filter: { documentId: $documentId }, first: $first) {
    nodes {
      documentId
      versionId
      fileName
      committed
      fileLastWriteTimeUtc
    }
  }
}
`;

// Keys and structured changes only: the viewer already holds both graphs and looks the entities up there.
const COMPARE_QUERY = `
query ViewerCompare($before: DocumentKeyInput!, $after: DocumentKeyInput!) {
  compareDocuments(before: $before, after: $after) {
    addedNodes { nodeId }
    removedNodes { nodeId }
    changedNodes { after { nodeId } changes { kind key before after } }
    addedPorts { portId }
    removedPorts { portId }
    addedEdges { sourcePortId targetPortId }
    removedEdges { sourcePortId targetPortId }
  }
}
`;

export class GraphQlError extends Error {
  constructor(messages) {
    super(messages.join("\n"));
    this.name = "GraphQlError";
    this.messages = messages;
  }
}

export async function graphql(url, query, variables) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status} ${response.statusText}`);
  }

  const payload = await response.json();
  const messages = (payload.errors ?? []).map((error) => error.message);
  if (messages.length) throw new GraphQlError(messages);
  return payload.data;
}

export function listDocuments(url) {
  return graphql(url, DOCUMENTS_QUERY, { first: 200 });
}

export function listVersions(url, documentId) {
  return graphql(url, VERSIONS_QUERY, { documentId, first: 100 });
}

export function compareDocuments(url, before, after) {
  const key = (doc) => ({ documentId: doc.documentId, versionId: doc.versionId });
  return graphql(url, COMPARE_QUERY, { before: key(before), after: key(after) });
}

export function loadDocument(url, documentId, versionId) {
  return graphql(url, DOCUMENT_QUERY, { documentId, versionId });
}
