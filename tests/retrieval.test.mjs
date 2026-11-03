import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticSearchEngine, createSearchSession } from '../dist/index.js';
import { collectCandidates, rankLexical, rankSemantic, fuseRrf } from '../dist/retrieval.js';
import { source, MemoryStorage } from './fixtures/lifecycle.mjs';

// Explicit non-unit vectors prove ranking mechanics, not model quality.
class RankingEmbedder {
  id = 'explicit-ranking-v1'; dimensions = 2; queries = []; documents = [];
  async embedDocuments(texts) {
    this.documents.push(...texts);
    return texts.map(text => new Float32Array(text.includes('needle.txt') ? [0, 50] : text.includes('needle') ? [3, 0] : [8, 6]));
  }
  async embedQuery(query, options = {}) { options.signal?.throwIfAborted(); this.queries.push(query); return new Float32Array([2, 0]); }
}
async function fixture(embedder = new RankingEmbedder()) {
  const input = source('one', { 'needle.txt': 'needle.txt', 'b.txt': 'needle evidence', 'c.txt': 'paraphrased material' });
  const storage = new MemoryStorage(); const engine = new SemanticSearchEngine({ embedder, storage });
  engine.addSource(input); await engine.initialize(); return { input, storage, engine, embedder };
}
const ids = hits => hits.map(hit => hit.documentId);
test('modes preserve lexical scoring, use generic cosine, and fuse the channel union before final limit', async () => {
  const { engine, embedder } = await fixture();
  const lexical = await engine.search({ query: 'needle', mode: 'lexical' });
  assert.deepEqual(ids(lexical), ['needle.txt', 'b.txt']); assert.equal(embedder.queries.length, 0);
  const semantic = await engine.search({ query: 'needle', mode: 'semantic' });
  assert.deepEqual(ids(semantic), ['b.txt', 'c.txt', 'needle.txt']); assert.equal(embedder.queries.length, 1);
  assert.deepEqual(semantic.map(hit => [hit.semanticRank, hit.combinedRank, hit.lexicalRank, hit.matchReasons]),
    [[1, 1, undefined, ['semantic']], [2, 2, undefined, ['semantic']], [3, 3, undefined, ['semantic']]]);
  const hybrid = await engine.search({ query: 'needle', mode: 'hybrid' });
  assert.deepEqual(ids(hybrid), ['b.txt', 'needle.txt', 'c.txt']); assert.equal(embedder.queries.length, 2);
  assert.deepEqual(hybrid.map(hit => [hit.lexicalRank, hit.semanticRank, hit.combinedRank, hit.matchReasons]),
    [[2, 1, 1, ['lexical', 'semantic']], [1, 3, 2, ['lexical', 'semantic']], [undefined, 2, 3, ['semantic']]]);
  assert.equal((await engine.search({ query: 'needle', mode: 'hybrid', limit: 1 }))[0].documentId, 'b.txt');
  assert.equal(engine.defaultMode, 'hybrid');
  assert.deepEqual(await engine.search({ query: 'needle' }), hybrid);
});
test('RRF uses k=60, deterministic identity ties and both one-channel and shared candidates', () => {
  const candidates = ['a', 'b', 'c', 'd'].map(id => ({ chunk: { id } }));
  const [a,b,c,d] = candidates;
  // b wins with rank 2 in both; slicing either channel at limit=1 loses it.
  assert.equal(fuseRrf([a,b,c,d], [d,b,c,a])[0].candidate, b);
  const union = fuseRrf([a,b], [b,c]);
  assert.deepEqual(union.map(hit => hit.candidate.chunk.id), ['b', 'a', 'c']);
  assert.equal(union[0].score, 1 / 62 + 1 / 61);
  assert.deepEqual(fuseRrf([b,a], [a,b]).map(hit => hit.candidate.chunk.id), ['a','b']);
});
test('explicit semantic modes require an embedder; lexical defaults and request validation remain clear', async () => {
  const engine = new SemanticSearchEngine(); engine.addSource(source()); await engine.initialize();
  assert.equal(engine.defaultMode, 'lexical'); assert.equal((await engine.search({ query: 'alpha' })).length, 1);
  for (const mode of ['semantic', 'hybrid']) await assert.rejects(engine.search({ query: 'alpha', mode }), /requires an Embedder/);
  await assert.rejects(engine.search({ query: 'alpha', mode: 'unknown' }), /Invalid search mode/);
  for (const limit of [0, 101, 1.5]) await assert.rejects(engine.search({ query: 'alpha', limit }), /limit/);
});
test('empty queries and zero filtered candidates avoid query inference; punctuation still has semantic meaning', async () => {
  const { engine, embedder } = await fixture();
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    assert.deepEqual(await engine.search({ query: ' \n ', mode }), []);
    assert.deepEqual(await engine.search({ query: 'needle', sources: [], mode }), []);
  }
  assert.deepEqual(await engine.search({ query: '!!!', mode: 'lexical' }), []); assert.equal(embedder.queries.length, 0);
  for (const mode of ['semantic', 'hybrid']) {
    assert.equal((await engine.search({ query: ' !!! ', mode })).length, 3);
    assert.equal(embedder.queries.at(-1), ' !!! ');
  }
  assert.equal(embedder.queries.length, 2);
});
test('all established source and metadata filters constrain both ranking channels and preserve provenance', async () => {
  const { engine, embedder } = await fixture();
  const input = source('two', { 'sub/code.ts': 'needle evidence', 'submarine/code.ts': 'needle evidence', 'sub/a.md': '# Header\nneedle [[Target]]' });
  const list = input.list;
  input.list = async () => (await list()).map(doc => ({ ...doc, createdAt: 10, modifiedAt: 20, metadata: { tags: ['keep'] } }));
  engine.addSource(input); await engine.refreshSource('two');
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    const hits = await engine.search({ query: 'needle', mode, sources: ['two'], filters: { pathPrefix: 'sub', extensions: ['ts'], tags: ['keep'], createdAfter: 5, modifiedAfter: 15 } });
    assert.equal(hits.length, 1);
    const hit = hits[0];
    assert.equal(hit.sourceId, 'two'); assert.equal(hit.documentId, 'sub/code.ts'); assert.equal(hit.path, 'sub/code.ts');
    assert.equal(hit.uri, 'memory://two/sub/code.ts'); assert.equal(hit.language, 'typescript');
    assert.equal(hit.startLine, 1); assert.equal(hit.endLine, 1); assert.equal(hit.snippet, 'needle evidence'); assert.ok(hit.chunkId); assert.ok(hit.title);
    const linked = await engine.search({ query: 'needle', mode, filters: { linkedTo: 'Target' } });
    assert.equal(linked.length, 1); assert.equal(linked[0].heading, 'Header');
    for (const filters of [{ createdAfter: 30 }, { modifiedAfter: 30 }, { tags: ['absent'] }, { extensions: ['pdf'] }, { linkedTo: 'absent' }, { pathPrefix: 'missing' }]) {
      const before = embedder.queries.length; assert.deepEqual(await engine.search({ query: 'needle', mode, filters }), []);
      assert.equal(embedder.queries.length, before);
    }
  }
});
test('semantic ties use chunk identity, regardless of insertion order and vector magnitude', async () => {
  const { engine, embedder } = await fixture(); embedder.embedQuery = async () => new Float32Array([0, 2]);
  // All identical vectors: reorder candidate insertion to prove sorting is by identity.
  const candidates = ['z', 'a', 'm'].map(id => ({ chunk: { id }, vector: new Float32Array([5, 10]) }));
  assert.deepEqual(rankSemantic(candidates, new Float32Array([2, 4]), 2).map(hit => hit.chunk.id), ['a','m','z']);
  assert.equal((await engine.search({ query: 'anything', mode: 'semantic' }))[0].documentId, 'needle.txt');
});
test('mode-aware bounded cache avoids duplicate inference and retains raw semantic query identity', async () => {
  const { engine, embedder, input } = await fixture(); const run = createSearchSession(engine, 4);
  await run.search({ query: 'needle', mode: 'lexical' }); assert.equal(embedder.queries.length, 0);
  await run.search({ query: 'needle', mode: 'semantic' }); await run.search({ query: 'needle', mode: 'semantic' });
  await run.search({ query: 'needle', mode: 'hybrid' }); const hit = await run.search({ query: 'needle' }); hit[0].snippet = 'poison';
  assert.notEqual((await run.search({ query: 'needle' }))[0].snippet, 'poison'); assert.equal(embedder.queries.length, 2);
  await run.search({ query: 'NEEDLE' }); assert.equal(embedder.queries.length, 3);
  await run.search({ query: ' needle' }); assert.equal(embedder.queries.length, 4);
  await run.search({ query: 'needle', mode: 'lexical' }); // evicted: recomputed, still no inference
  assert.equal(embedder.queries.length, 4);
  input.files.clear(); await engine.refreshSource(input.id); assert.deepEqual(await run.search({ query: 'needle' }), []);
  assert.equal(embedder.queries.length, 4); assert.equal(run.stats.hits, 3);
});
test('query and candidate vector corruption fails clearly without changing canonical state', async () => {
  const { engine, embedder, storage } = await fixture(); const good = structuredClone(storage.snapshot); const revision = engine.revision;
  for (const vector of [new Float32Array(2), new Float32Array([1, NaN]), new Float32Array([1, Infinity]), new Float32Array(3), [1,2]]) {
    embedder.embedQuery = async () => vector;
    await assert.rejects(engine.search({ query: 'needle', mode: 'semantic' }), /Invalid semantic vector/);
  }
  for (const vector of [undefined, new Float32Array(2), new Float32Array([1, Infinity]), new Float32Array(3)]) {
    assert.throws(() => rankSemantic([{ chunk: { id: 'broken' }, vector }], new Float32Array([1, 2]), 2), /Invalid semantic vector/);
  }
  assert.equal(engine.revision, revision); assert.deepEqual(storage.snapshot, good);
  assert.equal((await engine.search({ query: 'needle', mode: 'lexical' })).length, 2);
  embedder.id = 'changed'; await assert.rejects(engine.search({ query: 'needle' }), /configuration changed/);
});
test('zero document vectors remain indexable/lexical-compatible but cannot produce semantic results', async () => {
  const embedder = new RankingEmbedder(); embedder.embedDocuments = async texts => texts.map(() => new Float32Array(2));
  const { engine } = await fixture(embedder);
  assert.equal((await engine.search({ query: 'needle', mode: 'lexical' })).length, 2);
  await assert.rejects(engine.search({ query: 'needle', mode: 'semantic' }), /zero/);
});
test('query failure/cancellation preserves index and is never cached', async () => {
  const { engine, embedder, storage } = await fixture(); const run = createSearchSession(engine); const good = structuredClone(storage.snapshot);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(run.search({ query: 'needle', signal: abort.signal }), { name: 'AbortError' }); assert.equal(embedder.queries.length, 0);
  const later = new AbortController(); let calls = 0;
  embedder.embedQuery = async (_query, options) => { calls++; assert.equal(options.signal, later.signal); later.abort(); return new Float32Array([1, 2]); };
  await assert.rejects(run.search({ query: 'needle', signal: later.signal }), { name: 'AbortError' });
  embedder.embedQuery = async () => { calls++; throw new Error('inference failure'); };
  await assert.rejects(run.search({ query: 'needle' }), /inference failure/);
  await assert.rejects(run.search({ query: 'needle' }), /inference failure/);
  assert.equal(calls, 3); assert.deepEqual(storage.snapshot, good);
});
test('cancellation is checked during candidate collection, cosine and fusion loops', () => {
  const controller = new AbortController(); let checks = 0;
  const signal = { throwIfAborted() { if (++checks === 3) controller.abort(); controller.signal.throwIfAborted(); } };
  const candidates = Array.from({ length: 10 }, (_, i) => ({ chunk: { id: String(i) }, vector: new Float32Array([1,2]) }));
  assert.throws(() => rankSemantic(candidates, new Float32Array([1,2]), 2, signal), { name: 'AbortError' });
  assert.throws(() => fuseRrf(candidates, candidates, controller.signal), { name: 'AbortError' });
  assert.throws(() => collectCandidates([{ catalog: { sourceId: 'x' }, chunks: [] }], new Map(), { signal: controller.signal }), { name: 'AbortError' });
});
test('in-flight search retains one revision and cannot poison a newer session cache', async () => {
  const { engine, embedder, input } = await fixture(); const run = createSearchSession(engine);
  let release; let calls = 0;
  embedder.embedQuery = async () => { calls++; if (calls === 1) await new Promise(resolve => { release = resolve; }); return new Float32Array([1,0]); };
  const pending = run.search({ query: 'needle' });
  input.files.clear(); input.files.set('new.txt', 'needle new evidence'); await engine.refreshSource(input.id);
  const current = await run.search({ query: 'needle' }); assert.deepEqual(ids(current), ['new.txt']);
  release(); assert.deepEqual(ids(await pending), ['b.txt', 'needle.txt', 'c.txt']);
  assert.deepEqual(ids(await run.search({ query: 'needle' })), ['new.txt']); assert.equal(calls, 2);
});
test('semantic cache keys isolate filters, sources and final limits', async () => {
  const { engine, embedder } = await fixture(); const run = createSearchSession(engine);
  const requests = [
    { query: 'needle', mode: 'semantic', limit: 1 },
    { query: 'needle', mode: 'semantic', limit: 2 },
    { query: 'needle', mode: 'semantic', sources: ['one'] },
    { query: 'needle', mode: 'semantic', filters: { pathPrefix: 'b.txt' } },
  ];
  for (const request of requests) {
    const expected = await run.search(request); assert.deepEqual(await run.search(request), expected);
  }
  assert.equal(embedder.queries.length, requests.length); assert.equal(run.stats.hits, requests.length);
  assert.equal((await run.search(requests[0])).length, 1); assert.equal((await run.search(requests[1])).length, 2);
  assert.deepEqual(ids(await run.search(requests[3])), ['b.txt']);
});
test('hybrid defaults work with memory-only embeddings and compatible restart vectors', async () => {
  const embedder = new RankingEmbedder(); const input = source();
  const memory = new SemanticSearchEngine({ embedder }); memory.addSource(input); await memory.initialize();
  assert.ok((await memory.search({ query: 'alpha' }))[0].semanticRank); assert.equal(embedder.queries.length, 1);
  const { engine, storage, input: persisted } = await fixture();
  const replacement = new RankingEmbedder(); const restart = new SemanticSearchEngine({ embedder: replacement, storage });
  restart.addSource(persisted); await restart.initialize(); assert.equal(replacement.documents.length, 0);
  assert.deepEqual(await restart.search({ query: 'needle' }), await engine.search({ query: 'needle' }));
});
test('generic cosine preserves negative/orthogonal ordering without assuming unit normalization', () => {
  const candidates = [['negative', [-100, 0]], ['orthogonal', [0, 80]], ['positive', [3, 4]]]
    .map(([id, values]) => ({ chunk: { id }, vector: new Float32Array(values) }));
  assert.deepEqual(rankSemantic(candidates, new Float32Array([7, 0]), 2).map(hit => hit.chunk.id), ['positive', 'orthogonal', 'negative']);
});
test('lexical scoring weights a matched term by its rarity across the candidate set, not presence alone', () => {
  const chunk = (id, text) => ({ record: { catalog: { path: `${id}.md`, title: id, tags: [] } }, chunk: { id, text, sourceId: 's', documentId: id, uri: id }, vector: undefined });
  // "request" appears in every candidate (weak signal); "idempotency" appears in exactly one.
  // a/b each match exactly one query term, so presence-only scoring ties them and falls back
  // to identity order (a before b). IDF must break that tie toward the rarer, more
  // discriminating match (b) instead of leaving alphabetical order to decide relevance.
  const candidates = [
    chunk('a-matches-common-term', 'request handling pipeline overview'),
    chunk('b-matches-rare-term', 'idempotency guarantees for payment retries'),
    chunk('filler-1', 'request timeout settings'),
    chunk('filler-2', 'request headers normalization'),
    chunk('filler-3', 'request volume logging'),
  ];
  const ranked = rankLexical(candidates, 'request idempotency').map(hit => hit.chunk.id);
  assert.equal(ranked[0], 'b-matches-rare-term');
  assert.equal(ranked[1], 'a-matches-common-term');
});
test('lexical IDF is computed per request from the eligible candidate set, not a persisted corpus statistic', async () => {
  const { engine, embedder } = await fixture();
  // Same term, two different candidate sets (full source vs. filtered to one file):
  // document frequency differs per request, so this must not be cached/shared across searches.
  const all = await engine.search({ query: 'needle', mode: 'lexical' });
  const filtered = await engine.search({ query: 'needle', mode: 'lexical', filters: { pathPrefix: 'b.txt' } });
  assert.deepEqual(ids(all), ['needle.txt', 'b.txt']);
  assert.deepEqual(ids(filtered), ['b.txt']);
  assert.equal(embedder.queries.length, 0);
});
