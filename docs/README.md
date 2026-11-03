# Documentation

## Consumer guides

- [README](../README.md): installation, usage and capabilities
- [Integration](integration.md): host sources, adapters, storage and MiniLM
- [Public API](api.md): contracts, lifecycle, errors and cancellation
- [Architecture](architecture.md): indexing and retrieval internals
- [Supported file types](file-types.md): generated extension registry
- [Examples](../examples/README.md): maintained executable examples
- [Command-line tool](../cli/README.md): usage, model cache and saved indexes
- [Evaluation](evaluation.md): methodology and historical measurements

## Historical design and validation

These are **dated technical records**, not active release instructions. Previous milestone names in the technical records describe how evaluation evolved, not the public release history.

- [Alpha.5 hardening](https://github.com/the-leumas/provena/blob/main/docs/alpha5-hardening.md)
- [Alpha.6 answerability design](https://github.com/the-leumas/provena/blob/main/docs/alpha6-answerability.md)
- [Alpha.6 development evidence](https://github.com/the-leumas/provena/blob/main/docs/alpha6-evidence-traces.md)
- [Retrieval boundary validation record](https://github.com/the-leumas/provena/blob/main/docs/alpha6-c-validation.md)
- ADRs: [MiniLM loading](decisions/0001-minilm-loading.md), [retrieval modes](decisions/0002-retrieval-modes.md), [evidence boundary](decisions/0003-retrieval-evidence-boundary.md)
- Benchmark records (`docs/benchmarks/*.json`): historical measurement records; excluded from the npm tarball

See the [changelog](../CHANGELOG.md) for release changes and the [roadmap](../ROADMAP.md) for possible future work.
