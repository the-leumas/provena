import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { metrics, average } from '../scripts/evaluation/metrics.mjs';
import { ParserRegistry, chunkDocument } from '../dist/index.js';
test('evaluation metrics honor cutoffs, graded gains, duplicates, missing slots and undefined no-answer recall', () => {
    const rel = { a: 2, b: 1 };
    const m = metrics(['x', 'a', 'a', 'b'], rel);
    assert.equal(m.precisionAt5, 2 / 5);
    assert.equal(m.precisionAt10, 2 / 10);
    assert.equal(m.recallAt5, 1);
    assert.equal(m.mrr, .5);
    const expected = (3 / Math.log2(3) + 1 / Math.log2(4)) / (3 + 1 / Math.log2(3));
    assert.ok(Math.abs(m.ndcgAt5 - expected) < 1e-12);
    assert.equal(metrics(['a', 'b'], rel).ndcgAt5, 1);
    assert.equal(metrics([], rel).mrr, 0);
    assert.equal(metrics(['a'], {}).recallAt5, null);
    assert.equal(metrics(['a'], {}).ndcgAt10, null);
    assert.equal(average([m, metrics([], rel)]).recallAt5, .5);
    const late = metrics(['x', 'y', 'z', 'u', 'v', 'a'], rel);
    assert.equal(late.recallAt5, 0);
    assert.equal(late.recallAt10, .5);
    assert.equal(late.mrr, 1 / 6);
});
test('representative judgments are complete, independently addressable and cover all ten query classes', async () => {
    const corpus = JSON.parse(await readFile(new URL('./fixtures/representative/corpus.json', import.meta.url)));
    const { queries } = JSON.parse(await readFile(new URL('./fixtures/representative/queries.json', import.meta.url)));
    assert.equal(Object.keys(corpus.documents).length, 64);
    assert.equal(queries.length, 50);
    assert.equal(new Set(queries.map(q => q.id)).size, 50);
    assert.equal(new Set(queries.map(q => q.class)).size, 10);
    let chunks = 0;
    for (const [name, text] of Object.entries(corpus.documents))
        chunks += chunkDocument(await new ParserRegistry().parse({ id: name, sourceId: 's', name, uri: 'memory:' + name }, { text })).length;
    assert.ok(chunks > 64 && chunks <= 100);
    for (const q of queries) {
        assert.ok(q.rationale);
        for (const [id, grade] of Object.entries(q.relevance)) {
            assert.ok(id in corpus.documents);
            assert.ok(grade === 1 || grade === 2);
        }
        assert.equal(Object.keys(q.relevance).length === 0, ['negative', 'near-miss'].includes(q.class));
    }
});
