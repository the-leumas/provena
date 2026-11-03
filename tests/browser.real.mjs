// Explicit real-browser test: install a tarball, bundle its public exports, run page + module worker.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm, symlink, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, extname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION } from '../dist/adapters/minilm.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'semantic-browser-'));
const real = process.argv.includes('--minilm');
let server, browser;
const errors = [];
const external = [];
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && key !== 'INIT_CWD'));
try {
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, env, encoding: 'utf8' }));
    const pack = Array.isArray(packed) ? packed[0] : packed.filename ? packed : packed['@theleumas/provena'];
    await writeFile(join(temporary, 'package.json'), JSON.stringify({ name: 'browser-consumer', private: true, type: 'module' }));
    execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(temporary, 'npm-cache'), join(temporary, pack.filename)], { cwd: temporary, env, stdio: 'pipe' });
    await assert.rejects(access(join(temporary, 'node_modules/@huggingface/transformers')));
    await mkdir(join(temporary, 'approved'));
    await writeFile(join(temporary, 'approved', 'note.md'), '# Portable\ninstallation evidence');
    const nodeSmoke = `import {exerciseCore} from './node_modules/@theleumas/provena/examples/core.mjs';
 import {searchFolder} from './node_modules/@theleumas/provena/examples/filesystem.mjs';
 await exerciseCore();const hits=await searchFolder(${JSON.stringify(join(temporary, 'approved'))},${JSON.stringify(join(temporary, 'index.json'))},'evidence');if(hits[0]?.path!=='note.md')throw new Error('Filesystem consumer failed');`;
    await writeFile(join(temporary, 'node-smoke.mjs'), nodeSmoke);
    execFileSync(process.execPath, ['node-smoke.mjs'], { cwd: temporary, stdio: 'pipe' });
    const core = `import {exerciseCore} from './node_modules/@theleumas/provena/examples/core.mjs';
 if(typeof globalThis.process!=='undefined'||typeof globalThis.Buffer!=='undefined'||typeof globalThis.require!=='undefined')throw new Error('Node globals leaked');`;
    await writeFile(join(temporary, 'worker.mjs'), core + `exerciseCore().then(result=>postMessage({result}),error=>postMessage({error:error.stack}));`);
    await writeFile(join(temporary, 'main.mjs'), core + `globalThis.smoke=(async()=>{const page=await exerciseCore();const worker=await new Promise((resolve,reject)=>{const w=new Worker('/worker.js',{type:'module'});w.onerror=reject;w.onmessage=e=>{w.terminate();e.data.error?reject(new Error(e.data.error)):resolve(e.data.result);};});return{page,worker};})();`);
    const meta = [];
    for (const name of ['main', 'worker']) {
        const result = await build({ entryPoints: [join(temporary, name + '.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile: join(temporary, name + '.js'), metafile: true });
        meta.push(result.metafile);
    }
    for (const m of meta)
        for (const path of Object.keys(m.inputs))
            assert.doesNotMatch(path, /adapters|transformers|onnx|node:/);
    const shaken = await build({ stdin: { contents: "import {isSupportedFile} from '@theleumas/provena';globalThis.supported=isSupportedFile('x.md');", resolveDir: temporary }, bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true, minify: true });
    assert.ok(!shaken.outputFiles[0].text.includes('SemanticSearchEngine'));
    assert.ok(!shaken.outputFiles[0].text.includes('MiniLM'));
    assert.ok(Object.values(shaken.metafile.outputs).every(o => Object.entries(o.inputs).every(([path, value]) => !path.endsWith('/engine.js') || value.bytesInOutput === 0)));
    let modelRoot;
    if (real) {
        await mkdir(join(temporary, 'node_modules/@huggingface'), { recursive: true });
        await symlink(join(root, 'node_modules/@huggingface/transformers'), join(temporary, 'node_modules/@huggingface/transformers'), 'dir');
        modelRoot = process.env.MINILM_LOCAL_MODEL_DIR ?? join(root, '.cache/minilm', MINILM_DEFAULT_MODEL, MINILM_DEFAULT_REVISION);
        for (const file of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model.onnx'])
            await access(join(modelRoot, file));
        const code = `import {env} from '@huggingface/transformers';import {MiniLMEmbedder} from '@theleumas/provena/minilm';
 import {SemanticSearchEngine} from '@theleumas/provena';import {memorySource,memoryStorage} from './node_modules/@theleumas/provena/examples/core.mjs';
 env.localModelPath='/models/';env.allowLocalModels=true;env.allowRemoteModels=false;env.useBrowserCache=false;
 env.backends.onnx.wasm.wasmPaths='/runtime/';env.backends.onnx.wasm.numThreads=1;
 const model=new MiniLMEmbedder({device:'wasm',dtype:'fp32',localFilesOnly:true});
 (async()=>{try{const start=performance.now();const docs=await model.embedDocuments(['reset account password','water garden plants']);const query=await model.embedQuery('recover login credentials');
 for(const vector of [...docs,query]){const norm=Math.sqrt(vector.reduce((s,v)=>s+v*v,0));if(!(vector instanceof Float32Array)||vector.length!==384||!vector.every(Number.isFinite)||Math.abs(norm-1)>.001)throw new Error('Bad WASM vector');}
 const engine=new SemanticSearchEngine({embedder:model,storage:memoryStorage()});engine.addSource(memorySource(new Map([['auth.txt','reset account password'],['garden.txt','water garden plants']])));await engine.initialize();
 const hit=(await engine.search({query:'recover login credentials',mode:'semantic'}))[0];if(hit?.path!=='auth.txt')throw new Error('Browser semantic retrieval failed');
 await model.dispose();postMessage({result:{dimensions:query.length,normalized:true,semantic:true,disposed:true,elapsedMs:performance.now()-start}});
 }catch(error){postMessage({error:error.stack+' '+error.cause?.stack});}finally{await model.dispose();}})();`;
        await writeFile(join(temporary, 'minilm-worker.mjs'), code);
        await build({ entryPoints: [join(temporary, 'minilm-worker.mjs')], bundle: true, format: 'esm', platform: 'browser', outfile: join(temporary, 'minilm-worker.js') });
    }
    const allowed = new Map(['/main.js', '/worker.js', '/minilm-worker.js'].map(path => [path, join(temporary, path.slice(1))]));
    const resolveWithin = (base, suffix) => { const path = resolve(base, suffix); const rel = relative(base, path); if (rel === '..' || rel.startsWith('../') || isAbsolute(rel))
        throw new Error('Outside fixture root'); return path; };
    server = createServer(async (req, res) => {
        try {
            const path = new URL(req.url, 'http://localhost').pathname;
            res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
            res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
            if (path === '/') {
                res.setHeader('Content-Type', 'text/html');
                res.end('<script type="module" src="/main.js"></script>');
                return;
            }
            let file = allowed.get(path);
            const prefix = '/models/' + MINILM_DEFAULT_MODEL + '/';
            if (real && path.startsWith(prefix))
                file = resolveWithin(modelRoot, path.slice(prefix.length));
            if (real && path.startsWith('/runtime/'))
                file = resolveWithin(join(root, 'node_modules/onnxruntime-web/dist'), path.slice('/runtime/'.length));
            if (!file) {
                res.statusCode = 404;
                res.end();
                return;
            }
            await access(file);
            res.setHeader('Content-Type', extname(file) === '.wasm' ? 'application/wasm' : extname(file) === '.json' ? 'application/json' : 'text/javascript');
            if (req.method === 'HEAD') {
                res.end();
                return;
            }
            const stream = createReadStream(file);
            stream.on('error', () => res.destroy());
            stream.pipe(res);
        }
        catch {
            res.statusCode = 404;
            res.end();
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : {}) });
    const context = await browser.newContext();
    await context.route('**/*', route => { if (!route.request().url().startsWith(origin + '/')) {
        external.push(route.request().url());
        return route.abort();
    } return route.continue(); });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.waitForFunction(() => globalThis.smoke !== undefined, null, { timeout: 10000 }).catch(error => { throw new Error('Browser entry failed: ' + errors.join('; '), { cause: error }); });
    const result = await page.evaluate(() => globalThis.smoke);
    assert.ok(result.page.hybrid && result.worker.hybrid);
    let minilm = null;
    if (real)
        minilm = await page.evaluate(() => new Promise((resolve, reject) => { const w = new Worker('/minilm-worker.js', { type: 'module' }); const timer = setTimeout(() => { w.terminate(); reject(new Error('MiniLM worker timeout')); }, 180000); w.onerror = reject; w.onmessage = e => { clearTimeout(timer); e.data.error ? reject(new Error(e.data.error)) : resolve(e.data.result); }; }));
    assert.deepEqual(external, []);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ browser: browser.version(), core: result, pageAndWorker: true, installedTarball: pack.filename, corePeerAbsent: true, nodeFilesystem: true, treeShakenBytes: shaken.outputFiles[0].contents.length, coreBundleBytes: (await readFile(join(temporary, 'worker.js'))).length, externalRequests: external, minilm }, null, 2));
}
finally {
    if (browser)
        await browser.close();
    if (server)
        await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
}
