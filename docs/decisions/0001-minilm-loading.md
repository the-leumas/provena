# ADR 0001: Optional MiniLM inference and host-owned offline deployment

Status: accepted. Date: 2026-09-13. Applies to alpha.3 and Transformers.js 4.2.0. Alpha.4 retrieval behavior is documented separately in [ADR 0002](0002-retrieval-modes.md); loading decisions here remain in effect.

## Context and evidence

The root is universal retrieval infrastructure. Real sentence embeddings must not introduce a model runtime, filesystem location or worker topology into core consumers. Alpha.2 already supplies transactional indexing and persistence; alpha.3 adds inference while search stays lexical.

The initial real CPU run with pinned MiniLM passed dimensions, normalization, semantic sanity and lifecycle reuse. Strict cached-offline acceptance then found upstream 4.2.0 metadata probes that ignore revision, cache and local-only options. `pipeline()` calls metadata discovery without those options; `loadTokenizer` calls `get_tokenizer_files(modelId)`, which probes `tokenizer_config.json` with an empty options object. A complete revision-specific Hub cache did not make that probe resolve offline. The resulting tokenizer load failed. This was exposed by real inference, despite passing offline adapter mocks.

Evidence is in the installed stable npm sources: `src/pipelines.js`, `src/tokenization_utils.js`, and `src/utils/model_registry/get_tokenizer_files.js` of `@huggingface/transformers@4.2.0`. The cached-offline limitation remains an explicit opt-in acceptance case, not a failure of the accepted staged-assets contract.

## Decisions

- Export `MiniLMEmbedder` only from `/minilm`; use exact optional peer `@huggingface/transformers@4.2.0` and the same development version. Root imports and built-package core-only installation require no model runtime. Source/Git builds install development dependencies; use the built tarball for core-only installation without those build dependencies.
- Pin `Xenova/all-MiniLM-L6-v2` to `751bff37182d3f1213fa05d7196b954e230abad9`. Embedder identity includes model, revision, runtime/adapter version, device, dtype, pooling, normalization and tokenizer truncation policy. Batch size/cache location do not affect identity.
- Use stable public tokenizer/model loaders and `FeatureExtractionPipeline`. This avoids factory preflight, but does not claim to repair tokenizer discovery. Do not patch upstream code or use private runtime imports.
- Ordinary online/cached Hub-ID loading is supported. `cacheDir` is a cache location. `localFilesOnly` forwards the runtime option; neither guarantees zero network access for Hub IDs in 4.2.0.
- Strict offline deployment requires host-staged model assets. The host configures `env.localModelPath`, enables local loading, disables remote loading, and supplies backend/WASM assets where required. The adapter never mutates runtime globals or spawns workers. Host staging must bind immutable local bytes to the declared model/revision; upstream ignores revision for local file resolution.
- The concrete adapter owns lazy loading, serialized calls, batches (default 4), finite 384-dimensional unit Float32 vectors, and terminal asynchronous disposal. Hosts own execution placement and adapter lifetime. Cancellation checks boundaries; it cannot preempt native loading/inference already running.
- Embedding input version 1 includes content-derived headings for continuation chunks, avoids duplicating initial Markdown headings, and excludes provenance paths. Exact constructed input governs reuse. Snapshot schema 3 includes the input version; alpha.2 snapshots rebuild. Generic core supplies unique missing inputs once; each embedder owns batching.
- Alpha.3 included no semantic ranking, query retrieval, RRF, consumer integration or new storage subsystem. Alpha.4 subsequently adds retrieval as recorded in ADR 0002.

## Consequences and verification

Hosts may share a model between engines and must dispose it explicitly. Mutable Hub aliases or replacing staged bytes without changing revision weakens reproducibility. A staged deployment using the same model/revision and settings can retain the same embedding identity as Hub loading, provided the host supplies those exact bytes.

`npm test` stays model-free. `npm run test:minilm` runs isolated online/cached Hub, strict staged-assets, and known-limited cache-only probes. Staged acceptance disables caches and remote loading and traps fetch calls; it must complete real inference with zero network attempts. Both supported modes run semantic sanity and lifecycle reuse assertions. Exact observed results and platform limitations belong in [evaluation](../evaluation.md); deployment examples belong in [integration](../integration.md).

## Documentation policy

Every implementation change and accepted behavioral/architectural decision must update the relevant repository docs and README in the same work. Use ADRs for durable choices and general docs for current behavior. Local planning files are supplementary, ignored, and never the sole record of decisions or guarantees.
