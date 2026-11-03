import type { FeatureExtractionPipeline, PreTrainedTokenizer, ProgressCallback } from '@huggingface/transformers';
import type { Embedder, OperationOptions } from '../contracts.js';

export const MINILM_DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const MINILM_DEFAULT_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
const RUNTIME_VERSION = '4.2.0';
export interface MiniLMEmbedderOptions {
  /** Custom/local model must produce 384-dimensional sentence embeddings; supply its revision explicitly. */
  model?: string;
  revision?: string;
  batchSize?: number;
  /** Node default is cpu. Browser/worker hosts select wasm or supported webgpu explicitly. */
  device?: 'cpu' | 'wasm' | 'webgpu';
  dtype?: 'fp32' | 'fp16' | 'q8';
  /** Forwarded to Transformers.js; Hub-ID metadata probes in 4.2.0 may still access the network.
   * Strict offline operation requires host-staged assets and host env.allowRemoteModels=false.
   */
  localFilesOnly?: boolean;
  /** Passed to the runtime; a populated Hub cache alone does not guarantee offline resolution. */
  cacheDir?: string;
  onProgress?: (event: { status: string; file?: string; progress?: number; loaded?: number; total?: number }) => void;
}
/** Optional local sentence embedder. Import/construction never load the runtime or model.
 * Hosts own placement and disposal. Calls are serialized; cancellation cannot preempt native inference.
 */
export class MiniLMEmbedder implements Embedder {
  readonly dimensions = 384;
  readonly id: string;
  private readonly options: Readonly<MiniLMEmbedderOptions>;
  private readonly model: string;
  private readonly revision: string;
  private readonly batchSize: number;
  private readonly device: 'cpu' | 'wasm' | 'webgpu';
  private readonly dtype: 'fp32' | 'fp16' | 'q8';
  private extractor: FeatureExtractionPipeline | undefined;
  private tokenizer: PreTrainedTokenizer | undefined;
  private tail: Promise<void> = Promise.resolve();
  private disposed = false;
  private disposal: Promise<void> | undefined;
  constructor(options: MiniLMEmbedderOptions = {}) {
    this.options = { ...options };
    this.model = options.model ?? MINILM_DEFAULT_MODEL;
    this.revision = options.revision ?? MINILM_DEFAULT_REVISION;
    this.batchSize = options.batchSize ?? 4;
    this.device = options.device ?? 'cpu'; this.dtype = options.dtype ?? 'fp32';
    if (!this.model.trim() || !this.revision.trim() || (this.model !== MINILM_DEFAULT_MODEL && !options.revision)) throw new Error('A custom MiniLM model requires an explicit revision');
    if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) throw new Error('Invalid MiniLM batch size');
    if (!['cpu', 'wasm', 'webgpu'].includes(this.device) || !['fp32', 'fp16', 'q8'].includes(this.dtype)) throw new Error('Unsupported MiniLM device or dtype');
    this.id = JSON.stringify({ adapter: 'minilm-v1', runtime: RUNTIME_VERSION, model: this.model, revision: this.revision,
      device: this.device, dtype: this.dtype, pooling: 'mean', normalize: true, truncation: 'pinned-tokenizer-default' });
  }
  private check(options: OperationOptions): void {
    options.signal?.throwIfAborted();
    if (this.disposed) throw new Error('MiniLMEmbedder is disposed');
  }
  private async load(options: OperationOptions): Promise<FeatureExtractionPipeline> {
    this.check(options);
    if (!this.extractor) {
      try {
        const runtime = await import('@huggingface/transformers');
        this.check(options);
        if (runtime.env.version !== RUNTIME_VERSION) throw new Error(`Expected @huggingface/transformers ${RUNTIME_VERSION}, received ${runtime.env.version}`);
        const loading = {
          revision: this.revision, device: this.device, dtype: this.dtype,
          ...(this.options.cacheDir !== undefined ? { cache_dir: this.options.cacheDir } : {}),
          ...(this.options.localFilesOnly !== undefined ? { local_files_only: this.options.localFilesOnly } : {}),
          ...(this.options.onProgress ? { progress_callback: (event: Parameters<ProgressCallback>[0]) => this.options.onProgress!({
            status: event.status,
            ...('file' in event ? { file: event.file } : {}),
            ...('progress' in event ? { progress: event.progress } : {}),
            ...('loaded' in event ? { loaded: event.loaded } : {}),
            ...('total' in event ? { total: event.total } : {}),
          }) } : {}),
        };
        // Avoid factory preflight; the 4.2.0 tokenizer still probes unversioned metadata.
        // Strict offline hosts stage local assets and configure the runtime globally (see integration docs).
        const tokenizer = await runtime.AutoTokenizer.from_pretrained(this.model, loading);
        this.check(options);
        const model = await runtime.AutoModel.from_pretrained(this.model, loading);
        try { this.extractor = new runtime.FeatureExtractionPipeline({ task: 'feature-extraction', tokenizer, model }); }
        catch (cause) { await model.dispose(); throw cause; }
        this.tokenizer = tokenizer;
        this.options.onProgress?.({ status: 'ready' });
      } catch (cause) {
        this.check(options);
        throw new Error(`MiniLM model load failed (${this.model}@${this.revision}). Install @huggingface/transformers@${RUNTIME_VERSION} and check model/cache availability.`, { cause });
      }
    }
    this.check(options); return this.extractor;
  }
  async embedDocuments(texts: string[], options: OperationOptions = {}): Promise<Float32Array[]> {
    this.check(options);
    if (!Array.isArray(texts) || texts.some(text => typeof text !== 'string')) throw new Error('MiniLM inputs must be strings');
    const inputs = [...texts]; const operationOptions = { ...options };
    const operation = this.tail.then(() => this.run(inputs, operationOptions));
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }
  async embedQuery(text: string, options: OperationOptions = {}): Promise<Float32Array> {
    return (await this.embedDocuments([text], options))[0]!;
  }
  private async run(texts: string[], options: OperationOptions): Promise<Float32Array[]> {
    this.check(options); if (!texts.length) return [];
    const extractor = await this.load(options);
    const order = Array.from({ length: texts.length }, (_, i) => i);
    if (this.batchSize > 1 && texts.length > this.batchSize) {
      // Group inputs by token length up to MiniLM's 512-token limit (510 content tokens + [CLS] and [SEP])
      // to minimize batch padding waste while preserving determinism and input-to-output mapping.
      if (typeof this.tokenizer?.tokenize === 'function') {
        const lengths = texts.map(t => Math.min(510, this.tokenizer!.tokenize(t).length));
        order.sort((a, b) => (lengths[a]! - lengths[b]!) || (a - b));
      } else {
        order.sort((a, b) => (texts[a]!.length - texts[b]!.length) || (a - b));
      }
    }
    const vectors = new Array<Float32Array>(texts.length);
    for (let start = 0; start < order.length; start += this.batchSize) {
      this.check(options);
      const batchIndices = order.slice(start, start + this.batchSize);
      const batchTexts = batchIndices.map(i => texts[i]!);
      const output = await extractor(batchTexts, { pooling: 'mean', normalize: true });
      try {
        this.check(options);
        const data = output.data;
        if (output.type !== 'float32' || !(data instanceof Float32Array) || output.dims.length !== 2 ||
          output.dims[0] !== batchIndices.length || output.dims[1] !== this.dimensions || data.length !== batchIndices.length * this.dimensions) throw new Error('Invalid MiniLM output shape/type');
        for (let row = 0; row < batchIndices.length; row++) {
          const vector = data.slice(row * this.dimensions, (row + 1) * this.dimensions);
          const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
          if (!vector.every(Number.isFinite) || Math.abs(norm - 1) > 0.001) throw new Error('Invalid MiniLM output: expected finite unit vectors');
          vectors[batchIndices[row]!] = vector;
        }
      } finally { output.dispose(); }
    }
    this.check(options); return vectors;
  }
  /** Terminal and idempotent. Waits for active work, releases the pipeline; further use rejects. */
  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true;
      this.disposal = this.tail.then(async () => {
        const extractor = this.extractor; this.extractor = undefined;
        this.tokenizer = undefined;
        if (extractor) await extractor.dispose();
      });
    }
    return this.disposal;
  }
}
