// Normal terminal line editing; no alternate screen or persistent composer.
import { createInterface } from 'node:readline/promises';
import { safe, wrap } from './format.mjs';

export function validateQuery(query) {
  if (!query.trim() || query.length > 300 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(query)) {
    throw new Error('Use 1–300 characters without terminal control characters.');
  }
  return query;
}

export async function promptForQuery(options, { input = process.stdin, output = process.stderr,
  header = true, history = [], signal, commands = false } = {}) {
  const row = text => { for (const line of wrap(text, options.width - 4)) output.write('  ' + line + '\n'); };
  if (header) {
    output.write('\n'); row('PROVENA / SEARCH'); row('─'.repeat(options.width - 4));
    row(`Source  ${safe(options.root)}`); row(`Mode    ${options.mode.toUpperCase()}`);
    if (options.sourceDefaulted) row('Current directory, recursively. Use --source PATH to choose another folder.');
    row(commands ? 'Queries reuse the index. /refresh checks changes; /help shows commands.' : 'Enter a query. Ctrl+C cancels before indexing.');
    output.write('\n');
  }
  const controller = new AbortController(); let interrupted = false;
  const reader = createInterface({ input, output, history: [...history], terminal: Boolean(input.isTTY && output.isTTY) });
  const interrupt = () => { interrupted = true; controller.abort(); };
  const close = () => controller.abort();
  reader.on('SIGINT', interrupt); reader.on('close', close);
  signal?.addEventListener('abort', interrupt, { once: true });
  if (signal?.aborted) interrupt();
  try {
    while (true) {
      const query = (await reader.question('  Query › ', { signal: controller.signal })).trim();
      try {
        validateQuery(commands && query.startsWith('/query ') ? query.slice(7).trim() : query);
        const previous = history.indexOf(query); if (previous >= 0) history.splice(previous, 1);
        history.unshift(query); history.length = Math.min(history.length, 50);
        return { query, exitCode: 0 };
      } catch (error) { row(error.message); }
    }
  } catch (error) {
    if (error.name !== 'AbortError') throw error;
    output.write('\n');
    return { query: null, exitCode: interrupted ? 130 : 0 };
  } finally {
    signal?.removeEventListener('abort', interrupt);
    reader.removeListener('SIGINT', interrupt); reader.removeListener('close', close); reader.close();
  }
}
