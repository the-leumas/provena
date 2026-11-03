import type { FileTypeDefinition } from './types.js';
const define = (extensions: string[], kind: FileTypeDefinition['kind'], language: string,
  parserId: FileTypeDefinition['parserId'], structureAware = false, mimeTypes: string[] = []): FileTypeDefinition =>
  Object.freeze({ extensions: Object.freeze(extensions), kind, language, parserId,
    indexable: true, structureAware, textFallback: true, mimeTypes: Object.freeze(mimeTypes), maxBytes: 2 * 1024 * 1024 });
/** The only built-in extension list. Adapters, parsers and generated docs consult it. */
export const FILE_TYPES: readonly FileTypeDefinition[] = Object.freeze([
  define(['.md'], 'document', 'markdown', 'markdown', true, ['text/markdown']),
  define(['.txt'], 'document', 'text', 'text', false, ['text/plain']),
  define(['.js', '.jsx', '.mjs', '.cjs'], 'code', 'javascript', 'code'),
  define(['.ts', '.tsx'], 'code', 'typescript', 'code'),
  define(['.py'], 'code', 'python', 'code'), define(['.rs'], 'code', 'rust', 'code'),
  define(['.go'], 'code', 'go', 'code'), define(['.java'], 'code', 'java', 'code'),
  define(['.c', '.h'], 'code', 'c', 'code'), define(['.cpp', '.hpp'], 'code', 'cpp', 'code'),
  define(['.html'], 'code', 'html', 'code'), define(['.css'], 'code', 'css', 'code'),
  define(['.scss'], 'code', 'scss', 'code'),
  define(['.json'], 'configuration', 'json', 'structured', false, ['application/json']),
  define(['.yaml', '.yml'], 'configuration', 'yaml', 'structured'),
  define(['.toml'], 'configuration', 'toml', 'structured'),
  define(['.sh', '.bash'], 'code', 'bash', 'code'), define(['.fish'], 'code', 'fish', 'code'),
  define(['.sql'], 'code', 'sql', 'code'),
]);
export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}
export class FileTypeRegistry {
  readonly definitions: readonly FileTypeDefinition[];
  constructor(definitions: readonly FileTypeDefinition[] = FILE_TYPES) {
    const seen = new Set<string>();
    this.definitions = Object.freeze(definitions.map(type => {
      for (const extension of type.extensions) {
        if (!/^\.[a-z0-9]+$/.test(extension) || seen.has(extension)) throw new Error(`Invalid or duplicate extension: ${extension}`);
        seen.add(extension);
      }
      return Object.freeze({ ...type, extensions: Object.freeze([...type.extensions]), mimeTypes: Object.freeze([...type.mimeTypes]) });
    }));
  }
  get(path: string): FileTypeDefinition | undefined {
    const extension = extensionOf(path);
    return this.definitions.find(type => type.extensions.includes(extension));
  }
}
export const defaultFileTypes = new FileTypeRegistry();
export function getFileTypeDefinition(path: string): FileTypeDefinition | undefined { return defaultFileTypes.get(path); }
export function isSupportedFile(path: string): boolean { return getFileTypeDefinition(path)?.indexable === true; }
export function getSupportedExtensions(): string[] { return FILE_TYPES.flatMap(type => [...type.extensions]); }
