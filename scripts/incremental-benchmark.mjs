// Disposable real-MiniLM filesystem lifecycle check; never indexes a user corpus.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionsFrom } from '../cli/cli.mjs';
import { createRuntime } from '../cli/runtime.mjs';
const root = await mkdtemp(join(tmpdir(), 'provena-incremental-benchmark-'));
const fetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('This benchmark requires the offline model cache'); };
try {
  for (let i = 0; i < 24; i++) await writeFile(join(root, `note-${i}.md`), `# Project ${i}\n\nThe worker processes queue ${i} and preserves its retry state after interruption.\n`);
  const options = optionsFrom(['--source', root, '--mode', 'semantic', '--save-index', root], { isTTY: false, columns: 100 }, {});
  const stages = [];
  for (const stage of ['cold', 'warm-restart', 'one-file-edit', 'verify-all']) {
    if (stage === 'one-file-edit') await writeFile(join(root, 'note-0.md'), '# Project 0\n\nThe queue now retains completed transactions in a durable log.\n');
    const runtime = await createRuntime(options); const at = performance.now();
    try {
      const report = await runtime.refresh({ verifyContent: stage === 'verify-all' });
      stages.push({ stage, elapsedMs: Number((performance.now() - at).toFixed(2)), ...report });
    } finally { await runtime.dispose(); }
  }
  assert.equal(stages[1].documentsRead, 0); assert.equal(stages[1].documentsParsed, 0); assert.equal(stages[1].embeddedTexts, 0); assert.equal(stages[1].persistence, 'unchanged');
  assert.equal(stages[2].documentsParsed, 1); assert.equal(stages[2].embeddedTexts, 1); assert.equal(stages[2].documentsReused, 23);
  assert.equal(stages[3].documentsParsed, 24); assert.equal(stages[3].embeddedTexts, 0);
  console.log(JSON.stringify({ node: process.version, model: 'pinned MiniLM, offline CPU fp32, batches of four', documents: 24,
    scope: 'disposable temporary source; refresh only, no query inference', stages }, null, 2));
} finally { globalThis.fetch = fetch; await rm(root, { recursive: true, force: true }); }
