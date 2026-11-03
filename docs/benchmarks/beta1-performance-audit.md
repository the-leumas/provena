# Provena 0.1.0-beta.1 performance audit

> Historical measurement record from 2026-10-10. The recorded values are observations from that run, not current regression thresholds.

**Judgment:** a consumer performing the same fresh CPU/fp32 index will experience approximately the CLI's latency. A consumer retaining its engine or supplying compatible storage will avoid nearly all subsequent document inference. The default CLI repeats that expensive work on every invocation. Initial inference is the dominant cost, but padding, filesystem admission, and allocation behavior present concrete optimization opportunities. No indexing redesign or retrieval change is justified before 0.1.0-beta.1.

Measured on 2026-10-10, against library commit `e12ce28a9564dd82e18382badbf3d91e5305d83a` and the CLI implementation at that time. CLI persistence was measured separately during this audit. Production library code and the original corpus were not changed.

**Environment and method**

Linux 6.14, Node 24.21.0, npm 11.19.0; Intel i5-8350U, four physical/eight logical cores; 7.8 GiB RAM. The desktop was active, approximately 2.8 GiB RAM was available initially, and swap already held 2.2 GiB. These are characterization results, not isolated-machine SLA measurements. Early small runs overlapped brief non-model tests; one middle run overlapped the bounded synthetic diagnostic. Repeated eight-file pairs provide a check on that noise.

Real `@huggingface/transformers@4.2.0` / ONNX MiniLM-L6-v2, revision `751bff37182d3f1213fa05d7196b954e230abad9`, CPU/fp32, batch size four, 384 dimensions. Both routes used the **same staged absolute model path**, source bytes, source ID, query `refreshSource`, limit three, and default chunking (1,600 characters, two overlap lines). No external content was indexed; remote models were disabled and fetch was blocked. Models were disposed between benchmark processes.

The harness uses published `provena`, `@theleumas/provena/filesystem`, and `@theleumas/provena/minilm` entrypoints. The CLI route executes the current `runSearch` and measures `renderRun` separately. Shell/Node startup, terminal writes, and optional evidence-output publication are excluded from its internal timings. A temporary loader times internal stages without editing source or built files; it and all copied/generated corpora and indexes are removed automatically. RSS uses the OS process high-water mark; heap/buffer maxima are sampled every 10 ms and at stage boundaries. These can miss brief peaks. RSS includes native runtime/model memory, not just JavaScript. GC and event-loop lag cover the complete child lifecycle rather than one inference stage.

Reproduce from the repository, with the pinned fp32 assets already in `.cache/minilm`:

```sh
npm run build
node docs/benchmarks/beta1-audit.mjs --output=/tmp/beta1-audit.json
node docs/benchmarks/beta1-audit.mjs --persistence-only --output=/tmp/beta1-cli-persistence.json
node docs/benchmarks/beta1-audit.mjs --shape-only --output=/tmp/beta1-shape.json
node docs/benchmarks/beta1-operations.mjs > /tmp/beta1-operations.json
node docs/benchmarks/beta1-model.mjs > /tmp/beta1-model.json
node docs/benchmarks/beta1-model.mjs --confirm > /tmp/beta1-model-confirm.json
```

Recorded results: [matched indexing](beta1-audit.json), [current CLI persistence](beta1-cli-persistence.json), [file-count control](beta1-shape.json), [admission/file shape/retrieval scaling](beta1-operations.json), [batch probe](beta1-model.json), [warmed confirmation](beta1-model-confirm.json). Corpus manifests record file paths and byte sizes. Reproduction after edits may change corpus counts. The historical harness label `mixed24` actually contains **20 files**; counts below use measured values.

**Execution path and ownership**

The repository CLI now lives in [cli/cli.mjs](../../cli/cli.mjs). The CLI resolves options/model assets and prepares the runtime **before** its indexing timer. It creates a new engine, wraps the filesystem source to record hashes/counts, observes the canonical parser, and wraps MiniLM to report completed four-input batches.

[refreshSource](../../src/engine.ts) loads and validates optional storage once, lists the complete source, then serially reads, parses, chunks, hashes, and catalogs each admitted document. Only after **all documents** are staged does [embedChunks](../../src/index-state.ts) derive heading-aware inputs, deduplicate exact strings, and reuse existing/seed vectors. The embedder performs missing inference; the engine validates/copies vectors, constructs candidate maps, optionally builds/saves a snapshot, then atomically publishes the source. There is no separate lexical inverted-index or ANN construction phase.

[FileSystemFolderSource](../../src/adapters/filesystem.ts) owns filesystem traversal, path/symlink containment checks, extension/size admission, checked reading, UTF-8 decoding, and read-race checks. [ParserRegistry](../../src/parsers/index.ts) normalizes text and extracts Markdown headings/sections/links; code parsing preserves line structure rather than building an AST. [chunkDocument](../../src/chunking.ts) owns passage creation, overlap, and BigInt content hashing.

[search](../../src/engine.ts) never discovers, reads, or refreshes sources. It collects filtered candidates, performs lexical ranking and/or query inference and exact cosine ranking, fuses complete rankings for hybrid, then applies the result limit. The CLI subsequently reopens **each result**, validates its content hash and passage lines, selects excerpts, and renders terminal output. Those verification/presentation costs belong to the CLI, not retrieval.

**Stage breakdown**

Representative matched fresh index: 20 files / 189,135 bytes / 185 passages / 185 unique inputs. Times are milliseconds and nested model load is separated from document inference here.

| Stage | CLI | Public API, no storage |
|---|---:|---:|
| Filesystem scan + metadata/size admission | 16.85 | 13.56 |
| Checked reads + UTF-8 content admission | 44.89 | 40.46 |
| Canonical parsing | 8.79 | 8.58 |
| Passage creation + content hashing | 42.44 | 31.96 |
| MiniLM initialization, inside first embed call | 474.05 | 483.23 |
| Document embedding after initialization | 29,113.19 | 27,148.69 |
| Input dedup + vector validation/copy/mapping, excluding embedder | 3.71 | 5.95 |
| Snapshot construction | 11.48 | 0 |
| Other engine/wrapper/validation/commit work, residual | 11.85 | 7.29 |
| **Complete indexing** | **29,727.25** | **27,739.70** |

The dedup/copy row is explicitly combined: a later precise probe isolated input preparation/dedup at **1.26 ms for 115 fresh inputs**, and **0.59 ms on restored inputs**. These are a different run, not components to add to the table. Scan/read admission includes security and format checks; pure directory enumeration and decoding alone were not isolated.

For the 20-file CLI, source verification cost 59.66 ms across its three searches; measured rendering cost roughly 50 ms on the repeated eight-file CLI. The CLI's transient storage observer forces full snapshot construction, including conversion/cloning of vectors, even when nothing is persisted. Direct consumers without storage avoid it. This cost is real but does not explain tens of seconds of initial indexing. About **99%** of fresh indexing elapsed inside the model/embedding path. Parsing throughput was about 21–22 MB/s and chunk/hash throughput 4.5–5.9 MB/s on this small fixture; checked reads approximately 4.2–4.7 MB/s include per-file syscalls, not disk bandwidth. These rates are descriptive, not extrapolation guarantees.

**Scaling and reuse**

| Corpus | Files / bytes | Passages / unique inputs | CLI full index | API full index | Peak RSS CLI / API | Warm API lexical / semantic / hybrid median |
|---|---|---|---:|---:|---:|---:|
| Markdown subset | 8 / 111,302 | 115 / 115 | 17.04–18.51 s | 17.32–17.48 s | 489–490 / 494 MiB | 1.45 / 8.60 / 7.71 ms¹ |
| Root Markdown docs | 12 / 152,423 | 154 / 154 | 20.30 s | 24.27 s | 503 / 516 MiB | 1.75 / 6.92 / 9.12 ms |
| Markdown + top-level TS | 20 / 189,135 | 185 / 185 | 29.73 s | 27.74 s | 512 / 532 MiB | 2.96 / 8.93 / 9.45 ms |

¹ First matched API run; warm medians use three repetitions after the first query per mode. API RSS includes extra repeated searches and refresh, so RSS differences do not isolate CLI overhead. Batch inference after model load delivered roughly **6.4–7.8 unique inputs/s** on these corpora. Passage length, tokenizer length, padding, and CPU conditions matter more than file count alone. The original 98-passage/64-input and 616-input observations were not reproduced with their original folders; their exact times cannot be attributed from counts alone.

With identical 16 section inputs (18,972 total input characters), one file versus 16 files cost 5.35 versus 19.77 ms scanning and 2.67 versus 41.68 ms reading. Embedding itself varied 1.44–2.27 s, so the total difference must not be assigned to file count. A separate approximately 1 MiB text test produced **one 1,048,576-character passage** for a single line, versus 737 passages of at most 1,595 characters for many lines. Chunk/hash cost was 194 versus 244 ms. `targetChars` is a soft, line-preserving target; it does not bound individual passage size. MiniLM truncates at 512 tokens while stored/searchable passage text remains complete.

| Reuse path | Measured work |
|---|---|
| Same live engine, unchanged 185-passage refresh | 164 ms; zero document embeddings; still scans/reads/parses/chunks |
| File storage, first 185-passage index | 30.05 s; 185 embeddings; snapshot 1,783,013 bytes |
| File storage, fresh process restoring unchanged corpus | 463 ms; zero document embeddings; load/JSON parse 56 ms, validation/clone 65 ms, snapshot creation 24 ms, serialization/atomic save 128 ms |
| Same live engine with file storage, unchanged refresh | 204–218 ms; zero document embeddings; snapshot rewritten |
| Latest CLI `--save-index`, 115 passages | First 21.94 s; restarted unchanged 230 ms; zero document embeddings on restart |
| First semantic query after API restore | 677 ms, including 647 ms lazy model load; subsequent semantic queries 9–12 ms |
| First semantic query after CLI restore | 652 ms, including 604 ms lazy model load |
| Public `createSearchSession`, completed repeated hybrid query | 0.13–0.21 ms; no inference/ranking on cache hit |

Model initialization occurs once **per MiniLM instance** and is reused for all batches/queries. Cached/staged assets avoid downloads, not pipeline initialization. “Cold” here means a fresh process/pipeline with already-staged assets; first download and cold OS page-cache loading were not measured. There is no source-free public snapshot hydration, unchanged-file read/parse bypass, persistent query cache, watcher, or partial-source refresh API. Changed sections and renames reuse exact compatible vectors through existing refresh/storage APIs; lifecycle tests verify this. Snapshot incompatibility rebuilds; changing the absolute model path changes MiniLM identity even with identical weights. Stable host configuration matters.

Retrieval also scales: synthetic 384-dimensional vectors, 1,000 → 10,000 candidates, warmed public API medians were lexical **4.7 → 37.1 ms**, semantic **17.0 → 116.5 ms**, hybrid **16.6 → 214.5 ms**. These exclude real query inference. Exact cosine validates/recomputes norms on every search; lexical search lowercases/scans bodies and computes eligible-corpus term frequencies each time; full sorting/fusion precedes limiting. Complexity includes corpus scanning and O(N log N) ranking, not O(limit). The synthetic fixture's 85 → 287 MiB peak RSS includes a second component fixture and two vector copies, so it is not a core-only memory estimate.

**Embedding efficiency and operational findings**

| Finding | Classification | Evidence / implication |
|---|---|---|
| Default CLI rebuilds and disposes each invocation | **CLI overhead** | No default index retention. Latest optional `--save-index` / `--index-location` removes repeated document inference. |
| Sequential batches, not individual sequential inputs | **Expected computational cost** | Core submits unique missing inputs once; MiniLM serializes calls and runs four-input batches. ONNX uses multiple CPU threads (about 350% process CPU observed); serialization does not imply one CPU core. CLI uses the same native batch shape with extra callbacks/arrays. |
| Length mixing wastes padded inference | **Library inefficiency** | Runtime pads to longest input in each batch. Warmed, alternating-order confirmation: four 9-token + four 512-token inputs took median 2.16 s interleaved versus 1.10 s grouped, with identical returned vectors on this probe. Batch eight did not improve throughput; real-corpus benefit remains unmeasured. |
| Exact duplicates and unchanged content | **Expected computational cost, already avoided** | Heading-aware exact-string deduplication works. No path in reuse keys; repeated identical content shares vectors, including renames. No evidence of redundant same-input inference inside one refresh. |
| Per-file maximum-size read buffers | **Library inefficiency** | Every default adapter read allocates 2 MiB + 1 even for tiny files. Checked reads repeat for refresh and CLI result verification. Buffer churn is visible: sampled array-buffer peak reached 81 MiB in the 20-file API lifecycle. |
| Expensive admission of irrelevant tree entries | **Library inefficiency** | Containment checking precedes extension rejection; 101/1,001 encountered entries with one admitted file cost 54/521 ms. Hidden/dependency directories are traversed. Latest CLI filters index artifacts only after adapter listing, so it still pays traversal cost. |
| Full refresh, snapshots, and synchronous ranking | **Expected computational cost; optimization opportunities** | Atomic source staging retains old+new records; missing input strings/output vectors are fully buffered; compatible snapshots are fully validated/cloned and saved again. CLI snapshot observation adds unnecessary persistence-format work. No sustained GC bottleneck observed: roughly 0.10–0.17 s cumulative GC versus 17–30 s indexing. |
| No total job or queue capacity bound | **Library inefficiency / operational limitation** | Filesystem has a per-file cap, but no file-count/total-byte cap. Custom sources and MiniLM text arrays have no size cap. Calls queued on MiniLM retain copied input arrays without backpressure. Engine mutations reject overlap, but arbitrary concurrent queries/embedder callers can grow the queue. This is capacity growth, not a demonstrated leak. |
| Responsiveness/cancellation | **Expected native limitation + library synchronous work** | Complete runs showed 0.9–1.3 s maximum event-loop lag. Abort dispatched after 13 ms rejected only after the active native batch finished: 0.80–1.04 s elapsed, 0.79–1.03 s after abort. Parser/chunker/hash/snapshot/ranking loops do not yield to timers. CLI SIGINT exits 130; it does not propagate an AbortSignal for graceful disposal. |
| Run-to-run variance and larger-corpus exhaustion | **Environment limitation / unresolved** | Active laptop, memory pressure and timing variation limit precise deltas. No OOM in bounded tests. No enormous private folder run, sustained leak test, mobile/worker certification, q8/GPU benchmark, or download timing was attempted. |

Errors in discovery/read/parser/model/vector validation/storage reject refresh and preserve the previous committed source; corrupt compatible snapshots fail explicitly. No partial usable index is published midway through a large refresh. Intermediate successful inference from a failed refresh is not persisted, so retry may repeat it. During an update, searches can use the captured previous index; semantic queries sharing an adapter can wait behind its inference queue. There is model-load progress in MiniLM, but no core scan/chunk/document-inference progress API. The CLI supplies those observations. Its read/parse phases alternate per document, its “chunking complete” event occurs **after indexing**, and its spinner elapsed time is cumulative from CLI progress creation, not embedding-only time.

`--compare` indexes **once**, enables document embeddings even when `--mode lexical`, then searches lexical/semantic/hybrid on that index. Semantic and hybrid each embed the query, so comparison does two query inferences and multiple result rechecks. A lexical-only run creates no model or document vectors. Comparing their total costs as equivalent lexical workloads is invalid. Reported passages are committed chunks; “unique inputs” is the number of **new missing embedding texts**. On a restored index it is zero even though the corpus has many unique inputs. `reusedVectors = passages - embeddedTexts` also includes same-run duplicates, not only prior-index reuse. Model-load time is nested in first document or query inference; indexing includes snapshot/save, while CLI `totalMs` excludes final rendering, stdout writing, and `--output` publication.

**Recommended order and 0.1.0-beta.1 decision**

1. **Before 0.1.0-beta.1: make the lifecycle distinction explicit in the CLI/docs.** Highest practical impact, low complexity/risk: retain the current opt-in persistence path, show new versus reused input counts and first-query model loading clearly, and document full-refresh reconciliation and scope selection. Verify two invocations with the same source/options embed zero documents on the second; changed-section and rename cases must retain provenance. The newly added persistence path already meets the main latency objective in the measured runs; do not credit it as an audit implementation.
2. **Before 0.1.0-beta.1: document soft chunk targets and operational limits.** Low complexity/risk. A 2 MiB file cap is not a corpus or passage cap, and native cancellation is delayed. Recommend deliberate source roots and host-owned worker/process placement for responsive applications, using existing contracts. Do not advertise “millisecond search” without corpus/mode context.
3. **Next measured optimization: adapter batch packing/tuning.** Potentially largest remaining initial-index benefit; moderate complexity and correctness risk. The cause is demonstrated padding. Validate on the recorded Markdown/code corpora, preserving positional output mapping, vectors, cancellation, and ranking results; compare 1/4/8 batches, latency, peak RSS, and long-input truncation. The probe's ~2× gain is not a promised corpus-wide gain. Do not add concurrency or change defaults from this audit.
4. **Then reduce avoidable filesystem work.** Low-to-moderate complexity/risk: size read buffers from the observed file size with a bounded growth/race check; reject unsupported non-directory entries before expensive path resolution while preserving symlink/containment protections. Expected benefit is lower allocation pressure and faster scans of irrelevant files, not tens of seconds saved on these admitted corpora. Verify race/growth/binary/UTF-8 tests and the 101/1,001-entry and file-count controls.
5. **Defer snapshot and ranking optimization until workload targets require it.** Snapshot conversion costs 8–24 ms here; serialization/save dominates restored persistence cost. Norm/lowercase reuse or top-k schemes could improve larger searches but carry compatibility/relevance risks. Benchmark target corpus sizes and exact result equivalence before implementing; no ANN or architecture rewrite is supported by these measurements.

Build passed. Historical verification at the time of this audit (2026-10-10) reported 43 passing tests with three opt-in real-model tests skipped. Subsequent storage/CLI checks passed nine tests; the CLI persistence checks passed seven. Separate real MiniLM tests passed for both comparison ranking/count equivalence and persisted restart/rename reuse, with network blocked. No production optimization, dependency, public API, corpus edit, or ranking change was made. Temporary loaders, generated/copy corpora and index files were removed; only this report and reproducible diagnostic artifacts remain.
