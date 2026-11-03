// Explicit scale characterization, not part of ordinary npm test/benchmark.
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cpus, totalmem, platform, arch } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { SemanticSearchEngine, ParserRegistry, chunkDocument, catalogEntry } from '../dist/index.js';
import { rankLexical, rankSemantic, fuseRrf } from '../dist/retrieval.js';
import { distribution } from './evaluation/metrics.mjs';
const sizeArg = process.argv.find(arg => arg.startsWith('--size='));
if (!sizeArg) {
    const sizes = process.argv.includes('--quick') ? [1000] : [1000, 10000, 50000, 100000];
    const results = [];
    for (const size of sizes) {
        const result = await new Promise((resolve, reject) => { const child = fork(fileURLToPath(import.meta.url), [`--size=${size}`], { execArgv: ['--expose-gc'], stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }); let report; child.on('message', value => { report = value; }); child.on('error', reject); child.on('exit', code => code === 0 && report ? resolve(report) : reject(new Error(`Scale child ${size} exited ${code}`))); });
        results.push(result);
        console.log(JSON.stringify(result));
    }
    const out = process.argv.find(arg => arg.startsWith('--output='))?.slice(9);
    if (out)
        await writeFile(out, JSON.stringify({ schema: 1, results }, null, 2) + '\n');
}
else {
    const size = Number(sizeArg.slice(7));
    const dimensions = 384;
    const generated = new Map();
    const vectorFor = seed => { const v = new Float32Array(dimensions); let state = seed + 1; for (let i = 0; i < dimensions; i++) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        v[i] = state / 2 ** 31 - 1;
    } return v; };
    const textFor = i => `Record ${i} discusses topic${i % 97} indexing and operational evidence.`;
    const docFor = i => ({ id: `${i}.txt`, name: `${i}.txt`, path: `${i}.txt`, sourceId: 'scale', uri: `memory:scale/${i}` });
    const model = { id: 'scale-lcg-v1', dimensions, async embedDocuments(texts) { return texts.map(text => { const v = vectorFor(Number(text.split(' ')[1])); generated.set(text, v); return v; }); }, async embedQuery() { return vectorFor(42); } };
    globalThis.gc?.();
    const before = process.memoryUsage();
    const start = performance.now();
    const engine = new SemanticSearchEngine({ embedder: model });
    engine.addSource({ id: 'scale', type: 'synthetic', async list() { return Array.from({ length: size }, (_, i) => docFor(i)); }, async read(id) { return { text: textFor(Number(id.split('.')[0])) }; } });
    const [index] = await engine.initialize();
    const indexingMs = performance.now() - start;
    // Independent internal component fixture with matching catalog/chunk content and adapter vectors.
    const candidates = [];
    const parser = new ParserRegistry();
    for (let i = 0; i < size; i++) {
        const parsed = await parser.parse(docFor(i), { text: textFor(i) });
        const record = { catalog: catalogEntry(parsed), chunks: chunkDocument(parsed) };
        candidates.push({ record, chunk: record.chunks[0], vector: generated.get(textFor(i)) });
    }
    globalThis.gc?.();
    const after = process.memoryUsage();
    const modes = {};
    const query = 'topic42 indexing';
    const queryVector = vectorFor(42);
    for (const mode of ['lexical', 'semantic', 'hybrid']) {
        const totals = [], lexicalTimes = [], cosineTimes = [], fusionTimes = [];
        for (let run = 0; run < 7; run++) {
            let t = performance.now();
            const hits = await engine.search({ query, mode, limit: 10 });
            const total = performance.now() - t;
            if (hits.length !== 10)
                throw new Error('Incomplete scale search');
            t = performance.now();
            const lex = mode !== 'semantic' ? rankLexical(candidates, query) : [];
            const lexMs = performance.now() - t;
            t = performance.now();
            const sem = mode !== 'lexical' ? rankSemantic(candidates, queryVector, dimensions) : [];
            const cosineMs = performance.now() - t;
            t = performance.now();
            if (mode === 'hybrid')
                fuseRrf(lex, sem);
            const fusionMs = performance.now() - t;
            if (run >= 2) {
                totals.push(total);
                lexicalTimes.push(mode === 'semantic' ? 0 : lexMs);
                cosineTimes.push(mode === 'lexical' ? 0 : cosineMs);
                fusionTimes.push(mode === 'hybrid' ? fusionMs : 0);
            }
        }
        modes[mode] = { totalMs: distribution(totals), lexicalComponentMs: distribution(lexicalTimes), cosineComponentMs: distribution(cosineTimes), fusionComponentMs: distribution(fusionTimes) };
    }
    process.send({ schema: 1, date: new Date().toISOString(), environment: { node: process.version, cpu: cpus()[0].model, platform: platform(), arch: arch(), totalMemoryBytes: totalmem() }, candidateCount: index.chunks, dimensions, indexingMs, modes,
        memory: { rssGrowthBytes: after.rss - before.rss, heapGrowthBytes: after.heapUsed - before.heapUsed, arrayBufferGrowthBytes: after.arrayBuffers - before.arrayBuffers, processPeakRssBytes: process.resourceUsage().maxRSS * 1024 },
        note: 'Isolated process per size; 2 warmups plus 5 measured runs. Public engine total includes filtering/ranking/result construction; components are independent reruns. Memory includes engine plus component fixture and two vector copies, not core-only allocation or a memory guarantee. Synthetic vectors, no model inference.' });
}
