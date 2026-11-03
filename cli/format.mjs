// Shared terminal presentation and verified excerpt selection.
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultFileTypes } from '@theleumas/provena';

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const controls = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
export const safe = text => String(text).replace(controls, ' ');
export const normalize = text => text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
const escapeRegex = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paint = (text, style, color) => color && style ? `\x1b[${style}m${text}\x1b[0m` : text;

// Common terminal cell widths, including combining characters and emoji clusters.
function cells(text) {
  return [...segmenter.segment(text)].map(({ segment }) => ({ text: segment, width:
    /^[\p{Mark}\u200d\ufe0f]+$/u.test(segment) ? 0 :
      /[\p{Extended_Pictographic}\u1100-\u115f\u2329\u232a\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff01-\uff60\uffe0-\uffe6\u{1f1e6}-\u{1f1ff}\u{20000}-\u{3fffd}]/u.test(segment) ? 2 : 1,
  }));
}
export const displayWidth = text => cells(text).reduce((sum, cell) => sum + cell.width, 0);
export function wrap(text, width) {
  return proseLines(safe(text), width);
}

function literalPattern(query) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const literals = [...new Set([query.trim(), ...terms])].filter(Boolean).sort((a, b) => b.length - a.length);
  return new RegExp(literals.map(escapeRegex).join('|'), 'giu');
}
function matches(line, query) {
  return [...line.matchAll(literalPattern(query))].map(match => ({ start: match.index, end: match.index + match[0].length }));
}

export function selectExcerpt(result, text, query, maxLines, mode) {
  const all = normalize(text).split('\n');
  const { startLine, endLine } = result;
  if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine > all.length ||
      all.slice(startLine - 1, endLine).join('\n') !== result.snippet) {
    throw new Error('Source changed or passage provenance is invalid; rerun the demo');
  }
  const highlight = mode !== 'semantic' && result.lexicalRank !== undefined;
  let center = Math.floor((startLine - 1 + endLine - 1) / 2); let best = 0;
  if (highlight) {
    for (let i = startLine - 1; i < endLine; i++) {
      const hits = matches(all[i], query);
      if (!hits.length) continue;
      const phrase = all[i].toLowerCase().includes(query.trim().toLowerCase());
      const symbol = /\b(?:function|class|interface|type|const|let)\s+([\w$]+)/.exec(all[i])?.[1]
        ?? /^\s*(?:(?:public|private|static|async|readonly)\s+)*([\w$]+)\s*\(/.exec(all[i])?.[1];
      const declaration = symbol && !['if', 'for', 'while', 'switch', 'catch'].includes(symbol) && literalPattern(query).test(symbol);
      const usage = !/^\s*(?:import|\/\/|\/\*|\*)/.test(all[i]);
      const score = (phrase ? 100 : 0) + (declaration ? 40 : usage ? 20 : 0) + Math.min(hits.length, 20);
      if (score > best) { best = score; center = i; }
    }
  }
  const count = Math.min(maxLines, endLine - startLine + 1);
  const start = Math.max(startLine - 1, Math.min(center - Math.floor(count / 3), endLine - count));
  return { startLine: start + 1, endLine: start + count, lines: all.slice(start, start + count), highlight };
}

// Clip a contiguous horizontal window, keeping an exact match visible when possible.
// Ellipses are presentation markers, never source text.
export function crop(line, width, focus) {
  const units = cells(line); let offset = 0;
  for (const unit of units) { unit.start = offset; offset += unit.text.length; }
  if (displayWidth(line) <= width) return { text: line, start: 0, left: false, right: false };
  let begin = 0;
  if (focus && displayWidth(line.slice(0, focus.end)) > width - 1) {
    const at = units.findIndex(unit => unit.start + unit.text.length > focus.start);
    let room = Math.floor(width / 3);
    begin = Math.max(0, at);
    while (begin > 0 && room >= units[begin - 1].width) { room -= units[--begin].width; }
  }
  const left = begin > 0; let end = begin; let used = left ? 1 : 0;
  while (end < units.length && used + units[end].width <= width - 1) used += units[end++].width;
  return { text: units.slice(begin, end).map(unit => unit.text).join(''), start: units[begin]?.start ?? 0, left, right: end < units.length };
}

function codeLine(raw, width, query, highlight, color, language) {
  const line = safe(raw.replace(/\t/g, '    '));
  const hits = highlight ? matches(line, query) : [];
  const window = crop(line, width, hits[0]);
  const styles = Array(line.length).fill('');
  if (['typescript', 'javascript'].includes(language)) {
    const tokens = /\/\/.*|\/\*.*?(?:\*\/|$)|(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\b(?:export|import|from|async|await|return|if|else|throw|new|const|let|class|function|interface|type|try|catch|finally|for|of|while|private|readonly|undefined|null|true|false)\b|\b\d+(?:\.\d+)?\b/g;
    for (const token of line.matchAll(tokens)) {
      const style = token[0].startsWith('//') || token[0].startsWith('/*') ? '90' : /^["'`]/.test(token[0]) ? '32' : '36';
      styles.fill(style, token.index, token.index + token[0].length);
    }
  }
  for (const hit of hits) styles.fill('1;33', hit.start, hit.end);
  let rendered = window.left ? paint('…', '90', color) : '';
  let group = ''; let previous = '';
  for (let i = 0; i < window.text.length; i++) {
    const style = styles[window.start + i];
    if (style !== previous) { rendered += paint(group, previous, color); group = ''; previous = style; }
    group += window.text[i];
  }
  return rendered + paint(group, previous, color) + (window.right ? paint('…', '90', color) : '');
}

// Preserve prose verbatim across visual continuation rows, preferably at spaces.
// Each source line retains its own number; continuations have a blank gutter.
function proseLines(raw, width) {
  let remaining = safe(raw.replace(/\t/g, '    '));
  const rows = [];
  while (displayWidth(remaining) > width) {
    let end = 0; let used = 0; let space = 0;
    for (const cell of cells(remaining)) {
      if (used + cell.width > width) break;
      used += cell.width; end += cell.text.length;
      if (/\s/u.test(cell.text) && used >= width / 2) space = end;
    }
    end = space || end;
    rows.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  rows.push(remaining); return rows;
}

export function renderDemo(options, report, entries) {
  const { width, color, query, mode, label } = options;
  const output = []; const row = (text, style = '', indent = '  ') => {
    for (const part of wrap(text, width - indent.length)) output.push(indent + paint(part, style, color));
  };
  if (options.compact) {
    output.push(''); row(`Query  ${query}`, '1');
    row(`${mode.toUpperCase()} · ${entries.length} of up to ${options.limit} results`, '90'); output.push('');
  } else {
    output.push(''); row('PROVENA', '1');
    row('─'.repeat(width - 4), '90');
    row(`Query    ${query}`, '1');
    row(`Mode     ${mode.toUpperCase()}${mode === 'lexical' ? ' · no model' : ' · MiniLM-L6-v2 · CPU/fp32'}`, '36');
    row(`Corpus   ${label} · ${report.documents} files · ${report.chunks} passages`, '90');
    row(`Results  ${entries.length} of up to ${options.limit} ranked passages`, '90'); output.push('');
  }
  for (const { result, excerpt } of entries) {
    row(`${String(result.combinedRank).padStart(2, '0')}  ${result.path ?? result.documentId}`, '1;36');
    row(`Passage L${result.startLine}–${result.endLine} · Excerpt L${excerpt.startLine}–${excerpt.endLine}`, '90', '    ');
    const ranks = [result.lexicalRank !== undefined ? `lexical #${result.lexicalRank}` : '',
      result.semanticRank !== undefined ? `semantic #${result.semanticRank}` : ''].filter(Boolean);
    row(ranks.join(' · '), '90', '    ');
    const digits = String(excerpt.endLine).length;
    const type = defaultFileTypes.get(result.path ?? result.documentId);
    const prose = type?.parserId === 'markdown' || type?.parserId === 'text';
    for (const [i, line] of excerpt.lines.entries()) {
      const prefix = `    ${String(excerpt.startLine + i).padStart(digits)} │ `;
      const rows = prose ? proseLines(line, width - prefix.length) : [line];
      for (const [continuation, text] of rows.entries()) {
        const gutter = continuation ? `    ${' '.repeat(digits)} │ ` : prefix;
        output.push(paint(gutter, '90', color) + codeLine(text, width - prefix.length, query, excerpt.highlight, color, result.language));
      }
    }
    output.push('');
  }
  if (!entries.length) { row('No ranked passages for this query and mode.', '90'); output.push(''); }
  if (options.compact) row('Ranks are retrieval order, not confidence. … marks omitted text.', '90');
  else {
    row(mode === 'semantic' ? 'Passage context · ranks are retrieval order, not confidence.' :
      `${color ? 'Yellow = literal query text' : 'Literal highlights require color'} · ranks are retrieval order.`, '90');
    row('Excerpts stay inside passages; … marks omitted text.', '90'); output.push('');
  }
  return output.join('\n') + '\n';
}

// One animated stderr line; result output remains deterministic and independently usable.
export function createProgress(options, stream = process.stderr) {
  if (options.showcase || !stream.isTTY || process.env.TERM === 'dumb') return { update() {}, stop() {} };
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let state; let frame = 0; let timer; let lastDraw = -Infinity; let stopped = false;
  const began = performance.now();
  const width = () => Math.max(1, Math.min(options.width, stream.columns ?? options.width) - 1);
  const draw = () => {
    if (!state || stopped || state.phase === 'done' || Date.now() - lastDraw < 80) return;
    const room = width(); const compact = room < 40;
    let message;
    if (state.phase === 'read') {
      message = `${compact ? 'Files' : 'Reading files'} ${state.completed}/${state.total}`;
      if (room >= 50 && state.total > 0) {
        const filled = Math.floor(12 * state.completed / state.total);
        message += `  [${'━'.repeat(filled)}${'─'.repeat(12 - filled)}]`;
      }
    } else if (state.phase === 'model') {
      message = state.percent === undefined ? 'Loading MiniLM' :
        `Model ${Math.floor(state.percent)}%${state.file && !compact ? ` · ${state.file}` : ''}`;
    } else if (state.phase === 'verify') {
      message = `${compact ? 'Verify' : 'Checking sources'} ${state.completed}/${state.total}`;
    } else {
      message = { 'index-load': 'Loading saved index', 'index-save': 'Saving index atomically', runtime: 'Preparing MiniLM', scan: 'Discovering supported documents', check: `Checking revisions ${state.completed}/${state.total}`, parse: `Parsing ${state.completed}/${state.total}`, chunk: `Chunking complete · ${state.completed} passages`, embed: state.total === undefined ? 'Embedding passages' : `Embedding ${state.completed}/${state.total} inputs`, search: 'Searching passages' }[state.phase];
    }
    if (!message) return;
    const line = `${frames[frame++ % frames.length]} ${message}${room >= 50 ? ` · ${((performance.now() - began) / 1000).toFixed(1)}s` : ''}`;
    const visible = crop(line, room);
    // Overwrite first, then clear the tail to avoid displaying a blank frame.
    stream.write('\r' + paint(visible.text + (visible.right ? '…' : ''), '36', options.color) + '\x1b[K');
    lastDraw = Date.now();
  };
  return {
    update(event) {
      if (stopped) return;
      if (event.phase === 'index-rebuild' || event.phase === 'index-preserved') {
        state = undefined;
        stream.write('\r\x1b[2K');
        for (const line of wrap(event.message, width())) stream.write(line + '\n');
        return;
      }
      state = event;
      if (!timer) { timer = setInterval(draw, 80); timer.unref(); }
      // Reading and parsing alternate per file; phase changes share the frame limit.
      draw();
    },
    stop(success = false) {
      if (stopped) return;
      stopped = true; clearInterval(timer);
      if (!state) return;
      stream.write('\r\x1b[2K');
      if (success && state.phase === 'done') {
        const summaries = width() < 40 ? [`✓ ${state.report.documents} files`, `  ${state.report.chunks} passages`] :
          [`✓ ${state.indexState === 'loaded' ? 'Refreshed' : 'Indexed'} ${state.report.documents} files · ${state.report.chunks} passages`];
        for (const summary of summaries) for (const line of wrap(summary, width())) stream.write(paint(line, '32', options.color) + '\n');
      }
    },
  };
}

// Use the pinned cache as a local model: Hub-name tokenizer discovery can make
// metadata requests even when the revision-specific assets are already cached.
export async function cachedModelDirectory(cacheDir, model, revision) {
  const directory = join(cacheDir, model, revision);
  for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx']) {
    try {
      const info = await stat(join(directory, file));
      if (!info.isFile() || info.size === 0) return undefined;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined;
      throw error;
    }
  }
  return directory;
}
