# TypeScript Command Gateway

**Date:** 27 August, 2026  
**Status:** completion-gate implementation in the shared worktree; clean aggregate
validation rerun pending

## Decision and invariant

Make the existing TypeScript orchestration path an explicit command gateway for
canonical project and thread mutations. This is a consolidation and hardening
of existing behavior, not a new domain service.

```text
client -> TypeScript gateway -> canonical SQLite commit -> committed events
                                                        -> Rust delivery -> UI ACK
```

TypeScript alone owns command decoding and authorization, stable identity,
bounded admission, ordering and fences, domain decisions, canonical SQLite
transactions, receipts/outcomes, and canonical event history. Rust owns only
bounded delivery of already committed events, replay/reconnect, consumer
generations and fencing, backpressure, and application ACK.

Rust must not accept, queue, journal, validate, or decide project/thread
commands. There is no Rust command queue, command journal, canonical database,
or second domain model in this plan.

## Evidence snapshot

The current worktree contains substantial uncommitted implementation. Preserve
it and re-check these findings at the start of each phase.

### Completion-gate update — 27 August, 2026

Focused regressions now cover the six recovery gaps that were open in this
snapshot:

- command receipts atomically bind a versioned normalized-command digest;
  legacy unbound receipts conflict conservatively, while a stored accepted
  outcome remains authoritative;
- operational preparation and persistence failures remain unknown/retryable,
  and terminal rejection is returned only after its receipt is read back;
- bootstrap recipes and client draft state persist recovery identities, and
  physical Git tests cover response loss, restart, partial success, and
  overlapping retries;
- canonical replay is paged past 1,000 events, gaps fence live delivery, and
  the TypeScript supervisor buffer is capped before explicit snapshot recovery;
- the UI ACK boundary requires the exact contiguous applied and
  ownership-reconciled cursor; defer, partial application, and recovery failure
  cannot advance it; and
- general reactors use a one-slot conflated wake-up backed by canonical SQLite
  replay. Delivery capture remains bounded with explicit overflow recovery.

The focused server, web, and shared suites pass, as do formatting, lint, and
typechecking. The full `bun run test` attempt is not clean evidence yet: current
concurrent provider-capability expectations failed, one Claude MCP test timed
out, and the run later exhausted the shared volume (`ENOSPC`, 181 MiB free).
Rerun the aggregate suite on a clean, adequately provisioned worktree before
marking the broader gateway program complete.

### Implemented

- `CommandAdmission.ts` bounds the orchestration queue at 256 (one slot
  reserved for internal work), bounds startup readiness at 128, returns typed
  retryable overload/deadline errors, and records queue metrics.
- `OrchestrationEngine.ts` uses one global serialized command lane and applies
  preparation and deletion fences before decision processing.
- `OrchestrationEngine.commandProcessing.ts` checks durable receipts, appends
  events, applies projections, and stores an accepted receipt inside one SQLite
  transaction. It updates the read model and publishes only after commit.
- `OrchestrationCommandReceipts.ts`, `OrchestrationEngine.commandOutcome.ts`,
  and the RPC contract provide durable accepted/rejected/unknown lookup by the
  original command ID. Rejection persistence is read back before a rejection is
  returned.
- Desktop and mobile RPC ingress normalize client commands before dispatch.
  Bootstrap child commands use deterministic IDs, a cross-transport lock, and
  durable outcome lookup. Local existing-branch worktrees derive a stable path
  from the parent command identity, project path, and branch.
- The web command-recovery ledger persists command payloads before dispatch,
  reuses IDs, queries outcomes after transport failure, and waits for canonical
  events before clearing accepted attempts. Project/thread create, rename,
  delete, archive, and important chat actions use this helper.
- The desktop supervisor has bounded TypeScript input/output channels, bounded
  Rust queues, generations, stale-generation fencing, ACK timeouts, fallback,
  and active-session/tombstone limits.
- Web delivery application is serialized. `applyAndAcknowledgeDeliveryBatch`
  ACKs only after event application and canonical ownership reconciliation;
  failures prevent the ACK call. Delivery is currently one event per batch.
- `readReplay` returns retained-range metadata, explicit gap/complete status,
  and at most 1,000 events. Storage reads use fixed 500-row pages.

### Partial or unsafe

- The public boundary is distributed across `wsRpcContext.ts`, RPC/mobile
  handlers, bootstrap/shell dispatch, `Normalizer.ts`, and engine dispatch.
  Internal reactors and tools call the engine directly. There is no gateway
  facade, actor/source context, or enforceable ingress inventory.
- WebSocket authentication exists at connection setup, but evidence is still
  required for operation-level project/thread/workspace authorization across
  desktop, mobile, automation, and internal callers.
- Bootstrap Git recovery is covered for local physical worktrees and response
  loss, but the side-effect recipe is not durably bound server-side before Git
  execution. Remote targets and caller-supplied/generated branch identity need
  equivalent evidence.
- Rejection receipts are durably confirmed, but the worker converts every
  command-state preparation failure into an invariant error. Hydration or
  persistence failures can therefore be cached incorrectly as deterministic
  rejection.
- Delivery capture uses a bounded dropping queue with explicit overflow, but
  the general domain-event `PubSub` is unbounded. The ordered merge also keeps
  an unbounded `pendingBySequence` map while waiting for a missing sequence.
- The UI applies and reconciles before ACK, but the ACK helper trusts the batch
  tail. Contiguous application is currently implied by one-event supervisor
  batches and recovery state rather than represented by a single verified
  applied cursor at the ACK boundary.

### Missing completion gates

1. Receipts have no canonical payload digest. Same-ID/different-command reuse
   returns the old outcome instead of a typed conflict, and receipt lookup plus
   digest comparison is not an atomic storage operation.
2. Replay is not paged end to end. The supervisor treats an available but
   incomplete 1,000-event page as recovery failure. In fallback mode it can
   then consume live input; gap checks are enforced only on the supervisor
   route, so a live event can bridge an unresolved replay gap.
3. There is no composed proof covering all six completion gates across command
   ingress, SQLite, publication, supervisor restart/fallback, UI application,
   and ACK.

## Gateway contract

Create a small Effect service under `apps/server/src/command-gateway/` using the
repository's `CommandGateway`/`CommandGatewayLive` convention. Reuse
`ClientOrchestrationCommand` and `OrchestrationCommand`; do not create a parallel
command schema.

The input must contain the transport command and an authenticated request
context with actor, source (`desktop`, `mobile`, `automation`, `provider`,
`startup`, or other explicit internal source), and authorization scope. The
terminal result remains the existing `{ sequence }` or typed dispatch error.
Outcome lookup remains a query by command ID.

The gateway sequence is:

1. Decode transport input and establish stable command ID.
2. Canonically normalize once, then calculate its versioned payload digest.
3. Authenticate/authorize the requested aggregate and operation.
4. Carry `(command_id, payload_digest)` through bounded startup and
   orchestration admission.
5. In the serialized lane, atomically claim/inspect that identity and recheck
   lifecycle, ownership, and deletion invariants.
6. Commit events, required projections, and accepted outcome atomically.
7. Publish only committed sequences; provider/runtime reactions remain after
   commit and outside the SQLite transaction.

An accepted receipt means commit, never queue admission. Overload, deadline,
hydration, SQLite, filesystem, Git, timeout, transport, and publication failure
remain retryable or unknown unless a receipt proves the terminal outcome. Only
schema/authorization errors and deterministic domain invariants may be rejected.

## Operation classification

The inventory must classify every mutation as one of:

- canonical project/thread command through the gateway;
- authorized infrastructure operation with its own bounded lifecycle; or
- post-commit provider/runtime reaction caused by canonical state.

Canonical scope includes project create/update/reconfigure/delete; thread
create/meta/update/rename/archive/delete/fork; turn/session queue/start/stop/
interrupt; approval and user-input resolution; model/runtime/interaction
settings; canonical automation and retention mutations; and corresponding
internal/provider lifecycle events.

Explicitly audit shell/terminal, Git, workspace files, browser/computer use,
remote-agent operations, automation scheduling, and retention. For example,
`thread.shell.run` currently branches to `wsShellDispatch`; its canonical
activity events belong through the gateway, while process execution does not
belong inside the canonical transaction.

## Implementation phases

### Phase 0 — Freeze the evidence and ingress matrix

**Scope/owners:** `apps/server/src/ws/`, `orchestration-tools/`, `retention/`,
provider ingestion/reactors, automation handlers, mobile RPC, persistence
projection repositories, and web mutation call sites.

**Deliverables:** a checked-in gateway inventory (in the implementation PR or
adjacent design document) listing command type, caller/source, normalization,
authorization, stable-ID origin, admission lane, fences, side effects, recovery
helper, and any permitted direct projection/migration write. Add characterization
tests for every distinct path before moving it.

**Failure invariant:** observation only; no behavior changes. Unknown paths are
blockers, not silently classified commands.

**Tests/exit:** static searches for engine dispatch and project/thread SQL are
reconciled with the matrix; desktop, mobile, automation, retention, provider,
startup, and tools have named owners. Record current focused test results.

**Rollback/compatibility:** none. This phase is prerequisite to all others.

### Phase 1 — Bind command ID to canonical payload atomically

**Scope/owners:** command contracts/canonicalizer,
`OrchestrationCommandReceipts` service/layer, a new SQLite migration,
`OrchestrationEngine.commandProcessing.ts`, outcome/RPC error schemas.

**Deliverables:** a versioned canonical serializer and SHA-256 digest; non-null
digest on new receipts; transactional repository operation that inserts a claim
or compares the stored digest; typed `command_id_conflict` for mismatched reuse;
compatible handling/backfill for legacy rows. Digest includes command type,
aggregate identity, and every semantic normalized field, excluding transport
metadata only by an explicit versioned rule.

**Failure invariant:** equal ID+digest may return the stored outcome; unequal
digest never executes or overwrites a receipt. Digest/claim storage failure is
unknown/retryable, not rejection.

**Tests/exit:** same ID/same payload before and after restart; same ID with
changed aggregate, bootstrap recipe, attachment, or timestamp; concurrent
conflicting claims; migration from legacy accepted/rejected rows; SQLite fault
between claim, event append, projection, and receipt. All conflicts are typed
and no conflicting canonical event is appended.

**Rollback/compatibility:** deploy readers tolerant of legacy null/version
first, backfill where reconstructable, then require digests for new dispatches.
Do not infer a digest from an outcome alone.

### Phase 2 — Correct terminal-outcome classification

**Scope/owners:** `OrchestrationEngine.prepareCommandState.ts`, `preflight.ts`,
`commandProcessing.ts`, orchestration errors, deletion/ownership fences, and
`wsDispatchCommandError.ts`.

**Deliverables:** a closed typed split between deterministic rejection and
operational failure; preserve original hydration/persistence errors; persist a
rejection only for enumerated schema/authorization/domain codes; atomically
confirm its digest and receipt before returning it. Keep unknown outcome lookup
by the original ID.

**Failure invariant:** timeout, interruption, SQLite, hydration, filesystem,
Git, provider, and publication failures cannot poison an ID with `rejected`.
An accepted receipt wins a race with rejection confirmation.

**Tests/exit:** fault-inject each operational class before decision, during the
transaction, after commit/before response, and during rejection persistence;
restart and retry using the same ID. Only enumerated invariant failures remain
rejected; unconfirmed outcomes report retryable/unknown.

**Rollback/compatibility:** retain existing RPC envelopes and map new typed
codes additively. Do not rewrite historical receipts automatically.

### Phase 3 — Persist external Git side-effect identity before execution

**Prerequisites:** Phases 1–2.

**Scope/owners:** `wsBootstrap.ts`, `.identity.ts`, `.worktree.ts`, command
recovery persistence/contracts, remote Git execution, project/thread creation
callers.

**Deliverables:** persist a command-owned bootstrap recipe before Git work,
including execution target, canonical project identity/path, base/generated
branch, deterministic worktree path, and recipe version. Retries load and verify
that recipe; they never recalculate from changed caller input or adopt an
unrelated checkout. Commit canonical thread metadata with deterministic child
IDs after the physical resource is confirmed.

**Failure invariant:** response loss or restart before/after Git creation always
addresses the same branch/worktree. Ambiguous discovery remains unknown and
requires recovery; it never creates another resource or deterministically
rejects the parent.

**Tests/exit:** real-Git local tests plus remote-adapter contract tests for loss
before create response, after create/before metadata commit, restart, concurrent
desktop/mobile retry, changed-payload conflict, existing branch collision, and
canonical-path mismatch. One command produces at most one physical identity.

**Rollback/compatibility:** read legacy bootstrap attempts through the current
recovery path; only new attempts require recipes. No destructive cleanup of
ambiguous legacy worktrees.

### Phase 4 — Bound every TypeScript publication boundary

**Scope/owners:** `OrchestrationEngine.domainEvents.ts`, `.deliveryHub.ts`,
`wsStreams.ts`, `wsOrchestrationDelivery.ts`, and every subscriber to the
general domain stream.

**Deliverables:** replace unbounded `PubSub` and unbounded pending maps with
explicit capacities. Delivery publication should be a conflated bounded wake-up
or a bounded capture whose overflow emits a typed recoverable gap and resumes
from SQLite. Document capacity, overflow response, metric, and recovery owner
for every publisher/subscriber. Slow non-delivery consumers must not block the
canonical transaction or retain canonical history in memory.

**Failure invariant:** publication occurs after commit; overflow cannot erase
canonical SQLite history, silently drop a sequence, grow without bound, or turn
an accepted command into rejection.

**Tests/exit:** saturate each subscriber independently while commands commit;
assert bounded memory/depth, overflow metric/lifecycle signal, replay from the
last contiguous sequence, and no blocked command worker. Static search finds no
unreviewed unbounded queue/PubSub/pending sequence collection on this path.

**Rollback/compatibility:** preserve event/RPC schemas where possible; add gap
signals additively. Controlled direct delivery fallback remains supported.

### Phase 5 — Page replay and forbid live gap bridging

**Prerequisites:** Phase 4 bounds and canonical replay metadata.

**Scope/owners:** event-store replay contract, `wsOrchestrationDelivery.ts`,
`DesktopSupervisorDelivery.session.ts`, Rust supervisor state/queue, web
recovery coordinator, and delivery contracts.

**Deliverables:** define page cursor/limit/target sequence; fetch pages until
the captured target is contiguous and complete; buffer live input only within a
declared bound while replaying; then re-check and drain in sequence. An
incomplete page is continuation, not gap. A real retention/internal gap fences
the route and triggers bounded snapshot recovery. Apply identical sequence
checks to supervisor and fallback routes.

**Failure invariant:** neither supervisor nor fallback emits sequence N while
any sequence between the applied cursor and N is unresolved. Page failure,
restart, or live overflow resumes from the last application-ACKed sequence.

**Tests/exit:** replay more than 1,000 events and multiple storage pages; inject
live events between every page, supervisor restart mid-page, fallback mid-gap,
retention gap, and subscriber saturation. Observed batches are strictly
contiguous without duplicates being applied or live bridging.

**Rollback/compatibility:** version replay fields additively and retain the
current one-page RPC during a compatibility window. Never fall back to unsafe
live delivery when either endpoint lacks paged-replay support.

### Phase 6 — Expose the gateway and prove application ACK

**Prerequisites:** Phases 0–5; introduce the facade last so it exposes corrected
semantics rather than preserving known holes.

**Scope/owners:** new `command-gateway/` service, `wsRpcContext.ts`, desktop/
mobile/automation handlers, internal tools/reactors/retention, web ACK cursor,
and composed server-supervisor-web harnesses.

**Deliverables:** thin transport adapters call the gateway with authenticated
actor/source context; internal callers use the same facade or an explicitly
documented post-commit reaction API. ACK input is derived from a verified
highest-contiguous applied cursor advanced only after all application and
ownership reconciliation succeeds, not from the received batch tail.

**Failure invariant:** no canonical project/thread mutation bypasses digest,
authorization, bounded admission, fences, transaction, and outcome rules. UI
application/reconciliation failure freezes ACK advancement and starts recovery.

**Tests/exit:** boundary tests reject an unauthorized/bypass caller; composed
fault tests cover application failure before ACK, ownership failure, response
loss, duplicate/conflicting IDs, SQLite failure, publication saturation, paged
replay with concurrent live events, supervisor restart/fallback, and stale
generation ACK. Static inventory has no unexplained bypass, and traces link
actor/source, ID/digest, aggregate, queue wait, outcome, and sequence range.

**Rollback/compatibility:** migrate callers in small groups behind one facade
without changing successful response shapes. Keep one serialized lane. Remove
old adapters only after inventory and fault tests prove parity.

## Global exit criteria

All six completion gates in `RUST_SYSTEMS_CORE.md` pass as composed tests: ACK
through the highest contiguous applied/reconciled sequence; fully paged replay
without live bridging; persisted deterministic Git identities; operational
failures never cached as rejection and durable rejection confirmation; bounds
and explicit overflow for every async TypeScript boundary; and atomic
ID+payload-digest conflict detection.

Also require queue/overflow/unknown/conflict metrics, command-to-delivery trace
correlation, `bun fmt`, `bun lint`, `bun typecheck`, and focused/all tests through
`bun run test` (never `bun test`). Rust changes additionally require the checks
in `crates/AGENTS.md`.

## Non-goals

- Moving command validation, ordering, receipts, outcomes, SQLite, or canonical
  history to Rust.
- Adding a Rust command ingress queue/journal or accepting commands while the
  TypeScript backend is unavailable.
- Rewriting the orchestration decider, event model, provider adapters, or
  delivery supervisor.
- Putting provider, Git, terminal, browser, remote-agent, or setup-script waits
  inside a SQLite transaction.
- Aggregate-parallel command processing before measurements and cross-aggregate
  conflict tests justify it.
- Synthetic percentage progress for terminal CRUD commands or cleanup of
  ambiguous legacy external resources.
