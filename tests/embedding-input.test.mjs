import test from 'node:test';
import assert from 'node:assert/strict';
import { embeddingTextForChunk, EMBEDDING_INPUT_VERSION, SemanticSearchEngine, ParserRegistry, chunkDocument } from '../dist/index.js';
import { source, TestEmbedder, MemoryStorage } from './fixtures/lifecycle.mjs';
test('embedding input preserves continuation headings without duplicating initial Markdown headings', async () => {
  assert.equal(embeddingTextForChunk({ text: 'body' }), 'body');
  assert.equal(embeddingTextForChunk({ text: 'body', heading: 'Context' }), 'Context\n\nbody');
  assert.equal(embeddingTextForChunk({ text: '## Context\nbody', heading: 'Context' }), '## Context\nbody');
  assert.equal(embeddingTextForChunk({ text: 'Context\n===\nbody', heading: 'Context' }), 'Context\n===\nbody');
  const parsed = await new ParserRegistry().parse({ id: 'a', sourceId: 's', name: 'a.md', uri: 'memory:a' }, { text: '# Context\n' + 'continuing text\n'.repeat(30) });
  const chunks = chunkDocument(parsed, { targetChars: 80 }); assert.ok(chunks.length > 2);
  assert.ok(embeddingTextForChunk(chunks[1]).startsWith('Context\n\n'));
});
test('embedding input is deterministic, path independent and sensitive to meaningful heading/content changes', () => {
  const chunk = { text: 'same body', heading: 'Gardening', path: 'a.md', uri: 'memory:a', sourceId: 'a', documentId: 'a' };
  const input = embeddingTextForChunk(chunk); assert.equal(embeddingTextForChunk(chunk), input);
  assert.equal(embeddingTextForChunk({ ...chunk, path: 'renamed.md', uri: 'memory:b', sourceId: 'b', documentId: 'b' }), input);
  assert.notEqual(embeddingTextForChunk({ ...chunk, heading: 'Software' }), input);
  assert.notEqual(embeddingTextForChunk({ ...chunk, text: 'changed body' }), input);
  assert.ok(EMBEDDING_INPUT_VERSION);
});
test('generic core infers unique structural inputs in one call and reuses them after rename/restart', async () => {
  const input = source('fixture', { 'a.txt': 'same body', 'b.txt': 'same body' });
  const parsers = new ParserRegistry();
  const original = parsers.parse.bind(parsers);
  let heading = 'Alpha';
  parsers.parse = async (doc, content) => { const parsed = await original(doc, content); parsed.sections[0].heading = doc.id === 'b.txt' ? 'Beta' : heading; return parsed; };
  const storage = new MemoryStorage(); const embedder = new TestEmbedder(); const engine = new SemanticSearchEngine({ parsers, storage, embedder }); engine.addSource(input);
  await engine.initialize(); assert.deepEqual(embedder.calls, [['Alpha\n\nsame body', 'Beta\n\nsame body']]);
  input.files.set('renamed.txt', input.files.get('a.txt')); input.files.delete('a.txt'); await engine.refreshSource(input.id); assert.equal(embedder.count, 2);
  heading = 'Gamma'; await engine.refreshSource(input.id); assert.equal(embedder.count, 3); assert.equal(embedder.calls.at(-1)[0], 'Gamma\n\nsame body');
  const restartedModel = new TestEmbedder(); const restarted = new SemanticSearchEngine({ parsers, storage, embedder: restartedModel }); restarted.addSource(input); await restarted.initialize(); assert.equal(restartedModel.count, 0);
  const many = source('many', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`${i}.txt`, `text ${i}`])));
  const generic = new TestEmbedder(); const manyEngine = new SemanticSearchEngine({ embedder: generic }); manyEngine.addSource(many); await manyEngine.initialize();
  assert.equal(generic.calls.length, 1); assert.equal(generic.calls[0].length, 40);
});
