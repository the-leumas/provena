import {
  FILE_TYPES,
  FileTypeRegistry,
  ParserRegistry,
  SemanticSearchEngine,
  createSearchSession,
} from '@theleumas/provena';

/** Reopen the source document and extract the 1-based line span cited by a SearchResult. */
export async function readCitedLines(source, result, options = {}) {
  const { text } = await source.read(result.documentId, options);
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const lines = normalized.split('\n');
  if (result.startLine < 1 || result.endLine < result.startLine || result.endLine > lines.length) {
    throw new Error(`Citation line range ${result.startLine}-${result.endLine} is out of bounds for ${result.uri}`);
  }
  const excerpt = lines.slice(result.startLine - 1, result.endLine).join('\n');
  return {
    uri: result.uri,
    startLine: result.startLine,
    endLine: result.endLine,
    excerpt,
    matchesIndexedSnippet: excerpt === result.snippet,
  };
}

/** End-to-end onboarding example: custom format registration, filtered search, incremental refresh, and citation verification. */
export async function verifyProvenanceWorkflow() {
  const records = new Map([
    ['runbooks/failover.mdx', {
      revision: 'rev-1',
      tags: ['production', 'database'],
      text: '# Database Failover\nPromote the standby replica after verifying replication lag is zero.',
    }],
    ['notes/staging.md', {
      revision: 'rev-1',
      tags: ['staging'],
      text: '# Staging Reset\nRebuild staging fixtures nightly.',
    }],
  ]);

  const source = {
    id: 'handbook',
    type: 'memory',
    async list(options = {}) {
      options.signal?.throwIfAborted();
      return [...records.entries()].map(([path, entry]) => ({
        id: path,
        sourceId: 'handbook',
        name: path.split('/').pop(),
        path,
        uri: `handbook://${path}`,
        revision: entry.revision,
        metadata: { tags: entry.tags },
      }));
    },
    async read(id, options = {}) {
      options.signal?.throwIfAborted();
      const entry = records.get(id);
      if (!entry) throw new Error(`Unknown document: ${id}`);
      return { text: entry.text };
    },
  };

  const fileTypes = new FileTypeRegistry([
    ...FILE_TYPES,
    {
      extensions: ['.mdx'],
      kind: 'document',
      language: 'mdx',
      parserId: 'markdown',
      indexable: true,
      structureAware: true,
      textFallback: true,
      mimeTypes: ['text/mdx'],
      maxBytes: 2 * 1024 * 1024,
    },
  ]);

  const parsers = new ParserRegistry(undefined, fileTypes, 'handbook-mdx-v1');
  const engine = new SemanticSearchEngine({ parsers });
  engine.addSource(source);
  const initial = await engine.initialize();

  const session = createSearchSession(engine, 32);
  const hits = await session.search({
    query: 'standby replica',
    mode: 'lexical',
    sources: ['handbook'],
    filters: { tags: ['production'], extensions: ['.mdx'] },
    limit: 5,
  });

  if (hits.length !== 1 || hits[0]?.heading !== 'Database Failover') {
    throw new Error('Expected filtered MDX section match');
  }

  const verified = await readCitedLines(source, hits[0]);
  if (!verified.matchesIndexedSnippet) {
    throw new Error('Live source no longer matches indexed passage; refresh before acting');
  }

  // Update only the staging note; failover.mdx keeps rev-1 and skips reading/parsing.
  records.set('notes/staging.md', {
    revision: 'rev-2',
    tags: ['staging'],
    text: '# Staging Reset\nRebuild staging fixtures every Sunday.',
  });
  const refreshed = await engine.refreshSource('handbook');
  if (refreshed.documentsReused !== 1 || refreshed.documentsParsed !== 1) {
    throw new Error('Expected incremental revision reuse');
  }

  return {
    indexedDocuments: initial[0].documents,
    verifiedUri: verified.uri,
    lines: [verified.startLine, verified.endLine],
    reusedOnRefresh: refreshed.documentsReused,
    parsedOnRefresh: refreshed.documentsParsed,
  };
}
