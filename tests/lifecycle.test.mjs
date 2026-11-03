import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticSearchEngine, ParserRegistry, PlainTextParser, FileTypeRegistry, FILE_TYPES, contentHash } from '../dist/index.js';
import { TestEmbedder, MemoryStorage, source } from './fixtures/lifecycle.mjs';
const engineFor = (input, options = {}) => { const engine = new SemanticSearchEngine(options); engine.addSource(input); return engine; };

test('all four storage/embedder configurations preserve lexical results and never embed queries', async () => {
  let expected;
  for (const persisted of [false, true]) for (const embedded of [false, true]) {
    const storage = persisted ? new MemoryStorage() : undefined; const embedder = embedded ? new TestEmbedder() : undefined;
    const engine = engineFor(source(), { storage, embedder }); await engine.initialize();
    const hits = await engine.search({ mode: 'lexical', query: 'alpha material' });
    expected ??= hits; assert.deepEqual(hits, expected); assert.ok(hits.every(hit => hit.semanticRank === undefined));
    if (storage) { assert.equal(storage.snapshot.documents.length, 3); assert.equal(storage.snapshot.chunks.length, 3); assert.equal(storage.snapshot.schemaVersion, 3); assert.ok(storage.snapshot.parserVersion); assert.ok(storage.snapshot.chunking); }
    if (embedder) assert.equal(embedder.queryCalls, 0);
    const report = await engine.refreshSource('fixture'); assert.equal(report.embeddedTexts, 0);
    if (embedder) assert.equal(embedder.count, 3);
    if (storage && !embedder) assert.ok(storage.snapshot.chunks.every(chunk => chunk.vector === undefined));
  }
});
test('initial, unchanged, changed, new, renamed and deleted content has deterministic embedding lifecycle', async () => {
  const input = source(); const storage = new MemoryStorage(); const embedder = new TestEmbedder();
  const engine = engineFor(input, { storage, embedder });
  const [first] = await engine.initialize(); assert.equal(first.embeddedTexts, 3);
  const initial = structuredClone(storage.snapshot);
  assert.equal((await engine.refreshSource(input.id)).reusedVectors, 3); assert.equal(embedder.count, 3);
  input.files.set('b.txt', 'changed beta material');
  assert.equal((await engine.refreshSource(input.id)).embeddedTexts, 1); assert.equal(embedder.count, 4);
  for (const id of ['a.txt', 'c.txt']) assert.deepEqual(storage.snapshot.chunks.find(c => c.documentId === id).vector, initial.chunks.find(c => c.documentId === id).vector);
  input.files.set('d.txt', 'delta material'); await engine.refreshSource(input.id); assert.equal(embedder.count, 5);
  const old = storage.snapshot.chunks.find(c => c.documentId === 'a.txt');
  input.files.set('renamed.txt', input.files.get('a.txt')); input.files.delete('a.txt');
  await engine.refreshSource(input.id); assert.equal(embedder.count, 5);
  const renamed = storage.snapshot.chunks.find(c => c.documentId === 'renamed.txt');
  assert.notEqual(renamed.id, old.id); assert.deepEqual(renamed.vector, old.vector); assert.equal(renamed.uri, 'memory://fixture/renamed.txt');
  assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' }))[0].path, 'renamed.txt');
  input.files.delete('renamed.txt'); await engine.refreshSource(input.id);
  assert.deepEqual(await engine.search({ mode: 'lexical', query: 'alpha' }), []);
  assert.ok(!storage.snapshot.documents.some(d => d.documentId === 'a.txt' || d.documentId === 'renamed.txt'));
  assert.ok(!storage.snapshot.chunks.some(c => c.text === 'alpha material'));
});
test('restart reconciles live sources before publishing and reuses compatible vectors across sources', async () => {
  const storage = new MemoryStorage(); const first = new TestEmbedder(); const a = source(); const b = source('other', { 'a.txt': 'other content' });
  const engine = engineFor(a, { storage, embedder: first }); engine.addSource(b); await engine.initialize(); assert.equal(first.count, 4);
  const second = new TestEmbedder(); const restarted = engineFor(a, { storage, embedder: second }); restarted.addSource(b);
  assert.deepEqual(await restarted.search({ mode: 'lexical', query: 'material' }), []);
  await restarted.initialize(); assert.equal(second.count, 0); assert.equal(storage.loads, 2); assert.equal(restarted.getCatalog().length, 4);
  a.files.delete('a.txt'); a.files.set('b.txt', 'new live content');
  const third = new TestEmbedder(); const changed = engineFor(a, { storage, embedder: third }); await changed.initialize();
  assert.equal(third.count, 1); assert.deepEqual(await changed.search({ mode: 'lexical', query: 'alpha' }), []);
  assert.ok(storage.snapshot.documents.every(doc => doc.sourceId === a.id));
});
test('lexical storage restart rebuilds live provenance and retains matching chunk identities', async () => {
  const storage = new MemoryStorage(); const input = source(); await engineFor(input, { storage }).initialize();
  const ids = storage.snapshot.chunks.map(c => c.id); const [report] = await engineFor(input, { storage }).initialize();
  assert.equal(report.unchangedChunks, 3);
  assert.deepEqual(storage.snapshot.chunks.map(c => c.id), ids); assert.equal(storage.snapshot.embedding, undefined);
});
test('duplicates share inference by exact text while keeping distinct deterministic chunk identities', async () => {
  const embedder = new TestEmbedder(); const storage = new MemoryStorage();
  const engine = engineFor(source('fixture', { 'a.txt': 'same text', 'b.txt': 'same text', 'c.txt': 'different text' }), { embedder, storage });
  await engine.initialize(); assert.equal(embedder.count, 2); assert.equal(new Set(storage.snapshot.chunks.map(c => c.id)).size, 3);
  assert.deepEqual(storage.snapshot.chunks[0].vector, storage.snapshot.chunks[1].vector);
  assert.notDeepEqual(storage.snapshot.chunks[0].vector, storage.snapshot.chunks[2].vector);
});
test('embedding identity/input/schema changes invalidate vectors; layout changes reuse identical inputs', async () => {
  const original = new MemoryStorage(); await engineFor(source(), { storage: original, embedder: new TestEmbedder() }).initialize();
  for (const mutate of [s => s.schemaVersion = 2, s => s.embeddingInputVersion = 'old', s => delete s.embeddingInputVersion, s => s.parserVersion += '-different', s => s.chunkerVersion += '-different',
    s => s.chunking.targetChars++, s => s.chunking.overlapLines++, s => s.embedding.id += '-different', s => { s.embedding.dimensions++; s.chunks.forEach(chunk => chunk.vector.push(0)); }]) {
    const storage = new MemoryStorage(); storage.snapshot = structuredClone(original.snapshot); mutate(storage.snapshot);
    const embedder = new TestEmbedder(); await engineFor(source(), { storage, embedder }).initialize();
    const before = structuredClone(original.snapshot); mutate(before);
    assert.equal(embedder.count, before.schemaVersion === original.snapshot.schemaVersion &&
      before.embeddingInputVersion === original.snapshot.embeddingInputVersion &&
      before.embedding.id === original.snapshot.embedding.id && before.embedding.dimensions === original.snapshot.embedding.dimensions ? 0 : 3);
  }
  for (const options of [{ chunking: { targetChars: 80 } }, { chunking: { overlapLines: 0 } }]) {
    const storage = new MemoryStorage(); storage.snapshot = structuredClone(original.snapshot);
    const embedder = new TestEmbedder(); await engineFor(source(), { storage, embedder, ...options }).initialize(); assert.equal(embedder.count, 0);
  }
  for (const property of ['id', 'dimensions']) {
    const storage = new MemoryStorage(); storage.snapshot = structuredClone(original.snapshot); const embedder = new TestEmbedder();
    embedder[property] = property === 'id' ? 'other-model' : 5;
    await engineFor(source(), { storage, embedder }).initialize(); assert.equal(embedder.count, 3);
  }
});
test('custom parsers need versions for reuse; registry changes reparse but retain matching vectors', async () => {
  for (const version of [undefined, 'custom-v1']) {
    const storage = new MemoryStorage(); const parsers = new ParserRegistry([new PlainTextParser()], undefined, version);
    await engineFor(source(), { parsers, storage, embedder: new TestEmbedder() }).initialize();
    const embedder = new TestEmbedder(); await engineFor(source(), { parsers, storage, embedder }).initialize(); assert.equal(embedder.count, version ? 0 : 3);
    const changed = new TestEmbedder();
    await engineFor(source(), { parsers: new ParserRegistry([new PlainTextParser()], undefined, 'custom-v2'), storage, embedder: changed }).initialize(); assert.equal(changed.count, version ? 0 : 3);
  }
  const storage = new MemoryStorage(); await engineFor(source(), { storage, embedder: new TestEmbedder() }).initialize();
  const types = new FileTypeRegistry(FILE_TYPES.map(type => ({ ...type, maxBytes: type.maxBytes + 1 })));
  const embedder = new TestEmbedder(); await engineFor(source(), { storage, embedder, parsers: new ParserRegistry(undefined, types) }).initialize(); assert.equal(embedder.count, 0);
});
test('compatible corrupted snapshot fails explicitly without saving or publishing any records', async () => {
  const good = new MemoryStorage(); await engineFor(source(), { storage: good, embedder: new TestEmbedder() }).initialize();
  for (const mutate of [s => s.documents.push(s.documents[0]), s => s.chunks[0].vector = [1], s => s.chunks[0].vector[0] = NaN,
    s => s.chunks[0].text = 'wrong text', s => s.chunks[0].sourceId = 'wrong', s => s.chunks.push(s.chunks[0]), s => s.chunks = {},
    s => s.documents[0].tags = null, s => s.chunks[0].endLine = 100]) {
    const storage = new MemoryStorage(); storage.snapshot = structuredClone(good.snapshot); mutate(storage.snapshot);
    const engine = engineFor(source(), { storage, embedder: new TestEmbedder() });
    await assert.rejects(engine.initialize(), /Corrupt/); assert.equal(engine.getCatalog().length, 0); assert.equal(storage.saves, 0);
  }
});
test('a forged matching content hash cannot reuse a vector for different actual content', async () => {
  const storage = new MemoryStorage(); await engineFor(source(), { storage, embedder: new TestEmbedder() }).initialize();
  storage.snapshot.chunks[0].contentHash = contentHash('different actual text');
  await assert.rejects(engineFor(source(), { storage, embedder: new TestEmbedder() }).initialize(), /Corrupt/);
});
test('failed list/read/parser/embedding/save preserve the previous live and canonical persisted index', async () => {
  for (const failure of ['list', 'read', 'parse', 'embed', 'save']) {
    const input = source(); const storage = new MemoryStorage(); const embedder = new TestEmbedder(); const parsers = new ParserRegistry();
    const engine = engineFor(input, { storage, embedder, parsers }); await engine.initialize();
    const old = structuredClone(storage.snapshot); const revision = engine.revision;
    input.files.set('a.txt', 'replacement material');
    const fail = async () => { throw new Error('injected failure'); };
    if (failure === 'list' || failure === 'read') input[failure] = fail;
    if (failure === 'parse') parsers.parse = fail;
    if (failure === 'embed') embedder.embedDocuments = fail;
    if (failure === 'save') storage.save = fail;
    await assert.rejects(engine.refreshSource(input.id), /injected failure/);
    assert.equal(engine.revision, revision); assert.deepEqual(storage.snapshot, old); assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' })).length, 1);
  }
});
test('invalid embedding batches/vectors never commit candidate state', async () => {
  for (const vectors of [[], [[1, 2, 3, 4]], [new Float32Array(2)], [new Float32Array([NaN, 1, 2, 3])]]) {
    const input = source('fixture', { 'a.txt': 'alpha' }); const embedder = new TestEmbedder(); const engine = engineFor(input, { embedder }); await engine.initialize();
    input.files.set('a.txt', 'replacement'); embedder.embedDocuments = async () => vectors;
    await assert.rejects(engine.refreshSource(input.id), /Invalid embedding/); assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' })).length, 1);
  }
});
test('cancellation through load/list/read/batched embedding/save preserves prior state', async () => {
  for (const stage of ['load', 'list', 'read', 'embed', 'save']) {
    const input = source(); const storage = new MemoryStorage(); const embedder = new TestEmbedder(); const engine = engineFor(input, { storage, embedder });
    if (stage !== 'load') await engine.initialize();
    const old = structuredClone(storage.snapshot); const revision = engine.revision; const abort = new AbortController();
    input.files.set('a.txt', 'changed material');
    const target = stage === 'load' || stage === 'save' ? storage : stage === 'embed' ? embedder : input;
    const name = stage === 'embed' ? 'embedDocuments' : stage; const original = target[name].bind(target);
    target[name] = async (...args) => { assert.equal(args.at(-1).signal, abort.signal); abort.abort(); return original(...args); };
    await assert.rejects(engine.refreshSource(input.id, { signal: abort.signal }), { name: 'AbortError' });
    assert.equal(engine.revision, revision); assert.deepEqual(storage.snapshot, old);
    assert.equal(engine.getCatalog().length, stage === 'load' ? 0 : 3);
  }
  const input = source('fixture', Object.fromEntries(Array.from({ length: 35 }, (_, i) => [`${i}.txt`, `unique content ${i}`])));
  const embedder = new TestEmbedder(); const abort = new AbortController(); const original = embedder.embedDocuments.bind(embedder);
  embedder.embedDocuments = async (...args) => { const result = await original(...args); abort.abort(); return result; };
  const engine = engineFor(input, { embedder }); await assert.rejects(engine.initialize({ signal: abort.signal }));
  assert.equal(embedder.count, 35); assert.equal(engine.getCatalog().length, 0);
});
test('successful atomic save is the commit boundary even if cancellation arrives after publication', async () => {
  const storage = new MemoryStorage(); const abort = new AbortController(); const original = storage.save.bind(storage);
  storage.save = async (...args) => { await original(...args); abort.abort(); };
  const engine = engineFor(source(), { storage }); await engine.initialize({ signal: abort.signal });
  assert.equal(engine.getCatalog().length, 3); assert.equal(storage.snapshot.documents.length, 3);
});
test('load errors surface and remain retryable; concurrent mutations are rejected', async () => {
  const storage = new MemoryStorage(); const load = storage.load.bind(storage); storage.load = async () => { throw new Error('load failed'); };
  const input = source(); const engine = engineFor(input, { storage }); await assert.rejects(engine.initialize(), /load failed/);
  storage.load = load; await engine.initialize(); assert.equal(engine.getCatalog().length, 3);
  input.files.set('a.txt', 'changed alpha');
  let release; storage.save = () => new Promise(resolve => { release = resolve; });
  const updating = engine.refreshSource('fixture'); while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(engine.refreshSource('fixture'), /in progress/); assert.throws(() => engine.removeSource('fixture'), /in progress/);
  assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' })).length, 1); release(); await updating;
});
test('editing one Markdown section embeds only that chunk within the document', async () => {
  const input = source('fixture', { 'sections.md': '# A\nalpha\n# B\nbeta\n# C\ngamma' });
  const storage = new MemoryStorage(); const embedder = new TestEmbedder(); const engine = engineFor(input, { storage, embedder });
  await engine.initialize(); assert.equal(embedder.count, 3); const old = structuredClone(storage.snapshot.chunks);
  input.files.set('sections.md', '# A\nalpha\n# B\nchanged beta\n# C\ngamma');
  const report = await engine.refreshSource(input.id); assert.equal(report.embeddedTexts, 1); assert.equal(report.unchangedChunks, 2);
  for (const heading of ['A', 'C']) assert.deepEqual(storage.snapshot.chunks.find(chunk => chunk.heading === heading), old.find(chunk => chunk.heading === heading));
});
test('later batch failure commits nothing and retry embeds all still-missing content', async () => {
  const input = source(); const embedder = new TestEmbedder(); const storage = new MemoryStorage(); const engine = engineFor(input, { embedder, storage }); await engine.initialize();
  const old = structuredClone(storage.snapshot); const original = embedder.embedDocuments.bind(embedder);
  for (let i = 0; i < 35; i++) input.files.set(`new${i}.txt`, `new content ${i}`);
  embedder.embedDocuments = async (texts, options) => { await original(texts.slice(0, 16), options); throw new Error('second batch failed'); };
  await assert.rejects(engine.refreshSource(input.id), /second batch/); assert.deepEqual(storage.snapshot, old); assert.equal(engine.getCatalog().length, 3);
  embedder.embedDocuments = original; const report = await engine.refreshSource(input.id); assert.equal(report.embeddedTexts, 35);
});
test('lexical refresh preserves a vector snapshot for subsequent semantic reuse', async () => {
  const input = source(); const storage = new MemoryStorage(); await engineFor(input, { storage, embedder: new TestEmbedder() }).initialize();
  const [report] = await engineFor(input, { storage }).initialize(); assert.equal(report.persistence, 'preserved'); assert.ok(storage.snapshot.embedding); assert.ok(storage.snapshot.chunks.every(c => c.vector));
  const embedder = new TestEmbedder(); await engineFor(input, { storage, embedder }).initialize(); assert.equal(embedder.count, 0);
});
test('multi-source initialization remains per-source atomic; empty refresh persists deletion', async () => {
  const storage = new MemoryStorage(); const a = source(); const b = source('other');
  const engine = engineFor(a, { storage }); engine.addSource(b); b.read = async () => { throw new Error('other unavailable'); };
  await assert.rejects(engine.initialize(), /other unavailable/); assert.equal(engine.getCatalog().length, 3);
  assert.ok(storage.snapshot.documents.every(doc => doc.sourceId === a.id));
  a.files.clear(); await engine.refreshSource(a.id); assert.deepEqual(storage.snapshot.documents, []); assert.deepEqual(storage.snapshot.chunks, []);
});
test('mid-refresh embedding configuration changes and chunking errors cannot commit replacement state', async () => {
  for (const failure of ['configuration', 'chunking']) {
    const input = source(); const embedder = new TestEmbedder(); const parsers = new ParserRegistry(); const engine = engineFor(input, { embedder, parsers }); await engine.initialize();
    input.files.set('a.txt', 'replacement');
    if (failure === 'configuration') {
      const original = embedder.embedDocuments.bind(embedder);
      embedder.embedDocuments = async (...args) => { const vectors = await original(...args); embedder.id += '-changed'; return vectors; };
    } else {
      const original = parsers.parse.bind(parsers);
      parsers.parse = async (...args) => ({ ...await original(...args), sections: [{ startLine: 999, endLine: 1000, kind: 'text' }] });
    }
    await assert.rejects(engine.refreshSource(input.id)); assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' })).length, 1);
  }
});
