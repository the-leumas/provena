import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { SemanticSearchEngine, createSearchSession } from '../dist/index.js';
const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/retrieval.json', import.meta.url), 'utf8'));
const files = new Map(Object.entries(fixture.documents));
const source = { id: 'fixture', type: 'memory',
  async list() { return [...files.keys()].map(path => ({ id: path, sourceId: 'fixture', name: path, path, uri: `memory://fixture/${path}` })); },
  async read(id) { return { text: files.get(id) }; },
};
const before = process.memoryUsage().heapUsed;
const engine = new SemanticSearchEngine(); engine.addSource(source);
let start = performance.now(); const [index] = await engine.initialize(); const indexingMs = performance.now() - start;
let recall5 = 0; let recall10 = 0; const latency = [];
for (const entry of fixture.queries) {
  start = performance.now(); const hits = await engine.search({ query: entry.query, limit: 10 }); latency.push(performance.now() - start);
  const recall = limit => entry.relevant.filter(id => hits.slice(0, limit).some(hit => hit.documentId === id)).length / entry.relevant.length;
  recall5 += recall(5); recall10 += recall(10);
}
files.set('garden.md', files.get('garden.md') + '\nMulch conserves water.');
start = performance.now(); const refresh = await engine.refreshSource('fixture'); const refreshMs = performance.now() - start;
const run = createSearchSession(engine); await run.search({ query: 'retrieval' }); await run.search({ query: 'retrieval' });
console.log(JSON.stringify({ mode: 'lexical', documents: index.documents, chunks: index.chunks,
  recallAt5: recall5 / fixture.queries.length, recallAt10: recall10 / fixture.queries.length,
  indexingMs, refreshMs, unchangedChunks: refresh.unchangedChunks,
  meanSearchMs: latency.reduce((a, b) => a + b, 0) / latency.length,
  heapDeltaBytes: process.memoryUsage().heapUsed - before, catalogBytes: JSON.stringify(engine.getCatalog()).length,
  persistentIndexBytes: null, duplicateQueriesAvoided: run.stats.hits,
  note: 'Small deterministic lexical fixture; no embeddings, persistent index, or live-agent quality measurement.' }, null, 2));
