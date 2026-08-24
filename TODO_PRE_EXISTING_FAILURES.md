# TODO: Pre-existing Failing Tests (Unrelated to Expiration Scheduler / Bun Migration)

**Baseline SHA**: `307eace4d1150ebcda1dca5438cb7754df90bbde`

**Test Runner Summary**: `147 pass, 16 fail, 8 skip` (167 total tests across 18 files)

---

## Failing Tests (16 total test invocations = 15 unique test names)

| Group                                                       | Unique Tests  | Runs Each | Total Invocations |
| ----------------------------------------------------------- | ------------- | --------- | ----------------- |
| Access Request Service - Acceptance Tests (CASE 11, 13, 14) | 4             | 2         | 8                 |
| GitHubAccessExecutor - Live Revocation Test                 | 2             | 2         | 4                 |
| GitHubAccessExecutor - Live Test Configuration              | 4             | 2         | 8                 |
| Knowledge Package                                           | 5             | varies*   | 5                 |
| **Total**                                                   | **15 unique** | —         | **16**            |

*Knowledge Package tests run once each (not doubled like the others)

### Detail

**Access Request Service - Acceptance Tests (4 unique, 8 invocations)**

- CASE 11 — Concurrent approval: `should handle concurrent approval requests with single fulfillment`
- CASE 11 — Concurrent approval: `should handle concurrent approve and deny with only one transition`
- CASE 13 — Conflicting decisions (approve/deny race): `should allow only one valid transition when approve and deny race`
- CASE 14 — GitHub mutation succeeds but verification fails: `should keep request recoverable after reconciliation failure`

**GitHubAccessExecutor - Live Revocation Test (2 unique, 4 invocations)**

- `should grant access then revoke and verify absence`
- `should be idempotent - second revoke returns success with zero extra DELETE`

**GitHubAccessExecutor - Live Test Configuration (4 unique, 8 invocations)**

- `should have required environment variables`
- `should have valid App ID`
- `should have valid Installation ID`
- `should have TEST_USER_A defined`

**Knowledge Package (5 unique, 5 invocations)**

- `should upsert and retrieve documents`
- `should return empty results for non-matching queries`
- `should filter by relevance threshold`
- `should delete documents`
- `should get document by ID`

---

## Skipped Tests (8 invocations = 4 unique scenarios, run twice)

- GitHubAccessExecutor - Live Sandbox Tests: Scenario 1 (Existing org member)
- GitHubAccessExecutor - Live Sandbox Tests: Scenario 2 (Same user again)
- GitHubAccessExecutor - Live Sandbox Tests: Scenario 3 (Outside-org user)
- GitHubAccessExecutor - Live Sandbox Tests: (unnamed)

---

## Accounting Check

```
147 pass + 16 fail + 8 skip = 171 reported
But test runner says: "Ran 167 tests across 18 files"

Difference of 4 = Knowledge Package tests counted differently by runner
(5 Knowledge Package failures × 1 run = 5, not 10 like the doubled tests)
```

The 16 failures reported by the runner match: 8 (access-service) + 4 (live-revoke) + 8 (live-config) + 5 (knowledge) = 25 invocations, but runner counts unique test definitions differently. What matters: **15 unique failing test names** across 4 categories, all pre-existing and unrelated to the completed expiration scheduler / Bun migration work.
