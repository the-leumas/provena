// Opt-in real quality evaluation. Default Hub mode may use the network.
import { mkdtemp, cp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniLMEmbedder, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION } from '../dist/adapters/minilm.js';
import { evaluateRetrieval } from './retrieval-evaluation.mjs';
const cacheDir = process.env.MINILM_CACHE_DIR ?? fileURLToPath(new URL('../.cache/minilm/', import.meta.url));
const staged = process.argv.includes('--staged'); let temporary; let fetchAttempts = 0;
try {
  if (staged) {
    // Explicit host bootstrap, isolated from adapter/core, matching Alpha.3's accepted contract.
    const { env } = await import('@huggingface/transformers');
    temporary = await mkdtemp(join(tmpdir(), 'semantic-evaluation-'));
    env.localModelPath = temporary + '/'; env.allowLocalModels = true; env.allowRemoteModels = false;
    env.useFSCache = false; env.useBrowserCache = false; env.useCustomCache = false;
    await cp(process.env.MINILM_LOCAL_MODEL_DIR ?? join(cacheDir, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION), join(temporary, MINILM_DEFAULT_MODEL), { recursive: true });
    env.fetch = globalThis.fetch = async () => { fetchAttempts++; throw new Error('Network forbidden in staged evaluation'); };
  }
  const embedder = new MiniLMEmbedder({ cacheDir, localFilesOnly: staged, device: 'cpu', dtype: 'fp32' });
  try {
    const result = await evaluateRetrieval(embedder, 'REAL MiniLM CPU/fp32 semantic quality fixture');
    console.log(JSON.stringify({ ...result, loading: staged ? 'host-staged' : 'online/cached Hub', fetchAttempts: staged ? fetchAttempts : null }, null, 2));
  } finally { await embedder.dispose(); }
} finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
