import { open, readFile, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IndexSnapshot, IndexStorage, OperationOptions } from '../contracts.js';
/** Atomic single-writer store at an explicit host-chosen absolute path. Parent must exist. */
export class FileIndexStorage implements IndexStorage {
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw new Error('An explicit absolute index path is required');
  }
  async load(options: OperationOptions = {}): Promise<IndexSnapshot | null> {
    options.signal?.throwIfAborted();
    try {
      const text = await readFile(this.path, { encoding: 'utf8', ...options });
      options.signal?.throwIfAborted();
      return JSON.parse(text) as IndexSnapshot;
    } catch (error) {
      options.signal?.throwIfAborted();
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async save(snapshot: IndexSnapshot, options: OperationOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const text = JSON.stringify(snapshot);
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    let closed = false; let published = false;
    try {
      await handle.writeFile(text, { encoding: 'utf8', ...options });
      await handle.sync(); await handle.close(); closed = true;
      options.signal?.throwIfAborted();
      // rename is the publication boundary; cancellation after this point is too late.
      await rename(temporary, this.path); published = true;
    } finally {
      try { if (!closed) await handle.close(); }
      finally { if (!published) await unlink(temporary); }
    }
  }
}
