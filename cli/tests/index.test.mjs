import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { optionsFrom, runSearch, renderRun } from '../cli.mjs';
import { indexStore } from '../index.mjs';

const script = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const options = args => optionsFrom(args, { columns: 88, isTTY: false }, {});
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'provena-index-cli-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'documents'); await mkdir(root);
  await writeFile(join(root, 'character.md'), '# Character\n\nAda is the protagonist of Example System.\n');
  await writeFile(join(root, 'worker.ts'), 'export const retryJob = () => true;\n');
  const config = options(['--source', root, '--query', 'Ada', '--save-index', root, '--color', 'never']);
  return { base, root, config };
}

test('index CLI: optional directory syntax and mutually exclusive flags', () => {
  assert.equal(options(['--save-index']).saveIndexBase, process.cwd());
  assert.equal(options(['--save-index', '--query', 'Ada']).saveIndexBase, process.cwd());
  assert.equal(options(['--save-index', 'folder with spaces']).saveIndexBase, resolve('folder with spaces'));
  assert.equal(options(['--save-index=here']).saveIndexBase, resolve('here'));
  assert.equal(options(['--save-index', '']).saveIndexBase, process.cwd());
  assert.equal(options(['--query=--save-index']).saveIndexBase, undefined);
  assert.throws(() => options(['--save-index', '--index-location', 'index.json']), /Choose/);
  assert.throws(() => options(['--index-location', '']), /requires/);
  assert.throws(() => options(['--index-location']), /argument|value/i);
  assert.throws(() => options(['--no-index', '--save-index']), /Choose/);
  assert.throws(() => options(['--no-index', '--index-location', 'index.json']), /Choose/);
});

test('index CLI: cold/warm snapshots, accurate counts, and reserved artifact exclusion', async t => {
  const { root, config } = await fixture(t);
  const cold = await runSearch(config);
  assert.equal(cold.index.state, 'new'); assert.equal(cold.index.saved, true);
  assert.equal(cold.corpus.documents, 2); assert.equal(cold.report.unchangedChunks, 0);
  assert.equal(cold.runs[0].entries[0].result.path, 'character.md');
  assert.ok(cold.index.path.startsWith(join(root, '.provena-indexes', 'documents-')));
  const stored = JSON.parse(await readFile(cold.index.path, 'utf8'));
  assert.equal(stored.cliSource.root, root); assert.equal(stored.schemaVersion, 3);
  assert.equal(stored.chunks.length, cold.corpus.passages);
  const warm = await runSearch(config);
  assert.equal(warm.index.state, 'loaded'); assert.equal(warm.report.unchangedChunks, cold.report.chunks);
  assert.equal(warm.corpus.identity, cold.corpus.identity);
  assert.equal(warm.observations.indexArtifactsExcluded, 1);
  assert.deepEqual(warm.runs[0].entries, cold.runs[0].entries);
  assert.match(renderRun(config, warm), /loaded index/);
  assert.ok(renderRun({ ...config, width: 200 }, warm).includes(`Used index ${warm.index.path}`));
  assert.equal(warm.report.documentsParsed, 0); assert.equal(warm.report.documentsReused, 2); assert.equal(warm.index.saved, false);
  assert.match(renderRun(config, warm), /Index unchanged; no write needed/);
  assert.match(renderRun(config, warm), /2 files reused/);
  assert.match(renderRun({ ...config, dev: true }, warm), /Index file/);
  assert.doesNotMatch(renderRun({ ...config, showcase: true }, warm), /Index file|Persistence|\.provena-indexes/);
  const memory = await runSearch({ ...config, saveIndexBase: undefined });
  assert.equal(memory.index, null); assert.equal(memory.corpus.identity, cold.corpus.identity);
  assert.equal(memory.observations.indexArtifactsExcluded, 1);
});

test('index CLI: bare flag uses invocation directory; explicit file works from another cwd', async t => {
  const { base, root } = await fixture(t);
  const invoke = (args, cwd) => spawnSync(process.execPath, [script, '--source', root, '--query', 'Ada', '--color', 'never', ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
  const first = invoke(['--save-index'], base);
  assert.equal(first.status, 0, first.stderr);
  const [directory] = await readdir(join(base, '.provena-indexes'));
  const path = join(base, '.provena-indexes', directory, 'index.json');
  const automatic = invoke([], base);
  assert.equal(automatic.status, 0, automatic.stderr);
  assert.match(automatic.stdout, /Used index/); assert.match(automatic.stdout, /auto-selected/);
  assert.match(automatic.stdout, /Index unchanged; no write needed/); assert.match(automatic.stdout, /2 files reused/);
  const memory = invoke(['--no-index'], base);
  assert.equal(memory.status, 0, memory.stderr); assert.match(memory.stdout, /Persistence: in-memory/);
  assert.doesNotMatch(memory.stdout, /Used index|Saved index/);
  const differentCwd = invoke([], tmpdir());
  assert.equal(differentCwd.status, 0, differentCwd.stderr); assert.match(differentCwd.stdout, /Persistence: in-memory/);
  const second = invoke(['--index-location', path], tmpdir());
  assert.equal(second.status, 0, second.stderr); assert.match(second.stdout, /loaded index/);
  assert.match(second.stdout, /2 files reused/);
});

test('index CLI: refresh reconciles additions, modifications, deletions', async t => {
  const { root, config } = await fixture(t);
  const first = await runSearch(config);
  await writeFile(join(root, 'character.md'), '# Character\n\nAda is from Example Town.\n');
  await rm(join(root, 'worker.ts'));
  await writeFile(join(root, 'new.txt'), 'Grace teaches Ada magic.\n');
  const second = await runSearch(config);
  assert.equal(second.index.state, 'loaded'); assert.equal(second.report.unchangedChunks, 0);
  assert.notEqual(second.corpus.identity, first.corpus.identity);
  assert.deepEqual(second.corpus.files.map(file => file.path), ['character.md', 'new.txt']);
  const saved = JSON.parse(await readFile(second.index.path, 'utf8'));
  assert.deepEqual(saved.documents.map(document => document.documentId).sort(), ['character.md', 'new.txt']);
  assert.ok(saved.chunks.every(chunk => !chunk.text.includes('protagonist') && chunk.documentId !== 'worker.ts'));
});

test('index CLI: source isolation, compatibility rebuilds, and failed refresh preserve snapshot', async t => {
  const { base, root, config } = await fixture(t);
  const first = await runSearch(config);
  const location = { ...config, saveIndexBase: undefined, indexLocation: first.index.path };
  const original = await readFile(first.index.path, 'utf8');
  const other = join(base, 'other', 'documents'); await mkdir(other, { recursive: true });
  await writeFile(join(other, 'other.md'), 'Ada');
  await assert.rejects(runSearch({ ...location, root: other }), /different source/);
  assert.equal(await readFile(first.index.path, 'utf8'), original);
  const otherRun = await runSearch({ ...config, root: other });
  assert.notEqual(otherRun.index.path, first.index.path);
  await assert.rejects(runSearch({ ...location, indexLocation: join(base, 'missing.json') }), /existing CLI index/);
  const incompatible = JSON.parse(original); incompatible.chunkerVersion = 'old-version';
  await writeFile(first.index.path, JSON.stringify(incompatible));
  const rebuilt = await runSearch(location);
  assert.equal(rebuilt.index.state, 'rebuilt'); assert.deepEqual(rebuilt.index.rebuildReasons, ['chunkerVersion']);
  const output = renderRun(config, rebuilt);
  assert.match(output, /updated incompatible parts, reused\s+compatible content/); assert.doesNotMatch(output, /Used index/);
  assert.equal(rebuilt.report.unchangedChunks, 0);
  const lastGood = await readFile(first.index.path, 'utf8');
  await writeFile(join(root, 'broken.txt'), Buffer.from([65, 0, 66]));
  await assert.rejects(runSearch(location), /binary|NUL/i);
  assert.equal(await readFile(first.index.path, 'utf8'), lastGood);
  await rm(join(root, 'broken.txt'));
  await assert.rejects(runSearch({ ...location, mode: 'semantic', modelDir: join(base, 'missing-model') }), /MiniLM model load failed/);
  assert.equal(await readFile(first.index.path, 'utf8'), lastGood);
  const corrupt = JSON.parse(lastGood); corrupt.chunks[0].contentHash = 'incorrect';
  await writeFile(first.index.path, JSON.stringify(corrupt));
  await assert.rejects(runSearch(location), /Corrupt index/);
  assert.equal(await readFile(first.index.path, 'utf8'), JSON.stringify(corrupt));
  delete corrupt.cliSource; await writeFile(first.index.path, JSON.stringify(corrupt));
  await assert.rejects(runSearch(location), /binding is missing/);
});

test('index CLI: custom index inside corpus is excluded, without excluding other JSON', async t => {
  const { root, config } = await fixture(t);
  const first = await runSearch(config);
  const custom = join(root, 'saved.json'); await writeFile(custom, await readFile(first.index.path));
  await writeFile(join(root, 'data.json'), '{"name":"Ada"}');
  const next = await runSearch({ ...config, saveIndexBase: undefined, indexLocation: custom });
  assert.equal(next.corpus.documents, 3);
  assert.ok(next.corpus.files.some(file => file.path === 'data.json'));
  assert.equal(next.observations.indexArtifactsExcluded, 2);
});

test('index CLI: real MiniLM vectors survive restart and reuse on rename without network', { skip: process.env.PROVENA_DEMO_MODEL !== '1' }, async t => {
  const { root, config } = await fixture(t);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Network prohibited by persistence test'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const modelOptions = { ...config, mode: 'hybrid', modelDir: process.env.PROVENA_DEMO_MODEL_DIR };
  const cold = await runSearch(modelOptions);
  assert.equal(cold.report.embeddedTexts, 2);
  if (!modelOptions.modelDir) {
    const { MiniLMEmbedder } = await import('@theleumas/provena/minilm');
    assert.equal(cold.model.id, new MiniLMEmbedder().id, 'Hub and automatic cache loading share the pinned model identity');
    assert.equal(JSON.parse(await readFile(cold.index.path, 'utf8')).embedding.id, cold.model.id);
  }
  const events = [];
  const warm = await runSearch(modelOptions, event => events.push(event));
  assert.equal(warm.index.state, 'loaded'); assert.equal(warm.report.embeddedTexts, 0);
  assert.equal(warm.report.documentsRead, 0); assert.equal(warm.report.documentsParsed, 0); assert.equal(warm.report.documentsReused, 2); assert.equal(warm.report.persistence, 'unchanged');
  assert.equal(warm.report.reusedVectors, 2); assert.equal(warm.report.unchangedChunks, 2);
  assert.equal(events.filter(event => event.phase === 'embed').length, 0);
  assert.ok(Number.isFinite(warm.timings.modelLoadMs));
  assert.deepEqual(warm.runs[0].entries, cold.runs[0].entries);
  const before = JSON.parse(await readFile(warm.index.path, 'utf8'));
  await writeFile(join(root, 'renamed.ts'), await readFile(join(root, 'worker.ts')));
  await rm(join(root, 'worker.ts'));
  const renamed = await runSearch(modelOptions);
  assert.equal(renamed.report.embeddedTexts, 0);
  const after = JSON.parse(await readFile(renamed.index.path, 'utf8'));
  assert.deepEqual(after.chunks.find(chunk => chunk.documentId === 'renamed.ts').vector,
    before.chunks.find(chunk => chunk.documentId === 'worker.ts').vector);
  await writeFile(join(root, 'added.txt'), 'The index is saved atomically.\n');
  const added = await runSearch(modelOptions); assert.equal(added.report.embeddedTexts, 1);
  const lexical = await runSearch(config);
  assert.equal(lexical.index.state, 'preserved'); assert.ok(lexical.index.rebuildReasons.includes('embedding'));
});

test('index CLI: legacy verification manifests bootstrap once and explicit verification preserves matching hashes', async t => {
  const { root, config } = await fixture(t); const cold = await runSearch(config);
  const snapshot = JSON.parse(await readFile(cold.index.path, 'utf8')); delete snapshot.cliFiles;
  await writeFile(cold.index.path, JSON.stringify(snapshot));
  const bootstrap = await runSearch(config); assert.equal(bootstrap.report.documentsParsed, 2);
  // Existing core records match, but CLI metadata must publish after the bootstrap.
  const warm = await runSearch(config); assert.equal(warm.report.documentsRead, 0); assert.deepEqual(warm.corpus.files, cold.corpus.files);
  const verify = await runSearch({ ...config, verifyContent: true }); assert.equal(verify.report.documentsParsed, 2); assert.equal(verify.report.embeddedTexts, 0);
  assert.equal(verify.corpus.identity, cold.corpus.identity);
  await writeFile(join(root, 'worker.ts'), 'export const retryJob = () => false;\n');
  const changed = await runSearch(config); assert.equal(changed.report.documentsParsed, 1); assert.equal(changed.report.documentsReused, 1);
});
