# OpenCode V2 native-family execution prerequisites

The separately versioned `bigbud.native-subagents.v1.<issuer>` guard does not modify
the frozen `bigbud.thread.v2` bootstrap. Production preparation and activation-gated
publication are wired, but the release qualification registry remains empty. Offline
fixtures execute the emitted guard with the production broker, pinned HTTP client,
and SQLite; they are not native qualification or runner approval.

The repository integration and portable source contribution are implemented. Parent
targeted validation and final independent source/security re-review closed the reported
admission, shell/restart, SQL hydration, per-child closure and cached-zero drain-authority
findings. This is source acceptance, not executable qualification. See the
[current evidence ledger](../validation/opencode-v2-subagent-evidence-2026-10-16.md#current-disposition--repository-source-2026-10-21)
for separate, non-additive validation batches and the remaining external boundary.

## Exact background-completion boundary

Pinned immutable native sources:

- [subagent-completion.ts, v2.0.26](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/subagent-completion.ts):
  `deliver` supplies private `Job.Info.notificationID` as the synthetic message ID,
  followed by `jobs.completeBackground(notificationID)`.
- [subagent-job.ts, v2.0.26](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/session/subagent-job.ts):
  continuation notification deduplication uses child ID plus `started_at`, obtained
  from internal `Job.Service`. Child ID alone does not identify a completion generation.
- [public Promise session API, v2.0.26](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/plugin/src/promise/session.ts)
  and [prompt admission semantics](https://opencode.ai/v2/docs/build/plugins):
  the prompt hook runs for user prompts, not synthetic messages. Model context hooks
  are not BEFORE-synthetic-admission hooks.

The primitive missing from the stock runtime is an authenticated BEFORE-synthetic-admission receipt binding
the exact notification/message/inbox ID to the enrolled child, native tool call,
continuation generation, and owning root generation, with cancellation fencing.
Public observed IDs and caller-supplied `metadata.source`/`childID` do not prove that
binding. No invented notification endpoint or inferred receipt is accepted.

Consequently stock-runtime production rejects background spawn before child creation and rejects
synthetic model contexts. The approved custom extension below supplies a separate,
exactly qualified path, not a toggle enabling stock runtimes. Foreground spawning, permission ceilings, exact child
interaction routing, Stop, explicit user rearming, and durable ownership are separate
implemented paths. A background model becoming idle does not settle its continuation
obligation; uncertain spawn/enrollment obligations retain activation exclusion.
The pinned [subagent executor](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool/plugin/subagent.ts)
can also receive `backgrounded` from `jobs.block` for a foreground request. The
emitted wrapper records an exact call-bound executor result; `running` retains a
durable continuation obligation. Stop still attempts native interruption, but
cannot label an unresolved executor/job obligation physically settled solely from
child model idle. Such uncertainty prevents rearming until trustworthy cancellation
evidence, rather than silently clearing the obligation. Native host exit is not
detached-shell termination proof and cannot release retained family authority.

## Approved native source extension (local source evidence only)

The source contribution is persisted at
`patches/opencode@2.0.26-native-family-v1.patch`, based on immutable commit
`9b4ec5714d481559990db0a816d5dec19541a814` (v2.0.26). No dependency upgrade,
public HTTP endpoint, generated client edit, or replacement subagent executor is required.
The first-class plugin API is `ctx.session.family`, ABI `opencode.native-family.v1`;
bigbud transports it through the existing signed plugin RPC boundary.

- Native-private KV owns exact root/owner generations and call/job/notification bindings.
  Admission provenance commits with inbox admission, before a synthetic notification can wake execution.
  Public metadata and same-ID synthetic collisions cannot create provenance.
  Native-reserved IDs survive cancellation/removal permanently; cancellation tombstones
  and immutable payload digests prevent cancel/re-admit or recovery from authenticating
  a replacement body with an old unconsumed receipt.
- Stop authenticates ownership, installs a generation fence, then cancels/drains exact owned
  root/descendant jobs, queued input, notifications and interactions. Read/write or acknowledgement
  uncertainty is retained, not inferred away from idle status.
  Shell jobs use their actual native shell/job IDs and recovery-owned session identity,
  including idle-root/child/nested background and implicit-background work. Job scope
  closure waits for physical process-scope termination, and failed termination/acknowledgement
  records cannot be retired as ordinary cancellation. Creation-to-job handoff also owns
  cleanup until registration; permission waits remain interruptible.
- Captured generation guards run synchronously at the coordinator's wake/start/drain boundaries,
  including delayed wakeups across Stop and explicit new-user rearming.
- Native terminal receipt consumption commits with terminal lifecycle publication. Consumed receipts
  remain queryable for historical projection but cannot authorize another model execution.
  Durable job acknowledgement, not admission or idle, closes the native pending obligation.
- Managed-family restart resumes admitted history without the generic synthetic restart prompt,
  which has no native completion receipt. Ordinary native session recovery is unchanged.
  Unreadable recovery records are retained; only positive owner/generation retirement evidence
  retires notifications. A fenced completion cannot abort recovery of unrelated records.
  Managed running-shell records survive startup even without a cancellation marker;
  deleted ancestry is checked against native-private ownership instead of being treated
  as shell termination.
- Native per-session obligations/callback scopes determine individual child closure;
  siblings still hold whole-family activation and cancellation authority. Canonical
  `session.state.changed.retainedFamily` projects through normal session snapshots and UI
  hydration independently of child cards. Pending spawn/recovery uncertainty keeps Stop
  accessible without presenting an idle root as working or targeting its completed turn.
- Physical-drain authority starts unknown on each attachment and is independent of cached
  inspection counts. Only an exact stopped/settled native barrier for the current
  root/input/generation can establish it. New admission, dispatch or executable callbacks
  invalidate it; old proof and reconnect cannot release a newer generation. Host loss
  retains admission, guard and canonical Stop even with no child cards, cached zero pending
  counts and a previously false session flag. Migration 135 and the production full/mobile/
  operational query paths preserve this control state through SQL snapshot hydration.

The reproducible export script and hash manifest in `patches/opencode-native-family-v1/`
include only a compiled **pure ledger/receipt** for scripted tests. These tests also exercise
the emitted guard, authenticated HTTP broker and SQLite; native source-unit tests exercise
actual in-memory admission/terminal transactions and coordinator behavior. None launches a
native application, provider or model, and none constitutes native/runtime qualification.
No source-only result populates either release qualification registry.

## Policy and qualification

The actual emitted guard uses public Promise `tool.transform`, `permission.hook`,
`session.hook`, `storage`, and `rpc.register`. Permission evaluation is mutable and
registration-ordered; public hook presence alone does not prove a final exclusive
clamp. Release qualification must establish the pinned executor's BEFORE-prompt
ordering, final-clamp/plugin-stack guarantees, native admission fences, and exact
artifact/source identity. Arbitrary callback booleans and synthetic fixture records
cannot enable the default production composition. An independently approved isolated
native runner and reviewed release evidence remain prerequisites; none was provisioned.
The custom path additionally requires the exact extension ABI and source digest in the reviewed
native and family qualification records, matching the runtime's capability response.
