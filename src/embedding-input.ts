import type { IndexedChunk } from './contracts.js';
/** Bump when changing the text presented to embedders. Paths never participate. */
export const EMBEDDING_INPUT_VERSION = '1';
export function embeddingTextForChunk(chunk: Pick<IndexedChunk, 'text' | 'heading'>): string {
  const heading = chunk.heading?.trim();
  if (!heading) return chunk.text;
  const lines = chunk.text.split('\n', 2);
  const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(lines[0] ?? '')?.[1];
  const setext = lines[0]?.trim() === heading && /^ {0,3}(?:=+|-+)\s*$/.test(lines[1] ?? '');
  // Initial Markdown section chunks already contain their heading; continuation chunks do not.
  return atx === heading || setext ? chunk.text : `${heading}\n\n${chunk.text}`;
}
