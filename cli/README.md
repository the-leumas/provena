# provena CLI

A small command-line front end for trying provena on a folder of documents. It is a thin
wrapper over the public library API (`@theleumas/provena`, `@theleumas/provena/filesystem`, `@theleumas/provena/minilm`).

```sh
npx @theleumas/provena@beta --query "project overview"   # lexical search of the current directory
provena --source ./docs --query "retry policy"           # after `npm i -g @theleumas/provena@beta`
node cli/cli.mjs --fixture --query retryJob              # from a checkout; bundled sample documents
```

Without `--query`, a terminal prompts for repeated queries (`/refresh`, `/help`, `/quit`).
Run `provena --help` for every flag.

## Modes and the embedding model

| `--mode` | Needs a model | Notes |
| --- | --- | --- |
| `lexical` (default) | no | Filename, symbol and content scoring. |
| `semantic` | yes | Exact cosine over stored vectors. |
| `hybrid` | yes | Lexical + semantic fused with RRF (k=60). |
| `--compare` | yes | Runs all three modes over one index. |

Pick `lexical` (the default, with no model needed) for exact terms, names and identifiers. Pick
`hybrid` for natural-language questions, where semantic matching helps when the wording differs
from the text.

Semantic, hybrid and `--compare` use `Xenova/all-MiniLM-L6-v2` through the optional
`@huggingface/transformers@4.2.0` peer. Install it yourself (`npm i @huggingface/transformers@4.2.0`).
On first use the model is **downloaded and cached**; later runs reuse the cache.

Cache location, first match wins: `--cache-dir DIR`, `$PROVENA_CACHE_DIR`, an existing
`.cache/minilm` inside a checkout, otherwise `$XDG_CACHE_HOME` or `~/.cache` + `/provena/minilm`.
`--model-dir DIR` points at staged model assets and disables remote loading (offline use).

## Ollama backend

`--embedder ollama --ollama-model NAME` selects the CLI-only Ollama backend. `--ollama-url URL`
overrides the default `http://localhost:11434`; both `--ollama-model` and `--ollama-url` require
`--embedder ollama`. The CLI calls Ollama's `/api/embed` endpoint with `{ model, input }`, discovers
the embedding dimension on first use, and includes the URL origin, model name and discovered
dimension in the index identity. The embedder has no external dependencies. Query/document
prefixes are constructor options in `cli/ollama.mjs`, not CLI flags.

`cli/tests/ollama.test.mjs` exercises the implementation only against a fake local HTTP server:
flag validation, default URL, request shape, query/document prefixes, dimension-aware identity,
empty input, non-200 and unreachable errors, abort, and a hybrid CLI search. A real Ollama daemon
is not required or exercised by the test suite.

Ollama embeddings are a CLI-only option. provena does not export an Ollama adapter; hosts that
want Ollama, or any other model, implement the Embedder interface themselves. The CLI backend is
not part of the package's public API.

## Saving the index

Index creation requires `--save-index`.

- `--save-index [DIR]` stores `DIR/.provena-indexes/<name>-<hash>/index.json` (default `DIR` = current directory).
  Later runs reuse unchanged files and embeddings; only changed content is re-embedded.
- An existing index in `cwd/.provena-indexes` is discovered automatically, reused, and refreshed; an unchanged index is not rewritten.
- `--index-location FILE` loads, refreshes and saves one existing index file.
- `--verify-content` rereads every file instead of trusting file metadata. `--no-index` ignores saved indexes and prevents writes.

The CLI never indexes its own `.provena-indexes` directory. Add it to `.gitignore`.
A lexical run cannot erase vectors from an index saved by a semantic run.

## Output

`--limit N` passages (default 3), `--lines N` excerpt lines, `--width N`, `--color auto|always|never`,
`--dev` for timings, `--showcase` for the stable 88-column demo presentation. Exit code 1 on errors, 130 on Ctrl-C.

## Known limitations

See the full [Known limitations](../README.md#known-limitations). A returned result list is not an answerability signal, ranks are retrieval order rather than confidence, and the first indexed folder run can take noticeable time; use `--save-index` to reuse the work.

## Layout

`cli.mjs` arguments and rendering · `runtime.mjs` engine and model setup · `index.mjs` saved indexes ·
`scrollback.mjs` / `prompt.mjs` interactive prompt · `format.mjs` text layout · `ollama.mjs` CLI-only
Ollama backend · `fixtures/` sample documents · `tests/` (not published). Tests: `npm run test:search`.
