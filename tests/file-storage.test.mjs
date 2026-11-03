import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileIndexStorage } from '../dist/adapters/filesystem.js';
import { SemanticSearchEngine } from '../dist/index.js';
import { source, TestEmbedder } from './fixtures/lifecycle.mjs';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-storage-')); t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'index.json'); return { root, path, storage: new FileIndexStorage(path) };
}
test('file storage persists a complete index and supports restart reuse', async t => {
  const { storage, path } = await fixture(t); assert.equal(await storage.load(), null);
  const engine = new SemanticSearchEngine({ storage, embedder: new TestEmbedder() }); engine.addSource(source()); await engine.initialize();
  assert.equal(JSON.parse(await readFile(path, 'utf8')).chunks.length, 3);
  const embedder = new TestEmbedder(); const restarted = new SemanticSearchEngine({ storage: new FileIndexStorage(path), embedder }); restarted.addSource(source());
  await restarted.initialize(); assert.equal(embedder.count, 0);
});
test('atomic file save preserves canonical data on serialization failure and cancellation before rename', async t => {
  const { storage, root, path } = await fixture(t); const old = { marker: 'previous complete snapshot' }; await storage.save(old);
  await assert.rejects(storage.save({ bigint: 1n })); assert.deepEqual(await storage.load(), old);
  const abort = new AbortController(); const check = abort.signal.throwIfAborted.bind(abort.signal); let checks = 0;
  t.mock.method(abort.signal, 'throwIfAborted', () => { if (++checks === 2) abort.abort(); check(); });
  await assert.rejects(storage.save({ marker: 'candidate' }, { signal: abort.signal }), { name: 'AbortError' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), old); assert.deepEqual(await readdir(root), ['index.json']);
});
test('file storage surfaces corrupt JSON and I/O errors; paths are host supplied', async t => {
  const { storage, path, root } = await fixture(t); await writeFile(path, '{broken'); await assert.rejects(storage.load(), SyntaxError);
  await assert.rejects(new FileIndexStorage(root).load());
  await assert.rejects(new FileIndexStorage(join(root, 'absent', 'index.json')).save({}));
  assert.throws(() => new FileIndexStorage('relative.json'), /absolute/);
  const abort = new AbortController(); abort.abort(); await assert.rejects(storage.load({ signal: abort.signal }), { name: 'AbortError' });
});
