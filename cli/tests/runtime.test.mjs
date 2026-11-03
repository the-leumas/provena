import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { optionsFrom } from '../cli.mjs';
import { createRuntime } from '../runtime.mjs';

const options = args => optionsFrom(args, { isTTY: true, columns: 88 }, {});
async function fixture(t) {
  const base = await mkdtemp(join(tmpdir(), 'provena-runtime-test-')); t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, 'documents'); await mkdir(root);
  await writeFile(join(root, 'profile.md'), '# Ada\n\nAda is the protagonist of Example System.\n');
  const config = options(['--source', root, '--color', 'never']);
  return { base, root, config };
}

test('runtime repeats queries without refreshing, verifies cached passages, and preserves the committed index after a failed refresh', async t => {
  const { root, config } = await fixture(t); const events = [];
  const runtime = await createRuntime(config, event => events.push(event)); t.after(() => runtime.dispose());
  await runtime.refresh(); const revision = runtime.engine.revision;
  const first = await runtime.search('Ada'); const second = await runtime.search('Ada');
  assert.deepEqual(first.entries, second.entries); assert.equal(runtime.engine.revision, revision);
  assert.equal(events.filter(event => event.phase === 'scan').length, 1);
  await writeFile(join(root, 'profile.md'), '# Ada\n\nAda is from Example Town.\n');
  await assert.rejects(runtime.search('Ada'), /Source changed.*refresh/);
  await runtime.refresh(); assert.ok(runtime.engine.revision > revision);
  assert.match((await runtime.search('Ada')).entries[0].result.snippet, /Example Town/);
  await writeFile(join(root, 'bad.txt'), Buffer.from([0]));
  await assert.rejects(runtime.refresh(), /binary/i);
  assert.match((await runtime.search('Ada')).entries[0].result.snippet, /Example Town/);
  const record = await runtime.record([], []);
  assert.equal(record.corpus.documents, record.observations.admittedFiles);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.search('Ada', 'lexical', config, { signal: controller.signal }), /abort/i);
});

test('lexical refresh cannot erase a saved semantic index; the next semantic refresh embeds only changed inputs', async t => {
  const { root, config } = await fixture(t); let inferred = 0;
  const resource = { model: { id: 'preserved-model' }, embedder: { dimensions: 2,
    async embedDocuments(texts) { inferred += texts.length; return texts.map(() => new Float32Array([1, 0])); },
    async embedQuery() { return new Float32Array([1, 0]); },
  } };
  const manager = { acquire: async () => resource, listen() {}, dispose: async () => {} };
  const opts = { ...config, mode: 'semantic', saveIndexBase: root };
  const semantic = await createRuntime(opts, () => {}, { manager }); await semantic.refresh(); assert.equal(inferred, 1);
  const directories = await readdir(join(root, '.provena-indexes')); const path = join(root, '.provena-indexes', directories[0], 'index.json');
  const before = await readFile(path, 'utf8'); assert.ok(JSON.parse(before).embedding);
  await writeFile(join(root, 'new.md'), '# Added\n\nAnother policy added after the semantic run.');
  const events = []; const lexical = await createRuntime({ ...opts, mode: 'lexical' }, event => events.push(event), { manager });
  await lexical.refresh(); assert.equal(lexical.report.documents, 2); assert.equal(inferred, 1);
  assert.equal(await readFile(path, 'utf8'), before, 'lexical refresh must leave the vector-bearing snapshot intact');
  assert.ok(events.some(event => event.phase === 'index-preserved'));
  assert.equal((await lexical.search('policy', 'lexical')).entries.length, 1);
  const next = await createRuntime(opts, () => {}, { manager }); await next.refresh();
  assert.equal(inferred, 2); assert.equal(next.report.embeddedTexts, 1); assert.equal(next.report.reusedVectors, 1);
  const warm = await createRuntime(opts, () => {}, { manager }); await warm.refresh(); assert.equal(inferred, 2);
});
