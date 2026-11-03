# Public API and host responsibilities

All root contracts are TypeScript/ESM and import no host or model runtime. The only public subpaths remain `/filesystem` (Node) and `/minilm` (portable optional runtime). Internal ranking helpers are not package exports. There is no implicit worker, scheduler, source discovery or storage directory.

## Ownership and lifecycle

| Contract | Host owns | Engine/adapter owns | Failure and mutability expectations |
| --- | --- | --- | --- |
| `SearchSource` | Authorization, stable source ID, listing/reading, source event subscription | Per-source scan, parsing, reconciliation | IDs unique within a source; each document declares its owning source; throw on unavailable reads. Keep a scan coherent where practical; source I/O is not a filesystem transaction. |
| `Embedder` | Effective immutable model/config ID, dimensions, execution realm, resource lifetime | Engine finds unique missing inputs and reuses compatible vectors; embedder batches inference | Float32Array per input, finite and matching dimensions. Semantic use additionally needs nonzero norms. Propagate signal cooperatively and surface errors. Generic embedders need not normalize. |
| `IndexStorage` | Location/backend, provisioning, atomic transactions, single writer and recovery | Compatible snapshot creation/load/reconciliation | `load` returns snapshot or null; corrupt data/I/O errors surface. `save` rejects before publication, resolves after publication; late abort cannot undo a committed save. Do not mutate saved/loaded values behind the engine. |
| `SearchRequest` | Query, explicit mode if desired, approved sources and deterministic filters, final limit, signal | Effective mode, shared filtering, channel ranking, RRF and final limit | Nonempty semantic queries are sent unmodified to the embedder. Limit 1–100, default 8. No embedder: default lexical; embedder: default hybrid. Explicit semantic/hybrid without embedder fails. |
| `SearchResult` | Evidence interpretation, reopening source and checking current facts before actions | Stable source/document/chunk identity, URI/path/lines/snippet and ordinal ranks | Results are evidence candidates, not verified answers. Channel ranks and combinedRank are not confidence. No calibrated rejection or raw-score API exists. |
| `SemanticSearchEngine` | Source registration, serialized refresh requests, sharing/disposal of supplied adapters | Catalog, chunks, compatible vector reuse, atomic per-source publication, retrieval | A failed refresh preserves the last good source. `initialize` is per-source atomic, not whole-index atomic. Search sees a captured committed view; overlapping refresh may make it old but cannot mix vector generations. |
| `createSearchSession` | Per-run cache lifetime and optional capacity | Bounded FIFO insertion, defensive copies, effective-mode keys, revision invalidation | Failed calls are not cached. Equivalent unordered source/tag/extension sets share keys. Lexical queries normalize case/outer spaces; semantic/hybrid retain exact query text. `clear()` also prevents pending older work from repopulating the cache; it does not abort that work. |
| `MiniLMEmbedder` | Optional peer installation, model/backend assets, global runtime configuration, thread/worker placement and disposal | Lazy model load, modest batches, normalized 384-dimensional output, query/document inference, terminal disposal | Default pinned model/revision and identity remain documented in integration. No runtime import at construction. Active native inference may not be preemptible. Sharing one adapter across engines is allowed; finish all users before disposal. |

## Small operational sequence

Create host adapters, construct an engine, register sources, then await `initialize({ signal })`. Search with `engine.search(request)` or a short-lived `createSearchSession(engine)`. After host-observed changes, await `refreshSource(sourceId, { signal })`; inspect its embedding/unchanged counts when diagnosing expensive updates. Keep the embedder alive for semantic queries.

`getCatalog()` returns a defensive copy. `revision` identifies committed index changes. `defaultMode` is read-only. `removeSource(id)` immediately clears that source in memory; the next successful refresh persists the removal. It is not an immediate durable storage operation. Adding a source does not index it automatically.

Mutation of parser or embedder behavior without changing its version/identity violates compatibility assumptions. Construct a new engine for changed embedding configuration. Hosts must serialize writes to a store; there is no multi-process lock. A custom parser registry requires an explicit behavior version for persistent reuse and parsers whose `supports` methods recognize their custom formats.

## Cancellation and workers

Signals are checked before/after asynchronous stages and during candidate loops. Synchronous parsing/ranking/sorting does not yield to the event loop, so a same-thread timer cannot preempt a running scan. Large searches belong in a host-controlled worker when interactive responsiveness matters. Pass messages/serializable evidence across worker boundaries; instantiate source/storage/embedder objects within the chosen realm rather than transferring an engine object. Browser storage in examples is memory-only, not IndexedDB/OPFS.

## Limits and release scope

- Returned evidence can be irrelevant, including high-cosine near misses. Use provenance to check the requested fact; a nonempty result is not proof that an answer exists.
- Search returns candidates whenever eligible chunks exist, including when no passage contains the requested fact, and an empty list is also not a corpus-absence signal. There is no separate “not found” result state.
- Markdown headings with no body text under them can be returned as passages, and a short query naming the heading can rank that passage highly.
- Semantic and hybrid ordering follows embedding similarity, not grammar. Informal testing observed right-topic passages with the action reversed; a host must read the passages rather than inferring relationships from rank alone.
- Raw scores are deliberately absent. Ranks cannot be converted into reliable confidence thresholds, and the current evaluation does not validate a generic rejection cutoff. A consuming application may assess its retrieved evidence separately.
- Full exact ranking becomes expensive at tens of thousands of unfiltered 384-dimensional candidates on the measured laptop. Scope sources/filters and choose execution placement; no universal latency promise is made.
- Snapshots serialize numeric arrays and refresh rescans sources. No automatic migrations, watcher subscription, durable removeSource call, or production browser store is provided.

See [integration](integration.md), [examples](../examples/README.md), [Alpha.5 evidence](https://github.com/the-leumas/provena/blob/main/docs/alpha5-hardening.md) and [architecture](architecture.md).

## Candidate retrieval is not a support judgment

`SearchRequest`, `SearchResult`, `SemanticSearchEngine.search` and `createSearchSession` retain their runtime signatures. TSDoc now explicitly states that ranked candidates are unassessed evidence; neither an empty nor a nonempty array establishes corpus answerability. Empty can mean lexical mismatch, query/filter restrictions or no indexed candidates. The engine does not classify these causes in a new result envelope.

The maintained [host example](../examples/evidence.mjs) preserves candidates and uses the example-local label `answerability: 'not-assessed'` for both `retrieved` and `no-results`. It propagates failures/abort, adds no inference or caching, and observes only whether the index revision changed during search. A false overlap flag is not a source-freshness guarantee. These fields are not exported engine/result types. Hosts can perform separate evidence verification, but this package neither implements nor certifies a host assessment. See [ADR 0003](decisions/0003-retrieval-evidence-boundary.md) and [the design record](https://github.com/the-leumas/provena/blob/main/docs/alpha6-answerability.md).

## Incremental refresh

`SourceDocument.revision` is an optional opaque source-owned token. It must change
whenever content or metadata consumed by a parser changes. A matching token can
reuse the catalog and passages under compatible parser/chunker configuration.
Absent tokens always read/parse; `modifiedAt` alone is never treated as a token.
The filesystem adapter supplies a high resolution stat-based token while retaining
its containment, symlink, size and file-type admission checks.

`initialize` and `refreshSource` accept `RefreshOptions`: `verifyContent: true`
bypasses revision reuse, and `onDocument(event)` reports source/document identity,
`disposition` (`reused` or `parsed`), `completed`, `total`, and that document's
`passages`. Callback errors and cancellation before publication abort the refresh.
Progress describes candidate work, not a committed index.

`RefreshReport` includes `documentsRead`, `documentsParsed`, `documentsReused`,
`documentsDeleted`, and `persistence` (`saved`, `unchanged`, `preserved`, `none`),
alongside the existing passage/vector counters. Identical complete snapshots skip
writes. A lexical-only engine preserves an existing vector-bearing store while
committing its lexical replacement in memory. Subsequent semantic refreshes
reconcile that stored snapshot against current revisions.

Schema 3 adds optional `documentRevisions` records keyed by source/document.
Older schema-3 snapshots without these records bootstrap with one read/parse pass
while retaining compatible vectors. Model/input changes invalidate vectors
independently of passage compatibility. Revision checks are not a content audit;
hosts may request explicit verification and still verify current search evidence.
