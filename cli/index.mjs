// CLI persistence policy; the library owns snapshot validation and atomic writes.
import { basename, dirname, resolve } from 'node:path';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CHUNKER_VERSION, EMBEDDING_INPUT_VERSION } from '@theleumas/provena';
import { FileIndexStorage } from '@theleumas/provena/filesystem';

// Canonicalize existing ancestors too, so two missing files under a symlinked
// directory cannot bypass collision checks or the self-index exclusion.
async function canonicalPath(path) {
  try { return await realpath(path); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return resolve(await canonicalPath(dirname(path)), basename(path));
  }
}

export async function indexStore(options, root, timings, progress) {
  if (options.noIndex) return null;
  const automatic = options.saveIndexBase === undefined && !options.indexLocation;
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('Source must be a directory');
  const name = basename(canonicalRoot).replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 60) || 'source';
  const hash = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 12);
  const path = await canonicalPath(options.indexLocation ?? resolve(options.saveIndexBase ?? process.cwd(), '.provena-indexes', `${name}-${hash}`, 'index.json'));
  if (automatic) {
    try { await stat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  const disk = new FileIndexStorage(path);
  const info = { path, sourceRoot: canonicalRoot, automatic, state: 'new', rebuildReasons: [], saved: false };
  let files;
  return { info, get files() { return files; },
    excludes(document) {
      return document.id.split('/').includes('.provena-indexes') || resolve(canonicalRoot, document.id) === path || resolve(canonicalRoot, document.id).startsWith(path + '.embeddings-');
    },
    async load(parsers, embedder, operation) {
      progress({ phase: 'index-load' });
      const at = performance.now();
      let snapshot;
      try { snapshot = await disk.load(operation); } finally { timings.indexLoadMs += performance.now() - at; }
      if (!snapshot) {
        if (options.indexLocation || automatic) throw new Error('Selected location must contain an existing CLI index');
        return null;
      }
      if (snapshot.cliSource?.version !== 1 || snapshot.cliSource.root !== canonicalRoot) {
        throw new Error('Index source binding is missing or belongs to a different source directory; use --save-index to create an index for this source');
      }
      const preserveEmbeddedSnapshot = !embedder && Boolean(snapshot.embedding);
      if (preserveEmbeddedSnapshot) {
        info.preservedEmbedding = true;
        progress({ phase: 'index-preserved', message: 'Saved semantic vectors are preserved; lexical indexing uses an in-memory snapshot.' });
      }
      // Diagnostic comparison only. The engine independently decides reuse and
      // validates passage and vector compatibility independently.
      const expected = { schemaVersion: 3, parserVersion: JSON.stringify([parsers.version, parsers.fileTypes.definitions]),
        chunkerVersion: CHUNKER_VERSION, embeddingInputVersion: EMBEDDING_INPUT_VERSION,
        chunking: { targetChars: 1600, overlapLines: 2 },
        embedding: embedder ? { id: embedder.id, dimensions: embedder.dimensions } : undefined };
      info.rebuildReasons = Object.keys(expected).filter(key => JSON.stringify(snapshot[key]) !== JSON.stringify(expected[key]));
      info.state = info.rebuildReasons.length ? 'rebuilt' : 'loaded';
      if (info.rebuildReasons.length && !preserveEmbeddedSnapshot) {
        progress({ phase: 'index-rebuild', message: !snapshot.embedding && embedder
          ? 'The saved index has no embedding vectors. Semantic indexing must create them once.'
          : `Saved index compatibility changed: ${info.rebuildReasons.join(', ')}. Rechecking passages; matching compatible vectors will be reused.` });
      }
      if (snapshot.cliFiles !== undefined) {
        if (snapshot.cliFiles.version !== 1 || !Array.isArray(snapshot.cliFiles.files)) throw new Error('Corrupt CLI verification manifest');
        files = new Map();
        for (const file of snapshot.cliFiles.files) {
          if (!file || typeof file.path !== 'string' || files.has(file.path) || !/^[a-f0-9]{64}$/.test(file.contentHash) ||
            typeof file.parser !== 'string' || typeof file.language !== 'string' || !Number.isSafeInteger(file.normalizedBytes) || file.normalizedBytes < 0 ||
            !Number.isSafeInteger(file.passages) || file.passages < 0) throw new Error('Corrupt CLI verification manifest');
          files.set(file.path, file);
        }
        if (snapshot.documents.some(doc => !files.has(doc.documentId)) || files.size !== snapshot.documents.length) throw new Error('Incomplete CLI verification manifest');
      }
      return snapshot;
    },
    async save(snapshot, operation) {
      progress({ phase: 'index-save' });
      const at = performance.now();
      try {
        await mkdir(dirname(path), { recursive: true });
        await disk.save({ ...snapshot, cliSource: { version: 1, root: canonicalRoot } }, operation);
        info.saved = true;
      } finally { timings.indexSaveMs += performance.now() - at; }
    },
  };
}
