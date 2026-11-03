# Retrieval results and answerability

*Design record, September 2026. This boundary remains part of the 0.1.0-beta.1 API.*

## Decision

Provena returns ranked **retrieval candidates**, not judgments that a claim is supported. The API deliberately does not supply answerability flags, calibrated confidence, arbitrary rejection thresholds, or a model-based evaluator.

A retrieved passage may mention the right topic without stating the requested fact. Conversely, no returned passage does not establish that the information is absent from the entire corpus: the query, selected sources, mode, result limit, or filters may have excluded it.

The consuming application decides whether, and how, to assess the evidence. The optional [evidence consumer example](../examples/evidence.mjs) uses the explicit value `answerability: 'not-assessed'`; that envelope belongs to the example, **not** the package API.

## Why the boundary exists

The representative evaluation contains 64 documents, 72 chunks, and 50 queries. Ten requests deliberately lack an answer or closely resemble an answerable question with a missing fact. All three retrieval modes still returned candidates for those ten requests. The benchmark's related-topic matches could have relatively high cosine scores.

Even accurate topical retrieval does not imply that the returned **chunk** answers the question. Some tasks also need several passages from different documents; no one passage provides complete support.

The evaluation therefore tracks separate concepts:

| Concept | Question |
| --- | --- |
| Retrieval rank | Where did a passage appear among returned candidates? |
| Relevance | Is the passage about the requested topic or mechanism? |
| Sufficiency | Does it contain the fact or reasoning needed for the request? |
| Evidence-set sufficiency | Do several passages jointly support the request? |
| Corpus answerability | Does adequate support exist in the authorized, current source collection? |

Only the first of these is calculated by the runtime search API. The other labels in development benchmarks are **annotations**, not runtime predictions.

## Alternatives considered

- **Expose raw similarity and lexical scores.** Useful for diagnostics, but insufficient for calibrated rejection; score distributions overlap between supported questions and near misses.
- **Add a generic evaluator interface.** Would require specifying task interpretation, source authority, caching, failures, freshness and the evaluator's own version. No stable cross-application requirement was demonstrated.
- **Automatically classify answers.** Would make unsupported confidence claims given the available corpus and evaluation.
- **Keep retrieval-only results.** Preserves a precise, composable contract without pretending candidate ranking solves evidence verification.

The last option was selected. Hosts remain free to add domain-specific rules, human review or additional model checks outside Provena.

## Provenance, freshness, and errors

`SearchResult` includes source identity, URI, line range, text and channel positions. Positions are ordinal, not probabilities. Source content may change after a refresh; applications should reopen and verify passages before using them for consequential decisions.

Failures and cancellation propagate as errors rather than empty result lists. A search spanning a refresh sees one committed index view but may observe older content. The [API guide](api.md) documents those semantics.

## Evidence and limits

The corpus and judgments are authored development data rather than independently certified truth. Additional adversarial review found interpretation disagreements and demonstrated the danger of deriving unsupported guarantees from toy embedders. The subsequent [validation report](alpha6-c-validation.md) documents the findings and corrections.

Reproducible fixtures: [retrieval evaluation](evaluation.md), [example traces](alpha6-evidence-traces.md), and [ADR 0003](decisions/0003-retrieval-evidence-boundary.md). Stored evaluation artifacts are linked from the [documentation index](README.md).
