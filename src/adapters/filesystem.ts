import { lstat, opendir, realpath, open } from 'node:fs/promises';
import { constants, type BigIntStats } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OperationOptions, SearchSource, SourceDocument, SourceContent } from '../contracts.js';
import { defaultFileTypes, type FileTypeRegistry } from '../file-types/registry.js';
const revisionOf = (stat: BigIntStats): string => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].join(':');
export interface FileSystemSourceOptions { id: string; root: string; maxFileBytes?: number; fileTypes?: FileTypeRegistry; }
/** Index only an explicitly configured root; never traverse symlinks. */
export class FileSystemFolderSource implements SearchSource {
  readonly type = 'filesystem';
  readonly id: string;
  private readonly root: string;
  private readonly maxBytes: number;
  private readonly fileTypes: FileTypeRegistry;
  private canonicalRoot: string | undefined;
  constructor(options: FileSystemSourceOptions) {
    if (!options.id.trim() || !isAbsolute(options.root)) throw new Error('A source ID and explicit absolute root are required');
    this.fileTypes = options.fileTypes ?? defaultFileTypes;
    this.id = options.id; this.root = resolve(options.root); this.maxBytes = options.maxFileBytes ?? 2 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error('Invalid file size limit');
  }
  private async getRoot(): Promise<string> {
    const root = await realpath(this.root);
    if (!(await lstat(root)).isDirectory()) throw new Error('Source root is not a directory');
    if (this.canonicalRoot && this.canonicalRoot !== root) throw new Error('Source root changed; register it again explicitly');
    this.canonicalRoot = root; return root;
  }
  private async checkedPath(id: string): Promise<string> {
    if (!id || id.includes('\0') || id.includes('\\') || isAbsolute(id) || id.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid document path');
    const root = await this.getRoot(); const candidate = resolve(root, id);
    const inside = relative(root, candidate);
    if (!inside || inside === '..' || inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('Path escapes source root');
    let current = root;
    for (const part of id.split('/')) { current = resolve(current, part); if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlinks are not followed'); }
    if (await realpath(candidate) !== candidate) throw new Error('Path changed or escaped its root');
    return candidate;
  }
  async list(options: OperationOptions = {}): Promise<SourceDocument[]> {
    const root = await this.getRoot(); const documents: SourceDocument[] = [];
    const walk = async (folder: string): Promise<void> => {
      options.signal?.throwIfAborted();
      for await (const entry of await opendir(folder)) {
        options.signal?.throwIfAborted(); if (entry.isSymbolicLink()) continue;
        // Reject entries that cannot be admitted before doing path I/O. Every
        // traversed directory and admitted file still gets the full checks.
        const definition = entry.isDirectory() ? undefined : this.fileTypes.get(entry.name);
        if (!entry.isDirectory() && (!entry.isFile() || !definition?.indexable)) continue;
        const path = resolve(folder, entry.name); const id = relative(root, path).split(sep).join('/');
        const checked = await this.checkedPath(id);
        if (entry.isDirectory()) { await walk(checked); continue; }
        if (!definition) continue;
        const stat = await lstat(checked, { bigint: true }); if (!stat.isFile() || stat.size > BigInt(Math.min(this.maxBytes, definition.maxBytes))) continue;
        documents.push({ id, sourceId: this.id, uri: pathToFileURL(checked).href, path: id, name: entry.name,
          createdAt: Number(stat.birthtimeNs) / 1e6, modifiedAt: Number(stat.mtimeNs) / 1e6, revision: revisionOf(stat) });
      }
    };
    await walk(root); return documents.sort((a, b) => a.id.localeCompare(b.id));
  }
  async read(documentId: string, options: OperationOptions = {}): Promise<SourceContent> {
    options.signal?.throwIfAborted();
    const type = this.fileTypes.get(documentId); if (!type?.indexable) throw new Error('Unsupported file type');
    const path = await this.checkedPath(documentId);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat({ bigint: true }); const max = Math.min(this.maxBytes, type.maxBytes);
      if (!stat.isFile() || stat.size > BigInt(max)) throw new Error('File is not indexable or exceeds the size limit');
      // One extra byte detects growth without allocating the format's maximum
      // size for every small file. Identity/revision checks remain below.
      const size = Number(stat.size);
      const buffer = new Uint8Array(size + 1); let count = 0;
      while (count < buffer.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, count, buffer.length - count, null);
        if (!bytesRead) break; count += bytesRead;
      }
      if (count > max) throw new Error('File exceeds the size limit');
      if (count > size) throw new Error('File changed while reading; retry');
      // Recheck containment and identity before returning bytes if the source changed during I/O.
      const current = await lstat(await this.checkedPath(documentId), { bigint: true }); const after = await handle.stat({ bigint: true });
      if (revisionOf(current) !== revisionOf(stat) || revisionOf(after) !== revisionOf(stat)) throw new Error('File changed while reading; retry');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
      if (text.includes('\0')) throw new Error('Binary content is not indexable');
      return { text };
    } finally { await handle.close(); }
  }
}

export { FileIndexStorage } from './file-storage.js';
