import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { SemanticSearchEngine, defaultFileTypes, getSupportedExtensions } from '@theleumas/provena';
import { FileSystemFolderSource } from '@theleumas/provena/filesystem';
import { optionsFrom, runDemo, selectExcerpt, displayWidth, createProgress, cachedModelDirectory } from '../cli.mjs';

const script = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const normalize = text => text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const options = args => optionsFrom(args, { columns: 88, isTTY: false }, {});
const cli = args => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 20_000 });
function withinWidth(output, width) {
  for (const line of stripVTControlCharacters(output).split('\n')) assert.ok(displayWidth(line) <= width, `Overflow at ${width}: ${line}`);
}
async function verify({ entries, output }, root, width, color = false) {
  withinWidth(output, width);
  const codeRows = stripVTControlCharacters(output).split('\n')
    .map(line => /^ {4} *(\d*) │ (.*)$/.exec(line)).filter(Boolean);
  assert.equal(codeRows.filter(row => row[1]).length, entries.reduce((sum, entry) => sum + entry.excerpt.lines.length, 0));
  let rowIndex = 0;
  for (const { result, excerpt } of entries) {
    const lines = normalize(await readFile(join(root, result.documentId), 'utf8')).split('\n');
    assert.equal(result.snippet, lines.slice(result.startLine - 1, result.endLine).join('\n'));
    assert.ok(excerpt.startLine >= result.startLine && excerpt.endLine <= result.endLine);
    assert.deepEqual(excerpt.lines, lines.slice(excerpt.startLine - 1, excerpt.endLine));
    for (const [i, raw] of excerpt.lines.entries()) {
      const row = codeRows[rowIndex++];
      assert.equal(Number(row[1]), excerpt.startLine + i);
      while (codeRows[rowIndex] && !codeRows[rowIndex][1]) row[2] += codeRows[rowIndex++][2];
      const original = raw.replace(/\t/g, '    ').replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
      if (row[2] !== original) {
        assert.ok(row[2].startsWith('…') || row[2].endsWith('…'), 'Clipping must be explicit');
        assert.ok(original.includes(row[2].replace(/^…|…$/g, '')), 'Rendered window must be contiguous source text');
      }
    }
    const plain = stripVTControlCharacters(output);
    if (width === 88) {
      assert.ok(plain.includes(result.path));
      assert.ok(plain.includes(`Passage L${result.startLine}–${result.endLine} · Excerpt L${excerpt.startLine}–${excerpt.endLine}`));
    }
  }
  if (!color) assert.doesNotMatch(output, /\x1b/);
}

test('demo: only a complete pinned model cache selects local loading', async t => {
  const cache = await mkdtemp(join(tmpdir(), 'provena-demo-cache-'));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const directory = join(cache, 'model', 'revision');
  assert.equal(await cachedModelDirectory(cache, 'model', 'revision'), undefined);
  await mkdir(join(directory, 'onnx'), { recursive: true });
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json']) await writeFile(join(directory, file), '{}');
  assert.equal(await cachedModelDirectory(cache, 'model', 'revision'), undefined);
  await writeFile(join(directory, 'onnx/model.onnx'), '');
  assert.equal(await cachedModelDirectory(cache, 'model', 'revision'), undefined);
  await writeFile(join(directory, 'onnx/model.onnx'), 'model');
  assert.equal(await cachedModelDirectory(cache, 'model', 'revision'), directory);
  assert.equal(await cachedModelDirectory(cache, 'model', 'other-revision'), undefined);
});

test('demo: fixture ranking is exactly the public API ranking with verified source excerpts', async () => {
  const config = options(['--fixture', '--showcase', '--color', 'never']);
  const demo = await runDemo(config);
  const engine = new SemanticSearchEngine();
  const source = new FileSystemFolderSource({ id: 'project', root: config.root });
  const list = source.list.bind(source);
  source.list = async operation => (await list(operation)).filter(document => !document.id.split('/').includes('.provena-indexes'));
  engine.addSource(source);
  const report = await engine.refreshSource('project');
  const expected = await engine.search({ query: config.query, mode: config.mode, limit: config.limit });
  assert.deepEqual(demo.entries.map(entry => entry.result), expected);
  assert.deepEqual(demo.report, report);
  assert.ok(expected.length > 0);
  await verify(demo, config.root, config.width);
  const retry = demo.entries.find(entry => entry.result.path === 'retry.ts');
  assert.ok(retry.excerpt.lines.some(line => line.includes('export function retryJob')));
  const queue = demo.entries.find(entry => entry.result.path === 'queue.ts');
  assert.ok(queue.excerpt.lines.some(line => line.includes('pending.push(retryJob')));
});

test('demo: refreshSource showcase selects its declaration inside the real engine passage', async () => {
  const config = options(['--source', fileURLToPath(new URL('../../src', import.meta.url)), '--showcase', '--color', 'never']);
  const demo = await runDemo(config);
  assert.ok(demo.entries.length > 0);
  const hit = demo.entries.find(entry => entry.result.path === 'engine.ts' && entry.result.snippet.includes('async refreshSource('));
  assert.ok(hit, 'the declaration passage must remain among retrieved results');
  assert.ok(hit.excerpt.lines.some(line => line.includes('async refreshSource(')));
  assert.ok(hit.excerpt.startLine > hit.result.startLine);
  await verify(demo, config.root, config.width);
});

test('demo: showcase CLI is reproducible across working directories; color preserves text', () => {
  const args = ['--fixture', '--showcase'];
  const plain = execFileSync(process.execPath, [script, ...args, '--color', 'never'], { encoding: 'utf8', cwd: tmpdir() });
  const again = execFileSync(process.execPath, [script, ...args, '--color', 'never'], { encoding: 'utf8' });
  assert.equal(again, plain);
  assert.doesNotMatch(plain, /file:\/\/|\/home\/|\/tmp\/|\d{4}-\d{2}-\d{2}|\x1b/);
  const colored = cli([...args, '--color', 'always']);
  assert.equal(colored.status, 0, colored.stderr);
  assert.equal(colored.stderr, '');
  assert.match(colored.stdout, /\x1b\[1;33mretryJob\x1b\[0m/);
  // Only the footer describes whether colors are enabled.
  assert.equal(stripVTControlCharacters(colored.stdout).replace('Yellow = literal query text', 'Literal highlights require color'), plain);
  withinWidth(colored.stdout, 88);
});

test('demo: provenance rejects stale or invalid ranges and normalizes parser-compatible newlines', () => {
  const result = { startLine: 2, endLine: 3, snippet: 'retryJob();\n}', lexicalRank: 1 };
  const excerpt = selectExcerpt(result, '\uFEFF// source\r\nretryJob();\r\n}\r\n', 'retryJob', 8, 'lexical');
  assert.deepEqual(excerpt.lines, ['retryJob();', '}']);
  assert.throws(() => selectExcerpt(result, '// source\nchanged();\n}', 'retryJob', 8, 'lexical'), /Source changed/);
  for (const invalid of [{ startLine: 0 }, { endLine: 99 }, { startLine: 2.5 }, { startLine: 3, endLine: 2 }]) {
    assert.throws(() => selectExcerpt({ ...result, ...invalid }, '// source\nretryJob();\n}', 'retryJob', 8, 'lexical'), /provenance/);
  }
  const semantic = selectExcerpt({ ...result, lexicalRank: undefined, semanticRank: 1 }, '// source\nretryJob();\n}', 'retryJob', 1, 'semantic');
  assert.equal(semantic.highlight, false);
});

test('demo: custom CRLF/BOM source, Unicode, tabs, literal regex text, long lines and narrow widths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'provena-demo-'));
  try {
    await mkdir(join(root, 'nested'));
    const text = '\uFEFF// 界面 👩‍💻 e\u0301\r\nexport function retryJob() {\r\n\treturn "' + '界'.repeat(70) + 'retryJob(";\r\n}\r\n';
    await writeFile(join(root, 'nested', '界面.ts'), text);
    await writeFile(join(root, 'ignored.unsupported'), 'retryJob is not a supported format');
    for (const width of [20, 32, 48, 88, 200]) {
      const config = options(['--source', root, '--query', 'retryJob(', '--width', String(width), '--showcase', '--color', 'always']);
      const demo = await runDemo(config);
      assert.equal(demo.report.documents, 1);
      assert.equal(demo.entries.length, 1);
      await verify(demo, root, width, true);
      assert.doesNotMatch(demo.output, /\uFEFF|\t/);
      assert.ok(!demo.output.includes(root));
      if (width >= 32) assert.match(demo.output, /\x1b\[1;33mretryJob\(\x1b\[0m/);
    }
    assert.equal(displayWidth('界👩‍💻e\u0301'), 5);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('demo: mixed corpus admits every canonical format and retrieves Markdown names', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-demo-documents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'Characters'));
  const profile = 'Characters/Ada of Example Town.md';
  const text = 'Character’s Overview\n====================\n\nAda, the protagonist of Example System, hails from Example Town as a Free Folk. ' +
    'He travels through the wilderness with his companions and learns the ways of magic.\n\nBasic Information\n=================\n- Name: Ada\n';
  await writeFile(join(root, profile), text);
  const samples = { '.ts': 'export const sampleToken = 1;\n', '.py': 'sampleToken = 1\n',
    '.json': '{"sampleToken": 1}\n', '.txt': 'sampleToken plain text\n', '.yaml': 'sampleToken: 1\n' };
  for (const extension of getSupportedExtensions().filter(extension => extension !== '.md')) {
    await writeFile(join(root, `sample${extension}`), samples[extension] ?? 'sampleToken\n');
  }
  // Hidden generated code is eligible alongside the Markdown source, not preferred
  // by admission. There are deliberately no demo directory exclusions.
  await mkdir(join(root, '.obsidian/plugins/example'), { recursive: true });
  await writeFile(join(root, '.obsidian/plugins/example/main.js'), 'export const sampleToken = true;\n');
  await writeFile(join(root, 'unsupported.pdf'), 'Ada unsupported');
  await writeFile(join(root, 'unknown.custom'), 'Ada unknown extension');
  await writeFile(join(root, 'no-extension'), 'Ada no extension');
  await writeFile(join(root, 'oversized.txt'), 'x'.repeat(defaultFileTypes.get('oversized.txt').maxBytes + 1));
  await symlink(join(root, profile), join(root, 'linked.md'));
  await symlink(join(root, 'Characters'), join(root, 'linked-directory'));
  const folder = new FileSystemFolderSource({ id: 'project', root });
  const admitted = await folder.list();
  assert.equal(admitted.length, getSupportedExtensions().length + 1);
  for (const extension of ['.md', '.ts', '.py', '.json', '.txt', '.yaml']) {
    assert.ok(admitted.some(document => document.path.endsWith(extension)));
  }
  assert.ok(admitted.some(document => document.path === '.obsidian/plugins/example/main.js'));
  const engine = new SemanticSearchEngine(); engine.addSource(folder);
  const expectedReport = await engine.refreshSource('project');
  const expected = await engine.search({ query: 'Who is Ada', mode: 'lexical', limit: 3 });
  for (const width of [20, 40, 88]) {
    const config = options(['--source', root, '--query', 'Who is Ada', '--mode', 'lexical', '--width', String(width), '--color', 'never']);
    const events = [];
    const demo = await runDemo(config, event => events.push(event));
    assert.deepEqual(demo.report, expectedReport);
    assert.deepEqual(demo.entries.map(entry => entry.result), expected);
    assert.equal(demo.entries[0].result.path, profile);
    assert.equal(demo.entries[0].result.language, 'markdown');
    assert.ok(demo.entries[0].excerpt.lines.some(line => line.includes('Ada, the protagonist')));
    const complete = events.filter(event => event.phase === 'read').at(-1);
    assert.equal(complete.completed, admitted.length); assert.equal(complete.total, admitted.length);
    await verify(demo, root, width);
    assert.doesNotMatch(demo.output, /SOURCE CODE RETRIEVAL/);
    // Long prose is preserved across continuation rows rather than clipped.
    assert.ok(demo.output.includes('│ '));
    assert.doesNotMatch(demo.output.split('\n').filter(line => /│/.test(line)).join('\n'), /…/);
  }
  const all = await runDemo(options(['--source', root, '--query', 'sampleToken', '--limit', '100', '--color', 'never']));
  await verify(all, root, 88);
  assert.ok(all.entries.some(entry => entry.result.path === 'sample.ts'));
  assert.ok(all.entries.some(entry => entry.result.path === 'sample.py'));
  assert.ok(all.entries.some(entry => entry.result.path === 'sample.json'));
});

test('demo: supported extensions do not bypass binary and UTF-8 rejection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'provena-demo-invalid-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'invalid.md');
  await writeFile(path, 'Ada\0binary');
  await assert.rejects(runDemo(options(['--source', root, '--query', 'Ada'])), /Binary content/);
  await writeFile(path, Uint8Array.from([0xff, 0xfe]));
  await assert.rejects(runDemo(options(['--source', root, '--query', 'Ada'])), /encoded data|encoding/i);
  const failed = cli(['--source', root, '--query', 'Ada']);
  assert.equal(failed.status, 1); assert.equal(failed.stdout, '');
});

test('demo: empty results, empty source and CLI errors exit honestly', async () => {
  const empty = await runDemo(options(['--fixture', '--query', 'no_such_symbol_918374', '--color', 'never']));
  assert.equal(empty.entries.length, 0);
  assert.match(empty.output, /No ranked passages/);
  const root = await mkdtemp(join(tmpdir(), 'provena-demo-empty-'));
  try {
    const demo = await runDemo(options(['--source', root, '--color', 'never']));
    assert.equal(demo.report.documents, 0);
    assert.equal(demo.entries.length, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
  for (const args of [['--mode', 'bogus'], ['--limit', '0'], ['--lines', '0'], ['--width', '19'], ['--query', ''], ['--query', '\x1b[31m'], ['--color', 'bogus'], ['--fixture', '--source', 'src'], ['--unknown']]) {
    const failed = cli(args);
    assert.equal(failed.status, 1, JSON.stringify(args));
    assert.equal(failed.stdout, '');
    assert.match(failed.stderr, /Search failed:/);
    assert.doesNotMatch(failed.stderr, /\x1b/);
  }
  const failed = cli(['--source', '/no-such-provena-demo-source', '--showcase']);
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.doesNotMatch(failed.stderr, /\/no-such/);
  assert.match(cli(['--help']).stdout, /Usage:/);
  assert.equal(optionsFrom([], { isTTY: true, columns: 88 }, { NO_COLOR: '' }).color, false);
  assert.throws(() => optionsFrom([], { columns: 12 }, {}), /too narrow/);
  const invalidShowcase = cli(['--showcase', '--unknown=machine-specific-detail']);
  assert.equal(invalidShowcase.status, 1);
  assert.doesNotMatch(invalidShowcase.stderr, /machine-specific-detail/);
});

test('demo: missing staged model reports failure without falling back to lexical', { timeout: 30_000 }, () => {
  const failed = cli(['--fixture', '--mode', 'semantic', '--model-dir', '/no-such-provena-demo-model', '--showcase']);
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /Could not load the model/);
  assert.doesNotMatch(failed.stderr, /\/home\/|\/no-such/);
});

test('demo: progress counts actual indexing reads, with verification counted separately', async () => {
  const config = options(['--fixture', '--color', 'never']);
  const events = [];
  const demo = await runDemo(config, event => events.push(structuredClone(event)));
  const reads = events.filter(event => event.phase === 'read');
  assert.deepEqual(reads.map(event => [event.completed, event.total]), [[0, 3], [1, 3], [2, 3], [3, 3]]);
  const checks = events.filter(event => event.phase === 'verify');
  assert.deepEqual(checks.map(event => event.completed), [0, 1, 2]);
  assert.ok(checks.every(event => event.total === demo.entries.length));
  assert.equal(events[0].phase, 'scan');
  assert.equal(events.at(-1).phase, 'done');
  assert.deepEqual(events.at(-1).report, demo.report);
  assert.deepEqual((await runDemo(config)).entries, demo.entries, 'Timings and progress must not alter results');

  const root = await mkdtemp(join(tmpdir(), 'provena-demo-progress-'));
  try {
    const emptyEvents = [];
    await runDemo(options(['--source', root]), event => emptyEvents.push(event));
    assert.deepEqual(emptyEvents.find(event => event.phase === 'read'), { phase: 'read', completed: 0, total: 0 });
    await writeFile(join(root, 'a.ts'), 'export const retryJob = true;');
    await writeFile(join(root, 'b.ts'), 'binary\0content');
    const failedEvents = [];
    await assert.rejects(runDemo(options(['--source', root]), event => failedEvents.push(event)), /Binary/);
    assert.deepEqual(failedEvents.filter(event => event.phase === 'read').map(event => event.completed), [0, 1]);
    assert.ok(!failedEvents.some(event => event.phase === 'done'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('demo: live progress animates, fits narrow terminals, and stops cleanly', t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const originalTerm = process.env.TERM;
  process.env.TERM = 'xterm';
  t.after(() => { if (originalTerm === undefined) delete process.env.TERM; else process.env.TERM = originalTerm; });
  const config = options(['--color', 'never']);
  const writes = [];
  const stream = { isTTY: true, columns: 88, write(text) { writes.push(text); } };
  const live = createProgress(config, stream);
  try {
    live.update({ phase: 'read', completed: 45, total: 1450 });
    assert.match(writes.at(-1), /Reading files 45\/1450/);
    assert.match(writes.at(-1), /\[━*─+\]/);
    t.mock.timers.tick(240);
    assert.ok(new Set(writes).size > 1, 'Waiting should advance the spinner');
    stream.columns = 20;
    live.update({ phase: 'scan' });
    live.update({ phase: 'read', completed: 45, total: 1450 });
    t.mock.timers.tick(80);
    assert.match(writes.at(-1), /Files 45\/1450/);
    withinWidth(writes.at(-1), 19);
    live.update({ phase: 'model', percent: 42.8, file: 'model.onnx' });
    t.mock.timers.tick(80);
    assert.match(writes.at(-1), /Model 42%/);
    withinWidth(writes.at(-1), 19);
    live.update({ phase: 'done', report: { documents: 1450, chunks: 3000 } });
    live.stop(true);
    assert.match(writes.join(''), /✓ 1450 files/);
    assert.match(writes.join(''), /3000 passages/);
    for (const line of writes.filter(text => text.endsWith('\n'))) withinWidth(line, 19);
    const count = writes.length;
    t.mock.timers.tick(80);
    live.update({ phase: 'scan' });
    live.stop(true);
    assert.equal(writes.length, count, 'Stopping must cancel animation and future writes');
  } finally { live.stop(); }

  const failedWrites = [];
  const failed = createProgress(config, { isTTY: true, columns: 88, write(text) { failedWrites.push(text); } });
  failed.update({ phase: 'read', completed: 1, total: 2 });
  failed.stop();
  assert.equal(failedWrites.at(-1), '\r\x1b[2K');
  assert.doesNotMatch(failedWrites.join(''), /✓/);
  for (const [settings, tty] of [[{ ...config, showcase: true }, true], [config, false]]) {
    const quiet = createProgress(settings, { isTTY: tty, write() { assert.fail('Noninteractive/showcase progress must be silent'); } });
    quiet.update({ phase: 'scan' }); quiet.stop(true);
  }
  process.env.TERM = 'dumb';
  const dumb = createProgress(config, { isTTY: true, write() { assert.fail('Dumb terminals must not receive cursor controls'); } });
  dumb.update({ phase: 'scan' }); dumb.stop();
});

test('demo: real MiniLM semantic and hybrid smoke with verified provenance', {
  skip: process.env.PROVENA_DEMO_MODEL !== '1', timeout: 600_000,
}, async () => {
  const extra = process.env.PROVENA_DEMO_MODEL_DIR ? ['--model-dir', process.env.PROVENA_DEMO_MODEL_DIR] : [];
  for (const mode of ['semantic', 'hybrid']) {
    const config = options(['--fixture', '--showcase', '--mode', mode, '--query',
      'retry failed background jobs with increasing delays', '--color', 'always', ...extra]);
    const progress = [];
    const demo = await runDemo(config, event => progress.push(event));
    assert.ok(progress.some(event => event.phase === 'embed'));
    const readingDone = progress.findIndex(event => event.phase === 'read' && event.completed === event.total);
    assert.ok(progress.findIndex(event => event.phase === 'embed') > readingDone);
    assert.equal(progress.at(-1).phase, 'done');
    assert.equal(demo.entries.length, 3);
    assert.ok(demo.entries.some(entry => entry.result.path === 'retry.ts'));
    assert.ok(demo.entries.every(entry => entry.result.semanticRank >= 1));
    await verify(demo, config.root, config.width, true);
    if (mode === 'semantic') {
      assert.ok(demo.entries.every(entry => entry.result.lexicalRank === undefined && !entry.excerpt.highlight));
      assert.doesNotMatch(demo.output, /\x1b\[1;33m/);
    } else {
      assert.ok(demo.entries.some(entry => entry.result.lexicalRank >= 1));
    }
    assert.equal((await runDemo(config)).output, demo.output, `${mode} showcase must repeat with the same model and source`);
  }
});

test('demo: warm default cache works in separate processes with all fetches forbidden', {
  skip: process.env.PROVENA_DEMO_MODEL !== '1' || Boolean(process.env.PROVENA_DEMO_MODEL_DIR), timeout: 300_000,
}, () => {
  const program = `
    import assert from 'node:assert/strict';
    import { env } from '@huggingface/transformers';
    import { optionsFrom, runDemo } from ${JSON.stringify(new URL('../cli.mjs', import.meta.url).href)};
    let requests = 0;
    env.fetch = globalThis.fetch = async () => { requests++; throw new Error('Network forbidden'); };
    const previous = env.allowRemoteModels;
    const config = optionsFrom(['--fixture', '--showcase', '--color', 'never', '--mode', process.argv[1],
      '--query', 'retry failed background jobs with increasing delays']);
    const demo = await runDemo(config);
    assert.ok(demo.entries.some(entry => entry.result.path === 'retry.ts'));
    assert.equal(requests, 0);
    assert.equal(env.allowRemoteModels, previous);
    console.log('Verified real inference with zero fetch attempts');
  `;
  for (const mode of ['semantic', 'hybrid']) {
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', program, mode], {
      cwd: fileURLToPath(new URL('../..', import.meta.url)), encoding: 'utf8', timeout: 120_000,
    });
    assert.equal(child.status, 0, child.stderr || child.error?.message);
    assert.match(child.stdout, /zero fetch attempts/);
  }
});
