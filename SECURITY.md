# Opnory Security Policy

This repository follows the central Opnory security policy.

**Report vulnerabilities to:** security@opnory.com

**Full policy:** https://github.com/opnory/support/blob/main/SECURITY.md

---

## Scope

This policy covers the Opnory open-source codebase in this repository. For issues related to the Opnory Cloud hosted service, see the central policy.

Do not report security vulnerabilities through public GitHub issues, discussions, or social media.

---

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| Main branch (latest) | ✅ Security fixes |
| Previous minor (N-1) | ✅ Critical fixes only |

Only the latest main branch and the immediately preceding minor release receive security patches. Older versions should be upgraded.

---

## Disclosure Process

1. **Private report** — Email details to security@opnory.com with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (if any)

2. **Acknowledgment** — We confirm receipt within **2 business days**.

3. **Assessment** — We validate and classify severity within **5 business days**.

4. **Fix development** — We develop and test a fix. Timeline depends on severity:
   - Critical: target **≤ 14 days**
   - High: target **≤ 30 days**
   - Medium/Low: next regular release

5. **Coordinated disclosure** — We agree on a disclosure date (typically **7 days after fix release**). No public disclosure before the fix is available.

6. **Credit** — Reporters are credited in the release notes unless anonymity is requested.

---

## Out of Scope

The following do not qualify for the coordinated disclosure process:

- Issues requiring physical access or local admin privileges
- Social engineering, phishing, or physical attacks
- Vulnerabilities in third-party dependencies (report to the upstream maintainer)
- Theoretical issues without a practical exploit path
- Denial-of-service via resource exhaustion without a specific code flaw

---

## Security Features in This Codebase

- Structured logging with automatic redaction of secrets, tokens, and credentials
- Input validation via Zod schemas at all external boundaries
- Database access via parameterized queries / ORM (no raw SQL concatenation)
- Authentication/authorization delegated to external providers (Entra ID, Okta, GitHub)
- Live governance tests require explicit sandbox confirmation and allowlisted identities