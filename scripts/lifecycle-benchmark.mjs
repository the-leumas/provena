import { performance } from 'node:perf_hooks';
import { SemanticSearchEngine } from '../dist/index.js';
import { source, TestEmbedder, MemoryStorage } from '../tests/fixtures/lifecycle.mjs';
const input = source(); const storage = new MemoryStorage(); const embedder = new TestEmbedder();
const engine = new SemanticSearchEngine({ storage, embedder }); engine.addSource(input);
const measurements = {};
async function measure(name, operation, model = embedder) {
  const before = model.count; const start = performance.now(); await operation();
  measurements[name] = { embeddings: model.count - before, elapsedMs: performance.now() - start };
}
await measure('initial', () => engine.initialize());
await measure('unchanged', () => engine.refreshSource(input.id));
input.files.set('b.txt', 'changed beta material'); await measure('singleChange', () => engine.refreshSource(input.id));
input.files.set('renamed.txt', input.files.get('a.txt')); input.files.delete('a.txt'); await measure('rename', () => engine.refreshSource(input.id));
const restartedEmbedder = new TestEmbedder(); const restarted = new SemanticSearchEngine({ storage, embedder: restartedEmbedder }); restarted.addSource(input);
await measure('restart', () => restarted.initialize(), restartedEmbedder);
console.log(JSON.stringify({ mode: 'lifecycle-test-embedder', measurements,
  snapshotBytes: new TextEncoder().encode(JSON.stringify(storage.snapshot)).byteLength,
  storageLoads: storage.loads, storageSaves: storage.saves,
  note: 'Deterministic test embedder and memory storage; measures lifecycle overhead, not model inference or disk performance.' }, null, 2));
