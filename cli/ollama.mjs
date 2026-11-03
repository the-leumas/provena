// Ollama HTTP embedder. Implements the Embedder contract for the CLI.
// Calls the local Ollama /api/embed endpoint; no external dependencies.
import { createHash } from 'node:crypto';

export const OLLAMA_DEFAULT_URL = 'http://localhost:11434';

/** Embedder that delegates to a running Ollama instance via its REST API.
 *
 * The model's declared dimension is probed lazily on first use.
 * Model identity includes the URL origin, model name, and (once known) dimension,
 * so a saved index is invalidated when any of those change.
 *
 * Some embedding models expect different prefixes on query vs. document inputs
 * (e.g. nomic-embed-text uses "search_query: " / "search_document: "). Pass
 * `queryPrefix` and `documentPrefix` to enable this; leave them undefined or
 * empty for models that do not use prefixes.
 */
export class OllamaEmbedder {
  #url;
  #model;
  #queryPrefix;
  #documentPrefix;
  #fetch;
  #dimensions = 0;
  #baseId;

  constructor({ url = OLLAMA_DEFAULT_URL, model, queryPrefix = '', documentPrefix = '', fetch: fetchImpl = globalThis.fetch } = {}) {
    if (!model || typeof model !== 'string') throw new Error('--ollama-model NAME is required');
    this.#url = url.replace(/\/+$/, '');
    this.#model = model;
    this.#queryPrefix = queryPrefix;
    this.#documentPrefix = documentPrefix;
    this.#fetch = fetchImpl;
    // Stable prefix for id; dimensions are appended after first call.
    const origin = new URL(this.#url).origin;
    this.#baseId = `ollama:${origin}:${model}`;
  }

  get id() {
    // Include dimensions once known; until then use a placeholder that forces
    // index rebuild if a prior run had already recorded the real dimension.
    return this.#dimensions ? `${this.#baseId}:dim${this.#dimensions}` : this.#baseId;
  }

  get dimensions() { return this.#dimensions; }

  async #embed(inputs, options) {
    options?.signal?.throwIfAborted();
    const body = JSON.stringify({ model: this.#model, input: inputs });
    let response;
    try {
      response = await this.#fetch(`${this.#url}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: options?.signal,
      });
    } catch (cause) {
      throw new Error(`Ollama request failed: ${cause.message}`, { cause });
    }
    if (!response.ok) {
      let detail = '';
      try { detail = ` — ${(await response.json()).error ?? ''}`; } catch {}
      throw new Error(`Ollama responded ${response.status}${detail}`);
    }
    let data;
    try { data = await response.json(); } catch (cause) {
      throw new Error('Ollama response is not valid JSON', { cause });
    }
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== inputs.length) {
      throw new Error(`Ollama returned ${data.embeddings?.length ?? 'no'} embeddings for ${inputs.length} inputs`);
    }
    const vectors = data.embeddings.map(embedding => {
      if (!Array.isArray(embedding) || !embedding.length) throw new Error('Ollama returned an empty embedding vector');
      return new Float32Array(embedding);
    });
    if (!this.#dimensions) this.#dimensions = vectors[0].length;
    return vectors;
  }

  async embedDocuments(texts, options) {
    if (!Array.isArray(texts) || texts.some(t => typeof t !== 'string')) throw new Error('OllamaEmbedder inputs must be strings');
    if (!texts.length) return [];
    const inputs = this.#documentPrefix ? texts.map(t => this.#documentPrefix + t) : texts;
    return this.#embed(inputs, options);
  }

  async embedQuery(text, options) {
    if (typeof text !== 'string') throw new Error('OllamaEmbedder query must be a string');
    const input = this.#queryPrefix ? this.#queryPrefix + text : text;
    return (await this.#embed([input], options))[0];
  }
}
