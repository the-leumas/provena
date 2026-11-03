# Alpha.5 hardening and release record

> **Historical record.** This document describes the Alpha.5 release at the time of evaluation. See the [README](../README.md) and [changelog](../CHANGELOG.md) for the current 0.1.0-beta.1 contract.

**Historical verdict: READY FOR EXPERIMENTAL USE. Version at the time: `0.1.0-alpha.5`.** Keep Alpha rather than promoting to `0.2.0-beta.1`. Retrieval quality is now characterized on a broader authored corpus, atomic failure behavior is stressed, exact-search cost is measured through 100k candidates, and installed consumers run in a real browser/worker. Independent relevance review and a practical no-answer contract remain unresolved; one browser/backend/laptop is not general portability or production certification.

## Scope and changes

The current Alpha.4 code, tests, docs, decisions, packaging and CI were reconstructed before editing. Sources, parsing, chunking, index publication, exact-input embedding reuse and MiniLM ownership remain unchanged. So do lexical scoring, generic exact cosine, complete-channel RRF k=60, hybrid-with-embedder defaults, snapshot schema 3, embedding-input version 1 and the three public exports. There is no new retrieval feature or production dependency.

Two cache bugs were reproduced on the unchanged Alpha.4 implementation before correction:

1. Equivalent reordered/duplicated source, tag and extension sets produced extra query inference. Cache keys now canonicalize these sets, including extension case/leading-dot equivalence and absent undefined filter values. Actual filter semantics are unchanged.
2. Clearing a pending query allowed its later result to repopulate the cache. A clear-generation marker prevents insertion from older pending calls; their original callers still receive results. It does not cancel model work.

Everything else is hardening, evaluation, documentation, examples or development tooling. Esbuild 0.25.5 and Playwright 1.62.1 are exact **development dependencies** for real installed-browser validation. Transformers.js remains the same optional exact 4.2.0 peer. Core has zero runtime dependencies/imports of host or model APIs. Internal instrumentation imports repository ranking helpers only from scripts; no diagnostic score or internal module became a package export. Existing ADRs remain authoritative; the cache amendment extends the existing retrieval decision rather than adding a new architectural layer.

## Robustness reconciliation

The final offline suite passes **75/75**: 64 existing regressions plus nine hardening and two evaluation tests. Existing tests were retained instead of duplicated just to raise the count.

| Requirement group | Evidence and finding |
| --- | --- |
| Empty sources, non-indexable/blank documents | New hardening tests: no candidates, no document/query inference, empty persisted/restarted state. |
| Deletes, renames, source removal, repeated refresh | Existing lifecycle/foundation tests plus new real-file rename/delete/empty restart; current provenance reconciles, old paths disappear, exact input reuse survives. `removeSource` remains memory-immediate, durable on a later successful refresh. |
| Duplicate document IDs, identical chunk text/inputs | Existing foundation/lifecycle/input regressions reject duplicate IDs and deduplicate inference by exact versioned input, without merging distinct provenance. |
| Unicode/non-Latin/emoji | New Japanese/Arabic/Cyrillic/café path/title/content/query tests preserve provenance and restart reuse. Emoji-only lexical queries have no terms; semantic mode remains usable. This proves data handling, not multilingual MiniLM quality. |
| Large/awkward documents | New source-line coverage tests use 300 repeated/deep headings, 10k code lines, a 350k-character CJK line (about 1.05 MB UTF-8), 1000 malformed frontmatter lines and an unclosed frontmatter block. Closed frontmatter stays raw/excluded from body; unclosed content remains visible. Single huge lines are not split. No chunker redesign; MiniLM tokenizer truncation still limits how much of a huge chunk is embedded. |
| Parser/registry behavior | All registered uppercase extensions preserve parser/language mappings; existing unknown/binary/fallback tests and generated file-type check pass. Structured config is text, not a validating parser. |
| Source list/read, parser/chunker, document/query embedder failures | Existing lifecycle/retrieval failures retain old committed state and do not cache failed searches. New tests exercise unchanged behavior during repeated concurrent schedules. |
| Cancellation | Existing checks cover pre-search abort, load/list/read/inference/save, semantic candidate/cosine/fusion loops and abort after publication. No partial candidate commit. Successful atomic publication remains the commit point; active synchronous loops/native inference are not preemptively interruptible by same-thread timers. |
| Search overlapping refresh | Twenty controlled schedules per new regression hold query inference across refresh, begin another search while save is pending, publish the new generation, then release queries. Both old searches return one consistent old view, never mixed vectors/chunks. A subsequent cached query sees the new revision; source removal empties results. |
| Cache isolation | Existing tests cover mode/default equivalence, different sources/filters/limits, failed/aborted queries, mutation-safe copies, bounded eviction and revision invalidation. New tests cover set ordering and pending clear. No global/pending-query coalescing cache was added. |
| Snapshot compatibility/corruption | Existing tests cover schema/parser/file-type/chunker/config/input-version/embedder ID/dimension incompatibility and corrupt compatible shapes. New file tests cover harmless unknown future fields, truncation, rename/delete and empty restart. Malformed JSON and I/O errors surface; incompatible snapshots rebuild rather than mix state. |
| Atomic replacement failure | New failure injected at the filesystem canonical `rename`: old canonical bytes, live revision and search remain intact; temporary sibling is removed. Existing write/serialization/abort failures also pass. This does not claim directory-fsync/power-loss durability or multi-process locking. |

These are controlled invariant tests, not random stress fuzzing or OS-level adversarial filesystem certification. No robustness finding required a source/index redesign.

## Retrieval and no-answer evidence

The fixed host-neutral fixture has 64 documents, 72 chunks, 50 queries and explicit document grades/rationales across ten classes. Forty queries are answerable; ten are negative/near-miss. Judgments were authored from corpus facts before model scoring, not inferred from rankings, but have not been independently expert-reviewed. All P@5/@10, Recall@5/@10, MRR and nDCG@5/@10 aggregates, class breakdowns, per-query ordering and top-cosine distributions are in [evaluation](evaluation.md) and the structured record (`docs/benchmarks/alpha5-retrieval.json`).

Answerable document-level Recall@5 is 0.6417 lexical / 0.8688 semantic / 0.8479 hybrid. Semantic wins natural-language/noisy cases; hybrid helps known terminology and multi-evidence questions. Hybrid defaults remain a defensible mixed-workload compromise, not a claim of universal superiority. Representative failures are documented without changing RRF or tuning lexical scoring.

All modes return irrelevant evidence for every no-answer query. Near-miss top cosine overlaps answerable results (up to 0.6632); a requested measured backup time is absent despite a highly similar general runbook. Ranks are not confidence. Raw cosine stays evaluation-only because a new score API alone would not solve answerability. No global threshold or automatic routing was added. The next direction is **retrieval quality/answerability design**, with held-out judgment review before any scoring/public-contract change.

The preserved tiny lexical baseline still returns Recall@5/@10 0.9167/0.9167 and avoids one duplicate query; lifecycle inference remains **3/0/1/0/0**. Deterministic representative evaluation validates mechanics only. Actual quality uses the optional real model from staged assets; it passed with zero fetch attempts.

## Scale and latency

The scale record (`docs/benchmarks/alpha5-scale.json`) reports 1k, 10k, 50k and 100k candidates at 384 dimensions, two warmups and five measured runs in isolated processes. Median lexical/semantic/hybrid totals are approximately 4.35/9.30/16.58 ms at 1k, 24.81/113.56/201.95 ms at 10k, 131.87/427.29/743.43 ms at 50k and 245.82/791.79/1437.57 ms at 100k. Independent cosine/RRF component measurements and memory ranges are preserved. At 100k peak process RSS is about 1.36 GiB, including indexing and the duplicate evaluation fixture/vector representations; it is not core-only memory.

This Linux i5-8350U laptop shows noticeable exact-search cost at tens of thousands of unfiltered candidates. Use explicit filters and host worker placement for interactive workloads. ANN is a future option only for demonstrated wide-scope scale needs; fusion itself is costly, so ANN alone would not remove all measured overhead. No universal latency limit or ANN dependency is introduced.

Real MiniLM warm inference is measured separately from cosine/fusion and cold loading. The full measurement method and hardware limitations are in evaluation. No timing thresholds were made into tests.

## Installed consumer and browser matrix

| Consumer | Local result |
| --- | --- |
| Node core, optional peer absent | Pass: isolated offline tarball install, ESM + declarations, custom source/store/embedder and all modes. Runtime absence is explicitly checked. |
| Node filesystem | Pass: installed example indexes an approved temporary folder and atomic file storage at a separate host path; original source/storage tests pass. |
| MiniLM subpath, peer present | Pass: installed export/declarations resolve with the locally provisioned peer; real inference is separate/opt-in. Core imports never load it. |
| Internal package paths | Rejected by exports; only `.`, `/filesystem`, `/minilm` remain public. `sideEffects: false`, no CommonJS export, no production dependency. |
| Actual Chrome page and module worker | Pass on Chrome **150.0.7871.124**: installed/bundled root, no Node globals, browser source, host memory storage, all modes, query cache and restart reuse. Both report two initial document inputs/four query calls across two engines. |
| Tree shaking | Minimal `isSupportedFile` browser bundle is 1,676 bytes; engine contributes zero emitted bytes to that minimal bundle. Full exercised worker bundle is 34,997 bytes. This is the tested esbuild configuration, not a universal bundle-size promise. |
| Optional real browser MiniLM | Pass on the same Chrome, WASM/fp32, one thread: 384-dimensional finite normalized query/document embeddings, semantic engine retrieval and completed disposal. Elapsed load/inference/retrieval/disposal smoke 3,772.565 ms. **Zero external requests**; local asset/backend HTTP fetches are expected. |
| Other browsers / WebGPU / offline PWA | Not tested/certified. The host still owns serving/cache/CSP/runtime assets and workers. No production IndexedDB/OPFS adapter was added. |

Browser MiniLM uses the installed public `/minilm` adapter with host-side runtime configuration, pinned locally staged model assets and local WASM/backend files. No adapter global mutation or runtime patch. Node strict offline staged loading retains the Alpha.3 zero-fetch contract; Hub-cache-only offline remains known-limited in Transformers.js 4.2.0. Online Hub acceptance was not rerun for Alpha.5: this campaign's real evaluation uses provisioned local assets and does not depend on Hub availability.

## Packaging, examples and CI

The MIT license, three ESM/type exports and optional-peer semantics were verified at the time of this historical report. This record describes the Alpha.5 package state; it is not the current release. The tarball includes docs and maintained [examples](../examples/README.md) for lexical core, custom source/storage/embedder, filesystem and MiniLM lifetime. The examples are readable consumer code, not extra exported internals. At the time, source/Git installation built with development dependencies; core-only consumers wanting no model runtime should use the built tarball.

The CI configuration preserves Node 20/22 typecheck, offline tests and npm pack (including generated registry docs checks and installed JS/types smoke). Node 22 additionally runs deterministic representative evaluation. A separate Node 22 browser-core job installs Playwright Chromium and runs the model-free browser/worker tarball harness. It downloads a browser, not model weights. Real MiniLM and the full 100k scale campaign remain explicit opt-in work. Local validation used Node 26.4.0; the new remote CI jobs are configured, not claimed to have run locally on Node 20/22.

## Final validation and requirement reconciliation

- Full offline suite: **75 passed, 0 failed**; strengthened source-line assertion also passes its focused hardening rerun.
- Strict typecheck, clean production build, generated registry documentation, original lexical/lifecycle/three-mode benchmark: passed.
- Deterministic representative harness and real staged MiniLM representative harness: passed; recorded quality outputs repeat across reruns.
- Exact scale: completed 1k/10k/50k/**100k**, no real model inference used.
- `npm pack`, offline installed core/filesystem/MiniLM export/type tests, optional-peer absence and internal-export rejection: passed.
- Actual installed browser page/worker core and optional MiniLM WASM acceptance including disposal: passed.
- Root/browser import graph remains free of Node/Transformers/product dependencies; only cache code changed in production. Final diff review excludes unrelated code, model assets, local planning and generated dependency/output directories.

All requested classes, metrics, negative/near-miss distributions, default/RRF tradeoffs, scale, concurrency/cancellation/cache/snapshot edge cases, file registry consistency, examples/API docs and consumer/CI boundaries are addressed above or in linked evaluation. No production browser store, watcher, ANN, reranker, routing, UI or product integration was added. The current result type still serves ranked evidence; a no-answer API is a future design question rather than a silent Alpha.5 breaking change.
