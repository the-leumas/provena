import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticSearchEngine, createSearchSession, contentHash } from '../dist/index.js';
import { RetrievalCache, rankLexical, rankSemantic, collectCandidates, fuseRrf } from '../dist/retrieval.js';
import { MemoryStorage, source } from './fixtures/lifecycle.mjs';

function fixture() {
  const input = source(); const list = input.list; let reads = 0; let lists = 0;
  input.list = async () => { lists++; return (await list()).map(doc => ({ ...doc, revision: input.files.get(doc.id) })); };
  const read = input.read; input.read = async id => { reads++; return read(id); };
  const embedder = { id: 'warm-ranking', dimensions: 2, documents: 0, queries: 0,
    async embedDocuments(texts) { this.documents += texts.length; return texts.map(text => Float32Array.of(text.includes('alpha') ? 3 : 1, 2)); },
    async embedQuery() { this.queries++; return Float32Array.of(2, 0); },
  };
  const storage = new MemoryStorage();
  const create = (options = {}) => { const engine = new SemanticSearchEngine({ storage, embedder, ...options }); engine.addSource(input); return engine; };
  return { input, storage, embedder, create, counters: () => ({ reads, lists }) };
}

test('allocation-free fingerprint arithmetic exactly preserves legacy UTF-8 hashes and chunk identities', () => {
  const legacy = text => {
    let hash = 0xcbf29ce484222325n;
    for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
    return hash.toString(16).padStart(16, '0');
  };
  const samples = ['', 'a', 'foobar', '证据 İstanbul 😀', '\ud800', '\udfff', '\u0000', 'a'.repeat(65535), '😀\n证据'.repeat(4096)];
  let seed = 12345;
  for (let i = 0; i < 200; i++) {
    const units = [];
    for (let j = 0; j < i * 3; j++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; units.push(seed & 0xffff); }
    samples.push(String.fromCharCode(...units));
  }
  for (const sample of samples) assert.equal(contentHash(sample), legacy(sample));
  assert.equal(contentHash(''), 'cbf29ce484222325'); assert.equal(contentHash('foobar'), '85944171f73967e8');
});

test('restore publishes isolated saved state without scanning, reading or embedding documents; refresh reconciles changes', async () => {
  const { input, storage, embedder, create, counters } = fixture();
  const original = create(); await original.initialize();
  const expected = await original.search({ query: 'alpha', mode: 'hybrid' });
  const before = counters(); const calls = embedder.documents; const saves = storage.saves;
  input.files.set('a.txt', 'changed alpha'); input.files.delete('b.txt'); input.files.set('new.txt', 'new alpha');
  const restored = create(); const reports = await restored.restoreSnapshot();
  assert.equal(reports[0].documentsReused, 3); assert.equal(reports[0].reusedVectors, 3);
  assert.deepEqual(counters(), before); assert.equal(embedder.documents, calls); assert.equal(storage.saves, saves);
  assert.deepEqual(await restored.search({ query: 'alpha', mode: 'hybrid' }), expected);
  storage.snapshot.documents[0].title = 'mutated external storage'; storage.snapshot.chunks[0].vector[0] = 999;
  assert.deepEqual(await restored.search({ query: 'alpha', mode: 'hybrid' }), expected);
  const refreshed = await restored.refreshSource(input.id);
  assert.equal(refreshed.documentsRead, 2); assert.equal(refreshed.documentsDeleted, 1);
  assert.equal(refreshed.embeddedTexts, 2); assert.equal(refreshed.documentsReused, 1);
  assert.deepEqual(new Set(restored.getCatalog().map(doc => doc.documentId)), new Set(['a.txt', 'c.txt', 'new.txt']));
  await assert.rejects(restored.restoreSnapshot(), /already initialized/);
});

test('missing/incompatible snapshots do not publish; corruption, unregistered sources and cancellation fail atomically', async () => {
  const { create, storage } = fixture();
  assert.equal(await create().restoreSnapshot(), null);
  const first = create(); await first.initialize(); const good = structuredClone(storage.snapshot);
  for (const mutate of [s => s.chunkerVersion = 'other', s => s.parserVersion = 'other', s => s.embedding.id = 'other',
    s => s.embeddingInputVersion = -1, s => s.chunking.targetChars++]) {
    storage.snapshot = structuredClone(good); mutate(storage.snapshot); const engine = create();
    assert.equal(await engine.restoreSnapshot(), null); assert.equal(engine.revision, 0); assert.deepEqual(engine.getCatalog(), []);
  }
  for (const mutate of [s => s.chunks[0].text += 'corruption', s => s.chunks[0].vector[0] = NaN,
    s => s.documentRevisions[0].documentId = 'missing']) {
    storage.snapshot = structuredClone(good); mutate(storage.snapshot); const engine = create();
    await assert.rejects(engine.restoreSnapshot(), /Corrupt/); assert.equal(engine.revision, 0); assert.deepEqual(engine.getCatalog(), []);
  }
  storage.snapshot = structuredClone(good);
  const unknown = new SemanticSearchEngine({ storage });
  await assert.rejects(unknown.restoreSnapshot(), /unregistered source/); assert.deepEqual(unknown.getCatalog(), []);
  const controller = new AbortController(); const engine = create({ storage: { async load() { controller.abort(); return good; } } });
  await assert.rejects(engine.restoreSnapshot({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(engine.revision, 0); assert.deepEqual(engine.getCatalog(), []);
  const lexical = create({ embedder: undefined });
  assert.equal((await lexical.restoreSnapshot())[0].persistence, 'preserved');
  assert.equal((await lexical.search({ query: 'alpha', mode: 'lexical' }))[0].documentId, 'a.txt');
  let release;
  const pending = create({ storage: { load: () => new Promise(resolve => { release = resolve; }) } });
  const restoring = pending.restoreSnapshot();
  await assert.rejects(pending.restoreSnapshot(), /in progress/);
  await assert.rejects(pending.refreshSource('fixture'), /in progress/);
  assert.throws(() => pending.addSource(source('other')), /in progress/);
  release(good); await restoring;
});

test('unchanged revision refresh retains generation and result cache; source removal still persists and changes invalidate', async () => {
  const { input, storage, embedder, create } = fixture(); const engine = create();
  const other = source('other', { 'other.txt': 'other material' }); engine.addSource(other); await engine.initialize();
  const session = createSearchSession(engine); await session.search({ query: 'alpha', mode: 'semantic' });
  const revision = engine.revision; const saves = storage.saves; const queries = embedder.queries;
  const vectors = engine.vectors; const cache = engine.retrievalCache;
  const retained = [...engine.records.values()].find(record => record.catalog.documentId === 'c.txt').chunks[0];
  const prepared = cache.chunk(retained);
  const report = await engine.refreshSource(input.id);
  assert.equal(report.persistence, 'unchanged'); assert.equal(engine.revision, revision);
  assert.equal(engine.vectors, vectors); assert.equal(engine.retrievalCache, cache); assert.equal(storage.saves, saves);
  await session.search({ query: 'alpha', mode: 'semantic' }); assert.equal(embedder.queries, queries);
  assert.equal(session.stats.hits, 1);
  engine.removeSource(other.id); await engine.refreshSource(input.id);
  assert.equal(engine.retrievalCache.chunk(retained), prepared);
  assert.ok(storage.snapshot.documents.every(doc => doc.sourceId === input.id)); assert.equal(storage.saves, saves + 1);
  input.files.set('a.txt', 'replacement'); await engine.refreshSource(input.id);
  assert.equal(engine.retrievalCache.chunk(retained), prepared, 'one edited document does not discard unrelated lexical preparations');
  await session.search({ query: 'alpha', mode: 'semantic' }); assert.equal(embedder.queries, queries + 1);
  const cancelled = new AbortController(); const before = engine.revision;
  await assert.rejects(engine.refreshSource(input.id, { signal: cancelled.signal, onDocument() { cancelled.abort(); } }), { name: 'AbortError' });
  assert.equal(engine.revision, before);
});

test('bounded lexical preparation and norm reuse preserve complete ranks, filter-dependent IDF, and exact top K', async () => {
  for (const lexicalCacheBytes of [-1, 0.5, NaN, Infinity]) assert.throws(() => new SemanticSearchEngine({ lexicalCacheBytes }), /cache budget/);
  assert.equal(new SemanticSearchEngine({ lexicalCacheBytes: 0 }).retrievalCache.lexicalBytes, 0);
  const { input, create } = fixture();
  input.files.clear();
  for (let i = 0; i < 210; i++) input.files.set(`${i}.txt`, `XMLParser HTTP2Response snake_case sessions İstanbul 证据\nneedle topic${i % 13} ${i % 2 ? 'alpha' : 'beta'}`);
  const engine = create(); await engine.initialize();
  const cache = new RetrievalCache(); const small = new RetrievalCache(600); const zero = new RetrievalCache(0);
  const candidates = collectCandidates(engine.records.values(), engine.vectors, { query: 'needle' });
  for (const subset of [candidates, candidates.filter(candidate => candidate.chunk.documentId.endsWith('1.txt')), [...candidates].reverse()]) {
    for (const query of ['needle', 'XMLParser session', 'HTTP2Response', 'snake case', '证据', 'İstanbul', 'unmatched']) {
      const expected = rankLexical(subset, query);
      for (const prepared of [cache, small, zero]) {
        assert.deepEqual(rankLexical(subset, query, undefined, prepared), expected);
        for (const limit of [1, 3, 10, 100]) assert.deepEqual(rankLexical(subset, query, undefined, prepared, limit), expected.slice(0, limit));
      }
    }
    for (const vector of [Float32Array.of(2, 0), Float32Array.of(0, 2), Float32Array.of(-2, -1)]) {
      const expected = rankSemantic(subset, vector, 2);
      assert.deepEqual(rankSemantic(subset, vector, 2, undefined, cache), expected);
      for (const limit of [1, 3, 10, 100]) assert.deepEqual(rankSemantic(subset, vector, 2, undefined, cache, limit), expected.slice(0, limit));
      assert.deepEqual(fuseRrf(rankLexical(subset, 'needle'), expected), fuseRrf(rankLexical(subset, 'needle', undefined, cache), rankSemantic(subset, vector, 2, undefined, cache)));
    }
  }
  assert.ok(small.lexicalBytes <= 600); assert.equal(zero.lexicalBytes, 0);
  assert.equal(cache.chunk(candidates[0].chunk), cache.chunk(candidates[0].chunk));
  const forked = cache.fork(engine.records.values()); assert.ok(forked.lexicalBytes <= cache.lexicalBytes);
  assert.equal(forked.chunk(candidates[0].chunk), cache.chunk(candidates[0].chunk));
  assert.throws(() => cache.norm(candidates[0].vector, 3, 'wrong'), /dimensions/);
  assert.throws(() => cache.norm(Float32Array.of(0, 0), 2, 'zero'), /zero/);
});

test('lexical result-cache keys preserve camel-case and Unicode token derivation while equivalent ordinary queries share hits', async () => {
  const engine = new SemanticSearchEngine();
  engine.addSource(source('case', { 'literal.txt': 'XMLParser', 'parts.txt': 'xml parser', 'unicode.txt': 'İstanbul', 'unicode-parts.txt': 'i stanbul' }));
  await engine.initialize(); const session = createSearchSession(engine);
  for (const query of ['XMLParser', 'xmlparser', 'İstanbul', 'i\u0307stanbul']) {
    assert.deepEqual(await session.search({ query }), await engine.search({ query }));
  }
  assert.equal(session.stats.hits, 0); assert.equal(session.stats.misses, 4);
  await session.search({ query: ' XMLParser ' }); assert.equal(session.stats.hits, 1);
  await session.search({ query: 'parser' }); await session.search({ query: ' PARSER ' }); assert.equal(session.stats.hits, 2);
});
