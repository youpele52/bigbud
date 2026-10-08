# Terminal scoped-output architecture plan

**Date:** 30 September, 2026  
**Status:** Proposed — ready for implementation approval; independent review passed; implementation not authorized  
**Owner:** Planner / main agent  
**Created:** 2026-09-30T15:17:20+02:00 (SAST)  
**Last modified:** 2026-09-30T16:09:23+02:00 (SAST)  
**Project root:** `/Users/youpele/DevWorld/bigbud`  
**Inspected branch / commit:** `dev` / `7142d10c6a9d3ccfb13c9dcb844b3916f33d8e5c`  
**Baseline:** Current working tree, not commit alone. Existing unrelated changes include `apps/server/src/ws/wsStreams.ts` and `apps/web/src/rpc/client.test.ts`. Preserve all existing user work.

## Summary

Separate lightweight terminal status/identity delivery from heavyweight terminal output. Tabs and background activity indicators should continue updating without subscribing to every terminal's raw output. Rendered panes should receive only their own output through an explicit snapshot-to-live handoff, backed by incremental history with both line and byte limits.

Keep xterm, the existing renderer integration and write batching, direct SSH targets, terminal annotations, file-path drops, labels, local agent detection, and worktree ownership safeguards. Adapt upstream concepts to bigbud's own Effect services and focused modules; do not transplant upstream code.

The user-selected architecture is:

```text
Each terminal process
        │
        ├── Lightweight status / identity events
        │          └──► tabs and background activity indicators
        │
        └── Terminal-specific output
                   │
                   ├──► incremental, byte-bounded history
                   │
                   └──► snapshot + buffered live handoff
                                  │
                                  └──► existing terminal renderer
```

This lets bigbud retain its richer terminal features without routing every raw output chunk through the same shared client subscription.

## Related Work

- Source: the terminal comparison and architecture request in bigbud thread `9191707a-cc9e-4673-9b92-3f18f3868469`.
- Preserve the implemented safeguards in [Terminal harness icon reliability plan](2026-09-23-terminal-harness-icon-plan.md), especially authoritative local null identities, runtime generations, close tombstones, and identity state surviving output-buffer eviction.
- Reference implementation: [t3code snapshot `c2fa9fc911daeac97df4760f95fc57dca42b84c8`](https://github.com/pingdotgg/t3code/tree/c2fa9fc911daeac97df4760f95fc57dca42b84c8). Read and adapt, never copy directly; follow `.opencode/agents/fork-upstream-adapter.md`.
- Notes / Kanban: none identified. Lookup was attempted, but workspace tools returned `Workspace tools are not ready`; this is not evidence that no related records exist. No issue ID or PR was supplied.

## Problem

1. The current terminal RPC subscription registers against a shared event feed rather than a terminal-scoped output feed (`apps/server/src/ws/wsRpcHandlers.gitTerminal.ts:350`). Background awareness therefore depends on delivery of events that can contain unrelated raw output.
2. The existing snapshot restoration path buffers events and compares them with `snapshot.updatedAt` (`apps/web/src/components/terminal/TerminalViewport.session.helpers.ts:269`). Recovery exists already, but its snapshot/live boundary should use explicit sequence and runtime identity rather than timestamp ordering alone.
3. History is capped by lines (`apps/server/src/terminal/Layers/Manager.history.ts:5`). A giant unterminated line can exceed a reasonable byte budget. Restoration reads the complete saved log before trimming it (`apps/server/src/terminal/Layers/Manager.history-io.ts:37`).
4. History strings are rebuilt during output handling (`apps/server/src/terminal/Layers/Manager.process-drain.events.ts:54`). Incremental retained chunks can avoid repeated copies of the complete history.
5. Raw output also supports existing context and remote identity heuristics. Simply removing the root subscription would regress those consumers unless their replacement data paths are explicit.

These are structural observations, not measured throughput or latency claims. No comparative benchmarks or implementation validation have been run for this plan.

## Goals

- Deliver raw output only to consumers explicitly attached to that terminal.
- Keep tabs, activity indicators, and identities current for hidden and inactive panes without background raw-output subscriptions.
- Restore a bounded snapshot, then deliver newer live events in order without duplicating the snapshot boundary.
- Bound retained history by the existing line policy and a new UTF-8 byte policy, including newline-free output and oversized legacy logs.
- Bound application-managed attachment and renderer backlogs; expose discontinuity and recover rather than silently dropping live output.
- Preserve existing terminal controls, renderer behavior, remote targets, annotations, labels, and lifecycle safeguards.

## Non-Goals

- Replacing xterm with Ghostty or introducing a server-side VT renderer.
- Adding close confirmation, changing font-setting UX, or other unrelated UI changes.
- Adding durable SQL event replay, an `afterSequence` resume protocol, or guaranteed recovery of history outside the retention budget.
- Making hidden terminal programs universally independent of terminal-query replies from a visible renderer.
- Replacing the Rust supervisor, redesigning generic RPC ACK handling, or claiming end-to-end PTY backpressure from protocol acknowledgments.
- Adding exact remote process detection, changing SSH authentication, or treating agent identity as authorization.
- Changing script execution or implicitly rerunning terminal commands on attachment/reconnect.
- Committing, pushing, discarding user changes, or implementing this proposal without approval.

## Current State

### Observed architecture and reuse targets

| Area                              | Existing files / evidence                                                                                                                          | Preserve or adapt                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                         | `packages/contracts/src/workspace/terminal.ts:43`, `:162`                                                                                          | Execution targets, typed identities, snapshots and runtime identity; add focused streaming contracts rather than breaking existing callers.                                                             |
| Manager API and subscription      | `apps/server/src/terminal/Services/Manager.ts`; `Layers/Manager.session.subscription.ts`; `Layers/Manager.session.ts:121`                          | Reuse session ownership and controls; distinguish side-effectful open/restart from read-only attachment.                                                                                                |
| Output and lifecycle              | `Layers/Manager.process.ts:159`; `Manager.process-drain.events.ts:54`; `Manager.process-lifecycle.ts`; `Manager.session.timestamp.ts`              | Keep server coalescing, final output ordering, process identity fencing, and established timestamps for compatibility.                                                                                  |
| History                           | `Layers/Manager.history.ts:5`; `Manager.history-io.ts:37`                                                                                          | Preserve replay-unsafe control sanitization, log paths, persistence scheduling and error reporting.                                                                                                     |
| SSH and leases                    | `Layers/Manager.remote.ts:4`; `Layers/Manager.ts:25`                                                                                               | Keep direct SSH execution targets and local persistent per-terminal worktree leases. Remote targets remain outside local filesystem leases.                                                             |
| Web restoration                   | `apps/web/src/components/terminal/TerminalViewport.session.helpers.ts:269`; `TerminalViewport.session.ts`                                          | Replace timestamp-only handoff for new attachments without replacing xterm or terminal controls.                                                                                                        |
| Web state                         | `apps/web/src/stores/terminal/terminal.store.panel.ts`; `terminal.store.identity.ts`; `terminal.store.close.ts`; `helpers.events.store.ts`         | Preserve identities outside the event buffer, close boundaries, custom labels and cleanup behavior.                                                                                                     |
| Rendering                         | `apps/web/src/components/terminal/TerminalWriteBatcher.ts:9`                                                                                       | Keep batching; add minimal byte accounting / drain admission hooks only if needed to bound new delivery.                                                                                                |
| Root and transport                | `apps/web/src/routes/-__root.logic.tsx`; `apps/web/src/rpc/wsTransport.ts`; `apps/server/src/ws/wsStreams.ts`                                      | Root subscribes to metadata instead of global raw output. Handle automatic stream resubscription explicitly. Respect existing dirty transport changes.                                                  |
| Rich workflows                    | `TerminalViewport.drop.ts:88`; `TerminalViewport.annotations.tsx:68`; `ThreadTerminalDrawerSidebar.tsx:129`; `apps/web/src/lib/terminalContext.ts` | Preserve file drops, annotation selection and provenance, names, and provider icons.                                                                                                                    |
| Independent terminal abstractions | `packages/effect-acp/src/terminal.ts:6`; `apps/server/src/remote-workspace-bridge/remoteWorkspaceAcpBridge.ts:132`                                 | Planning research found independent ACP command processes and on-demand output, not a dependency on the UI global feed. Verify adapters before editing; do not migrate independent paths unnecessarily. |

Paths under `Layers/` in this table are relative to `apps/server/src/terminal/`. Confirm line locations before implementation; they describe the inspected working tree.

### Decisions and assumptions

- Use separate metadata and terminal-scoped attachment contracts, with no `data` or `history` fields in metadata schemas.
- Keep existing line-limit defaults; introduce a default **8 MiB retained UTF-8 history budget**. This limits logical retained data, not total process RSS or every serialization allocation.
- Use a unique `serverEpoch` per manager boot, immutable `sessionIncarnation` per created session, existing `runtimeGeneration` per spawned process, and a monotonically increasing `sequence` per session incarnation. Sequence continues across clear/restart; compare it only within the same epoch/incarnation. A sequenced reset explicitly admits the next runtime generation; arbitrary old-generation output never does.
- New attachments restore a fresh bounded snapshot on reconnect. They do not claim cursor-based durable replay or recovery of evicted history.
- Keep existing `.log` paths and plain-text compatibility; no SQLite migration is expected.
- Cancellation of a subscription is a detach, never process termination or history deletion.
- A slow subscriber must not stop or restart the terminal process. Its attachment fails explicitly and resynchronizes independently.
- Additive legacy compatibility is acceptable only for explicit legacy consumers. The current web root must not keep a global raw-output compatibility subscription after cutover.

### Chosen stream protocol and state transitions

Add `terminal.subscribeMetadata` and `terminal.attach({ threadId, terminalId })`. Add `terminal.ensureOpen` with the existing open input/mutation semantics but a metadata-only result, avoiding a redundant full-history response before attachment. Retain legacy `terminal.open` and event contracts for identified older consumers. New contracts are additive; required new-stream fields must not make optional legacy fields mandatory.

A metadata summary contains session identifiers, existing launch/target/drop-mode information, lifecycle/activity, normalized provider identity/hint provenance, and versions. It excludes history, raw output, environment assignments and free-form terminal-derived text. Use existing authenticated server/remote-environment authorization, not a new per-thread ACL assumption. IDs select an existing session; they do not grant access.

| Stream item                                               | Required boundary fields and behavior                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Metadata `snapshotBegin` / `snapshotPage` / `snapshotEnd` | `serverEpoch`, unique `syncId`, manager-wide `catalogRevision = R`; begin/end delimit a frozen catalog, pages contain bounded summaries only. Register metadata capture before freezing R. Stage pages without changing layout; replace server-owned awareness only after a complete matching end.                                                   |
| Metadata `upsert` / `remove`                              | Epoch, catalog revision, thread/terminal/incarnation and session sequence; upserts contain the current summary, removals contain the retired session identity. After baseline R, deliver every catalog change with revision greater than R in order. Metadata session sequences may jump over output-only commits; do not treat those jumps as gaps. |
| Attachment `snapshotBegin`                                | Unique `attachmentId`, epoch, session incarnation, runtime generation, summary, watermark `S`, `historyTruncated` and replay-boundary information. History/state/checkpoint are captured together after a synchronous pending-output flush.                                                                                                          |
| Attachment `snapshotChunk` / `snapshotEnd`                | Same attachment/epoch/incarnation/watermark; chunks have consecutive indexes and bounded history payloads. End gives the final chunk count. No live frame precedes end; the client accepts S only after all snapshot writes drain.                                                                                                                   |
| Attachment live `output` / `state`                        | Attachment ID, epoch, incarnation, runtime generation and session sequence. Every attachment-visible committed output or state transition is represented, including an empty output/checkpoint when boundary filtering removes all payload. The client rejects duplicates at or below its cursor and resynchronizes on a missing sequence.           |
| Attachment `cleared` / `reset`                            | Sequenced control boundary after the preceding output flush. Clear applies existing clear behavior without changing runtime generation; reset carries the new generation/summary and invalidates old queued work before new-generation data is accepted.                                                                                             |
| Attachment `exit` / `closed`                              | Sequenced terminal boundary after final output; the renderer drains all preceding writes before invoking existing exit/close cleanup. Metadata exit/removal updates indicators but cannot detach an active output owner ahead of this completion fence.                                                                                              |
| Typed stream failure                                      | Lookup/authorization, payload limit, overflow/resync, initialization timeout or listener failure. Failure is delivered through a separate cancellation/failure signal, not inserted into a full data queue; dispose the affected capture only.                                                                                                       |

Allocate a sequence only at the synchronous, non-awaiting session commit boundary. Split oversized output into bounded frames before allocation; update retained history and state for each frame before publishing its sequence. Take snapshot chunk references, summary, pending-control state and S without yielding. Buffered frames at or below S are already represented by the snapshot; drain all newer frames before switching to direct live delivery.

Metadata uses a separate manager-wide catalog revision that advances only on metadata mutations. A new complete baseline clears stale server-owned awareness for absent incarnations while preserving local tab/layout choices, label overrides, context drafts and close tombstones. Incomplete baselines never partially replace the catalog. Epoch changes invalidate prior cursors; sync/attachment IDs and local attempt tokens fence queued work from retired subscriptions. An active renderer owns its exit/close completion fence; metadata cannot independently invoke its auto-close callback. On a failed attachment, report discontinuity/unavailability rather than silently treating undrained final output as delivered.

### Replay boundaries and incomplete controls

- Retained history contains only complete replay-safe tokens plus ordinary text. Keep pending UTF-8/surrogate and escape-control state bounded; a snapshot never emits an unclassified partial control prefix to xterm.
- If S lands inside a control, seed an attachment-local continuation parser from the withheld pre-S prefix. Hold subsequent suffix bytes until classification/termination. For a replay-safe completed token, emit its reconstructed whole token once with the completion frame's post-S sequence. For a replay-unsafe query/reply, omit the whole token and its suffix; never resend it solely to restore parser state. Pass subsequent ordinary live data unchanged.
- Emit sequenced empty advances for post-S fragments that remain withheld, so the cursor stays contiguous. Bound prefix/suffix carry to 16 KiB; an overlong control is discarded through its terminator using fixed-size parser state, with replay-boundary truncation explicitly marked. Do not accumulate its entire payload or expose its suffix as plain output.
- Preserve raw live controls that begin after S; normal live terminal replies remain normal behavior. The special reconstruction/suppression rule applies only to a control intersecting the attachment checkpoint.
- Preserve UTF-8 boundaries on chunk eviction and file-tail reads. With an oversized unindexed legacy log, the bounded tail may start inside unknown ANSI state. Restore a conservatively neutralized text-only tail and mark truncation rather than executing unprovable partial controls. Do not destroy the source on replacement/migration failure.
- Required deterministic cases include snapshots after `ESC[3` with later `1mred`, split OSC/DCS with ST/BEL termination, unsafe query continuation, oversized unterminated controls, and split Unicode characters. Safety does not imply perfect reconstruction of arbitrary historical TUI screens.

### Resource and recovery defaults

These are chosen starting policies to validate, not measured speed improvements or total RSS/native-buffer guarantees. Byte units below are UTF-8 payload unless explicitly serialized; event/node limits bound bookkeeping as well as strings.

| Managed resource                               | Default and failure/admission policy                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retained history                               | Existing 5,000-line limit plus 8 MiB; use compact bounded blocks, merge small fragments and cap retained chunk bookkeeping at 1,024 nodes. Eviction is explicit retained-history truncation, not silent live loss.                                                                                                                                                     |
| Pending coalescer                              | 64 KiB / 1,024 pieces; synchronously flush before exceeding either threshold, split large callbacks safely, and retain only one scheduled timer per session. Threshold and timer flushes share state, preventing duplicate commits.                                                                                                                                    |
| Snapshot chunks / live frames / metadata pages | Snapshot chunks at most 64 KiB payload; split canonical live output at 48 KiB before sequence allocation, reserving 16 KiB for a reconstructed pre-checkpoint control so the delivered payload stays at most 64 KiB. Metadata pages are at most 64 KiB serialized UTF-8. A single unrepresentable metadata item fails explicitly instead of violating the page budget. |
| Attachment capture/live queue                  | At most 1 MiB serialized queued envelopes / 1,024 events, plus one separately bounded immutable 8 MiB history snapshot; nonblocking offer failure invalidates only this attachment. Snapshot chunks are streamed, not queued as the whole snapshot in the live queue.                                                                                                  |
| Metadata live queue                            | 256 KiB serialized / 1,024 events; overflow invalidates this metadata subscription and requires a complete new catalog baseline. Raw output is filtered out before capture.                                                                                                                                                                                            |
| Incomplete control carry / tail restoration    | Carry at most 16 KiB; tail reads at most 8 MiB + 16 KiB boundary repair. Scope file handles and test short reads.                                                                                                                                                                                                                                                      |
| Renderer admission                             | 1 MiB combined pending and in-flight payload; snapshot chunks, live chunks and direct flushes all use the same byte-accounted drain path. Stream snapshot chunks through available admission instead of enqueueing 8 MiB at once.                                                                                                                                      |
| Attachment initialization / renderer drain     | 10-second deadline each; timeout invalidates the local attachment, never the PTY. A stuck renderer may be recreated using the same xterm/addons after fencing old callbacks.                                                                                                                                                                                           |
| Overload recovery                              | At most three automatic overload-triggered reattachments per 30 seconds, delayed 250 ms, 1 second and 2 seconds. The next overflow pauses output with explicit Retry. Keep this window outside generic transport retry counters; successful snapshot frames do not reset it.                                                                                           |

All manager offers are nonblocking and attachment-local; a blocking bounded queue must not replace the existing sequentially awaited listener loop. Isolate legacy subscribers too. Ordinary transient connection recovery can reuse the established transport, but repeated overload follows the bounded policy above. The terminal controller must receive retryable failure/new-attempt notifications before automatic resubscription, mark itself stale, cancel queued old writes and stop the transport retry when paused. Retry reattaches to the existing runtime; it does not perform Restart or rerun a script. Metadata overload likewise stages a fresh baseline with bounded recovery and exposes stale/paused awareness if overload persists.

## Phases

### Phase 1: Freeze the consumer contract and add characterization tests

**Goal:** Make the replacement data paths and preserved behavior explicit before switching subscriptions.

- Inventory all `terminal.onEvent` callers, Manager subscriptions, snapshot callers, and raw-output-derived UI fields. Trace native API/RPC adapters and remote-environment connections, not only the web drawer.
- Classify each consumer as metadata, scoped live output, on-demand retained context, or an independent ACP/command-output abstraction.
- Record baseline bytes delivered for two terminals when only one is displayed; separate payload counts from runtime performance measurements.
- Add characterization coverage for current identity recovery, close tombstones, remote icon fallback, context capture, annotations, labels, resize, restart, exit and final output flush.
- Verify the transport's automatic resubscription path: a retry may not invoke a caller error callback. Treat each fresh attachment snapshot as a new delivery boundary and invalidate old queued work.

**Likely files:** existing terminal contracts, Manager service, RPC handler tests, root subscription, terminal stores, `wsTransport.ts` and terminal viewport tests. Any diagnostic helpers must avoid logging raw output or credentials.

**Exit:** Each consumer has a documented replacement path. Independent ACP paths are either demonstrably unaffected or have a specific targeted compatibility test. No application subscription has changed yet.

### Phase 2: Incremental byte-bounded history, independently safe to ship

**Dependency:** Phase 1 characterization tests.

- Introduce focused history-chunk and bounded-tail modules (proposed `Manager.history.chunks.ts` and `Manager.history.tail.ts`). Retain UTF-8 byte accounting and line accounting incrementally; do not flatten the full retained history on every chunk.
- Materialize history only for an explicit snapshot or the existing coalesced persistence operation.
- Preserve Unicode boundaries and replay-control sanitization. Bound any carried incomplete escape/control sequence so it cannot bypass the history cap. Preserve live data independently of replay sanitization.
- Trim at safe replay boundaries; explicitly expose truncation in snapshot metadata without injecting fabricated text into terminal output. Truncation is retained-history eviction, not permission to drop live delivery silently.
- Restore only the bounded tail of legacy logs, with a bounded boundary-repair allowance. Serialize reads/writes against the existing persistence lane and preserve existing error classification.
- Preserve existing log names and restart recovery. Do not rewrite or delete unrelated logs. A failed read/write remains visible through established errors, not a fabricated empty successful history.

**Likely files:** `Manager.history.ts`, `Manager.history-io.ts`, `Manager.process-drain.events.ts`, `Manager.process.persistence.ts`, `Manager.session.types.ts`; proposed focused history modules and their tests.

**Exit:** Logical history remains within the byte and line budgets for newline-free, Unicode and control-heavy output. Oversized log restoration does not read the whole file. Existing history tests pass.

### Phase 3: Add metadata and scoped snapshot/live server streams

**Dependency:** Phase 2 bounded snapshot/history implementation.

- Add focused contracts (proposed `packages/contracts/src/workspace/terminal.streaming.ts`) for metadata snapshots/upserts/closed boundaries and terminal attachment snapshot/live envelopes.
- Metadata includes only lifecycle/activity summaries, identities and relevant versions. Register metadata observation before initial hydration and replay only newer buffered changes, preventing stale identities or lifecycle state from winning an initial snapshot race.
- Key output subscriptions by authenticated connection/environment and `(threadId, terminalId)`. Validate against the existing session ownership and authorization boundary; terminal IDs reused across threads must not collide.
- Implement read-only attachment: register the scoped listener first, buffer events, capture an immutable history/status/runtime/sequence snapshot, then deliver only buffered events newer than that snapshot. Capture history and its sequence consistently before asynchronous work can invalidate the boundary.
- Fence events with runtime identity and stream ownership. Deliver final output before exit/closed completion; late events from retired runtimes cannot revive a closed pane.
- Bound pending coalescing by bytes and event count. Flush earlier when thresholds are reached, splitting oversized chunks safely, rather than terminating PTYs for client pressure. Retain existing time-based batching for normal traffic.
- Bound each attachment's buffered live events. Overflow produces an explicit attachment discontinuity/error and releases only that subscriber. Recovery uses a fresh snapshot with backoff; do not silently evict live events or block other terminals.
- Attach/detach does not run scripts, replace a shell, resize another consumer unexpectedly, close processes, delete history, or acquire a second runtime lease. Existing open/restart operations remain the source of lifecycle mutations.
- Keep legacy event APIs temporarily for identified legacy consumers; no hidden global raw-output bridge for new clients.

**Likely files:** Manager service, `Manager.session.subscription.ts`, process/lifecycle modules, contracts, `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts`, native API/RPC definitions discovered in Phase 1. Proposed focused metadata/output subscription modules keep materially edited source files at or below 400 lines.

**Exit:** Deterministic server tests prove source scoping, metadata/output separation, race-safe hydration and snapshot handoff, final-flush ordering, cancellation, generation fencing and explicit bounded-overflow behavior.

### Phase 4: Switch client ownership and preserve output-derived workflows

**Dependency:** Phase 3 server contract and ordering tests pass.

- Root state subscribes to metadata only. It retains background identity/activity and lifecycle state without buffering raw output for every pane.
- Use independent per-visible-viewport attachments as the default, keyed by connection/environment, thread, terminal and local owner token. Every visible split pane attaches independently; duplicate viewers have independent bounded queues/cursors. Cancelling one viewer cannot cancel another. Do not introduce reference-counted shared-stream alternatives in this implementation.
- Propagate explicit UI visibility/output ownership through `ThreadTerminalDrawerViewport.tsx` into `TerminalViewport.tsx` and the attachment controller. Current visibility affects autofocus only (`ThreadTerminalDrawerViewport.tsx:78`); autofocus is not subscription ownership. Mounted-but-hidden tabs/panels detach unless a separately declared output consumer owns an attachment. Hiding, collapsing, switching active groups or unmounting removes only that owner, never the runtime.
- Preserve initial creation and deliberate reopen/target-change behavior through metadata-only `ensureOpen`, backed by the existing open primitive. Invoke it for a lifecycle intent, not every component mount or visibility change. Revealing an already initialized pane and transport resubscription obtain fresh attachment snapshots without invoking open/restart again. A transport reconnect alone never reruns a script. Server epoch changes invalidate old runtime state; missing runtimes are explicitly unavailable, not silently replaced with healthy running shells.
- On each snapshot boundary, invalidate old delivery jobs and discard unissued old batches. Let already issued writes drain before resetting/replaying; checkpoint S becomes applied only after matching snapshot end and renderer drain. Control frames obey the same drain fence, especially clear/reset/exit/closed. An older metadata exit/removal cannot unmount an active output owner ahead of the final-output fence.
- Retain xterm and `TerminalWriteBatcher`; add minimal byte accounting and drain/admission hooks to enforce the chosen 1 MiB pending-plus-in-flight budget. Snapshot chunks and direct flushes cannot bypass admission. A snapshot larger than the window advances incrementally through drain callbacks; live overload invalidates only its attachment. Do not replace a bounded network queue with an unbounded renderer queue.
- Apply the chosen bounded overload recovery window outside generic transport retry state; reset it only when the window expires or explicit Retry is requested, not when a snapshot frame arrives. Add terminal-scoped retry/discontinuity notifications so automatically retried failures cannot leave the controller silently stale or restart a paused subscription.
- Preserve local authoritative identities, null identities, close tombstones, custom labels and runtime-generation behavior. Missing metadata must not resurrect icons from historical output.
- Preserve remote best-effort output-based icon hints through a bounded server summary using shared pure matching logic, not a hidden raw-output subscription. Keep remote process inspection out of scope.
- Move terminal-context reads that depended on the global event buffer to scoped/on-demand bounded snapshots. Preserve the source terminal/runtime, selection ranges, comments, intent and existing delegated provenance; do not silently replace a user's selected text with a newer tail.
- Keep input, paste, links, file drops, resize, split/tab behavior, SSH target switching, and panel coordination unchanged. Reuse existing recovery/toast surfaces rather than introducing unrelated layout changes.

**Likely files:** root subscription, RPC/native client adapters, terminal stores, `TerminalViewport.session.ts`, `.session.helpers.ts`, `.events.ts`, `TerminalWriteBatcher.ts`, `terminalContext.ts`, `terminalDisplay.ts`, activity utilities and any proposed attachment controller/shared pure hint utility.

**Exit:** Current clients receive no unrelated raw output. Hidden panes retain status and identity. Reconnect, multiple viewers, close/restart races, context capture and remote fallback are covered by web/store/browser tests.

### Phase 5: Validate and cut over without a global-output fallback

**Dependency:** Phases 2–4 and focused regression suites pass.

- Verify every in-repository caller is migrated or explicitly independent. Search for new-client global raw subscriptions and unused history/event-buffer dependencies.
- Measure selected-terminal bytes, unrelated-terminal bytes, retained-history bytes, tail-read bytes and pending attachment/renderer bytes. Report actual results and workload definitions; do not infer performance from architecture alone.
- Exercise local and SSH terminals on macOS, Linux and Windows, including multiple views, hidden panes, disconnect/reconnect, slow delivery, fast output, interactive programs, restart, close and backend restart.
- Keep legacy APIs only as an explicit compatibility path for older consumers. Decide removal from real caller/protocol evidence, not an arbitrary date. Do not downgrade new clients to global raw output on a transient stream error.
- Roll back delivery cutover by restoring the previous client subscription path if an acceptance gate fails. History stays readable at its existing paths, but content intentionally evicted by the new retention budget cannot be restored by rollback.
- Record check results and remaining platform limitations in this plan before declaring implementation complete.

**Exit:** All acceptance criteria below pass with evidence; no unrelated application behavior was changed.

## Risks And Decision Gates

- **Scope versus compatibility:** additive server methods may coexist with legacy APIs, but the new root must not retain the old raw feed. Identify actual old consumers before removal. Targeted terminal retry/discontinuity hooks are allowed; do not redesign the generic RPC/ACK protocol or change unrelated consumers' retry behavior.
- **Initial hydration and reconnect races:** implement the chosen catalog revision, session sequence, epoch/incarnation and stream-token domains. Metadata exit/removal must respect the active output owner's completion/drain fence. Generation and close tombstone fencing remain mandatory.
- **Slow clients:** apply the Resource and recovery defaults, including nonblocking offers, separately accounted snapshots, pending-plus-in-flight renderer admission and an overload window outside transport counters. Test single oversized events separately from multi-event overflow. No automatic PTY termination for a slow consumer. Change a budget only with recorded test/measurement evidence; do not leave its failure policy undefined.
- **Heavy ingress:** flush-on-threshold and safe chunking must bound application-managed pending coalescing. If a source cannot support these guarantees without a broader PTY behavior change, stop at a decision gate and revise the plan; do not silently introduce process killing or claim OS/native buffers are bounded by this work.
- **Remote hints and context:** removing global output before replacement summaries/on-demand reads are implemented is a rollout blocker.
- **Persistence:** preserve serialized writes and legacy paths. Clearly distinguish retention eviction from persistence failure. No SQL migration or new durable replay log is planned.
- **Renderer/parser fidelity:** preserve Unicode and control-sequence behavior, including replay-unsafe terminal replies. Retained raw-history tails are not complete serialized VT screen state.
- **Dirty baseline:** review current changes before implementation, especially shared transport/RPC work. Revalidate if terminal contracts, routing, identity or transport code changes underneath the plan.
- **Approval:** this document authorizes no implementation, destructive cleanup, commit or push. Obtain implementation approval and fresh explicit approval for each commit/push.

## Testing And Validation

### Required coverage

| Requirement                                                    | Layer and tests / evidence                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No unrelated output; metadata contains no raw data/history     | Contract tests; RPC integration tests with two terminals/two threads; serialize and count received payload bytes.                                                                                                                                                                                                                            |
| Metadata hydration cannot overwrite newer identity/exit/close  | Manager subscription tests; terminal identity/store cleanup tests; deterministic update during initial snapshot.                                                                                                                                                                                                                             |
| Snapshot/live exactly-once boundary                            | Manager events/lifecycle tests: output before/during/after capture, matching begin/chunk/end, same timestamps with different sequences, clear/reset and final flush. Deliver metadata exit/removal before the attachment exit fence to prove the final output still drains before UI auto-close.                                             |
| Retained history and tail reads remain bounded                 | `Manager.history.test.ts`; proposed chunk/tail tests: huge unterminated lines, tiny fragments/node limits, Unicode, snapshot-mid-CSI/OSC/DCS, safe prefix reconstruction, unsafe-query suffix suppression, overlong carry and legacy tails starting inside controls; zero/low budgets and file failures.                                     |
| Bounded attachment and renderer admission                      | Proposed overflow/controller tests; `TerminalWriteBatcher.test.ts`; nonblocking subscriber offers, fast producer/slow consumer, oversized events, all snapshot/direct-write admission, initialization/drain timeouts, resync, cancellation, and independent sibling progress. Successful snapshot frames must not reset the overload window. |
| Runtime/close fencing and reconnect                            | `Manager.lifecycle.test.ts`, `.events.test.ts`, `.lease.test.ts`; web `TerminalViewport.events.test.ts`, `.session.helpers.test.ts`; terminal store identity/close/event tests.                                                                                                                                                              |
| Visibility, remote, labels and rich context remain intact      | `Manager.remote.test.ts`; terminal context/provenance and annotation/drop/links tests; terminal panel/drawer/browser tests for mounted-but-hidden panes, hide/reveal without lifecycle open, all visible splits, independent duplicate viewers, and cancelling only one owner.                                                               |
| Independent ACP / native / environment paths remain compatible | Focused adapter tests identified in Phase 1; do not edit independent ACP processes solely to fit UI streaming.                                                                                                                                                                                                                               |
| Platform behavior                                              | Native smoke matrix: macOS, Linux, Windows; local and SSH; distinguish synthetic tests from actual platform observations.                                                                                                                                                                                                                    |

### Commands for implementation

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run --cwd apps/server vitest run src/terminal/Layers/Manager.history.test.ts src/terminal/Layers/Manager.events.test.ts src/terminal/Layers/Manager.lifecycle.test.ts src/terminal/Layers/Manager.remote.test.ts src/terminal/Layers/Manager.lease.test.ts`
- `bun run --cwd apps/web vitest run src/components/terminal/TerminalWriteBatcher.test.ts src/components/terminal/TerminalViewport.events.test.ts src/components/terminal/TerminalViewport.session.helpers.test.ts`
- Run focused new contract, RPC, store, context and browser suites identified above using package scripts; confirm browser setup/filters from `apps/web/package.json` before execution.
- `bun run test` for the integrated regression suite. **Never use `bun test`.**
- No Rust changes are expected. If scope introduces them, first revise this plan and require `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, and `cargo test --locked --workspace`.

**Planning validation:** No tests, formatting mutations, code edits or implementation checks have been run. Read-only research initially encountered `ENOSPC`; a later storage check succeeded before this save attempt. Record independent review and actual implementation results separately.

## Acceptance Criteria

- [ ] Metadata schemas and serialized metadata payloads never contain terminal output/history.
- [ ] A client displaying terminal A receives zero raw-output payload bytes from unrelated terminal B unless it explicitly attaches to B.
- [ ] Hidden panes keep existing lifecycle/activity indicators and local/remote best-effort identities without a global raw-output subscription.
- [ ] Snapshot/live boundaries are sequence-safe within the correct runtime and attachment; newer events are neither skipped nor duplicated at the boundary.
- [ ] Final output precedes exit; close/restart/server-incarnation fences reject stale work and cannot revive closed UI state.
- [ ] Retained history respects both line and UTF-8 byte limits; oversized logs use bounded-tail reads; output processing does not flatten full history per chunk.
- [ ] Subscriber and renderer overflow is bounded, observable, attachment-local and recoverable through a fresh snapshot; no silent live-output dropping or PTY termination for client pressure.
- [ ] Detach never stops a shell or deletes history; reconnect never reruns scripts or silently creates a replacement healthy runtime.
- [ ] SSH targeting, local worktree leases, annotations, selection/provenance, file drops, custom labels, inputs and panel coordination retain their behavior.
- [ ] Contract, server, web and relevant adapter suites pass; required repository checks pass; platform results and remaining limitations are stated accurately.
- [ ] Independent plan review has no blocking findings before implementation handoff; implementation approval is obtained separately.

## Open Questions

No unresolved user/product decision is identified for the selected architecture. Stream framing, sequence ownership, visibility policy, continuation handling and resource/recovery defaults are chosen above. Phase 1 verifies the actual adapter integration points and the later exit gates validate these policies; they are not permission to expand product scope.

Independent review pass 1 found four execution-readiness gaps: protocol/lifecycle framing, incomplete controls, resource/retry policy, and visibility ownership. This revision addresses all four. Follow-up independent read-only verification confirmed every correction and found no remaining concrete blocker. The plan is ready for implementation approval; engineering validation remains part of the future implementation, not a completed result.

## Plan Validity And Handoff

- Revalidate branch, commit and relevant working-tree changes immediately before implementation. Line references and proposed module names are planning evidence, not guarantees of unchanged files.
- Use `docs/plans/` and its `_plan-authoring-guide--do-not-delete.md`; do not create a competing singular plan directory or delete protected plan fixtures.
- Implement in phase order. History improvements can ship independently; do not cut the global client feed until scoped output and every dependent metadata/context path are complete.
- Every added or materially edited source/test file must be at most 400 lines. Split by concern using the repository dot-notation pattern; prefer contracts/shared subpath imports.
- Keep diagnostic metrics content-free. Do not log terminal output, selected context, SSH secrets or credentials for performance comparisons.
- Coordinator self-review pass 1 completed: checked the user-selected architecture and preserved workflows against phases and acceptance criteria. Pass 2 completed: defined stream/cursor ownership, lifecycle drain fences, boundary controls, nonblocking budgets, renderer admission, bounded retry and explicit visibility ownership. Independent review pass 1's four findings have been corrected in this plan; follow-up verification passed with no remaining concrete blocker. No application implementation, runtime benchmark or implementation validation is implied.
