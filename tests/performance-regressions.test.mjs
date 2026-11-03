import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendFileSync, writeFileSync } from 'node:fs';
import { FileSystemFolderSource } from '../dist/adapters/filesystem.js';
import { createRuntime } from '../cli/runtime.mjs';
import { optionsFrom } from '../cli/cli.mjs';
import { snapshotOf } from '../dist/index-state.js';
import { SemanticSearchEngine } from '../dist/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'provena-perf-regression-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
test('checked reads allocate for actual file size while retaining the growth sentinel', async t => {
  const root = await fixture(t); const text = 'Small UTF-8 evidence: café.\n';
  await writeFile(join(root, 'small.md'), text);
  const source = new FileSystemFolderSource({ id: 'small', root });
  const Original = globalThis.Uint8Array; const allocations = [];
  globalThis.Uint8Array = class extends Original { constructor(...args) { super(...args); if (typeof args[0] === 'number') allocations.push(args[0]); } };
  try { assert.equal((await source.read('small.md')).text, text); }
  finally { globalThis.Uint8Array = Original; }
  assert.deepEqual(allocations, [Buffer.byteLength(text) + 1]);
});
test('unsupported files need no containment calls; admitted files and directories still do', async t => {
  const root = await fixture(t); await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'ignored.pdf'), 'Ignored');
  await writeFile(join(root, 'nested', 'note.md'), '# Admitted\n');
  const source = new FileSystemFolderSource({ id: 'admission', root });
  // TypeScript private methods compile to ordinary properties; spy only in tests.
  const original = source.checkedPath.bind(source); const checked = [];
  source.checkedPath = async id => { checked.push(id); return original(id); };
  assert.deepEqual((await source.list()).map(doc => doc.id), ['nested/note.md']);
  assert.deepEqual(checked.sort(), ['nested', 'nested/note.md']);
});
test('sized checked reads reject growth, including growth beyond the admission limit', async t => {
  const root = await fixture(t); const path = join(root, 'growing.md');
  for (const [initial, appended, message] of [['a', 'bc', /changed while reading/], ['abcd', 'e', /size limit/]]) {
    await writeFile(path, initial);
    const source = new FileSystemFolderSource({ id: 'growing', root, maxFileBytes: 4 });
    const Original = globalThis.Uint8Array; let changed = false;
    globalThis.Uint8Array = class extends Original {
      constructor(...args) { super(...args); if (!changed && typeof args[0] === 'number') { changed = true; appendFileSync(path, appended); } }
    };
    try { await assert.rejects(source.read('growing.md'), message); }
    finally { globalThis.Uint8Array = Original; }
  }
  await writeFile(path, 'abcd');
  const source = new FileSystemFolderSource({ id: 'rewrite', root, maxFileBytes: 4 });
  const Original = globalThis.Uint8Array; let changed = false;
  globalThis.Uint8Array = class extends Original {
    constructor(...args) { super(...args); if (!changed && typeof args[0] === 'number') { changed = true; writeFileSync(path, 'wxyz'); } }
  };
  try { await assert.rejects(source.read('growing.md'), /changed while reading/); }
  finally { globalThis.Uint8Array = Original; }
});
test('CLI verifies one checked read per document per search and rechecks cached queries', async t => {
  const root = await fixture(t);
  const text = '# First\n\nretryJob evidence one.\n\n# Second\n\nretryJob evidence two.\n\n# Third\n\nretryJob evidence three.\n';
  await writeFile(join(root, 'note.md'), text);
  const options = optionsFrom(['--source', root, '--query', 'retryJob', '--no-index', '--limit', '3', '--color', 'never'], { isTTY: false, columns: 88 }, {});
  const runtime = await createRuntime(options); t.after(() => runtime.dispose()); await runtime.refresh();
  let reads = 0; const original = FileSystemFolderSource.prototype.read;
  FileSystemFolderSource.prototype.read = function (...args) { reads++; return original.apply(this, args); };
  try {
    const first = await runtime.search('retryJob'); assert.equal(first.entries.length, 3); assert.equal(reads, 1);
    const second = await runtime.search('retryJob'); assert.deepEqual(second.entries, first.entries); assert.equal(reads, 2);
    await writeFile(join(root, 'note.md'), text + 'Changed source.\n');
    await assert.rejects(runtime.search('retryJob'), /Source changed after indexing/); assert.equal(reads, 3);
  } finally { FileSystemFolderSource.prototype.read = original; }
});
test('snapshot construction isolates metadata and vector arrays from live state', () => {
  const catalog = { sourceId: 's', documentId: 'd', uri: 'memory:d', title: 'D', tags: ['original'], headings: [], outgoingLinks: [] };
  const chunk = { id: 'c', sourceId: 's', documentId: 'd', uri: 'memory:d', text: 'evidence', contentHash: 'h', startLine: 1, endLine: 1 };
  const records = new Map([['d', { catalog, chunks: [chunk], revision: 'r' }]]);
  const vector = Float32Array.of(0.25, 0.75); const vectors = new Map([['c', vector]]);
  const config = { schemaVersion: 3, parserVersion: '1', chunkerVersion: '2', chunking: { targetChars: 1600, overlapLines: 2 }, embedding: { id: 'm', dimensions: 2 } };
  const snapshot = snapshotOf(records, vectors, config);
  snapshot.documents[0].tags.push('modified'); snapshot.chunks[0].text = 'modified'; snapshot.chunks[0].vector[0] = 9;
  snapshot.chunking.targetChars = 800; snapshot.embedding.id = 'changed'; snapshot.documentRevisions[0].revision = 'changed';
  assert.deepEqual(catalog.tags, ['original']); assert.equal(chunk.text, 'evidence'); assert.equal(vector[0], 0.25);
  assert.equal(config.chunking.targetChars, 1600); assert.equal(config.embedding.id, 'm'); assert.equal(records.get('d').revision, 'r');
  vector[1] = 5; assert.equal(snapshot.chunks[0].vector[1], 0.75);
});
test('lexical camel-case guard preserves acronym, number, underscore, plural and Unicode matches', async () => {
  const engine = new SemanticSearchEngine();
  engine.addSource({ id: 'terms', type: 'memory',
    async list() { return [{ id: 'terms.txt', name: 'terms.txt', sourceId: 'terms', uri: 'memory:terms' }]; },
    async read() { return { text: 'XMLParser handles HTTP2Response, snake_case, sessions, İstanbul, and 证据.' }; },
  });
  await engine.initialize();
  for (const query of ['XMLParser', 'xml parser', 'HTTP2Response', 'http2 response', 'snake_case', 'snake case', 'session', 'İstanbul', '证据']) {
    assert.equal((await engine.search({ query, mode: 'lexical' }))[0]?.documentId, 'terms.txt', query);
  }
  assert.deepEqual(await engine.search({ query: 'unrelated', mode: 'lexical' }), []);
});
