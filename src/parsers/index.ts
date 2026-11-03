import type { DocumentParser, ParsedDocument, SourceContent, SourceDocument, DocumentSection } from '../contracts.js';
import { defaultFileTypes, type FileTypeRegistry } from '../file-types/registry.js';
export const PARSER_VERSION = '1';
const definition = (doc: SourceDocument, fileTypes: FileTypeRegistry) => fileTypes.get(doc.path ?? doc.name);
function base(doc: SourceDocument, content: SourceContent, parserId: string, fileTypes: FileTypeRegistry): ParsedDocument {
  if (content.text.includes('\0')) throw new Error('Binary content is not indexable');
  const text = content.text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '');
  const language = definition(doc, fileTypes)?.language;
  return { document: doc, text, parserId, title: doc.name, ...(language ? { language } : {}),
    sections: text ? [{ startLine: 1, endLine: text.split('\n').length, kind: parserId === 'code' ? 'code' : 'text' }] : [],
    headings: [], outgoingLinks: [] };
}
export class PlainTextParser implements DocumentParser {
  readonly id: string = 'text';
  constructor(protected readonly fileTypes: FileTypeRegistry = defaultFileTypes) {}
  supports(doc: SourceDocument): boolean { return definition(doc, this.fileTypes)?.parserId === this.id; }
  parse(doc: SourceDocument, content: SourceContent): ParsedDocument { return base(doc, content, this.id, this.fileTypes); }
}
export class CodeParser extends PlainTextParser { override readonly id = 'code'; }
/** Structured formats retain their exact line structure; JSON syntax is not required for indexing incomplete files. */
export class StructuredTextParser extends PlainTextParser { override readonly id = 'structured'; }
export class MarkdownParser extends PlainTextParser {
  override readonly id = 'markdown';
  override parse(doc: SourceDocument, content: SourceContent): ParsedDocument {
    const parsed = base(doc, content, this.id, this.fileTypes);
    const lines = parsed.text.split('\n');
    let start = 0;
    if (lines[0] === '---') {
      const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
      if (end > 0) { parsed.frontmatter = lines.slice(1, end).join('\n'); start = end + 1; }
    }
    const sections: DocumentSection[] = [];
    let sectionStart = start; let heading: string | undefined; let fence: { char: string; length: number } | undefined;
    const push = (end: number) => {
      if (end > sectionStart) sections.push({ startLine: sectionStart + 1, endLine: end, kind: 'text', ...(heading ? { heading } : {}) });
    };
    for (let i = start; i < lines.length; i++) {
      const line = lines[i]!;
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (marker) {
        if (!fence) fence = { char: marker[1]![0]!, length: marker[1]!.length };
        else if (marker[1]![0] === fence.char && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
        continue;
      }
      if (fence) continue;
      const atx = /^ {0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
      const setext = i + 1 < lines.length && line.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[i + 1]!);
      const nextHeading = atx?.[1] ?? (setext ? line.trim() : undefined);
      if (nextHeading) { push(i); sectionStart = i; heading = nextHeading; parsed.headings.push(heading); if (parsed.headings.length === 1) parsed.title = heading; }
      for (const match of line.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]|\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
        const link = match[1] ?? match[2]; if (link) parsed.outgoingLinks.push(link);
      }
      if (setext) i++;
    }
    push(lines.length);
    parsed.sections = sections; parsed.outgoingLinks = [...new Set(parsed.outgoingLinks)];
    return parsed;
  }
}
export class ParserRegistry {
  private readonly parsers = new Map<string, DocumentParser>();
  /** Custom parser behavior must have an explicit version to permit persisted reuse. */
  readonly version: string | undefined;
  constructor(parsers?: DocumentParser[], readonly fileTypes: FileTypeRegistry = defaultFileTypes, version?: string) {
    this.version = version ?? (parsers === undefined && new.target === ParserRegistry ? PARSER_VERSION : undefined);
    for (const parser of parsers ?? [new MarkdownParser(fileTypes), new PlainTextParser(fileTypes), new CodeParser(fileTypes), new StructuredTextParser(fileTypes)]) { if (this.parsers.has(parser.id)) throw new Error(`Duplicate parser: ${parser.id}`); this.parsers.set(parser.id, parser); }
  }
  select(document: SourceDocument): DocumentParser {
    const type = this.fileTypes.get(document.path ?? document.name);
    if (!type?.indexable) throw new Error(`Unsupported file type: ${document.name}`);
    const parser = this.parsers.get(type.parserId);
    if (parser?.supports(document)) return parser;
    const fallback = this.parsers.get('text');
    if (type.textFallback && fallback) return fallback;
    throw new Error(`No parser for ${type.parserId}`);
  }
  async parse(document: SourceDocument, content: SourceContent): Promise<ParsedDocument> {
    return this.select(document).parse(document, content);
  }
}
