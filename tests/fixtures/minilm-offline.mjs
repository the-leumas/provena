import assert from 'node:assert/strict';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { SemanticSearchEngine } from '../../dist/index.js';
import { source, MemoryStorage } from './lifecycle.mjs';
const code = await readFile(new URL('../../dist/adapters/minilm.js', import.meta.url), 'utf8');
assert.doesNotMatch(code, /node:|process\.|worker_threads/);
async function fixture() {
  const state = { imports: 0, loads: 0, batches: [], releases: 0, tensorsDisposed: 0, infer: null, load: null };
  const context = createContext({ Float32Array, AbortController });
  const extractor = Object.assign(async (texts, options) => {
    assert.deepEqual(options.pooling, 'mean'); assert.equal(options.normalize, true); state.batches.push(Array.from(texts));
    const data = new Float32Array(texts.length * 384); texts.forEach((text, i) => { data[i * 384 + text.length % 384] = 1; });
    const output = { data, type: 'float32', dims: [texts.length, 384], dispose() { state.tensorsDisposed++; } };
    if (state.infer) await state.infer(output); return output;
  }, { async dispose() { state.releases++; } });
  const runtime = new SyntheticModule(['env', 'AutoTokenizer', 'AutoModel', 'FeatureExtractionPipeline'], function() {
    this.setExport('env', { version: '4.2.0' });
    this.setExport('AutoTokenizer', { async from_pretrained(model, options) {
      assert.ok(options.revision);
      return state.tokenizer ?? { tokenize(text) { return Array.from({ length: text.length }, () => 'tok'); } };
    } });
    this.setExport('AutoModel', { async from_pretrained(model, options) {
      state.loads++; state.options = options; state.model = model;
      if (state.load) await state.load(); return { dispose: extractor.dispose };
    } });
    this.setExport('FeatureExtractionPipeline', function(args) { assert.equal(args.task, 'feature-extraction'); return extractor; });
  }, { context });
  await runtime.link(() => {}); await runtime.evaluate();
  const adapter = new SourceTextModule(code, { context, importModuleDynamically: async name => {
    assert.equal(name, '@huggingface/transformers'); state.imports++; return runtime;
  } });
  await adapter.link(() => { throw new Error('Unexpected eager dependency'); }); await adapter.evaluate();
  return { MiniLMEmbedder: adapter.namespace.MiniLMEmbedder, state };
}
{
  const { MiniLMEmbedder, state } = await fixture(); const progress = [];
  const model = new MiniLMEmbedder({ batchSize: 2, cacheDir: 'host-cache', localFilesOnly: true, onProgress: e => progress.push(e.status) });
  assert.equal(state.imports, 0); assert.equal(state.loads, 0); assert.equal((await model.embedDocuments([])).length, 0); assert.equal(state.imports, 0);
  // Scrambled inputs: length-aware batching groups by length but preserves exact return order
  const vectors = await model.embedDocuments(['eeeee', 'a', 'dddd', 'bb', 'ccc']);
  assert.deepEqual(state.batches, [['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
  assert.equal(state.batches.map(b => b.length).join(','), '2,2,1'); assert.equal(state.loads, 1); assert.equal(state.tensorsDisposed, 3);
  assert.equal(vectors[0][5], 1, 'Input 0 (eeeee) mapped back to result 0');
  assert.equal(vectors[1][1], 1, 'Input 1 (a) mapped back to result 1');
  assert.equal(vectors[2][4], 1, 'Input 2 (dddd) mapped back to result 2');
  assert.equal(vectors[3][2], 1, 'Input 3 (bb) mapped back to result 3');
  assert.equal(vectors[4][3], 1, 'Input 4 (ccc) mapped back to result 4');
  vectors[0][0] = 42; assert.notEqual(vectors[1][0], 42);
  const query = await model.embedQuery('bb'); assert.equal(query.length, 384); assert.equal(query[2], 1); assert.equal(state.loads, 1);
  assert.equal(state.options.cache_dir, 'host-cache'); assert.equal(state.options.local_files_only, true); assert.equal(state.options.device, 'cpu'); assert.equal(state.options.dtype, 'fp32'); assert.ok(progress.includes('ready'));
  assert.equal(model.id, new MiniLMEmbedder({ batchSize: 1, cacheDir: 'other', localFilesOnly: false }).id);
  for (const options of [{ revision: 'different' }, { dtype: 'q8' }, { device: 'wasm' }, { model: 'other', revision: 'pinned' }]) assert.notEqual(model.id, new MiniLMEmbedder(options).id);
  assert.throws(() => new MiniLMEmbedder({ batchSize: 0 })); assert.throws(() => new MiniLMEmbedder({ model: 'other' }));
  await model.dispose(); await model.dispose(); assert.equal(state.releases, 1); await assert.rejects(model.embedQuery('after disposal'), /disposed/);
}
{
  // Test fallback to character length sorting when tokenizer lacks tokenize method
  const { MiniLMEmbedder, state } = await fixture();
  state.tokenizer = {}; // Empty mock object without tokenize
  const model = new MiniLMEmbedder({ batchSize: 2 });
  const vectors = await model.embedDocuments(['eeeee', 'a', 'dddd', 'bb', 'ccc']);
  assert.deepEqual(state.batches, [['a', 'bb'], ['ccc', 'dddd'], ['eeeee']]);
  assert.equal(vectors[0][5], 1); assert.equal(vectors[1][1], 1); assert.equal(vectors[2][4], 1);
  await model.dispose();
}
{
  const { MiniLMEmbedder, state } = await fixture(); const model = new MiniLMEmbedder(); const abort = new AbortController(); abort.abort();
  await assert.rejects(model.embedQuery('cancelled', { signal: abort.signal })); assert.equal(state.imports, 0);
  state.load = () => { throw new Error('offline load'); }; await assert.rejects(model.embedQuery('fail'), /model load failed/);
  state.load = null; await model.embedQuery('retry'); assert.equal(state.loads, 2); await model.dispose();
}
for (const stage of ['loading', 'inference']) {
  const { MiniLMEmbedder, state } = await fixture(); const abort = new AbortController(); const model = new MiniLMEmbedder({ batchSize: 1 });
  if (stage === 'loading') state.load = () => abort.abort(); else state.infer = () => abort.abort();
  await assert.rejects(model.embedDocuments(['a', 'b'], { signal: abort.signal }));
  assert.equal(state.batches.length, stage === 'loading' ? 0 : 1);
  assert.equal(state.tensorsDisposed, stage === 'loading' ? 0 : 1); await model.dispose(); assert.equal(state.releases, 1);
}
for (const corrupt of [o => o.dims = [1, 2], o => o.type = 'int8', o => o.data[0] = NaN, o => o.data.fill(0)]) {
  const { MiniLMEmbedder, state } = await fixture(); state.infer = corrupt; const model = new MiniLMEmbedder();
  await assert.rejects(model.embedQuery('bad'), /Invalid MiniLM/); assert.equal(state.tensorsDisposed, 1); await model.dispose();
}
for (const stage of ['loading', 'inference']) {
  const { MiniLMEmbedder, state } = await fixture(); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  state[stage === 'loading' ? 'load' : 'infer'] = async () => { entered(); await new Promise(resolve => { release = resolve; }); };
  const model = new MiniLMEmbedder(); const work = model.embedQuery('active'); const rejected = assert.rejects(work, /disposed/);
  await started; const disposal = model.dispose(); release(); await rejected; await disposal; assert.equal(state.releases, 1);
}
{
  const { MiniLMEmbedder, state } = await fixture(); const model = new MiniLMEmbedder({ batchSize: 1 });
  await Promise.all([model.embedDocuments(['a', 'b']), model.embedQuery('c')]); assert.equal(state.loads, 1); assert.equal(state.batches.flat().join(','), 'a,b,c');
  const storage = new MemoryStorage(); const input = source(); const engine = new SemanticSearchEngine({ storage, embedder: model }); engine.addSource(input); await engine.initialize();
  const good = structuredClone(storage.snapshot); input.files.set('a.txt', 'changed material'); state.infer = () => { throw new Error('inference failure'); };
  await assert.rejects(engine.refreshSource(input.id), /inference failure/); assert.deepEqual(storage.snapshot, good); assert.equal((await engine.search({ mode: 'lexical', query: 'alpha' })).length, 1); await model.dispose();
}
console.log('Offline MiniLM adapter lifecycle assertions passed');
