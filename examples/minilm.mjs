import { SemanticSearchEngine } from '@theleumas/provena';
import { MiniLMEmbedder } from '@theleumas/provena/minilm';
/** Run in the host's chosen process/worker. First inference may download assets. */
export async function searchWithMiniLM(source, storage, query, options = {}) {
    const embedder = new MiniLMEmbedder(options);
    try {
        const engine = new SemanticSearchEngine({ embedder, storage });
        engine.addSource(source);
        await engine.initialize();
        return await engine.search({ query, mode: 'hybrid' });
    }
    finally {
        await embedder.dispose();
    }
}
