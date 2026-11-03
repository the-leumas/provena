# ADR 0002: Exact semantic retrieval and rank-based fusion

Status: accepted. Date: 2026-09-13. Applies to Alpha.4.

## Context

Alpha.3 already creates and persists compatible vectors behind a generic Embedder. Retrieval can consume those vectors without changing index schemas, importing MiniLM into core, or introducing storage/worker machinery. Existing lexical scoring supplies a measurable baseline.

## Decisions

- Extend SearchRequest with lexical/semantic/hybrid mode. Default to hybrid when an embedder is configured, lexical otherwise; expose read-only defaultMode for hosts and cache normalization. Explicit semantic modes without an embedder fail. Explicit lexical preserves Alpha.3 behavior and never embeds queries.
- Collect one deterministically filtered candidate set. Rank all eligible vectors using exact cosine with both norms; reject missing/invalid/zero vectors rather than silently return incomplete semantic evidence. Do not impose MiniLM normalization or dimensions on generic embedders.
- Preserve lexical scoring. Fuse complete channel rankings with conventional RRF k=60; apply final limit afterward. Use chunk identity for deterministic ties and preserve provenance and one-based channel/final positions. No confidence scores, relevance threshold or public ranking-tuning knobs.
- Capture record/vector references before awaiting query inference. Concurrent refresh cannot mix revisions; completed searches can still return that older coherent view. Cache only results whose revision remained stable. Cache effective modes separately and preserve raw semantic query text; generic embedders need not be case-insensitive. Do not introduce pending-call coalescing or a second query-vector cache.
- Keep schema 3 and embedding-input version 1 because no persisted vector meaning changes. No runtime dependency, optional MiniLM or host boundary changes are required.
- Preserve the original six-query lexical benchmark, add four relevance judgments before running the real model, and compare all three modes on the same eight-document/ten-query fixture. Deterministic vectors prove machinery only. Keep real MiniLM evaluation opt-in.

## Consequences and evidence

The default for embedder consumers changes intentionally; explicit lexical mode is the migration path. Exact retrieval uses O(N·D + N log N) time and O(N) temporary references. Full-channel semantic retrieval can return weak evidence and saturates Recall@10 on eight documents. Cancellation remains cooperative, not event-loop preemption.

Real MiniLM Recall@5 is 1.00 semantic versus 0.95 hybrid on this fixture; noisy lexical matches keep the gateway query's second relevant file below the hybrid top five. RRF is not tuned to conceal this regression. The next authorized work should validate retrieval quality with a larger representative corpus before choosing scoring changes or consumer integration. See [evaluation](../evaluation.md) for full measurements and [integration](../integration.md) for migration guidance.

## Alpha.5 cache amendment

Reproduced unnecessary inference for equivalent unordered source/tag/extension filters is corrected by canonical set keys (including extension case/leading-dot normalization). Undefined filter fields are omitted. A cache clear-generation prevents pending work that started before `clear()` from repopulating the cache, without aborting its caller. Effective modes, revision invalidation, bounded capacity and exact semantic query-text identity are unchanged. No ranking/default decision changes; see the [hardening record](https://github.com/the-leumas/provena/blob/main/docs/alpha5-hardening.md).

## 0.1.0-beta.1 amendment: lexical IDF weighting (2026-10-08)

The 0.1.0-beta.1 lexical scoring weights term matches by their frequency within the eligible candidate set (IDF). Earlier text preserving Alpha.3 lexical scoring describes the original Alpha.4 decision; the current scoring is in `src/retrieval.ts` and the [changelog](../../CHANGELOG.md). Exact cosine, RRF k=60 and mode defaults remain unchanged.
