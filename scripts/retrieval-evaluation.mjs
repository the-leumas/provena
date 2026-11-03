// Shared corpus and relevance judgments for deterministic mechanics and opt-in real quality evaluation.
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { SemanticSearchEngine, createSearchSession, documentKey } from '../dist/index.js';
import { collectCandidates, rankLexical, rankSemantic, fuseRrf } from '../dist/retrieval.js';
import { source, MemoryStorage } from '../tests/fixtures/lifecycle.mjs';
export async function evaluateRetrieval(model, label) {
  const fixture = JSON.parse(await readFile(new URL('../tests/fixtures/retrieval.json', import.meta.url), 'utf8'));
  const queries = [...fixture.queries, ...fixture.additionalQueries];
  let queryCalls = 0; let queryMs = 0; let lastVector;
  const embedder = { id: model.id, dimensions: model.dimensions,
    embedDocuments: (...args) => model.embedDocuments(...args),
    async embedQuery(...args) { const start = performance.now(); queryCalls++; lastVector = await model.embedQuery(...args); queryMs += performance.now() - start; return lastVector; },
  };
  const storage = new MemoryStorage(); const engine = new SemanticSearchEngine({ embedder, storage });
  engine.addSource(source('fixture', fixture.documents));
  let start = performance.now(); const [report] = await engine.initialize(); const indexingMs = performance.now() - start;
  const records = new Map(storage.snapshot.documents.map(catalog => [documentKey(catalog.sourceId, catalog.documentId), { catalog, chunks: [] }]));
  const vectors = new Map();
  for (const { vector, ...chunk } of storage.snapshot.chunks) {
    records.get(documentKey(chunk.sourceId, chunk.documentId)).chunks.push(chunk); vectors.set(chunk.id, new Float32Array(vector));
  }
  const candidates = collectCandidates(records.values(), vectors, {});
  const modes = {};
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    const results = []; const before = queryCalls; const embeddingBefore = queryMs;
    let elapsed = 0; let cosineMs = 0; let fusionMs = 0;
    for (const entry of queries) {
      start = performance.now(); const hits = await engine.search({ query: entry.query, mode, limit: 10 }); const totalMs = performance.now() - start; elapsed += totalMs;
      const recall = limit => entry.relevant.filter(id => hits.slice(0, limit).some(hit => hit.documentId === id)).length / entry.relevant.length;
      results.push({ query: entry.query, relevant: entry.relevant, top5: hits.slice(0, 5).map(hit => hit.documentId), recallAt5: recall(5), recallAt10: recall(10), totalMs });
      if (mode !== 'lexical') {
        // Independent component measurements reuse the just-produced query vector: no extra inference.
        start = performance.now(); const semantic = rankSemantic(candidates, lastVector, model.dimensions); cosineMs += performance.now() - start;
        if (mode === 'hybrid') {
          const lexical = rankLexical(candidates, entry.query);
          start = performance.now(); fuseRrf(lexical, semantic); fusionMs += performance.now() - start;
        }
      }
    }
    const average = (rows, key) => rows.reduce((sum, row) => sum + row[key], 0) / rows.length;
    modes[mode] = { recallAt5: average(results, 'recallAt5'), recallAt10: average(results, 'recallAt10'),
      originalSixRecallAt5: average(results.slice(0, fixture.queries.length), 'recallAt5'), originalSixRecallAt10: average(results.slice(0, fixture.queries.length), 'recallAt10'),
      meanSearchMs: elapsed / queries.length, meanQueryEmbeddingMs: (queryMs - embeddingBefore) / queries.length,
      meanCosineComponentMs: cosineMs / queries.length, meanFusionComponentMs: fusionMs / queries.length,
      queryEmbeddingCalls: queryCalls - before, results };
  }
  const run = createSearchSession(engine); const before = queryCalls;
  await run.search({ query: queries[0].query }); await run.search({ query: queries[0].query });
  return { label, modelId: model.id, dimensions: model.dimensions, documents: report.documents, candidateCount: candidates.length,
    queries: queries.length, indexingMs, snapshotBytes: new TextEncoder().encode(JSON.stringify(storage.snapshot)).byteLength,
    modes, duplicateQueriesAvoided: run.stats.hits, cachedPairQueryEmbeddingCalls: queryCalls - before,
    note: 'Same 8-document corpus across modes. Recall is document-level presence among ranked chunks. Recall@10 saturates for the full semantic channel on this tiny corpus; no quality guarantee. Component timings are independent reruns without inference, not subtractions from total latency. No performance thresholds.' };
}
