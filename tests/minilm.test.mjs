import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
test('portable MiniLM adapter handles lazy loading, batching, cancellation, validation and disposal offline', () => {
  execFileSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('./fixtures/minilm-offline.mjs', import.meta.url))], { stdio: 'pipe' });
});
