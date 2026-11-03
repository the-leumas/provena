// A small repeat-query loop around the same runtime used by batch CLI runs.
import { createRuntime } from './runtime.mjs';
import { promptForQuery, validateQuery } from './prompt.mjs';
import { createProgress, describeError, safe, wrap } from './format.mjs';

export async function runInteractive(options, { render, input = process.stdin, output = process.stdout,
  status = process.stderr, prompt = promptForQuery, runtimeFactory = createRuntime } = {}) {
  const controller = new AbortController(); const history = [];
  const row = text => { for (const line of wrap(safe(text), options.width - 4)) status.write('  ' + line + '\n'); };
  let runtime; let display; let sessionBegan; let header = true; let memoryHintShown = false;
  const interrupt = () => { controller.abort(); display?.stop(); };
  process.on('SIGINT', interrupt);
  // Each operation owns its progress timer; prompts never compete with redraws.
  const operation = async task => {
    display = createProgress(options, status);
    runtime?.setProgress(display.update);
    try { return await task(display.update); }
    finally { display.stop(); display = undefined; }
  };
  const preparation = async () => {
    const record = await runtime.record([], [], sessionBegan);
    output.write(render({ ...options, session: true, memoryHint: !memoryHintShown }, record));
    if (!record.index) memoryHintShown = true;
  };
  try {
    while (!controller.signal.aborted) {
      const answer = await prompt(options, { input, output: status, header, history, signal: controller.signal, commands: true });
      header = false;
      if (answer.query === null) return answer.exitCode;
      let query = answer.query;
      if (query === '/quit') return 0;
      if (query === '/help') {
        row('/refresh — check source changes and update the index');
        row('/quit — exit; Ctrl+D also exits, Ctrl+C interrupts');
        row('/query TEXT — search literal text, including a command name');
        row('Source and mode stay fixed. Use arrow keys for editing/history and terminal scrollback for results.');
        continue;
      }
      if (query === '/refresh') {
        if (!runtime) { row('Enter a search query before preparing the index.'); continue; }
        try {
          await operation(() => runtime.refresh({ signal: controller.signal }));
          await preparation();
        } catch (error) {
          if (controller.signal.aborted) return 130;
          row(`Refresh failed: ${describeError(error)}. The previous committed index is retained.`);
        }
        continue;
      }
      if (query.startsWith('/query ')) query = query.slice(7).trim();
      else if (query.startsWith('/')) { row('Unknown command. Use /help, or /query TEXT to search literal text.'); continue; }
      try { validateQuery(query); } catch (error) { row(error.message); continue; }
      sessionBegan ??= performance.now(); const definition = { id: 'query', query };
      if (!runtime) {
        // Preparation errors end the session; no partially prepared engine is searched.
        await operation(async progress => {
          runtime = await runtimeFactory(options, progress);
          await runtime.refresh({ signal: controller.signal });
        });
        await preparation();
      }
      try {
        const run = await operation(() => runtime.search(query, options.mode, options, { signal: controller.signal }));
        const record = await runtime.record([definition], [run], sessionBegan);
        output.write(render({ ...options, session: true, preparation: false, memoryHint: !memoryHintShown }, record));
        if (!record.index) memoryHintShown = true;
      } catch (error) {
        if (controller.signal.aborted) return 130;
        row(`Search failed: ${describeError(error)}. Use /refresh to check source changes.`);
      }
    }
    return 130;
  } catch (error) {
    if (controller.signal.aborted) return 130;
    row(`Preparation failed: ${describeError(error)}`); return 1;
  } finally {
    process.removeListener('SIGINT', interrupt); display?.stop(); await runtime?.dispose();
  }
}
