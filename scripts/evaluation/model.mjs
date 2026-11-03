// Evaluation host configuration only. No environment changes inside the production adapter/core.
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { MiniLMEmbedder, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION } from '../../dist/adapters/minilm.js';
export async function evaluationModel(real = false, staged = false) {
    if (!real) {
        const encode = text => { const v = new Float32Array(32); for (const char of text.toLowerCase())
            v[char.codePointAt(0) % 32]++; if (!v.some(Boolean))
            v[0] = 1; return v; };
        return { model: { id: 'test-character-bins-v1', dimensions: 32, async embedDocuments(texts) { return texts.map(encode); }, async embedQuery(text) { return encode(text); } },
            observations: { kind: 'deterministic mechanics only, not semantic quality' }, async dispose() { } };
    }
    const cacheDir = process.env.MINILM_CACHE_DIR ?? fileURLToPath(new URL('../../.cache/minilm/', import.meta.url));
    let temporary;
    let model;
    const observations = { kind: 'real MiniLM', loading: staged ? 'host-staged' : 'online/cached Hub', fetchAttempts: staged ? 0 : null };
    try {
        if (staged) {
            const { env } = await import('@huggingface/transformers');
            temporary = await mkdtemp(join(tmpdir(), 'semantic-model-'));
            env.localModelPath = temporary + '/';
            env.allowLocalModels = true;
            env.allowRemoteModels = false;
            env.useFSCache = false;
            env.useBrowserCache = false;
            env.useCustomCache = false;
            await cp(process.env.MINILM_LOCAL_MODEL_DIR ?? join(cacheDir, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION), join(temporary, MINILM_DEFAULT_MODEL), { recursive: true });
            env.fetch = globalThis.fetch = async () => { observations.fetchAttempts++; throw new Error('Remote access forbidden in staged evaluation'); };
        }
        let started;
        model = new MiniLMEmbedder({ cacheDir, localFilesOnly: staged, onProgress(event) { if (event.status === 'ready')
                observations.coldLoadThroughReadyMs = performance.now() - started; } });
        started = performance.now();
        await model.embedQuery('evaluation warmup');
        observations.firstInferenceMs = performance.now() - started;
        return { model, observations, async dispose() { try {
                await model.dispose();
            }
            finally {
                if (temporary)
                    await rm(temporary, { recursive: true, force: true });
            } } };
    }
    catch (error) {
        await model?.dispose();
        if (temporary)
            await rm(temporary, { recursive: true, force: true });
        throw error;
    }
}
