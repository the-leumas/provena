import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SemanticSearchEngine } from '../dist/index.js';
import { source, MemoryStorage } from '../tests/fixtures/lifecycle.mjs';
import { metrics, average, cosine } from './evaluation/metrics.mjs';
import { evidenceMetrics, evidenceAverage } from './evaluation/evidence.mjs';
import { evaluationModel } from './evaluation/model.mjs';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
const corpusText = await read('../tests/fixtures/representative/corpus.json');
const queryText = await read('../tests/fixtures/representative/queries.json');
const judgmentText = await read('../tests/fixtures/evidence/judgments.json');
const judgments = JSON.parse(judgmentText);
const manifest = JSON.parse(await read('../tests/fixtures/evidence/chunks.json'));
const baseline = JSON.parse(await read('../docs/benchmarks/alpha5-retrieval.json'));
assert.equal(createHash('sha256').update(corpusText).update(queryText).digest('hex'), judgments.alpha5FixtureSha256);
const recorded = JSON.parse(queryText).queries;
const real = process.argv.includes('--minilm');
const runtime = await evaluationModel(real, process.argv.includes('--staged'));
try {
  const model = runtime.model;
  let queryVector;
  const embedder = { id: model.id, dimensions: model.dimensions,
    embedDocuments: (...args) => model.embedDocuments(...args),
    async embedQuery(...args) { queryVector = await model.embedQuery(...args); return queryVector; } };
  const storage = new MemoryStorage();
  const engine = new SemanticSearchEngine({ embedder, storage });
  engine.addSource(source('handbook', JSON.parse(corpusText).documents));
  await engine.initialize();
  const current = storage.snapshot.chunks.map(({ vector, ...chunk }) => ({ key: `${chunk.documentId}:${chunk.startLine}`, chunk }));
  assert.deepEqual(current, manifest, 'Chunk manifest changed; review judgments, do not silently remap');
  const byId = new Map(manifest.map(row => [row.chunk.id, row.key]));
  const vectors = new Map(storage.snapshot.chunks.map(chunk => [`${chunk.documentId}:${chunk.startLine}`, new Float32Array(chunk.vector)]));
  const rows = [], documentRows = { lexical: [], semantic: [], hybrid: [] };
  const traceIds = new Set(['conceptual-1', 'conceptual-3', 'exact-symbol-2', 'terminology-1', 'mixed-2', 'noisy-1', 'negative-1', 'near-miss-3', 'near-miss-4', 'multi-relevant-1', 'multi-relevant-5']);
  const traces = [];
  for (const judgment of judgments.queries) {
    const rankings = {}, scores = {}, measures = {};
    const original = recorded.find(q => q.id === judgment.id);
    assert.equal(judgment.query, original.query);
    for (const mode of ['lexical', 'semantic', 'hybrid']) {
      const hits = await engine.search({ query: judgment.query, mode, limit: 100 });
      rankings[mode] = hits.map(hit => byId.get(hit.chunkId));
      measures[mode] = evidenceMetrics(rankings[mode], judgment);
      documentRows[mode].push({ id: judgment.id, ...metrics(hits, original.relevance) });
      if (mode === 'semantic') for (const [key, vector] of vectors) scores[key] = cosine(vector, queryVector);
    }
    rows.push({ id: judgment.id, class: judgment.class, answerability: judgment.answerability, measures, rankings });
    if (traceIds.has(judgment.id)) {
      const union = new Set([...Object.keys(judgment.grades), ...Object.values(rankings).flatMap(keys => keys.slice(0, 5))]);
      traces.push({ id: judgment.id, query: judgment.query, requirement: judgment.requirement, sufficientSets: judgment.sufficientSets, answerability: judgment.answerability,
        chunks: [...union].map(key => ({ key, grade: judgment.grades[key] ?? 0, cosine: scores[key], ...Object.fromEntries(Object.entries(rankings).map(([mode, keys]) => [mode + 'Rank', keys.includes(key) ? keys.indexOf(key) + 1 : null])) })) });
    }
  }
  const modes = {};
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    const supported = rows.filter(row => row.answerability === 'supported');
    const originalAnswerable = documentRows[mode].filter(row => Object.keys(recorded.find(q => q.id === row.id).relevance).length);
    const documentMetrics = average(originalAnswerable);
    let maxRecordedMetricDelta = null;
    if (real) {
      const differences = documentRows[mode].flatMap(row => {
        const old = baseline.modes[mode].queries.find(q => q.id === row.id);
        return Object.keys(documentMetrics).map(key => row[key] === null && old[key] === null ? 0 : Math.abs(row[key] - old[key]));
      });
      maxRecordedMetricDelta = Math.max(...differences);
      if (mode === 'semantic') {
        assert.ok(maxRecordedMetricDelta < 1e-12, `semantic drifted from recorded Alpha.5 document metrics: delta ${maxRecordedMetricDelta}`);
      } else {
        // Lexical and hybrid rankings intentionally improved in Beta.1 with token-boundary matching.
        // Guard against regressions below archived Alpha.5 baseline floors.
        assert.ok(
          documentMetrics.mrr >= baseline.modes[mode].answerable.mrr - 1e-9,
          `${mode} MRR regressed below Alpha.5 baseline floor: ${documentMetrics.mrr} < ${baseline.modes[mode].answerable.mrr}`,
        );
        assert.ok(
          documentMetrics.recallAt5 >= baseline.modes[mode].answerable.recallAt5 - 1e-9,
          `${mode} Recall@5 regressed below Alpha.5 baseline floor: ${documentMetrics.recallAt5} < ${baseline.modes[mode].answerable.recallAt5}`,
        );
      }
    }
    modes[mode] = { supported: evidenceAverage(supported.map(row => row.measures[mode])), recordedDocumentMetrics: documentMetrics, maxRecordedMetricDelta,
      byClass: Object.fromEntries([...new Set(rows.map(row => row.class))].map(cls => { const selected = rows.filter(row => row.class === cls); return [cls, { ...evidenceAverage(selected.map(row => row.measures[mode])), nonemptyRate: selected.filter(row => row.measures[mode].returned > 0).length / selected.length }]; })) };
  }
  const result = { schema: 1, date: new Date().toISOString(), kind: real ? 'real MiniLM development evaluation' : 'deterministic mechanics ONLY',
    modelId: model.id, loading: runtime.observations, alpha5FixtureSha256: judgments.alpha5FixtureSha256, developmentJudgmentSha256: createHash('sha256').update(judgmentText).digest('hex'),
    documents: 64, chunks: manifest.length, queries: rows.length, supported: rows.filter(r => r.answerability === 'supported').length, unsupported: rows.filter(r => r.answerability === 'unsupported').length, underspecified: rows.filter(r => r.answerability === 'underspecified').length,
    modes, traces, rows, note: 'Development labels are authored, not independent. No production answerability classifier. No-answer/underspecified sufficiency metrics are null. OR of sufficient sets, AND within each set; multi-evidence reciprocal rank uses first completed set. Semantic engine rankings match recorded Alpha.5; lexical and hybrid rankings reflect Beta.1 token-boundary improvements guarded against baseline floors.' };
  const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
  if (output) await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, rows: undefined, traces: undefined }, null, 2));
} finally { await runtime.dispose(); }
