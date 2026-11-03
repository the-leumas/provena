# Security policy

## Supported versions

Provena is pre-1.0 and has no long-term support branch. Security fixes are made
against the latest published version.

| Version     | Supported |
| ----------- | --------- |
| 0.1.x-beta  | Yes       |
| < 0.1       | No        |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through GitHub's [private vulnerability reporting][report]
(Security → Advisories → Report a vulnerability). If that is unavailable, open a
public issue that says only that you have a security report and ask for a private
channel; do not include details.

Please include:

- the affected version and how it was installed (npm, tarball, checkout)
- Node.js version and operating system
- a minimal reproduction, if one is possible
- the impact you believe it has
- any suggested fix or mitigation

I aim to acknowledge a report within 7 days and to give an initial assessment
within 14. If the report is accepted, a fix and a GitHub security advisory will be
published. Credit is given unless you ask to remain anonymous.

[report]: https://github.com/the-leumas/provena/security/advisories/new

## Scope

In scope:

- code execution, path traversal, or writes outside a configured source root or
  index path
- unsafe deserialization of a stored index, including prototype pollution
- denial of service caused by a crafted document, source, or index file
- leakage of credentials, environment values, or document content through the
  CLI or the filesystem adapter

Out of scope:

- retrieval quality, ranking, or incorrect answers. Provena returns ranked
  passages, not verified answers; see [Known limitations](README.md#known-limitations).
- vulnerabilities in optional peer dependencies such as
  `@huggingface/transformers` or the ONNX runtime. Report those upstream.
- an attacker who already controls the host, the corpus, or the index file.
- prompt injection. Provena does not call an LLM.
