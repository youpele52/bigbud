# Mobile Recovery Correctness Plan

**Date:** 9 September, 2026  
**Status:** Proposed  
**Owner:** Planner agent; implementation owner unassigned

## Summary

All three recovery issues from the review of the [mobile adaptation plan](2026-09-06-mobile-floaty-chat-adaptation-plan.md) remain unresolved at commit `8e59bfe746d299e85dc3ebecb1ed56acefffcb0c`. The inspection started from a clean worktree. Recent work provides reusable replay and overflow protections, but the mobile path does not connect them to a consistent baseline or an explicit completion signal.

Add a targeted mobile baseline and a bounded recovery stream. Mobile should preserve cached conversation content during recovery and report current data only after applying the server's explicit catch-up boundary. This plan replaces the original plan's Phase 2.4 specification; its other phases remain separate work. Creating this document does not implement those changes.

## Related Work

- [Original mobile adaptation plan](2026-09-06-mobile-floaty-chat-adaptation-plan.md), Phase 2.4, lines 518–535: source of the three review findings and surrounding mobile lifecycle requirements.
- [Plan authoring guide](_plan-authoring-guide--do-not-delete.md): required planning and validation structure.
- `docs/CONTEXT.md`: mobile remains Direct Unmanaged Delivery, outside the Desktop Delivery Supervisor.
- Recent relevant commits: `64008345b4` (durable cleanup and orchestration recovery), `aa3dc4d370` (canonical dispatch and recovery), and `bc6f06c9bf` (unified deletion pipeline). Their protections must be preserved.
- Stable notes/cards: none identified. The coordinating agent attempted both note and Kanban discovery; both tools returned `dynamic tool request failed`. No issue or PR was supplied. Link a matching existing reference when discovery becomes available; do not invent one.

## Problem

1. **Global hydration remains.** Mobile loads and decodes the full projection snapshot before trimming it, including when requesting one thread. A small mobile response therefore does not imply small server work. The user's previously reported approximately 16 GB macOS database and incomplete full snapshots make this a practical recovery risk; those performance symptoms were not reproduced during this review.
2. **Replay can wait indefinitely at a missing sequence.** The mobile stream ignores the supplied cursor, collects one replay result into memory, and waits for consecutive sequence numbers. The concrete engine limits that read to 1,000 events; the issue is not currently an unlimited event count, but missing pagination/completion metadata and gap handling. Canonical deletion can intentionally remove event sequences. The existing pending-map cap catches overflow, but a gap followed by one event can remain below that cap indefinitely.
3. **Recovery completion is undefined.** Mobile consumes batch events only. It cannot prove the baseline-to-live handoff completed when no events arrive, nor distinguish an idle replay from a stalled one. An open socket or successful baseline read is insufficient evidence of catch-up.

## Goals

- Fetch mobile data without hydrating unrelated full thread history.
- Return summary data, optional selected-thread data, and a trustworthy projection cursor from one consistent read.
- Recover baseline-to-subscription races with bounded, gap-aware replay and live capture.
- Emit and consume an explicit completion boundary, including zero-event recovery.
- Preserve drafts and cached content across retry, cancellation, expiry, and failed refresh.
- Preserve existing desktop delivery behavior and mobile command restrictions.

## Non-Goals

- Implement the original plan's layout, navigation, composer, send correction, or comprehensive connection redesign.
- Import desktop delivery supervision, acknowledgements, leases, or its consumer lifecycle into mobile.
- Change canonical deletion semantics, compact history, repair user databases, or add retention jobs.
- Redesign authorization or implement automatic command resubmission.
- Add Rust changes or perform commits/pushes.
- Promise constant memory for arbitrarily large selected-thread histories or all-project metadata. This plan bounds recovery queues and avoids unrelated history; selected-history pagination requires a separate product/API decision if measurements demand it.

## Current State

Line references describe the inspected commit and should be refreshed during implementation.

| Concern                        | Current evidence                                                                                                                                                                              | Assessment                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Mobile baseline hydration      | `apps/server/src/ws/ws.mobile.ts:44–83` calls `getSnapshot()` for both summary and selected thread                                                                                            | Unresolved                                                                               |
| Existing consistency boundary  | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts:26–35` wraps full assembly in a SQL transaction                                                                              | Already present; retain for targeted queries                                             |
| Full assembly                  | `apps/server/src/orchestration/Layers/ProjectionSnapshotQueryAssembly.ts:60–172` reads messages, activities, tasks, sessions, checkpoints, plans, and watches globally                        | Response trimming does not avoid this work                                               |
| Projection cursor              | `apps/server/src/orchestration/Layers/ProjectionSnapshotQueryAssembly.snapshot.ts:67–87,365` derives the minimum required projector sequence                                                  | Must verify exact-baseline semantics rather than substitute an event-store tip           |
| Mobile retention semantics     | `apps/server/src/mobile/mobileSnapshot.trim.ts:10–105` retains four messages, all approval/user-input activities, latest-turn activities/plans, active threads, and no checkpoints/watches    | Targeted SQL must preserve these semantics, including terminal approval/question records |
| Cursor ignored                 | `apps/server/src/ws/ws.mobile.ts:156–190` accepts `appliedSequence` but does not pass it to the stream helper                                                                                 | Unresolved                                                                               |
| Collected replay and gap wait  | `apps/server/src/ws/wsStreams.ts:63–72,99–153` uses `Stream.runCollect(readEvents(...))` and a consecutive pending map                                                                        | Pending cap exists; bounded gap-aware recovery does not                                  |
| Gap-aware replay foundation    | `apps/server/src/persistence/Layers/OrchestrationEventStore.ts:278–357` implements bounded `readReplay(cursor, limit)` with `availability`, `latestSequence`, and `complete`                  | Reusable; mobile's separate replay RPC calls it, but its subscription does not           |
| Sparse-gap protection          | Same replay implementation checks `orchestration_event_gaps` through the observed tip and suppresses replay on a gap                                                                          | Preserve; do not bridge deleted history using live events                                |
| Live capture foundation        | `apps/server/src/orchestration/Services/OrchestrationEngine.ts:72–76` exposes optional engine-owned bounded capture; `wsStreams.ts:39–60` supports capture/overflow paths                     | Existing mobile call does not opt into nonblocking capture                               |
| Client discards control frames | `apps/mobile-web/src/lib/mobileRpc.ts:75–78` subscribes with `{}` and ignores non-batch items                                                                                                 | No completion contract consumed                                                          |
| Cache application ownership    | `apps/mobile-web/src/hooks/useMobileOrchestrationSync.ts:12–38` and `apps/mobile-web/src/logic/mobileOrchestrationSync.logic.ts:46–198` apply/coalesce events independently of baseline reads | Recovery must fence baseline and event ownership                                         |
| Recovery RPC absent            | `packages/contracts/src/server/rpc.mobile.ts:17–29` exposes existing reads/subscriptions only                                                                                                 | Additive protocol required                                                               |

The concrete `readEvents` delegates to `eventStore.readFromSequence` (`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:227–228`), whose default limit is 1,000 (`apps/server/src/persistence/Layers/OrchestrationEventStore.ts:27,226–275`). Extending the helper with an old baseline cursor without adding pagination could therefore truncate a backlog.

Existing tests already cover capture during replay, pending overflow, canonical replay failure, and trailing deletion gaps. Passing them does not establish the missing mobile recovery guarantees.

## Phases

### Phase 1: Establish the targeted baseline and additive contract

**Dependency:** None. Independently safe to ship as unused mobile endpoints.

**Scope:** Add focused modules such as `ProjectionSnapshotQuery.mobile.ts`, `.mobile.sql.ts`, `.mobile.assembly.ts`, `ws.mobile.recovery.ts`, and mobile recovery contract schemas under `packages/contracts/src/server/`. Reuse row decoding and assembly utilities through direct imports. Extend existing service wiring narrowly; split any materially edited source/test file exceeding 400 lines.

1. Add a mobile recovery read accepting an optional selected thread ID. Return the current mobile summary shape, selected thread or explicit missing/deleted result, and `snapshotSequence`. Preserve archived selected-thread behavior supported by existing reads.
2. Query active summaries and only their required preview data; query full history only for the selected thread. Push selection/order/limits into SQL. Avoid loading global history and then filtering in JavaScript; avoid one independent transaction or RPC per thread.
3. Preserve all existing mobile fields, deterministic ordering, pending and terminal approval/question evidence, current-turn plans, tasks, session state, and deletion filtering. Reuse the current trim implementation as a fixture parity oracle, not as the production full-hydration path. Do not silently cap approval history and resurrect an already-resolved request.
4. Read selected thread, summaries, and projector state within one SQL transaction. Investigate whether projector rows and their watermarks commit atomically at one sequence. A minimum watermark alone does not prove that ahead-of-watermark rows are safe for non-idempotent replay. Prove the invariant with concurrent-write tests; if it fails, establish a common projection publication barrier before exposing recovery. Do not guess a cursor from the engine/event-store tip.
5. Add mobile-specific recovery RPC and stream schemas while retaining existing endpoints. Use a versioned stream union with `batch`, `caught-up`, and `resync-required`; associate frames with one client recovery attempt ID echoed by the server. `caught-up` includes `throughSequence`; resync includes a bounded reason such as gap, overflow, unavailable, invalid cursor, or timeout.
6. Reject invalid/future cursors explicitly. Obtain a fresh baseline on each new transport generation, including server restart, instead of persisting sequence-only replay assumptions across restarts. Reuse a canonical instance/revision token if existing infrastructure requires it to fence in-process replacement; do not reuse the literal `mobile-direct` as proof of identity.
7. Keep these endpoints behind the existing authenticated mobile route. Do not enlarge the command allowlist, attachment access, or scope claims. Baseline reads carry existing attachment metadata only; they must not fetch file contents.

**Tests:** Targeted/full-trim parity fixtures; missing/deleted/archived selection; concurrent event/projector writes; schema bounds and compatibility; no unrelated full-history query/decode.

**Exit:** Baseline consistency is demonstrated and unrelated history hydration is absent. New endpoints remain unused by older clients; no persisted-state change is necessary unless the query-plan gate justifies an index.

### Phase 2: Implement bounded mobile replay and live handoff

**Dependency:** Phase 1's cursor and frame invariants proven.

**Scope:** Implement a focused mobile recovery stream module, e.g. `ws.mobile.recovery.stream.ts`. Keep the existing ordered helper's default behavior and desktop callers unchanged. Extract genuinely shared capture utilities where needed; do not duplicate canonical replay policy.

1. Register an engine-owned nonblocking bounded live capture **before** the first replay read. Verify subscription readiness, not an assumed scheduling delay. Overflow must fail this recovery attempt without blocking engine dispatch. Production should require this capture capability; any test/fallback implementation must provide equivalent guarantees.
2. Call `readReplay(baselineSequence, explicitPageLimit)`. On the first available page, fix watermark `W = latestSequence`. Reject a cursor beyond `W`. Read subsequent pages from the last verified sequence until reaching `W`, emitting bounded batches with ordering and deduplication. Do not collect the full replay or chase a moving tip indefinitely.
3. Preserve the existing conservative gap policy: `readReplay` checks gaps up to its observed tip, so a later gap beyond `W` may invalidate the attempt. Accept that safe rebaseline behavior initially. Do not silently narrow gap checks or advance across deletion holes. A bounded-through persistence API is a later optimization only if measured rebaseline starvation justifies it and deletion tests prove equivalence.
4. Deduplicate live/replay overlap by sequence and verify consistent event identity. Check capture overflow before publishing completion. Emit `caught-up(W)` after all events through `W` have been emitted in order; emit it even when the baseline already equals `W` and no event batches exist. Then drain live events above `W` in order. The marker proves only catch-up through `W`, not absence of later commits.
5. On a live sequence discontinuity, perform bounded canonical replay verification immediately. If the canonical record is unavailable, gapped, or cannot close the discontinuity within the recovery deadline, send `resync-required` and terminate. A single post-gap event must trigger resolution without waiting for another event or buffer overflow. Never use live capture to override a canonical gap result.
6. Set explicit page, serialized-byte, capture, pending, total-replay, and deadline limits with documented constants. Start with a 500-event page and at most 2,000 pending/captured events as provisional count budgets; measure payload sizes before fixing byte/time budgets. Oversized single events fail recovery explicitly rather than bypassing memory limits. Bound client queues too.
7. On any overflow, replay error, cancellation, disconnect, authorization expiry, or deadline, release capture and scoped fibers. Where a control frame cannot be delivered because the transport failed, client termination handling must still mark recovery incomplete. Coalesce retries with bounded backoff; never spin on repeated gaps or stale projector baselines.

**Tests:** Baseline/subscription race; replay exceeding the existing 1,000-event default cap; multi-page replay under continuing writes; overlap deduplication; zero events; known sparse gap; unrecorded discontinuity; missing sequence plus one event; trailing gap with no subsequent events; replay failure; capture/pending/byte overflow; slow consumer; cancellation and reconnect storms.

**Exit:** Every attempt reaches one verified completion boundary or an explicit bounded failure. Engine dispatch remains responsive under a stalled mobile consumer. Desktop stream regression tests retain their existing expectations.

### Phase 3: Consume recovery evidence through one mobile owner

**Dependency:** Phases 1–2 server integration tests pass. Integrate with the original plan's lifecycle ownership in Phase 2.1–2.3; if that work has not landed, implement only the minimal cancellable generation owner needed here.

**Scope:** `mobileRpc.ts`, `useMobileSnapshot.ts`, `useMobileThread.ts`, `useMobileOrchestrationSync.ts`, and focused mobile recovery/controller modules.

1. Own baseline loading, subscription, cache application, and freshness in one controller. Fence callbacks by session/backend identity, client generation, recovery attempt, and selected-thread generation. A stale HTTP/RPC completion must not overwrite newer event-applied data.
2. Install the baseline atomically before applying replay. Validate every frame's attempt identity; validate sequence progression before UI coalescing. Flush queued/coalesced event applications through `W` before accepting `caught-up(W)`. Unsupported events that require refetch keep freshness incomplete until a new baseline/recovery succeeds.
3. Distinguish transport open, refreshing, current through a sequence, and stale. Remain refreshing until the completion marker is applied. On overflow, stream loss, unknown event, deadline, or refresh failure, retain cached content and show stale/last-known state. Do not infer provider state or command delivery from catch-up.
4. Gate new state-dependent submissions and approval/question decisions until recovery evidence is current; preserve typing, navigation, drafts, and the original command-pending/uncertain state. Define Stop separately as the existing explicitly targeted recovery action, using last-known state and server validation without claiming the provider is stopped. No automatic send or retry with a new command identity.
5. On selection change, rebaseline the selected thread under a new attempt and reject late prior-selection results. On session replacement clear old-session caches according to existing isolation rules; ordinary same-session retry preserves cached data and drafts. Disposal must discard old queued work, not flush it into current caches.
6. Detect older servers through a typed unsupported-method result or explicit capability evidence. Only unsupported protocol responses activate legacy fallback; timeouts, auth errors, and generic failures remain failures. Fallback uses bounded/coalesced cancellable refetch, preserves cached data, and displays last-refreshed evidence without claiming synchronized recovery. Preserve the legacy server's existing command behavior rather than disabling all commands indefinitely for lack of a new marker.
7. Bound restart attempts/deadlines and cancel subscriptions on disconnect, unpair, or expiry. A server restart starts baseline recovery anew. Stream termination without a marker is never success.

**Tests:** Fake-clock generation/cancellation tests; delayed baseline vs live event; marker before queued UI flush; empty replay; stale marker; unknown events; old-server fallback; authorization and timeout discrimination; selected-thread switch; session replacement; preserved draft/focus; state-dependent action gating.

**Exit:** Current-data UI is justified by applied recovery evidence, and failures never discard the current composition or imply successful command delivery.

### Phase 4: Validate scale and enable the client path

**Dependency:** All earlier exit criteria and limits finalized.

1. Benchmark a deterministic large synthetic SQLite fixture with many unrelated histories, plus a consented copy of representative large userdata if available. Do not mutate the user's live database. Record rows queried/decoded, query plans, response bytes, wall time, peak memory, and concurrent dispatch latency.
2. Compare fixtures with identical returned mobile data but 10× unrelated historical message/activity volume. Require unchanged decoded unrelated-history rows (zero), no material linear increase in allocated history objects, and query plans that avoid scanning unrelated history. Record warm/cold results and platform/database differences instead of generalizing macOS timings to Windows/Linux.
3. Set and record numerical p95 baseline latency, replay memory, byte, timeout, and dispatch-latency thresholds on named hardware before enabling the path. No invented performance result or fixed latency claim from static inspection. If required approval history or selected-thread size dominates, keep correctness and document the measured limitation; pagination or materialized pending-state derivation needs a separate reviewed design.
4. Enable the new client path only after contract, server, and browser validation. Roll back by disabling new-client selection of these additive endpoints; existing endpoints remain available. Rollback retains honest last-refreshed fallback state. No data migration rollback is expected.

**Exit:** Limits and representative measurements are recorded, required checks pass, and mobile interaction checks succeed.

## Risks And Decision Gates

- **Projection consistency:** A transaction is necessary but does not alone establish exact sequence semantics if projectors can be at different versions. This blocks exposing the recovery endpoint until proved or repaired.
- **Large required payloads:** Current approval history and a selected full thread may be large. Preserve correctness; do not solve memory pressure by silently omitting terminal decisions.
- **Moving deletion frontier:** Conservative replay may force repeated baselines under concurrent deletion. Retry must be bounded and visible; optimize only after evidence, without changing canonical gap semantics.
- **Live capture race:** Subscription readiness and resource cleanup need integration tests using the actual engine hub. A mocked stream alone is insufficient.
- **Compatibility:** Mobile uses shared RPC/contract types. Prefer a separate additive stream method so old clients and desktop consumers do not unexpectedly receive new frame variants.
- **Scope:** Any database migration, including a new index, requires explicit approval under the original plan’s migration scope gate, after demonstrating a query-plan benefit and preparing migration/restart coverage. Broader schema/deletion changes are outside this plan.
- **Meaning of freshness:** Catch-up applies through a specific watermark; command acceptance and provider health remain separate evidence dimensions.

## Testing And Validation

Validation recorded by the coordinating agent on 9 September, 2026, before this document was added:

- `bun fmt`: passed without worktree mutations.
- `bun lint`: passed with four existing warnings and fourteen oversized-test warnings.
- `bun typecheck`: all nine packages passed.
- `bun run --cwd apps/server vitest run src/ws/wsStreams.test.ts src/persistence/Layers/OrchestrationEventStore.frontier.test.ts`: two files, eight tests passed.

After saving the plan, the coordinating agent reviewed it and reran `bun fmt`, `bun lint`, and `bun typecheck`; all passed with the same existing lint warnings. Only this plan was added; application code and the original plan remain unchanged.

These checks establish the inspected code's existing baseline, not completion of the proposed recovery changes. No large-database benchmark or physical-device recovery test was performed in this review.

Implementation must add focused contract, targeted-query, actual mobile-route/engine integration, and mobile controller tests described per phase. Run server files through `bun run --cwd apps/server vitest run <file>`; mobile tests through `bun run --cwd apps/mobile-web test`. Use `bun run test` for broader Vitest validation when warranted; never `bun test`. Before marking implementation complete, all of `bun fmt`, `bun lint`, and `bun typecheck` must pass. Rust checks are unnecessary unless implementation scope changes to Rust.

Add browser coverage for stale cached content, draft/focus preservation, action gating, recovery after network suspension, and older-server fallback. Perform physical iOS Safari/Android Chrome resume checks when available; unavailable devices must be recorded as a validation limitation, not a passed check.

## Acceptance Criteria

- All three findings have focused regression coverage and implemented fixes.
- Baseline data and cursor share a proved consistency boundary, and summary reads do not hydrate unrelated full history.
- Replay honors the supplied baseline cursor, is paged and bounded, and uses canonical gap evidence.
- A missing sequence followed by one event results in bounded recovery/failure without waiting for capacity overflow.
- Zero-event replay emits and applies an explicit completion marker.
- Completion is accepted only after all relevant event applications through its watermark finish.
- Errors, cancellation, and overflow close capture without blocking engine dispatch or leaking retries.
- Older servers retain usable conservative fallback without unsupported synchronization claims.
- Desktop defaults, direct-unmanaged mobile semantics, authorization boundaries, and command identity behavior remain intact.
- Scale measurements and numerical operating limits are recorded; required checks pass; changed source/test files respect the 400-line limit.

## Open Questions

- No user/product decision blocks starting the server work. Projection publication semantics and operating budgets are engineering gates to resolve in Phases 1 and 4.
- Which representative hardware/database copy is available for the optional real-data benchmark? Synthetic data is sufficient to begin; access to private userdata must not be assumed.
- Does later product work require pagination of exceptionally large selected threads? Preserve existing full-thread behavior in this plan pending measured need.
- Attach an existing note/card reference if discovery becomes available; creating a new tracking item is not part of this document-only task.
