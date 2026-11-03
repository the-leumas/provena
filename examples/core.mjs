import { SemanticSearchEngine, createSearchSession } from '@theleumas/provena';
import { retrieveUnassessedEvidence } from './evidence.mjs';
/** A minimal host source. Replace its read/list methods with your authorized content APIs. */
export function memorySource(files, id = 'example') {
    return { id, type: 'memory',
        async list(options = {}) { options.signal?.throwIfAborted(); return [...files.keys()].map(path => ({ id: path, sourceId: id, name: path, path, uri: `memory://${id}/${path}` })); },
        async read(id, options = {}) { options.signal?.throwIfAborted(); if (!files.has(id))
            throw new Error('Document unavailable'); return { text: files.get(id) }; },
    };
}
/** Test/example storage only: no browser database or durable production adapter is implied. */
export function memoryStorage() {
    let snapshot = null;
    return { async load(options = {}) { options.signal?.throwIfAborted(); return structuredClone(snapshot); },
        async save(candidate, options = {}) { options.signal?.throwIfAborted(); const next = structuredClone(candidate); snapshot = next; } };
}
/** Toy vectors demonstrate injection only. Substitute your real text embedder in applications. */
export function demonstrationEmbedder() {
    const stats = { documents: 0, queries: 0 };
    const encode = text => new Float32Array(/password|credential|login/i.test(text) ? [2, 0] : [0, 3]);
    return { id: 'example-two-topics-v1', dimensions: 2, stats,
        async embedDocuments(texts, options = {}) { options.signal?.throwIfAborted(); stats.documents += texts.length; return texts.map(encode); },
        async embedQuery(text, options = {}) { options.signal?.throwIfAborted(); stats.queries++; return encode(text); } };
}
export async function exerciseCore() {
    const source = memorySource(new Map([['account.txt', 'Recover a lost password'], ['garden.txt', 'Water plants at dawn']]));
    const lexical = new SemanticSearchEngine();
    lexical.addSource(source);
    await lexical.initialize();
    const evidence = await retrieveUnassessedEvidence(lexical, { query: 'password' });
    if (evidence.answerability !== 'not-assessed' || evidence.retrieval !== 'retrieved' || evidence.candidates[0]?.path !== 'account.txt')
        throw new Error('Lexical example failed');
    const storage = memoryStorage();
    const embedder = demonstrationEmbedder();
    for (let restart = 0; restart < 2; restart++) {
        const engine = new SemanticSearchEngine({ storage, embedder });
        engine.addSource(source);
        await engine.initialize();
        for (const mode of ['semantic', 'hybrid']) {
            const run = createSearchSession(engine);
            const request = { query: 'credentials', mode };
            const hit = (await run.search(request))[0];
            if (hit?.path !== 'account.txt' || hit.semanticRank !== 1 || !hit.uri || !hit.chunkId)
                throw new Error('Rank/provenance example failed');
            await run.search(request);
            if (run.stats.hits !== 1)
                throw new Error('Cache example failed');
        }
    }
    if (embedder.stats.documents !== 2 || embedder.stats.queries !== 4)
        throw new Error('Restart/query reuse example failed');
    return { lexical: true, semantic: true, hybrid: true, restart: true, ...embedder.stats };
}
