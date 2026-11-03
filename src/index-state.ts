import type { CatalogEntry, Embedder, IndexedChunk, IndexSnapshot, OperationOptions } from './contracts.js';
import { documentKey } from './contracts.js';
import { CHUNKER_VERSION, contentHash } from './chunking.js';
import type { ChunkOptions } from './chunking.js';
import { embeddingTextForChunk, EMBEDDING_INPUT_VERSION } from './embedding-input.js';
import type { ParserRegistry } from './parsers/index.js';

export interface IndexedDocument { catalog: CatalogEntry; chunks: IndexedChunk[]; revision?: string; }
export type SnapshotConfiguration = Pick<IndexSnapshot, 'schemaVersion' | 'parserVersion' | 'chunkerVersion' | 'chunking' | 'embedding' | 'embeddingInputVersion'>;
export function configuration(parsers: ParserRegistry, chunking: ChunkOptions, embedder?: Embedder): SnapshotConfiguration {
  return {
    schemaVersion: 3,
    embeddingInputVersion: EMBEDDING_INPUT_VERSION,
    parserVersion: parsers.version === undefined ? '' : JSON.stringify([parsers.version, parsers.fileTypes.definitions]),
    chunkerVersion: CHUNKER_VERSION,
    chunking: { targetChars: chunking.targetChars ?? 1600, overlapLines: chunking.overlapLines ?? 2 },
    ...(embedder ? { embedding: { id: embedder.id, dimensions: embedder.dimensions } } : {}),
  };
}
const strings = (value: unknown): boolean => Array.isArray(value) && value.every(item => typeof item === 'string');
const optionalString = (value: unknown): boolean => value === undefined || typeof value === 'string';
const optionalNumber = (value: unknown): boolean => value === undefined || (typeof value === 'number' && Number.isFinite(value));
/** Passage compatibility is independent of embedding configuration. Compatible corrupt data is an explicit error. */
export function reusableSnapshot(snapshot: IndexSnapshot | null, config: SnapshotConfiguration): IndexSnapshot | null {
  if (!snapshot || !config.parserVersion || snapshot.schemaVersion !== config.schemaVersion ||
    snapshot.parserVersion !== config.parserVersion || snapshot.chunkerVersion !== config.chunkerVersion ||
    snapshot.chunking?.targetChars !== config.chunking?.targetChars || snapshot.chunking?.overlapLines !== config.chunking?.overlapLines) return null;
  const corrupt = () => { throw new Error('Corrupt index snapshot'); };
  if (!Array.isArray(snapshot.documents) || !Array.isArray(snapshot.chunks)) return corrupt();
  const documents = new Map<string, CatalogEntry>();
  for (const doc of snapshot.documents) {
    if (!doc || ![doc.sourceId, doc.documentId, doc.uri].every(value => typeof value === 'string' && value.length > 0) ||
      typeof doc.title !== 'string' || !strings(doc.tags) || !strings(doc.headings) || !strings(doc.outgoingLinks) ||
      !optionalString(doc.path) || !optionalString(doc.fileType) || !optionalNumber(doc.createdAt) || !optionalNumber(doc.modifiedAt)) return corrupt();
    const key = documentKey(doc.sourceId, doc.documentId);
    if (documents.has(key)) return corrupt();
    documents.set(key, doc);
  }
  if (snapshot.documentRevisions !== undefined) {
    if (!Array.isArray(snapshot.documentRevisions)) return corrupt();
    const revisions = new Set<string>();
    for (const entry of snapshot.documentRevisions) {
      if (!entry || typeof entry.sourceId !== 'string' || typeof entry.documentId !== 'string' ||
        typeof entry.revision !== 'string' || !entry.revision.trim()) return corrupt();
      const key = documentKey(entry.sourceId, entry.documentId);
      if (!documents.has(key) || revisions.has(key)) return corrupt();
      revisions.add(key);
    }
  }
  if (snapshot.embedding && (typeof snapshot.embedding.id !== 'string' || !snapshot.embedding.id.trim() ||
    !Number.isSafeInteger(snapshot.embedding.dimensions) || snapshot.embedding.dimensions < 1)) return corrupt();
  const ids = new Set<string>(); const occurrences = new Map<string, number>();
  for (const chunk of snapshot.chunks) {
    if (!chunk || typeof chunk.text !== 'string' || typeof chunk.contentHash !== 'string' ||
      !Number.isSafeInteger(chunk.startLine) || chunk.startLine < 1 || !Number.isSafeInteger(chunk.endLine) || chunk.endLine < chunk.startLine ||
      chunk.text.split('\n').length !== chunk.endLine - chunk.startLine + 1 || !optionalString(chunk.heading) || !optionalString(chunk.language)) return corrupt();
    const key = documentKey(chunk.sourceId, chunk.documentId); const doc = documents.get(key);
    const occurrenceKey = JSON.stringify([key, chunk.contentHash]); const occurrence = occurrences.get(occurrenceKey) ?? 0;
    occurrences.set(occurrenceKey, occurrence + 1);
    if (!doc || chunk.uri !== doc.uri || chunk.path !== doc.path || chunk.contentHash !== contentHash(chunk.text) ||
      chunk.id !== JSON.stringify([key, chunk.contentHash, occurrence]) || ids.has(chunk.id)) return corrupt();
    ids.add(chunk.id);
    if (snapshot.embedding) {
      if (!Array.isArray(chunk.vector) || chunk.vector.length !== snapshot.embedding.dimensions ||
        !chunk.vector.every(value => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(Math.fround(value)))) return corrupt();
    } else if (chunk.vector !== undefined) return corrupt();
  }
  return structuredClone(snapshot);
}
/** Rebuilding passages does not invalidate vectors for identical model inputs. */
export function reusableEmbeddingSnapshot(snapshot: IndexSnapshot | null, config: SnapshotConfiguration): IndexSnapshot | null {
  if (!snapshot?.embedding || !snapshot.chunking || !config.parserVersion || !snapshot.parserVersion ||
    snapshot.schemaVersion !== config.schemaVersion || snapshot.embedding.id !== config.embedding?.id ||
    snapshot.embedding.dimensions !== config.embedding?.dimensions || snapshot.embeddingInputVersion !== config.embeddingInputVersion) return null;
  // Validate the saved layout against its own versions before trusting any vector.
  // Only the current source/parser/chunker determine the new passage layout.
  return reusableSnapshot(snapshot, { ...config, parserVersion: snapshot.parserVersion,
    chunkerVersion: snapshot.chunkerVersion, chunking: snapshot.chunking });
}
export function snapshotOf(records: Map<string, IndexedDocument>, vectors: Map<string, Float32Array>, config: SnapshotConfiguration): IndexSnapshot {
  const snapshot: IndexSnapshot = structuredClone({ ...config,
    documentRevisions: [...records.values()].flatMap(record => record.revision === undefined ? [] :
      [{ sourceId: record.catalog.sourceId, documentId: record.catalog.documentId, revision: record.revision }]),
    documents: [...records.values()].map(record => record.catalog),
    chunks: [...records.values()].flatMap(record => record.chunks),
  });
  // Metadata is isolated above; these freshly materialized arrays already own
  // their data. Cloning them a second time duplicates the largest payload.
  for (const chunk of snapshot.chunks) {
    const vector = vectors.get(chunk.id);
    if (vector) chunk.vector = Array.from(vector);
  }
  return snapshot;
}
/** Exact embeddable text is the reuse key; provenance-sensitive chunk IDs remain unchanged. */
export async function embedChunks(chunks: IndexedChunk[], reusable: Map<string, Float32Array>, embedder: Embedder,
  options: OperationOptions): Promise<{ vectors: Map<string, Float32Array>; embeddedTexts: number }> {
  const inputs = chunks.map(embeddingTextForChunk);
  const missing = [...new Set(inputs.filter(input => !reusable.has(input)))];
  options.signal?.throwIfAborted();
  if (missing.length) {
    // Runtime/model-specific batching belongs to the supplied embedder.
    const result = await embedder.embedDocuments([...missing], options);
    options.signal?.throwIfAborted();
    if (!Array.isArray(result) || result.length !== missing.length) throw new Error('Invalid embedding result length');
    for (const [index, vector] of result.entries()) {
      if (!(vector instanceof Float32Array) || vector.length !== embedder.dimensions || !vector.every(Number.isFinite)) throw new Error('Invalid embedding vector');
      reusable.set(missing[index]!, vector.slice());
    }
  }
  return { vectors: new Map(chunks.map((chunk, index) => [chunk.id, reusable.get(inputs[index]!)!])), embeddedTexts: missing.length };
}

/** Compare a candidate without allocating or serializing a second set of large vectors. */
export function snapshotMatches(records: Map<string, IndexedDocument>, vectors: Map<string, Float32Array>,
  config: SnapshotConfiguration, snapshot: IndexSnapshot | null): boolean {
  if (!snapshot) return false;
  const header = (value: SnapshotConfiguration) => [value.schemaVersion, value.parserVersion, value.chunkerVersion,
    value.embeddingInputVersion, value.chunking, value.embedding];
  if (JSON.stringify(header(config)) !== JSON.stringify(header(snapshot))) return false;
  const revisions = [...records.values()].flatMap(record => record.revision === undefined ? [] :
    [{ sourceId: record.catalog.sourceId, documentId: record.catalog.documentId, revision: record.revision }]);
  if (JSON.stringify(revisions) !== JSON.stringify(snapshot.documentRevisions) || records.size !== snapshot.documents.length) return false;
  let documentIndex = 0; let chunkIndex = 0;
  for (const record of records.values()) {
    if (JSON.stringify(record.catalog) !== JSON.stringify(snapshot.documents[documentIndex++])) return false;
    for (const chunk of record.chunks) {
      const other = snapshot.chunks[chunkIndex++]; if (!other) return false;
      const { vector: oldVector, ...oldFields } = other; const vector = vectors.get(chunk.id);
      if (JSON.stringify(chunk) !== JSON.stringify(oldFields) || (vector === undefined ? oldVector !== undefined :
        oldVector === undefined || vector.length !== oldVector.length || !vector.every((value, i) => value === oldVector[i]))) return false;
    }
  }
  return chunkIndex === snapshot.chunks.length;
}
