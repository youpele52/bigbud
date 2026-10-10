# OpenCode V2 owned deletion and tombstones

**Status: Draft — non-destructive persistence design specified; native-removal safety dependency unresolved.**

This implements the design investigation required by Phase E of the [completion plan](./2026-10-08-opencode-v2-preview-completion-plan.md). D7 already authorizes safe explicit owned deletion; another product approval is not required for that goal. This document does **not** authorize blanket profile/database/directory deletion, automatic resends, retention expiry, or Rust changes. Preserve exact 2.0.26 and all original AC1–AC8/D1–D8.

## Verified boundaries

- `EntityPurge.ts` collects resources before canonical dependent deletion and seals claims transactionally. `EntityPurge.claims.ts` rejects active durable activity and binds identity/digest. `EntityPurge.sql.activity.ts` includes unresolved provider admissions; a logical provider stop is not quiescence proof. `EntityPurge.admissions.test.ts` already races dispatch against purge claims.
- `ProviderTurnAdmissions.owner.ts` fences deleted/deleting projections, deletion markers, sealed purge manifests and deleted ancestors. `find` remains available after deletion; `reserve`/dispatch reject. Existing terminal compaction is lossless, not expiry. Do not add cascade deletion of admission or tool-receipt rows.
- Current purge resource kinds are filesystem resources. A native session is **not** a filesystem path resource. Do not encode it as a provider log or extend `removeWithoutFollowingSymlinks` to remove native database contents.
- Native release tag `v2.0.26` resolves to `9b4ec5714d481559990db0a816d5dec19541a814`. `packages/core/src/session.ts:367–376` gets the parent, interrupts and awaits idle, closes transport, lists `parentID` children, recursively removes them, clears environment, publishes deletion and removes durable native events. There is no expected-child-set/owner/generation conditional DELETE in the exact protocol.
- **Fork is not parentID ownership.** `packages/core/src/session/projector.ts:156–172` writes `parent_id: null`, retaining `fork_session_id` separately. Live documentation calling a fork a child is not the pinned storage contract. Independently created canonical bigbud children are likewise parentless native sessions.
- `Runtime.deletion.contract.native.test.ts` exercises a disposable parent, true `parentID` child, native fork and separate canonical-style child. It checks actual recursive deletion versus independent retention. It is test-only removal, not application integration clearance.

## Persistence slice (implementation specification)

Use existing SQLite migration registration and dot-concern module layout. Add `OpencodeV2NativeOwners` service/live implementation, with no dependency on the SDK's Effect services. Native API calls remain Promise-only.

### Owner registry

Persist one immutable row per `(storage_identity, native_session_id)` **before** an owner can send. Record runtime target, profile identity, native Location/project, canonical owner thread, native creation intent/result, ownership proof version and created time. Include zero-turn sessions; deriving ownership only from admissions is insufficient. Reject conflicting bindings transactionally. Existing sessions lacking exact retained proof remain inspectable/retained, never adopted for deletion from a title or deterministic ID alone.

Add durable cleanup rows keyed by `(storage_identity, native_session_id, canonical_deletion_event_id)`. Record exact owner, canonical deletion proof/digest, purge job, tombstone time, immutable captured native identity, revision and outcome. States: `retained`, `tombstoned`, `blocked`, `remove-intent`, `removed`. `blocked` includes structured reason; transport uncertainty after `remove-intent` is never reset to `tombstoned` by a timer. Preserve these rows indefinitely with the admission replay index.

### Canonical integration

1. Only an explicit committed canonical deletion proof can tombstone an owner. Stop, archive, interruption, application shutdown and ordinary retention maintenance cannot call native removal or create removal authorization.
2. Capture the native owner registry row into a separate provider-cleanup manifest before canonical rows disappear. Reuse sealed `EntityPurge` proof/claim ordering; do not make native cleanup depend on a later projection lookup. Avoid introducing a filesystem resource alias.
3. A transaction verifies the exact canonical deletion proof, owner binding, sealed purge job and absence of unresolved admissions/activity leases, then writes `tombstoned`. Competing dispatch must lose through existing `assertOwnerAvailable`/transactional claim fences. Independent canonical child owners are not included in a parent's cleanup manifest.
4. Canonical deletion may finish logically with provider cleanup **pending**, but must not mark native cleanup physically successful. Surface the precise retained/blocked reason in the existing cleanup result/recovery path. Parent history cleanup cannot authorize deletion of an independently owned child.

## Destructive gate — not ready for implementation

The executor must hold the exact runtime namespace mutation queue and durable purge lease, reauthorize the exact configuration/owner/generation/deletion proof after every awaited read, prove native execution and durable admissions quiescent, and synchronously revalidate dispatch. These guards alone are **not** a recursive-tree ownership lock.

The safe first implementation must reject every native `parentID` descendant rather than recursively remove an unproven subtree. A direct-child query with limit one can detect non-leaf ownership without unbounded traversal. Native forks and parentless canonical children are outside the recursive tree and must remain untouched.

**Unresolved dependency:** the pinned API cannot atomically assert "this exact owned session has no parentID children" at deletion. A child can be created after inventory and before/inside DELETE. Private authenticated HTTP and a single bigbud queue serialize bigbud callers, but are not proof against another native producer/plugin or a native command using the profile. Full access is host-user trust, not enforced containment. A PID exit alone does not prove every external writer is excluded. Therefore read-empty-then-DELETE is insufficient to claim no independent history removal.

Before native-removal implementation, provide either an upstream conditional/tree-ownership deletion primitive compatible with the exact pin, or an enforceable exclusive native storage/tree-mutation fence that covers **all** producers without changing the agreed trust model. Do not invent direct SQLite mutation, rewrite child parents, kill unrelated processes, or use broad directory removal. Until then write `blocked` and retain native history. This is a concrete SDK/ownership dependency, not a request to reapprove D7.

## Settlement and restart

- Persist `remove-intent` before any external call. Observe raw settlement; an acknowledgement timeout is not absence proof. Namespace quarantine has no TTL release.
- Successful native removal must be verified by typed NotFound for the exact ID under the same storage/Location generation, not by treating every GET error as absent. A profile mismatch, transport failure or restarted generation cannot discharge uncertainty.
- After a lost acknowledgement, recovery performs **read-only** exact-ID reconciliation. Confirmed absence can mark `removed`; confirmed presence remains pending until prior raw mutation settlement and the destructive preconditions are proven. Do not blindly resend DELETE: recursive cleanup can have partially completed while the parent survives.
- Retain owner/cleanup tombstones, admission fingerprints/results and tool invocation receipts even after confirmed deletion. Old requests reject through canonical owner fences, never recreate a native session or resend. Manual cleanup cannot repurpose the old owner identity.

## Required validation before design/implementation green

1. Zero-turn owner registration, conflicting owner IDs, historical unproven sessions and config/storage identity changes.
2. Real canonical deletion → sealed claim → durable provider tombstone; concurrent send/create/learning versus deletion and restart after canonical projection removal.
3. Native parentID descendant **created between inventory and dispatch** rejects without deletion; independent canonical child and native fork remain usable with history intact. This needs the missing atomic/exclusive primitive.
4. Native partial recursive failure, lost acknowledgement, raw settlement after deadline, read-only restart reconciliation, typed NotFound versus transport error, and no uncertain-owner expiry.
5. Terminal and unresolved admissions, tool receipts and completed learning memory applications retained after cleanup; old request replay rejects without acquisition.
6. Stop/archive/shutdown produce zero removal calls. Failed native cleanup remains pending; only exact verified removal marks physical cleanup done.

Fresh planner delegation was unavailable (`Subagent depth limit reached (1)`). This is direct design work, not independently accepted `Ready for implementation` clearance. The blocked destructive gate must be resolved before implementing native deletion; independent Phase A/C/D work is unaffected.
