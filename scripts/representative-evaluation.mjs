import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { cpus, platform, arch } from 'node:os';
import { SemanticSearchEngine, documentKey } from '../dist/index.js';
import { collectCandidates, rankLexical, rankSemantic, fuseRrf } from '../dist/retrieval.js';
import { source, MemoryStorage } from '../tests/fixtures/lifecycle.mjs';
import { metrics, average, distribution, cosine, uniqueDocuments } from './evaluation/metrics.mjs';
import { evaluationModel } from './evaluation/model.mjs';
const corpusText = await readFile(new URL('../tests/fixtures/representative/corpus.json', import.meta.url), 'utf8');
const queryText = await readFile(new URL('../tests/fixtures/representative/queries.json', import.meta.url), 'utf8');
const corpus = JSON.parse(corpusText);
const { queries } = JSON.parse(queryText);
const real = process.argv.includes('--minilm');
const runtime = await evaluationModel(real, process.argv.includes('--staged'));
try {
    const { model } = runtime;
    let queryMs = 0, queryCalls = 0, lastVector;
    const embedder = { id: model.id, dimensions: model.dimensions, embedDocuments: (...args) => model.embedDocuments(...args), async embedQuery(...args) { const start = performance.now(); lastVector = await model.embedQuery(...args); queryMs += performance.now() - start; queryCalls++; return lastVector; } };
    const storage = new MemoryStorage();
    const engine = new SemanticSearchEngine({ embedder, storage });
    engine.addSource(source('handbook', corpus.documents));
    let start = performance.now();
    const [index] = await engine.initialize();
    const indexingMs = performance.now() - start;
    const records = new Map(storage.snapshot.documents.map(catalog => [documentKey(catalog.sourceId, catalog.documentId), { catalog, chunks: [] }]));
    const vectors = new Map();
    for (const { vector, ...chunk } of storage.snapshot.chunks) {
        records.get(documentKey(chunk.sourceId, chunk.documentId)).chunks.push(chunk);
        vectors.set(chunk.id, new Float32Array(vector));
    }
    const candidates = collectCandidates(records.values(), vectors, {});
    const modes = {};
    const similarities = [];
    for (const mode of ['lexical', 'semantic', 'hybrid']) {
        const rows = [];
        const timing = [];
        const embeddingTiming = [];
        const cosineTiming = [];
        const fusionTiming = [];
        const postEmbeddingTiming = [];
        const before = queryCalls;
        // Warm every strategy before timed runs; no cache is involved.
        await engine.search({ query: queries[0].query, mode, limit: 100 });
        for (const entry of queries) {
            let hits;
            for (let repeat = 0; repeat < 3; repeat++) {
                const beforeMs = queryMs;
                start = performance.now();
                hits = await engine.search({ query: entry.query, mode, limit: 100 });
                timing.push(performance.now() - start);
                embeddingTiming.push(queryMs - beforeMs);
            }
            let topCosine = null;
            if (mode !== 'lexical') {
                start = performance.now();
                const semantic = rankSemantic(candidates, lastVector, model.dimensions);
                cosineTiming.push(performance.now() - start);
                if (mode === 'semantic')
                    postEmbeddingTiming.push(cosineTiming.at(-1));
                if (mode === 'hybrid') {
                    start = performance.now();
                    const lexical = rankLexical(candidates, entry.query);
                    const lexicalMs = performance.now() - start;
                    start = performance.now();
                    fuseRrf(lexical, semantic);
                    const fusionMs = performance.now() - start;
                    fusionTiming.push(fusionMs);
                    postEmbeddingTiming.push(lexicalMs + cosineTiming.at(-1) + fusionMs);
                }
                topCosine = cosine(semantic[0].vector, lastVector);
                if (mode === 'semantic')
                    similarities.push({ id: entry.id, class: entry.class, query: entry.query, answerable: Object.keys(entry.relevance).length > 0, topCosine, topDocument: semantic[0].chunk.documentId });
            }
            const unique = uniqueDocuments(hits);
            const rawCoverage = Object.fromEntries([5, 10].map(k => { const selected = new Set(hits.slice(0, k).map(h => h.documentId)); const relevant = Object.keys(entry.relevance); return ['rawRecallAt' + k, relevant.length ? relevant.filter(id => selected.has(id)).length / relevant.length : null]; }));
            rows.push({ id: entry.id, class: entry.class, query: entry.query, ...metrics(hits, entry.relevance), ...rawCoverage, topCosine,
                top10: unique.slice(0, 10), rawTop10: hits.slice(0, 10).map(h => ({ documentId: h.documentId, chunkId: h.chunkId, heading: h.heading, lexicalRank: h.lexicalRank, semanticRank: h.semanticRank, combinedRank: h.combinedRank })),
                duplicateChunksInRawTop10: 10 - new Set(hits.slice(0, 10).map(h => h.documentId)).size - (10 - Math.min(10, hits.length)) });
        }
        const byClass = {};
        for (const cls of new Set(queries.map(q => q.class))) {
            const selected = rows.filter(r => r.class === cls);
            byClass[cls] = { ...average(selected), count: selected.length, nonemptyResultRate: selected.filter(r => r.returnedDocuments > 0).length / selected.length };
        }
        modes[mode] = { answerable: average(rows.filter(r => !['negative', 'near-miss'].includes(r.class))), byClass, queryEmbeddingCalls: queryCalls - before,
            timing: { totalMs: distribution(timing), queryEmbeddingMs: distribution(embeddingTiming), cosineComponentMs: distribution(cosineTiming), fusionComponentMs: distribution(fusionTiming), rankingAfterEmbeddingMs: distribution(postEmbeddingTiming) }, rows };
    }
    const result = { schema: 1, date: new Date().toISOString(), environment: { node: process.version, cpu: cpus()[0].model, platform: platform(), arch: arch() },
        fixtureHash: createHash('sha256').update(corpusText).update(queryText).digest('hex'), documents: index.documents, chunks: index.chunks, queries: queries.length, dimensions: model.dimensions, modelId: model.id, indexingMs,
        loading: runtime.observations, modes, similarities, topScoreDistributions: Object.fromEntries(['answerable', 'negative', 'near-miss'].map(kind => [kind, distribution(similarities.filter(row => kind === 'answerable' ? row.answerable : row.class === kind).map(row => row.topCosine))])),
        note: 'Document judgments, first-occurrence deduplication before metric cutoffs; raw top-10 chunks also retained. P@K denominator K, unfilled slots zero. Recall/nDCG/MRR undefined (null) for no-answer. Full ranking MRR within this <=100-chunk corpus. Three warm repeats; component reruns exclude inference and public-result construction. No confidence threshold or ranking tuning.' };
    const out = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
    if (out)
        await writeFile(out, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ ...result, modes: Object.fromEntries(Object.entries(modes).map(([k, v]) => [k, { ...v, rows: undefined }])), similarities: undefined }, null, 2));
}
finally {
    await runtime.dispose();
}
