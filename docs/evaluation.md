# Retrieval evaluation

> **Historical measurement record.** The Alpha.5 and Alpha.6 figures below were collected before the 0.1.0-beta.1 candidate-scoped IDF weighting in lexical retrieval. They are useful baselines, **not current 0.1.0-beta.1 metrics**. Re-run evaluations on the release revision before quoting updated ranking results; see [CHANGELOG](../CHANGELOG.md).

## Alpha.6A+B: chunk relevance and evidence sufficiency

Alpha.5 data below is historical. Alpha.6 layers separately authored development judgments over the same 64 documents/72 chunks/50 queries. The exact-text manifest and task interpretations are checked into `tests/fixtures/evidence/`; they are not independent/held-out validation. Five previously broadly relevant queries are explicitly underspecified, leaving 35 supported tasks and ten unsupported requests. No old grades or benchmark figures were rewritten.

Relevance grades concern chunks. Sufficient alternatives are sets of chunks (OR between sets, AND within a set), so individually contextual parts can jointly satisfy a multi-evidence requirement. Sufficient-set hit@K asks whether at least one complete set is within K raw returned chunks; set reciprocal rank uses the first completing position. Unsupported and underspecified sufficiency metrics are null. These are offline human-readable development judgments, never engine predictions.

| Mode | Chunk relevance P@5 / @10 | Chunk relevance R@5 / @10 | Sufficient-set hit@5 / @10 | Set reciprocal rank |
| --- | --- | --- | --- | ---: |
| Lexical | .2229 / .1514 | .4805 / .6400 | .6286 / .8000 | .5744 |
| Semantic | .3829 / .2314 | .7705 / .9010 | .8857 / .9714 | .6817 |
| Hybrid | .3486 / .2029 | .7238 / .8076 | .8857 / .9714 | .7183 |

Every recorded Alpha.5 per-query document metric has zero delta. These development metrics do not claim an improvement: different units/requirements explain differences from document recall. Wrong-flow OAuth illustrates this: missing a redundant implementation document lowers document recall even when a returned contract chunk is sufficient. Conversely, a related recovery-verification section or payment JSON may lack the mechanism required by a broader task. Multi-evidence tasks can fail despite several high-ranked relevant chunks.

All modes still return candidates on the ten unsupported requests. The report chunk for the absent dated backup measurement has cosine .6632; it only instructs operators to record time. No rejection/classification improvement is claimed. Chat restoration is semantic #1/hybrid #10; exhausted-job destination is semantic #1/hybrid #7; hybrid completes persisted-edit/rename evidence by #5 versus semantic #7. Exact-symbol sufficient-set hit@5 is 1.0 in all modes. Conceptual hit@5 is .4/.8/.6, noisy .4/1.0/.8, multi-evidence 0/.6/.8 (lexical/semantic/hybrid). Requirement interpretation is subjective.

```sh
npm run evaluate:evidence
npm run evaluate:evidence:minilm -- --staged --output=/tmp/alpha6-evidence.json
```

The first command is model-free mechanics. The second uses provisioned pinned MiniLM and asserts unchanged recorded document metrics. Structured evidence (`docs/benchmarks/alpha6-evidence.json`), [readable traces](https://github.com/the-leumas/provena/blob/main/docs/alpha6-evidence-traces.md) and [design/gate](https://github.com/the-leumas/provena/blob/main/docs/alpha6-answerability.md) record chunk text, ranks, internal cosine, full relevance nDCG, class breakdowns and sufficient-set assumptions. The labels are authored development annotations, not independent human review; held-out cases would be needed before treating them as validation. A/B real-model rankings, traces and all metrics are identical; staged inference made zero fetch attempts. At the time of this record (September 2026), validation reported 84 offline tests, typecheck/build, normal benchmarks/evaluations, npm pack and installed Chrome page/worker checks. Browser MiniLM was not rerun because its adapter was unchanged; the new helper was exercised with a deterministic browser embedder.

## Alpha.5: representative evaluation and scale

Alpha.5 preserves Alpha.4 lexical scoring, exact cosine, complete-channel RRF k=60 and mode defaults. It fixes two reproduced cache defects and adds measurement/portability coverage; it does not tune ranking or introduce a relevance cutoff. At the time, the offline suite had **75 passing tests**. See the [hardening/release record](https://github.com/the-leumas/provena/blob/main/docs/alpha5-hardening.md) for the robustness and package matrix.

### Reproduce

```sh
npm test
npm run benchmark                         # preserved original baselines, no model
npm run evaluate -- --output=/tmp/retrieval-mechanics.json
npm run evaluate:minilm -- --staged --output=/tmp/retrieval-minilm.json
npm run benchmark:scale -- --output=/tmp/retrieval-scale.json
npm run test:browser
npm run test:browser:minilm                # explicit, requires staged model assets
```

`evaluate` uses character bins only to validate the harness, not language quality. `evaluate:minilm` without `--staged` permits Hub network access. Staged evaluation requires the pinned assets described in integration. `benchmark:scale -- --quick` runs only 1k candidates. Browser commands require a provisioned Playwright Chromium or `BROWSER_EXECUTABLE`; they are separate from default offline tests. The MiniLM browser harness never downloads a model.

Structured measurement records: retrieval (`docs/benchmarks/alpha5-retrieval.json`), scale (`docs/benchmarks/alpha5-scale.json`). They include environment, dimensions, corpus hash, per-query metrics/order, class breakdowns, distributions and warm timing ranges. Full fresh output also includes raw chunk ranks/IDs. These are recorded observations, not timing assertions. Measurements used Linux x64, Node 26.4.0, Intel i5-8350U @1.70GHz, eight logical CPUs, about 7.61 GiB total RAM, on 2026-09-14 local time (2026-09-13 UTC). This is one laptop, not a controlled cross-hardware study; background load can affect timings.

### Corpus and judgments

The checked-in `tests/fixtures/representative/{corpus,queries}.json` contains **64 documents, 72 chunks and 50 queries**, ten classes of five. The fictional engineering handbook spans architecture, authentication/security, databases, operations/jobs, ML, project notes, APIs, code and configuration with overlapping distractors. Eight documents have multiple sections. Forty queries have answers; five unrelated negatives and five near misses deliberately have none.

Judgments are authored from corpus facts independently of engine scores, with explicit document IDs, rationale and grades (1 supporting, 2 direct). They were fixed before real inference; the SHA-256 corpus/query identity is in the measurement record. They have not had independent expert/user review. This substantially broadens the eight-document fixture but remains an authored engineering corpus, not a general-domain benchmark. No private data, product-specific relevance, agent traces or automatic ground-truth generation is used.

Metrics use **document-level first-occurrence deduplication before cutoffs**. P@K divides positive relevant hits by K, with missing positions counted as zero. Recall divides by all positive judgments. MRR uses the first relevant document across the full available ranking (all 72 chunks fit the API limit of 100). nDCG uses `(2^grade - 1)/log2(rank+1)`. Answerable aggregates are macro averages over 40 queries. No-answer recall/MRR/nDCG are undefined, not zero or perfect; their precision is zero and result behavior is reported separately. Precision is naturally limited when only one or two relevant documents exist.

### Real MiniLM quality

Same recorded corpus and queries for all modes; default pinned CPU/fp32 MiniLM, 384 dimensions, mean pooling/normalization, Transformers.js 4.2.0. No constants or lexical rules were tuned after results.

| Mode | P@5 | P@10 | R@5 | R@10 | MRR | nDCG@5 | nDCG@10 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| lexical | 0.2400 | 0.1475 | 0.6417 | 0.7812 | 0.7386 | 0.6184 | 0.6650 |
| semantic | 0.3300 | 0.1825 | 0.8688 | 0.9479 | 0.8725 | 0.8137 | 0.8413 |
| hybrid | 0.3250 | 0.1800 | 0.8479 | 0.9292 | 0.8600 | 0.7977 | 0.8296 |

All metrics by class (five queries per class):

| Class | Mode | P@5 | P@10 | R@5 | R@10 | MRR | nDCG@5 | nDCG@10 |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| exact-symbol | lexical | 0.3200 | 0.1600 | 1.0000 | 1.0000 | 1.0000 | 0.9433 | 0.9433 |
| exact-symbol | semantic | 0.3200 | 0.1600 | 1.0000 | 1.0000 | 1.0000 | 0.9348 | 0.9348 |
| exact-symbol | hybrid | 0.3200 | 0.1600 | 1.0000 | 1.0000 | 1.0000 | 0.9433 | 0.9433 |
| terminology | lexical | 0.2400 | 0.1200 | 1.0000 | 1.0000 | 1.0000 | 0.9928 | 0.9928 |
| terminology | semantic | 0.2000 | 0.1200 | 0.8000 | 1.0000 | 0.8333 | 0.7593 | 0.8306 |
| terminology | hybrid | 0.2400 | 0.1200 | 1.0000 | 1.0000 | 1.0000 | 1.0000 | 1.0000 |
| conceptual | lexical | 0.0800 | 0.0400 | 0.3000 | 0.3000 | 0.2669 | 0.2000 | 0.2000 |
| conceptual | semantic | 0.1600 | 0.1000 | 0.6000 | 0.7000 | 0.4800 | 0.4816 | 0.5225 |
| conceptual | hybrid | 0.1200 | 0.0800 | 0.4000 | 0.6000 | 0.4804 | 0.3866 | 0.4496 |
| mixed | lexical | 0.1600 | 0.1000 | 0.7000 | 0.9000 | 0.5700 | 0.5635 | 0.6213 |
| mixed | semantic | 0.2400 | 0.1200 | 1.0000 | 1.0000 | 0.7667 | 0.8262 | 0.8262 |
| mixed | hybrid | 0.2000 | 0.1200 | 0.9000 | 1.0000 | 0.8000 | 0.7750 | 0.8119 |
| ambiguous | lexical | 0.4800 | 0.2600 | 0.7333 | 0.8000 | 1.0000 | 0.6554 | 0.6686 |
| ambiguous | semantic | 0.5600 | 0.3000 | 0.8667 | 0.9333 | 1.0000 | 0.8248 | 0.8619 |
| ambiguous | hybrid | 0.5600 | 0.3000 | 0.8667 | 0.9333 | 1.0000 | 0.7883 | 0.8234 |
| noisy | lexical | 0.0800 | 0.0800 | 0.2000 | 0.5000 | 0.3500 | 0.2695 | 0.3604 |
| noisy | semantic | 0.3600 | 0.1800 | 1.0000 | 1.0000 | 0.9000 | 0.8408 | 0.8408 |
| noisy | hybrid | 0.2800 | 0.1600 | 0.8000 | 0.9000 | 0.7000 | 0.6987 | 0.7576 |
| negative | lexical | 0.0000 | 0.0000 | — | — | — | — | — |
| negative | semantic | 0.0000 | 0.0000 | — | — | — | — | — |
| negative | hybrid | 0.0000 | 0.0000 | — | — | — | — | — |
| near-miss | lexical | 0.0000 | 0.0000 | — | — | — | — | — |
| near-miss | semantic | 0.0000 | 0.0000 | — | — | — | — | — |
| near-miss | hybrid | 0.0000 | 0.0000 | — | — | — | — | — |
| multi-relevant | lexical | 0.3600 | 0.3000 | 0.5333 | 0.8833 | 0.9000 | 0.5774 | 0.7278 |
| multi-relevant | semantic | 0.5200 | 0.3200 | 0.7500 | 0.9500 | 1.0000 | 0.9021 | 0.9573 |
| multi-relevant | hybrid | 0.6000 | 0.3400 | 0.8833 | 1.0000 | 1.0000 | 0.8880 | 0.9326 |
| code-config | lexical | 0.2000 | 0.1200 | 0.6667 | 0.8667 | 0.8222 | 0.7452 | 0.8055 |
| code-config | semantic | 0.2800 | 0.1600 | 0.9333 | 1.0000 | 1.0000 | 0.9401 | 0.9562 |
| code-config | hybrid | 0.2800 | 0.1600 | 0.9333 | 1.0000 | 0.9000 | 0.9020 | 0.9181 |

The public API still returns chunks. Deduplicated document metrics can overstate evidence coverage for a host that consumes only the first K raw chunks. Raw top-5/top-10 chunk coverage, counting unique relevant documents in those slots, is **0.6333/0.7813 lexical, 0.8688/0.9479 semantic, 0.8417/0.9292 hybrid**. Across 50 raw top-ten lists there are 19/29/28 repeated-document chunk positions respectively. The harness retains raw ranks and duplicate counts; no engine deduplication feature was added. Historical eight-chunk fixture metrics below used raw chunk cutoffs, so compare only the unchanged historical baseline directly across releases.

### Complementarity and fusion failures

- Exact-symbol queries have Recall@5 1.0 in all modes. Known terminology favors lexical/hybrid (1.0 versus semantic 0.8); the expand-and-contract migration query is lexical/hybrid first but absent from semantic top five.
- Conceptual Recall@5 is 0.3 lexical, 0.6 semantic, 0.4 hybrid. For restoring conversations after restart, semantic places session persistence first; hybrid's top five instead contain backup, retention, OAuth, migration and audit material.
- Noisy Recall@5 is 0.2/1.0/0.8. For the failed-job question, semantic finds the answer but hybrid top five favor rate-limit, backup, shutdown, upload and migration material. These are positive but unhelpful lexical matches.
- Multi-relevant Recall@5 is 0.5333/0.7500/0.8833. Hybrid recovers complementary evidence for schema rollout and persisted retrieval edits/renames that one channel misses.

Hybrid remains a defensible compatibility/default compromise for this mixed engineering corpus, **not the best mode for every query**. Semantic leads aggregate metrics and natural-language/noisy classes. Lexical boosts help known terminology and multi-evidence queries; lexical noise can also displace semantic discoveries under rank fusion. This is a measured tradeoff, not a verified RRF implementation bug. No k sweep, automatic mode routing or scoring change was made. Hosts can choose explicit modes, and the next campaign should investigate evidence quality before any default change.

### No-answer / rejection findings

All three modes returned nonempty, irrelevant evidence for **all ten no-answer queries**; false-positive nonempty-result rate is 100% in both negative classes. Lexical also matches incidental/common words. Semantic/hybrid deliberately rank all eligible vectors and have no answerability mechanism. Per-query ordering is preserved in the structured report.

| Query group | n | Top cosine min | Median | Max |
| --- | ---: | ---: | ---: | ---: |
| Answerable | 40 | 0.2165 | 0.5007 | 0.6684 |
| Unrelated negative | 5 | 0.0962 | 0.1630 | 0.2060 |
| Near miss | 5 | 0.2386 | 0.3040 | 0.6632 |

The five unrelated negatives happen to separate here; near misses overlap answerable scores strongly. Asking for last Tuesday's measured backup restoration time retrieves the general backup runbook at **0.6632**, although that measured fact is absent. Asking for a production OAuth secret retrieves the OAuth document at **0.4698**, without the requested secret. Rank fusion does not establish whether the evidence contains the answer. A universal threshold based on this fixture would reject legitimate low-score results while retaining high-score near misses.

Raw cosine remains evaluation-only. Ranks do not let a host implement score thresholds, but publishing scores alone would not solve this problem. The current API is adequate for ranked candidates with provenance; whether core should offer calibrated relevance, expose optional scores, or leave answer verification entirely to hosts remains a separate public-contract decision. Alpha.5 does not establish that such an API is required or a dependable cutoff exists.

### Known informal failure cases

These are informal observations from a private test corpus, not benchmark measurements, and they do not change any recorded value above.

- Markdown headings with no body text under them can be returned as passages, and a short query naming the heading can rank that passage highly.
- Semantic and hybrid sometimes returned passages about the correct subject with the action reversed; for example, a “who killed X” style query returned a passage where X is the one who kills.
- The formal no-answer and near-miss findings above already show that nonempty results do not establish answerability and that these data do not support a universal cutoff.
- Embedding a corpus for the first time can take noticeable time, so saved indexes are intended to avoid repeating that work.

### Model and query latency

Staged local loading made **zero fetch attempts**. Load through adapter ready: **752.282 ms**; first inference including load: **785.365 ms**; indexing 72 chunks after model warmup: **1657.319 ms**. Runtime import and staging precede these load timers; no fresh download is included. One warmup per strategy and three measured repeats of all 50 queries produced 150 timed queries per mode, with **0/151/151** query embedding calls including warmup. Cache avoidance is tested separately.

| Mode | Warm total ms | Query embedding ms | Cosine component ms | RRF component ms | Ranking after embedding ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| lexical | 0.565 | 0.000 | — | — | — |
| semantic | 7.309 | 6.548 | 0.425 | — | 0.425 |
| hybrid | 9.362 | 7.744 | 0.499 | 0.093 | 1.145 |

Timing columns show medians. Cosine/lexical/fusion components are independent reruns using the already-computed query vector; they exclude candidate collection and public result construction. They are not additive partitions of the public search timer. Model load is reported separately from warm query inference. No machine-specific pass/fail performance thresholds are used.

### Exact-search scale

Isolated processes for 1k/10k/50k/100k one-chunk documents, deterministic 384-dimensional vectors, two warmups and five measured runs per mode. The broad query produces lexical evidence in every document, measuring full-channel exact sorting/fusion rather than selective-filter performance. No MiniLM document inference occurs. Public totals include filtering, ranking and final ten results; component reruns do not.

| Candidates (384 dimensions) | Lexical total ms | Semantic total ms | Cosine component ms | Hybrid total ms | RRF component ms | RSS growth MiB | Peak RSS MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 4.35 | 9.30 | 8.28 | 16.58 | 1.94 | 15.03 | 96.75 |
| 10,000 | 24.81 | 113.56 | 85.37 | 201.95 | 37.76 | 99.92 | 234.49 |
| 50,000 | 131.87 | 427.29 | 350.69 | 743.43 | 175.67 | 353.03 | 698.84 |
| 100,000 | 245.82 | 791.79 | 726.59 | 1437.57 | 443.96 | 636.99 | 1396.32 |

Memory is an observation of the **benchmark process**, including engine state, a separate component-measurement fixture and two vector representations. RSS growth is measured after explicit GC; process peak includes indexing/temporary allocations. At 100k, retained array-buffer growth is 307.2 MB and heap growth about 220.6 MB; these are not a core-only memory promise. Full distributions and environment are in the structured scale record.

On this laptop 10k unfiltered candidates already cost roughly 0.1–0.2 seconds semantically/hybrid; 50k–100k make interactive wide-scope queries noticeably expensive. At 100k, hybrid is about 1.44 seconds and fusion alone about 444 ms, so accelerating vector lookup alone would not eliminate all cost. Use deterministic scope and a host worker where responsiveness matters. ANN is a future scaling candidate **if** measured host workloads require large unfiltered interactive searches; it is not required for all local corpora and is not implemented/recommended as an immediate dependency. The chosen next campaign is quality/answerability work, not automatic ANN adoption.

### Browser evidence

An installed alpha.5 tarball runs lexical/semantic/hybrid search, host memory storage, restart/vector reuse and run caching in an actual Chrome page and module worker with a deterministic injected embedder. No Node globals or model peer are needed. A separate opt-in worker loads real MiniLM via WASM, embeds documents/queries, performs semantic retrieval and disposes the model, using only host-served model/runtime assets and no external requests. Exact browser version and validation results are recorded in [hardening](https://github.com/the-leumas/provena/blob/main/docs/alpha5-hardening.md). This certifies the tested Chrome/WASM arrangement only, not WebGPU, all browsers or offline PWA asset management.

## Historical baseline observations

Run `npm test` for the offline suite and `npm run benchmark` for the original lexical/lifecycle baselines plus a three-mode mechanics comparison. CI is configured for Node 20 and 22; the initial local run used Node 26.4.0.

The Alpha.4 offline suite contains 64 tests (49 retained Alpha.3 tests and 15 focused retrieval regressions). It covers registry admission/fallback, source identity, Markdown/code/text structure, line-preserving chunks, stable fingerprints, lexical results, metadata filters, atomic source refresh, rename/delete behavior, run-cache invalidation, source containment/symlinks, binary/size rejection, host independence, generated documentation, and offline tarball installation with JavaScript and TypeScript exports.

Initial fixture benchmark (8 documents, 8 chunks, 6 queries):

| Measurement | Observed |
| --- | ---: |
| Lexical Recall@5 | 0.9167 |
| Lexical Recall@10 | 0.9167 |
| Initial indexing | 5.21 ms |
| Explicit refresh after one edit | 4.44 ms |
| Unchanged chunks in refresh | 7 |
| Mean query time | 4.78 ms |
| Duplicate cached queries avoided | 1 |
| Serialized catalog size | 1,626 characters |

Timing varies by machine and warm-up; these numbers are not performance guarantees. The benchmark reports heap delta, which can be negative when garbage collection occurs, rather than claiming peak memory usage. That lexical-only benchmark deliberately uses no storage, so its persistent index size is reported as null. A separate lifecycle benchmark reports actual serialized snapshot bytes. Catalog size is not total index size. The vague conceptual query exposes lexical limitations. The table above is the historical baseline; Alpha.4 preserves its recall and adds the separate comparison below.

The package-install test packs built files, checks the publication allowlist, installs into an isolated temporary consumer offline, imports all three public exports, and typechecks a consumer against the installed declarations. It accommodates array and name-keyed npm JSON formats. Build output and npm caches are excluded from Git.

## Lifecycle acceptance

The deterministic test embedder lives only under `tests/fixtures/`; it is not a production semantic model. The lifecycle suite covers the four optional-adapter configurations, initial persistence, reconciled restart, unchanged/changed/new content, duplicate content, deletes, renames, model/dimension incompatibility, schema/parser/chunker/config invalidation, explicit custom parser versions, malformed snapshots, load/scan/parser/embedding/save failures, cancellation, and concurrent mutation rejection.

File storage tests use temporary directories to verify restart reuse, serialization failure, cancellation after writing but before rename, cleanup and explicit I/O/JSON errors. Root isolation checks include graph inspection and execution of the emitted core graph in a web-like VM realm with no `process`, `Buffer`, `require` or adapter imports. That realm exercises host-supplied source/storage/embedder, restart reuse and all three retrieval modes with non-unit vectors. This is an offline host-neutrality smoke test, not an actual-browser/model-runtime certification.

`npm run benchmark` now also runs a lifecycle measurement using three small documents, the deterministic test embedder and memory storage:

| Operation | New embedding inputs |
| --- | ---: |
| Initial index | 3 |
| Unchanged refresh | 0 |
| Single changed document | 1 |
| Rename without text changes | 0 |
| Restart with compatible state | 0 |

The local lifecycle run serialized a 5,586-byte snapshot, with two loads and five saves. The harness prints measured elapsed time per operation and serialized snapshot bytes, plus load/save counts. These timings measure engine/test-adapter overhead, not MiniLM inference or disk I/O. Snapshot size includes compatibility markers, catalog, chunks and vectors. The lexical benchmark remains unchanged so recall stays comparable. That lifecycle measurement makes no semantic-quality claim; real retrieval quality is measured separately below.

## Alpha.4 retrieval acceptance and evaluation

The new offline regressions prove lexical compatibility, explicit/default modes, generic cosine with non-unit/negative vectors, exact RRF k=60, ties, channel union, final-limit ordering, all established filters, provenance, punctuation queries, zero candidates, query inference counts, mode/filter/source/limit cache identity, revision races, compatible restart retrieval, invalid/missing/zero vectors, and cancellation/failure preservation. Existing lifecycle assertions explicitly use lexical mode where they test availability independent of query inference; the browser-like realm now runs all three modes. Normal tests and benchmarks never load MiniLM.

Commands:

```sh
npm run benchmark              # original lexical, lifecycle, then offline three-mode mechanics
npm run benchmark:minilm       # opt-in real model; online/cached Hub loading may access network
npm run benchmark:minilm -- --staged  # provisioned pinned local assets; host disables remote loading
```

Both comparison commands use `tests/fixtures/retrieval.json`: the same eight documents/chunks and ten queries across modes. Its original six queries remain unchanged and continue to feed the original lexical script. Four added judgments target restart persistence, retry after failure, frost protection, and a mixed exact-symbol/cookie query. Judgments were fixed before running MiniLM; no ranking parameters were tuned after observing outcomes. They identify relevant documents; Recall@K counts distinct relevant document IDs appearing among the first K chunks. This small corpus does **not** measure multi-chunk-document competition. Semantic/hybrid rank all eight chunks, so Recall@10 saturates and cannot distinguish their quality here.

Observed on Node 26.4.0, CPU/fp32, 2026-09-13. Real model: pinned `Xenova/all-MiniLM-L6-v2` revision `751bff37182d3f1213fa05d7196b954e230abad9`, runtime 4.2.0, 384 dimensions, mean pooling and normalization. Host-staged inference completed with **zero fetch attempts**.

| Evaluation | Mode | Recall@5 | Recall@10 |
| --- | --- | ---: | ---: |
| Offline character bins (mechanics only) | lexical | 0.7500 | 0.8500 |
| Offline character bins (mechanics only) | semantic | 0.9000 | 1.0000 |
| Offline character bins (mechanics only) | hybrid | 0.7500 | 1.0000 |
| Real MiniLM | lexical | 0.7500 | 0.8500 |
| Real MiniLM | semantic | 1.0000 | 1.0000 |
| Real MiniLM | hybrid | 0.9500 | 1.0000 |

The deterministic 32-dimensional character-bin fixture is deliberately not a semantic model. Its numbers make execution repeatable, not a claim of language understanding. Hand-authored vector tests independently establish the expected channel/RRF ordering. The original six-query lexical Recall@5/@10 remains **0.9167/0.9167**, both in the unchanged baseline script and the expanded comparison.

Real model results do not show universal hybrid superiority. For the gateway query, semantic retrieves both `notes.txt` and `auth.ts` in the top five, while lexical/hybrid retrieve only `notes.txt`. Hybrid ranks unrelated lexical matches above `auth.ts`. For `architecture.md`, semantic prefers the link-bearing note first; lexical/hybrid place the named document first. The added persistence paraphrase finds its target at semantic position 3 and hybrid position 5, so perfect Recall@5 does not imply ideal early ordering.

| Query | Relevant document(s) | Lexical / semantic / hybrid Recall@5 |
| --- | --- | --- |
| architecture.md | architecture.md | 1 / 1 / 1 |
| validateSession | auth.ts | 1 / 1 / 1 |
| model dimensions | storage.md | 1 / 1 / 1 |
| retrieval | architecture.md, links.md | 1 / 1 / 1 |
| healthcheck | deployment.yaml | 1 / 1 / 1 |
| who is allowed through the gateway | auth.ts, notes.txt | 0.5 / 1 / 0.5 |
| How can completed preprocessing survive an application relaunch? | storage.md | 1 / 1 / 1 |
| What happens to an unsuccessful scheduled task? | queue.md | 0 / 1 / 1 |
| Keeping vegetables safe during freezing nights | garden.md | 0 / 1 / 1 |
| validateSession checks incoming cookies | auth.ts | 1 / 1 / 1 |

The frost-protection query has no lexical hits; semantic/hybrid return `garden.md` first. The unsuccessful-task query misses `queue.md` in lexical top five; semantic returns it first and hybrid third. Exact identifiers `validateSession` and `healthcheck` retain their relevant first result in all modes. Full per-query top-five IDs and latency are printed by the harness, including misses; no absolute cosine values are represented as confidence.

| Run / mode | Mean total query ms | Mean query embedding ms | Mean cosine component ms | Mean RRF component ms | Query embedding calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| Offline / lexical | 4.737 | 0.000 | 0.000 | 0.000 | 0 |
| Offline / semantic | 0.591 | 0.036 | 0.143 | 0.000 | 10 |
| Offline / hybrid | 0.403 | 0.037 | 0.073 | 0.033 | 10 |
| MiniLM / lexical | 3.125 | 0.000 | 0.000 | 0.000 | 0 |
| MiniLM / semantic | 7.918 | 7.395 | 0.265 | 0.000 | 10 |
| MiniLM / hybrid | 6.663 | 6.392 | 0.107 | 0.036 | 10 |

These are individual local runs, not performance thresholds. Lexical's first query includes sorting/runtime warm-up, and later modes benefit from warm-up; do not infer general relative throughput from these averages. Cosine/RRF component timings are independent reruns over the same candidate references using the already-computed query vector, not additive subdivisions of total search time. The harness does not perform extra query inference to measure components.

There are eight candidates per unfiltered query. Ten semantic queries and ten hybrid queries each use ten query embeddings; lexical uses zero. A duplicate cached hybrid pair needs one embedding. Offline comparison indexing took 14.328 ms and produced a 9,359-byte snapshot. Real MiniLM indexing including lazy model load took 1038.216 ms and produced a 73,452-byte snapshot. Host runtime import and asset staging precede that timer. The original baseline's local indexing/one-edit refresh took 13.503/4.197 ms; unchanged chunks remained seven. Lifecycle inference counts remain **3/0/1/0/0**, with a 5,586-byte snapshot.

This corpus is too small for a scaling claim, early-precision judgment, or evidence that an agent needs fewer exploratory tools. No live-agent/consumer integration has been run. Alpha.4 recommended representative evaluation before quality changes or integration; Alpha.5 now supplies it above; ANN, reranking and query expansion are not implemented.

## Alpha.3 real MiniLM acceptance

`npm run test:minilm` is an explicit opt-in command, separate from `npm test` and `npm run benchmark`. It runs each loading mode in a fresh process, preventing host runtime globals and metadata memoization from leaking between modes. Hub mode may download pinned assets into `.cache/minilm/`; staged mode copies those provisioned assets into a temporary local-model deployment, disables model caches and remote loading, and traps both runtime/global fetch. The final cache-only probe verifies the specific tokenizer-discovery failure as an expected result; unrelated errors are not accepted as that limitation.

To exercise one mode after `npm run build`:

```sh
node tests/minilm.real.mjs --mode=hub
node tests/minilm.real.mjs --mode=staged
node tests/minilm.real.mjs --mode=hub-cache-only
```

`MINILM_CACHE_DIR` selects the Hub cache fixture. `MINILM_LOCAL_MODEL_DIR` may point staged mode at an already provisioned default CPU/fp32 model directory containing the four files documented in [integration](integration.md#strict-offline-host-staged-assets). Individual staged/cache-only probes require provisioned assets; the full command runs Hub mode first to obtain them. The former `MINILM_LOCAL_FILES_ONLY` test toggle is replaced by these explicit modes so cache-only failure is not mistaken for failure of supported strict offline deployment.

### Exact supported loading matrix

| Mode | Result on Node CPU/fp32 | Network contract |
| --- | --- | --- |
| Normal online/cached Hub ID | Passed real inference and lifecycle acceptance | May access the network; final run reused cached weights. |
| Host-staged assets, local loading enabled, remote loading disabled | Passed with caches disabled and **0 fetch attempts** | Strict offline local-file deployment verified. |
| Revision-specific Hub cache alone, no staged assets, remote loading disabled | Known limitation reproduced: tokenizer discovery fails with `Cannot read properties of undefined (reading 'tokenizer_class')` | Unsupported as an offline guarantee; expected limitation is not overall acceptance failure. |
| Browser/worker with host-served model/backend assets | Alpha.3 graph-only validation; actual Chrome/WASM inference now passes in Alpha.5 | Host must validate serving, offline caching, WASM/WebGPU availability and runtime configuration. |

The first two modes prove real document/query vectors, finite Float32 data, dimension 384, unit norm within 0.001, repeatability, batch partition equivalence (maximum absolute difference < 0.0001), relative semantic sanity, query/document space compatibility, disposal, failed-refresh preservation and explicitly requested lexical engine search. Both reproduce inference counts **3 initial / 0 unchanged / 1 changed / 0 renamed / 0 restarted**. Those explicit lexical searches make no query embedding calls. The generic offline suite remains authoritative for full lifecycle/cancellation coverage.

### Recorded run, 2026-09-13

Configuration: Transformers.js **4.2.0**, `Xenova/all-MiniLM-L6-v2`, immutable revision `751bff37182d3f1213fa05d7196b954e230abad9`, CPU, fp32, mean pooling, normalization, 384 dimensions, batches of four versus one. Local runtime: Node **26.4.0**. No performance threshold is imposed.

| Measurement | Hub/cached mode | Staged local mode |
| --- | ---: | ---: |
| Load through adapter ready | 7,804.764 ms | 723.497 ms |
| First three-text embedding including load | 7,896.788 ms | 747.964 ms |
| Warm query embedding | 19.110 ms | 11.300 ms |
| Warm three-text batch | 32.429 ms | 17.642 ms |
| Maximum repeat difference | 0 | 0 |
| Maximum batch partition difference | 0 | 0 |
| Password paraphrase cosine | 0.8270960321 | 0.8270960321 |
| Password versus weather cosine | 0.0408346637 | 0.0408346637 |
| Observed RSS delta, bytes | 285,483,008 | 268,324,864 |
| Strict offline fetch attempts | Not constrained/measured | 0 |

The load timer ends when the adapter reports ready. Hub mode includes its dynamic runtime import; staged mode imports the runtime during host bootstrap before timing. Cached weights were already present, so these load times are not fresh-download measurements or a controlled cross-mode performance comparison. RSS deltas include runtime allocations and two live model instances and are not peak memory estimates. Results are machine-specific; actual browser, WebGPU and quantized-dtype performance were not measured. These historical cosine examples evaluated embedding sanity; actual cosine retrieval was added in Alpha.4.

For comparison, the initial run's first real Hub embedding took 179,318 ms including loading/download overhead and an upstream metadata warning. Strict Hub-cache-only testing then exposed the blocker recorded in [ADR 0001](decisions/0001-minilm-loading.md). The accepted host-staged contract resolves deployment without patching Transformers.js or mutating its globals inside the adapter.

### Final validation

49 offline tests passed, including optional-peer absence, installed MiniLM declarations/export with the peer present, browser-like core execution, offline adapter lifecycle and deterministic input-policy checks. Strict typechecking, production build, generated file-type documentation check, tarball creation and isolated offline tarball installation passed. The lexical benchmark remains Recall@5/@10 **0.9167**, eight documents/eight chunks, and one duplicate query avoided. Its lifecycle companion reports 5,586 snapshot bytes, two loads/five saves and **3/0/1/0/0** inference counts. Real loading-matrix acceptance passed for the two supported modes and reproduced the expected third-mode limitation.

Alpha.4 now implements and evaluates semantic cosine candidates and RRF above. Live consumer tool-call counts, failed/duplicate calls, end-to-end latency and task correctness remain outside this package-only campaign.

## Alpha.4 final validation

On 2026-09-13, `npm test` passed **64/64**, including installed JS/types for core, filesystem and MiniLM exports, optional-peer absence, and browser-like execution without Node globals. Strict typecheck, clean production build, generated file-type consistency, offline benchmark and tarball consumer installation passed. Root dependencies/exports remain unchanged; the retrieval helper is internal to the package export boundary.

The full `npm run test:minilm` command was attempted again but stopped in its first online Hub process: fetching `https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer_config.json` returned `TypeError: fetch failed`, followed by the upstream `tokenizer_class` discovery error. Therefore **the complete online acceptance command did not pass in this Alpha.4 run**. Alpha.3's successful online observation above is historical, not a claim that this rerun succeeded. No runtime patch, hidden network bypass or loading-contract change was made.

The supported staged path was then run directly with `node tests/minilm.real.mjs --mode=staged` and passed: 384-dimensional finite normalized Float32 vectors; repeat and batch-partition maximum differences 0; paraphrase cosine 0.8270960321 versus unrelated 0.0408346637; lifecycle inference counts **3/0/1/0/0**; failed-refresh preservation; explicit lexical search; disposal; **zero fetch attempts**. Load-through-ready was 615.263 ms, first embedding 653.279 ms, warm query 10.847 ms, warm batch 21.339 ms. RSS delta was 255,401,984 bytes across two models/runtime allocations, not peak model memory.

The separate `--mode=hub-cache-only` probe reproduced the expected unsupported tokenizer-discovery limitation with zero fetch attempts. Real Alpha.4 semantic/hybrid evaluation also passed under staged loading as reported above. The online fetch failure does not invalidate supported strict-local inference or retrieval correctness; Hub-only loading remains network-dependent under 4.2.0.
