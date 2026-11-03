// Explicit opt-in: downloads pinned model files if absent. Never imported by tests/run.mjs.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { MiniLMEmbedder, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION } from '../dist/adapters/minilm.js';
import { SemanticSearchEngine } from '../dist/index.js';
import { MemoryStorage, source } from './fixtures/lifecycle.mjs';
const cacheDir = process.env.MINILM_CACHE_DIR ?? fileURLToPath(new URL('../.cache/minilm/', import.meta.url));
await mkdir(cacheDir, { recursive: true });
const mode = process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'hub';
assert.ok(['hub', 'staged', 'hub-cache-only'].includes(mode), 'Unknown MiniLM acceptance mode');
const temporary = await mkdtemp(join(tmpdir(), 'minilm-acceptance-'));
let networkAttempts = 0;
const options = { cacheDir, localFilesOnly: mode !== 'hub', device: 'cpu', dtype: 'fp32' };
if (mode !== 'hub') {
  // This is host setup in an isolated test process, never configuration inside MiniLMEmbedder.
  const { env } = await import('@huggingface/transformers');
  env.localModelPath = join(temporary, 'models') + '/';
  env.allowLocalModels = true; env.allowRemoteModels = false;
  env.useBrowserCache = false; env.useCustomCache = false;
  env.cacheDir = join(temporary, 'empty-global-cache');
  if (mode === 'staged') {
    const assets = process.env.MINILM_LOCAL_MODEL_DIR ?? join(cacheDir, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION);
    // Acceptance stages only files from the pinned fixture; deployment staging belongs to the host.
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']) await access(join(assets, file));
    await cp(assets, join(env.localModelPath, MINILM_DEFAULT_MODEL), { recursive: true });
    env.useFSCache = false; // Prove local assets alone work, independently of Hub caches.
  } else {
    for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']) await access(join(cacheDir, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION, file));
  }
  const forbidNetwork = async () => { networkAttempts++; throw new Error('Unexpected network request during strict offline acceptance'); };
  env.fetch = forbidNetwork; globalThis.fetch = forbidNetwork;
}
if (mode === 'hub-cache-only') {
  const model = new MiniLMEmbedder(options); let failure;
  try { await model.embedQuery('known limitation probe'); } catch (error) { failure = error; }
  finally { await model.dispose(); await rm(temporary, { recursive: true, force: true }); }
  assert.ok(failure, 'The documented 4.2.0 cache-only limitation changed; review the loading matrix');
  assert.match(failure.cause?.message ?? '', /tokenizer_class/, 'Unexpected failure must not be classified as the known cache-only limitation');
  assert.equal(networkAttempts, 0);
  console.log(JSON.stringify({ mode, status: 'known-unsupported', reproduced: true, networkAttempts,
    reason: failure.cause?.message ?? failure.message, note: 'Expected limitation, not an adapter acceptance failure. Use staged local assets for strict offline deployment.' }, null, 2));
  process.exit(0);
}
const started = performance.now(); let readyMs; let progressEvents = 0;
const embedder = new MiniLMEmbedder({ ...options, batchSize: 4, onProgress(event) { progressEvents++; if (event.status === 'ready') readyMs = performance.now() - started; } });
const partitioned = new MiniLMEmbedder({ ...options, batchSize: 1 });
const restartModel = new MiniLMEmbedder(options);
const metrics = { mode, id: embedder.id, dimensions: embedder.dimensions, device: options.device, dtype: options.dtype };
const cosine = (a, b) => a.reduce((sum, value, i) => sum + value * b[i], 0) / Math.sqrt(a.reduce((s, v) => s + v*v, 0) * b.reduce((s, v) => s + v*v, 0));
const distance = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])));
const validate = vector => {
  assert.ok(vector instanceof Float32Array); assert.equal(vector.length, 384); assert.ok(vector.every(Number.isFinite));
  assert.ok(Math.abs(Math.sqrt(vector.reduce((s, v) => s + v*v, 0)) - 1) < 0.001);
};
try {
  assert.equal(progressEvents, 0); assert.equal(partitioned.id, embedder.id);
  const texts = ['reset my account password', 'change the password for my account', 'the weather forecast predicts rain'];
  const rssBefore = process.memoryUsage().rss;
  let start = performance.now(); const documents = await embedder.embedDocuments(texts); metrics.firstEmbeddingMs = performance.now() - start;
  documents.forEach(validate); assert.ok(progressEvents > 0); metrics.coldLoadThroughReadyMs = readyMs;
  start = performance.now(); const query = await embedder.embedQuery(texts[0]); metrics.warmQueryMs = performance.now() - start; validate(query);
  start = performance.now(); const repeat = await embedder.embedDocuments(texts); metrics.warmBatchMs = performance.now() - start;
  const split = await partitioned.embedDocuments(texts); split.forEach(validate);
  metrics.repeatMaxAbsoluteDifference = Math.max(...repeat.map((v, i) => distance(v, documents[i])));
  metrics.partitionMaxAbsoluteDifference = Math.max(...split.map((v, i) => distance(v, documents[i])));
  assert.ok(metrics.repeatMaxAbsoluteDifference < 0.0001); assert.ok(metrics.partitionMaxAbsoluteDifference < 0.0001);
  metrics.similarCosine = cosine(documents[0], documents[1]); metrics.unrelatedCosine = cosine(documents[0], documents[2]);
  assert.ok(metrics.similarCosine > metrics.unrelatedCosine);
  assert.ok(cosine(query, documents[1]) > cosine(query, documents[2])); assert.ok(distance(query, documents[0]) < 0.0001);
  metrics.rssDeltaBytes = process.memoryUsage().rss - rssBefore;
  let inferred = 0; let queryCalls = 0;
  const observed = model => ({ id: model.id, dimensions: model.dimensions,
    async embedDocuments(texts, options) { inferred += texts.length; return model.embedDocuments(texts, options); },
    async embedQuery(...args) { queryCalls++; return model.embedQuery(...args); } });
  const input = source(); const storage = new MemoryStorage(); const engine = new SemanticSearchEngine({ embedder: observed(embedder), storage }); engine.addSource(input);
  const counts = {};
  async function measure(name, work) { const before = inferred; await work(); counts[name] = inferred - before; }
  await measure('initial', () => engine.initialize()); await measure('unchanged', () => engine.refreshSource(input.id));
  input.files.set('b.txt', 'changed beta material'); await measure('changed', () => engine.refreshSource(input.id));
  input.files.set('renamed.txt', input.files.get('a.txt')); input.files.delete('a.txt'); await measure('rename', () => engine.refreshSource(input.id));
  const restarted = new SemanticSearchEngine({ embedder: observed(restartModel), storage }); restarted.addSource(input);
  await measure('restart', () => restarted.initialize()); assert.deepEqual(counts, { initial: 3, unchanged: 0, changed: 1, rename: 0, restart: 0 });
  const hits = await restarted.search({ mode: 'lexical', query: 'alpha' }); assert.equal(hits[0].path, 'renamed.txt'); assert.equal(hits[0].semanticRank, undefined); assert.equal(queryCalls, 0);
  const good = structuredClone(storage.snapshot); await embedder.dispose(); input.files.set('renamed.txt', 'candidate must fail');
  await assert.rejects(engine.refreshSource(input.id), /disposed/); assert.deepEqual(storage.snapshot, good);
  assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' })).length, 1);
  await assert.rejects(embedder.embedQuery('after disposal'), /disposed/); await embedder.dispose();
  metrics.lifecycleInferenceInputs = counts; metrics.networkAttempts = mode === 'staged' ? networkAttempts : null;
  if (mode === 'staged') assert.equal(networkAttempts, 0);
  metrics.passed = true;
  metrics.note = 'Single Node CPU fp32 run. Cold load may include downloads; RSS delta includes two model instances and runtime allocations, not peak model memory. This inference/lifecycle acceptance explicitly uses lexical search; retrieval quality is evaluated separately.';
} finally {
  try { await Promise.all([embedder.dispose(), partitioned.dispose(), restartModel.dispose()]); }
  finally { await rm(temporary, { recursive: true, force: true }); }
}
console.log(JSON.stringify(metrics, null, 2));
