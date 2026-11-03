# Supported file types

Generated from the package registry by `npm run docs:file-types`. Do not edit this table by hand.

| Extensions | Kind | Language | Parser | Structure-aware | Text fallback | Max bytes |
| --- | --- | --- | --- | --- | --- | ---: |
| `.md` | document | markdown | markdown | yes | yes | 2097152 |
| `.txt` | document | text | text | no | yes | 2097152 |
| `.js`, `.jsx`, `.mjs`, `.cjs` | code | javascript | code | no | yes | 2097152 |
| `.ts`, `.tsx` | code | typescript | code | no | yes | 2097152 |
| `.py` | code | python | code | no | yes | 2097152 |
| `.rs` | code | rust | code | no | yes | 2097152 |
| `.go` | code | go | code | no | yes | 2097152 |
| `.java` | code | java | code | no | yes | 2097152 |
| `.c`, `.h` | code | c | code | no | yes | 2097152 |
| `.cpp`, `.hpp` | code | cpp | code | no | yes | 2097152 |
| `.html` | code | html | code | no | yes | 2097152 |
| `.css` | code | css | code | no | yes | 2097152 |
| `.scss` | code | scss | code | no | yes | 2097152 |
| `.json` | configuration | json | structured | no | yes | 2097152 |
| `.yaml`, `.yml` | configuration | yaml | structured | no | yes | 2097152 |
| `.toml` | configuration | toml | structured | no | yes | 2097152 |
| `.sh`, `.bash` | code | bash | code | no | yes | 2097152 |
| `.fish` | code | fish | code | no | yes | 2097152 |
| `.sql` | code | sql | code | no | yes | 2097152 |

Markdown preserves frontmatter as raw text and recognizes a lightweight subset of Markdown structure. Code and structured configuration preserve text and line boundaries; they do not use language ASTs or validate YAML/JSON.

Unknown extensions are rejected by default. Explicit custom definitions can opt additional text formats into a shared FileTypeRegistry. A declared text fallback is used only when the selected parser is unavailable and a text parser was registered.

No binary extraction: PDF, DOCX, XLSX, PPTX, images, audio, video, archives and executables are unsupported. The filesystem adapter rejects NUL-containing or invalid UTF-8 content even when its extension is supported.
