// Exercise the emitted root graph in a realm with web globals and no Node globals.
import { SourceTextModule, createContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
const context = createContext({ TextEncoder, TextDecoder, AbortController, AbortSignal, structuredClone });
const modules = new Map();
async function load(url) {
  if (!modules.has(url)) modules.set(url, readFile(new URL(url), 'utf8').then(code => new SourceTextModule(code, { context, identifier: url })));
  return modules.get(url);
}
const root = await load(new URL('../../dist/index.js', import.meta.url).href);
await root.link(async (specifier, parent) => {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) throw new Error(`Non-neutral dependency: ${specifier}`);
  const url = new URL(specifier, parent.identifier);
  if (url.pathname.includes('/adapters/')) throw new Error('Node adapter leaked into root graph');
  return load(url.href);
});
await root.evaluate();
context.SemanticSearchEngine = root.namespace.SemanticSearchEngine;
const exercise = new SourceTextModule(`
if (typeof process !== 'undefined' || typeof Buffer !== 'undefined' || typeof require !== 'undefined') throw new Error('Node global leaked');
let saved = null; let embeddings = 0; let queries = 0;
const storage = { async load() { return structuredClone(saved); }, async save(snapshot) { saved = structuredClone(snapshot); } };
const embedder = { id: 'browser-test-v1', dimensions: 2,
  async embedDocuments(texts) { embeddings += texts.length; return texts.map(() => new Float32Array([1, 2])); },
  async embedQuery() { queries++; return new Float32Array([2, 4]); } };
const source = { id: 'web', type: 'browser', async list() { return [{ id: 'a', sourceId: 'web', uri: 'memory:a', name: 'a.txt' }]; }, async read() { return { text: 'browser evidence' }; } };
for (let run = 0; run < 2; run++) {
  const engine = new SemanticSearchEngine({ storage, embedder }); engine.addSource(source); await engine.initialize();
  for (const mode of ['lexical', 'semantic', 'hybrid']) {
    const hits = await engine.search({ query: 'evidence', mode });
    if (hits.length !== 1 || (mode !== 'lexical' && hits[0].semanticRank !== 1)) throw new Error('No browser evidence');
  }
}
if (queries !== 4) throw new Error('Browser query inference count');
if (embeddings !== 1) throw new Error('Browser restart reuse failed');
`, { context });
await exercise.link(() => { throw new Error('Unexpected import'); }); await exercise.evaluate();
