/** Offline lifecycle fixture; deliberately not a semantic model or public adapter. */
export class TestEmbedder {
  id = 'test-content-v1'; dimensions = 4; calls = []; queryCalls = 0;
  async embedDocuments(texts, options = {}) {
    options.signal?.throwIfAborted(); this.calls.push([...texts]);
    return texts.map(text => {
      const vector = new Float32Array(this.dimensions);
      for (let i = 0; i < text.length; i++) vector[i % vector.length] += text.charCodeAt(i) / 256;
      return vector;
    });
  }
  async embedQuery() { this.queryCalls++; throw new Error('Lifecycle fixture forbids query inference'); }
  get count() { return this.calls.flat().length; }
}
export class MemoryStorage {
  snapshot = null; loads = 0; saves = 0;
  async load(options = {}) { options.signal?.throwIfAborted(); this.loads++; return structuredClone(this.snapshot); }
  async save(snapshot, options = {}) { options.signal?.throwIfAborted(); this.saves++; this.snapshot = structuredClone(snapshot); }
}
export function source(id = 'fixture', initial = { 'a.txt': 'alpha material', 'b.txt': 'beta material', 'c.txt': 'gamma material' }) {
  const files = new Map(Object.entries(initial));
  return { id, type: 'memory', files,
    async list(options = {}) { options.signal?.throwIfAborted(); return [...files.keys()].map(path => ({ id: path, sourceId: id, uri: `memory://${id}/${path}`, path, name: path })); },
    async read(id, options = {}) { options.signal?.throwIfAborted(); if (!files.has(id)) throw new Error('missing file'); return { text: files.get(id) }; },
  };
}
