# Native family source extension

Source target: OpenCode **v2.0.26**, immutable commit
`9b4ec5714d481559990db0a816d5dec19541a814`. This matches bigbud's pinned
client/native ABI; no SDK dependency or stock-runtime qualification was upgraded.

`../opencode@2.0.26-native-family-v1.patch` is a source contribution, not a package
manager patch or an installed binary. Apply with `git apply --check` then
`git apply` in a clean checkout at that commit. Install source dependencies with
scripts disabled for local source tests. Regenerate the source stamp with
`bun run packages/core/script/family-source.ts` from the native checkout root.
The extension is plugin-only (`ctx.session.family`), using the existing signed
plugin RPC bridge; there are no invented HTTP routes or handwritten generated clients.

`ledger.mjs`, `receipt-shared.mjs` and `family.receipt.mjs` are generated from the pure native ledger/receipt modules by
`bun run scripts/native-family/export-source-patch.ts <native-source-checkout>`
from bigbud. It exists solely for deterministic scripted source-unit integration
tests. It does not initialize OpenCode, an SDK host, a server, a provider or native
configuration. `manifest.json` records hashes, **not native qualification**.

Source-location banners are normalized to native repository-relative `// packages/...`
paths at the generator output boundary. For existing checked-in modules, run
`bun run scripts/native-family/normalize-artifacts.ts` from bigbud. This repo-only
command first verifies the exact inventory and current module/source-patch hashes,
then normalizes banners and refreshes module hashes. It never accesses a native
checkout or changes the source digest, patch hash or qualification claims.

Each generated code file is limited to 400 lines; receipt logic is split at its native
source boundary, not hand-edited after generation. Export refreshes the native source
stamp and hashes every compiled module as well as the portable patch.

Native-private KV stores family generations and admission origins. A completion
origin commits in the same transaction as its synthetic inbox admission. Public
synthetic requests cannot supply the native transaction proof. Plugin owner,
root, ancestry, native call, job generation and exact notification ID are checked.
Cancellation keeps a permanent native-reserved identity/tombstone. Public APIs
cannot reuse the notification ID after removal, and a canonical payload digest
binds a receipt to the actual pending/projected body, including after recovery.
Stop fences first, cancels only owned sessions/jobs/notifications, and reports
uncertainty rather than inferring physical settlement from model idle or HTTP ack.
Terminal consumption commits with terminal lifecycle publication: historical receipts
remain readable but cannot authorize another model execution. Native pending counts
close only after job acknowledgement. Captured synchronous coordinator guards reject
late wakes across Stop/rearm. Managed-family recovery resumes admitted history without
an unproven generic synthetic restart prompt; uncertain recovery records remain durable.
Shell jobs are enumerated by native recovery ownership, not session IDs or opaque
metadata. Root, child and nested shell job scopes must physically terminate before
acknowledgement; failed termination and journal acknowledgements remain recoverable
obligations. Scoped creation-to-job handoff and late creation acknowledgement cleanup
cover the pre-registration gap while permission waits remain interruptible.
Startup also retains managed **running** shell records without a cancellation marker:
server death, model idle and a synthetic restart notice are not physical termination
proof. Deleted ancestry is checked against the native-private ownership inventory;
unreadable ownership retains uncertainty without aborting unrelated shell recovery.
bigbud keeps the corresponding fence, admission, guard and binding quarantine after
native server exit, publishing an error with retained Stop authority rather than exit.

Per-session native pending counts and callback scopes let an independently drained
child complete while siblings keep family-wide activation/Stop exclusion. The normal
session-state stream carries `retainedFamily`; migration 135 and the SQL repository,
projector, full/mobile/operational queries and assembly now persist and hydrate it.
An idle root with an unconfirmed spawn or recovery state keeps Stop without a
fabricated child card or a fabricated running root turn. The regression fixtures
`ProjectionSnapshotQuery.family.fixture.ts` / `.test.ts` and
`mappers.family.sql.test.ts` use actual SQLite projection-to-snapshot reads followed
by the production browser mapper and primary composer rendering. They cover absent
legacy defaults, true-to-false clearing and cardless Stop visibility. These new
follow-up regressions passed the parent's scoped fixer and independent source
re-review; the earlier mapper-only test did not prove SQL hydration.

bigbud's physical-drain proof is separate from inspection counts and starts unknown
on attachment. Only an exact stopped/settled native barrier for the current
root/input/generation can establish it; admission, dispatch and executable callbacks
invalidate it. Cached zero, no child cards, an old proof or reconnect cannot retire
authority. Host loss retains admission, guard, binding quarantine and canonical Stop
even when the previously published retained flag was false. The final independent
security review marked the cached-zero finding **RESOLVED**, source-only.

Operator follow-up remains required: independently approved native isolation,
native build and race/recovery qualification of this exact source/artifact/plugin
stack. The release registry remains empty. Do not launch the patched runtime on
the developer host or publish it without separate authorization.

## Validation status

Parent-reported completed batches (not rerun or summed by the repository build pass):

| Scope                                           | Result                               | Evidence boundary                                      |
| ----------------------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| Restart/shell native source regressions         | 16 passed                            | Historical source-unit run, no native host/model       |
| Server restart/loss/SQL corrections             | 29 passed                            | Scoped repository fixtures                             |
| SQL snapshot → browser mapper/composer          | 1 passed                             | Actual SQLite projection/hydration, scripted rendering |
| Settlement fixture corrections                  | 3 passed                             | Deterministic retained reservation regression          |
| Final cached-zero physical-authority correction | 22 passed; 13 intentionally excluded | Focused selection, not qualification                   |

These batches can overlap; they are not an aggregate test count. Parent independent
source/security/requirements re-review closed the reported findings. Exact runtime
qualification remains unperformed. Earlier broad format/typecheck/test results in the
[evidence ledger](../../docs/validation/opencode-v2-subagent-evidence-2026-10-16.md)
are historical, not a fresh whole-workspace green claim for the concurrent worktree.

## Historical source-check recipe

From the native checkout's `packages/core` directory:

```sh
bun run test test/native-family-*.test.ts test/session-run-coordinator.test.ts test/session-execution*.test.ts test/tool-subagent.test.ts test/job.test.ts test/session-owned.test.ts test/plugin/identity.test.ts test/plugin/command.test.ts test/plugin/promise-tool.test.ts test/plugin/session-compact.test.ts test/plugin/session-remove.test.ts
bun typecheck
```

Before the restart/SQL follow-up, the test command passed 141 source-unit/regression tests across 23 bounded files.
`bun typecheck` also passed in native `packages/plugin` and
`packages/server`; scoped native Prettier and oxlint checks passed. Source patch
application is checked on pristine baseline files and all changed/new files
matched the isolated source checkout byte-for-byte.
The subsequent parent-scoped validation above includes
`test/native-family-restart.shell.test.ts` and the real SQL hydration regressions.
The recipe is retained for separately authorized source maintenance; the current
repository-only completion does not access, modify, build or test an external checkout.

The exporter rejects every materially edited/new native source/test exceeding 400
lines, as well as every oversized generated fixture module. Contracts, scoped
registries, plugin domains/adapters, inbox projection/admission and execution tests
are split at their source concern boundaries, not hidden or minified.

bigbud's format/lint, bounded server/UI/browser checks and scoped typechecks are
recorded separately from full-workspace checks: concurrent terminal work can block
the latter and must not be patched or hidden by this contribution.
These are source/scripted/browser checks, **not native executable evidence**.
Independent source review is complete for the reported findings. Isolated runtime
qualification is the remaining external prerequisite; local builds neither perform it
nor enable the gated production capability or change an installed app.
