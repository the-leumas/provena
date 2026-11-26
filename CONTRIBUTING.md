# Contributing

Issues, small fixes, relevant documentation improvements, reproducible benchmarks and focused pull requests are welcome.

## Development

From a checkout of this repository, use Node.js 20 or newer:

```sh
cd provena
npm ci
npm run typecheck
npm test
npm run build
npm pack
```

Default tests are deterministic and do not download model assets. Real model and browser tests are opt-in and have additional setup; see [evaluation](docs/evaluation.md) and [examples](examples/README.md).

## Issues and pull requests

Search for an existing issue before opening a new one. Include package/runtime versions, a minimal reproduction, expected and observed results, and relevant logs. Do not include secrets, private sources or access tokens.

Keep changes focused. Add regression coverage for behavior changes and update relevant API/integration documentation. Report checks that were not run. New abstractions or public exports need an identified consumer use case and a compatibility discussion.

Current contracts are in [API](docs/api.md); the [roadmap](ROADMAP.md) describes ideas rather than committed work. Design records explain how current behavior was reached, but they are not contributor instructions.

## Releases

Releases are published to npm from GitHub Actions via [`.github/workflows/release.yml`](.github/workflows/release.yml) using npm Trusted Publishing (OIDC provenance, no long-lived `NPM_TOKEN` secret):

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` in a pull request against `main`, and verify CI is green before merging.
2. Create and push an annotated or lightweight version tag matching `package.json`'s `version` (for example, `git tag v0.1.0-beta.3 && git push origin v0.1.0-beta.3`).
3. The release workflow verifies that the tag matches `package.json`, runs `npm ci --ignore-scripts`, `npm run typecheck`, `npm test`, and `npm run prepack`, and publishes with `--provenance --access public` (`--tag beta` for pre-release versions, `--tag latest` for stable versions).

By contributing, you agree your contributions are provided under the project's [MIT license](LICENSE).
