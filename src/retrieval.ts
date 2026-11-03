import type { IndexedChunk, SearchRequest, SearchResult } from './contracts.js';
import type { IndexedDocument } from './index-state.js';
import { matchesFilters } from './catalog.js';

/** Internal references to one committed index view; vectors are never copied for search. */
export interface Candidate { record: IndexedDocument; chunk: IndexedChunk; vector: Float32Array | undefined; }
export interface RankedCandidate { candidate: Candidate; lexicalRank?: number; semanticRank?: number; }
const RRF_K = 60;
const byIdentity = (a: Candidate, b: Candidate): number => a.chunk.id.localeCompare(b.chunk.id);

export function collectCandidates(records: Iterable<IndexedDocument>, vectors: ReadonlyMap<string, Float32Array>, request: SearchRequest): Candidate[] {
  const candidates: Candidate[] = [];
  for (const record of records) {
    request.signal?.throwIfAborted();
    if (request.sources && !request.sources.includes(record.catalog.sourceId)) continue;
    if (!matchesFilters(record.catalog, request.filters)) continue;
    for (const chunk of record.chunks) {
      request.signal?.throwIfAborted();
      candidates.push({ record, chunk, vector: vectors.get(chunk.id) });
    }
  }
  return candidates;
}

const isCjk = (str: string): boolean => /[\p{sc=Han}\p{sc=Hira}\p{sc=Kana}\p{sc=Hang}]/u.test(str);

function extractLexicalTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  const matches = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  for (const word of matches) {
    const lower = word.toLowerCase();
    tokens.add(lower);
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) {
      tokens.add(lower.slice(0, -1));
    }
    if (lower.includes('_')) {
      for (const part of lower.split('_')) {
        if (part) {
          tokens.add(part);
          if (part.length > 3 && part.endsWith('s') && !part.endsWith('ss')) tokens.add(part.slice(0, -1));
        }
      }
    }
    const camel = /[a-z\d][A-Z]|[A-Z][A-Z][a-z]/.test(word) ? word
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/) : [];
    if (camel.length > 1) {
      for (const part of camel) {
        if (part) {
          tokens.add(part);
          if (part.length > 3 && part.endsWith('s') && !part.endsWith('ss')) tokens.add(part.slice(0, -1));
        }
      }
    }
  }
  return tokens;
}

/** Rank positive lexical matches with term rarity weighted within eligible candidates.
 * A term found in fewer candidates contributes more to the score (smoothed IDF).
 * Body, heading and metadata matches receive distinct weights; full-query matches
 * add a bonus. Scores only order candidates and are not calibrated confidence.
 */
export function rankLexical(candidates: Candidate[], text: string, signal?: AbortSignal): Candidate[] {
  const query = text.trim().toLowerCase();
  const rawTerms = text.trim().match(/[\p{L}\p{N}_]+/gu) ?? [];
  const termSet = new Set<string>();
  for (const word of rawTerms) {
    const lower = word.toLowerCase();
    termSet.add(lower);
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) {
      termSet.add(lower.slice(0, -1));
    }
    if (lower.includes('_')) {
      for (const part of lower.split('_')) {
        if (part) {
          termSet.add(part);
          if (part.length > 3 && part.endsWith('s') && !part.endsWith('ss')) termSet.add(part.slice(0, -1));
        }
      }
    }
    const camel = /[a-z\d][A-Z]|[A-Z][A-Z][a-z]/.test(word) ? word
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/) : [];
    if (camel.length > 1) {
      for (const part of camel) {
        if (part) {
          termSet.add(part);
          if (part.length > 3 && part.endsWith('s') && !part.endsWith('ss')) termSet.add(part.slice(0, -1));
        }
      }
    }
  }
  const terms = [...termSet];
  if (!terms.length) return [];

  const hasTerm = (term: string, inTokens: Set<string>, inText: string): boolean =>
    isCjk(term) ? inText.includes(term) : inTokens.has(term);

  // One pass to build each candidate's lowercased body/header, metadata, and token sets
  // (cached per record), and to count, per term, how many candidates contain it
  // (body, header or metadata) — the document-frequency input to IDF below.
  const prepared: Array<{
    candidate: Candidate;
    body: string;
    header: string;
    metadata: string;
    bodyTokens: Set<string>;
    headerTokens: Set<string>;
    metadataTokens: Set<string>;
  }> = [];
  const documentFrequency = new Map(terms.map(term => [term, 0]));
  let previous: IndexedDocument | undefined;
  let metadata = '';
  let metadataTokens = new Set<string>();

  for (const candidate of candidates) {
    signal?.throwIfAborted();
    const { record, chunk } = candidate;
    if (record !== previous) {
      const rawMetadata = `${record.catalog.path ?? ''} ${record.catalog.title} ${record.catalog.tags.join(' ')}`;
      metadata = rawMetadata.toLowerCase();
      metadataTokens = extractLexicalTokens(rawMetadata);
      previous = record;
    }
    const body = chunk.text.toLowerCase();
    const header = (chunk.heading ?? '').toLowerCase();
    const bodyTokens = extractLexicalTokens(chunk.text);
    const headerTokens = chunk.heading ? extractLexicalTokens(chunk.heading) : new Set<string>();

    prepared.push({ candidate, body, header, metadata, bodyTokens, headerTokens, metadataTokens });
    for (const term of terms) {
      if (
        hasTerm(term, bodyTokens, body) ||
        hasTerm(term, headerTokens, header) ||
        hasTerm(term, metadataTokens, metadata)
      ) {
        documentFrequency.set(term, documentFrequency.get(term)! + 1);
      }
    }
  }
  const total = prepared.length;
  // Smoothed IDF, floored at a small positive weight: a term present in every
  // candidate still counts (it may be the only shared term), just far less than
  // a term only a handful of candidates contain.
  const idf = new Map(terms.map(term => [term, Math.log(1 + total / (1 + documentFrequency.get(term)!))]));

  const hits: Array<{ candidate: Candidate; score: number }> = [];
  for (const { candidate, body, header, metadata: candidateMetadata, bodyTokens, headerTokens, metadataTokens: cMetadataTokens } of prepared) {
    signal?.throwIfAborted();
    let score = 0;
    for (const term of terms) {
      const weight = idf.get(term)!;
      score += weight * (
        (hasTerm(term, bodyTokens, body) ? 1 : 0) +
        (hasTerm(term, cMetadataTokens, candidateMetadata) ? 3 : 0) +
        (hasTerm(term, headerTokens, header) ? 2 : 0)
      );
    }
    if (!score) continue;
    if (body.includes(query)) score += 4;
    if (candidateMetadata.includes(query)) score += 8;
    hits.push({ candidate, score });
  }
  hits.sort((a, b) => b.score - a.score || byIdentity(a.candidate, b.candidate));
  return hits.map(hit => hit.candidate);
}

function vectorNorm(vector: Float32Array | undefined, dimensions: number, label: string): number {
  if (!(vector instanceof Float32Array) || vector.length !== dimensions) throw new Error(`Invalid semantic vector (${label}): missing or wrong dimensions/type`);
  let squared = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error(`Invalid semantic vector (${label}): non-finite value`);
    squared += value * value;
  }
  if (!squared || !Number.isFinite(squared)) throw new Error(`Invalid semantic vector (${label}): zero or non-finite norm`);
  return Math.sqrt(squared);
}

export function rankSemantic(candidates: Candidate[], query: Float32Array, dimensions: number, signal?: AbortSignal): Candidate[] {
  signal?.throwIfAborted();
  const queryNorm = vectorNorm(query, dimensions, 'query');
  const hits = candidates.map(candidate => {
    signal?.throwIfAborted();
    const norm = vectorNorm(candidate.vector, dimensions, candidate.chunk.id);
    const vector = candidate.vector!; let dot = 0;
    for (let i = 0; i < dimensions; i++) dot += vector[i]! * query[i]!;
    return { candidate, score: dot / (norm * queryNorm) };
  });
  hits.sort((a, b) => b.score - a.score || byIdentity(a.candidate, b.candidate));
  signal?.throwIfAborted();
  return hits.map(hit => hit.candidate);
}

/** Fuse complete channel rankings before applying any final result limit. */
export function fuseRrf(lexical: Candidate[], semantic: Candidate[], signal?: AbortSignal): RankedCandidate[] {
  const hits = new Map<string, RankedCandidate & { score: number }>();
  for (const [channel, candidates] of [['lexicalRank', lexical], ['semanticRank', semantic]] as const) {
    candidates.forEach((candidate, index) => {
      signal?.throwIfAborted();
      const hit = hits.get(candidate.chunk.id) ?? { candidate, score: 0 };
      hit[channel] = index + 1; hit.score += 1 / (RRF_K + index + 1);
      hits.set(candidate.chunk.id, hit);
    });
  }
  return [...hits.values()].sort((a, b) => b.score - a.score || byIdentity(a.candidate, b.candidate));
}

export function toSearchResults(ranked: RankedCandidate[], limit: number, signal?: AbortSignal): SearchResult[] {
  return ranked.slice(0, limit).map(({ candidate: { record, chunk }, lexicalRank, semanticRank }, index) => {
    signal?.throwIfAborted();
    return {
      sourceId: chunk.sourceId, documentId: chunk.documentId, chunkId: chunk.id, uri: chunk.uri,
      ...(chunk.path !== undefined ? { path: chunk.path } : {}), title: record.catalog.title,
      ...(chunk.heading ? { heading: chunk.heading } : {}), ...(chunk.language ? { language: chunk.language } : {}),
      startLine: chunk.startLine, endLine: chunk.endLine, snippet: chunk.text,
      ...(lexicalRank !== undefined ? { lexicalRank } : {}), ...(semanticRank !== undefined ? { semanticRank } : {}),
      combinedRank: index + 1,
      matchReasons: [...(lexicalRank !== undefined ? ['lexical'] : []), ...(semanticRank !== undefined ? ['semantic'] : [])],
    };
  });
}
