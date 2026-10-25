# Effect RPC ownership repair

## Scope

bigbud pins Effect `4.0.0-beta.43`. The approved Bun dependency repair changes
only its RPC server/client implementation, with matching TypeScript source and
exported compiled JavaScript. No Effect version upgrade or new dependency is
included. `package.json` and `bun.lock` both reference the reproducible repair in
`patches/effect@4.0.0-beta.43.patch`.

## Proven defects addressed

- A server request fiber could execute before its ownership map and observer were
  installed. An explicit closed start gate now prevents execution until both are
  registered. This is not a timing delay or `onFiberStart` workaround.
- Failed chunk encoding previously returned success after reporting a failure,
  allowing its producer to wait indefinitely for an Ack that would never arrive.
  Encoding failure now fails the producer. Its request scope closes before the
  failure response is sent. Terminal unary encoding still reports a local failure.
- Synchronous handler factory exceptions are captured as request failures, so
  bigbud's explicit `disableFatalDefects` policy also applies to them.
- Client stream cancellation now has independent, idempotent ownership rather
  than depending on response-table presence. Global failure cancels requests
  before failing their consumers. The serialization layer forwards cancellation
  even when its own response entry has already disappeared.
- Chunk decode failure cancels the affected producer and fails only that request,
  rather than terminating the shared client response reader.

bigbud separately retires physically poisoned protocol generations through a
single-flight, bounded recovery owner. Ordinary request-local failures do not
retire healthy sibling requests. Mutations are not automatically replayed.

Cancellation retires the RPC waiter/request scope; it is not a domain rollback.
In the current orchestration engine, `dispatch` offers an envelope to the
engine-owned admission queue and then waits for its result. The separately
scoped worker owns admitted execution, so interrupting that waiter does not
remove its admitted envelope. Startup commands already queued in the command
gate likewise remain worker-owned. A regression exercises that actual gate
across RPC retirement and asserts exactly one admitted execution.

This is **not** a guarantee that every request-scoped mutation continues: work
not yet admitted, direct request-scoped operations, or infrastructure failure
may be interrupted. A disconnect can leave the caller with an unknown outcome.
Existing command-outcome/receipt recovery remains authoritative; no automatic
mutation replay or new blanket mutation timeout is introduced.

## Config recovery and readiness

Config synchronization has one explicit retry owner and a three-failure budget.
Applying the first valid baseline is progress; replaying identical bootstrap
snapshots after failures is not. A successfully applied config attempt that
remains live for 30 seconds also resets its failure streak. Deterministic errors
back off from 250 ms; socket errors use the existing socket owner's 1-second
initial reconnect delay rather than exhausting config retries before it can run.
Fallback fetches remain single-flight, and stale fetch/subscription generations
cannot overwrite the active baseline.
Only the read-only `server.getConfig` fallback has a 15-second request deadline.
The deadline interrupts its Effect request fiber and waits for scoped cleanup;
it does not race and abandon a JavaScript promise. A timeout becomes a visible
fallback failure and releases the fallback owner so explicit retry can issue a
fresh request. Other unary requests retain their existing no-deadline default.

Each config subscription attempt also has a 15-second **initial applied
snapshot** deadline. A scoped race cancels its actual RPC request if application
does not complete; raw receipt, ignored deltas, and stale generations do not
disarm it. Successful snapshot application disarms the deadline permanently for
that attempt, so healthy idle config streams never expire between messages.
Initial timeout consumes the same bounded retry budget, and interruption closes
the watchdog and producer scope rather than abandoning a promise.

Poisoned protocol recovery permits three failed generations, with capped
exponential backoff. After exhaustion, logical subscribers wait for explicit
recovery without scheduling another connection. Cancellation/disposal releases
their timers and waiters. Ordinary socket close/open errors retain the existing
socket retry policy instead of creating a second physical recovery owner.

The normal initial-config grace period remains 60 seconds. Confirmed fallback
or exhausted config failures are visible immediately. The readiness surface
distinguishes an open socket awaiting config from a connection still opening,
offers explicit config retry, and never discards a loaded config during recovery.
Socket diagnostics remove authentication, query strings, arbitrary paths and
fragments before retention; UI details omit raw schema errors and close reasons.
When cached config exists but updates are exhausted, one nonblocking warning
offers config retry and preserves the accepted config. During explicit recovery
it becomes an informational notice, closing only when updates are live or its
coordinator unmounts. The blocking surface offers logical retry after fallback
failure as well as stream exhaustion, and an explicit physical reconnect when
disconnected. Physical reconnect restarts only a config owner that permanently
stopped; retained subscribers resume through their existing transport owner.

## Evidence limits

The ownership hazards are reproducible. The historical installed application's
specific invalid config field remains **unproven**. Interrupted config spans and
thread-dispatch attachment schema warnings are not evidence of that field.
Config producer guards record only a fixed stage, structural area, bounded
allowlisted schema-field/index path, and issue category. Unknown string/symbol
path keys are redacted. They neither log rejected values nor weaken the contract.

## Maintenance and removal condition

The bigbud maintainers own this narrowly pinned dependency repair. No upstream
issue has been published, and no upstream release has been verified to contain
an equivalent fix. Before changing the Effect pin, inspect upstream ownership
semantics and rerun the serialized ownership regressions against the proposed
version. Remove the repair only after those tests prove registration ordering,
producer finalization, cancellation through both maps, sibling isolation, and
global cleanup, including the exported runtime used in packaged builds.

## Validation

Validation is restricted to exactly two final fixer passes, with each requested
workflow run once per pass and no full test suite.
The focused ownership harness imports `effect/unstable/rpc` through package
exports (compiled runtime) and uses the actual socket client protocol with JSON
frames. It measures producer acquisition/finalization counters, not inferred
outbound cancellation counts. Packaged artifact parity and isolated runtime
verification remain required before claiming completion.

Focused tests cover server acquisition/finalizer counts for immediate and
asynchronous encoding failures, unary/factory isolation, Ack-wait cancellation,
decode-failure cancellation through both maps, reader survival, global defects,
and malformed socket frames. Frontend tests cover bounded recovery, explicit
retry, completion backoff, timer cancellation, generation fencing, independent
transports, retained config, and real readiness rendering/redaction.
Additional regressions cover timed-out unary producer finalization, fresh
fallback ownership after its deadline, finite consumer failure cleanup, safe
structural-path retention/redaction, and admitted-command preservation. Effect
beta.43's `Stream.runForEach` already closes its channel scope on exit; bigbud
also makes its finite request scope and generation fence explicit.
Initial-application regressions cover actual producer cancellation without a
first value, disarming after application, healthy idle retention, and disposal.
Cached-config notice regressions cover warning/retry, live cleanup, unmount
cleanup, explicit reconnect, and fixed safe error copy.

### Final pass 1

- `bun fmt` and `bun lint` passed; lint reported 50 warnings and 24 test-length
  warnings outside the task-owned tests.
- `bun typecheck` failed on task-created Effect API and contract import errors.
  Turbo stopped downstream checks; this was not a whole-workspace success.
- Focused server tests: 20 passed, 3 failed. Focused web unit tests: 55 passed,
  18 failed. Focused browser tests: 8 passed, with one suite import failure.
- Minimal corrections replaced `tapErrorCause` with Effect v4's `tapCause`, used
  the direct Schema result issue, resolved contract wildcard imports, completed
  startup mocks, and retained smoke-script error causes. Checks were not rerun.
- The fresh unsigned arm64 build returned success, but its copied framework
  links referenced deleted staging. The isolated smoke failed before startup;
  no soak, profile assertion, recovery result, or memory evidence was collected.
- The approved follow-up copy repair preserves relative framework links using
  `verbatimSymlinks`. Its focused regression checks readability and executable
  mode after staging removal. The ownership polling helper now uses one
  unchanged five-second deadline rather than recursively nesting timeouts.

### Final pass 2

- `bun fmt` passed. `bun lint` passed with 52 warnings and 24 preexisting
  test-length warnings. Correctly preserved AggregateError causes still trigger
  two linter warnings; the new copy test also produced two sorting warnings.
- `bun typecheck` exited 2 on the task's `instanceOfSchema` diagnostic in
  `serverState.configSync.ts`; Turbo stopped downstream checks. That predicate
  was then changed to `Schema.is(RpcClientError)`. No checker was rerun, so this
  source correction is **unverified by the quality workflows**.
- Focused server tests: all 23 passed across six files. Focused browser tests:
  all 11 passed across three files. The focused artifact-copy regression passed
  all three tests. The requested web unit command timed out after 120 seconds
  with SIGTERM and no Vitest output or test counts; it was not retried. The
  previously observed initial-deadline test therefore remains unverified in
  this final pass, without weakening assertions or durations.
- The fresh unsigned `0.1.613-beta.9999` arm64 directory build passed. Its
  framework links remained relative and readable after staging cleanup. It
  included the post-typecheck predicate correction, but a build is not a
  substitute for the missing checker results.
- The isolated packaged-app smoke passed in 720,008 ms. It asserted packaged
  identity and an isolated realpath profile, used disabled providers, recovered
  both forced disconnects without another reload, and retained no blocking
  connection surface. Config requests: 3; snapshots: 3; failures: 0; defects: 0.
  Twelve process-tree samples each measured nine owned processes. RSS ranged
  from 763,776 to 1,083,552 KiB, starting at 1,083,552 KiB and ending at
  768,912 KiB. These aggregate samples are not a general leak certification.
- Smoke report:
  `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/bigbud-connection-smoke-ZFLGbz/connection-smoke.json`.
  Fresh executable:
  `/private/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode/bigbud-connection-validation/artifacts-pass2/mac-arm64/bigbud Beta.app/Contents/MacOS/bigbud Beta`.
- Both permitted fixer passes are exhausted. No full test suite, checker retry,
  installed-app modification, commit, or push was performed. Only evidence
  documentation changed after the fresh build. **Overall validation remains
  incomplete** because typechecking and web unit verification did not pass.
  The successful 12-minute smoke exceeds the reported 10-minute interval, but
  does not certify two hours or overnight operation or identify the historical
  invalid config field.
