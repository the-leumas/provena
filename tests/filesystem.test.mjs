import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSystemFolderSource } from '../dist/adapters/filesystem.js';
import { SemanticSearchEngine } from '../dist/index.js';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'semantic-source-')); t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'allowed')); await mkdir(join(root, 'outside'));
  await writeFile(join(root, 'outside', 'secret.md'), 'outside');
  await mkdir(join(root, 'allowed', 'nested')); await writeFile(join(root, 'allowed', 'nested', 'code.ts'), 'export function validateSession() {}');
  await writeFile(join(root, 'allowed', 'note.md'), '# Retrieval\narchitecture');
  await writeFile(join(root, 'allowed', 'ignored.pdf'), 'not indexable');
  return { root, allowed: join(root, 'allowed'), source: new FileSystemFolderSource({ id: 'folder', root: join(root, 'allowed') }) };
}
test('filesystem vertical slice indexes only supported files with normalized IDs and URIs', async t => {
  const { source } = await fixture(t); const docs = await source.list();
  assert.deepEqual(docs.map(doc => doc.id), ['nested/code.ts', 'note.md']); assert.ok(docs.every(doc => doc.uri.startsWith('file:')));
  const engine = new SemanticSearchEngine(); engine.addSource(source); await engine.initialize();
  assert.equal((await engine.search({ query: 'validateSession' }))[0].path, 'nested/code.ts');
});
test('traversal, absolute paths and symlink escapes are rejected on direct reads', async t => {
  const { source, root, allowed } = await fixture(t);
  await symlink(join(root, 'outside'), join(allowed, 'escape')); await symlink(join(allowed, 'note.md'), join(allowed, 'internal.md'));
  for (const path of ['../outside/secret.md', '/outside/secret.md', 'nested/../../outside/secret.md', 'escape/secret.md', 'internal.md', 'nested\\code.ts']) await assert.rejects(source.read(path));
  assert.deepEqual((await source.list()).map(doc => doc.id), ['nested/code.ts', 'note.md']);
});
test('binary disguised as text, invalid UTF8 and oversized files are refused', async t => {
  const { source, allowed } = await fixture(t);
  await writeFile(join(allowed, 'binary.md'), Buffer.from([0, 1, 2])); await assert.rejects(source.read('binary.md'), /Binary/);
  await writeFile(join(allowed, 'invalid.txt'), Buffer.from([0xff, 0xfe])); await assert.rejects(source.read('invalid.txt'));
  const small = new FileSystemFolderSource({ id: 'small', root: allowed, maxFileBytes: 3 });
  await assert.rejects(small.read('note.md'), /size limit/); assert.ok(!(await small.list()).some(doc => doc.id === 'note.md'));
});
test('explicit refresh handles filesystem rename and deletion without stale paths', async t => {
  const { source, allowed } = await fixture(t); const engine = new SemanticSearchEngine(); engine.addSource(source); await engine.initialize();
  await rename(join(allowed, 'note.md'), join(allowed, 'moved.md')); await engine.refreshSource('folder');
  assert.equal((await engine.search({ query: 'architecture' }))[0].path, 'moved.md');
  await rm(join(allowed, 'moved.md')); await engine.refreshSource('folder'); assert.deepEqual(await engine.search({ query: 'architecture' }), []);
});
test('unavailable sources fail explicitly; registration needs an absolute opt-in root', async t => {
  const { root } = await fixture(t);
  assert.throws(() => new FileSystemFolderSource({ id: 'x', root: '.' }), /absolute/);
  await assert.rejects(new FileSystemFolderSource({ id: 'x', root: join(root, 'missing') }).list());
});
