import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { optionsFrom } from '../cli.mjs';
import { OllamaEmbedder, OLLAMA_DEFAULT_URL } from '../ollama.mjs';
import { createRuntime } from '../runtime.mjs';

const options = args => optionsFrom(args, { isTTY: false, columns: 88 }, {});

// Minimal fake Ollama server that returns fixed-dimension zero vectors.
function startFakeOllama({ dimensions = 4, failOnce = false, status = 200, errorBody = null } = {}) {
  let calls = []; let failNext = failOnce;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      calls.push({ url: req.url, body: JSON.parse(body) });
      if (failNext) {
        failNext = false;
        res.writeHead(status ?? 500);
        res.end(errorBody ?? JSON.stringify({ error: 'model not found' }));
        return;
      }
      const { input } = JSON.parse(body);
      const embeddings = input.map(() => Array.from({ length: dimensions }, () => 0.1));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ embeddings }));
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        get calls() { return calls; },
        close: () => new Promise(res => server.close(res)),
      });
    });
  });
}

// --- OllamaEmbedder unit tests ---

test('OllamaEmbedder: requires model name', () => {
  assert.throws(() => new OllamaEmbedder({ url: OLLAMA_DEFAULT_URL }), /ollama-model/i);
  assert.throws(() => new OllamaEmbedder({ model: '' }), /ollama-model/i);
});

test('OllamaEmbedder: default URL constant is localhost:11434', () => {
  assert.equal(OLLAMA_DEFAULT_URL, 'http://localhost:11434');
});

test('OllamaEmbedder: embedDocuments sends correct request and returns Float32Arrays', async () => {
  const server = await startFakeOllama({ dimensions: 4 });
  try {
    const embedder = new OllamaEmbedder({ url: server.url, model: 'nomic-embed-text' });
    assert.equal(embedder.dimensions, 0); // not yet known
    const vectors = await embedder.embedDocuments(['hello world', 'foo bar']);
    assert.equal(vectors.length, 2);
    assert.ok(vectors[0] instanceof Float32Array);
    assert.equal(vectors[0].length, 4);
    assert.equal(embedder.dimensions, 4);
    assert.equal(server.calls.length, 1);
    assert.equal(server.calls[0].url, '/api/embed');
    assert.deepEqual(server.calls[0].body.input, ['hello world', 'foo bar']);
    assert.equal(server.calls[0].body.model, 'nomic-embed-text');
  } finally { await server.close(); }
});

test('OllamaEmbedder: embedQuery sends single input and returns Float32Array', async () => {
  const server = await startFakeOllama({ dimensions: 4 });
  try {
    const embedder = new OllamaEmbedder({ url: server.url, model: 'mxbai-embed-large' });
    const vector = await embedder.embedQuery('find things');
    assert.ok(vector instanceof Float32Array);
    assert.equal(vector.length, 4);
    assert.deepStrictEqual(server.calls[0].body.input, ['find things']);
  } finally { await server.close(); }
});

test('OllamaEmbedder: query and document prefixes are prepended correctly', async () => {
  const server = await startFakeOllama({ dimensions: 2 });
  try {
    const embedder = new OllamaEmbedder({
      url: server.url, model: 'nomic-embed-text',
      queryPrefix: 'search_query: ', documentPrefix: 'search_document: ',
    });
    await embedder.embedDocuments(['Example System']);
    assert.deepEqual(server.calls[0].body.input, ['search_document: Example System']);
    await embedder.embedQuery('Ada');
    assert.deepEqual(server.calls[1].body.input, ['search_query: Ada']);
  } finally { await server.close(); }
});

test('OllamaEmbedder: id includes origin, model name, and dimension after first call', async () => {
  const server = await startFakeOllama({ dimensions: 8 });
  try {
    const embedder = new OllamaEmbedder({ url: server.url, model: 'my-model' });
    const preId = embedder.id;
    assert.match(preId, /ollama:http:\/\/127\.0\.0\.1:\d+:my-model$/);
    assert.doesNotMatch(preId, /dim/);
    await embedder.embedQuery('x');
    const postId = embedder.id;
    assert.match(postId, /ollama:http:\/\/127\.0\.0\.1:\d+:my-model:dim8$/);
  } finally { await server.close(); }
});

test('OllamaEmbedder: empty document list returns empty array without HTTP call', async () => {
  const server = await startFakeOllama();
  try {
    const embedder = new OllamaEmbedder({ url: server.url, model: 'test' });
    const result = await embedder.embedDocuments([]);
    assert.deepEqual(result, []);
    assert.equal(server.calls.length, 0);
  } finally { await server.close(); }
});

test('OllamaEmbedder: non-200 response throws descriptive error', async () => {
  const server = await startFakeOllama({ failOnce: true, status: 404 });
  try {
    const embedder = new OllamaEmbedder({ url: server.url, model: 'ghost-model' });
    await assert.rejects(embedder.embedDocuments(['x']), /Ollama responded 404/);
  } finally { await server.close(); }
});

test('OllamaEmbedder: unreachable server throws descriptive error', async () => {
  const embedder = new OllamaEmbedder({ url: 'http://127.0.0.1:1', model: 'nope' });
  await assert.rejects(embedder.embedDocuments(['x']), /Ollama request failed/);
});

test('OllamaEmbedder: abort signal cancels in-flight request', async () => {
  // Server that hangs until aborted
  const server = createServer((_req, _res) => { /* hang */ });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();
  try {
    const embedder = new OllamaEmbedder({ url: `http://127.0.0.1:${port}`, model: 'slow' });
    const controller = new AbortController();
    const promise = embedder.embedDocuments(['x'], { signal: controller.signal });
    controller.abort();
    await assert.rejects(promise, /abort/i);
  } finally { await new Promise(res => server.close(res)); }
});

// --- CLI integration: --embedder ollama wires through createRuntime ---

test('CLI optionsFrom: --embedder ollama validates flags', () => {
  assert.equal(options(['--embedder', 'ollama', '--ollama-model', 'nomic']).embedder, 'ollama');
  assert.equal(options(['--embedder', 'ollama', '--ollama-model', 'nomic']).ollamaModel, 'nomic');
  assert.equal(options(['--embedder', 'ollama', '--ollama-model', 'nomic']).ollamaUrl, undefined);
  assert.equal(options(['--embedder', 'ollama', '--ollama-model', 'nomic', '--ollama-url', 'http://localhost:11434']).ollamaUrl, 'http://localhost:11434');
  assert.equal(options([]).embedder, 'minilm'); // default
  assert.throws(() => options(['--embedder', 'ollama']), /ollama-model/i);
  assert.throws(() => options(['--embedder', 'bad']), /embedder must be/i);
  assert.throws(() => options(['--ollama-model', 'x']), /--ollama-model requires/i);
  assert.throws(() => options(['--ollama-url', 'http://x']), /--ollama-url requires/i);
  assert.throws(() => options(['--embedder', 'ollama', '--ollama-model', 'x', '--ollama-url', 'not-a-url']), /valid URL/i);
});

test('CLI createRuntime: --embedder ollama hybrid search with fake server', async t => {
  const server = await startFakeOllama({ dimensions: 4 });
  const root = await mkdtemp(join(tmpdir(), 'provena-ollama-test-'));
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, 'notes.md'), '# Ada\n\nAda is the protagonist of Example System.\n');

  const config = {
    ...options(['--source', root, '--mode', 'hybrid', '--color', 'never',
      '--embedder', 'ollama', '--ollama-model', 'nomic-embed-text']),
    ollamaUrl: server.url,
  };

  const runtime = await createRuntime(config);
  t.after(() => runtime.dispose());
  await runtime.refresh();
  const run = await runtime.search('Ada', 'hybrid', config);
  assert.ok(run.entries.length > 0);
  assert.equal(run.entries[0].result.path, 'notes.md');
  // Ollama endpoint was called for document and query embedding
  assert.ok(server.calls.length >= 2, `expected >=2 calls, got ${server.calls.length}`);
  assert.ok(server.calls.every(c => c.url === '/api/embed'));
  assert.ok(server.calls.every(c => c.body.model === 'nomic-embed-text'));
});
