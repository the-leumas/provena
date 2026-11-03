import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile, access, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
// A nested install must not inherit the parent npm lifecycle's project/script policy.
// Scripts remain explicitly disabled for the isolated consumer.
const consumerEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && key !== 'INIT_CWD'));
test('file-type documentation matches its registry generator', () => {
  execFileSync(process.execPath, ['scripts/file-types.mjs', '--check'], { cwd: root });
});
test('packed package installs offline with working public JS and type exports', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'provena-package-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const packed = JSON.parse(execFileSync(npm, ['--cache', join(temp, 'npm-cache'), 'pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: root, encoding: 'utf8', env: consumerEnv }));
  const pack = Array.isArray(packed) ? packed[0] : packed.filename ? packed : packed['@theleumas/provena'];
  if (!pack?.filename || !pack.files) throw new Error(JSON.stringify(packed));
  const names = pack.files.map(file => file.path);
  assert.ok(names.includes('dist/index.js')); assert.ok(names.includes('dist/index.d.ts')); assert.ok(names.includes('LICENSE'));
  for (const required of ['CHANGELOG.md', 'CONTRIBUTING.md', 'ROADMAP.md']) assert.ok(names.includes(required));
  // Shipped documentation must not link to source-only files or omitted benchmark JSON.
  for (const file of names.filter(path => path.endsWith('.md') || path === 'LICENSE' || path === 'package.json')) {
    const markdown = await readFile(join(root, file), 'utf8');
    for (const url of markdown.matchAll(/github\.com\/([A-Za-z0-9-]+)/g)) assert.equal(url[1].toLowerCase(), 'the-leumas', 'Unexpected GitHub account reference in published file: ' + file);
    if (!file.endsWith('.md')) continue;
    for (const match of markdown.matchAll(/\[[^\]]+\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const href = match[1];
      if (/^(?:https?:|mailto:|#)/i.test(href)) continue;
      const path = posix.normalize(posix.join(posix.dirname(file), decodeURIComponent(href.split('#')[0])));
      assert.ok(names.includes(path), 'Broken packaged documentation link: ' + file + ' -> ' + href);
    }
  }

  assert.ok(names.includes('cli/cli.mjs'), 'CLI entrypoint must ship for the bin command');
  assert.equal(JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).bin.provena, './cli/cli.mjs');
  assert.ok(!names.some(path => /^(?:cli\/tests|node_modules|tests|local|\.env|indexes|models)\//.test(path)));
  await writeFile(join(temp, 'package.json'), JSON.stringify({ name: 'install-check', private: true, type: 'module' }));
  execFileSync(npm, ['--cache', join(temp, 'npm-cache'), 'install', '--ignore-scripts', '--offline', '--no-audit', '--no-fund', join(temp, pack.filename)], { cwd: temp, stdio: 'pipe', env: consumerEnv });
  // Execute the documented quickstart against the actual installed tarball.
  const readme = await readFile(join(root, 'README.md'), 'utf8');
  const section = readme.split('## Quick start: lexical search without a model')[1];
  assert.ok(section, 'README quickstart section missing');
  const fence = '```js\n';
  const start = section.indexOf(fence);
  assert.ok(start >= 0, 'README JavaScript quickstart missing');
  const begin = start + fence.length;
  const end = section.indexOf('```', begin);
  assert.ok(end > begin, 'README quickstart closing fence missing');
  await writeFile(join(temp, 'readme-quickstart.mjs'), section.slice(begin, end));
  const quickstartOutput = execFileSync(process.execPath, [join(temp, 'readme-quickstart.mjs')], { cwd: temp, encoding: 'utf8' });
  assert.match(quickstartOutput, /memory:\/\/docs\/sessions\.md/);
  await assert.rejects(access(join(temp, 'node_modules/@huggingface/transformers')));
  const script = `import { SemanticSearchEngine, isSupportedFile } from '@theleumas/provena';
import { FileSystemFolderSource, FileIndexStorage } from '@theleumas/provena/filesystem';
import { MiniLMEmbedder } from '@theleumas/provena/minilm';
if (!isSupportedFile('x.ts') || !new SemanticSearchEngine() || typeof FileSystemFolderSource !== 'function' || typeof FileIndexStorage !== 'function') throw new Error('bad exports');
const minilm = new MiniLMEmbedder();
await minilm.embedQuery('missing optional peer').then(() => { throw new Error('Peer unexpectedly available'); }, error => { if (!error.message.includes('Install @huggingface/transformers@4.2.0')) throw error; });
await minilm.dispose();`;
  execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: temp });
  await writeFile(join(temp, 'consumer.mts'), `import { SemanticSearchEngine, type SearchSource, type Embedder, type IndexStorage, type SearchMode } from '@theleumas/provena';
import { FileSystemFolderSource, FileIndexStorage } from '@theleumas/provena/filesystem';
import { MiniLMEmbedder } from '@theleumas/provena/minilm';
const optional: Embedder = new MiniLMEmbedder({ device: 'wasm', batchSize: 2 });
const source: SearchSource = new FileSystemFolderSource({ id: 'x', root: '/explicit' });
const storage: IndexStorage = new FileIndexStorage('/explicit/index.json');
const embedder: Embedder = { id: 'test-config', dimensions: 2,
  async embedDocuments(texts) { return texts.map(() => new Float32Array(2)); },
  async embedQuery() { return new Float32Array(2); } };
const engine = new SemanticSearchEngine({ storage, embedder }); engine.addSource(source);
const mode: SearchMode = 'hybrid';
const results = await engine.search({ query: 'symbol', mode }); results[0]?.chunkId;
`);
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--skipLibCheck', '--noEmit', '--target', 'ES2022', '--module', 'NodeNext', join(temp, 'consumer.mts')], { cwd: temp, stdio: 'pipe' });
  const manifest = JSON.parse(await readFile(join(temp, 'node_modules/@theleumas/provena/package.json'), 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.sideEffects, false);
  assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './filesystem', './minilm']);
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    await import('@theleumas/provena/dist/retrieval.js').then(() => { throw new Error('Internal export leaked'); }, error => { if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error; });
    const { searchWithMiniLM } = await import('./node_modules/@theleumas/provena/examples/minilm.mjs');
    const hits = await searchWithMiniLM({ id: 'empty', type: 'test', async list() { return []; }, async read() { throw new Error('No documents'); } }, undefined, 'test');
    if (hits.length) throw new Error('Empty MiniLM example failed');
  `], { cwd: temp, stdio: 'pipe' });
  assert.equal(manifest.peerDependencies['@huggingface/transformers'], '4.2.0');
  assert.equal(manifest.peerDependenciesMeta['@huggingface/transformers'].optional, true);
  await mkdir(join(temp, 'node_modules/@huggingface'), { recursive: true });
  await symlink(join(root, 'node_modules/@huggingface/transformers'), join(temp, 'node_modules/@huggingface/transformers'), 'dir');
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { MiniLMEmbedder } from '@theleumas/provena/minilm';
    import { env } from '@huggingface/transformers';
    if (env.version !== '4.2.0' || new MiniLMEmbedder().dimensions !== 384) throw new Error('Optional runtime export failed');
  `], { cwd: temp, stdio: 'pipe' });
});
