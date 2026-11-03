# Incremental filesystem refresh

Reproduce with `npm run build`, then `node scripts/incremental-benchmark.mjs`.
The script creates 24 Markdown files in a temporary directory, uses the pinned
MiniLM CPU fp32 model offline in batches of four, and deletes its source/index
afterward. A complete model cache is required. It never opens a user corpus.

Results from Node v24.21.0 are recorded in
[incremental-indexing.json](incremental-indexing.json). Each stage constructs a
fresh runtime; elapsed time measures refresh only, without query inference.

| Stage | Time | Read/parsed files | Reused files | New embedding inputs | Persistence |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial index | 1,447 ms | 24 | 0 | 24 | Saved |
| Unchanged restart | 102 ms | 0 | 24 | 0 | No write |
| One file edited | 630 ms | 1 | 23 | 1 | Saved |
| Explicit content verification | 381 ms | 24 | 0 | 0 | No write |

These small-source timings demonstrate skipped operations, not large-vault
capacity. Discovery still traverses the entire source and performs metadata,
containment and admission checks. Snapshot loading/validation also remains
proportional to saved index size. No directory inclusion rules changed.
Older indexes require one read/parse bootstrap pass to acquire revisions and
CLI verification hashes; compatible vectors are retained. Lexical refreshes
preserve an existing semantic snapshot rather than overwriting its vectors.
