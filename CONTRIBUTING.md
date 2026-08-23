# Contributing to Opnory

Thank you for contributing to Opnory. This document outlines the process and expectations for contributions.

---

## Developer Certificate of Origin (DCO)

All contributions must be certified with a **Signed-off-by** line in the commit message.

```bash
git commit -s -m "Your commit message"
```

This certifies that you:

1. Created the contribution yourself, or
2. Have the right to submit it under the BSD-2-Clause license, or
3. Are authorized by your employer to contribute

The DCO text is in [DCO.txt](DCO.txt) (or see https://developercertificate.org/).

---

## Pull Request Expectations

### Before Opening a PR

- [ ] Run `bun install` (installs dependencies)
- [ ] Run `bun run typecheck` — must pass
- [ ] Run `bun run build` — must pass
- [ ] Run `bun test` — must pass (0 failures)
- [ ] Run `bun run format` — code formatted with Prettier

### PR Requirements

- **Small, focused changes** — one logical change per PR
- **Clear title and description** — what, why, testing done
- **Tests included** — new behavior requires tests; bug fixes require regression tests
- **No secrets or live data** — never commit credentials, tenant IDs, sandbox IDs, or live evidence
- **Update documentation** — if behavior changes, update README/SECURITY.md/architecture docs

### Prohibited Content

Do not commit:

- `.env` files or any environment configuration with real values
- Entra/Okta/GitHub client secrets, tokens, or private keys
- Real tenant IDs, object IDs, user IDs, or sandbox resource IDs
- `.live-results/` evidence files
- Personal paths (`/Users/...`, `/home/...`)
- Internal hostnames, IPs, or infrastructure identifiers

---

## Testing Requirements

### Unit / Contract Tests (default)

```bash
bun test
```

These run in CI on every PR. Must pass with 0 failures.

### Live Governance Tests (opt-in)

```bash
OPNORY_LIVE_GOVERNANCE_TESTS=true \
OPNORY_ENTRA_SANDBOX_CONFIRM=true \
# ... additional required env vars ...
bun run live:entra
```

**Never run these in CI on public forks.** They require explicit sandbox credentials and confirmation env vars.

---

## Code Style

- **TypeScript** — strict mode, explicit return types on public APIs
- **Prettier** — `bun run format` before committing
- **No `any`** — use `unknown` and narrow; `any` only with `// eslint-disable-line` justification
- **Async/await** — prefer over Promise chains
- **Error handling** — never swallow errors; use typed error codes

---

## Commit Hygiene

- **Signed-off-by** required (DCO)
- **Conventional commits** preferred:
  - `feat:` new feature
  - `fix:` bug fix
  - `docs:` documentation only
  - `refactor:` code change, no behavior change
  - `test:` test additions/changes
  - `chore:` build/tooling
- **Atomic commits** — one logical change per commit
- **No fixup/squash commits in history** — rewrite locally before pushing

---

## Review Process

1. CI must pass (typecheck, build, tests)
2. At least one maintainer approval
3. All conversations resolved
4. Linear history — squash and merge

---

## Reporting Issues

- **Bugs** — GitHub Issues with reproduction steps
- **Security** — See [SECURITY.md](SECURITY.md) (private email only)
- **Features/Design** — GitHub Discussions preferred

---

## License

By contributing, you agree your contributions are licensed under the **BSD-2-Clause License** (see [LICENSE](LICENSE)).

---

## Questions?

- General: hello@opnory.com
- Security: security@opnory.com
- Support: support@opnory.com