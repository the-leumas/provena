import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('root graph executes indexing, persistence, restart and all retrieval modes in a browser-like realm without Node globals', () => {
  execFileSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('./fixtures/browser-core.mjs', import.meta.url))], { stdio: 'pipe' });
});
