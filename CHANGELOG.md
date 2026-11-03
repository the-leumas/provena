# Changelog

## 0.1.0-beta.2 (2026-11-03)

- Semantic and hybrid CLI modes now work from `npx`, global and project installs without
  manually installing the optional peer. The CLI installs the pinned
  `@huggingface/transformers@4.2.0` runtime once into `~/.cache/provena/runtime`;
  `--no-install` or `PROVENA_NO_INSTALL=1` opts out.
- Pinned MiniLM cache assets are verified by size and SHA-256 before local loading. A damaged
  revision directory is removed and downloaded again instead of failing with an opaque ONNX
  parse error.
- Interactive preparation failures now include the full cause chain, so cache, runtime and
  tokenizer failures are distinguishable.

## 0.1.0-beta.1 (2026-11-03)

Initial public beta.

- Lexical, semantic, and hybrid (RRF, k=60) retrieval over host-supplied sources
- Candidate-scoped IDF weighting for lexical ranking, with heading/metadata and full-query boosts
- Source-aware indexing with line-level provenance: URIs, headings, and 1-based line ranges on every result
- Markdown, plain text, and code parsers behind an extensible parser registry
- Optional local embeddings via the portable `MiniLMEmbedder` adapter (Transformers.js optional peer)
- Optional persistence and filesystem source adapter (`@theleumas/provena/filesystem`, Node 20+)
- Zero runtime dependencies in the core; ESM-only with TypeScript declarations
- Small `provena` command-line tool for lexical, semantic and hybrid search over a directory, with optional saved indexes
- Ollama embeddings are available through the CLI only and are not a library export
