# Maintained examples

These files use public package exports. They are included in the tarball as readable examples, not new package subpath exports. Copy/adapt them into a consumer or run the checkout after `npm run build`.

```sh
node --input-type=module -e "import { exerciseCore } from './examples/core.mjs'; console.log(await exerciseCore());"
```

- `evidence.mjs`: `retrieveUnassessedEvidence(engine, request)` preserves candidate evidence and reports `retrieved`/`no-results`, always with `answerability: 'not-assessed'`. Errors/abort reject; `indexChangedDuringSearch` reports only observed index revision overlap, never source freshness. This envelope is an example-local choice, not a public package contract.
- `core.mjs`: lexical-only indexing; custom SearchSource, memory-only IndexStorage, toy injected Embedder; semantic/hybrid retrieval, cache and restart checks. The two-topic vectors demonstrate plumbing and are not a production semantic model.
- `filesystem.mjs`: `searchFolder(approvedRoot, indexFilename, query)` uses explicit host paths and atomic Node storage. Create the index parent first; keep it outside indexed roots.
- `minilm.mjs`: `searchWithMiniLM(source, storage, query, options)` manages one concrete model lifetime. First inference may download files. Strict local deployments configure Transformers.js globals in host bootstrap before using this function; see integration docs.

The installed-tarball Node/browser test executes `exerciseCore` and `searchFolder`. The ordinary package test loads the MiniLM example with an empty source without loading a runtime; real Node and browser MiniLM acceptance separately prove actual inference. The browser harness bundles the installed core example into a page and a module worker. Production worker topology remains host-owned.

Browser commands (explicit, separate from offline `npm test`):

```sh
npx playwright install chromium
npm run test:browser
npm run test:browser:minilm
```

`BROWSER_EXECUTABLE` optionally selects a host browser executable. Browser MiniLM requires provisioned pinned fp32 assets (`MINILM_LOCAL_MODEL_DIR` or the documented `.cache/minilm` fixture), serves them and backend files from a temporary loopback server, selects WASM with one thread, and forbids external requests. It downloads no model itself. A successful local-server smoke is not certification of every browser, WebGPU, service-worker cache or offline PWA deployment.

## Evidence interpretation example

```js
import { retrieveUnassessedEvidence } from './evidence.mjs'; // Copy/adapt the maintained host example.
const observation = await retrieveUnassessedEvidence(engine, {
  query: 'What was the measured duration of the latest recovery drill?',
  mode: 'hybrid',
});
// observation.candidates are ranked passages, possibly just a drill procedure.
// observation.answerability is always 'not-assessed', including when candidates is [].
```

Do not convert `no-results` to “the corpus cannot answer”: lexical mismatches, empty queries or filters can also produce it. Do not convert nonempty results to “supported”: instructions to measure are not a measured value. A host choosing to verify support must separately define the task, eligible scope, evidence completeness, source currency/authority and treatment of contradictions. A failed assessment of top-K evidence does not prove absence elsewhere. There is no evaluator interface or assessment cache in this example. The core example and installed browser/worker harness exercise this helper; focused tests cover cancellation, model errors and concurrent refresh.
