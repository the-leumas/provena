import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { optionsFrom, renderRun, createProgress } from '../cli.mjs';
import { createRuntime } from '../runtime.mjs';
import { runInteractive } from '../scrollback.mjs';
import { promptForQuery } from '../prompt.mjs';

const options = args => optionsFrom(args, { columns: 88, isTTY: false }, {});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'provena-scrollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'alpha.txt'), 'alpha project overview\n');
  await writeFile(join(root, 'beta.txt'), 'beta notes\n');
  return { root, config: options(['--source', root, '--color', 'never', '--width', '200']) };
}
function scripted(steps) {
  let index = 0;
  return async (_options, context) => {
    assert.equal(context.header, index === 0);
    const next = steps[index++]; assert.notEqual(next, undefined, 'unexpected extra prompt');
    const query = typeof next === 'function' ? await next(context) : next;
    return { query, exitCode: 0 };
  };
}
function capture() {
  let output = ''; let status = '';
  return { output: { write(text) { output += text; } }, status: { write(text) { status += text; } },
    get text() { return output; }, get info() { return status; } };
}
function observe(events, counts) {
  return async (config, progress) => {
    counts.created++;
    const runtime = await createRuntime(config, event => { events.push(event); progress(event); });
    const set = runtime.setProgress.bind(runtime); const dispose = runtime.dispose.bind(runtime);
    runtime.setProgress = progress => set(event => { events.push(event); progress(event); });
    runtime.dispose = async () => { counts.disposed++; await dispose(); };
    return runtime;
  };
}

test('scrollback queries share one engine; only explicit refresh discovers and parses changes', async t => {
  const { root, config } = await fixture(t); const io = capture(); const events = []; const counts = { created: 0, disposed: 0 };
  const prompt = scripted(['alpha', () => {
    assert.equal(events.filter(e => e.phase === 'scan').length, 1); return 'beta';
  }, async () => {
    assert.equal(events.filter(e => e.phase === 'scan').length, 1);
    await writeFile(join(root, 'alpha.txt'), 'replacement overview\n');
    await rm(join(root, 'beta.txt')); await writeFile(join(root, 'new.txt'), 'new subject\n');
    return '/refresh';
  }, 'replacement', '/quit']);
  assert.equal(await runInteractive(config, { ...io, render: renderRun, prompt, runtimeFactory: observe(events, counts) }), 0);
  assert.deepEqual(counts, { created: 1, disposed: 1 });
  assert.equal(events.filter(e => e.phase === 'scan').length, 2);
  assert.equal(events.filter(e => e.phase === 'parse').length, 4);
  assert.equal((io.text.match(/Ready ·/g) ?? []).length, 2);
  assert.equal((io.text.match(/Use --save-index/g) ?? []).length, 1);
  assert.equal((io.text.match(/Query  /g) ?? []).length, 3);
  assert.match(io.text, /replacement/); assert.doesNotMatch(io.text, /DEVELOPMENT|Scan \+ admission/);
});

test('scrollback stale evidence requires refresh; failed refresh retains committed results', async t => {
  const { root, config } = await fixture(t); const io = capture();
  const prompt = scripted(['alpha', async () => {
    await writeFile(join(root, 'alpha.txt'), 'changed alpha overview\n'); return 'alpha';
  }, '/refresh', 'alpha', async () => {
    await writeFile(join(root, 'invalid.txt'), Buffer.from([0])); return '/refresh';
  }, 'alpha', '/quit']);
  assert.equal(await runInteractive(config, { ...io, render: renderRun, prompt }), 0);
  assert.match(io.info, /Source changed after indexing/);
  assert.match(io.info, /Refresh failed:.*Binary/); assert.match(io.info, /previous committed index is retained/);
  assert.equal((io.text.match(/Query  alpha/g) ?? []).length, 3);
  assert.match(io.text, /changed alpha overview/);
});

test('scrollback exit/help before first valid query perform no preparation; initial failure disposes', async t => {
  const { config } = await fixture(t); const io = capture(); let preparations = 0;
  const runtimeFactory = async () => { preparations++; throw new Error('must not prepare'); };
  assert.equal(await runInteractive(config, { ...io, render: renderRun, runtimeFactory,
    prompt: scripted(['/help', '/refresh', '/unknown', '/quit']) }), 0);
  assert.equal(preparations, 0); assert.match(io.info, /Enter a search query before preparing/);
  assert.equal(await runInteractive(config, { ...io, render: renderRun, runtimeFactory, prompt: scripted([null]) }), 0);
  let disposed = false;
  assert.equal(await runInteractive(config, { ...io, render: renderRun, prompt: scripted(['alpha']), runtimeFactory: async () => ({
    async refresh() { throw new Error('initial failure'); }, async dispose() { disposed = true; },
  }) }), 1);
  assert.ok(disposed); assert.match(io.info, /Preparation failed: initial failure/);
});

test('scrollback Ctrl+C aborts current work and disposes runtime', async t => {
  const { config } = await fixture(t); const io = capture(); let disposed = false;
  const runtimeFactory = async () => ({
    async refresh({ signal }) { process.emit('SIGINT'); assert.ok(signal.aborted); signal.throwIfAborted(); },
    async dispose() { disposed = true; },
  });
  const before = process.listenerCount('SIGINT');
  assert.equal(await runInteractive(config, { ...io, render: renderRun, prompt: scripted(['alpha']), runtimeFactory }), 130);
  assert.ok(disposed); assert.equal(process.listenerCount('SIGINT'), before);
});

test('scrollback semantic session reuses document vectors and warm restart skips inference', async t => {
  const { root, config } = await fixture(t); let documents = 0; let queries = 0; const events = []; const io = capture();
  const embedder = { id: 'scrollback-model', dimensions: 2,
    async embedDocuments(texts) { documents += texts.length; return texts.map(() => new Float32Array([1, 0])); },
    async embedQuery() { queries++; return new Float32Array([1, 0]); },
  };
  const manager = { async acquire() { return { embedder, model: { id: embedder.id } }; }, listen() {}, async dispose() {} };
  const semantic = { ...config, mode: 'semantic', saveIndexBase: root };
  const factory = (options, progress) => createRuntime(options, e => { events.push(e); progress(e); }, { manager });
  assert.equal(await runInteractive(semantic, { ...io, render: renderRun, runtimeFactory: factory, prompt: scripted(['alpha', 'beta', '/quit']) }), 0);
  assert.equal(documents, 2); assert.equal(queries, 2); assert.equal(events.filter(e => e.phase === 'scan').length, 1);
  const warm = await createRuntime(semantic, () => {}, { manager });
  try {
    await warm.refresh(); assert.equal(warm.report.documentsRead, 0); assert.equal(warm.report.documentsParsed, 0);
    assert.equal(warm.report.embeddedTexts, 0); assert.equal(documents, 2); assert.equal(warm.report.persistence, 'unchanged');
    await warm.search('alpha'); assert.equal(documents, 2);
  } finally { await warm.dispose(); }
});

test('CLI prompt validates input, preserves history and exits on EOF or cancellation', async () => {
  const config = options(['--color', 'never']); const history = []; const input = new PassThrough(); const output = new PassThrough();
  let prompts = 0; output.on('data', chunk => {
    if (chunk.toString().includes('Query ›')) setImmediate(() => input.write(++prompts === 1 ? '\n' : 'alpha\n'));
  });
  const answer = await promptForQuery(config, { input, output, history });
  assert.equal(answer.query, 'alpha'); assert.deepEqual(history, ['alpha']); input.destroy(); output.destroy();
  for (const cancel of [false, true]) {
    const input = new PassThrough(); const output = new PassThrough(); const controller = new AbortController();
    output.on('data', chunk => { if (chunk.toString().includes('Query ›')) setImmediate(() => cancel ? controller.abort() : input.end()); });
    const answer = await promptForQuery(config, { input, output, signal: controller.signal });
    assert.equal(answer.query, null); assert.equal(answer.exitCode, cancel ? 130 : 0); input.destroy(); output.destroy();
  }
});

test('CLI progress coalesces phase changes and paints before clearing leftover text', t => {
  const previous = process.env.TERM; process.env.TERM = 'xterm';
  t.after(() => { if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous; });
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const writes = []; const progress = createProgress(options(['--color', 'never']), { isTTY: true, columns: 88, write(text) { writes.push(text); } });
  progress.update({ phase: 'scan' });
  for (let i = 1; i <= 2000; i++) {
    progress.update({ phase: 'read', completed: i, total: 2000 }); progress.update({ phase: 'parse', completed: i, total: 2000 });
  }
  assert.equal(writes.length, 1); t.mock.timers.tick(80); assert.equal(writes.length, 2);
  assert.match(writes.at(-1), /Parsing 2000\/2000/);
  assert.ok(writes.every(text => text.startsWith('\r') && text.endsWith('\x1b[K') && !text.includes('\x1b[2K')));
  progress.stop(); const count = writes.length; t.mock.timers.tick(1000); assert.equal(writes.length, count);
});

test('CLI explains index migration before inference without resuming a stale loading spinner', t => {
  const previous = process.env.TERM; process.env.TERM = 'xterm';
  t.after(() => { if (previous === undefined) delete process.env.TERM; else process.env.TERM = previous; });
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 0 });
  const writes = []; const progress = createProgress(options(['--color', 'never']), { isTTY: true, columns: 88, write(text) { writes.push(text); } });
  try {
    progress.update({ phase: 'index-load' });
    progress.update({ phase: 'index-rebuild', message: 'Chunker changed. Matching compatible vectors will be reused.' });
    assert.match(writes.join(''), /Matching compatible vectors will be reused/);
    const count = writes.length; t.mock.timers.tick(160); assert.equal(writes.length, count);
    progress.update({ phase: 'embed', completed: 0, total: 4 });
    assert.match(writes.at(-1), /Embedding 0\/4 inputs/);
  } finally { progress.stop(); }
});
