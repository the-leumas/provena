# Provena

**Local hybrid retrieval with source-level provenance.**

Provena is an embeddable TypeScript retrieval engine for text and code. It indexes documents supplied by an application, preserves source line references, and ranks passages using lexical search, vector similarity, or both. The index lives in memory; embeddings and persistence are optional.

Provena is not a vector database, cloud search client, or LLM framework.

> **Status:** Experimental — this is a pre-1.0 public beta. API and behavior may change between minor versions.

## Why Provena?

Most retrieval libraries are either:
- **Vector databases** — managed services, network hops, opaque scoring
- **Embedding-first SDKs** — force a model, hide the index, no provenance
- **Full-text engines** — no semantic capability, no embedding reuse

Provena is different: **you own the index, the embedder, and the storage**. The core is a pure in-memory structure with zero runtime dependencies. You supply documents (from files, a database, an API, anywhere), optionally provide an embedder, and get back **ranked passages with full citation metadata** — source ID, document URI, heading, 1-based line ranges, and the exact snippet.

## Features

- **Source-aware indexing:** register any collection via the `SearchSource` interface (filesystem, database, API, in-memory Map, etc.)
- **Traceable results:** every hit carries `sourceId`, `documentId`, `uri`, `heading` (when available), `startLine`/`endLine`, and `snippet`
- **Three search modes:** `lexical` (candidate-scoped IDF, heading/metadata boosts), `semantic` (exact cosine similarity), `hybrid` (RRF fusion, k=60)
- **Optional local embeddings:** use the portable `MiniLMEmbedder` adapter (Transformers.js optional peer) or implement `Embedder` for any model
- **Optional persistence:** plug in an `IndexStorage` — the Node file adapter (`@theleumas/provena/filesystem`) or your own (IndexedDB, SQLite, etc.)
- **Extensible parsers:** Markdown (ATX/setext headings, sections, links), plain text, code (language metadata), or custom formats via `FileTypeRegistry`
- **Incremental file reuse:** unchanged filesystem revisions skip reading, parsing and chunking; only new or changed documents need processing
- **Embedding input reuse:** identical chunk content + heading context reuses vectors across refreshes and renames — no re-embedding unchanged text
- **Cancellation & lifecycle:** cooperative `AbortSignal` checks at stage boundaries; failed refreshes leave the previous index intact
- **Search sessions:** bounded FIFO cache keyed by effective mode, query, sources, filters, and limit
- **Portable core:** ESM-only, TypeScript declarations, no Node/Browser assumptions — runs in Node 20+, modern bundlers, and browsers

## Install

```sh
npm install @theleumas/provena@beta
```

This is a beta release; install it with the `beta` tag so the version stays explicit.

Build a tarball from source:

```sh
npm ci
npm run build
npm pack
```

**Requirements:** Node.js 20+ (core), Node.js 20+ for `@theleumas/provena/filesystem` adapter. No CommonJS export.

## Quick start: lexical search without a model

```js
import { SemanticSearchEngine } from '@theleumas/provena';

const documents = new Map([
  ['sessions.md', '# Sessions\nSession tokens expire after 30 minutes.'],
  ['backups.md', '# Backups\nRestores are tested every Friday.'],
]);

const source = {
  id: 'docs',
  type: 'memory',
  async list() {
    return [...documents.keys()].map(name => ({
      id: name,
      sourceId: 'docs',
      name,
      path: name,
      uri: 'memory://docs/' + name,
    }));
  },
  async read(id) {
    const text = documents.get(id);
    if (text === undefined) throw new Error('Unknown document: ' + id);
    return { text };
  },
};

const engine = new SemanticSearchEngine();
engine.addSource(source);
await engine.initialize();

const matches = await engine.search({
  query: 'session tokens',
  mode: 'lexical',
  limit: 5,
});

for (const hit of matches) {
  console.log(hit.uri, hit.startLine, hit.endLine, hit.snippet);
}
```

**Output example:**
```
memory://docs/sessions.md 1 2 # Sessions
Session tokens expire after 30 minutes.
```

Each `hit` is a `SearchResult` with:
- `chunkId` — stable identifier for this passage
- `sourceId`, `documentId`, `uri` — reopenable origin
- `heading`, `language` — structural context when available
- `startLine`, `endLine` — 1-based source line range
- `snippet` — the matching text
- `lexicalRank` / `semanticRank` / `combinedRank` — ordinal positions

> **Important:** Results are **ranked passages, not verified answers**. Rank is ordinal, not a confidence score. Reopen the source and verify current content before treating a passage as factual evidence.

## Quick start: filesystem + semantic search (MiniLM)

```js
import { SemanticSearchEngine } from '@theleumas/provena';
import { FileSystemFolderSource, FileIndexStorage } from '@theleumas/provena/filesystem';
import { MiniLMEmbedder } from '@theleumas/provena/minilm';

const embedder = new MiniLMEmbedder();
const storage = new FileIndexStorage('/data/provena/index.json');
const source = new FileSystemFolderSource({ id: 'code', root: '/path/to/repo' });

const engine = new SemanticSearchEngine({ embedder, storage });
engine.addSource(source);
await engine.refreshSource('code');

const hits = await engine.search({
  query: 'async function',
  mode: 'hybrid',
  limit: 10,
  sources: ['code'],
});

for (const h of hits) {
  console.log(`${h.uri}:${h.startLine}-${h.endLine} (rank ${h.combinedRank})`);
  console.log(h.snippet);
}

await embedder.dispose();
```

## Command-line tool

The package ships a small `provena` command for trying retrieval on a folder of documents:

```sh
npx @theleumas/provena@beta --query "project overview"     # lexical, current directory
provena --source ./docs --mode lexical --query "retry"      # after npm i -g @theleumas/provena@beta
provena --fixture --query retryJob                          # bundled sample documents
```

`semantic`, `hybrid` and `--compare` need the optional `@huggingface/transformers@4.2.0`
peer; the first run downloads MiniLM into a per-user cache (`~/.cache/provena/minilm`, override
with `--cache-dir` or `PROVENA_CACHE_DIR`). Index creation requires `--save-index`; an existing
index in `cwd/.provena-indexes` is reused and refreshed on later runs (an unchanged index is not
rewritten), and `--no-index` avoids both loading and writing saved indexes.

Ollama embeddings are a CLI-only option. provena does not export an Ollama adapter; hosts
that want Ollama, or any other model, implement the Embedder interface themselves. The CLI
backend is not part of the package's public API.

See the [CLI guide](cli/README.md).

## Search modes in detail

| Mode | Ranking | Requires embedder | Default (no embedder) | Default (with embedder) |
|------|---------|-------------------|------------------------|--------------------------|
| `lexical` | Term matches + candidate-scoped IDF + heading/metadata boosts | No | ✅ | |
| `semantic` | Exact cosine similarity over stored vectors | Yes | | |
| `hybrid` | RRF fusion (k=60) of complete lexical + semantic rankings | Yes | | ✅ |

- Source and metadata filters apply **before** either ranking channel
- The `limit` (1–100, default 8) applies **after** fusion
- Lexical-only results carry `lexicalRank`; semantic-only carry `semanticRank`; hybrid carries both plus `combinedRank`
- Match reasons list participating channels: `['lexical']`, `['semantic']`, or `['lexical', 'semantic']`

## Sources, filters, and sessions

```js
// Source-scoped search
await engine.search({ query: 'error', sources: ['code', 'docs'] });

// Tag/metadata filters (catalog tags come from frontmatter or source metadata)
await engine.search({ query: 'config', tags: ['production'], extensions: ['.yaml', '.yml'] });

// Cached search session (bounded, auto-invalidates on index change)
const session = createSearchSession(engine, { maxEntries: 64 });
const hits = await session.search({ query: 'retry logic', mode: 'hybrid' });
```

## File types and parser registry

The `FileTypeRegistry` maps extensions/languages to parsers. Built-in:
- Markdown (`.md`, `.mdx`, `.markdown`) — headings, sections, wiki/Markdown links
- Plain text (`.txt`, `.text`) — line-preserving
- Code (`.ts`, `.js`, `.py`, `.rs`, `.go`, `.java`, …) — language detection via extension

Extend or override at engine construction:

```js
import { FileTypeRegistry, defaultFileTypes, isSupportedFile } from '@theleumas/provena';

const customRegistry = new FileTypeRegistry({
  ...defaultFileTypes,
  '.myfmt': { parserId: 'custom', language: 'myfmt' },
});
```

## Persistence and embedding reuse

`FileIndexStorage` serializes the index to a single JSON file (atomic write via temp sibling + rename). On reload, the engine matches incoming chunks by **exact embedding input text** — so a document rename preserves vectors, while a heading change triggers re-embedding only for affected chunks.

```js
import { FileIndexStorage } from '@theleumas/provena/filesystem';

const storage = new FileIndexStorage('/data/index.json');
// On next initialize(), loads previous state; compatible vectors are reused
const engine = new SemanticSearchEngine({ storage, embedder });
```

## Architecture highlights

- **In-memory exact cosine** — O(N·D + N log N) for N chunks, D dimensions; no ANN, no quantization
- **Snapshot isolation** — each source refresh builds a complete replacement snapshot; atomic commit or full rollback
- **Vector reuse** — by exact embedding input, not hash; identical content + heading context = shared inference
- **Cancellation** — `AbortSignal` checked before collection, per-candidate, around inference, during fusion
- **No hidden dependencies** — `Embedder` and `IndexStorage` are optional constructor arguments; core imports nothing

See [Architecture](docs/architecture.md) for the full data flow, [API](docs/api.md) for contracts, and [Evaluation](docs/evaluation.md) for methodology and benchmarks.

## Documentation

- [Integration guide](docs/integration.md) — sources, parsers, filesystem, storage, browsers, MiniLM
- [Public API](docs/api.md) — contracts, lifecycle, errors, cancellation
- [Architecture](docs/architecture.md) — indexing, retrieval, caching, snapshot guarantees
- [Command-line tool](cli/README.md) — usage, model cache and saved indexes
- [Examples](examples/README.md) — runnable consumer examples
- [Supported file types](docs/file-types.md) — generated extension registry
- [Evaluation](docs/evaluation.md) — methodology, benchmarks, limitations
- [Documentation index](docs/README.md) — all guides and historical records
- [Roadmap](ROADMAP.md) · [Changelog](CHANGELOG.md)

## Known limitations

- Results are returned whenever candidates match, even when nothing in the corpus answers the query. There is no separate “not found” signal, and ranks show retrieval order rather than confidence.
- A Markdown heading with no text under it can still come back as a passage, and it can rank high for a short query that names the heading.
- Semantic and hybrid ranking follows meaning, not grammar. In informal tests it sometimes returned passages about the right subjects with the action reversed — for example, a query such as “who killed X” returned passages where X is the one who kills. Check the returned passages.
- Embedding a corpus for the first time takes noticeable time. Use `--save-index` or a host `IndexStorage` to reuse vectors instead of repeating that work.

## Development

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack
```

Default tests are deterministic (no model downloads). Browser, inference, and scale checks are opt-in; see [Evaluation](docs/evaluation.md).

## Boundaries

- Parsing preserves lines but is not a full Markdown/CommonMark or AST parser
- Public results expose line ranges, not character-offset spans or complete heading hierarchies
- Semantic search is exact and in-memory; wide queries scale with corpus size
- A failed source refresh leaves the previous committed index available
- No file watching — hosts control refresh scheduling

See [Architecture](docs/architecture.md) and [API](docs/api.md) for complete semantics.

## Contributing and license

Contributions welcome; start with [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed — see [LICENSE](LICENSE).

Copyright (c) 2026 Leumas
