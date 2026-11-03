import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultRuntimeDir, importTransformers, installTransformers, loadTransformers } from '../transformers.mjs';
import { describeError } from '../format.mjs';

const missing = () => Object.assign(new Error("Cannot find package '@huggingface/transformers'"), { code: 'ERR_MODULE_NOT_FOUND' });

async function fakePackage(runtimeDir, marker) {
  const packageDir = join(runtimeDir, 'node_modules/@huggingface/transformers');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@huggingface/transformers',
    version: '4.2.0',
    exports: { node: { import: { default: './dist/transformers.node.mjs' } } },
  }));
  await writeFile(join(packageDir, 'dist/transformers.node.mjs'),
    `export const env = { version: '4.2.0' };\nexport const marker = ${JSON.stringify(marker)};\n`);
}

test('managed runtime location respects PROVENA_RUNTIME_DIR and XDG_CACHE_HOME', () => {
  assert.equal(defaultRuntimeDir({ PROVENA_RUNTIME_DIR: '/runtime' }), '/runtime');
  assert.equal(defaultRuntimeDir({ XDG_CACHE_HOME: '/xdg' }), '/xdg/provena/runtime');
});

test('error descriptions keep the root cause chain', () => {
  const root = new Error('Protobuf parsing failed');
  const middle = new Error('MiniLM model load failed', { cause: root });
  assert.equal(describeError(middle), 'MiniLM model load failed → caused by: Protobuf parsing failed');
});

test('managed runtime imports the pinned package layout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakePackage(root, 'managed');
  const runtime = await importTransformers(root);
  assert.equal(runtime.marker, 'managed');
  assert.equal(runtime.env.version, '4.2.0');
});

test('loadTransformers falls back to a managed runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakePackage(root, 'managed');
  const loaded = await loadTransformers({ runtimeDir: root, resolvePackage: async () => { throw missing(); } });
  assert.equal(loaded.source, 'managed');
  assert.equal(loaded.runtime.marker, 'managed');
});

test('loadTransformers installs the pinned runtime once when it is absent', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  const runtimeDir = join(root, 'runtime');
  t.after(() => rm(root, { recursive: true, force: true }));
  let notified = 0; let installed = 0;
  const loaded = await loadTransformers({
    runtimeDir,
    resolvePackage: async () => { throw missing(); },
    notify: () => { notified++; },
    installer: async dir => { installed++; await fakePackage(dir, 'installed'); },
  });
  assert.equal(installed, 1);
  assert.equal(notified, 1);
  assert.equal(loaded.source, 'installed');
  assert.equal(loaded.runtime.marker, 'installed');
});

test('loadTransformers refuses installation when disabled', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(loadTransformers({
    runtimeDir: join(root, 'runtime'), install: false,
    resolvePackage: async () => { throw missing(); },
  }), /Automatic installation is disabled/);
});

test('installTransformers uses the pinned version, skips scripts and publishes atomically', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  const runtimeDir = join(root, 'runtime');
  t.after(() => rm(root, { recursive: true, force: true }));
  let captured;
  await installTransformers(runtimeDir, {
    run: async (args, cwd) => {
      captured = { args, cwd };
      const prefix = args[args.indexOf('--prefix') + 1];
      const manifest = JSON.parse(await readFile(join(prefix, 'package.json'), 'utf8'));
      assert.equal(manifest.name, 'provena-semantic-runtime');
      await fakePackage(prefix, 'installed');
    },
  });
  assert.ok(captured.args.includes('--ignore-scripts'));
  assert.ok(captured.args.includes('@huggingface/transformers@4.2.0'));
  assert.equal(captured.cwd, captured.args[captured.args.indexOf('--prefix') + 1]);
  await access(join(runtimeDir, 'node_modules/@huggingface/transformers/package.json'));
  assert.equal((await importTransformers(runtimeDir)).marker, 'installed');
});
