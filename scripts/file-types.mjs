import { readFile, writeFile } from 'node:fs/promises';
import { FILE_TYPES } from '../dist/index.js';
const text = [
  '# Supported file types', '',
  'Generated from the package registry by `npm run docs:file-types`. Do not edit this table by hand.', '',
  '| Extensions | Kind | Language | Parser | Structure-aware | Text fallback | Max bytes |',
  '| --- | --- | --- | --- | --- | --- | ---: |',
  ...FILE_TYPES.map(type => `| ${type.extensions.map(ext => '`' + ext + '`').join(', ')} | ${type.kind} | ${type.language} | ${type.parserId} | ${type.structureAware ? 'yes' : 'no'} | ${type.textFallback ? 'yes' : 'no'} | ${type.maxBytes} |`),
  '', 'Markdown preserves frontmatter as raw text and recognizes a lightweight subset of Markdown structure. Code and structured configuration preserve text and line boundaries; they do not use language ASTs or validate YAML/JSON.', '',
  'Unknown extensions are rejected by default. Explicit custom definitions can opt additional text formats into a shared FileTypeRegistry. A declared text fallback is used only when the selected parser is unavailable and a text parser was registered.', '',
  'No binary extraction: PDF, DOCX, XLSX, PPTX, images, audio, video, archives and executables are unsupported. The filesystem adapter rejects NUL-containing or invalid UTF-8 content even when its extension is supported.', '',
].join('\n');
const path = new URL('../docs/file-types.md', import.meta.url);
if (process.argv.includes('--check')) {
  if (await readFile(path, 'utf8') !== text) throw new Error('File-type docs drifted. Run npm run docs:file-types.');
} else await writeFile(path, text);
