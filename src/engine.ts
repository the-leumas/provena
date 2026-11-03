import type { CatalogEntry, Embedder, IndexStorage, IndexSnapshot, RefreshOptions, SearchMode, SearchRequest, SearchResult, SearchSource } from './contracts.js';
import { documentKey } from './contracts.js';
import { ParserRegistry } from './parsers/index.js';
import { chunkDocument, type ChunkOptions } from './chunking.js';
import { catalogEntry } from './catalog.js';
import { embeddingTextForChunk } from './embedding-input.js';
import { configuration, reusableSnapshot, reusableEmbeddingSnapshot, snapshotOf, embedChunks, type IndexedDocument, type SnapshotConfiguration, snapshotMatches } from './index-state.js';
import { collectCandidates, rankLexical, rankSemantic, fuseRrf, toSearchResults } from './retrieval.js';
export interface RefreshReport {
  sourceId: string; documents: number; chunks: number; unchangedChunks: number;
  embeddedTexts: number; reusedVectors: number;
  documentsRead: number; documentsParsed: number; documentsReused: number; documentsDeleted: number;
  persistence: 'saved' | 'unchanged' | 'preserved' | 'none';
}
export interface EngineOptions { parsers?: ParserRegistry; chunking?: ChunkOptions; embedder?: Embedder; storage?: IndexStorage; }
/** Host-independent indexing and lexical/semantic retrieval lifecycle. */
export class SemanticSearchEngine {
  private readonly sources = new Map<string, SearchSource>();
  private readonly records = new Map<string, IndexedDocument>();
  private readonly parsers: ParserRegistry;
  private readonly chunking: ChunkOptions;
  private readonly embedder: Embedder | undefined;
  private readonly storage: IndexStorage | undefined;
  private readonly config: SnapshotConfiguration;
  private vectors = new Map<string, Float32Array>();
  private loaded = false;
  private seed: IndexSnapshot | null = null;
  private seedVectors = new Map<string, Float32Array>();
  private persisted: IndexSnapshot | null = null;
  private seedRecords = new Map<string, IndexedDocument>();
  private busy = false;
  private generation = 0;
  constructor(options: EngineOptions = {}) {
    this.parsers = options.parsers ?? new ParserRegistry(); this.chunking = { ...options.chunking };
    this.embedder = options.embedder; this.storage = options.storage;
    if (this.embedder && (!this.embedder.id.trim() || !Number.isSafeInteger(this.embedder.dimensions) || this.embedder.dimensions < 1)) throw new Error('Invalid embedder configuration');
    this.config = configuration(this.parsers, this.chunking, this.embedder);
    const { targetChars, overlapLines } = this.config.chunking!;
    if (!Number.isSafeInteger(targetChars) || targetChars < 64 || !Number.isSafeInteger(overlapLines) || overlapLines < 0) throw new Error('Invalid chunk options');
  }
  /** Effective strategy when SearchRequest.mode is omitted. */
  get defaultMode(): SearchMode { return this.embedder ? 'hybrid' : 'lexical'; }
  get revision(): number { return this.generation; }
  addSource(source: SearchSource): void {
    if (this.busy) throw new Error('Index update is in progress');
    if (!source.id.trim() || this.sources.has(source.id)) throw new Error(`Invalid or duplicate source: ${source.id}`);
    this.sources.set(source.id, source);
  }
  removeSource(sourceId: string): void {
    if (this.busy) throw new Error('Index update is in progress');
    this.sources.delete(sourceId);
    for (const record of this.records.values()) if (record.catalog.sourceId === sourceId) for (const chunk of record.chunks) this.vectors.delete(chunk.id);
    this.discardSeed(sourceId);
    for (const [key, record] of this.records) if (record.catalog.sourceId === sourceId) this.records.delete(key);
    this.generation++;
  }
  async initialize(options: RefreshOptions = {}): Promise<RefreshReport[]> {
    options.signal?.throwIfAborted();
    const reports: RefreshReport[] = [];
    for (const id of this.sources.keys()) reports.push(await this.refreshSource(id, options));
    return reports;
  }
  /** Atomic per-source refresh. A failed or cancelled scan preserves that source's previous index. */
  async refreshSource(sourceId: string, options: RefreshOptions = {}): Promise<RefreshReport> {
    if (this.busy) throw new Error('Index update is in progress');
    const source = this.sources.get(sourceId); if (!source) throw new Error(`Unknown source: ${sourceId}`);
    this.busy = true;
    try {
      options.signal?.throwIfAborted();
      if (JSON.stringify(configuration(this.parsers, this.chunking, this.embedder)) !== JSON.stringify(this.config)) throw new Error('Index configuration changed; create a new engine');
      if (!this.loaded) {
        const snapshot = this.storage ? await this.storage.load(options) : null;
        options.signal?.throwIfAborted();
        this.seed = reusableSnapshot(snapshot, this.config); this.persisted = this.seed ?? snapshot;
        const embeddingSeed = this.seed?.embedding && this.seed.embedding.id === this.config.embedding?.id &&
          this.seed.embedding.dimensions === this.config.embedding?.dimensions &&
          this.seed.embeddingInputVersion === this.config.embeddingInputVersion ? this.seed :
          reusableEmbeddingSnapshot(this.seed ? null : snapshot, this.config);
        this.seedVectors = new Map((embeddingSeed?.chunks ?? []).map(chunk =>
          [embeddingTextForChunk(chunk), new Float32Array(chunk.vector!)]));
        const revisions = new Map(this.seed?.documentRevisions?.map(entry => [documentKey(entry.sourceId, entry.documentId), entry.revision]));
        for (const catalog of this.seed?.documents ?? []) {
          const key = documentKey(catalog.sourceId, catalog.documentId); const revision = revisions.get(key);
          this.seedRecords.set(key, { catalog, chunks: [], ...(revision === undefined ? {} : { revision }) });
        }
        for (const { vector: _vector, ...chunk } of this.seed?.chunks ?? []) this.seedRecords.get(documentKey(chunk.sourceId, chunk.documentId))!.chunks.push(chunk);
        this.loaded = true;
      }
      const documents = await source.list(options);
      const totalDocuments = documents.filter(doc => this.parsers.fileTypes.get(doc.path ?? doc.name)?.indexable).length;
      const next = new Map<string, IndexedDocument>(); let unchangedChunks = 0; let documentsRead = 0; let documentsParsed = 0; let documentsReused = 0;
      const seedChunks = new Map((this.seed?.chunks ?? []).map(({ vector: _vector, ...chunk }) => [chunk.id, chunk]));
      const ids = new Set<string>();
      for (const doc of documents) {
        options.signal?.throwIfAborted();
        if (!doc.id || doc.sourceId !== sourceId || !doc.uri || ids.has(doc.id)) throw new Error('Invalid, duplicate or cross-source document identity');
        ids.add(doc.id);
        if (!this.parsers.fileTypes.get(doc.path ?? doc.name)?.indexable) continue;
        if (doc.revision !== undefined && (typeof doc.revision !== 'string' || !doc.revision.trim())) throw new Error('Invalid document revision');
        const key = documentKey(sourceId, doc.id);
        const previous = this.records.get(key) ?? this.seedRecords.get(key);
        if (!options.verifyContent && this.config.parserVersion && doc.revision !== undefined && previous?.revision === doc.revision) {
          next.set(key, previous); unchangedChunks += previous.chunks.length; documentsReused++;
          options.onDocument?.({ sourceId, documentId: doc.id, disposition: 'reused', completed: next.size, total: totalDocuments, passages: previous.chunks.length });
          continue;
        }
        const content = await source.read(doc.id, options); documentsRead++;
        const parsed = await this.parsers.parse(structuredClone(doc), content); documentsParsed++;
        let chunks = chunkDocument(parsed, this.chunking);
        const oldChunks = new Map(previous?.chunks.map(chunk => [chunk.id, chunk]));
        chunks = chunks.map(chunk => {
          const old = oldChunks.get(chunk.id) ?? seedChunks.get(chunk.id);
          if (old && JSON.stringify(old) === JSON.stringify(chunk)) { unchangedChunks++; return old; }
          return chunk;
        });
        next.set(key, { catalog: catalogEntry(parsed), chunks, ...(doc.revision === undefined ? {} : { revision: doc.revision }) });
        options.onDocument?.({ sourceId, documentId: doc.id, disposition: 'parsed', completed: next.size, total: totalDocuments, passages: chunks.length });
      }
      options.signal?.throwIfAborted();
      const reusable = new Map<string, Float32Array>();
      if (this.embedder) {
        for (const [input, vector] of this.seedVectors) reusable.set(input, vector);
        for (const record of this.records.values()) for (const chunk of record.chunks) {
          const vector = this.vectors.get(chunk.id); if (vector) reusable.set(embeddingTextForChunk(chunk), vector);
        }
      }
      const chunks = [...next.values()].flatMap(record => record.chunks);
      const embedded = this.embedder ? await embedChunks(chunks, reusable, this.embedder, options) : { vectors: new Map<string, Float32Array>(), embeddedTexts: 0 };
      const candidate = new Map(this.records); const vectors = new Map(this.vectors);
      for (const [key, record] of candidate) if (record.catalog.sourceId === sourceId) {
        if (!next.has(key)) candidate.delete(key); for (const chunk of record.chunks) vectors.delete(chunk.id);
      }
      for (const [key, record] of next) candidate.set(key, record);
      for (const [id, vector] of embedded.vectors) vectors.set(id, vector);
      options.signal?.throwIfAborted();
      if (JSON.stringify(configuration(this.parsers, this.chunking, this.embedder)) !== JSON.stringify(this.config)) throw new Error('Index configuration changed; create a new engine');
      const oldKeys = new Set([...this.seedRecords, ...this.records].filter(([, record]) => record.catalog.sourceId === sourceId).map(([key]) => key));
      const documentsDeleted = [...oldKeys].filter(key => !next.has(key)).length;
      let persistence: RefreshReport['persistence'] = 'none';
      if (this.storage) {
        if (!this.embedder && this.persisted?.embedding) persistence = 'preserved';
        else {
          if (snapshotMatches(candidate, vectors, this.config, this.persisted)) persistence = 'unchanged';
          else { const snapshot = snapshotOf(candidate, vectors, this.config); await this.storage.save(snapshot, options); this.persisted = snapshot; persistence = 'saved'; }
        }
      }
      if (persistence !== 'saved') options.signal?.throwIfAborted();
      // Successful save is the commit point. Late cancellation cannot undo atomic publication.
      this.records.clear(); for (const [key, record] of candidate) this.records.set(key, record);
      this.vectors = vectors; this.discardSeed(sourceId); this.generation++;
      return { sourceId, documents: next.size, chunks: chunks.length, unchangedChunks,
        documentsRead, documentsParsed, documentsReused, documentsDeleted, persistence,
        embeddedTexts: embedded.embeddedTexts, reusedVectors: this.embedder ? chunks.length - embedded.embeddedTexts : 0 };
    } finally { this.busy = false; }
  }
  private discardSeed(sourceId: string): void {
    for (const [key, record] of this.seedRecords) if (record.catalog.sourceId === sourceId) this.seedRecords.delete(key);
    if (!this.seed) return;
    this.seed = { ...this.seed, documents: this.seed.documents.filter(doc => doc.sourceId !== sourceId),
      ...(this.seed.documentRevisions ? { documentRevisions: this.seed.documentRevisions.filter(doc => doc.sourceId !== sourceId) } : {}),
      chunks: this.seed.chunks.filter(chunk => chunk.sourceId !== sourceId) };
  }
  getCatalog(): CatalogEntry[] { return structuredClone([...this.records.values()].map(record => record.catalog)); }
  /** Return ranked candidates only. Empty results may reflect query/mode/filter restrictions,
   * not absence of sufficient evidence elsewhere. No answerability evaluation is performed. */
  async search(request: SearchRequest): Promise<SearchResult[]> {
    const { signal, query } = request;
    signal?.throwIfAborted();
    const mode = request.mode ?? this.defaultMode;
    if (!['lexical', 'semantic', 'hybrid'].includes(mode)) throw new Error('Invalid search mode');
    if (mode !== 'lexical' && !this.embedder) throw new Error(`${mode} search requires an Embedder`);
    const limit = request.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 to 100');
    if (!query.trim()) return [];
    // Capture references before awaiting inference so a concurrent refresh cannot mix revisions.
    const candidates = collectCandidates(this.records.values(), this.vectors, request);
    if (!candidates.length) return [];
    const lexical = mode !== 'semantic' ? rankLexical(candidates, query, signal) : [];
    let semantic: typeof candidates = [];
    if (mode !== 'lexical') {
      this.checkEmbeddingConfiguration(); signal?.throwIfAborted();
      const vector = await this.embedder!.embedQuery(query, signal ? { signal } : {});
      signal?.throwIfAborted(); this.checkEmbeddingConfiguration();
      semantic = rankSemantic(candidates, vector, this.config.embedding!.dimensions, signal);
    }
    const ranked = mode === 'hybrid' ? fuseRrf(lexical, semantic, signal)
      : mode === 'lexical' ? lexical.map((candidate, i) => ({ candidate, lexicalRank: i + 1 }))
        : semantic.map((candidate, i) => ({ candidate, semanticRank: i + 1 }));
    signal?.throwIfAborted();
    return toSearchResults(ranked, limit, signal);
  }
  private checkEmbeddingConfiguration(): void {
    if (this.embedder?.id !== this.config.embedding?.id || this.embedder?.dimensions !== this.config.embedding?.dimensions) {
      throw new Error('Embedding configuration changed; create a new engine');
    }
  }
}
/** Host creates one candidate-result cache per run; bounded and invalidated by index revision.
 * This caches retrieval only, not answerability, host decisions or current source verification.
 *
 * Cache key semantics:
 * - Lexical queries normalize via trim() + toLowerCase().
 * - Semantic/hybrid queries preserve the raw query string because arbitrary embedders may be case- or whitespace-sensitive.
 * - Filters are canonicalized: source/tag/extension sets are sorted; extensions are lowercased with leading dot normalized. */
export function createSearchSession(engine: SemanticSearchEngine, maxEntries = 64) {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new Error('Invalid cache size');
  let revision = engine.revision; let cleared = 0; const cache = new Map<string, SearchResult[]>();
  const stats = { hits: 0, misses: 0 };
  return {
    get stats() { return { ...stats }; },
    /** Cache candidate retrieval only; no host assessment is cached here. */
    async search(request: SearchRequest): Promise<SearchResult[]> {
      request.signal?.throwIfAborted();
      if (revision !== engine.revision) { cache.clear(); revision = engine.revision; }
      const mode = request.mode ?? engine.defaultMode;
      const query = mode === 'lexical' ? request.query.trim().toLowerCase() : request.query;
      const startedRevision = engine.revision; const startedClear = cleared;
      const key = JSON.stringify([mode, query, request.sources ? [...new Set(request.sources)].sort() : null,
        Object.entries(request.filters ?? {}).filter(([, value]) => value !== undefined).map(([key, value]) => {
          // These filter lists are sets; extension matching also ignores case and a leading dot.
          if (key === 'tags' || key === 'extensions') {
            const items = (value as string[]).map(item => key === 'extensions' ? '.' + item.replace(/^\./, '').toLowerCase() : item);
            return [key, [...new Set(items)].sort()] as const;
          }
          return [key, value] as const;
        }).sort(([a], [b]) => a.localeCompare(b)), request.limit ?? 8]);
      const hit = cache.get(key); if (hit) { stats.hits++; return structuredClone(hit); }
      stats.misses++; const result = await engine.search(request);
      if (engine.revision !== startedRevision || cleared !== startedClear) return result;
      if (cache.size >= maxEntries) cache.delete(cache.keys().next().value!);
      cache.set(key, structuredClone(result)); return result;
    },
    clear() { cache.clear(); cleared++; },
  };
}
