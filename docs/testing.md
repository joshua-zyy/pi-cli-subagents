# Local Test Tiers and Verification Costs

## Entry points and boundaries

The existing Node test infrastructure is unchanged. `scripts/test.mjs` selects local tests, isolates the environment before imports, and runs tests serially. The counts and costs below are the baseline from the introduction of test tiers (`bf85d3e`): the existing 45 files and 385 tests were retained, with 5 launcher tests added, for a total of 390. Later regression tests do not rewrite historical measurements; use actual execution output for current counts.

| Entry point | Files / tests | Scope |
|---|---:|---|
| `npm run test:fast` | 26 / 239 | Logic, UI, result projections and transcript reading without launching CLIs/Git; temporary file I/O is allowed |
| `npm run test:domain` | 6 / 62 | Single-module protocols/adapters, RPC, storage races, Git workspaces and the test launcher; local fixtures only |
| `npm run test:acceptance:local` | 14 / 89 | Local end-to-end checks for the manager, extension entry points, UI actions, approvals and recovery; CLIs use fixtures |
| `npm test` | 46 / 390 | Union of the three local selections above; excludes real-model acceptance |
| `npm run test:list` | No tests executed | List all local test files and identify real acceptance tests that were not run |

Execution entry points build `dist/` first; `test:list` does not build. With a current build, run `node scripts/test.mjs fast` directly.

File classification is defined in [`scripts/test-tiers.json`](../scripts/test-tiers.json). Every formal `.test.mjs` file must belong to exactly one tier. Duplicates, omissions, missing files and non-test entries fail before test imports rather than being silently skipped.

```bash
# List a tier without executing it
node scripts/test.mjs domain --list

# Run only the specified files in that tier (no implicit fast-tier run)
npm run test:domain -- workspace.test.mjs
npm run test:acceptance:local -- extension.test.mjs tool-receipts.test.mjs
```

Files from other tiers, unknown tiers, arbitrary paths and `real-smoke.mjs` are rejected. Real-model scripts such as `test/real-smoke.mjs` are excluded from these entry points and explicitly reported as **NOT_RUN**. Their existing standalone invocation remains unchanged and still requires explicit user authorization. A local PASS does not establish acceptance of real CLIs, models, OS crashes or the human TUI experience.

## Environment isolation

Each execution creates a temporary `PI_CODING_AGENT_DIR` and applies it before child-process module imports, preventing the user's worker-role configuration from redirecting a Pi fixture to real Codex/Claude. It also clears the inherited `PI_CLI_SUBAGENT` marker so extension registration does not return early. The real child-agent recursion guard remains intact; tests do not disable it.

The Node runner uses `--test-concurrency=1` and does not modify the parent process environment or the user's global configuration. The temporary home is cleaned up on normal completion and failure, preserving the test exit code. This entry point is not an OS sandbox and does not guarantee temporary-directory cleanup after a force kill or power loss.

Launcher tests use independent miniature repositories to verify real process boundaries. Before starting the inner runner, they remove `NODE_TEST_CONTEXT` only in the fixture environment so Node does not mistake it for recursive execution of the outer test and silently skip it.

## Tier selection rules

1. For everyday changes, run the fast tier and relevant domain files. Changes to shared entry points such as `src/index.ts` or notifications/receipts also need the corresponding local acceptance checks.
2. For native CLI adapter changes, run the relevant adapter domain tests and manager/workspace local acceptance checks. This does not automatically authorize real-model calls.
3. Close-out without CI requires at least the complete fast and domain tiers. Use `npm test` for full local regression after changes to shared schemas, cross-tier contracts or test entry points.
4. Update the manifest before adding tests. Classify by actual dependencies, not filenames. A few mixed-tier files remain, such as `core.test.mjs` and `tool-receipts.test.mjs`; do not refactor their contents just for tiering.
5. Treat 20 seconds of fast-tier wall time as a review threshold, not a failure gate. If exceeded, check machine load, dependencies and tier assignment first; do not remove safety coverage to meet a time or test-count target. Removing or merging tests requires separate counterexample/mutation evidence.

## Cost measurements

These measurements were collected in independent runs on Windows / Node 22.21.0; each entry point includes one build. All passed with skipped=0; real CLI/model acceptance was NOT_RUN throughout.

| Entry point | Passed / total | Wall time including build | Node runner time |
|---|---:|---:|---:|
| `npm run test:fast` | 239 / 239 | 15.62 s | 11.96 s |
| `npm run test:domain` | 62 / 62 | 59.13 s | 55.36 s |
| `npm run test:acceptance:local` | 89 / 89 | 153.27 s | 149.60 s |
| `npm test` | 390 / 390 | 220.77 s | 217.09 s |

Tiering reduces the cost of selecting tests for everyday changes; it does not claim to accelerate the full suite. The full-suite 220.77 seconds came from an independent run, not the sum of the three tier times. Local logs are in the ignored `.test-output/tiers-*.log` and `tiers-timings.json`. Remeasure after environment or test changes; this table is not a continuing performance guarantee.
