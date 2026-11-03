import type { IndexedChunk, ParsedDocument } from './contracts.js';
import { documentKey } from './contracts.js';
export const CHUNKER_VERSION = '2';
export interface ChunkOptions { targetChars?: number; overlapLines?: number; }
/** Deterministic fingerprint, not a cryptographic/security hash. Index reuse also compares text. */
export function contentHash(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}
export function chunkDocument(parsed: ParsedDocument, options: ChunkOptions = {}): IndexedChunk[] {
  const target = options.targetChars ?? 1600; const overlap = options.overlapLines ?? 2;
  if (!Number.isSafeInteger(target) || target < 64 || !Number.isSafeInteger(overlap) || overlap < 0) throw new Error('Invalid chunk options');
  const lines = parsed.text.split('\n'); const chunks: IndexedChunk[] = []; const occurrences = new Map<string, number>();
  for (const section of parsed.sections) {
    let start = section.startLine - 1;
    while (start < section.endLine) {
      if (lines[start]!.length > target) {
        const line = lines[start]!;
        const doc = parsed.document;
        const subOverlap = overlap > 0 ? Math.min(Math.floor(target * 0.1), 160) : 0;
        let offset = 0;
        while (offset < line.length) {
          if (line.length - offset <= target) {
            const text = line.slice(offset);
            if (text.trim()) {
              const hash = contentHash(text);
              const occurrence = occurrences.get(hash) ?? 0;
              occurrences.set(hash, occurrence + 1);
              chunks.push({
                id: JSON.stringify([documentKey(doc.sourceId, doc.id), hash, occurrence]),
                sourceId: doc.sourceId, documentId: doc.id, uri: doc.uri,
                ...(doc.path !== undefined ? { path: doc.path } : {}),
                ...(section.heading ? { heading: section.heading } : {}),
                ...(parsed.language ? { language: parsed.language } : {}),
                text, contentHash: hash, startLine: start + 1, endLine: start + 1,
              });
            }
            break;
          }
          let maxEnd = offset + target;
          if (line.charCodeAt(maxEnd - 1) >= 0xd800 && line.charCodeAt(maxEnd - 1) <= 0xdbff) maxEnd--;
          let splitPoint = -1;
          const minSplit = offset + Math.floor(target / 2);
          for (let i = maxEnd; i >= minSplit; i--) {
            const char = line[i];
            if (char === ' ' || char === '\t') { splitPoint = i + 1; break; }
            if ((char === ';' || char === ',' || char === '.') && (i + 1 <= maxEnd && (line[i + 1] === ' ' || line[i + 1] === '\t' || i === maxEnd - 1))) {
              splitPoint = i + 1; break;
            }
          }
          if (splitPoint === -1) splitPoint = maxEnd;
          const text = line.slice(offset, splitPoint);
          if (text.trim()) {
            const hash = contentHash(text);
            const occurrence = occurrences.get(hash) ?? 0;
            occurrences.set(hash, occurrence + 1);
            chunks.push({
              id: JSON.stringify([documentKey(doc.sourceId, doc.id), hash, occurrence]),
              sourceId: doc.sourceId, documentId: doc.id, uri: doc.uri,
              ...(doc.path !== undefined ? { path: doc.path } : {}),
              ...(section.heading ? { heading: section.heading } : {}),
              ...(parsed.language ? { language: parsed.language } : {}),
              text, contentHash: hash, startLine: start + 1, endLine: start + 1,
            });
          }
          offset = Math.max(offset + 1, splitPoint - subOverlap);
          if (offset < line.length && line.charCodeAt(offset) >= 0xdc00 && line.charCodeAt(offset) <= 0xdfff) offset--;
        }
        start++;
        continue;
      }
      let end = start; let chars = 0; let boundary = -1;
      while (end < section.endLine) {
        const size = lines[end]!.length + (end > start ? 1 : 0);
        if (end > start && chars + size > target) break;
        chars += size; end++;
        // Prefer a nearby paragraph/function boundary, without discarding any lines.
        if (chars >= target / 2 && (!lines[end - 1]!.trim() || /^\s*[}\]];?\s*$/.test(lines[end - 1]!))) boundary = end;
      }
      if (end < section.endLine && boundary > start) end = boundary;
      const text = lines.slice(start, end).join('\n');
      if (text.trim()) {
        const hash = contentHash(text); const occurrence = occurrences.get(hash) ?? 0; occurrences.set(hash, occurrence + 1);
        const doc = parsed.document;
        chunks.push({ id: JSON.stringify([documentKey(doc.sourceId, doc.id), hash, occurrence]), sourceId: doc.sourceId,
          documentId: doc.id, uri: doc.uri, ...(doc.path !== undefined ? { path: doc.path } : {}),
          ...(section.heading ? { heading: section.heading } : {}), ...(parsed.language ? { language: parsed.language } : {}),
          text, contentHash: hash, startLine: start + 1, endLine: end });
      }
      if (end >= section.endLine) break;
      start = Math.max(start + 1, end - Math.min(overlap, end - start - 1));
    }
  }
  return chunks;
}
