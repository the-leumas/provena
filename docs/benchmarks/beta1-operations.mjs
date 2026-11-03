// Bounded non-model diagnostics; all generated files and instrumented artifacts are temporary.
import { SemanticSearchEngine, ParserRegistry, chunkDocument } from '@theleumas/provena';
import { FileSystemFolderSource } from '@theleumas/provena/filesystem';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const measure = async fn => { const at=performance.now(); const value=await fn(); return {ms:performance.now()-at,value}; };
const temp=await mkdtemp(join(tmpdir(),'provena-operations-'));
const result={admission:[],fileShape:[],scale:[]};
try {
  for(const count of [100,1000]) {
    const root=join(temp,String(count)); await mkdir(root);
    for(let i=0;i<count;i++) await writeFile(join(root,`${i}.ignored`),'');
    await writeFile(join(root,'admitted.md'),'# Index\n\nrefreshSource preserves evidence.');
    const source=new FileSystemFolderSource({id:'files',root});
    const listed=await measure(()=>source.list());
    result.admission.push({encountered:count+1,admitted:listed.value.length,scanAdmissionMs:listed.ms});
  }
  const doc={id:'large.txt',name:'large.txt',path:'large.txt',sourceId:'shape',uri:'memory:shape'};
  const parsers=new ParserRegistry();
  for(const shape of ['one-line','many-lines']) {
    const text=shape==='one-line' ? 'x'.repeat(1024*1024) : ('An indexing operation preserves source evidence and current document paths.\n').repeat(14000);
    const parsed=await measure(()=>parsers.parse(doc,{text}));
    const chunks=await measure(()=>chunkDocument(parsed.value));
    result.fileShape.push({shape,bytes:Buffer.byteLength(text),parseMs:parsed.ms,chunkMs:chunks.ms,chunks:chunks.value.length,maxChunkChars:Math.max(...chunks.value.map(c=>c.text.length))});
  }
  // Existing scale benchmark with synthetic 384-d vectors; inference cost is deliberately absent.
  for(const size of [1000,10000]) {
    const report=await new Promise((resolve,reject)=>{
      const child=fork(fileURLToPath(new URL('../../scripts/scale-benchmark.mjs',import.meta.url)),[`--size=${size}`],{execArgv:['--expose-gc'],stdio:['ignore','ignore','inherit','ipc']});
      let report; child.on('message',value=>report=value); child.on('error',reject);child.on('exit',code=>code===0?resolve(report):reject(new Error('Scale failed '+code)));
    });result.scale.push(report);
  }
  console.log(JSON.stringify(result,null,2));
} finally {await rm(temp,{recursive:true,force:true});}
