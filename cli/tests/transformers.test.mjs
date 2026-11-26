import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TRANSFORMERS_VERSION, defaultRuntimeDir, importTransformers, installTransformers, loadTransformers } from '../transformers.mjs';
import { describeError } from '../format.mjs';

const missing = () => Object.assign(new Error("Cannot find package '@huggingface/transformers'"), { code: 'ERR_MODULE_NOT_FOUND' });

async function fakePackage(runtimeDir, marker, version = TRANSFORMERS_VERSION) {
  const packageDir = join(runtimeDir, 'node_modules/@huggingface/transformers');
  await mkdir(join(packageDir, 'dist'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: '@huggingface/transformers',
    version,
    exports: { node: { import: { default: './dist/transformers.node.mjs' } } },
  }));
  await writeFile(join(packageDir, 'dist/transformers.node.mjs'),
    `export const env = { version: ${JSON.stringify(version)} };\nexport const marker = ${JSON.stringify(marker)};\n`);
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

test('managed runtime imports the pinned package layout and rejects stale versions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakePackage(root, 'managed');
  const runtime = await importTransformers(root);
  assert.equal(runtime.marker, 'managed');
  assert.equal(runtime.env.version, '4.3.2');

  const stale = await mkdtemp(join(tmpdir(), 'provena-runtime-stale-'));
  t.after(() => rm(stale, { recursive: true, force: true }));
  await fakePackage(stale, 'old', '4.2.0');
  await assert.rejects(importTransformers(stale), { code: 'ERR_PROVENA_RUNTIME_VERSION' });
});

test('loadTransformers falls back to a managed runtime when absent or mismatched in resolution scope', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakePackage(root, 'managed');
  const fromMissing = await loadTransformers({ runtimeDir: root, resolvePackage: async () => { throw missing(); } });
  assert.equal(fromMissing.source, 'managed');
  assert.equal(fromMissing.runtime.marker, 'managed');

  const fromMismatched = await loadTransformers({
    runtimeDir: root,
    resolvePackage: async () => ({ env: { version: '4.2.0' }, marker: 'global-old' }),
  });
  assert.equal(fromMismatched.source, 'managed');
  assert.equal(fromMismatched.runtime.marker, 'managed');
});

test('loadTransformers installs or upgrades the pinned runtime when absent or outdated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  const runtimeDir = join(root, 'runtime');
  t.after(() => rm(root, { recursive: true, force: true }));
  await fakePackage(runtimeDir, 'stale', '4.2.0');
  let notified = 0; let installed = 0;
  const loaded = await loadTransformers({
    runtimeDir,
    resolvePackage: async () => { throw missing(); },
    notify: () => { notified++; },
    installer: async dir => { installed++; await fakePackage(dir, 'upgraded'); },
  });
  assert.equal(installed, 1);
  assert.equal(notified, 1);
  assert.equal(loaded.source, 'installed');
  assert.equal(loaded.runtime.marker, 'upgraded');
});

test('loadTransformers refuses installation when disabled, including for stale managed runtimes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(loadTransformers({
    runtimeDir: join(root, 'runtime'), install: false,
    resolvePackage: async () => { throw missing(); },
  }), /Automatic installation is disabled/);

  const staleDir = join(root, 'stale-runtime');
  await fakePackage(staleDir, 'stale', '4.2.0');
  await assert.rejects(loadTransformers({
    runtimeDir: staleDir, install: false,
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
  assert.ok(captured.args.includes('@huggingface/transformers@4.3.2'));
  assert.equal(captured.cwd, captured.args[captured.args.indexOf('--prefix') + 1]);
  await access(join(runtimeDir, 'node_modules/@huggingface/transformers/package.json'));
  assert.equal((await importTransformers(runtimeDir)).marker, 'installed');
});
