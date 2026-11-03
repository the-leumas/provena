import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SemanticSearchEngine, createSearchSession, ParserRegistry, chunkDocument, FILE_TYPES } from '../dist/index.js';
import { FileIndexStorage } from '../dist/adapters/filesystem.js';
import { source, MemoryStorage, TestEmbedder } from './fixtures/lifecycle.mjs';
class Model extends TestEmbedder {
    async embedQuery(_text, options = {}) { options.signal?.throwIfAborted(); this.queryCalls++; return new Float32Array([1, 2, 3, 4]); }
}
async function setup(input = source(), storage = new MemoryStorage()) { const embedder = new Model(); const engine = new SemanticSearchEngine({ embedder, storage }); engine.addSource(input); await engine.initialize(); return { engine, input, storage, embedder }; }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
test('equivalent unordered source/tag/extension filters share cache without changing restrictions', async () => {
    const input = source();
    const list = input.list;
    input.list = async () => (await list()).map(doc => ({ ...doc, metadata: { tags: ['x', 'y'] } }));
    const { engine, embedder } = await setup(input);
    const run = createSearchSession(engine);
    const a = { query: 'material', sources: ['fixture', 'other'], filters: { tags: ['x', 'y'], extensions: ['TXT', '.md'] } };
    const b = { query: 'material', mode: 'hybrid', sources: ['other', 'fixture', 'fixture'], filters: { extensions: ['md', '.txt', '.txt'], tags: ['y', 'x', 'x'] } };
    assert.deepEqual(await run.search(a), await run.search(b));
    assert.equal(embedder.queryCalls, 1);
    assert.deepEqual(await run.search({ ...b, filters: { ...b.filters, tags: ['z'] } }), []);
    assert.equal(run.stats.hits, 1);
});
test('clear prevents older in-flight requests from repopulating cache', async () => {
    const { engine, embedder } = await setup();
    const gate = deferred();
    embedder.embedQuery = async () => { embedder.queryCalls++; await gate.promise; return new Float32Array([1, 2, 3, 4]); };
    const run = createSearchSession(engine);
    const pending = run.search({ query: 'alpha' });
    run.clear();
    gate.resolve();
    await pending;
    await run.search({ query: 'alpha' });
    assert.equal(embedder.queryCalls, 2);
});
test('empty sources, unsupported documents and blank files have no semantic candidates or inference', async () => {
    for (const initial of [{}, { 'x.pdf': 'not text' }, { 'empty.txt': '', 'space.md': '\n \n' }]) {
        const { engine, embedder, storage } = await setup(source('empty', initial));
        for (const mode of ['lexical', 'semantic', 'hybrid'])
            assert.deepEqual(await engine.search({ query: 'anything', mode }), []);
        assert.equal(embedder.count, 0);
        assert.equal(embedder.queryCalls, 0);
        assert.deepEqual(storage.snapshot.chunks, []);
        const restarted = new SemanticSearchEngine({ storage, embedder });
        restarted.addSource(source('empty', initial));
        await restarted.initialize();
        assert.deepEqual(await restarted.search({ query: 'anything' }), []);
    }
});
test('Unicode, emoji and non-Latin provenance survive indexing, retrieval and restart', async () => {
    const text = '# 記憶 🧠\n日本語の会話を保存する。 café مرحبا мир 👩🏽‍💻';
    const { engine, embedder, input, storage } = await setup(source('世界', { '資料.md': text }));
    for (const query of ['日本語', 'café', 'مرحبا', 'мир']) {
        const hit = (await engine.search({ query, mode: 'lexical' }))[0];
        assert.equal(hit.path, '資料.md');
        assert.equal(hit.snippet, text);
    }
    assert.deepEqual(await engine.search({ query: '👩🏽‍💻', mode: 'lexical' }), []);
    assert.equal((await engine.search({ query: '👩🏽‍💻', mode: 'semantic' }))[0].heading, '記憶 🧠');
    const restarted = new SemanticSearchEngine({ storage, embedder });
    restarted.addSource(input);
    await restarted.initialize();
    assert.equal(embedder.count, 1);
    assert.equal((await restarted.search({ query: '保存' }))[0].sourceId, '世界');
});
test('large Markdown/code, huge lines and malformed frontmatter preserve all nonblank source lines', async () => {
    const fixtures = [['large.md', Array.from({ length: 300 }, (_, i) => `${'#'.repeat(i % 6 + 1)} Repeated ${i % 3}\nParagraph ${i} substantive content.\n`).join('\n')],
        ['large.ts', Array.from({ length: 10000 }, (_, i) => `export const item${i} = ${i};`).join('\n')], ['huge.txt', '界'.repeat(350000)],
        ['front.md', '---\n' + 'metadata: [unterminated\n'.repeat(1000) + '---\n# Body\nactual evidence'], ['malformed.md', '---\ntags: [unfinished\n# Content\nvisible body']];
    for (const [name, text] of fixtures) {
        const parsed = await new ParserRegistry().parse({ id: name, sourceId: 's', name, uri: 'memory:' + name }, { text });
        const chunks = chunkDocument(parsed);
        assert.equal(parsed.text, text);
        const lines = text.split('\n');
        const covered = new Set();
        for (const chunk of chunks) {
            if (lines[chunk.startLine - 1].length > 1600) {
                assert.ok(lines.slice(chunk.startLine - 1, chunk.endLine).join('\n').includes(chunk.text));
                assert.ok(chunk.text.length <= 1600);
            } else {
                assert.equal(chunk.text, lines.slice(chunk.startLine - 1, chunk.endLine).join('\n'));
            }
            for (let i = chunk.startLine; i <= chunk.endLine; i++)
                covered.add(i);
        }
        // Check original fixture lines independently of parser-produced sections.
        const firstBodyLine = name === 'front.md' ? 1003 : 1;
        for (let i = firstBodyLine; i <= lines.length; i++)
            if (lines[i - 1].trim())
                assert.ok(covered.has(i), `${name} lost source line ${i}`);
        if (name === 'huge.txt') {
            assert.ok(chunks.length > 1);
            assert.ok(chunks.every(c => c.text.length <= 1600));
            assert.ok(chunks.every(c => c.startLine === 1 && c.endLine === 1));
        }
        if (name === 'front.md') {
            assert.ok(parsed.frontmatter.includes('unterminated'));
            assert.ok(chunks.every(c => !c.text.includes('metadata:')));
        }
        if (name === 'malformed.md') {
            assert.equal(parsed.frontmatter, undefined);
            assert.ok(chunks.some(c => c.text.includes('unfinished')));
        }
        if (name === 'large.md')
            assert.equal(parsed.headings.length, 300);
    }
});
test('every built-in uppercase extension retains registered parser and language', async () => {
    for (const type of FILE_TYPES)
        for (const extension of type.extensions) {
            const name = 'sample' + extension.toUpperCase();
            const parsed = await new ParserRegistry().parse({ id: name, sourceId: 's', name, uri: 'memory:x' }, { text: 'unicode λ evidence\nnext line' });
            assert.equal(parsed.language, type.language);
            assert.equal(parsed.parserId, type.parserId);
            assert.equal(chunkDocument(parsed)[0].language, type.language);
        }
});
test('twenty controlled search/refresh schedules retain captured generations and invalidate cached completions', async () => {
    const { engine, input, storage, embedder } = await setup(source('s', { 'old.txt': 'generation zero' }));
    const run = createSearchSession(engine, 3);
    for (let generation = 1; generation <= 20; generation++) {
        const gate = deferred(), entered = deferred(), saveGate = deferred();
        const oldPaths = engine.getCatalog().map(doc => doc.path);
        const originalQuery = embedder.embedQuery.bind(embedder);
        embedder.embedQuery = async () => { await gate.promise; return new Float32Array([1, 2, 3, 4]); };
        const beforeRefresh = run.search({ query: `generation ${generation}`, mode: 'semantic' });
        input.files.clear();
        input.files.set(`${generation}.txt`, `generation ${generation} new evidence`);
        const save = storage.save.bind(storage);
        storage.save = async (...args) => { entered.resolve(); await saveGate.promise; return save(...args); };
        const refreshing = engine.refreshSource('s');
        await entered.promise;
        const duringRefresh = engine.search({ query: 'generation', mode: 'hybrid' });
        saveGate.resolve();
        await refreshing;
        storage.save = save;
        gate.resolve();
        for (const result of await Promise.all([beforeRefresh, duringRefresh]))
            assert.deepEqual(result.map(hit => hit.path), oldPaths);
        embedder.embedQuery = originalQuery;
        assert.deepEqual((await run.search({ query: `generation ${generation}`, mode: 'semantic' })).map(hit => hit.path), [`${generation}.txt`]);
    }
    engine.removeSource('s');
    assert.deepEqual(await run.search({ query: 'generation 20', mode: 'semantic' }), []);
});
test('file snapshots tolerate unknown fields and reconcile rename, deletion, empty restart and truncation', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'semantic-durable-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'index.json');
    const storage = new FileIndexStorage(path);
    const { input, engine, embedder } = await setup(source(), storage);
    const snapshot = await storage.load();
    snapshot.future = { harmless: true };
    snapshot.chunks[0].future = 42;
    await storage.save(snapshot);
    const restored = new SemanticSearchEngine({ storage, embedder });
    restored.addSource(input);
    await restored.initialize();
    assert.equal(embedder.count, 3);
    input.files.set('moved.txt', input.files.get('a.txt'));
    input.files.delete('a.txt');
    await engine.refreshSource(input.id);
    let saved = await storage.load();
    assert.ok(!saved.chunks.some(c => c.documentId === 'a.txt'));
    assert.ok(saved.chunks.some(c => c.documentId === 'moved.txt'));
    input.files.clear();
    await engine.refreshSource(input.id);
    saved = await storage.load();
    assert.deepEqual(saved.documents, []);
    assert.deepEqual(saved.chunks, []);
    const empty = new SemanticSearchEngine({ storage, embedder });
    empty.addSource(input);
    await empty.initialize();
    assert.deepEqual(await empty.search({ query: 'alpha' }), []);
    await fs.writeFile(path, JSON.stringify(snapshot).slice(0, -15));
    await assert.rejects(storage.load(), SyntaxError);
});
test('failed canonical rename preserves old bytes, live generation and cleans temporary siblings', async (t) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'semantic-replace-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const path = join(root, 'index.json');
    const { engine, input } = await setup(source(), new FileIndexStorage(path));
    const before = await fs.readFile(path, 'utf8');
    const revision = engine.revision;
    input.files.set('a.txt', 'changed candidate');
    const mock = t.mock.method(fs, 'rename', async () => { throw new Error('injected replacement failure'); });
    syncBuiltinESMExports();
    try {
        await assert.rejects(engine.refreshSource(input.id), /replacement failure/);
    }
    finally {
        mock.mock.restore();
        syncBuiltinESMExports();
    }
    assert.equal(engine.revision, revision);
    assert.equal(await fs.readFile(path, 'utf8'), before);
    assert.deepEqual(await fs.readdir(root), ['index.json']);
    assert.equal((await engine.search({ query: 'alpha', mode: 'lexical' })).length, 1);
});
