// Resolve the optional Transformers.js runtime used by semantic mode.
//
// npx, global installs and library consumers may not have the optional peer in
// their resolution scope. The CLI installs the pinned runtime once into a
// per-user directory and imports it from there, so every install shape works.
import { spawn } from 'node:child_process';
import { readFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TRANSFORMERS_VERSION = '4.2.0';
const PACKAGE = '@huggingface/transformers';

export function defaultRuntimeDir(env = process.env) {
  if (env.PROVENA_RUNTIME_DIR) return resolve(env.PROVENA_RUNTIME_DIR);
  return join(env.XDG_CACHE_HOME ? resolve(env.XDG_CACHE_HOME) : join(homedir(), '.cache'), 'provena', 'runtime');
}

function packageEntry(manifest) {
  const exported = manifest.exports;
  if (typeof exported === 'string') return exported;
  if (exported && typeof exported === 'object') {
    const node = exported.node;
    if (typeof node === 'string') return node;
    if (node && typeof node === 'object') {
      const imported = node.import;
      if (typeof imported === 'string') return imported;
      if (imported && typeof imported === 'object' && typeof imported.default === 'string') return imported.default;
    }
    const fallback = exported.default;
    if (typeof fallback === 'string') return fallback;
    if (fallback && typeof fallback === 'object' && typeof fallback.default === 'string') return fallback.default;
  }
  return manifest.main;
}

export async function importTransformers(runtimeDir) {
  const packageDir = join(runtimeDir, 'node_modules', PACKAGE);
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  const entry = packageEntry(manifest);
  if (!entry) throw new Error(`The managed ${PACKAGE} package has no import entry`);
  return import(pathToFileURL(join(packageDir, entry)).href);
}

function npmCommand() {
  if (process.env.npm_execpath) return { command: process.execPath, prefix: [process.env.npm_execpath] };
  return { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', prefix: [] };
}

function runNpm(args, cwd) {
  const { command, prefix } = npmCommand();
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, [...prefix, ...args], {
      cwd,
      stdio: ['ignore', 'ignore', 'pipe'],
      shell: !process.env.npm_execpath && process.platform === 'win32',
    });
    let stderr = '';
    child.stderr.on('data', chunk => { if (stderr.length < 8192) stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) { resolveRun(); return; }
      const detail = stderr.trim().split('\n').filter(Boolean).slice(-4).join(' ');
      reject(new Error(`npm install exited with code ${code}${detail ? `: ${detail}` : ''}`));
    });
  });
}

export async function installTransformers(runtimeDir, { run = runNpm } = {}) {
  const staging = `${runtimeDir}.install-${process.pid}-${Date.now().toString(36)}`;
  await mkdir(dirname(runtimeDir), { recursive: true });
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  try {
    await writeFile(join(staging, 'package.json'), JSON.stringify({
      name: 'provena-semantic-runtime',
      version: '1.0.0',
      private: true,
      description: 'Managed runtime for Provena semantic search.',
    }, null, 2) + '\n');
    // Install scripts are intentionally skipped: the prebuilt CPU binaries are
    // bundled, while onnxruntime-node's postinstall tries to fetch CUDA assets.
    await run(['install', '--prefix', staging, '--no-save', '--no-audit', '--no-fund', '--ignore-scripts',
      `${PACKAGE}@${TRANSFORMERS_VERSION}`], staging);
    await rm(runtimeDir, { recursive: true, force: true });
    try { await rename(staging, runtimeDir); }
    catch (error) {
      // Another process may have published the same runtime first.
      if (error.code !== 'ENOTEMPTY' && error.code !== 'EEXIST') throw error;
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}

export function manualInstallMessage(runtimeDir = defaultRuntimeDir(), { install = true } = {}) {
  const disabled = install ? '' : ' Automatic installation is disabled.';
  return `Semantic mode needs ${PACKAGE}@${TRANSFORMERS_VERSION}.${disabled} Install it once with: npm install --prefix ${JSON.stringify(runtimeDir)} --ignore-scripts ${PACKAGE}@${TRANSFORMERS_VERSION}. Inside a project, use: npm install ${PACKAGE}@${TRANSFORMERS_VERSION}.${install ? ' Set PROVENA_NO_INSTALL=1 to disable automatic installation.' : ''}`;
}

function notFound(error) {
  return error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'ENOENT';
}

export async function loadTransformers({
  runtimeDir = defaultRuntimeDir(),
  install = true,
  notify = () => {},
  resolvePackage = () => import(PACKAGE),
  installer = installTransformers,
} = {}) {
  try { return { runtime: await resolvePackage(), source: 'resolved', runtimeDir: null }; }
  catch (error) { if (!notFound(error)) throw error; }

  try { return { runtime: await importTransformers(runtimeDir), source: 'managed', runtimeDir }; }
  catch (error) { if (!notFound(error)) throw error; }

  if (!install) throw new Error(manualInstallMessage(runtimeDir, { install: false }));
  notify();
  try { await installer(runtimeDir); }
  catch (error) {
    throw new Error(`Automatic installation failed: ${error.message}. ${manualInstallMessage(runtimeDir)}`, { cause: error });
  }
  try { return { runtime: await importTransformers(runtimeDir), source: 'installed', runtimeDir }; }
  catch (error) {
    throw new Error(`The installed runtime could not be loaded: ${error.message}. ${manualInstallMessage(runtimeDir)}`, { cause: error });
  }
}
