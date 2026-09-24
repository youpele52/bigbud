# Local investigation: remote agent 0.2.205 → 0.2.207

## Status

Latest investigation: see **Isolated coexistence and the access-contract decision**
below. Actual legacy/candidate Linux binaries prove that separate state roots
preserve the old running operation and its reconnect route, but that sending the
same operation to the candidate can execute it twice. No runtime isolation or
generation routing fix has been implemented. The remaining clarification is the
user-visible access contract for legacy work, not permission to add another lock.

Partial fix only. The unsafe legacy rollback probe is prevented. The stale-history
takeover refusal is reproduced but is **not resolved** by this patch. Do not treat
this change as certification that affected installations can upgrade successfully.

The subsequent implementation work below adds read-only journal validation, not
the complete reviewed takeover/activation transaction. The earlier investigation
and its validation results are retained as historical provenance.

## Isolation and source provenance

- No SSH or VPS access, release operations, or real supervisor state access.
- Linux aarch64 in a dedicated Docker container using `rust:1.95-bookworm`.
- Legacy source extracted with `git archive v0.2.205 Cargo.toml Cargo.lock crates protocol`;
  relevant files also inspected using `git show`, without replacing worktree files.
- Candidate source at `1d02e44cd0`; `git diff v0.2.207 -- crates/bigbud-remote-agent`
  was empty. Built with version `0.2.207` and a fixture build digest.
- Legacy binary built with version `0.2.205` and a fixture build digest. These are
  source-built debug fixtures, not downloaded release artifacts.
- All spawned supervisors used private fixture directories via
  `BIGBUD_AGENT_STATE_DIR`. Only fixture processes received signals.

## Reproduction and observations

1. Start the actual legacy binary with `--supervisor` in fresh private state.
2. Run candidate `--check`, then `--prepare-supervisor` against the same fixture.
3. Repeat in a second fresh state directory, first creating a journal using the
   **legacy** `OperationJournal` writer. Append `Accepted` and `Started` for one
   operation, without launching a process or appending `Completed`.
4. On refusal, run the legacy binary with `--prepare-supervisor`, stdin at EOF,
   reproducing the old rollback invocation. Compare epoch and journal and repeat.

| Fixture                             | Candidate check | Candidate preparation         | Legacy rollback probe                         |
| ----------------------------------- | --------------- | ----------------------------- | --------------------------------------------- |
| Fresh idle supervisor               | Pass            | Exit 10, old supervisor exits | Not needed                                    |
| Restored unfinished acceptance      | Pass            | Exit 11                       | Exit 0, epoch changes; supervisor stays alive |
| Same restored state, second attempt | Pass            | Exit 11 again                 | Epoch changes again                           |

Exit 11 printed:

> remote agent upgrade is blocked by active terminals or process operations; close them and retry

This proves a problematic historical-state path, **not** a universal failure of
every 0.2.205 installation. It does not establish which state exists on the user's
VPSs. No production journal or exact deployed release binary was examined.

## Verified mechanisms and remaining hypotheses

- Legacy `session/mod.rs` restores journal records, then calls
  `expire_non_terminal`. `operations.registry.rs` records `Expired` /
  `AGENT_RESTARTED` in memory only. The unchanged journal still contains unmatched
  acceptance records, which the candidate's inspector treats as active.
- Legacy `main.rs` recognizes `--check`, `--supervisor`, and `--proxy`, but not
  `--prepare-supervisor`. Its default branch creates a stateful stdio session;
  `AgentState::open` rotates the epoch before reading stdin. EOF is not protection.
- Expired retention is skipped during legacy restoration. Its contribution to
  this incident remains a source-supported hypothesis; the executed stale fixture
  deliberately had no retention record.
- The candidate maps inspection errors to busy using `unwrap_or(true)`. This is
  verified in source, but no inspection-error fixture was needed for the reproduced
  exit 11. This patch does not change that diagnostic behavior.
- The guard first appears in release 0.2.206, after commit `d2d91daf1c`.

## Applied correction

Rollback preparation first uses the supported, stateless `--check`. A recognized
0.2.205 binary is not invoked with the unsupported flag. Recovery fails explicitly
with a manual-verification message instead of reporting false success and mutating
the epoch. The original candidate failure is retained alongside the recovery error.
Other versions continue through the existing preparation path; this is not a
general capability-negotiation implementation.

Two executions of the patched shell command against the actual legacy Linux binary
returned exit 1 with epoch and journal bytes unchanged.

## Validation

- Regression test failed before the fix: expected `live-supervisor-epoch`, received
  `rotated`. It passes after the fix and checks repeated attempts.
- Targeted Vitest: 23 passed, 3 skipped (existing platform-gated tests), across
  supervisor, transaction, install-manager, and artifact tests.
- Linux `cargo test --locked -p bigbud-remote-agent prepare`: 6 passed, including
  preservation of active PTYs, worker children, and accepted-before-spawn work.
  An initial overly-specific filter selected zero tests; the corrected filter above
  is the actual validation run.
- `bun fmt`, `bun lint`, and `bun typecheck` passed. Lint emitted unrelated existing
  warnings. No repository Rust source was changed.

## Safety boundary and follow-up decision

Do not clear journals, ignore retention-expired acceptances, or infer safety solely
from the absence of children. An accepted operation may not have spawned yet.
Legitimate active terminals/processes must finish or be explicitly closed by their
owner before takeover.

Resolving stale legacy history requires a separately verified migration/reconciliation
path, or operator-controlled maintenance after all work is confirmed stopped, with
original state preserved for recovery. This investigation did not establish such a
procedure and does not authorize remote intervention. Whether to build that migration
is the outstanding scope decision; the primary stale-history upgrade failure remains
open.

## Reviewed implementation follow-up (2026-09-06)

The user supplied the independent review from `ses_f8772a2e3ffeAwrs4lDYnX4WRO`.
That review resolves the former Draft/approval prerequisite; no further approval
or delegation is required before implementation. The earlier statement that the
migration scope is undecided is superseded. The complete migration is in scope.

### Changes implemented so far

- `validate_journal_read_only` separates structural validation from the
  `has_unmatched_acceptances` result. An unmatched acceptance is still treated
  conservatively by the existing preparer; no stale-history bypass was added.
- Inspection uses read-only, no-follow, nonblocking opens on Unix, validates the
  opened file's ownership/type/permissions/size and inode, and checks for observed
  replacement or mutation. This is **not** a substitute for a pinned private
  directory and frozen, authenticated process in the future takeover controller.
- The complete-record decoder is reused without journal recovery, truncation, or
  repair. Noncanonical records and orphan records are rejected. Started/completed
  state, output ordering, acknowledgements, and compacted output suffixes are
  checked in a separate relationship-validation module. Expiry is not used as a
  runtime liveness decision.
- Preparation now propagates inspection errors instead of converting them to an
  active-work refusal. The existing destructor-only resume and takeover design
  are **not** made interrupt-safe by this change.
- Four additional journal tests cover orphan records, retention-history
  interpretation, compacted output, and unsafe files. The existing truncated-tail
  test now explicitly asserts byte preservation. Six inspector tests pass.

### Fresh evidence

- Actual `v0.2.205` resolves to
  `461b7865cd28bb2570d9f580405fa53daee7b51f`.
- `git archive v0.2.205 Cargo.toml Cargo.lock crates protocol` was piped into
  the isolated `bigbud-upgrade-reviewed-legacy-fixture` Docker container using
  `rust:1.95-bookworm` on Linux aarch64. With
  `BIGBUD_AGENT_BUILD_VERSION=0.2.205` and the legacy source commit as the build
  digest, `cargo build --manifest-path /tmp/legacy/Cargo.toml --locked --release
--package bigbud-remote-agent` passed. Source and compiled output remain in that
  stopped container. Live fixture identity and the full upgrade matrix have not
  been reverified in this follow-up.
- Read-only `gh release view v0.2.205 --repo youpele52/bigbud --json tagName,assets`
  confirmed both Linux agent artifacts and the two manifests are available.
  Their signatures and bytes have not been downloaded/validated in this follow-up;
  this lookup is not production binary authentication.
- `bun fmt`, `bun lint`, and `bun typecheck` passed. Lint reported four existing
  warnings and existing oversized-test warnings outside this change.
- `bun run test --filter=@bigbud/server -- src/remote-agent` passed: 231 tests,
  nine platform-gated skips, 37 passing files and one skipped file. This includes
  connection/pool/lifecycle, process reconnect, PTY, watch, install manager,
  transaction, finalization, integrity, cancellation, and supervisor suites.
  The six shell activation tests and three artifact shell tests were skipped on
  macOS; their Linux execution remains required.
- `cargo fmt --all --check`,
  `cargo clippy --locked --workspace --all-targets -- -D warnings`, and
  `cargo test --locked --workspace` passed locally after removing two uses of
  `unreachable!` rejected by the repository's Clippy policy.
- Linux aarch64 workspace Clippy and tests passed in
  `bigbud-upgrade-reviewed-linux-checks`, with the workspace mounted read-only and
  `CARGO_TARGET_DIR=/tmp/target`. Remote-agent unit results were 87 passed and one
  pre-existing ignored bind-mount test requiring elevated mount capability. The
  six Linux preparer tests ran rather than being platform-skipped. This is
  existing regression coverage, **not** the new guardian/activation fault matrix.

### Outstanding implementation checklist

- [ ] Authenticated recognized legacy binary provenance and pinned process/private
      state/socket identity, with only the justified 0.2.205/0.1.0 exception.
- [ ] Owned-client admission lease fencing acquisition, reconnect, in-flight
      creation, and existing-client sends; lifetime-aware idle draining.
- [ ] Closed probe, bounded cleanup, whole-group stop, stable singleton task set,
      no live children, and read-only journal inspection under that proof.
- [ ] Independent ready guardian with serialized resume/kill authority, pidfd-only
      signalling, stopped-process SIGKILL, death confirmation, and interruption
      tests. No SIGCONT-to-deliver-SIGTERM.
- [ ] New staged controller owning the complete activation lock and durable,
      versioned transaction state; no inherited lock in a long-lived supervisor.
- [ ] Gated candidate startup and a gate before every dispatch, with admission
      opening only after the exact durable commit.
- [ ] Phase-driven recovery preserving untouched baseline identity or starting
      the verified legacy baseline only with supported flags after a real stop;
      committed candidates must never undergo destructive rollback.
- [ ] Capability-compatible proxy startup, consistent state paths, and bounded
      verification/recovery without invoking legacy preparation flags.
- [ ] Actual legacy fresh/stale/retention-expired upgrade success and the complete
      workload, identity, corruption, interruption, concurrency, lost-response,
      candidate-admission, and recovery-phase regression matrix.
- [ ] Linux x86_64 coverage, Linux shell activation tests, and final independent
      review. The work so far does not establish either completion gate for the
      complete requested upgrade.

No external technical blocker has been established. The unchecked items above
are unfinished implementation and verification, not a request for another design
approval. No SSH/VPS access, commits, pushes, tags, or publication occurred.

## Subsequent actual-legacy ownership-race reproduction

The preceding no-blocker statement describes the earlier implementation attempt.
The following experiment establishes a concurrency-contract issue that must be
resolved before treating the supervisor singleton proof as exclusive state
ownership. It does not invalidate that proof for work owned by the supervisor.

Using the saved release-mode source-built legacy fixture, an isolated Linux
aarch64 experiment performed these steps:

1. Started a legacy supervisor in a fresh private fixture state directory.
2. Completed a supported hello, verified live version `0.1.0`, build digest
   `461b7865cd28bb2570d9f580405fa53daee7b51f`, and the on-disk epoch, then closed the
   probe and waited for its handler to leave.
3. Held the private `activation.lock` with an exclusive flock.
4. Opened a pidfd for the owned fixture child, sent SIGSTOP through that pidfd, and
   verified the complete task set was exactly the stopped leader with no children.
5. Launched the actual legacy `--prepare-supervisor` with EOF, as an old recovery
   invocation would. It returned zero and changed the epoch despite the lock and
   frozen supervisor.
6. Launched a separate supported legacy stdio session against the same state root.
   It handshook, opened a fixture workspace, and executed a shell process that
   appended one marker line and slept for two seconds. While it was running, the
   journal contained its new operation and the original supervisor was still
   exactly one stopped task with no children.
7. Allowed the stdio operation to complete normally, verified exactly one marker
   line and a successful exit, then resumed and cleaned up only the owned idle
   supervisor. No production or unrelated processes were signalled.

The corrected harness was run three consecutive times with networking disabled;
all three runs reported:

```json
{
  "activation_lock_held": true,
  "unsupported_prepare_exit": 0,
  "epoch_changed_while_baseline_frozen": true,
  "journal_changed_while_baseline_frozen": true,
  "separate_stdio_operation_executed": true,
  "separate_stdio_exit": 0
}
```

The initial harness omitted the required client instance ID and therefore did not
execute the process request. It was corrected to send a valid hello and verify the
actual AgentHello before the three successful reproductions above.

The source-built binary and 207-line, standard-library-only reproduction script
are retained under the approved temporary directory:

- `legacy-reviewed-0.2.205`
- `legacy-owner-race.py`

The directory is
`/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/opencode`.
The invocation mounts it read-only at `/fixtures` in `rust:1.95-bookworm` and runs:

```sh
python3 /fixtures/legacy-owner-race.py /fixtures/legacy-reviewed-0.2.205
```

### Exact unresolved concurrency boundary

An observed conflicting stdio owner can be refused, as required by the review.
However, a scan, pidfd, frozen listener, advisory activation lock, and fencing the
new application's owned connection pool cannot prevent an independent legacy
stdio launcher from starting after that scan. Old recovery invocations and direct
legacy stdio launchers do not participate in either fence. This experiment proves
that they can mutate the shared state and execute separate work while the proposed
supervisor-local proof remains true. It does not claim that a revised controller
could not detect the specific mutation if it occurred before its last inspection.

The necessary decision is whether automatic activation may require that independent
legacy stdio/recovery launchers are quiesced for the transaction, while still
refusing observed conflicting owners and supporting concurrent cooperative new
installers. If uncoordinated new legacy stdio launches must also be supported during
activation, an enforceable launch/state-ownership fence outside the unmodified
legacy process is required. Merely adding another scan or ignoring the journal
would not supply that guarantee. No such external fencing mechanism is currently
part of the approved implementation or permissions.

## Isolated coexistence and the access-contract decision

### Research findings

The shared-state takeover is not the only architectural option. The following
distinctions matter:

- `remoteAgentInstall.ts:87-108` already installs immutable binaries under
  `bin/<version>/<artifact-sha256>/bigbud-remote-agent`. It does **not** give those
  builds separate runtime state: `stateRoot` remains `.bigbud/agent/state`.
- Both actual legacy and candidate binaries support `BIGBUD_AGENT_STATE_DIR`.
  Their supervisor and proxy use the socket under that root. This gives a
  supported, non-destructive coexistence mechanism for ordinary independent
  legacy launchers, which keep using their original default root. It is not a
  security sandbox against a same-UID process deliberately pointed at the new
  directory. Neither an executable hash nor an advisory lock creates that sandbox.
- Do not rename the legacy state directory, replace its socket, rotate its epoch,
  copy its journal into a live candidate, or replace the legacy `bin/current`
  discovery link as part of this transition. Independent old callers can use
  those paths after the candidate starts. They must continue to reach the old
  runtime rather than accidentally opening a fresh legacy runtime or reaching a
  new journal without their operation identities.
- The current shell preparer hardcodes the default socket/log, despite the Rust
  binary's state-directory override. A production isolation patch must pass one
  explicit runtime descriptor consistently through installation, health,
  preparation, supervisor startup, proxy startup, retry, and recovery.
- Pool entries are keyed only by target. `remoteAgentServerLayer.ts:262` closes
  that entry after installation. Process/PTY reconnect closures at
  `remoteAgentConnectionPool.ts:72-83` resolve the target again, not their original
  generation. A new directory plus the existing pool invalidation is not safe.
- `remoteAgentProcessClient.ts:146-160` attaches after a lost acceptance and can
  resubmit when attachment reports an unknown operation. A fresh candidate
  journal cannot provide the original generation's deduplication. The current
  lifecycle's epoch check is not sufficient after `pool.close` deletes the entry.
- A compatible raw `--proxy` can reach the original live legacy supervisor without
  invoking `--prepare-supervisor`. Calling the unsupported flag remains unsafe.
- The actual legacy `protocol/remote-agent/v1.proto` has attach-by-ID but no
  operation/PTY inventory or runtime-migration RPC. The actual legacy
  `session/pty_handlers.rs` stores PTY IDs/handles in memory and requires the ID to
  attach. Journal preservation alone cannot let a new app discover arbitrary
  live terminals belonging to an independent legacy client. Live stdio sessions
  also do not expose a separate attach listener; their original transport is
  their supported access route. These are limits of the released contract, not
  missing candidate implementation effort.

### New real-binary Linux evidence

Built the exact candidate source from
`1d02e44cd090cc0e2bce25a2cca1a88442e4873e`, using `git archive` into a dedicated
`rust:1.95-bookworm` Linux aarch64 container named
`bigbud-upgrade-isolation-proof`. Release build passed with fixture version
`0.2.207` and the source commit as a diagnostic build digest. Reused the actual
source-built legacy fixture from `461b7865cd28bb2570d9f580405fa53daee7b51f`.
Neither source digest is cryptographic authentication of a published artifact.

Three corrected, network-disabled executions of `legacy-isolation-proof.py`:

1. Started the actual legacy supervisor and a real process that writes a marker,
   emits output, sleeps, then completes. Closed its first client connection.
2. Prepared and started the actual candidate in a separate private state root.
   Preparation returned 10; candidate hello reported `0.2.207` and its expected
   fixture build digest. Legacy epoch and journal bytes were unchanged by that
   candidate startup.
3. Reconnected to the old socket. Its epoch was unchanged and attach reported the
   old operation as `running`; its result subsequently completed successfully.
4. Attached to that same operation ID through the candidate. It returned
   `process replay failed: operation is unknown or expired`.
5. Deliberately modeled the existing unknown-acceptance resubmission branch in
   this disposable fixture: opened the same workspace on the candidate and sent
   the same operation ID and digest. The candidate accepted it as new. Both
   operations completed successfully and the marker contained **two** executions.

This is a wire-level reproduction of the cross-journal deduplication hazard,
not an assertion that a complete TypeScript application trace was executed.
The first harness attempt used the wrong attach frame tag and was rejected with
`MISSING_WORKSPACE_HANDLE`; after checking the owning protobuf schema, the tags
were corrected before the three successful runs.

The original frozen-singleton/independent-stdio ownership harness was also rerun
successfully in this session. It again changed epoch/journal under the held
activation lock while the owned supervisor was exactly one stopped task without
children. The independent operation executed once and exited successfully.

New proof artifacts in the approved temporary directory (not staged):

- `candidate-reviewed-0.2.207`: exact candidate source-built Linux fixture.
- `legacy-isolation-proof.py`: bounded, owned-process-only reproduction, under
  400 lines; imports wire helpers from `legacy-owner-race.py` beside it.

Invocation, with that directory mounted read-only at `/fixtures`:

```sh
python3 /fixtures/legacy-isolation-proof.py \
  /fixtures/legacy-reviewed-0.2.205 /fixtures/candidate-reviewed-0.2.207
```

### The precise product decision

Does “old live work remains accessible” mean:

1. **Coexistence with original-owner access:** old work remains running and
   accessible through its original client/runtime, including reconnect to its
   original supervisor by known operation/PTY ID. The upgraded app uses a new
   isolated runtime for new work. It must visibly identify retained legacy work
   rather than imply that a new runtime imported it.
2. **Transparent import into the upgraded app:** the upgraded app must discover
   and present arbitrary pre-existing work, including independent clients' live
   PTYs and stateful stdio work whose IDs/transports it never owned.

Recommend (1), with generation-pinned reconnects for every client the upgraded
server itself owns. This is not permission to abandon known work or to replay
unknown acceptances. It also does not mean “save the journal and tell the user to
kill everything.” Original endpoints and processes must remain usable.

Option (2) cannot be guaranteed by the released legacy API alone. It requires
cooperation from the originating clients to hand over resource identities and,
for stdio, continued access to the original transport; otherwise an explicit
maintenance/access contract is required. No process scan or journal scan can
manufacture the missing supported PTY inventory/transport handoff. A larger
candidate-only transaction controller does not resolve this distinction.

The user has already authorized technical implementation and review. This asks
only which user-visible continuity contract is required; it is not a request to
choose a lock, approve a large rewrite, or relax preservation of accepted work.
Until that is explicit, do not label a fresh candidate runtime as a transparent
upgrade of all retained legacy work.

### Concrete implementation plan for recommended coexistence

This supersedes the earlier speculative destructive-takeover checklist as the
recommended direction, not as completed implementation:

1. Add a validated runtime descriptor: immutable binary identity, explicit
   private state root, socket location, and generation. Reuse existing signed
   artifact verification and immutable install paths. Keep legacy default state
   and discovery untouched. Use a separately namespaced selector for new clients;
   pin connections to the resolved descriptor, never a mutable selector.
2. Separate publication of the new default from lifecycle of existing runtimes.
   Serialize cooperative publication in new control state. Start and validate the
   candidate in its own state before publishing; retry the exact same generation
   rather than generating another empty journal. Recover selector publication
   without preparing/stopping the legacy runtime. Never stop an admitted
   candidate or delete its journal merely because finalization acknowledgement
   was lost; reconcile durable publication state.
3. Key pool lifecycles and reconnects by generation. Retain old entries while
   operation, PTY, watcher, workspace, or in-flight creation clients refer to them.
   New admission uses the published default; existing clients, cancellation,
   attach, output acknowledgement, and retries stay on their original descriptor.
   Do not use `pool.close(target)` to switch runtime generations. When the original
   runtime cannot establish continuity, report outcome unknown, never resubmit
   into the newly selected generation.
4. Support the recognized legacy endpoint using supported `--check` and raw
   `--proxy`, with narrow check/live version handling only for the known legacy
   identity. Do not equate reported build digest with authenticated artifact
   provenance. Do not automatically restart an absent legacy supervisor as though
   live PTYs could be restored from its process journal.
5. Preserve old runtime access explicitly under the selected product contract.
   No automatic journal import, expiry reconciliation, process kill, or legacy
   garbage collection is part of candidate activation. Separate operator-owned
   retirement can be designed later; it must not be disguised as rollback.
6. Require real legacy fresh/stale/retention-expired coexistence, live PTY and
   process completion/reconnect, accepted-before-spawn pinning, independent stdio
   and old recovery launchers before/during/after publication, and old-client
   discovery tests. Candidate startup must not modify old epoch/journal/socket.
7. Require candidate-start failure, simultaneous installers, interrupted
   publication, lost success responses, retry after candidate admission, failed
   original-generation attach, and same-ID tests proving exactly one side effect.
   New connection creation racing publication must resolve one pinned generation
   for workspace and operation creation, not a mixture.
8. Run Linux shell integration, both supported Linux architectures, Bun formatting,
   lint/typecheck/Vitest, Rust formatting/Clippy/workspace tests, and independent
   review. Existing green inspector/preparer tests do not certify this design.

No production runtime source was changed during this investigation. The inherited
journal validation and rollback guard remain partial fixes. The real-binary
coexistence proof is evidence for an architecture and its access limitation, not
the requested complete deployed upgrade/fault-matrix certification.

### Checks rerun for this investigation

- `bun fmt`, `bun lint`, and `bun typecheck`: passed. Lint retained four unrelated
  warnings and existing oversized-test warnings.
- `bun run test --filter=@bigbud/server -- src/remote-agent`: 231 passed, nine
  platform-gated skips (37 passing files, one skipped file).
- `cargo fmt --all --check`,
  `cargo clippy --locked --workspace --all-targets -- -D warnings`, and
  `cargo test --locked --workspace`: passed on the local macOS host. This run
  does not exercise the Linux-only preparer tests.
- `git diff --check`: passed; index remained empty. No fixture containers remained
  running at the end. No SSH/VPS, commits, pushes, tags, or publication.

The new experiment does not establish stale-history upgrade success, pre-spawn
isolation, publication rollback/retry correctness, or Linux x86_64 certification.
Those remain implementation gates, not claims implied by these passing checks.
