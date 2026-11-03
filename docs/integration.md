# Host integration

## Install as a versioned dependency

Install `@theleumas/provena@beta` from the registry. Alternatively, build a tarball from a checkout with `npm ci && npm run build && npm pack`. Installing directly from a Git checkout requires the development dependencies and an explicit `npm run build`; registry tarballs include the built `dist` files. Use public package exports instead of another checkout's `src/` files.

Host consumers can integrate via ESM: applications can bundle dependencies using standard bundlers (like esbuild or Rollup), while Node packages, CLIs, or daemons can import the ESM core directly. Current package-install checks exercise native ESM and installed declarations for all three public exports; core also executes in a browser-like realm and in an installed-package test, an actual Chrome page/module worker from the installed tarball. An esbuild CommonJS consumer bundle was also verified.

## Filesystem folders (desktop or daemon)

```ts
import { SemanticSearchEngine } from '@theleumas/provena';
import { FileSystemFolderSource } from '@theleumas/provena/filesystem';

const engine = new SemanticSearchEngine();
engine.addSource(new FileSystemFolderSource({
  id: 'project',
  root: configuredAbsoluteRoot,
  maxFileBytes: 512 * 1024,
}));
await engine.initialize();
const evidence = await engine.search({ query: 'validateSession', sources: ['project'] });
```

`configuredAbsoluteRoot` is an absolute folder path selected by the consuming application.

The root must be explicitly approved/configured by the host. Do not register arbitrary untrusted paths as sources. Symlinks are not followed. No filesystem watcher is created and no external folder is inferred. Mobile/browser hosts should use their own source APIs and not import the Node adapter.

## Custom sources and parsers

Implement `SearchSource` for any explicitly configured document collection. IDs are unique within a source and every listed document must carry that source's ID. Add a `DocumentParser` to a `ParserRegistry`; for extra text formats, pass an extended `FileTypeRegistry` to both the parser registry and the filesystem adapter. Default built-in parsers use the configured registry, including its language metadata. When supplying a built-in parser instance explicitly, construct it with the same registry (for example `new CodeParser(fileTypes)`). Use `new SemanticSearchEngine({ parsers })`. The shared registry provides parser selection and admission policy rather than competing extension arrays. Unknown files are rejected unless explicitly registered.

## Optional storage and embedding

```ts
import { SemanticSearchEngine, type Embedder, type IndexStorage } from '@theleumas/provena';

// Host-provided implementations; alternatively use the optional MiniLMEmbedder below.
const embedder: Embedder = myWorkerEmbedder;
const storage: IndexStorage = myTransactionalStorage;
const engine = new SemanticSearchEngine({ embedder, storage });
engine.addSource(mySource);
await engine.initialize({ signal: abortController.signal });
```

Ollama embeddings are a CLI-only option. provena does not export an Ollama adapter; hosts that want Ollama, or any other model, implement the Embedder interface themselves. The CLI backend is not part of the package's public API.

A browser app can supply a browser source and IndexedDB-backed storage; a daemon can supply filesystem sources and its own store. The core imports neither. Omit either option independently. Storage alone persists lexical records. An embedder alone reuses vectors in the current engine. Both enable compatible restart reuse. With an embedder, omitted mode now means hybrid retrieval; without one it means lexical. Storage is independent of that default. Explicit lexical mode requires no query inference and remains usable after a model has been disposed, using the last good index. Semantic/hybrid require a working embedder and fail on model errors rather than silently falling back.

```ts
const exact = await engine.search({ query: 'validateSession', mode: 'lexical' });
const conceptual = await engine.search({ query: 'verify the caller identity', mode: 'semantic', sources: ['approved-project'] });
const combined = await engine.search({ query: 'verify the caller identity', mode: 'hybrid', filters: { extensions: ['ts'] } });
```

Set `mode: 'lexical'` where existing consumers require lexical results or zero query-model latency. Keep the embedder alive through semantic/hybrid searches; the engine never disposes a shared host adapter. Any finite Float32 embedder dimensionality is supported, but query and candidate vectors must have nonzero norm for cosine. All candidate vectors must exist and match the engine configuration; inconsistency surfaces as an error.

Source/filter restrictions apply before both channels, and no eligible chunks means no inference. Results retain full provenance and one-based ranks, not confidence. RRF can retain noisy lexical matches; use evaluation to choose a mode for a workload. Exact search scales linearly with vector count/dimensions plus sorting; curate sources and filter scope before assuming a large-corpus latency budget.

Use `createSearchSession(engine)` per run to cache completed equivalent searches. It resolves default mode and includes mode/filters/sources/limit in keys. Semantic query text is case/whitespace-sensitive in the cache. Calls overlapping refresh see their captured old index and are not cached under the new revision. Equivalent unordered source/tag/extension sets share cache entries. `clear()` prevents earlier pending calls from repopulating the cache without cancelling their callers. Re-read cited material before mutations when current source content matters.

For Node/CLI/desktop consumers, a concrete atomic store is available from the existing Node-only export:

```ts
import { FileIndexStorage, FileSystemFolderSource } from '@theleumas/provena/filesystem';
const engine = new SemanticSearchEngine({
  storage: new FileIndexStorage(configuration.absoluteIndexFilename),
  // embedder: myEmbedder, // optional, including MiniLMEmbedder from /minilm
});
engine.addSource(new FileSystemFolderSource({ id: 'folder', root: configuration.approvedAbsoluteRoot }));
await engine.initialize();
```

The host creates the index parent directory and chooses an index location outside its indexed source roots. Use one writer per store. Save failures surface and preserve the last good live source state. Missing files mean an empty store; corrupt JSON/compatible snapshots produce errors. Hosts choose recovery by repairing/removing that store or selecting a fresh one. The package never chooses a product-specific cache path.

Loaded snapshots are reconciled with current sources before becoming searchable. Unchanged exact content—including renames—reuses document vectors. Changed/new content alone requires embedding. Deletes leave live and persisted state on successful refresh. Initialization is per-source atomic; an early successful save during multi-source startup includes only reconciled live sources. A later failure keeps earlier successes and may leave other sources needing re-indexing after restart.

Embedding a corpus for the first time takes noticeable time. With the `provena` CLI, use `--save-index`; with a host integration, supply `FileIndexStorage` or your own `IndexStorage` so later runs reuse vectors and only changed content is embedded.

Removing a source clears it from memory immediately; the next successful source refresh saves that removal. This synchronous API does not promise an immediate durable write. To persist a document deletion, refresh its still-registered source, including when its listing is empty.

### Version custom parsers and embedding configurations

```ts
import { ParserRegistry } from '@theleumas/provena';
const parsers = new ParserRegistry(myParsers, myFileTypes, 'my-parser-behavior-v1');
const engine = new SemanticSearchEngine({ parsers, storage, embedder });
```

The version describes all custom parser behavior. Increment it when that behavior changes. Without an explicit version, custom registries still work, but persisted reuse is disabled. Registry definitions, chunker version and effective chunking options are also checked automatically. Parser/chunker incompatibility rebuilds passages from the live source, while identical embedding inputs can reuse validated vectors when the schema, model identity, dimensions and embedding-input version still match. Model/input/schema incompatibility requires fresh vectors. Keep parser and embedder configurations immutable; a changed embedder identity/dimension requires a new engine. Its ID must include model revision and vector-affecting settings, not just a friendly model name.

`IndexStorage.save` must atomically publish and reject failure/abort before publication. Once it resolves successfully, late cancellation cannot prevent the matching live commit. See [architecture](architecture.md) for the exact failure and cancellation policy. MiniLM is an optional adapter; hosts control its execution and caches.

## Optional MiniLM: online or cached Hub loading

Install `@huggingface/transformers@4.2.0` alongside the package only when using `/minilm`. Built tarball installs for core-only usage omit the optional peer. Git/source builds install development dependencies for compilation, including Transformers.js.

```ts
import { MiniLMEmbedder } from '@theleumas/provena/minilm';
const embedder = new MiniLMEmbedder({
  device: 'cpu', dtype: 'fp32', batchSize: 4,
  cacheDir: configuration.modelCacheDirectory,
  onProgress: event => showModelLoadProgress(event),
});
const engine = new SemanticSearchEngine({ embedder, storage });
engine.addSource(mySource);
await engine.initialize();
// Later, after every engine/consumer has finished with this adapter:
await embedder.dispose();
```

No runtime/model load occurs on import or construction. The first nonempty call loads once; subsequent calls reuse the pipeline. The host controls the batch size and execution location. Empty document batches return no vectors without loading. Disposal is terminal; later calls reject. Concurrent calls serialize; cancellation is checked around expensive stages but does not interrupt native work already running.

The default model is `Xenova/all-MiniLM-L6-v2` at `751bff37182d3f1213fa05d7196b954e230abad9`, using 384-dimensional normalized mean-pooled embeddings. Custom model IDs/paths require an explicit revision and compatible 384-dimensional output. Model/revision, dtype/device, runtime/adapter behavior, pooling/normalization and tokenizer policy participate in identity. Batch size, cache location and `localFilesOnly` do not. Mutable revisions such as `main` weaken reproducibility. The default tokenizer truncates beyond 512 tokens.

`cacheDir` is a cache location, not an offline promise. `localFilesOnly` forwards `local_files_only`; Transformers.js 4.2.0 tokenizer metadata discovery does not forward that option, revision or cache location on every request. Thus a Hub ID may still trigger remote metadata discovery even with populated cached files and `localFilesOnly: true`. Do not use that flag alone to promise zero network access.

## Strict offline: host-staged assets

The host provisions model assets before entering offline mode and ensures their bytes match the declared immutable revision. For the default CPU/fp32 deployment, stage this layout beneath a host-selected base directory:

```text
<localModelPath>/
└── Xenova/all-MiniLM-L6-v2/
    ├── config.json
    ├── tokenizer.json
    ├── tokenizer_config.json
    └── onnx/model.onnx
```

Other dtype choices require their corresponding ONNX assets. The host may copy the verified pinned cache assets into this deployment layout as a provisioning step; the adapter never copies or downloads staged files itself. A populated revision-specific Hub cache has a different role and is not sufficient by itself for strict offline Hub-ID resolution in 4.2.0.

```ts
// HOST bootstrap, before constructing/using any models in this runtime realm.
import { env } from '@huggingface/transformers';
import { MiniLMEmbedder, MINILM_DEFAULT_REVISION } from '@theleumas/provena/minilm';

env.localModelPath = configuration.stagedModelBaseWithTrailingSlash;
env.allowLocalModels = true;
env.allowRemoteModels = false;

const embedder = new MiniLMEmbedder({
  revision: MINILM_DEFAULT_REVISION,
  device: 'cpu', dtype: 'fp32', localFilesOnly: true,
});
const engine = new SemanticSearchEngine({ embedder, storage });
engine.addSource(mySource);
await engine.initialize();
```

These global settings belong to the host and affect other Transformers.js users in the same realm. The adapter reads the selected runtime but never changes its environment. Configure globals before concurrent users start; use separate host-managed workers/processes when different policies need isolation. Local asset resolution does not enforce the Hub revision: hosts must bind staged bytes to the declared revision and change identity when those bytes change. Keeping the same model/revision and settings with the exact same staged bytes preserves vector compatibility with Hub loading.

The CPU acceptance run disables model caches and remote loading and traps fetch calls; staged inference succeeds with zero network attempts. Missing staged assets must fail instead of downloading replacements.

## Browser and Web Worker hosts

Inside a host-created worker, import only core and `/minilm`, install/bundle the optional runtime, and choose `device: 'wasm'` or supported `webgpu` explicitly. The default `cpu` device targets Node. The adapter creates no worker, worker thread or process. The host supplies sources and storage adapters and transfers results as appropriate.

For browser offline deployment, the host stages and serves/caches model files, the JavaScript runtime and required WASM/backend assets. Configure `env.localModelPath`, `env.allowRemoteModels`, and `env.backends.onnx.wasm.wasmPaths` as required by that deployment. Local browser URLs may still involve fetch and require a functioning local/offline serving or service-worker strategy. The Node zero-fetch acceptance does not certify a browser asset-serving arrangement; real browser/backend inference must be validated by the host. Core and the adapter source remain free of Node filesystem/process imports.

The accepted [loading ADR](decisions/0001-minilm-loading.md) and [evaluation matrix](evaluation.md) distinguish supported inference paths from the known Hub-cache-only limitation.

## Tested standalone examples and deployment limits

Start with [maintained examples](../examples/README.md): `core.mjs` exercises lexical-only usage and custom source/storage/embedder wiring; `filesystem.mjs` uses an explicit approved root and store path; `minilm.mjs` owns model disposal. These are public-export consumer code, not imports of internals. [API responsibilities](api.md) documents failures, mutability, source registration, storage single-writer rules and worker placement for each contract.

The installed-package browser harness bundles the installed core example into a Chrome page and module worker, with no Node globals or Transformers peer. Its storage is memory-backed to prove the contract; it is not a durable IndexedDB implementation. The separate MiniLM worker test uses `device: 'wasm'`, fp32, `env.backends.onnx.wasm.numThreads = 1`, host-served backend assets and local model URLs, with remote models disabled and external requests blocked. It validates embeddings, semantic retrieval and disposal. All these settings are host test bootstrap, never adapter/core side effects. No WebGPU or cross-browser certification is claimed.

The browser test serves assets over loopback HTTP. Zero external requests differs from zero browser fetches: local URLs still need a server or host-managed offline cache. Node staged-local acceptance retains its stronger zero-fetch observation. Hub cache-only offline remains unsupported under Transformers.js 4.2.0; `localFilesOnly` is not a guarantee.

Before broader deployment, choose a retrieval mode for the workload and treat candidates as unverified evidence. Historical retrieval evaluations found high-similarity near misses and noisy lexical interference; unchanged hybrid defaults are a compromise. Exact wide-scope search becomes expensive at tens of thousands of candidates on the measured laptop. Filters and host-controlled workers help scope cost; no threshold, ANN, mode router or new host adapter is included.

## Consuming evidence without inventing an answerability claim

The [evidence example](../examples/evidence.mjs) returns candidate retrieval observations with `answerability: 'not-assessed'`. Copy/adapt it as consumer code; it is not another package export. `retrieved` and `no-results` describe only the returned list. No-result cause is not inferred, and unavailable models, malformed vectors or aborts remain rejected operations rather than empty success. A request spanning refresh may return a coherent older view; the example reports revision overlap but cannot detect source edits that were never indexed.

Hosts deciding to act on a passage must establish whether it contains the requested fact/task evidence, whether multiple passages are required, and whether it is current and authoritative. A procedure for collecting a measurement cannot substitute for that measurement. High rank, similarity or lexical/semantic agreement is not an assessment. The library does not require a particular human/rules/model verification method or define an evaluator ABI. If a host adds assessment, failures/unavailable/partial/stale evaluation must remain distinct from a justified finding that the *assessed set* is insufficient. Do not store those decisions in the retrieval cache as though they were candidate results.

Runtime/API compatibility is unchanged. Keep current mode choices, generic embedder/storage/source adapters and optional MiniLM settings. See the [retrieval/answerability design](https://github.com/the-leumas/provena/blob/main/docs/alpha6-answerability.md) for the rationale and limitations.

## Optional example: Obsidian vault adapter

The following is a conceptual host-side adapter. The host must apply its own hidden/protected-path policy on **both** list and read, and resolve the active editor versus saved content according to product semantics.

```ts
import type { SearchSource } from '@theleumas/provena';
import { SemanticSearchEngine, isSupportedFile } from '@theleumas/provena';

const vaultSource: SearchSource = {
  id: configuredVaultId,
  type: 'obsidian',
  async list() {
    return app.vault.getFiles()
      .filter(file => isAllowed(file.path) && isSupportedFile(file.path))
      .map(file => ({
        id: file.path, sourceId: configuredVaultId,
        uri: makeObsidianUri(file.path), path: file.path, name: file.name,
        modifiedAt: file.stat.mtime,
        metadata: { tags: hostTagsFor(file) },
      }));
  },
  async read(id) {
    if (!isAllowed(id)) throw new Error('Source access denied');
    const file = app.vault.getFileByPath(id);
    if (!file) throw new Error('Document unavailable');
    return { text: await app.vault.read(file) };
  },
};
const engine = new SemanticSearchEngine();
engine.addSource(vaultSource);
await engine.initialize();
```

On vault create/modify/rename/delete events, debounce and serialize `refreshSource(configuredVaultId)`. Dispose host listeners when the plugin unloads. Refresh rescans the registered source; the host owns its event scheduling. A failed source scan retains previous results; a host that cannot permit stale evidence should remove that source or refuse searches until refresh succeeds. `SearchResult` has enough line/path/URI information for a host to re-read exact evidence before risky edits.

