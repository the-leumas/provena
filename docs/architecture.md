# Architecture

## Dependency direction

Host applications depend on this package; the package does not depend on any specific host. The root export is host-neutral TypeScript/ESM with zero runtime dependencies. Only the separate filesystem adapter imports Node APIs. There is no host-specific dependency or product-owned session, UI, job or workspace code.

Common host environments can consume this structure: bundlers (such as esbuild or Rollup) can bundle ESM dependencies into application plugins, while Node packages and daemons can import ESM directly. No CommonJS distribution is necessary for this slice. Browser bundles may use core and the portable `/minilm` export with its optional peer; they must avoid `/filesystem`.

## Current pipeline

```text
registered SearchSource
  → list source-aware documents
  → canonical FileTypeRegistry
  → ParserRegistry
  → ParsedDocument with source line sections
  → chunkDocument
  → CatalogEntry + IndexedChunk records
  → versioned content/heading embedding input
  → optional exact-input vector reuse / adapter-owned inference
  → optional atomic snapshot save
  → commit replacement source state
  → source/metadata filters
  → lexical scoring and/or query embedding + exact cosine
  → optional RRF fusion of complete channels
  → SearchResult with full provenance
```

`documentKey` encodes the source/document pair without separator collisions. URIs are reopenable origins supplied by sources; filesystem URIs are canonical `file:` URLs. Relative paths are display/filter metadata and never globally unique identities.

## Parsing and chunking

The file registry is the sole built-in extension authority. A host adding a format supplies the same extended registry to its parser registry and filesystem source. Parser IDs can be overridden deliberately; duplicate IDs/extensions fail early.

Markdown extracts ATX/setext headings, sections and basic Markdown/wiki links while ignoring headings/links inside fenced code. Frontmatter is preserved raw and excluded from body chunks; hosts may enrich catalog tags using metadata. No full CommonMark compliance, YAML evaluation, symbol AST or Tree-sitter is claimed. Other parsers preserve normalized lines and language metadata.

The chunker honors Markdown section boundaries, preserves complete code/text lines, prefers nearby blank/closing-brace boundaries, and uses modest configurable line overlap. Its character target is soft for unusually long lines. Every chunk contains source/document identity, URI, heading/language where known, exact line span and text. Deterministic FNV-1a-64 fingerprints are non-security hashes; identity also includes source/document and repeated-content occurrence. Reuse compares complete records/text, never trusts a hash alone. Changing chunk behavior must increment `CHUNKER_VERSION`.

## Catalog and indexing

The in-memory engine accepts explicit sources and refreshes them on demand. Catalog entries carry title, source/path/URI, dates, tags, headings, outgoing links and type. Tags are source metadata; backlinks are not synthesized.

Each source refresh builds a replacement snapshot before committing. If listing, parsing, reading, chunking, embedding, persistence or cancellation before publication fails, the previous source snapshot survives. Initializing several sources is atomic per source, not across all sources. Concurrent refresh requests are rejected; hosts debounce/serialize changes. Renames appear as document removal/addition while content fingerprints remain independent of paths. Matching source revisions reuse complete catalog entries and chunks without reading/parsing. Sources without revisions still compare freshly parsed chunks. Deletes disappear from both live and persisted state after a successful refresh. Removing a source synchronously clears its live records/vectors; persistence reflects that removal at the next successful source refresh. `removeSource` remains a synchronous registration API, not a durable storage operation.

No watch callback is automatically subscribed. The optional source watch contract is an extension point; host integration controls lifecycle, debounce and refresh scheduling.

## Retrieval and run cache

The public `SearchRequest.mode` (`lexical`, `semantic`, `hybrid`) and read-only `engine.defaultMode` define retrieval strategy. With an embedder the default is hybrid; without one it is lexical. Explicit semantic/hybrid without an embedder fails. Lexical search now weights term matches by candidate-scoped IDF, retains heading/metadata and full-query boosts, and never invokes query inference. Snapshot schema 3, embedding input version 1 and model identities are unchanged: compatible Alpha.3 vectors need no re-embedding for this retrieval-only change.

One candidate collection applies all existing source/catalog restrictions before either ranking channel. It keeps references to records, chunks and vectors from a single committed index view. Lexical scoring weights candidate-set term rarity with IDF, preserves heading/metadata and full-query boosts, and uses chunk-ID ties. It returns only positive-evidence chunks. Semantic/hybrid embeds the original unmodified query exactly once, validates its Float32 type, configured dimension and finite nonzero norm, then ranks every eligible vector by dot product divided by both norms. Unit normalization and MiniLM dimensions are not generic assumptions. Missing, malformed or zero-norm candidate vectors fail clearly; indexing still permits finite zero vectors for backward-compatible lexical use.

Whitespace-only queries and empty candidate sets return no results without inference. Nonempty queries with no lexical tokens can still return semantic results. Semantic similarity never bypasses filters and there is no minimum similarity threshold: semantic mode may return weak or unrelated evidence when nothing is relevant. Hosts must interpret/revalidate evidence rather than treat ranks as confidence.

Hybrid fuses the union of complete channel rankings using `sum(1 / (60 + channelRank))`. It never blends raw lexical and cosine scores or truncates channels before fusion. Scores sort descending, with stable chunk ID as final tie breaker. Lexical-only results have `lexicalRank`; semantic-only results have `semanticRank`; hybrid results retain each participating channel's rank. `combinedRank` is the final one-based position. Match reasons contain only `lexical` and/or `semantic`. The final limit defaults to 8 and accepts integers 1–100. Every mode preserves URI, source/document/chunk identity, path, title, heading, language, line range and snippet.

Exact cosine is O(N·D + N log N) for N eligible chunks of dimension D. Fusion adds O(N log N), with O(N) temporary candidate/rank references; query execution does not copy stored vectors. This is an exact in-memory baseline, not ANN or a vector database. AbortSignal checks occur before collection, per candidate, around query inference, during fusion and before result construction. Synchronous loops/sorts do not yield to the event loop; native inference cancellation remains adapter-dependent.

A search that overlaps refresh returns a consistent view captured before query inference. It can therefore return the previous committed evidence after a refresh finishes, but never combines new chunks with old vectors. Search/model failures do not mutate or persist index state. Embedding configuration changes before/during query inference fail; supplied adapters must remain immutable.

`createSearchSession` is bounded (default 64), returns defensive copies, counts hits/misses, and invalidates on index revision changes. Keys include **effective mode**, query, sources, filters and final limit. Omitted mode and explicit default mode share a key. Lexical keys retain trimmed/lowercased equivalence; semantic/hybrid keys preserve raw query text because arbitrary embedders may distinguish case/whitespace. A result spanning an index change is returned to its caller but not inserted into the cache. Alpha.5 canonicalizes source/tag/extension sets (including extension case/leading-dot equivalence), omits undefined filter values, and makes `clear()` prevent older pending results from repopulating the cache. Clearing does not abort the pending caller. Only completed successful searches are cached; concurrent identical pending searches are not coalesced. There is no cross-mode query-vector cache or similarity-based query deduplication. Host listing/read tools are outside this cache.

[ADR 0002](decisions/0002-retrieval-modes.md) records the default change and baseline decisions.

## Embedding and persistence boundaries

`Embedder` and `IndexStorage` are independent, optional constructor options. The root has no model, Node, IndexedDB, worker or storage-location dependency. Only semantic/hybrid search calls `embedQuery`. The host supplies adapters and keeps their configuration immutable for the engine's lifetime.

Chunks remain pure provenance records. Internally, vectors are held separately by chunk ID. Reuse uses exact embeddable text, not a non-cryptographic hash: a rename changes document/chunk identity while retaining the same vector. Identical embedding input across chunks shares inference. The generic engine submits all unique missing inputs in one call; batching belongs to each embedder; returned vectors must be finite Float32Arrays of the configured dimensions. The engine copies adapter results and saves numeric arrays. `embeddedTexts` counts unique new inference inputs; `reusedVectors` counts remaining chunk assignments, including duplicate input within the current refresh.

### Embedding input and the optional MiniLM adapter

`embeddingTextForChunk` and `EMBEDDING_INPUT_VERSION = '1'` make inference input explicit. A chunk without a heading uses its body. A continuation chunk prepends its content-derived heading and a blank line; an initial ATX/setext heading already present is not duplicated. Filename, path, URI and source/document IDs never enter the input. Different meaningful heading context can therefore require a new vector for the same body, while renames preserve reuse. Equality is over the complete constructed input, not a hash.

`MiniLMEmbedder` is isolated in `/minilm`. Transformers.js 4.2.0 is an exact optional peer and development dependency; no root module imports it. Import/construction is cheap; the first nonempty inference call dynamically imports the runtime and loads one pipeline. Stable public tokenizer/model loaders construct `FeatureExtractionPipeline`, avoiding the convenience factory's extra metadata discovery. Tokenizer discovery still has the documented upstream offline limitation.

The adapter uses mean pooling and normalization, validates 384 finite Float32 values with unit norm tolerance, copies only output vector rows, and disposes returned output tensors. It defaults to fp32/CPU/batches of four and permits supported wasm/webgpu devices and fp16/q8 dtype choices. Batch size does not enter identity. Inference calls serialize on one pipeline. Failed model loading is retryable; failed calls do not publish candidate engine state. `dispose()` is terminal/idempotent, waits for active work and releases the model; the engine never disposes a supplied embedder.

Identity includes the pinned model/revision, runtime and adapter behavior version, device, dtype, mean pooling, normalization and pinned-tokenizer truncation policy. The default tokenizer truncates at 512 tokens; character-based chunk targets are not a strict token bound. Query embedding uses the query itself in the same semantic space. Alpha.4 core invokes it through the generic Embedder contract for semantic/hybrid modes; the MiniLM adapter owns no ranking behavior.

Cancellation is cooperative before/after loading and inference and between adapter batches. The stable API cannot preempt active native inference or model loading; completion is checked before returning vectors. Hosts choose workers/processes, cache paths, local model staging, WASM locations and runtime environment globals. The adapter does not mutate those globals. Strict offline operation requires staged assets, not merely a Hub cache. See [ADR 0001](decisions/0001-minilm-loading.md) for the accepted boundary and [integration](integration.md) for deployment examples.

### Snapshot compatibility and restart

Schema 3 snapshots contain catalog entries, complete chunks, optional vectors and markers for parser behavior, file-type definitions, chunker version, effective chunking options, embedding-input version, and optional embedding ID/dimensions. Alpha.2/schema 2 snapshots rebuild wholesale. The embedder ID must encode model revision, pooling, normalization and all settings affecting vectors. Vectors are reused only for exact matching embedding inputs with compatible schema, model identity, dimensions and embedding-input version. Parser/chunker changes rebuild passages but do not discard matching validated vectors.

Built-in parser behavior uses `PARSER_VERSION`. Custom parser registries must supply an explicit behavior version (third constructor argument); without one, persisted reuse is disabled conservatively. File-type configuration is included automatically. Bump parser/chunker behavior versions when their implementation changes. Schema, parser and chunker mismatches rebuild passages. Embedding model/input mismatches invalidate vectors independently, preserving compatible passages. Compatible snapshots with malformed catalog/chunk/vector data throw `Corrupt index snapshot`; storage read errors and malformed JSON also surface. Nothing from a rejected snapshot becomes searchable. Hosts can repair/remove the store and retry, or explicitly choose a fresh store.

Loading is lazy on the first source refresh, including `initialize`. Loaded records are only reuse candidates. Every registered source is listed and reconciled before its replacement becomes searchable. Matching nonempty source revisions restore compatible catalogs/chunks, including empty documents; only new/changed documents are read and parsed. Explicit content verification bypasses the revision fast path. Unknown/unregistered sources are never restored into the live index. Reconciled source seed data is discarded, and deleted content is absent from the next canonical snapshot. Only live reconciled records are saved. Unchanged snapshots skip writes; lexical-only refreshes preserve vector-bearing stores and publish their lexical view in memory. During multi-source startup a successful early source save can replace still-unreconciled persisted records; a crash at that point may require more embedding work at the next restart, but cannot expose stale records. Initialization deliberately retains the existing per-source transaction semantics.

### Commit and cancellation policy

A refresh builds candidate records and vectors without mutating the live index. It then saves the complete candidate snapshot, if configured, before synchronously publishing the source replacement. Failed inference/save leaves the previous live source and engine revision intact. Failed candidate embeddings are not retained as hidden historical state. Searches can continue against the old live index during the refresh. Concurrent refresh/mutation requests are rejected.

`OperationOptions.signal` flows through load, list, read, embedding batches and save, with engine checks around asynchronous preparation. Storage implementations must reject failures/cancellation before atomic publication, and resolve after publication. A successful save is the transaction's commit point: cancellation arriving after publication does not undo that save or prevent the matching live commit. Without storage, the final abort check immediately precedes synchronous live publication. This is cancellation at transaction boundaries, not rollback of already committed operations.

The host owns storage identity/location and must provide a single writer per store. No multi-process locking, migration, automatic watcher or job scheduler is included.

### Node file storage

`FileIndexStorage`, exported alongside `FileSystemFolderSource` from `@theleumas/provena/filesystem`, uses an explicit absolute filename. Its parent must already exist. Save serializes the candidate, creates an exclusive temporary sibling with mode 0600, writes and fsyncs it, closes it, checks cancellation, then renames it over the canonical file. Failed writes remove the temporary file; an interrupted process may leave an ignored temporary sibling. Load reads only the canonical file. Missing canonical files return null; other I/O and JSON errors surface.

Atomic replacement prevents a partial canonical JSON file. Directory fsync and crash-proof power-loss durability are not promised. The adapter assumes a host-controlled directory and one writer; filesystem location, permissions and process/worker arrangement remain host responsibilities. Browser hosts implement the same `IndexStorage` contract with their own transactional store and import only the root package.

## Filesystem safety scope

A source requires an explicit absolute root, resolved canonically. The adapter rejects traversal, absolute document IDs, symlink components, unsupported formats, invalid UTF-8 and oversized reads. All symlinks are skipped, including internal ones. Reads use no-follow file opens, bounded buffers, and identity/containment checks before returning data. Root symlink retargeting after registration is rejected.

These checks prevent ordinary out-of-root discovery/read paths; they are not an OS sandbox against a hostile process concurrently replacing directory components. For adversarial filesystems, hosts must add OS-level confinement. Live changes may fail a scan; hosts retry explicitly rather than silently dropping or broadening source scope.

## Historical validation scope

Ranking, k=60, mode defaults, input version and snapshot schema remain unchanged. Reproduced cache defects were corrected without changing the ranking universe. Twenty controlled overlap schedules and canonical-rename failure injection strengthen the existing captured-view/atomic-publish guarantees. Large-document tests preserve all nonblank lines for 300 headings, 10k code lines, raw malformed frontmatter and a single 350k-character line; the latter remains one oversized chunk. MiniLM may truncate that input at its tokenizer limit, so line preservation is not proof that every token was embedded.

A real installed-tarball Chrome page/module worker demonstrates host-neutral core with an injected source, memory storage and custom embedder. Optional MiniLM WASM was tested separately using host-served assets; production core imports and exports do not change. Esbuild/Playwright are development-only test tools. See [API ownership](api.md), [evaluation](evaluation.md) and [hardening evidence](https://github.com/the-leumas/provena/blob/main/docs/alpha5-hardening.md) for constraints, timings and the experimental release verdict.

## Retrieval-only answerability boundary

[ADR 0003](decisions/0003-retrieval-evidence-boundary.md) selects retrieval-only core after inspecting exact chunk contents and sufficient evidence sets. Relevance, sufficiency, scoped corpus answerability and retrieval success are separate. Contextual proximity and channel agreement cannot supply an absent fact; multiple individually partial chunks can jointly satisfy a task. No core classifier, evaluator interface, public diagnostics field or rejection behavior is added.

The [evidence example](../examples/evidence.mjs) labels returned candidates as unassessed without adding a runtime classifier. It preserves errors and reports index revision overlap without certifying source freshness. The library imposes no worker, storage or model topology on host applications; internal evaluation annotations and cosine traces are not public result fields.
