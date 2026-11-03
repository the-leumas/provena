#!/usr/bin/env node
// Repository-only presentation code. Retrieval uses the published entrypoints.
import { resolve, join } from 'node:path';
import { realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { safe, wrap, renderDemo, createProgress, crop, displayWidth } from './format.mjs';
import { runSearch } from './runtime.mjs';
export { runSearch } from './runtime.mjs';
export { selectExcerpt, displayWidth, createProgress, cachedModelDirectory } from './format.mjs';

const project = fileURLToPath(new URL('..', import.meta.url));

// MiniLM download cache: PROVENA_CACHE_DIR, else a pre-existing checkout cache, else the per-user cache.
export function defaultCacheDir(env = process.env) {
  if (env.PROVENA_CACHE_DIR) return resolve(env.PROVENA_CACHE_DIR);
  const checkout = resolve(project, '.cache/minilm');
  if (existsSync(checkout)) return checkout;
  return join(env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(homedir(), '.cache'), 'provena', 'minilm');
}
export const help = `Usage: provena [options] (or node cli/cli.mjs [options])
  --query TEXT           Search once; omit for an interactive query session
  --mode MODE            lexical (default), semantic, hybrid
  --source DIR           Document directory (default: current directory, recursively)
  --fixture              Use the bundled TypeScript job queue
  --limit N              Ranked passages, 1–100 (default: 3)
  --lines N              Maximum excerpt lines, 1–30 (default: 8)
  --width N              Output columns, 20–200 (default: terminal, capped at 100)
  --color WHEN           auto (default), always, never
  --showcase             Stable 88-column presentation; no progress messages
  --dev                  Show indexing diagnostics and timing boundaries
  --compare              Search one index in lexical, semantic, and hybrid modes
  --full                 Display full passages instead of shortened excerpts
  --save-index [DIR]     Save/reuse under DIR/.provena-indexes (default: cwd)
  --index-location FILE  Load, refresh, and save an existing CLI index file
  --verify-content       Reread all documents; reuse matching embedding inputs
  --no-index             Ignore saved indexes; run entirely in memory
  --cache-dir DIR        MiniLM cache (default: $PROVENA_CACHE_DIR, else ~/.cache/provena/minilm)
  --model-dir DIR        Staged MiniLM-L6-v2 assets; disable remote model loading
  --embedder NAME        Embedding backend: minilm (default) or ollama
  --ollama-model NAME    Ollama model name (required with --embedder ollama)
  --ollama-url URL       Ollama base URL (not specified, uses default: http://localhost:11434)
  --help                 Show this help

CLI output is the default. Without --query, a terminal prompts for repeated queries.
Use /refresh to check source changes, /help for commands, and /quit to exit.

Without --source, search the current directory and its subdirectories.
Choose --source PATH to search another directory. For a code retrieval demo:
  --source ${JSON.stringify(resolve(project, 'src'))} --query refreshSource
Or use --fixture for the bundled job queue (${safe(resolve(project, 'cli/fixtures/source'))}).

Semantic/hybrid use real MiniLM on CPU. First use may download model assets;
complete cached assets are loaded directly from disk without remote requests.
Existing source-bound indexes in cwd/.provena-indexes are reused automatically.
Paths are relative to the selected source; ranks are retrieval order, not confidence.
All canonical supported file types are admitted; see docs/file-types.md.
Symlinks, non-regular files, unknown extensions, and files over 2 MiB are skipped.
Binary/invalid UTF-8 content fails the run. Saved CLI index artifacts are excluded.
`;

export function optionsFrom(argv, terminal = process.stdout, env = process.env) {
  // parseArgs has no optional string values. Normalize this one option without
  // interpreting values belonging to other options as flags.
  const normalized = [];
  const strings = new Set(['query', 'mode', 'source', 'limit', 'lines', 'width', 'color', 'cache-dir', 'model-dir', 'index-location', 'embedder', 'ollama-model', 'ollama-url']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--save-index') {
      const value = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : '';
      normalized.push(`--save-index=${value}`);
    } else {
      normalized.push(arg);
      if (strings.has(arg.slice(2)) && arg.startsWith('--') && i + 1 < argv.length) normalized.push(argv[++i]);
    }
  }
  const { values: v } = parseArgs({ args: normalized, options: {
    query: { type: 'string' }, mode: { type: 'string' }, source: { type: 'string' },
    fixture: { type: 'boolean' }, limit: { type: 'string' }, lines: { type: 'string' },
    width: { type: 'string' }, color: { type: 'string' }, showcase: { type: 'boolean' },
    'cache-dir': { type: 'string' }, 'model-dir': { type: 'string' }, help: { type: 'boolean' },
    dev: { type: 'boolean' }, compare: { type: 'boolean' }, full: { type: 'boolean' },
    'save-index': { type: 'string' }, 'index-location': { type: 'string' },
    'verify-content': { type: 'boolean' }, 'no-index': { type: 'boolean' },
    embedder: { type: 'string' }, 'ollama-model': { type: 'string' }, 'ollama-url': { type: 'string' },
  } });
  if (v.help) return { help: true };
  if (v['save-index'] !== undefined && v['index-location'] !== undefined) throw new Error('Choose --save-index or --index-location');
  if (v['no-index'] && (v['save-index'] !== undefined || v['index-location'] !== undefined)) throw new Error('Choose --no-index or persistence flags');
  if (v['index-location'] !== undefined && !v['index-location'].trim()) throw new Error('--index-location requires an index file');
  const integer = (value, fallback, min, max, name) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`);
    return n;
  };
  const mode = v.mode ?? 'lexical';
  if (!['lexical', 'semantic', 'hybrid'].includes(mode)) throw new Error('mode must be lexical, semantic, or hybrid');
  if (v.source !== undefined && !v.source.trim()) throw new Error('--source requires a directory path');
  if (v.fixture && v.source !== undefined) throw new Error('Choose --fixture or --source');
  if (v.dev && v.showcase) throw new Error('Choose --dev or --showcase');
  const embedderName = v.embedder ?? 'minilm';
  if (!['minilm', 'ollama'].includes(embedderName)) throw new Error('embedder must be minilm or ollama');
  if (embedderName === 'ollama' && !v['ollama-model']) throw new Error('--ollama-model NAME is required with --embedder ollama');
  if (v['ollama-model'] && embedderName !== 'ollama') throw new Error('--ollama-model requires --embedder ollama');
  if (v['ollama-url'] && embedderName !== 'ollama') throw new Error('--ollama-url requires --embedder ollama');
  if (v['ollama-url']) { try { new URL(v['ollama-url']); } catch { throw new Error('--ollama-url must be a valid URL'); } }
  const query = v.query ?? (v.fixture ? 'retryJob' : 'refreshSource');
  if (!query.trim() || query.length > 300 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(query)) {
    throw new Error('query must contain 1–300 characters without terminal control characters');
  }
  const colorMode = v.color ?? 'auto';
  if (!['auto', 'always', 'never'].includes(colorMode)) throw new Error('color must be auto, always, or never');
  if (!v.showcase && v.width === undefined && terminal.columns < 20) throw new Error('Terminal is too narrow; use at least 20 columns');
  const width = integer(v.width, v.showcase ? 88 : Math.max(20, Math.min(terminal.columns ?? 88, 100)), 20, 200, 'width');
  return {
    provided: new Set(Object.keys(v)),
    query, mode, width, showcase: v.showcase ?? false,
    color: colorMode === 'always' || (colorMode === 'auto' && !('NO_COLOR' in env) && (v.showcase || Boolean(terminal.isTTY))),
    limit: integer(v.limit, 3, 1, 100, 'limit'), lines: integer(v.lines, 8, 1, 30, 'lines'),
    root: v.source !== undefined ? resolve(v.source) : v.fixture ? resolve(project, 'cli/fixtures/source') : process.cwd(),
    label: v.fixture ? 'fixture/' : 'source/',
    sourceDefaulted: v.source === undefined && !v.fixture,
    cacheDir: resolve(v['cache-dir'] ?? defaultCacheDir(env)),
    modelDir: v['model-dir'] !== undefined ? resolve(v['model-dir']) : undefined,
    dev: v.dev ?? false, compare: v.compare ?? false, full: v.full ?? false,
    sourceProvided: v.source !== undefined,
    saveIndexBase: v['save-index'] !== undefined ? resolve(v['save-index'] || process.cwd()) : undefined,
    indexLocation: v['index-location'] !== undefined ? resolve(v['index-location']) : undefined,
    verifyContent: v['verify-content'] ?? false,
    noIndex: v['no-index'] ?? false,
    embedder: embedderName,
    ollamaModel: v['ollama-model'],
    ollamaUrl: v['ollama-url'],
  };
}

export async function runDemo(options, progress = () => {}) {
  const record = await runSearch(options, progress);
  return { report: record.report, entries: record.runs[0].entries, output: renderRun(options, record), record };
}

function timing(ms) { return `${ms.toFixed(1)} ms`; }

export function renderPreparation(record) {
  const r = record.report;
  return `Ready · ${r.documents} files · ${r.chunks} passages · ${r.documentsReused} files reused · ${r.documentsParsed} files processed · ${r.embeddedTexts} new embedding inputs`;
}

export function renderRun(options, record) {
  const lines = [];
  const row = text => { for (const part of wrap(text, options.width - 4)) lines.push('  ' + part); };
  if (!options.showcase && options.preparation !== false) {
    if (!options.session) { row(`Source  ${safe(record.index?.sourceRoot ?? options.root)}`); row(`Mode    ${options.mode.toUpperCase()}`); }
    if (!options.dev) {
      row(renderPreparation(record));
      row(`Persistence: ${record.index ? options.session ? record.report.persistence : `${record.index.state} index · ${record.report.persistence}` : 'in-memory'}`);
      if (record.index) {
        row(`${options.session ? 'Index' : record.index.state === 'loaded' ? 'Used index' : record.index.state === 'rebuilt' ? 'Loaded index' : record.index.state === 'new' ? 'Created index' : 'Index'} ${record.index.path}${record.index.automatic ? ' (auto-selected)' : ''}`);
        if (record.report.persistence === 'unchanged') row('Index unchanged; no write needed.');
        if (record.report.persistence === 'preserved') row('Saved semantic vectors preserved; lexical changes remain in memory.');
        else if (record.index.rebuildReasons.length) row(`Index compatibility changed: ${record.index.rebuildReasons.join(', ')}; updated incompatible parts, reused compatible content`);
      } else if (options.memoryHint !== false) row('Use --save-index to retain this index for future runs.');
      lines.push('');
    } else {
      row(`Indexing ${timing(record.timings.indexingMs)} · Search ${timing(record.runs.reduce((sum, run) => sum + run.searchMs, 0))} · ${options.session ? 'Session elapsed' : 'Total'} ${timing(record.timings.totalMs)}`);
      row(`Admission ${record.observations.admittedFiles} files · Parsing ${record.observations.parsedDocuments} documents · Chunking ${record.corpus.passages} passages`);
      row(`Embedding ${record.observations.embeddingInputs} unique inputs · Persistence: ${record.index ? `${record.index.state} index · ${record.report.persistence}` : 'in-memory'}`);
      if (record.index) {
        if (record.index.state === 'loaded') row(`Used index ${record.index.path}${record.index.automatic ? ' (auto-selected)' : ''}`);
        else if (record.index.state === 'rebuilt') row(`Loaded index ${record.index.path} · updated incompatible parts, reused compatible content`);
        else row(`Created index ${record.index.path}`);
        row(record.index.state === 'loaded' ? 'Refresh: source files checked; actual reuse counts below' : 'Build: source files read, parsed, and chunked');
        row(`Files ${record.report.documentsRead} read · ${record.report.documentsParsed} parsed · ${record.report.documentsReused} reused · ${record.report.documentsDeleted} removed`);
        row(`Reuse ${record.report.unchangedChunks} unchanged passages · ${record.report.reusedVectors} shared/reused vectors`);
        if (record.report.persistence === 'unchanged') row('Index unchanged; no write needed.');
        if (record.index.saved) row(`Saved index ${record.index.path}`);
        row(`Index load ${timing(record.timings.indexLoadMs)} · Save ${timing(record.timings.indexSaveMs)}`);
        if (record.index.rebuildReasons.length) row(`Rebuilt: changed ${record.index.rebuildReasons.join(', ')}`);
      }
      if (record.observations.indexArtifactsExcluded) row(`Excluded ${record.observations.indexArtifactsExcluded} supported index artifacts to prevent self-indexing`);
    }
  }
  if (options.dev && options.preparation !== false) {
    row('DEVELOPMENT / MEASURED OPERATIONS');
    if (options.session) row('Indexing and verification timings accumulate across this session.');
    row('Discovery: adapter scan; encountered/excluded counts are not exposed');
    row(`Scan + admission ${timing(record.timings.scanAdmissionMs)} · Reading ${timing(record.timings.readMs)} · Parsing ${timing(record.timings.parsingMs)}`);
    row(`Document embedding ${timing(record.timings.embeddingMs)} · Model load ${timing(record.timings.modelLoadMs)} (nested in first document/query inference)`);
    if (record.index) row(`Index file ${record.index.path}`);
    row('Chunking/commit time not exposed separately; indexing includes transient snapshot construction');
    row(`Verification ${timing(record.timings.verificationMs)} · model ${record.model?.loading ?? 'none'}`);
    row(`Corpus SHA-256 ${record.corpus.identity}`);
    if (record.model) row(`Model ${record.model.name}@${record.model.revision} · ${record.model.device}/${record.model.dtype}`);
    row('File passage counts (up to 12; complete manifest in JSON):');
    for (const file of [...record.corpus.files].sort((a, b) => b.passages - a.passages || a.path.localeCompare(b.path)).slice(0, 12)) {
      row(`${file.passages} passages · ${file.parser} · ${file.path}`);
    }
  }
  for (const query of record.queries) {
    const runs = record.runs.filter(run => run.queryId === query.id);
    if (runs.length > 1) {
      row(`COMPARE / ${query.query}`);
      const column = Math.floor((options.width - 4) / 3);
      if (column >= 24) {
        row(runs.map(run => run.mode.toUpperCase().padEnd(column)).join(''));
        for (let rank = 0; rank < options.limit; rank++) {
          if (!runs.some(run => run.entries[rank])) break;
          row(runs.map(run => {
            const result = run.entries[rank]?.result;
            const text = result ? `${rank + 1} ${result.path}:L${result.startLine}` : '—';
            const window = crop(text, column - 1); const shown = window.text + (window.right ? '…' : '');
            return shown + ' '.repeat(column - displayWidth(shown));
          }).join(''));
        }
      } else for (const run of runs) row(`${run.mode.toUpperCase()}: ${run.entries.map(({ result }) => `${result.combinedRank} ${result.path}:L${result.startLine}`).join(' · ') || 'no results'}`);
    }
    for (const run of runs) {
      if (!options.showcase && options.dev) row(`${query.id} / ${run.mode}: ${timing(run.searchMs)} search · ${timing(run.queryEmbeddingMs)} query inference`);
      lines.push(renderDemo({ ...options, compact: !options.showcase, label: record.corpus.label, query: run.query, mode: run.mode }, record.report, run.entries));
      if (!options.showcase) row(`Search ${timing(run.searchMs)}${options.dev ? ` · Query embedding ${timing(run.queryEmbeddingMs)}` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function main() {
  let options; let display;
  const controller = new AbortController();
  const interrupt = () => { controller.abort(); display?.stop(); };
  try {
    options = optionsFrom(process.argv.slice(2));
    if (options.help) { process.stdout.write(help); return; }
    if (!options.provided.has('query') && !options.showcase) {
      if (!process.stdin.isTTY) throw new Error('Provide --query "project overview", or run in a terminal to enter a query.');
      if (process.stdout.isTTY && !options.compare) {
        const { runInteractive } = await import('./scrollback.mjs');
        process.exitCode = await runInteractive(options, { render: renderRun });
        return;
      }
      const { promptForQuery } = await import('./prompt.mjs');
      const answer = await promptForQuery(options);
      if (answer.query === null) { process.exitCode = answer.exitCode; return; }
      options.query = answer.query; options.provided.add('query');
    }
    if (options.sourceDefaulted && !options.showcase) {
      process.stderr.write(`Source: ${safe(options.root)} (current directory, recursively). Use --source PATH to choose another folder.\n`);
      process.stderr.write(`Code demo: --source ${JSON.stringify(resolve(project, 'src'))} --query refreshSource; --fixture uses the bundled job queue at ${safe(resolve(project, 'cli/fixtures/source'))}.\n`);
    }
    display = createProgress(options);
    process.once('SIGINT', interrupt);
    const record = await runSearch(options, display.update, { signal: controller.signal });
    display.stop();
    process.stdout.write(renderRun(options, record));
  } catch (error) {
    display?.stop();
    if (controller.signal.aborted) { process.exitCode = 130; return; }
    const width = options?.width ?? 88;
    const showcase = options?.showcase ?? process.argv.slice(2).includes('--showcase');
    const message = showcase ? (!options ? 'Invalid demo options. Retry without --showcase or run --help.' : options.mode !== 'lexical' ?
      'Could not load the model, index the source, or verify results. Retry without --showcase for details.' :
      'Could not index the source or verify results. Retry without --showcase for details.') :
      `Search failed: ${error.message}${error.cause ? ` (${error.cause.message})` : ''}`;
    process.stderr.write(wrap(message, width).join('\n') + '\n');
    process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupt); }
}
if (process.argv[1] && await realpath(process.argv[1]).catch(() => undefined) === fileURLToPath(import.meta.url)) await main();
