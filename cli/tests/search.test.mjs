import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat, readlink, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { stripVTControlCharacters } from 'node:util';
import { SemanticSearchEngine, defaultFileTypes, PARSER_VERSION } from '@theleumas/provena';
import { FileSystemFolderSource } from '@theleumas/provena/filesystem';
import { optionsFrom, runSearch, renderRun, displayWidth, cachedModelDirectory } from '../cli.mjs';

const project = fileURLToPath(new URL('../..', import.meta.url));
const script = join(project, 'cli/cli.mjs');
const options = args => optionsFrom(args, { columns: 88, isTTY: false }, {});
const cli = (args, cwd = project) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8', timeout: 30_000 });
async function corpus(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'provena-search-cli-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = join(temporary, 'corpus'); await mkdir(root);
  await writeFile(join(root, 'character.md'), '# Character\n\nAda is the protagonist of Example System and travels from Example Town.\n');
  await writeFile(join(root, 'sample.ts'), 'export const unrelated = true;\n');
  await writeFile(join(root, 'empty.txt'), '');
  await writeFile(join(root, 'unsupported.pdf'), 'Ada should not be indexed');
  return { temporary, root };
}

test('search CLI: source observations and rankings match the public engine', async t => {
  const { root } = await corpus(t);
  const config = options(['--source', root, '--query', 'Who is Ada', '--dev', '--full', '--color', 'never']);
  const events = []; const record = await runSearch(config, event => events.push(structuredClone(event)));
  const engine = new SemanticSearchEngine(); engine.addSource(new FileSystemFolderSource({ id: 'project', root }));
  const report = await engine.refreshSource('project');
  assert.deepEqual(record.report, report);
  assert.deepEqual(record.runs[0].entries.map(entry => entry.result), await engine.search({ query: config.query, mode: 'lexical', limit: config.limit }));
  assert.equal(record.observations.admittedFiles, 3); assert.equal(record.observations.parsedDocuments, 3);
  assert.equal(record.observations.encounteredFiles, null); assert.equal(record.observations.excludedFiles, null);
  assert.equal(record.corpus.files.find(file => file.path === 'empty.txt').passages, 0);
  assert.equal(record.corpus.files.reduce((sum, file) => sum + file.passages, 0), record.report.chunks);
  assert.equal(record.configuration.parserVersion, JSON.stringify([PARSER_VERSION, defaultFileTypes.definitions]));
  assert.equal(events.filter(event => event.phase === 'scan').length, 1);
  assert.deepEqual(events.filter(event => event.phase === 'parse').map(event => event.completed), [1, 2, 3]);
  const { result, excerpt } = record.runs[0].entries[0];
  assert.equal(excerpt.startLine, result.startLine); assert.equal(excerpt.endLine, result.endLine);
  for (const [name, value] of Object.entries(record.timings)) {
    if (name === 'chunkingMs') assert.equal(value, null); else assert.ok(Number.isFinite(value) && value >= 0, name);
  }
  assert.ok(record.timings.totalMs >= record.timings.indexingMs);
  const output = renderRun(config, record);
  assert.match(output, /DEVELOPMENT/); assert.match(output, /not exposed/); assert.match(output, /Persistence: in-memory/);
  assert.doesNotMatch(output, /undefined|NaN/);
  assert.equal((await runSearch(config)).corpus.identity, record.corpus.identity);
  await writeFile(join(root, 'unsupported.pdf'), 'changed unsupported content');
  assert.equal((await runSearch(config)).corpus.identity, record.corpus.identity);
  await writeFile(join(root, 'sample.ts'), 'export const unrelated = false;\n');
  assert.notEqual((await runSearch(config)).corpus.identity, record.corpus.identity);
});

test('search CLI: incompatible options fail explicitly and npm aliases use the CLI', () => {
  assert.throws(() => options(['--dev', '--showcase']), /Choose/);
  assert.throws(() => options(['--mode', 'dev']), /mode must/);
  const canonical = cli(['--fixture', '--showcase', '--color', 'never']);
  assert.equal(canonical.status, 0, canonical.stderr);
  for (const alias of ['search', 'demo']) {
    const invoked = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['run', '--silent', alias, '--', '--fixture', '--showcase', '--color', 'never'],
      { cwd: project, encoding: 'utf8', timeout: 30_000 });
    assert.equal(invoked.status, 0, invoked.stderr);
    assert.equal(invoked.stdout, canonical.stdout);
  }
});

test('search CLI: real MiniLM comparison indexes once and counts completed unique inputs', {
  skip: process.env.PROVENA_DEMO_MODEL !== '1', timeout: 120_000,
}, async t => {
  const { root } = await corpus(t);
  for (const file of ['character.md', 'sample.ts', 'empty.txt']) await rm(join(root, file));
  for (let i = 0; i < 5; i++) await writeFile(join(root, `retry-${i}.ts`), `export function retryJob() { return ${i}; }\n`);
  await writeFile(join(root, 'duplicate.ts'), 'export function retryJob() { return 0; }\n');
  const { env } = await import('@huggingface/transformers');
  const previous = { fetch: env.fetch, globalFetch: globalThis.fetch, remote: env.allowRemoteModels };
  let fetches = 0; env.fetch = globalThis.fetch = async () => { fetches++; throw new Error('Network forbidden'); };
  t.after(() => { env.fetch = previous.fetch; globalThis.fetch = previous.globalFetch; env.allowRemoteModels = previous.remote; });
  const extra = process.env.PROVENA_DEMO_MODEL_DIR ? ['--model-dir', process.env.PROVENA_DEMO_MODEL_DIR] : [];
  const config = options(['--source', root, '--query', 'retryJob', '--compare', '--dev', '--color', 'never', ...extra]);
  const events = []; const record = await runSearch(config, event => events.push(structuredClone(event)));
  assert.equal(fetches, 0); assert.equal(env.allowRemoteModels, previous.remote);
  assert.equal(record.corpus.documents, 6); assert.equal(record.report.chunks, 6);
  assert.equal(record.observations.embeddingInputs, 5); assert.equal(record.report.reusedVectors, 1);
  assert.equal(events.filter(event => event.phase === 'scan').length, 1);
  assert.deepEqual(events.filter(event => event.phase === 'read').map(event => event.completed), [0, 1, 2, 3, 4, 5, 6]);
  const done = events.filter(event => event.phase === 'embed').map(event => event.completed);
  assert.ok(done.includes(4)); assert.equal(done.at(-1), 5);
  assert.deepEqual(record.runs.map(run => run.mode), ['lexical', 'semantic', 'hybrid']);
  for (const run of record.runs) {
    assert.equal(run.entries.length, 3); assert.ok(run.queryEmbeddingMs >= 0);
    for (const { result } of run.entries) assert.equal(result.snippet,
      (await readFile(join(root, result.path), 'utf8')).split('\n').slice(result.startLine - 1, result.endLine).join('\n'));
  }
  const { MiniLMEmbedder, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION } = await import('@theleumas/provena/minilm');
  const local = config.modelDir ?? await cachedModelDirectory(config.cacheDir, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION);
  const model = new MiniLMEmbedder({ model: local, revision: MINILM_DEFAULT_REVISION, localFilesOnly: true, device: 'cpu', dtype: 'fp32' });
  t.after(() => model.dispose());
  env.allowRemoteModels = false;
  const engine = new SemanticSearchEngine({ embedder: model });
  engine.addSource(new FileSystemFolderSource({ id: 'project', root })); await engine.refreshSource('project');
  for (const run of record.runs) assert.deepEqual(run.entries.map(entry => entry.result),
    await engine.search({ query: config.query, mode: run.mode, limit: config.limit }));
  assert.equal(fetches, 0);
  const output = renderRun(config, record); assert.match(output, /COMPARE/); assert.match(output, /LEXICAL\s+SEMANTIC\s+HYBRID/);
  for (const width of [20, 40, 88]) for (const line of stripVTControlCharacters(renderRun({ ...config, width }, record)).split('\n')) assert.ok(displayWidth(line) <= width, line);
});

test('search CLI: default source is cwd recursively, with a quiet source-selection hint', async t => {
  const { root, temporary } = await corpus(t);
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/extra.md'), 'Ada learns magic. refreshSource updates documents.\n');
  // Walking upward would encounter this invalid source outside cwd.
  await writeFile(join(temporary, 'parent.txt'), Buffer.from([0]));
  const inferred = cli(['--query', 'Ada', '--color', 'never'], root);
  assert.equal(inferred.status, 0, inferred.stderr);
  assert.match(inferred.stderr, /current directory, recursively/);
  assert.match(inferred.stderr, /--source PATH/);
  assert.ok(inferred.stderr.includes(join(project, 'src')));
  assert.ok(inferred.stderr.includes(join(project, 'cli/fixtures/source')));
  assert.match(inferred.stdout, /character.md/);
  assert.match(inferred.stdout, /nested\/extra.md/);
  for (const args of [[], ['--source', root], ['--fixture']]) {
    const missing = cli([...args, '--color', 'never'], root);
    assert.equal(missing.status, 1); assert.equal(missing.stdout, '');
    assert.match(missing.stderr.replace(/\s+/g, ' '), /Provide --query/);
  }
  for (const args of [['--source', root, '--query', 'Ada'], ['--fixture', '--query', 'retryJob'], ['--showcase'], ['--help']]) {
    const selected = cli([...args, '--color', 'never'], root);
    assert.equal(selected.status, 0, selected.stderr); assert.equal(selected.stderr, '');
  }
  assert.equal(options([]).root, process.cwd());
  const withEnv = (env, args = []) => optionsFrom(args, { columns: 88, isTTY: false }, env);
  assert.equal(withEnv({ PROVENA_CACHE_DIR: '/x/models' }).cacheDir, '/x/models');
  assert.equal(withEnv({ PROVENA_CACHE_DIR: '/x/models' }, ['--cache-dir', '/y']).cacheDir, '/y');
  assert.equal(withEnv({ PROVENA_RUNTIME_DIR: '/x/runtime' }).runtimeDir, '/x/runtime');
  assert.equal(withEnv({}, ['--runtime-dir', '/y']).runtimeDir, '/y');
  assert.equal(withEnv({}).installRuntime, true);
  assert.equal(withEnv({}, ['--no-install']).installRuntime, false);
  assert.equal(withEnv({ PROVENA_NO_INSTALL: '1' }).installRuntime, false);
  if (!(await import('node:fs')).existsSync(join(project, '.cache/minilm'))) assert.equal(withEnv({ XDG_CACHE_HOME: '/xdg' }).cacheDir, '/xdg/provena/minilm');
  assert.equal(options(['--fixture']).root, join(project, 'cli/fixtures/source'));
  assert.throws(() => options(['--source', '']), /requires a directory path/);
});
