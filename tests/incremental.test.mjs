import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, utimes, stat, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticSearchEngine, ParserRegistry } from '../dist/index.js';
import { FileSystemFolderSource } from '../dist/adapters/filesystem.js';
import { TestEmbedder, MemoryStorage, source } from './fixtures/lifecycle.mjs';
function revisionSource(initial = { 'a.txt': 'alpha', 'b.txt': 'beta', 'empty.txt': '' }) {
  const input = source('fixture', initial); const list = input.list;
  input.reads = 0; const read = input.read;
  input.read = (...args) => { input.reads++; return read(...args); };
  input.list = async options => (await list(options)).map(doc => ({ ...doc, revision: input.files.get(doc.id) || 'empty' }));
  return input;
}
function engineFor(input, storage, embedder = new TestEmbedder(), options = {}) {
  const parsers = options.parsers ?? new ParserRegistry(); let parses = 0; const parse = parsers.parse.bind(parsers);
  parsers.parse = (...args) => { parses++; return parse(...args); };
  const engine = new SemanticSearchEngine({ storage, embedder, ...options, parsers }); engine.addSource(input);
  return { engine, embedder, get parses() { return parses; } };
}
test('warm restart skips all reads/parsing/inference/writes, including empty documents', async () => {
  const input = revisionSource(); const storage = new MemoryStorage();
  await engineFor(input, storage).engine.initialize(); const saves = storage.saves; input.reads = 0;
  const next = engineFor(input, storage); const progress = []; const [report] = await next.engine.initialize({ onDocument: event => progress.push(event) });
  assert.equal(input.reads, 0); assert.equal(next.parses, 0); assert.equal(next.embedder.count, 0); assert.equal(storage.saves, saves);
  assert.equal(report.documentsReused, 3); assert.equal(report.documentsRead, 0); assert.equal(report.persistence, 'unchanged');
  assert.equal(next.engine.getCatalog().length, 3); assert.equal(progress.at(-1).completed, 3); assert.ok(progress.every(event => event.disposition === 'reused'));
  const again = await next.engine.refreshSource(input.id); assert.equal(again.documentsReused, 3); assert.equal(again.persistence, 'unchanged'); assert.equal(storage.saves, saves);
});
test('edits, additions, renames, removals and empty content reconcile independently', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); const { engine, embedder } = engineFor(input, storage); await engine.initialize();
  input.files.set('a.txt', 'changed alpha'); input.files.set('new.txt', 'new material'); input.files.set('renamed.txt', input.files.get('b.txt')); input.files.delete('b.txt');
  const report = await engine.refreshSource(input.id);
  assert.equal(report.documentsParsed, 3); assert.equal(report.documentsReused, 1); assert.equal(report.documentsDeleted, 1); assert.equal(report.embeddedTexts, 2);
  assert.equal(embedder.count, 4); assert.equal((await engine.search({ query: 'beta', mode: 'lexical' }))[0].path, 'renamed.txt');
  input.files.clear(); const empty = await engine.refreshSource(input.id); assert.equal(empty.documentsDeleted, 4); assert.equal(storage.snapshot.documents.length, 0);
});
test('sources without revisions always read and parse; modifiedAt alone is not trusted', async () => {
  const input = source(); const list = input.list; input.list = async options => (await list(options)).map(doc => ({ ...doc, modifiedAt: 123 }));
  const storage = new MemoryStorage(); const first = engineFor(input, storage); await first.engine.initialize();
  const next = engineFor(input, storage); const [report] = await next.engine.initialize();
  assert.equal(next.parses, 3); assert.equal(report.documentsRead, 3); assert.equal(report.documentsReused, 0); assert.equal(next.embedder.count, 0); assert.equal(report.persistence, 'unchanged');
});
test('explicit verification bypasses a falsely unchanged token but reuses unchanged vectors', async () => {
  const input = revisionSource(); const list = input.list; input.list = async options => (await list(options)).map(doc => ({ ...doc, revision: 'fixed' }));
  const storage = new MemoryStorage(); const { engine } = engineFor(input, storage); await engine.initialize();
  input.files.set('a.txt', 'replacement'); assert.equal((await engine.refreshSource(input.id)).documentsRead, 0);
  const report = await engine.refreshSource(input.id, { verifyContent: true }); assert.equal(report.documentsParsed, 3); assert.equal(report.embeddedTexts, 1);
  assert.equal((await engine.search({ query: 'replacement', mode: 'lexical' })).length, 1);
  assert.equal((await engine.refreshSource(input.id, { verifyContent: true })).embeddedTexts, 0);
});
test('old schema-3 snapshots bootstrap revisions once without losing vectors', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); await engineFor(input, storage).engine.initialize(); delete storage.snapshot.documentRevisions;
  const next = engineFor(input, storage); const [report] = await next.engine.initialize(); assert.equal(report.documentsParsed, 3); assert.equal(report.embeddedTexts, 0); assert.equal(report.persistence, 'saved');
  assert.equal((await engineFor(input, storage).engine.initialize())[0].documentsRead, 0);
});
test('model changes reuse passages but invalidate inference; parser/chunk changes reparse', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); await engineFor(input, storage).engine.initialize();
  const model = new TestEmbedder(); model.id = 'other'; const next = engineFor(input, storage, model); const [report] = await next.engine.initialize();
  assert.equal(next.parses, 0); assert.equal(report.documentsReused, 3); assert.equal(model.count, 2);
  const changed = engineFor(input, storage, model, { chunking: { targetChars: 80 } }); assert.equal((await changed.engine.initialize())[0].documentsParsed, 3);
  const parser = new ParserRegistry(undefined, undefined, 'changed'); const reparsed = engineFor(input, storage, model, { parsers: parser }); assert.equal((await reparsed.engine.initialize())[0].documentsParsed, 3);
});
test('corrupt revision entries fail explicitly before publication', async () => {
  const input = revisionSource(); const good = new MemoryStorage(); await engineFor(input, good).engine.initialize();
  for (const mutate of [s => s.documentRevisions.push(s.documentRevisions[0]), s => s.documentRevisions[0].revision = '', s => s.documentRevisions[0].documentId = 'missing', s => s.documentRevisions = {}]) {
    const storage = new MemoryStorage(); storage.snapshot = structuredClone(good.snapshot); mutate(storage.snapshot);
    const { engine } = engineFor(input, storage); await assert.rejects(engine.initialize(), /Corrupt/); assert.equal(engine.getCatalog().length, 0); assert.equal(storage.saves, 0);
  }
});
test('callback failure/cancellation and failed writes preserve committed state', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); const { engine } = engineFor(input, storage); await engine.initialize(); const previous = structuredClone(storage.snapshot); const revision = engine.revision;
  await assert.rejects(engine.refreshSource(input.id, { onDocument() { throw new Error('callback failed'); } }), /callback/);
  const controller = new AbortController(); await assert.rejects(engine.refreshSource(input.id, { signal: controller.signal, onDocument() { controller.abort(); } }), { name: 'AbortError' });
  input.files.set('a.txt', 'changed'); storage.save = async () => { throw new Error('save failed'); }; await assert.rejects(engine.refreshSource(input.id), /save failed/);
  assert.deepEqual(storage.snapshot, previous); assert.equal(engine.revision, revision); assert.equal((await engine.search({ query: 'alpha', mode: 'lexical' })).length, 1);
});
test('lexical restarts preserve semantic storage and subsequent semantic restart reuses it', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); await engineFor(input, storage).engine.initialize(); const previous = structuredClone(storage.snapshot);
  const lexical = new SemanticSearchEngine({ storage }); lexical.addSource(input); const [report] = await lexical.initialize(); assert.equal(report.documentsRead, 0); assert.equal(report.persistence, 'preserved');
  input.files.set('a.txt', 'new alpha'); await lexical.refreshSource(input.id); assert.deepEqual(storage.snapshot, previous);
  const next = engineFor(input, storage); const [semantic] = await next.engine.initialize(); assert.equal(semantic.documentsParsed, 1); assert.equal(semantic.embeddedTexts, 1);
});
test('filesystem high resolution revisions detect equal-size writes with restored mtime and replacements', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provena-revisions-'));
  try {
    const path = join(root, 'a.txt'); await writeFile(path, 'alpha'); const before = await stat(path);
    const input = new FileSystemFolderSource({ id: 'fixture', root }); const storage = new MemoryStorage(); const next = engineFor(input, storage); await next.engine.initialize();
    await writeFile(path, 'bravo'); await utimes(path, before.atime, before.mtime);
    assert.equal((await next.engine.refreshSource(input.id)).documentsParsed, 1);
    await writeFile(join(root, 'replacement'), 'cello'); await utimes(join(root, 'replacement'), before.atime, before.mtime); await rename(join(root, 'replacement'), path);
    assert.equal((await next.engine.refreshSource(input.id)).documentsParsed, 1); assert.equal((await next.engine.refreshSource(input.id)).documentsRead, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('multi-source in-memory refresh keeps stable order and avoids unnecessary writes; restart still reconciles each source', async () => {
  const input = revisionSource(); const other = revisionSource({ 'other.txt': 'other material' }); other.id = 'other';
  const list = other.list; other.list = async options => (await list(options)).map(doc => ({ ...doc, sourceId: 'other', uri: `memory://other/${doc.id}` }));
  const storage = new MemoryStorage(); const first = engineFor(input, storage); first.engine.addSource(other); await first.engine.initialize(); const saves = storage.saves;
  for (const id of [input.id, other.id]) assert.equal((await first.engine.refreshSource(id)).persistence, 'unchanged');
  assert.equal(storage.saves, saves);
  const next = engineFor(input, storage); next.engine.addSource(other); const reports = await next.engine.initialize();
  assert.ok(reports.every(report => report.documentsRead === 0)); assert.equal(next.embedder.count, 0); assert.equal(next.engine.getCatalog().length, 4);
  const pruned = engineFor(input, storage); await pruned.engine.initialize(); assert.ok(storage.snapshot.documents.every(doc => doc.sourceId === input.id));
});

test('embedding input version changes keep passages but replace vectors', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); await engineFor(input, storage).engine.initialize();
  storage.snapshot.embeddingInputVersion = 'previous';
  const next = engineFor(input, storage); const [report] = await next.engine.initialize();
  assert.equal(next.parses, 0); assert.equal(report.documentsReused, 3); assert.equal(report.embeddedTexts, 2);
});
test('files that exceed admission limits or become symlinks are removed on refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provena-admission-refresh-'));
  try {
    const path = join(root, 'a.txt'); await writeFile(path, 'alpha');
    const input = new FileSystemFolderSource({ id: 'fixture', root, maxFileBytes: 10 }); const storage = new MemoryStorage(); const { engine } = engineFor(input, storage); await engine.initialize();
    await writeFile(path, 'this file is now too large'); const report = await engine.refreshSource(input.id);
    assert.equal(report.documentsDeleted, 1); assert.equal(engine.getCatalog().length, 0);
    await writeFile(path, 'alpha'); await engine.refreshSource(input.id); await rm(path);
    const { symlink } = await import('node:fs/promises'); await symlink('missing-target', path);
    assert.equal((await engine.refreshSource(input.id)).documentsDeleted, 1); assert.equal(storage.snapshot.chunks.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('layout upgrades reparse live documents but infer only missing exact inputs, then restart unchanged', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); await engineFor(input, storage).engine.initialize();
  storage.snapshot.chunkerVersion = 'previous-layout';
  input.files.set('a.txt', 'updated alpha'); input.reads = 0;
  const next = engineFor(input, storage); const [report] = await next.engine.initialize();
  assert.equal(report.documentsParsed, 3); assert.equal(report.documentsReused, 0);
  assert.equal(report.embeddedTexts, 1); assert.equal(report.reusedVectors, 1);
  assert.deepEqual(next.embedder.calls, [['updated alpha']]);
  assert.equal((await next.engine.search({ query: 'updated', mode: 'lexical' }))[0].snippet, 'updated alpha');
  input.reads = 0; const restarted = engineFor(input, storage); const [warm] = await restarted.engine.initialize();
  assert.equal(input.reads, 0); assert.equal(restarted.parses, 0); assert.equal(restarted.embedder.count, 0);
  assert.equal(warm.documentsReused, 3); assert.equal(warm.persistence, 'unchanged');
});

test('layout-incompatible snapshots must validate vectors before reusing them', async () => {
  const input = revisionSource(); const storage = new MemoryStorage(); await engineFor(input, storage).engine.initialize();
  storage.snapshot.chunkerVersion = 'previous-layout'; storage.snapshot.chunks[0].vector = [1];
  const saved = storage.saves; input.reads = 0; const next = engineFor(input, storage);
  await assert.rejects(next.engine.initialize(), /Corrupt/);
  assert.equal(input.reads, 0); assert.equal(next.embedder.count, 0); assert.equal(storage.saves, saved);
  assert.equal(next.engine.getCatalog().length, 0);
});
