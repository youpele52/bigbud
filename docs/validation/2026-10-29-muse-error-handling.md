# Muse error-handling follow-up

## Scope

The user authorized a broader Muse error-handling review after six Effect diagnostics
blocked the server typecheck. Preserve provider behavior, original error causes and
unsafe-to-replay classifications; do not suppress diagnostics or add native retries.

All provider source/test edits are confined to `apps/server/src/provider/Layers/Muse`.
Existing concurrent work, marketplace removal, gauge formatting, provider-internal
OpenCode plugins, persistence interfaces, contracts and dependencies are preserved.
This record and the marketplace records document the original blocker's resolution.

## Root causes and repairs

| Concern                                  | Repair and regression coverage                                                                                                                                                                                              |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Six failing diagnostics                  | Replace global Error/unknown promise error channels with the existing tagged adapter request error. Preserve native evidence privately for refusal/already-applied handling, outside renderable error causes.               |
| False successful inspection              | Validate native session identity and evidence; only matching terminal evidence proves completion/failure. Malformed reads are unavailable, not successful completion.                                                       |
| Terminal-before-ack journal race         | Share monotonic, bounded CAS advancement with immutable-material checks. Already advanced matching rows are idempotent; terminal rows never reopen. Real SQLite tests cover the race.                                       |
| Swallowed journal/binding failures       | Await durable binding writes. Recovery counts/delivers only persisted outcomes. Failed live settlement retains unresolved tracking and surfaces a diagnostic.                                                               |
| Startup interruption and host loss       | Close late-acquired host/bridge resources, attempt both cleanup operations, fence owning state/callbacks, and emit unexpected session exit once without inventing turn success.                                             |
| Late queued acknowledgements             | Merge acknowledgements with bounded in-flight lifecycle observations so settled work cannot become queued/running again.                                                                                                    |
| Resumed state and early callbacks        | Restore authoritative active/queued evidence, respect newer explicit null, buffer bounded ordered startup callbacks, and reject pending requests on failed startup.                                                         |
| Malformed async/interactive payloads     | Validate identifiers, errors, questions/options and command acknowledgements. Retain pending interactions after uncertain acknowledgement; retire them on authoritative settlement.                                         |
| Error presentation                       | Reuse existing secret redaction, normalize one line, redact email labels and bound text. Private WeakMap evidence cannot leak through public Effect cause rendering.                                                        |
| Recovery/startup publication ordering    | Reconcile buffered lifecycle callbacks with recovered durable terminals before publication. Integration tests cover real admissions, liveness, delivery and ingestion, including prior terminal claims and late duplicates. |
| Settlement before answer acknowledgement | Decode native recorded answers before pending retirement; preserve structured notes and exactly one canonical resolution even when the later acknowledgement is lost or malformed.                                          |

## Focused validation

Both implementation and parent sessions ran:

- Explicit-path Oxc formatting and lint for **47 source/test files**: passed,
  **0 lint warnings/errors**.
- Direct line-count checks of those files: passed, maximum **385 lines**.
- Configured `bun run --cwd apps/server typecheck`: **exit 0**; the six warning-level
  diagnostics are gone. Non-failing informational/refactor Effect messages remain.
- Explicit-path Vitest coverage: **33 files / 197 tests passed**, including Muse
  adapter/client/provider tests and affected persistence, composition and orchestration.

The parent also reran the marketplace removal's **10 focused server files / 28 tests**:
passed. No repository/workspace/full-suite checks or live-provider qualification ran.
SDK lifecycle tests use mocks; persistence tests use in-memory SQLite. No credentials,
native configuration, installed runtimes or paid/provider requests were used.

Independent code and security reviews: **approved** after remediation and focused
re-review. Initial review identified three issues: a raw-cause presentation leak,
recovered-terminal/buffered-start ordering, and recorded-answer loss on early native
settlement. All three have focused regressions and were cleared on re-review. Reviewers
performed static source/diff review; the parent independently reran the final checks.

## Reproduction artifacts

Implementation plan, baseline copies, exact edited/test path inventories, source diff,
hashes and command logs are retained locally under:

```text
<qualification-root>/error-handling/
```

`Muse.baseline/` captures the pre-existing untracked Muse directory; `muse.changes.diff`
shows this task's changes rather than treating all untracked files as newly authored.
`changed-files.txt` and `test-files.txt` enumerate the exact check scope.

## Conservative boundaries

- Native commands retain `maxAttempts: 1`; uncertain submissions are not replayed.
- A native acknowledgement may legitimately return a different turn ID. Live tracking
  uses that identity; the existing immutable admission schema has no durable alias.
  Unmatched restart evidence remains unresolved instead of being replayed or completed.
- Native root queued inputs do not always carry turn identities. Only head-matching
  snapshot evidence restores real queued IDs; missing proof remains conservative busy
  or inspection-unavailable state rather than fabricated identities/completion.
- Authoritative live terminal delivery can proceed despite journal persistence failure,
  but unresolved journal evidence is retained and is not reported as durable recovery.
- No commits or pushes were performed by this task. A concurrent unrelated terminal
  commit advanced HEAD during implementation; it was not reverted or attributed here.
