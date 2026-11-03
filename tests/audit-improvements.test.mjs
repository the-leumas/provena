import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ParserRegistry,
  chunkDocument,
  CHUNKER_VERSION,
  contentHash,
  SemanticSearchEngine,
} from '../dist/index.js';
import { source, MemoryStorage, TestEmbedder } from './fixtures/lifecycle.mjs';

test('Task 1: oversized lines are bounded into sub-line passages without losing content', async () => {
  const line = 'Word ' + 'middle sentence here. '.repeat(500) + 'tail needle found.';
  const parsed = await new ParserRegistry().parse(
    { id: 'long.txt', sourceId: 'src', name: 'long.txt', uri: 'memory:long.txt' },
    { text: line }
  );

  const chunks = chunkDocument(parsed, { targetChars: 800, overlapLines: 2 });
  assert.ok(chunks.length > 5, 'Oversized line should produce multiple bounded chunks');
  assert.ok(chunks.every(c => c.text.length <= 800), 'All chunks must be <= targetChars');
  assert.ok(chunks.every(c => c.startLine === 1 && c.endLine === 1), 'Line provenance must stay 1:1 for line 1');

  // Chunk IDs must all be distinct
  const ids = new Set(chunks.map(c => c.id));
  assert.equal(ids.size, chunks.length, 'Every chunk must have a unique ID');

  // Content preservation: first chunk starts with Word, last chunk contains tail needle
  assert.ok(chunks[0].text.startsWith('Word'));
  assert.ok(chunks.at(-1).text.includes('tail needle found.'));

  // Downstream retrieval finds the tail chunk with line 1 provenance
  const engine = new SemanticSearchEngine();
  engine.addSource(source('s', { 'long.txt': line }));
  await engine.initialize();

  const hits = await engine.search({ query: 'needle', mode: 'lexical' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].documentId, 'long.txt');
  assert.equal(hits[0].startLine, 1);
  assert.equal(hits[0].endLine, 1);
  assert.ok(hits[0].snippet.includes('tail needle found.'));
  assert.ok(hits[0].snippet.length <= 1600, 'Snippet must be bounded');
});

test('Task 1: sub-line chunking respects overlap configuration and never splits surrogate pairs', async () => {
  const textWithEmoji = 'prefix ' + '🧠👩🏽‍💻'.repeat(400) + ' suffix';
  const parsed = await new ParserRegistry().parse(
    { id: 'emoji.txt', sourceId: 'src', name: 'emoji.txt', uri: 'memory:emoji.txt' },
    { text: textWithEmoji }
  );

  const withOverlap = chunkDocument(parsed, { targetChars: 200, overlapLines: 1 });
  const noOverlap = chunkDocument(parsed, { targetChars: 200, overlapLines: 0 });

  assert.ok(withOverlap.length > noOverlap.length, 'Overlap should produce more chunks than no overlap');
  assert.ok(withOverlap.every(c => c.text.length <= 200));
  assert.ok(noOverlap.every(c => c.text.length <= 200));

  // Verify that no surrogate pair is broken in any chunk
  for (const chunk of [...withOverlap, ...noOverlap]) {
    for (let i = 0; i < chunk.text.length; i++) {
      const code = chunk.text.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        assert.ok(i + 1 < chunk.text.length, 'High surrogate at chunk end without low surrogate');
        const next = chunk.text.charCodeAt(i + 1);
        assert.ok(next >= 0xdc00 && next <= 0xdfff, 'High surrogate not followed by low surrogate');
      }
    }
  }
});

test('Task 1: CHUNKER_VERSION is bumped to 2 and rejects obsolete version 1 snapshots', async () => {
  assert.equal(CHUNKER_VERSION, '2');

  const createSource = () => {
    const s = source('s', { 'a.txt': 'initial text' });
    const list = s.list;
    s.list = async opts => (await list(opts)).map(d => ({ ...d, revision: 'rev-1' }));
    return s;
  };

  const storage = new MemoryStorage();
  const engine = new SemanticSearchEngine({ storage });
  engine.addSource(createSource());
  await engine.initialize();

  assert.equal(storage.snapshot.chunkerVersion, '2');

  // Simulate an older v1 snapshot on disk
  storage.snapshot.chunkerVersion = '1';
  const restart = new SemanticSearchEngine({ storage });
  restart.addSource(createSource());
  const [report] = await restart.initialize();

  // Incompatible chunker version forces rebuild from source (no documents reused)
  assert.equal(report.persistence, 'saved');
  assert.equal(report.documentsReused, 0);
  assert.equal(report.documentsRead, 1);
  assert.equal(storage.snapshot.chunkerVersion, '2');

  // Compatible v2 snapshot reuses documents without re-reading
  const restart2 = new SemanticSearchEngine({ storage });
  restart2.addSource(createSource());
  const [report2] = await restart2.initialize();
  assert.equal(report2.persistence, 'unchanged');
  assert.equal(report2.documentsReused, 1);
  assert.equal(report2.documentsRead, 0);
});

test('Task 2: lexical matching rejects accidental substring matches', async () => {
  const corpus = {
    'backup.md': '# Backup restoration\nNightly backup jobs recover database records.',
    'callback.ts': 'export async function OAuthCallback(request) { return true; }',
    'against.md': '# Validation against schema\nCheck payloads against schema.',
    'target.md': '# Target document\nWe need to bring back earlier chats when starting again.',
  };

  const engine = new SemanticSearchEngine();
  engine.addSource(source('s', corpus));
  await engine.initialize();

  // "back" should match target.md (which has "back"), but NOT backup.md or callback.ts
  const backHits = await engine.search({ query: 'back', mode: 'lexical' });
  const backDocs = backHits.map(h => h.documentId);
  assert.ok(backDocs.includes('target.md'));
  assert.ok(!backDocs.includes('backup.md'), 'Query "back" must not match "backup"');
  assert.ok(!backDocs.includes('callback.ts'), 'Query "back" must not match "callback"');

  // "again" should match target.md (which has "again"), but NOT against.md
  const againHits = await engine.search({ query: 'again', mode: 'lexical' });
  const againDocs = againHits.map(h => h.documentId);
  assert.ok(againDocs.includes('target.md'));
  assert.ok(!againDocs.includes('against.md'), 'Query "again" must not match "against"');

  // Common stopword substring rejection: "are" shouldn't match "software"
  const softEngine = new SemanticSearchEngine();
  softEngine.addSource(source('s', { 'soft.txt': 'software engineering architecture' }));
  await softEngine.initialize();
  const areHits = await softEngine.search({ query: 'are', mode: 'lexical' });
  assert.equal(areHits.length, 0, 'Query "are" must not match substring in "software"');
});

test('Task 2: lexical matching preserves code identifiers, camelCase, snake_case, paths and plurals', async () => {
  const corpus = {
    'auth.ts': 'export function validateSession(cookie: string) { return cookie.length > 0; }',
    'config.yaml': 'visibility_timeout_seconds: 300\nmax_retry_count: 5',
    'session.md': 'SessionStore serializes messages to journal.',
    'drills.md': '# Backup drills\nDisaster recovery drills every Friday.',
  };

  const engine = new SemanticSearchEngine();
  engine.addSource(source('s', corpus));
  await engine.initialize();

  // camelCase parts match
  const validateHits = await engine.search({ query: 'validate', mode: 'lexical' });
  assert.equal(validateHits[0].documentId, 'auth.ts');
  const sessionHits = await engine.search({ query: 'validateSession', mode: 'lexical' });
  assert.equal(sessionHits[0].documentId, 'auth.ts');

  // snake_case parts match
  const timeoutHits = await engine.search({ query: 'visibility', mode: 'lexical' });
  assert.equal(timeoutHits[0].documentId, 'config.yaml');
  const fullSnakeHits = await engine.search({ query: 'visibility_timeout_seconds', mode: 'lexical' });
  assert.equal(fullSnakeHits[0].documentId, 'config.yaml');

  // exact symbol
  const storeHits = await engine.search({ query: 'SessionStore', mode: 'lexical' });
  assert.equal(storeHits[0].documentId, 'session.md');

  // singular matches plural heading ("drill" matches "drills")
  const drillHits = await engine.search({ query: 'drill', mode: 'lexical' });
  assert.equal(drillHits[0].documentId, 'drills.md');
});

test('Task 2 lifecycle: cold index, compatible restart, unchanged refresh, content edits, and obsolete snapshot rebuild', async () => {
  let readCount = 0;
  const files = new Map([
    ['doc1.md', { text: '# Doc 1\nFirst document content.', rev: 'r1' }],
    ['doc2.md', { text: '# Doc 2\nSecond document content.', rev: 'r2' }],
    ['doc3.md', { text: '# Doc 3\nThird document content.', rev: 'r3' }],
  ]);

  const versionedSource = {
    id: 'test-src',
    type: 'memory',
    async list() {
      return [...files.entries()].map(([path, data]) => ({
        id: path,
        sourceId: 'test-src',
        uri: `memory://test-src/${path}`,
        path,
        name: path,
        revision: data.rev,
      }));
    },
    async read(id) {
      readCount++;
      const data = files.get(id);
      if (!data) throw new Error(`Missing ${id}`);
      return { text: data.text };
    },
  };

  const embedder = new TestEmbedder();
  const storage = new MemoryStorage();

  // 1. Initial cold indexing
  const engine1 = new SemanticSearchEngine({ embedder, storage });
  engine1.addSource(versionedSource);
  const [report1] = await engine1.initialize();
  assert.equal(report1.documentsRead, 3);
  assert.equal(report1.documentsParsed, 3);
  assert.equal(report1.documentsReused, 0);
  assert.equal(report1.embeddedTexts, 3);
  assert.equal(report1.reusedVectors, 0);
  assert.equal(report1.persistence, 'saved');
  assert.equal(readCount, 3);
  assert.equal(storage.saves, 1);

  // 2. Explicit refreshSource() on unchanged source (live in-memory)
  readCount = 0;
  const embedCallsBefore = embedder.calls.length;
  const report2 = await engine1.refreshSource('test-src');
  assert.equal(report2.documentsRead, 0);
  assert.equal(report2.documentsParsed, 0);
  assert.equal(report2.documentsReused, 3);
  assert.equal(report2.embeddedTexts, 0);
  assert.equal(report2.reusedVectors, 3);
  assert.equal(report2.persistence, 'unchanged');
  assert.equal(readCount, 0, 'Unchanged refresh must perform zero reads');
  assert.equal(embedder.calls.length, embedCallsBefore, 'Zero embedding calls on unchanged refresh');
  assert.equal(storage.saves, 1, 'Zero storage writes on unchanged refresh');

  // 3. Explicit refreshSource() with verifyContent: true forces reads and parses, but reuses vectors
  readCount = 0;
  const report3 = await engine1.refreshSource('test-src', { verifyContent: true });
  assert.equal(report3.documentsRead, 3);
  assert.equal(report3.documentsParsed, 3);
  assert.equal(report3.documentsReused, 0);
  assert.equal(report3.embeddedTexts, 0);
  assert.equal(report3.reusedVectors, 3);
  assert.equal(report3.persistence, 'unchanged');
  assert.equal(readCount, 3);
  assert.equal(embedder.calls.length, embedCallsBefore);

  // 4. Restart with compatible persisted snapshot
  readCount = 0;
  const restartEngine = new SemanticSearchEngine({ embedder, storage });
  restartEngine.addSource(versionedSource);
  const [restartReport] = await restartEngine.initialize();
  assert.equal(restartReport.documentsRead, 0);
  assert.equal(restartReport.documentsParsed, 0);
  assert.equal(restartReport.documentsReused, 3);
  assert.equal(restartReport.embeddedTexts, 0);
  assert.equal(restartReport.reusedVectors, 3);
  assert.equal(restartReport.persistence, 'unchanged');
  assert.equal(readCount, 0, 'Compatible restart must perform zero reads');
  assert.equal(embedder.calls.length, embedCallsBefore, 'Zero embedding calls on compatible restart');

  // 5. Refresh after a document changes
  files.set('doc2.md', { text: '# Doc 2\nUpdated second document content with new information.', rev: 'r2-updated' });
  readCount = 0;
  const editReport = await restartEngine.refreshSource('test-src');
  assert.equal(editReport.documentsRead, 1);
  assert.equal(editReport.documentsParsed, 1);
  assert.equal(editReport.documentsReused, 2);
  assert.equal(editReport.embeddedTexts, 1);
  assert.equal(editReport.reusedVectors, 2);
  assert.equal(editReport.persistence, 'saved');
  assert.equal(readCount, 1);
  assert.equal(storage.saves, 2);

  // 6. Rebuild obsolete passages, retaining compatible exact-input vectors.
  storage.snapshot.chunkerVersion = '1';
  readCount = 0;
  const callsBeforeLayoutRebuild = embedder.calls.length;
  const obsoleteRestart = new SemanticSearchEngine({ embedder, storage });
  obsoleteRestart.addSource(versionedSource);
  const [obsoleteReport] = await obsoleteRestart.initialize();
  assert.equal(obsoleteReport.documentsRead, 3);
  assert.equal(obsoleteReport.documentsParsed, 3);
  assert.equal(obsoleteReport.documentsReused, 0);
  assert.equal(obsoleteReport.embeddedTexts, 0);
  assert.equal(obsoleteReport.reusedVectors, 3);
  assert.equal(embedder.calls.length, callsBeforeLayoutRebuild);
  assert.equal(obsoleteReport.persistence, 'saved');
  assert.equal(storage.snapshot.chunkerVersion, '2');
  assert.equal(readCount, 3);

  // Model incompatibility must still replace every vector during a layout rebuild.
  storage.snapshot.chunkerVersion = '1';
  const replacementEmbedder = new TestEmbedder();
  replacementEmbedder.id = 'replacement-content-v1';
  const replacementEngine = new SemanticSearchEngine({ embedder: replacementEmbedder, storage });
  replacementEngine.addSource(versionedSource);
  const [replacementReport] = await replacementEngine.initialize();
  assert.equal(replacementReport.documentsRead, 3);
  assert.equal(replacementReport.documentsParsed, 3);
  assert.equal(replacementReport.embeddedTexts, 3);
  assert.equal(replacementReport.reusedVectors, 0);
  assert.equal(replacementEmbedder.count, 3);
  assert.equal(storage.snapshot.embedding.id, replacementEmbedder.id);
});

