# ADR 0003: Retrieved candidates do not assert answerability

Status: accepted; the validation review has completed (see [validation report](https://github.com/the-leumas/provena/blob/main/docs/alpha6-c-validation.md)). Date: 2026-09-14.

## Context

Alpha.5 scores do not separate missing facts from related topics. Alpha.6 chunk inspection additionally separates relevant documents from sufficient returned chunks and jointly sufficient evidence sets. Every recorded document metric is unchanged; the new judgments are development annotations, not independent evaluation. See [design and gate](https://github.com/the-leumas/provena/blob/main/docs/alpha6-answerability.md).

## Decision

Keep the generic core retrieval-only. SearchResult represents ranked eligible chunks and provenance. Neither nonempty results, ordinal positions, channel agreement nor cosine assert sufficient evidence. Empty results do not certify absence from the corpus. No new public scores, evaluator abstraction or core rejection mechanism is introduced.

A maintained host example makes unassessed answerability explicit and preserves errors, cancellation, provenance and revision-overlap observations. Its local envelope is consumer code, not a new public package surface. Higher-level support verification belongs to the host until demonstrated requirements justify a separately reviewed contract. A failed top-K assessment, if a host later adds one, can only establish insufficiency of assessed evidence under that policy, not corpus-wide absence.

## Consequences

Runtime API, lexical/cosine/RRF behavior, default modes, filters, snapshots, cache keys and optional model boundaries remain unchanged. This prevents misleading claims, not false-positive retrieval itself. At the time of Alpha.6B, callers had no migration and the package remained alpha.5. A subsequent validation review completed, and this retrieval-only boundary remains in 0.1.0-beta.1.

Diagnostics and host evaluator wiring remain possible future designs, but are not justified solely by internal benchmark needs. A calibrated rejection mechanism cannot be invented from overlapping cosine distributions. Relevance/sufficiency/corpus answerability and retrieval success remain distinct.
