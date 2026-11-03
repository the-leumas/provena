import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { ParserRegistry, chunkDocument } from '../dist/index.js';
import { source } from './fixtures/lifecycle.mjs';
import { evidenceMetrics } from '../scripts/evaluation/evidence.mjs';
const read = path => readFile(new URL(path, import.meta.url), 'utf8');
test('evidence judgments bind exact chunks and preserve recorded Alpha.5 facts', async () => {
  const corpus = await read('./fixtures/representative/corpus.json'), queryText = await read('./fixtures/representative/queries.json');
  const overlay = JSON.parse(await read('./fixtures/evidence/judgments.json'));
  assert.equal(createHash('sha256').update(corpus).update(queryText).digest('hex'), overlay.alpha5FixtureSha256);
  const input = source('handbook', JSON.parse(corpus).documents), actual = [];
  for (const doc of await input.list()) for (const chunk of chunkDocument(await new ParserRegistry().parse(doc, await input.read(doc.id)))) actual.push({ key: `${doc.id}:${chunk.startLine}`, chunk });
  assert.deepEqual(actual, JSON.parse(await read('./fixtures/evidence/chunks.json')));
  const allowed = new Set(actual.map(row => row.key));
  const recorded = JSON.parse(queryText).queries;
  assert.deepEqual(overlay.queries.map(q => q.id), recorded.map(q => q.id));
  for (const q of overlay.queries) {
    assert.equal(q.query, recorded.find(old => old.id === q.id).query);
    assert.ok(q.requirement && q.rationale);
    for (const [key, grade] of Object.entries(q.grades)) { assert.ok(allowed.has(key)); assert.ok([1, 2].includes(grade)); }
    assert.equal(q.sufficientSets.length > 0, q.answerability === 'supported');
    for (const set of q.sufficientSets) { assert.ok(set.length); assert.equal(new Set(set).size, set.length); for (const key of set) assert.ok(q.grades[key] > 0); }
    for (const [key, grade] of Object.entries(q.grades)) if (grade === 2) assert.ok(q.sufficientSets.some(set => set.length === 1 && set[0] === key));
  }
});
test('chunk context is not sufficient evidence even within the same relevant document', () => {
  const q = { answerability: 'supported', grades: { 'same:1': 1, 'same:5': 2 }, sufficientSets: [['same:5']] };
  const context = evidenceMetrics(['same:1'], q);
  assert.equal(context.relevancePrecisionAt5, .2);
  assert.equal(context.sufficientSetHitAt5, 0);
  assert.equal(context.sufficientSetReciprocalRank, 0);
  const found = evidenceMetrics(['same:1', 'same:5'], q);
  assert.equal(found.sufficientSetHitAt5, 1);
  assert.equal(found.sufficientSetReciprocalRank, .5);
});
test('joint sufficiency requires a complete evidence set and supports alternatives without double counting', () => {
  const q = { answerability: 'supported', grades: { a: 1, b: 1, c: 1 }, sufficientSets: [['a', 'b'], ['a', 'c']] };
  assert.equal(evidenceMetrics(['a'], q).sufficientSetHitAt5, 0);
  assert.equal(evidenceMetrics(['a'], q).bestSetCoverageAt5, .5);
  assert.equal(evidenceMetrics(['a', 'c'], q).sufficientSetReciprocalRank, .5);
  const late = evidenceMetrics(['a', 'x', 'y', 'z', 'w', 'b'], q);
  assert.equal(late.sufficientSetHitAt5, 0);
  assert.equal(late.sufficientSetHitAt10, 1);
  assert.throws(() => evidenceMetrics(['a', 'a'], q), /Duplicate/);
});
test('unsupported and underspecified tasks do not get fake perfect or zero sufficiency recall', () => {
  for (const answerability of ['unsupported', 'underspecified']) {
    const m = evidenceMetrics(['topic'], { answerability, grades: { topic: 1 }, sufficientSets: [] });
    assert.equal(m.sufficientSetHitAt5, null);
    assert.equal(m.sufficientSetReciprocalRank, null);
    assert.equal(m.topGrade, 1);
  }
});
