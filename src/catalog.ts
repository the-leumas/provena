import type { CatalogEntry, ParsedDocument, SearchFilters } from './contracts.js';
import { extensionOf } from './file-types/registry.js';
export function catalogEntry(parsed: ParsedDocument): CatalogEntry {
  const doc = parsed.document;
  const tags = Array.isArray(doc.metadata?.['tags']) ? doc.metadata['tags'].filter((tag): tag is string => typeof tag === 'string') : [];
  return { documentId: doc.id, sourceId: doc.sourceId, uri: doc.uri, title: parsed.title,
    ...(doc.path !== undefined ? { path: doc.path } : {}), fileType: extensionOf(doc.path ?? doc.name),
    ...(doc.createdAt !== undefined ? { createdAt: doc.createdAt } : {}), ...(doc.modifiedAt !== undefined ? { modifiedAt: doc.modifiedAt } : {}),
    tags: [...tags], headings: [...parsed.headings], outgoingLinks: [...parsed.outgoingLinks] };
}
export function matchesFilters(entry: CatalogEntry, filters: SearchFilters = {}): boolean {
  if (filters.pathPrefix !== undefined) {
    const prefix = filters.pathPrefix.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+|\/+$/g, '');
    if (prefix && prefix !== '.' && entry.path !== prefix && !entry.path?.startsWith(prefix + '/')) return false;
  }
  if (filters.extensions && !filters.extensions.map(ext => ext.startsWith('.') ? ext.toLowerCase() : '.' + ext.toLowerCase()).includes(entry.fileType ?? '')) return false;
  if (filters.tags && !filters.tags.every(tag => entry.tags.includes(tag))) return false;
  if (filters.modifiedAfter !== undefined && (entry.modifiedAt === undefined || entry.modifiedAt < filters.modifiedAfter)) return false;
  if (filters.createdAfter !== undefined && (entry.createdAt === undefined || entry.createdAt < filters.createdAfter)) return false;
  return filters.linkedTo === undefined || entry.outgoingLinks.includes(filters.linkedTo);
}
