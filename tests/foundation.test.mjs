import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { FILE_TYPES, FileTypeRegistry, getFileTypeDefinition, getSupportedExtensions, isSupportedFile, ParserRegistry,
  PlainTextParser, CodeParser, chunkDocument, contentHash, documentKey, SemanticSearchEngine, createSearchSession } from '../dist/index.js';
const doc = (name = 'a.md', sourceId = 'vault') => ({ id: name, name, path: name, sourceId, uri: `memory://${sourceId}/${name}` });
function source(id = 'vault', initial = { 'a.md': '# Retrieval\nIndex architecture', 'code.ts': 'export function validateSession() {\n  return true;\n}' }) {
  const files = new Map(Object.entries(initial));
  return { id, type: 'memory', files,
    async list() { return [...files.keys()].map(name => ({ ...doc(name, id), modifiedAt: 20, metadata: { tags: ['project'] } })); },
    async read(id) { if (!files.has(id)) throw new Error('missing'); return { text: files.get(id) }; },
  };
}
test('canonical registry covers supported text/code types and rejects binary/unknown extensions', () => {
  const expected = '.md .txt .js .jsx .mjs .cjs .ts .tsx .py .rs .go .java .c .cpp .h .hpp .html .css .scss .json .yaml .yml .toml .sh .bash .fish .sql'.split(' ');
  assert.deepEqual(getSupportedExtensions().sort(), expected.sort());
  for (const ext of expected) assert.ok(isSupportedFile('file' + ext.toUpperCase()));
  for (const ext of ['.pdf', '.docx', '.xlsx', '.pptx', '.jpg', '.mp3', '.zip', '.exe', '.unknown']) assert.equal(isSupportedFile('file' + ext), false);
  assert.equal(getFileTypeDefinition('nested/a.TSX').parserId, 'code');
  assert.throws(() => new FileTypeRegistry([FILE_TYPES[0], FILE_TYPES[0]]), /duplicate/);
});
test('Markdown preserves frontmatter, sections, links and fenced code without false headings', async () => {
  const parsed = await new ParserRegistry().parse(doc(), { text: '---\ntags: [keep]\n---\n# Main\nSee [[Other|label]] and [web](https://example.test).\n```ts\n# Not heading\n[[not-link]]\n```\n## Sub\nMore' });
  assert.equal(parsed.frontmatter, 'tags: [keep]'); assert.deepEqual(parsed.headings, ['Main', 'Sub']);
  assert.deepEqual(parsed.outgoingLinks, ['Other', 'https://example.test']);
  assert.equal(parsed.sections[0].startLine, 4); assert.ok(parsed.text.includes('# Not heading'));
  assert.equal(parsed.sections[1].heading, 'Sub');
});
test('setext Markdown and CRLF normalize while preserving source line numbers', async () => {
  const parsed = await new ParserRegistry().parse(doc(), { text: 'Title\r\n=====\r\ncontent\r\n' });
  assert.deepEqual(parsed.headings, ['Title']); assert.equal(parsed.sections[0].startLine, 1);
});
test('registry selects all initial parsers; structured text keeps incomplete configuration', async () => {
  const registry = new ParserRegistry();
  for (const [name, parserId] of [['a.md', 'markdown'], ['a.txt', 'text'], ['a.ts', 'code'], ['a.json', 'structured']]) {
    const parsed = await registry.parse(doc(name), { text: '{ incomplete\n  value' });
    assert.equal(parsed.parserId, parserId); assert.equal(parsed.text, '{ incomplete\n  value');
  }
  await assert.rejects(registry.parse(doc('a.md'), { text: 'bad\0content' }), /Binary/);
});
test('custom parser definitions and plain-text fallback use the same file registry', async () => {
  const types = new FileTypeRegistry([...FILE_TYPES, { ...FILE_TYPES[0], extensions: ['.custom'], parserId: 'custom' }]);
  const custom = { id: 'custom', supports: () => true, parse: (doc, content) => ({ ...new PlainTextParser().parse(doc, content), parserId: 'custom' }) };
  assert.equal((await new ParserRegistry([custom], types).parse(doc('x.custom'), { text: 'value' })).parserId, 'custom');
  assert.equal((await new ParserRegistry([new PlainTextParser()], types).parse(doc('x.custom'), { text: 'value' })).parserId, 'text');
  await assert.rejects(new ParserRegistry([], types).parse(doc('x.custom'), { text: 'value' }), /No parser/);
});
test('custom file types are recognized by built-in parsers with the configured language', async () => {
  const types = new FileTypeRegistry([
    ...FILE_TYPES,
    { ...FILE_TYPES[0], extensions: ['.note'], parserId: 'markdown', language: 'notebook' },
    { ...FILE_TYPES[3], extensions: ['.proto'], parserId: 'code', language: 'protocol' },
  ]);
  const parsers = new ParserRegistry(undefined, types, 'file-types-v1');
  const markdown = await parsers.parse(doc('guide.note'), { text: '# Example\nAn indexed note.' });
  assert.equal(markdown.parserId, 'markdown');
  assert.equal(markdown.language, 'notebook');
  assert.deepEqual(markdown.headings, ['Example']);
  const code = await parsers.parse(doc('api.proto'), { text: 'message Session { string token = 1; }' });
  assert.equal(code.parserId, 'code');
  assert.equal(code.language, 'protocol');

  const explicit = new ParserRegistry([new CodeParser(types)], types, 'file-types-v1');
  assert.equal((await explicit.parse(doc('api.proto'), { text: 'message Session {}' })).language, 'protocol');

  const engine = new SemanticSearchEngine({ parsers });
  engine.addSource(source('extended', { 'guide.note': '# Example\nAn indexed note.', 'api.proto': 'message Session { string token = 1; }' }));
  await engine.initialize();
  const [hit] = await engine.search({ query: 'Session', mode: 'lexical' });
  assert.equal(hit.documentId, 'api.proto');
  assert.equal(hit.language, 'protocol');
});
test('chunk identities are stable, source-aware and preserve line/heading provenance', async () => {
  const parsed = await new ParserRegistry().parse(doc(), { text: '# First\n' + 'line of text\n'.repeat(20) + '# Second\nfinal' });
  const chunks = chunkDocument(parsed, { targetChars: 80, overlapLines: 1 });
  assert.ok(chunks.length > 2); assert.deepEqual(chunks, chunkDocument(parsed, { targetChars: 80, overlapLines: 1 }));
  for (const chunk of chunks) assert.equal(chunk.text, parsed.text.split('\n').slice(chunk.startLine - 1, chunk.endLine).join('\n'));
  assert.equal(chunks.at(-1).heading, 'Second');
  assert.notEqual(contentHash('first'), contentHash('changed'));
  assert.notEqual(documentKey('a', 'same.md'), documentKey('b', 'same.md'));
  const other = chunkDocument({ ...parsed, document: { ...parsed.document, sourceId: 'other' } }, { targetChars: 80 });
  assert.notEqual(chunks[0].id, other[0].id);
});
test('chunking bounds oversized code lines without discarding content or line provenance', async () => {
  const text = 'export function x() {\n' + '  a();\n'.repeat(30) + 'x'.repeat(200) + '\n}';
  const chunks = chunkDocument(await new ParserRegistry().parse(doc('a.ts'), { text }), { targetChars: 64, overlapLines: 1 });
  for (let line = 1; line <= text.split('\n').length; line++) assert.ok(chunks.some(chunk => chunk.startLine <= line && chunk.endLine >= line));
  const line32Chunks = chunks.filter(chunk => chunk.startLine === 32 && chunk.endLine === 32);
  assert.ok(line32Chunks.length > 1);
  assert.ok(line32Chunks.every(chunk => chunk.text.length <= 64));
  assert.ok(line32Chunks.every(chunk => /^x+$/.test(chunk.text)));
});
test('vertical slice returns exact filename and symbol matches with full provenance', async () => {
  const engine = new SemanticSearchEngine(); engine.addSource(source()); await engine.initialize();
  for (const query of ['code.ts', 'validateSession']) {
    const [hit] = await engine.search({ query });
    assert.equal(hit.documentId, 'code.ts'); assert.equal(hit.sourceId, 'vault'); assert.equal(hit.uri, 'memory://vault/code.ts');
    assert.equal(hit.language, 'typescript'); assert.equal(hit.lexicalRank, 1); assert.equal(hit.semanticRank, undefined);
    assert.ok(hit.snippet.includes('validateSession')); assert.ok(hit.chunkId);
  }
});
test('filters narrow source, folder, extension, dates, tags and relationships', async () => {
  const engine = new SemanticSearchEngine(); engine.addSource(source('one', { 'sub/a.md': '# Index\n[[Link]]', 'submarine/b.txt': 'Index' }));
  engine.addSource(source('two', { 'sub/a.md': 'Index' })); await engine.initialize();
  const results = await engine.search({ query: 'Index', sources: ['one'], filters: { pathPrefix: 'sub', extensions: ['md'], modifiedAfter: 10, tags: ['project'], linkedTo: 'Link' } });
  assert.equal(results.length, 1); assert.equal(results[0].sourceId, 'one');
  assert.equal((await engine.search({ query: 'Index', sources: [] })).length, 0);
  assert.equal((await engine.search({ query: 'Index', filters: { createdAfter: 1 } })).length, 0);
  assert.equal((await engine.search({ query: 'Index', filters: { tags: ['missing'] } })).length, 0);
});
test('same relative paths remain distinct across sources and index views are immutable copies', async () => {
  const engine = new SemanticSearchEngine(); engine.addSource(source('one')); engine.addSource(source('two')); await engine.initialize();
  const results = await engine.search({ query: 'architecture' }); assert.equal(new Set(results.map(hit => hit.sourceId)).size, 2);
  const catalog = engine.getCatalog(); catalog[0].tags.push('injected'); assert.ok(!engine.getCatalog()[0].tags.includes('injected'));
  assert.throws(() => engine.addSource(source('one')), /duplicate/);
});
test('explicit refresh handles unchanged chunks, modification, rename and deletion', async () => {
  const input = source(); const engine = new SemanticSearchEngine(); engine.addSource(input); const [initial] = await engine.initialize();
  const again = await engine.refreshSource('vault'); assert.equal(again.unchangedChunks, initial.chunks);
  input.files.set('moved.md', input.files.get('a.md')); input.files.delete('a.md'); input.files.delete('code.ts');
  await engine.refreshSource('vault'); const hits = await engine.search({ query: 'architecture' });
  assert.equal(hits[0].path, 'moved.md'); assert.equal(engine.getCatalog().length, 1);
  input.files.set('moved.md', '# Changed\nnewword'); await engine.refreshSource('vault');
  assert.equal((await engine.search({ query: 'architecture' })).length, 0);
  assert.equal((await engine.search({ query: 'newword' })).length, 1);
});
test('failed/cancelled refresh keeps previous source snapshot', async () => {
  const input = source(); const engine = new SemanticSearchEngine(); engine.addSource(input); await engine.initialize(); const revision = engine.revision;
  input.read = async () => { throw new Error('offline'); };
  await assert.rejects(engine.refreshSource('vault'), /offline/); assert.equal(engine.revision, revision);
  assert.ok((await engine.search({ query: 'architecture' })).length);
  const abort = new AbortController(); abort.abort(); await assert.rejects(engine.refreshSource('vault', { signal: abort.signal }));
});
test('cross-source identities and duplicate document IDs cannot corrupt the catalog', async () => {
  const engine = new SemanticSearchEngine(); const input = source(); input.list = async () => [doc('a.md', 'wrong')]; engine.addSource(input);
  await assert.rejects(engine.initialize(), /identity/); assert.equal(engine.getCatalog().length, 0);
  input.list = async () => [doc(), doc()]; await assert.rejects(engine.initialize(), /identity/);
});
test('run cache isolates results, counts duplicates and invalidates after refresh', async () => {
  const input = source(); const engine = new SemanticSearchEngine(); engine.addSource(input); await engine.initialize(); const run = createSearchSession(engine, 2);
  const hit = await run.search({ query: 'architecture' }); hit[0].snippet = 'poison';
  assert.notEqual((await run.search({ query: ' ARCHITECTURE ' }))[0].snippet, 'poison'); assert.deepEqual(run.stats, { hits: 1, misses: 1 });
  input.files.clear(); await engine.refreshSource('vault'); assert.deepEqual(await run.search({ query: 'architecture' }), []);
  assert.equal(run.stats.misses, 2);
});
test('public core import graph is host-independent', async () => {
  async function walk(url) { const files = []; for (const entry of await readdir(url, { withFileTypes: true })) { if (entry.name === 'adapters') continue; const path = new URL(entry.name + (entry.isDirectory() ? '/' : ''), url); if (entry.isDirectory()) files.push(...await walk(path)); else if (entry.name.endsWith('.js')) files.push(path); } return files; }
  for (const path of await walk(new URL('../dist/', import.meta.url))) {
    const text = await readFile(path, 'utf8'); assert.doesNotMatch(text, /(?:from|import)\s*['"](?:node:|obsidian|@nexus|.*vector\/)/);
  }
});
