// Stateful repository runtime. All retrieval and atomic snapshots belong to the library.
import { readFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { SemanticSearchEngine, ParserRegistry, createSearchSession, CHUNKER_VERSION, EMBEDDING_INPUT_VERSION } from '@theleumas/provena';
import { FileSystemFolderSource } from '@theleumas/provena/filesystem';
import { selectExcerpt, cachedModelDirectory, normalize } from './format.mjs';
import { indexStore } from './index.mjs';
const project = fileURLToPath(new URL('..', import.meta.url));
const digest = text => createHash('sha256').update(text).digest('hex');
const freshTimings = () => ({ scanAdmissionMs: 0, readMs: 0, parsingMs: 0, chunkingMs: null,
  embeddingMs: 0, modelLoadMs: 0, indexLoadMs: 0, indexSaveMs: 0, indexingMs: 0, verificationMs: 0, totalMs: 0 });

export function createModelManager() {
  let resource; let disposal; let notify = () => {}; let restore;
  return {
    async acquire(options, progress) {
      if (disposal) throw new Error('Model manager is disposed');
      notify = progress;
      if (resource) return resource;
      progress({ phase: 'runtime' });
      if (options.embedder === 'ollama') {
        const { OllamaEmbedder, OLLAMA_DEFAULT_URL } = await import('./ollama.mjs');
        const embedder = new OllamaEmbedder({
          url: options.ollamaUrl ?? OLLAMA_DEFAULT_URL,
          model: options.ollamaModel,
        });
        // Probe dimensions upfront so the engine's embedder contract (dimensions >= 1) is satisfied.
        // This also confirms the server is reachable and the model is available before indexing starts.
        try { await embedder.embedDocuments([''], {}); } catch (cause) {
          throw new Error(`Ollama connection failed for model "${options.ollamaModel}": ${cause.message}`, { cause });
        }
        // id and dimensions are lazily resolved after first embed; use getters so
        // record() sees the post-inference values.
        const modelMeta = { name: `ollama:${options.ollamaModel}`, revision: null, device: 'remote', dtype: null, loading: 'ollama' };
        Object.defineProperties(modelMeta, {
          id: { get: () => embedder.id, enumerable: true },
          dimensions: { get: () => embedder.dimensions, enumerable: true },
        });
        resource = { embedder, model: modelMeta };
        progress({ phase: 'model-ready' });
        return resource;
      }
      const { MiniLMEmbedder, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION } = await import('@theleumas/provena/minilm');
      const modelDir = options.modelDir ?? await cachedModelDirectory(options.cacheDir, MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION);
      if (modelDir) {
        const { env } = await import('@huggingface/transformers');
        const previous = { allowLocalModels: env.allowLocalModels, allowRemoteModels: env.allowRemoteModels };
        restore = () => Object.assign(env, previous);
        env.allowLocalModels = true; env.allowRemoteModels = false;
      }
      const embedder = new MiniLMEmbedder({ cacheDir: options.cacheDir, device: 'cpu', dtype: 'fp32',
        ...(modelDir ? { model: modelDir, revision: MINILM_DEFAULT_REVISION, localFilesOnly: true } : {}),
        onProgress(event) { notify(event.status === 'ready' ? { phase: 'model-ready' } :
          { phase: 'model', file: event.file, percent: Number.isFinite(event.progress) ? Math.max(0, Math.min(100, event.progress)) : undefined }); },
      });
      resource = { embedder, model: {
        id: options.modelDir ? embedder.id : new MiniLMEmbedder({ device: 'cpu', dtype: 'fp32' }).id,
        name: MINILM_DEFAULT_MODEL, revision: MINILM_DEFAULT_REVISION, dimensions: embedder.dimensions,
        device: 'cpu', dtype: 'fp32', loading: options.modelDir ? 'host-staged' : modelDir ? 'cached-local' : 'hub',
      } };
      return resource;
    },
    listen(progress) { notify = progress; },
    dispose() {
      disposal ??= (async () => { try { await resource?.embedder.dispose?.(); } finally { restore?.(); restore = undefined; resource = undefined; notify = () => {}; } })();
      return disposal;
    },
  };
}

export async function createRuntime(options, progress = () => {}, { manager, excludedPaths = [] } = {}) {
  const owned = !manager; manager ??= createModelManager();
  let timings = freshTimings(); let firstEmbeddingAt; let embeddingState; let embeddingStartedAt;
  const modelProgress = event => {
    if (event.phase === 'model-ready') {
      embeddingStartedAt = performance.now();
      timings.modelLoadMs += firstEmbeddingAt === undefined ? 0 : performance.now() - firstEmbeddingAt;
      progress(embeddingState ?? { phase: 'search' });
    } else progress(event);
  };
  let resource;
  try {
    const persisted = await indexStore(options, options.root, timings, progress);
    if (options.mode !== 'lexical' || options.compare) resource = await manager.acquire(options, modelProgress);
    const model = resource?.model ?? null;
    const sourceRoot = persisted?.info.sourceRoot ?? await realpath(options.root);
    const folder = new FileSystemFolderSource({ id: 'project', root: sourceRoot });
    let files = new Map(); let committedStats; let staged; let completed = 0; let total = 0; let parsedCount = 0; let excluded = 0; let passages = 0; let checked = 0; let reused = 0;
    const exclusions = new Set(excludedPaths.map(path => resolve(path)));
    const source = { id: folder.id, type: folder.type,
      async list(operation) {
        progress({ phase: 'scan' });
        const at = performance.now(); const listed = await folder.list(operation);
        const documents = listed.filter(document => !document.id.split('/').includes('.provena-indexes') &&
          !persisted?.excludes(document) && !exclusions.has(resolve(sourceRoot, document.id)));
        excluded = listed.length - documents.length; total = documents.length;
        timings.scanAdmissionMs += performance.now() - at;
        progress({ phase: 'read', completed, total }); return documents;
      },
      async read(id, operation) {
        const at = performance.now(); const content = await folder.read(id, operation);
        timings.readMs += performance.now() - at;
        const text = normalize(content.text);
        staged.set(id, { path: id, contentHash: digest(text), normalizedBytes: Buffer.byteLength(text), passages: 0 });
        progress({ phase: 'read', completed: ++completed, total }); return content;
      },
    };
    const parsers = new ParserRegistry(); const parse = parsers.parse.bind(parsers);
    parsers.parse = async (document, content) => {
      const at = performance.now(); const parsed = await parse(document, content);
      timings.parsingMs += performance.now() - at;

      Object.assign(staged.get(document.id), { parser: parsed.parserId, language: parsed.language ?? 'text' });
      parsedCount++; return parsed;
    };
    let queryEmbeddingMs = 0;
    const observed = resource ? { id: model.id, dimensions: resource.embedder.dimensions,
      async embedDocuments(texts, operation) {
        const at = performance.now(); firstEmbeddingAt ??= at; const vectors = Array(texts.length);
        embeddingStartedAt = at;
        const pending = [];
        texts.forEach((text, i) => { pending.push(i); });
        let completed = texts.length - pending.length;
        const state = () => ({ phase: 'embed', completed, total: texts.length, recovered: 0,
          freshCompleted: completed - (texts.length - pending.length), embeddingStartedAt, });
        embeddingState = state(); progress(embeddingState);
        for (let start = 0; start < pending.length; start += 4) {
          operation.signal?.throwIfAborted();
          const batch = pending.slice(start, start + 4); const inputs = batch.map(i => texts[i]);
          const output = await resource.embedder.embedDocuments(inputs, operation);
          // Persist successful batches before publishing progress. A cancelled
          // refresh never exposes an incomplete searchable index.
          batch.forEach((i, j) => { vectors[i] = output[j]; }); completed += batch.length;
          embeddingState = state(); progress(embeddingState);
        }
        operation.signal?.throwIfAborted();
        timings.embeddingMs += performance.now() - at; return vectors;
      },
      async embedQuery(text, operation) {
        const at = performance.now(); firstEmbeddingAt ??= at;
        const vector = await resource.embedder.embedQuery(text, operation);
        queryEmbeddingMs += performance.now() - at; return vector;
      },
    } : undefined;
    const configuration = { parserVersion: JSON.stringify([parsers.version, parsers.fileTypes.definitions]), chunkerVersion: CHUNKER_VERSION,
      embeddingInputVersion: EMBEDDING_INPUT_VERSION, chunking: { targetChars: 1600, overlapLines: 2 } };
    let report; let indexed = false;
    const storage = {
      async load(operation) {
        const snapshot = persisted ? await persisted.load(parsers, observed, operation) : null;
        if (snapshot) {
          files = persisted.files ?? new Map();
          // Older CLI indexes lack the full-file hashes needed to verify displayed evidence.
          if (!persisted.files) delete snapshot.documentRevisions;
        }
        return snapshot;
      },
      async save(snapshot, operation) {
        if (persisted) await persisted.save({ ...snapshot, cliFiles: { version: 1, files: [...staged.values()] } }, operation);
      },
    };
    const engine = new SemanticSearchEngine({ parsers, ...(persisted ? { storage } : {}), ...(observed ? { embedder: observed } : {}) });
    engine.addSource(source); const session = createSearchSession(engine);
    const runtime = {
      engine, setProgress(next) { progress = next; manager.listen(modelProgress); }, hasEmbeddings: Boolean(observed), get ready() { return indexed; }, get report() { return report; },
      async refresh(operation = {}) {
        operation.signal?.throwIfAborted();
        // Keep committed observations alongside the engine's committed snapshot.
        staged = new Map(); completed = 0; parsedCount = 0; passages = 0; checked = 0; reused = 0;
        const at = performance.now();
        manager.listen(modelProgress);
        const nextReport = await engine.refreshSource(source.id, {
          ...operation, verifyContent: operation.verifyContent ?? (options.verifyContent),
          onDocument(event) {
            checked = event.completed;
            if (event.disposition === 'reused') {
              const file = files.get(event.documentId);
              if (!file) throw new Error('Missing verification record; refresh with --verify-content');
              staged.set(event.documentId, { ...file }); reused++;
            }
            staged.get(event.documentId).passages = event.passages; passages += event.passages;
            progress({ phase: event.disposition === 'reused' ? 'check' : 'parse', completed: checked, total,
              filesChecked: checked, filesRead: completed, filesTotal: total, filesReused: reused, parsedDocuments: parsedCount, passages });
            operation.onDocument?.(event);
          },
        });
        files = staged; report = nextReport; indexed = true; committedStats = { total, parsedCount, excluded };
        timings.indexingMs += performance.now() - at;
        progress({ phase: 'chunk', completed: report.chunks });
        if (persisted && report.persistence === 'preserved') persisted.info.state = 'preserved';
        progress({ phase: 'done', report, indexState: persisted?.info.state });
        return report;
      },
      async search(query, mode = options.mode, display = options, operation = {}) {
        if (!indexed) throw new Error('Index not ready; use /refresh');
        if (!query.trim() || query.length > 300 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(query)) throw new Error('query must contain 1–300 characters without terminal control characters');
        operation.signal?.throwIfAborted(); manager.listen(modelProgress);
        progress({ phase: 'search', queryId: 'query', mode });
        const at = performance.now(); const before = queryEmbeddingMs;
        const results = await session.search({ query, mode, limit: display.limit, ...(operation.signal ? { signal: operation.signal } : {}) });
        const searchMs = performance.now() - at; const entries = []; const verifyAt = performance.now();
        progress({ phase: 'verify', completed: 0, total: results.length });
        const verified = new Map();
        for (const result of results) {
          operation.signal?.throwIfAborted();
          let text = verified.get(result.documentId);
          if (text === undefined) {
            ({ text } = await folder.read(result.documentId, operation));
            if (digest(normalize(text)) !== files.get(result.documentId)?.contentHash) throw new Error('Source changed after indexing; use /refresh (or rerun the CLI)');
            verified.set(result.documentId, text);
          }
          entries.push({ result, excerpt: selectExcerpt(result, text, query, display.full ? Infinity : display.lines, mode) });
          progress({ phase: 'verify', completed: entries.length, total: results.length });
        }
        operation.signal?.throwIfAborted();
        const verificationMs = performance.now() - verifyAt; timings.verificationMs += verificationMs;
        return { queryId: 'query', query, mode, searchMs, queryEmbeddingMs: queryEmbeddingMs - before, verificationMs, entries };
      },
      async record(queryDefinitions, runs, started = performance.now(), display = options) {
        const manifest = [...files.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        return { version: 1, tool: 'provena-repository-search',
          libraryVersion: JSON.parse(await readFile(join(project, 'package.json'), 'utf8')).version,
          corpus: { identity: digest(JSON.stringify(manifest.map(file => [file.path, file.contentHash]))), label: options.label,
            documents: report.documents, passages: report.chunks, files: manifest },
          configuration, model, options: { modes: [...new Set(runs.map(run => run.mode))], limit: display.limit, excerptLines: display.lines, full: Boolean(display.full) },
          observations: { encounteredFiles: null, excludedFiles: null, admittedFiles: committedStats.total, parsedDocuments: committedStats.parsedCount, readDocuments: report.documentsRead, reusedDocuments: report.documentsReused,
            embeddingInputs: report.embeddedTexts, reusedVectors: report.reusedVectors, indexArtifactsExcluded: committedStats.excluded,
            persistence: persisted ? 'atomic filesystem snapshot' : 'none; in-memory snapshot observation only' },
          index: persisted?.info ?? null, timings: { ...timings, totalMs: performance.now() - started }, report, queries: queryDefinitions, runs };
      },
      async dispose() { if (owned) await manager.dispose(); },
    };
    return runtime;
  } catch (error) { if (owned) await manager.dispose(); throw error; }
}

export async function runSearch(options, progress = () => {}, operation = {}) {
  const started = performance.now();
  const queries = [{ id: 'query', query: options.query }];
  let runtime; let record;
  try {
    runtime = await createRuntime(options, progress); await runtime.refresh(operation);
    const runs = [];
    for (const query of queries) for (const mode of options.compare ? ['lexical', 'semantic', 'hybrid'] : [options.mode]) {
      runs.push({ ...await runtime.search(query.query, mode, options, operation), queryId: query.id });
    }
    record = await runtime.record(queries, runs, started);
    progress({ phase: 'done', report: runtime.report, indexState: record.index?.state });
  } finally { await runtime?.dispose(); if (record) record.timings.totalMs = performance.now() - started; }
  return record;
}
