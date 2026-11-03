import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticSearchEngine } from '../dist/index.js';
import { retrieveUnassessedEvidence } from '../examples/evidence.mjs';
import { source, MemoryStorage } from './fixtures/lifecycle.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(text = '# Backup drills\nFor each drill record elapsed restoration time.') {
  const input = source('s', { 'backup.md': text });
  const storage = new MemoryStorage();
  const embedder = { id: 'test-equal-directions-v1', dimensions: 2,
    async embedDocuments(texts) { return texts.map(() => new Float32Array([2, 1])); },
    async embedQuery() { return new Float32Array([4, 2]); } };
  const engine = new SemanticSearchEngine({ storage, embedder });
  engine.addSource(input); await engine.initialize();
  return { engine, input, storage, embedder };
}
test('a perfectly aligned topical result is still unassessed evidence with intact provenance', async () => {
  const { engine } = await fixture();
  const request = { query: 'How many seconds did last Tuesday restoration take?', mode: 'semantic' };
  const raw = await engine.search(request);
  const result = await retrieveUnassessedEvidence(engine, request);
  assert.equal(result.retrieval, 'retrieved');
  assert.equal(result.answerability, 'not-assessed');
  assert.deepEqual(result.candidates, raw);
  assert.equal(result.candidates[0].snippet, '# Backup drills\nFor each drill record elapsed restoration time.');
  for (const key of ['sourceId', 'documentId', 'chunkId', 'uri', 'path', 'title', 'heading', 'startLine', 'endLine']) assert.ok(result.candidates[0][key] !== undefined);
  assert.equal(result.indexChangedDuringSearch, false);
});
test('no-results never means corpus absence, including lexical misses, filters and empty requests', async () => {
  const { engine } = await fixture('# Backup drill\nElapsed restoration: 41 seconds.');
  assert.equal(engine.getCatalog().length, 1);
  for (const request of [{ query: 'duration', mode: 'lexical' }, { query: 'seconds', filters: { pathPrefix: 'excluded' } }, { query: '   ' }]) {
    const result = await retrieveUnassessedEvidence(engine, request);
    assert.equal(result.retrieval, 'no-results');
    assert.equal(result.answerability, 'not-assessed');
    assert.deepEqual(result.candidates, []);
  }
  const result = await retrieveUnassessedEvidence(engine, { query: 'duration', mode: 'semantic' });
  assert.equal(result.retrieval, 'retrieved');
  assert.equal(result.answerability, 'not-assessed');
});
test('model failure or unavailable semantic retrieval is not converted into a no-answer result', async () => {
  const { engine, storage, embedder } = await fixture();
  const prior = structuredClone(storage.snapshot), revision = engine.revision;
  const failure = new Error('model unavailable');
  embedder.embedQuery = async () => { throw failure; };
  await assert.rejects(retrieveUnassessedEvidence(engine, { query: 'time' }), error => error === failure);
  assert.deepEqual(storage.snapshot, prior); assert.equal(engine.revision, revision);
  const lexical = new SemanticSearchEngine();
  await assert.rejects(retrieveUnassessedEvidence(lexical, { query: 'time', mode: 'semantic' }), /requires an Embedder/);
});
test('abort before and during query inference propagates without publishing an assessment', async () => {
  const { engine, embedder } = await fixture();
  const before = new AbortController(); before.abort(new Error('before'));
  await assert.rejects(retrieveUnassessedEvidence(engine, { query: 'time', signal: before.signal }), /before/);
  const gate = deferred(), controller = new AbortController(); let observed;
  embedder.embedQuery = async (_text, options) => { observed = options.signal; await gate.promise; return new Float32Array([4, 2]); };
  const pending = retrieveUnassessedEvidence(engine, { query: 'time', signal: controller.signal });
  assert.equal(observed, controller.signal);
  controller.abort(new Error('during')); gate.resolve();
  await assert.rejects(pending, /during/);
});
test('host example reports overlapping revisions without mistaking unchanged revision for source freshness', async () => {
  const { engine, input, embedder } = await fixture();
  const gate = deferred();
  embedder.embedQuery = async () => { await gate.promise; return new Float32Array([4, 2]); };
  const pending = retrieveUnassessedEvidence(engine, { query: 'drill', mode: 'semantic' });
  input.files.set('backup.md', '# Backup drills\nMeasured restoration took 41 seconds.');
  await engine.refreshSource(input.id); gate.resolve();
  const result = await pending;
  assert.equal(result.indexChangedDuringSearch, true);
  assert.match(result.candidates[0].snippet, /record elapsed/);
  assert.equal(result.answerability, 'not-assessed');
  input.files.set('backup.md', '# Backup drills\nUnindexed new source version.');
  const later = await retrieveUnassessedEvidence(engine, { query: 'drill', mode: 'lexical' });
  assert.equal(later.indexChangedDuringSearch, false);
  assert.match(later.candidates[0].snippet, /41 seconds/);
  assert.equal(later.answerability, 'not-assessed');
});
