// Small offline adapter experiment. No production options or ranking are changed.
import { MiniLMEmbedder, MINILM_DEFAULT_REVISION } from '@theleumas/provena/minilm';
import { env, AutoTokenizer } from '@huggingface/transformers';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
env.allowLocalModels=true; env.allowRemoteModels=false;
env.fetch=globalThis.fetch=async()=>{throw new Error('Network forbidden');};
const modelDir=fileURLToPath(new URL('../../.cache/minilm/Xenova/all-MiniLM-L6-v2/'+MINILM_DEFAULT_REVISION,import.meta.url));
const tokenizer=await AutoTokenizer.from_pretrained(modelDir,{local_files_only:true});
const short=Array.from({length:4},(_,i)=>`refreshSource evidence ${i}`);
const long=Array.from({length:4},(_,i)=>`Document ${i}. `+'A consumer preserves current source evidence and indexes local documents. '.repeat(55));
const interleaved=short.flatMap((text,i)=>[text,long[i]]);
const grouped=[...short,...long];
const lengths=interleaved.map(text=>tokenizer(text,{truncation:true}).input_ids.data.length);
const rows=[]; let reference;
for(const batchSize of (process.argv.includes('--confirm') ? [4] : [1,4,8])) {
  const model=new MiniLMEmbedder({model:modelDir,revision:MINILM_DEFAULT_REVISION,device:'cpu',dtype:'fp32',localFilesOnly:true,batchSize});
  const at=performance.now();await model.embedQuery('warm model'); const loadAndWarmQueryMs=performance.now()-at;
  if(process.argv.includes('--confirm')) await model.embedDocuments(interleaved);
  const orders=process.argv.includes('--confirm') ? ['interleaved','grouped','grouped','interleaved','interleaved','grouped'] : ['interleaved','grouped'];
  for(const order of orders) {
    const texts=order==='grouped'?grouped:interleaved;
    const before=performance.now();const vectors=await model.embedDocuments(texts);const inferenceMs=performance.now()-before;
    const reordered=order==='grouped'?short.flatMap((_,i)=>[vectors[i],vectors[4+i]]):vectors;
    reference??=reordered;
    const maxDifference=Math.max(...reordered.flatMap((v,i)=>[Math.max(...v.map((x,j)=>Math.abs(x-reference[i][j])))]));
    rows.push({batchSize,order,loadAndWarmQueryMs,inferenceMs,inputsPerSecond:8000/inferenceMs,maxDifference,heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss});
  }
  if(batchSize===4) {
    const controller=new AbortController();let dispatch;const at=performance.now();
    const timer=setTimeout(()=>{dispatch=performance.now();controller.abort();},5);
    try {await model.embedDocuments(long,{signal:controller.signal});rows.push({cancellation:'resolved',elapsedMs:performance.now()-at});}
    catch(error){rows.push({cancellation:error.name,elapsedMs:performance.now()-at,dispatchMs:dispatch-at,afterAbortMs:performance.now()-dispatch});}
    finally{clearTimeout(timer);}
  }
  await model.dispose();
}
console.log(JSON.stringify({node:process.version,modelDir,tokenLengths:lengths,rows,note:'8 controlled inputs, one measurement per configuration/order, models disposed between batch sizes; process RSS includes allocator retention from previous models. This is a tuning probe, not a default-change recommendation.'},null,2));
