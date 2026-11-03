// Diagnostic harness only; imports public APIs. No source/model text leaves this machine.
import { SemanticSearchEngine, ParserRegistry, createSearchSession } from '@theleumas/provena';
import { FileSystemFolderSource, FileIndexStorage } from '@theleumas/provena/filesystem';
import { MiniLMEmbedder, MINILM_DEFAULT_REVISION } from '@theleumas/provena/minilm';
import { runSearch, optionsFrom, renderRun } from '../../cli/cli.mjs';
import { performance, PerformanceObserver } from 'node:perf_hooks';
import { readdir, mkdir, copyFile, writeFile, readFile, rm, mkdtemp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir, cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const modelDir = join(repo, '.cache/minilm/Xenova/all-MiniLM-L6-v2', MINILM_DEFAULT_REVISION);
const query = 'refreshSource';
const measure = async fn => { const at = performance.now(); const value = await fn(); return { ms: performance.now() - at, value }; };
const memory = () => process.memoryUsage();

// Loader instruments a fresh process, without editing production files. Removed on completion.
const loader = `
const targets = { 'chunking.js': ['chunkDocument'], 'index-state.js': ['embedChunks','snapshotOf','reusableSnapshot'], 'retrieval.js': ['collectCandidates','rankLexical','rankSemantic','fuseRrf','toSearchResults'] };
export async function load(url, context, next) {
 const out = await next(url, context); const names = url.includes('/dist/') && targets[url.split('/').pop()];
 if (!names || out.format !== 'module') return out;
 let code = String(out.source);
 if (url.endsWith('/index-state.js')) {
  code=code.replace('const inputs = chunks.map(embeddingTextForChunk);','const auditDedupAt=performance.now(); const inputs = chunks.map(embeddingTextForChunk);');
  code=code.replace('const missing = [...new Set(inputs.filter(input => !reusable.has(input)))];','const missing = [...new Set(inputs.filter(input => !reusable.has(input)))]; globalThis.__provenaAudit?.("dedup",performance.now()-auditDedupAt);');
 }
 for (const name of names) {
  const async = name === 'embedChunks';
  code = code.replace('export '+(async?'async ':'')+'function '+name+'(', (async?'async ':'')+'function audit_'+name+'(');
  code += '\\nexport '+(async?'async ':'')+'function '+name+'(...args) { const at=performance.now(); try { return '+(async?'await ':'')+'audit_'+name+'(...args); } finally { globalThis.__provenaAudit?.("'+name+'",performance.now()-at); } }';
 }
 return {...out, source:code};
}`;

async function child(kind, root, indexPath) {
  const stages = {}; let phase = 'index'; let gcMs = 0; let gcCount = 0; let maxLagMs = 0;
  let samples = memory(); let tick = performance.now(); const phasePeaks = {};
  const sample = () => { const m = memory(); phasePeaks[phase] ??= {...m}; for (const key of Object.keys(m)) {samples[key] = Math.max(samples[key], m[key]);phasePeaks[phase][key]=Math.max(phasePeaks[phase][key],m[key]);} };
  globalThis.__provenaAudit = (name, ms) => { const key = phase + ':' + name; stages[key] = (stages[key] ?? 0) + ms; sample(); };
  const observer = new PerformanceObserver(list => { for (const entry of list.getEntries()) { gcMs += entry.duration; gcCount++; } });
  observer.observe({ entryTypes: ['gc'] });
  const timer = setInterval(() => { const now = performance.now(); maxLagMs = Math.max(maxLagMs, now - tick - 10); tick = now; sample(); }, 10);
  const started = performance.now(); let result;
  // Fail closed even if staged loading unexpectedly tries the network.
  globalThis.fetch = async () => { throw new Error('Audit prohibits network'); };
  if (kind.startsWith('demo')) {
    const options = optionsFrom(['--source', root, '--query', query, '--color', 'never', '--model-dir', modelDir,
      ...(kind === 'demo-lexical' ? [] : ['--compare']),
      ...(kind === 'demo-disk' ? ['--save-index', join(dirname(indexPath),'cli')] : [])]);
    const record = await runSearch(options);
    const rendered = await measure(() => renderRun(options, record));
    result = { report: record.report, timings: record.timings, index:record.index, runs: record.runs.map(({ mode, searchMs, queryEmbeddingMs, verificationMs }) => ({ mode, searchMs, queryEmbeddingMs, verificationMs })), renderMs: rendered.ms };
  } else {
    const { env } = await import('@huggingface/transformers');
    env.allowLocalModels = true; env.allowRemoteModels = false;
    const initialization = {}; let loadAt;
    const model = new MiniLMEmbedder({ model: modelDir, revision: MINILM_DEFAULT_REVISION, localFilesOnly: true, device: 'cpu', dtype: 'fp32', batchSize: 4,
      onProgress(event) { if (event.status === 'ready') initialization.modelLoadMs = performance.now() - loadAt; } });
    const source = new FileSystemFolderSource({ id: 'project', root });
    const parsers = new ParserRegistry(); const parse = parsers.parse.bind(parsers);
    const observedSource = { id: source.id, type: source.type,
      async list(options) { const m = await measure(() => source.list(options)); stages[phase+':scanAdmission'] = (stages[phase+':scanAdmission'] ?? 0) + m.ms; return m.value; },
      async read(id, options) { const m = await measure(() => source.read(id, options)); stages[phase+':read'] = (stages[phase+':read'] ?? 0) + m.ms; sample(); return m.value; } };
    parsers.parse = async (...args) => { const m = await measure(() => parse(...args)); stages[phase+':parse'] = (stages[phase+':parse'] ?? 0) + m.ms; return m.value; };
    let docMs = 0; let queryMs = 0; let inputChars = 0; let calls = 0;
    const embedder = { id: model.id, dimensions: model.dimensions,
      async embedDocuments(texts, options) { loadAt ??= performance.now(); calls++; inputChars += texts.reduce((sum,t) => sum+t.length,0); const m = await measure(() => model.embedDocuments(texts, options)); docMs += m.ms; sample(); return m.value; },
      async embedQuery(text, options) { loadAt ??= performance.now(); const m = await measure(() => model.embedQuery(text, options)); queryMs += m.ms; return m.value; } };
    const disk = kind === 'api-disk' ? new FileIndexStorage(indexPath) : undefined;
    const storage = disk && { async load(options) { const m = await measure(() => disk.load(options)); stages[phase+':storageLoad'] = m.ms; return m.value; }, async save(snapshot, options) { const m = await measure(() => disk.save(snapshot,options)); stages[phase+':storageSave'] = m.ms; } };
    const engine = new SemanticSearchEngine({ parsers, embedder, ...(storage ? {storage} : {}) }); engine.addSource(observedSource);
    const index = await measure(() => engine.initialize());
    const initialDocMs = docMs;
    phase = 'search'; const runs = [];
    for (let repeat=0; repeat<4; repeat++) for (const mode of ['lexical','semantic','hybrid']) {
      const before = queryMs; const m = await measure(() => engine.search({ query, mode, limit:3 }));
      runs.push({ repeat, mode, searchMs:m.ms, queryEmbeddingMs:queryMs-before, results:m.value.length });
    }
    const session = createSearchSession(engine); await session.search({query,mode:'hybrid',limit:3});
    const cache = await measure(() => session.search({query,mode:'hybrid',limit:3}));
    phase = 'refresh'; const refreshed = await measure(() => engine.refreshSource(source.id));
    result = { report:index.value[0], indexingMs:index.ms, embeddingMs:initialDocMs, initialization, calls, inputChars, runs, cachedSearchMs:cache.ms,
      unchanged:{report:refreshed.value,ms:refreshed.ms,embeddingMs:docMs-initialDocMs}, snapshotBytes: disk ? (await readFile(indexPath)).length : 0 };
    if (kind === 'api' && root.endsWith('md8')) {
      const controller = new AbortController(); const at = performance.now(); let abortedAt;
      const cancellationTimer = setTimeout(() => { abortedAt=performance.now(); controller.abort(); },5);
      try {
        await model.embedDocuments(Array(4).fill('Local indexing preserves current source evidence. '.repeat(40)),{signal:controller.signal});
        result.cancellation={resolved:true,elapsedMs:performance.now()-at};
      } catch(error) {
        result.cancellation={error:error.name,elapsedMs:performance.now()-at,abortDispatchMs:abortedAt-at,afterAbortMs:performance.now()-abortedAt};
      } finally {clearTimeout(cancellationTimer);}
    }
    await model.dispose();
  }
  await new Promise(resolve => setTimeout(resolve,20)); clearInterval(timer); observer.disconnect(); sample();
  result = { kind, corpus:root.split('/').pop(), totalMs:performance.now()-started, ...result, stages,
    memory:{sampledPeak:samples, phasePeaks, end:memory(), peakRssBytes:process.resourceUsage().maxRSS*1024}, gc:{ms:gcMs,count:gcCount}, maxEventLoopLagMs:maxLagMs };
  console.log(JSON.stringify(result));
}

if (process.argv[2] === '--child') {
  await child(process.argv[3], process.argv[4], process.argv[5]);
} else {
  const temporary = await mkdtemp(join(tmpdir(),'provena-beta1-audit-'));
  try {
    const loaderPath = join(temporary,'profile-loader.mjs'); await writeFile(loaderPath,loader);
    const md = (await readdir(join(repo,'docs'))).filter(name=>name.endsWith('.md')).sort();
    const ts = (await readdir(join(repo,'src'))).filter(name=>name.endsWith('.ts')).sort();
    const corpora = {};
    for (const [name,files] of [['md8',md.slice(0,8).map(f=>['docs',f])],['md12',md.map(f=>['docs',f])],['mixed24',[...md.map(f=>['docs',f]),...ts.map(f=>['src',f])]]]) {
      const root = join(temporary,name); await mkdir(root);
      let bytes=0; const manifest=[];
      for (const [dir,file] of files) { await copyFile(join(repo,dir,file),join(root,file)); const data=await readFile(join(root,file)); bytes+=data.length; manifest.push({path:dir+'/'+file,bytes:data.length}); }
      corpora[name]={root,files:files.length,bytes,manifest};
    }
    // Same exact passages, different file sizes/counts; Markdown sections bound chunks.
    const sections = Array.from({length:16},(_,i)=>`# Topic ${i}\n\nLocal indexing refreshSource section ${i}. `+'A consumer preserves source evidence and checks current paths. '.repeat(18));
    for (const [name,contents] of [['onefile', [sections.join('\n')]],['manyfiles',sections]]) {
      const root=join(temporary,name); await mkdir(root); let bytes=0;
      for (const [i,text] of contents.entries()) { await writeFile(join(root,i+'.md'),text); bytes+=Buffer.byteLength(text); }
      corpora[name]={root,files:contents.length,bytes};
    }
    const results=[];
    const jobs = process.argv.includes('--shape-only') ? [['onefile','api'],['manyfiles','api']] : process.argv.includes('--persistence-only') ? [['md8','demo-disk'],['md8','demo-disk']] : process.argv.includes('--quick') ? [['md8','demo'],['md8','api']] : [
      ['md8','demo'],['md8','api'],['md12','demo'],['md12','api'],['mixed24','demo'],['mixed24','api'],
      ['md8','demo'],['md8','api'],['onefile','api'],['manyfiles','api'],['mixed24','api-disk'],['mixed24','api-disk'],['mixed24','demo-lexical']];
    for (const [name,kind] of jobs) {
      const result=await new Promise((resolve,reject)=>{
        const proc=spawn(process.execPath,['--no-warnings','--loader',loaderPath,fileURLToPath(import.meta.url),'--child',kind,corpora[name].root,join(temporary,'index.json')],{cwd:repo,stdio:['ignore','pipe','inherit']});
        let output=''; proc.stdout.on('data',data=>output+=data); proc.on('error',reject); proc.on('exit',code=>{try {if(code!==0) throw new Error('Benchmark exited '+code);resolve(JSON.parse(output));}catch(e){reject(e);}});
      });
      results.push(result); console.error(`${name} ${kind}: ${(result.indexingMs??result.timings.indexingMs).toFixed(1)} ms; ${result.report.chunks} passages, ${result.report.embeddedTexts} inputs`);
    }
    const report={environment:{node:process.version,cpu:cpus()[0].model,logicalCpus:cpus().length,totalMemoryBytes:totalmem(),modelDir,revision:MINILM_DEFAULT_REVISION,device:'cpu',dtype:'fp32',batchSize:4,query,chunking:{targetChars:1600,overlapLines:2},network:'disabled; fetch throws'},corpora:Object.fromEntries(Object.entries(corpora).map(([name,{root,...data}])=>[name,data])),results};
    const output=process.argv.find(arg=>arg.startsWith('--output='))?.slice(9);
    if(output) await writeFile(resolve(output),JSON.stringify(report,null,2)+'\n'); else console.log(JSON.stringify(report,null,2));
  } finally { await rm(temporary,{recursive:true,force:true}); }
}
