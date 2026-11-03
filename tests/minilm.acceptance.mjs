// Explicit opt-in; each loading mode has isolated host runtime globals.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
for (const mode of ['hub', 'staged', 'hub-cache-only']) {
  execFileSync(process.execPath, [fileURLToPath(new URL('./minilm.real.mjs', import.meta.url)), `--mode=${mode}`], { stdio: 'inherit' });
}
