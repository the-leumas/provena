/** Identities are local to a source. URI is the host's reopenable origin. */
export interface SourceDocument {
  id: string;
  sourceId: string;
  uri: string;
  path?: string;
  name: string;
  extension?: string;
  mimeType?: string;
  createdAt?: number;
  modifiedAt?: number;
  metadata?: Record<string, unknown>;
  /** Opaque token that changes with content or parser-relevant document metadata. */
  revision?: string;
}
export interface SourceContent { text: string; }
export interface Disposable { dispose(): void; }
export type SourceChangeEvent =
  | { type: 'create' | 'modify' | 'delete'; documentId: string }
  | { type: 'rename'; documentId: string; previousDocumentId: string };
export interface OperationOptions { signal?: AbortSignal; }
export interface DocumentRefreshProgress {
  sourceId: string; documentId: string; disposition: 'reused' | 'parsed';
  completed: number; total: number; passages: number;
}
export interface RefreshOptions extends OperationOptions {
  /** Reread and reparse even when source revisions match; compatible vectors still reuse. */
  verifyContent?: boolean;
  /** Called before publication; throwing cancels this atomic refresh. */
  onDocument?: (progress: DocumentRefreshProgress) => void;
}
export interface SearchSource {
  readonly id: string;
  readonly type: string;
  list(options?: OperationOptions): Promise<SourceDocument[]>;
  read(documentId: string, options?: OperationOptions): Promise<SourceContent>;
  watch?(callback: (event: SourceChangeEvent) => void): Disposable;
}
export interface DocumentSection {
  startLine: number;
  endLine: number;
  heading?: string;
  kind: 'text' | 'code';
}
export interface ParsedDocument {
  document: SourceDocument;
  text: string;
  parserId: string;
  title: string;
  language?: string;
  sections: DocumentSection[];
  headings: string[];
  outgoingLinks: string[];
  /** Raw frontmatter text; no YAML parsing or validation is performed. */
  frontmatter?: string;
}
export interface DocumentParser {
  readonly id: string;
  supports(document: SourceDocument): boolean;
  parse(document: SourceDocument, content: SourceContent): ParsedDocument | Promise<ParsedDocument>;
}
export interface IndexedChunk {
  id: string;
  sourceId: string;
  documentId: string;
  uri: string;
  path?: string;
  heading?: string;
  language?: string;
  text: string;
  contentHash: string;
  startLine: number;
  endLine: number;
}
export interface Embedder {
  /** Include model revision, pooling and normalization in this identity. */
  readonly id: string;
  readonly dimensions: number;
  embedDocuments(texts: string[], options?: OperationOptions): Promise<Float32Array[]>;
  embedQuery(text: string, options?: OperationOptions): Promise<Float32Array>;
}
export interface CatalogEntry {
  documentId: string;
  sourceId: string;
  uri: string;
  path?: string;
  title: string;
  fileType?: string;
  createdAt?: number;
  modifiedAt?: number;
  tags: string[];
  headings: string[];
  outgoingLinks: string[];
}
export interface SearchFilters {
  pathPrefix?: string;
  extensions?: string[];
  tags?: string[];
  modifiedAfter?: number;
  createdAfter?: number;
  linkedTo?: string;
}
export type SearchMode = 'lexical' | 'semantic' | 'hybrid';
/** Retrieve eligible candidates, not an assessment that the requested fact/task is supported. */
export interface SearchRequest extends OperationOptions {
  /** Defaults to hybrid with an embedder, lexical without one. */
  mode?: SearchMode;
  query: string;
  sources?: string[];
  filters?: SearchFilters;
  limit?: number;
}
/** Ranked candidate evidence from one captured committed index view.
 * Ranks and channel matches are retrieval positions/signals, not confidence or sufficiency.
 * A nonempty list does not establish answerability; an empty list does not prove corpus absence.
 * Source content may change after indexing; hosts verify current evidence when needed.
 */
export interface SearchResult {
  sourceId: string;
  documentId: string;
  chunkId: string;
  uri: string;
  path?: string;
  title: string;
  heading?: string;
  language?: string;
  startLine: number;
  endLine: number;
  snippet: string;
  lexicalRank?: number;
  semanticRank?: number;
  combinedRank: number;
  matchReasons: string[];
}
/** Serializable index state. Engines validate compatibility and reconcile live sources before reuse. */
export interface IndexSnapshot {
  schemaVersion: number;
  parserVersion: string;
  chunkerVersion: string;
  /** Version of content/structure-based text supplied to the embedder. */
  embeddingInputVersion?: string;
  /** Effective boundary configuration; older snapshots without it are rebuilt. */
  chunking?: { targetChars: number; overlapLines: number };
  embedding?: { id: string; dimensions: number };
  documentRevisions?: Array<{ sourceId: string; documentId: string; revision: string }>;
  documents: CatalogEntry[];
  chunks: Array<IndexedChunk & { vector?: number[] }>;
}
/** Host-owned atomic storage. One writer per store. Errors must surface.
 * save must reject before publication on failure/abort and resolve after atomic publication.
 * Cancellation arriving after publication does not roll back a successful save.
 */
export interface IndexStorage {
  load(options?: OperationOptions): Promise<IndexSnapshot | null>;
  save(snapshot: IndexSnapshot, options?: OperationOptions): Promise<void>;
}
export function documentKey(sourceId: string, documentId: string): string {
  return JSON.stringify([sourceId, documentId]);
}
