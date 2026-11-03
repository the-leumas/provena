# Retrieval boundary: adversarial validation record

*Retrieval validation record, September 2026. Measurements describe the tested source revision, not a guarantee for future releases.*

## Scope and method

A separate technical review examined the retrieval core, existing judgments and the retrieval-only answerability contract. This was a limited internal review, **not** an external human audit or independent production certification.

The review included:

- Inspection of public contracts, ranking, parsing, persistence and consumer examples.
- Manual-style reassessment of 15 of the 50 authored evaluation queries against source chunks.
- 25 additional adversarial queries covering paraphrases, exact symbols, missing facts, contradictory or negated phrasing, multi-document requirements, distractors and filters.
- Deterministic-vector and real pinned MiniLM runs, including staged offline execution.
- Installed-package, portability and documented lifecycle checks.

The full fixtures and recorded outputs are in `tests/fixtures/heldout-adversarial.mjs` and the held-out record (`docs/benchmarks/alpha6c-heldout-real.json`).

## Findings

**Provenance:** the public results preserve source/document/chunk identity, URI, line ranges and retrieval positions. Those positions are not confidence scores.

**Retrieval quality:** real MiniLM found conceptual/paraphrased targets that lexical matching ranked lower. Exact-symbol queries and multi-passage tasks illustrated complementary strengths of the channels. Hybrid fusion was a reasonable default on this fixture, but not universally the strongest mode.

**Unsupported facts:** even a topical high-ranked passage can omit the requested fact. All studied no-answer and near-miss queries still returned candidates; no defensible generic similarity threshold separated supported from unsupported requests.

**Judgment uncertainty:** the second review disagreed with parts of the original evidence-set interpretations. Some tasks accepted a smaller collection of chunks as sufficient. These assessments remain subject to interpretation, not proof of overall answerability.

**Deterministic-model limitations:** an intentionally simple character-based embedder sometimes produced misleading rankings compared with the real MiniLM adapter. Those runs test algorithm wiring, not semantic quality.

## Follow-up and corrected findings

The initial review suggested five changes. Follow-up investigation reached these dispositions:

| Proposal | Outcome | Reason |
| --- | --- | --- |
| Export the example's unassessed-evidence wrapper | Not adopted | It would standardize host policy without a demonstrated generic need |
| Add a document-deduplication search option | Deferred | Several chunks in the same document can jointly matter |
| Fix missing heading boosts on continuation chunks | Incorrect diagnosis | The parser and chunker already propagate section headings |
| Rename `*Rank` fields to `*Position` | Not adopted | Ordinal semantics were already documented; renaming would be a compatibility cost |
| Clarify lexical vs semantic cache normalization | Accepted | Lexical normalizes case/outer whitespace; semantic and hybrid preserve exact query text |

No runtime change resulted directly from this review. Candidate-scoped lexical IDF weighting was introduced separately.

## Recorded verification and limits

The follow-up reported **84 passing offline tests**, type checking, build, `npm pack`, and an installed Chrome page/worker smoke test. The staged real MiniLM held-out evaluation used 25 queries and reported zero external fetch attempts under that configuration. These are historical observations, **not** a claim that the current commit has been locally retested or that every deployment is certified.

Limitations remain: no broad external relevance study, no general cross-browser or WebGPU certification, no concurrent-load campaign, and no validated model for deciding corpus-wide answerability. The initial 15/50 judgment review was not exhaustive.

For current behavior see [Public API](api.md), [Evaluation](evaluation.md), [Architecture](architecture.md), and [the retrieval evidence decision](decisions/0003-retrieval-evidence-boundary.md).
