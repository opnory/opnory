# staging environment — placeholder (Phase 1A)

Per ADR 0012 §2, `staging/` exists to name the future environment only. It
contains no resources and must not create any in Phase 1A. Authority over
`staging` is not granted by anything in this repository today.

When `staging` is eventually built it must follow the same host-contract and
environment wiring as `lab/`, with its own out-of-band state backend and
environment-protected GitHub Actions gate — never shared state with `lab/`.
