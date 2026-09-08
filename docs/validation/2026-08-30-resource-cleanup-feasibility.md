# Direct Resource Cleanup Native Feasibility Evidence

The implementation-first feasibility harness is the platform-gated
`resource_cleanup` Rust test suite. It invokes the real descriptor/handle
algorithms in temporary filesystems; no pathname mocks are used for mutation.

| Platform primitive                                                     | Harness evidence                                                                                                                                          | Fail-closed behavior                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Unix descriptor-relative open, rename, traversal, and unlink           | `unix.tests.rs` file, nested-directory, symlink-child, symlink-ancestor, replacement, quarantine-resume, and lock-contention tests                        | Links, special entries, identity changes, mount changes, bounds, and lock contention retain the object                                       |
| Linux mount identity                                                   | `refuses_a_same_device_bind_mount_boundary` privileged test                                                                                               | Missing `statx` mount identity or a changed mount ID is `unsupported_entry`                                                                  |
| macOS filesystem identity                                              | The same Unix harness using `fstatfs` filesystem IDs                                                                                                      | A changed filesystem ID is `unsupported_entry`                                                                                               |
| Windows relative NT handles, rename, disposition, and reparse handling | `windows.tests.rs` file, nested tree, verified parent, junction, open-delete-sharing, replacement, resume, lock, cancellation, and known-byte-bound tests | Reparse traversal, identity changes, bounds, and lock contention retain the object                                                           |
| Cancellation and bounded shutdown                                      | Platform cancellation tests plus the real stdio session cancellation frame                                                                                | Cancellation is checked between entries and during traversal; stdin closure requests cancellation and allows two seconds before process exit |

The CI `native_resource_cleanup` matrix runs these tests on macOS arm64/x64,
Linux x64, and Windows x64. The privileged Linux mount job runs separately.
Cross-compilation is useful build evidence only and is not treated as native
support evidence.

## Crash and failure-injection matrix

| Injection point                                                                | Expected recovery                                                                                  | Focused evidence                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Intent projection before reactor delivery / before plan insert                 | Indexed open intent is reconstructed                                                               | Migration 108 backfill/trigger test and repository recoverable-intent test |
| Plan insert before finalize                                                    | Stored immutable plan is reused; no mutation is claimable                                          | Repository duplicate-prepare, load-plan, and pre-proof claim tests         |
| During finalize                                                                | Exact command payload is queried/replayed                                                          | Prepared-plan reconciliation tests and handler ambiguous-finalize tests    |
| Accepted receipt before proof snapshot                                         | Matching receipt/event creates one immutable proof                                                 | Repository proof-reconciliation and proof-conflict tests                   |
| Proof snapshot before canonical pruning                                        | Thread plan remains unclaimable until pruning is recorded                                          | Repository before/after-pruning claim test                                 |
| Pruning before Rust acceptance                                                 | Ready plan remains durably claimable                                                               | Recovery claim tests and real-process executor integration test            |
| Quarantine rename / during traversal                                           | Matching quarantine resumes; unsafe entries retain                                                 | Unix/Windows resume, link/reparse, replacement, bound, and deadline tests  |
| Removal before response                                                        | Replay observes absence as idempotent success                                                      | Native `already_absent` and session replay tests                           |
| Response before SQLite result commit                                           | Prepared/sent/ambiguous exact request bytes and original deadline replay                           | Coordinator byte-replay and repository replayable-attempt tests            |
| Server shutdown during execution                                               | Cancellation is signalled; child settles for two seconds or is terminated; lease remains retryable | Coordinator cancellation/concurrency tests and native cancellation tests   |
| Orphan child holds OS lock while lease expires and a second coordinator starts | Native lock rejects overlap; expired lease returns to retry                                        | Unix/Windows lock-contention and repository stale-lease tests              |

All recovery rows preserve operation, plan, proof, page, resource-set, request,
and deadline identity. Contradictory receipt/event facts become blocked records
rather than filesystem mutations.
