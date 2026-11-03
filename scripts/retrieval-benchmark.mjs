import { evaluateRetrieval } from './retrieval-evaluation.mjs';
// Fixed character bins are repeatable non-random vectors, not a semantic model.
const encode = text => {
  const vector = new Float32Array(32);
  for (const char of text.toLowerCase()) vector[char.codePointAt(0) % vector.length]++;
  if (!vector.some(value => value !== 0)) vector[0] = 1;
  return vector;
};
console.log(JSON.stringify(await evaluateRetrieval({ id: 'test-character-bins-v1', dimensions: 32,
  async embedDocuments(texts) { return texts.map(encode); }, async embedQuery(text) { return encode(text); },
}, 'OFFLINE MECHANICS ONLY: character-bin vectors do not measure semantic quality'), null, 2));
