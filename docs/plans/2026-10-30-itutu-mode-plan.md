# Ìtútù mode: implementation plan

Date: 2026-10-30
Status: proposed implementation plan, ready for implementation approval. Planning and repository investigation are complete; production implementation and its validation have not started.

## 1. Goal and agreed experience

Offer two arrangements of the same threads: the existing Projects arrangement and Ìtútù. Switching arrangements must not create, move between projects, duplicate, restart, archive, or delete threads.

### Sidebar layout

- Fixed state order: **Present → Needs you → Later → Done**.
- Present stays at the top of the thread area.
- Needs you, Later, and Done form one bottom-anchored block, even when that leaves substantial empty space below Present.
- When the contents exceed the available height, all groups remain reachable without overlap or inaccessible drop targets.
- State headings are plain text, without state icons, following the existing project-section styling.
- Preserve the existing provider icon, thread title, conditional status/actions, and relative time on the first line.
- Add one smaller second line: location icon plus local project name, remote workspace/VPS name, or Chat.
- Reuse existing provider/status semantics and all existing thread behavior. An organizational state is not a provider execution status.
- Remember the chosen arrangement, collapsed groups, per-thread state, and snooze across application starts.

Visual reference: `../prototypes/2026-10-30-itutu-sidebar.html`. Its sample data and browser-only persistence are not production implementation patterns.

### Context menu

Preserve the agreed relative order:

1. Rename thread
2. Branch thread
3. Move to → Present / Needs you / Later / Done
4. Pin thread
5. Separator
6. Elevator summary
7. Copy Thread ID
8. Copy Path
9. Archive thread
10. Separator
11. Delete

Mark the current Move to destination with a check. Expose movement in both arrangements, including the application's existing multi-selection affordances where supported.

Snooze is an additional action, not a fifth state. Its exact menu insertion and controls are specified in the integration section below; preserve the relative order of all agreed actions.

**Done is not Archive.** Done threads stay accessible in their group. Archive and Delete retain their existing semantics and permission/confirmation behavior.

## 2. Requested automation

### Agent access

- Add a canonical capability/MCP tool for an authorized agent to move a thread between the four states.
- Provide current organizational state and snooze information through existing thread read/discovery paths.
- Keep authorization aligned with existing canonical thread tools: current thread by default; only eligible same-project targets or directly delegated children when explicitly targeting another thread.
- Attached history alone must not grant movement authority.
- Agents should offer Done or Later when the actual requested task is finished, rather than after every response or provider end-of-turn event.
- Asking for a destination is not authorization to select it. Perform the move after the user's choice, unless the user has already explicitly authorized it.
- Do not add model calls, classifiers, or a new agent loop to perform deterministic organization or timers.

### Idle Present threads

- Default idle timeout: 10 minutes.
- Minimum configurable timeout: 1 minute.
- Automatic destination: Done by default; configurable to Later.
- Settings live in the existing General → Threads area.
- Make the automation explicitly disableable.
- Eligibility must reflect actual user/provider work, not just the age of the last user message.
- Never infer that unfinished work has succeeded merely because the thread timed out. Done here is an organizational destination.

### Needs you acknowledgement

- Deliberate user interaction returns a Needs you thread to Present.
- Programmatic preloading, background reads, polling, hover, MCP status reads, and automatic navigation must not acknowledge a thread.
- Acknowledgement never implicitly answers a question or approves a tool.
- Existing pending-request indicators must stay accurate after the organizational state changes.
- Replaying the same outstanding request must not repeatedly bounce the thread between Needs you and Present.

### Snooze

- Supported duration: 2 minutes through 24 hours, inclusive.
- Snoozing sets Later and persists an absolute server-calculated wake deadline.
- Expiry sets Needs you and consumes the deadline once.
- Snooze is a reminder, not a scheduled agent turn, paused execution, or delayed message send.
- Offer useful duration presets and a bounded custom duration.
- Support cancellation and rescheduling.
- An explicit move supersedes the existing snooze, even if the chosen state is Later again.
- Starting/resuming actual work early cancels the snooze and brings the thread to Present. Merely browsing a snoozed Later thread does not cancel its reminder.
- Archive and Delete cancel outstanding automation for the thread.

## 3. Transition invariants

1. Store one authoritative organizational state per thread; do not derive it from provider Working/Done/Idle labels.
2. Every mutation passes through a shared server-side transition path. UI, agent tools, provider attention events, idle cleanup, and snooze expiry must not write independent competing copies.
3. Persist changes before broadcasting them. Use normal command/event sequencing and existing client reconciliation.
4. Runtime-state gates protect automatic idle transitions; they must not prevent the current agent from performing an explicitly authorized organizational move through its own tool.
5. A manual or agent-authorized move does not cancel a running provider turn, background task, or terminal.
6. New provider output alone must not undo an explicit manual choice of Later or Done.
7. A newly accepted user work request may return a thread to Present; a stale replay of an older request may not.
8. An unanswered approval, question, proposed plan requiring a decision, or uncertain/recovering runtime must not be silently swept to Done by idle cleanup.
9. A new actionable blocker is distinct from replaying an already acknowledged attention episode.
10. Stale timers must lose to a newer move, acknowledgement, interaction, re-snooze, archive, or delete.
11. Timer operations must be idempotent and guarded against races between clients and the scheduler.
12. Pending snooze and idle work must survive process restarts without relying on browser intervals or in-memory-only callbacks.
13. Closing the desktop/server cannot deliver a reminder while nothing is running. Overdue reminders are reconciled on the next server start; do not promise execution during shutdown.
14. Use indexed, bounded metadata queries, not full conversation loads, event-history scans, or repeated full orchestration snapshots.
15. Toggling the sidebar arrangement must not change thread history, project membership, provider session, archive state, or pin state.

## 4. Recommended product decisions to make explicit

These are implementation defaults to resolve unspecified edges, not changes to settled requirements:

- Store state globally for a thread, independent of which arrangement a client displays. Keep the layout preference separate from organization metadata.
- Once enabled, automation should not depend on which layout happens to be visible. Use a separate settings switch to pause automatic idle cleanup.
- Give existing threads a full initial grace period when idle automation is first activated; do not instantly move old threads using historical message ages.
- Treat explicit opening of a Needs you thread as acknowledgement, alongside replying, answering, or making an approval decision. Record the origin of the interaction so background route restoration does not count.
- Opening a thread acknowledges attention, not its outstanding provider requests. Pending blockers continue to prevent idle cleanup.
- For snoozed Later threads, intentional browsing alone is not a wake action; sending work, responding to a blocker, cancelling snooze, or explicitly moving the thread is.
- A fresh blocking approval/input request overrides a snooze and requires attention immediately; clear the old snooze so it cannot later fire again. Non-blocking provider output does not override it.
- Existing manual organization remains meaningful while a provider continues working. Only idle cleanup requires a confirmed quiescent runtime.
- New threads start in Present. Branches get fresh organization metadata rather than inheriting a parent's snooze/deadline.
- No new state icons, provider badges, or persistent row decorations are required for snooze; use existing tooltips/menu details for its wake time.
- User-facing notification text should describe movement/reminders, not claim task success from inactivity.

## 5. Verified architecture and reuse

The planning agent investigated the current checked-out branch read-only. The following are existing files, not proposed paths. Line references describe the investigation-time tree and may shift during implementation.

| Concern                     | Existing touchpoint                                                                                   | Implementation consequence                                                                                                                              |
| --------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical thread            | `packages/contracts/src/orchestration/orchestration.thread.ts:276–331`                                | Add organization separately from session, archive, pin, recovery, queue, and deletion fields.                                                           |
| Summary/catalog             | `packages/contracts/src/orchestration/orchestration.catalog.ts:48–77,134–144`                         | Carry organization through summaries; the existing sidebar catalog is not a complete cross-project listing.                                             |
| Transactional commands      | `apps/server/src/orchestration/Layers/OrchestrationEngine.commandProcessing.ts:124–227`               | Reuse command receipts, payload digests, event append, and projection sequencing.                                                                       |
| Sparse hydration            | `apps/server/src/orchestration/Layers/OrchestrationEngine.hydration.ts:40–84`                         | Hydrate exact authorized threads; never assume every thread is resident.                                                                                |
| Persisted thread projector  | `apps/server/src/orchestration/Layers/ProjectionPipeline.projector.threads.ts:74–203`                 | Extend the existing projector with an extracted organization helper.                                                                                    |
| Projection bootstrap        | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts:171–227`                                  | Respect existing cursors and retained-event gaps; do not start a new projector from zero against incomplete history.                                    |
| Thread SQL repository       | `apps/server/src/persistence/Layers/ProjectionThreads.ts:63–313`                                      | Explicit insert/select/normalization paths all need the new fields. The inspected file already has 401 lines: split by concern before material editing. |
| Baseline capture/restore    | `apps/server/src/persistence/Layers/ProjectionBaselines.ts:67–89,177–217`                             | Existing dynamic projection-column handling favors columns on the thread projection, with an explicit legacy-restore test.                              |
| Scheduler patterns          | `apps/server/src/orchestration/Layers/SchedulerReactor.ts:156–242`                                    | Reuse bounded due-work/scoped-loop patterns, not scheduled prompt/model execution.                                                                      |
| Durable safety predicates   | `apps/server/src/persistence/Layers/ThreadRetentionRepository.eligibility.ts:50–94`                   | Reuse suitable execution/admission/pending-work checks, not retention's complete policy or pin exclusions.                                              |
| Accepted provider facts     | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.processor.runtime.ts:98–233`           | Consume facts after existing ownership/epoch fences, not raw provider callbacks.                                                                        |
| Existing thread row         | `apps/web/src/components/sidebar/SidebarThreadRow.tsx:145–329`                                        | Reuse its first-line content and conditional status/actions.                                                                                            |
| Existing drag payload       | `apps/web/src/components/sidebar/SidebarThreadRow.tsx:166–176`                                        | Preserve copy-style drag-to-chat attachment behavior while adding organization drops.                                                                   |
| Section styling             | `apps/web/src/components/sidebar/SidebarSectionLabel.tsx:17–20`                                       | Reuse plain headings, spacing, typography, and collapse treatment.                                                                                      |
| Menu contract               | `packages/contracts/src/server/ipc.ts:30–36`                                                          | Currently flat; submenus and checked items require a shared contract extension.                                                                         |
| Native menu                 | `apps/desktop/src/window/ipcHandlers.contextMenu.ts`                                                  | Add bounded recursive items/checkmarks without duplicate destructive separators.                                                                        |
| Browser menu                | `apps/web/src/utils/context-menu/fallback.utils.ts`                                                   | Add the same interaction, focus, checked-item, and dismissal behavior.                                                                                  |
| Agent rename implementation | `apps/server/src/orchestration-tools/ThreadOrchestrationTools.rename.ts:10–80`                        | Reuse authenticated participant resolution and invocation-derived command identities.                                                                   |
| Settings persistence        | `apps/server/src/ws/serverSettings.ts:72–78,212–230`                                                  | Subscribe to persisted settings changes rather than polling a separate file.                                                                            |
| Bounded web bootstrap       | `apps/web/src/routes/-__root.bounded-bootstrap.ts:43–175`                                             | Preserve sequence-aware bootstrap instead of adding a full-snapshot dependency.                                                                         |
| Catalog refresh             | `apps/web/src/routes/-__root.sidebar-catalog.ts:32–85`                                                | Extend bounded refresh and reconcile live events versus late pages.                                                                                     |
| Workflow status             | `apps/server/src/orchestration/ThreadWorkflowStatus.logic.ts:270–277`                                 | Technical workflow completion follows turn settlement; it is not semantic task completion.                                                              |
| Technical finalizer         | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.processor.runtime.completion.ts:19–50` | Do not use message/turn finalization to automatically ask a completion question.                                                                        |
| Sleep epochs                | `apps/server/src/system-sleep/Services/SystemSleepEpochs.ts`                                          | Reuse startup/wake information for idle safety barriers.                                                                                                |
| Capability context          | `apps/server/src/orchestration/Layers/ProviderCommandReactorSessionOps.capabilityContext.ts`          | Provide current organization on ordinary input without starting extra turns.                                                                            |
| OpenCode V2 boundary        | `apps/server/src/provider/Layers/OpencodeV2/Execution.orchestration.ts:11–46`                         | Explicit action enumeration and versioned protocol/plugin integration need separate coverage.                                                           |
| Sidebar navigation          | `apps/web/src/components/sidebar/Sidebar.navigation.tsx`                                              | Update visible-order navigation without losing existing shortcuts and selection behavior.                                                               |

Follow the repository's existing Effect services/layers, contract subpaths, migration registry, and dot-notation module structure. Do not introduce a parallel application architecture or new dependency for this feature.

## 6. Canonical data model

### Organization versus runtime

Add a dedicated organization schema exposed on full threads, operational detail, and bounded summaries:

| Field        | Proposed meaning                                                                                                                             |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`      | `present`, `needs-you`, `later`, or `done`; UI labels and order remain fixed.                                                                |
| `revision`   | Monotonic organization version, tied to accepted organization events; legacy default zero.                                                   |
| `changedAt`  | Server-stamped last organizational mutation; nullable for legacy rows rather than inventing history.                                         |
| `activityAt` | Last qualifying activity anchor; distinct from generic `updatedAt` and retention activity.                                                   |
| `snooze`     | Null or `{ id, until }`: a unique occurrence and absolute UTC deadline.                                                                      |
| `attention`  | Null or a small typed ordinary-question/task-completion marker with occurrence ID, source reference, raised time, and acknowledgement state. |

Native approvals and structured user-input payloads stay in their existing authoritative projections. Organization must not duplicate their complete contents or invent responses.

The ordinary-attention marker covers a real gap: a question in prose may not exist in provider pending-input tables. A completion choice therefore needs an explicit signal, not text matching.

Keep rebuildable scheduling columns distinct from canonical organization: due time, applied policy generation, activity/schedule generation, and optional retry/not-before time. Updating a derived schedule is not a new canonical move.

### Commands and events

Define explicit schemas for move, snooze, human acknowledgement, ordinary-attention signalling/resolution, and internal idle/expiry transitions. Reuse existing accepted human/provider events for activity where sufficient; add an activity event only where a qualifying fact is otherwise missing.

- The server supplies trusted caller/source, timestamp, and absolute deadline.
- Record the resulting state and reason in accepted events.
- Replay applies recorded values; it never consults the current clock or starts timers.
- Internal timer operations are not unrestricted public RPC commands.
- Use exact-thread hydration before authorized operations against cold threads.
- Generic metadata/session upserts must preserve organization instead of overwriting it with defaults.

### Transition table

| Trigger                                           | Result                                               | Important guard                                                                                             |
| ------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Create/branch                                     | Present; no inherited snooze or unresolved attention | Preserve normal project/lineage behavior.                                                                   |
| Explicit Move to                                  | Requested state; cancel snooze                       | Does not stop execution or answer native prompts.                                                           |
| Move to Present again                             | Present with fresh idle budget                       | Treat as an intentional refresh, not a no-op if a schedule must change.                                     |
| Snooze                                            | Later; replace deadline/occurrence                   | Duration 2–1440 integer minutes.                                                                            |
| Matching expiry                                   | Needs you; consume snooze                            | Expected revision, occurrence, deadline, and active lifecycle still match.                                  |
| Deliberate open of Needs you                      | Present; acknowledge observed attention              | Preserve unresolved blockers; stale opens cannot acknowledge newer attention.                               |
| Browse Later/Done                                 | No state change                                      | Includes merely browsing a snoozed Later thread.                                                            |
| Accepted direct human work/response               | Present; cancel snooze; refresh activity             | Use trusted origin, not the stored message role alone.                                                      |
| New approval/input request                        | Needs you; cancel older snooze                       | Deduplicate by request identity; an existing deferred request must not repeatedly undo a later user choice. |
| Agent signals ordinary question/completion choice | Needs you with attention marker                      | Explicit current-task signal; not inferred from every turn.                                                 |
| Provider output/settlement                        | Refresh relevant safety/activity facts               | Does not undo Later/Done or prove semantic completion.                                                      |
| Eligible idle timeout                             | Configured Done or Later                             | All durable execution and attention gates pass.                                                             |
| Archive/delete                                    | Existing lifecycle behavior; invalidate timers       | Do not expose stale scheduled moves.                                                                        |
| Unarchive                                         | Present; fresh idle budget; no revived snooze        | Do not restore an expired reminder.                                                                         |

Pinning remains orthogonal: it neither creates a fifth state nor exempts a thread from the configured idle policy.

## 7. Interaction and precedence rules

### Acknowledgement

Send an explicit acknowledgement following deliberate row activation, keyboard opening, or a user-activated search result/notification that opens the conversation. For remote threads, acknowledge after the existing access gate succeeds.

Do not acknowledge startup route restoration, reconnect/hydration, background tab activity, hover, copying, context-menu opening, selection ranges, dragging alone, status tools, or agent-to-agent messages.

Bind an acknowledgement to the organization revision and attention occurrence the user saw. If a newer prompt arrives first, the stale acknowledgement must not consume it; do not retry it blindly against the new revision.

An unresolved ordinary question can be answered by accepted direct human input explicitly bound to its occurrence. Native approval/input resolution always uses existing response paths. An explicit completion choice resolves its completion marker. Provide a deterministic dismissal/Keep Present action so a completion marker cannot protect an abandoned thread forever.

### Snooze browsing decision

The repository planner suggested cancelling snooze on opening. This plan instead keeps the conservative behavior stated in Section 4: **browsing a snoozed Later thread does not cancel it**. Sending/responding, cancelling snooze, or explicitly moving it does. This is an explicit proposed product default, not a previously user-confirmed rule.

### Precedence

1. Archived/deleting/deleted lifecycle suppresses scheduled organization changes.
2. A newer organization revision invalidates older timer work.
3. A genuinely new blocking request overrides an earlier snooze.
4. An explicit later snooze may consciously defer an already-existing request.
5. Opening Needs you acknowledges attention but leaves unresolved requests protected from idle cleanup.
6. Background provider output does not override explicit Later/Done organization.
7. Accepted new human work returns the thread to Present.

## 8. Atomicity and idempotency

Route operations through the existing serialized command/receipt/event path. Scheduler prechecks improve efficiency but are not the correctness boundary.

### Snooze expiry fencing

Carry thread ID, expected organization revision, snooze occurrence ID, and deadline. Recheck all of them and lifecycle state inside command application. Clear and move once, or return a typed superseded/no-op outcome.

### Idle fencing

Carry expected organization revision, activity/schedule generation, policy generation, and due time. Recheck the current policy and authoritative execution/attention state before committing the move.

Do not hold SQL transactions open across provider or network inspection. Admission and idle movement must have a demonstrated atomic ordering boundary: committed work admission blocks the idle move; if the idle move commits first, subsequently accepted human work activates Present.

Some runtime facts are outside the orchestration projection. Verifying that ordering boundary is a release gate for automation, not something to assume from a best-effort precheck. Keep unknown/contradictory state ineligible until resolved.

### Command identity

- Tool identities follow rename's authenticated caller/provider/invocation/operation pattern.
- Changed arguments under an existing invocation ID fail the existing digest check.
- Retrying the same invocation returns the original result.
- Convert snooze duration to an absolute deadline once inside receipt-controlled handling; retries cannot extend it.
- Timer command IDs identify the deadline occurrence/generation, not the scheduler tick.

The guarantee is exactly-once observable movement under at-least-once processing, not exactly-once process execution.

## 9. Storage, compatibility, and bounded queries

### Migration and replay

Prefer typed columns on `projection_threads` to introducing a new mandatory baseline table. Extend explicit row schemas, normalizers, inserts, selects, summaries, snapshots, selected detail, operational hydration, and relevant mobile mappings.

Register the next migration in `apps/server/src/persistence/Migrations.ts`, choosing its number from the implementation-time tree rather than reserving the planner's inspected number.

- Old events/snapshots/details decode as Present, revision zero, no snooze, no attention.
- Add handlers to both the in-memory projector and existing persisted thread projector.
- Do not reset projection cursors or replay all retained history to initialize the feature.
- Do not force compaction or baseline creation to enable the view.
- Verify a pre-feature baseline restores new fields through SQL defaults and does not retain stale derived deadlines.
- Organization-only changes do not alter retention eligibility/activity or project recency unless they also represent real qualifying work.
- Done must never be interpreted as permission to archive, retain less history, or purge.

### Indexes and activation

Add appropriate indexes for active state membership/keyset order, snooze deadlines, current-generation idle due work, and Present rows requiring policy-generation recalculation. Use partial indexes where actual lifecycle predicates permit.

Activation/settings changes allocate persisted policy generation and activation time. Recalculate schedules in bounded resumable metadata batches; old-generation schedules are inert. Newly armed threads receive a full timeout.

A useful SQLite index requires a one-time scan of its indexed projection table. Measure that migration and WAL growth on a representative database copy. This is not permission for recurring transcript/event-history scans or a full orchestration snapshot, especially with large packaged-macOS userdata.

### Complete, bounded organization catalog

Do not group only the current sidebar store: it contains partial membership and can omit threads from unloaded projects.

Add a query returning sequence, requested state pages, per-state keyset cursor/`hasMore`, summaries, and minimal project/location references. Do not use offset pagination or run global counts on every refresh/tick.

Default within-group ordering should reuse existing activity-recency semantics with a stable thread-ID tie-breaker; if pinned-first treatment is retained, keep it consistent and avoid duplicate state rows.

Keep catalog membership/page state separate from hydrated conversations. Merge live moves immediately; invalidate affected page boundaries. Late page responses must not restore stale membership over newer events. Retained-event gaps cause bounded catalog/detail resynchronization, not a full snapshot.

## 10. Server-owned scheduling and idle policy

### Ownership

Use a dedicated organization reactor with existing Effect service/layer/scoped-fiber patterns. The authoritative bigbud server that owns the thread metadata owns its timers. A remote execution workspace is not automatically a separate metadata owner.

UI clients only observe state. Do not implement timers in a component, browser interval, provider process, model loop, or general prompt scheduler.

### Eligibility

An idle candidate must be active, Present, past its due time and safety barriers, with no unresolved attention and confirmed quiescent execution. Check applicable durable facts for:

- Runtime/projected sessions, running/starting turns, and tool activity.
- Admissions, queued prompts, pending starts, and queue holds.
- Pending interrupt/control/flush work.
- Execution leases, active automation runs, and pending/in-progress execution tasks.
- Native approvals, structured input, ordinary attention, and actionable proposed plans.
- Recovery, remote uncertainty, and contradictory health/liveness facts.

Use authoritative pending projections, not a truncated list of recent activities. Reuse appropriate retention/supervisor predicates without copying retention's unrelated policy.

`activityAt` is not `updatedAt`: rename, pin, telemetry, hydration, and catalog refresh do not keep a thread active. Do not append an organization event for every streamed token or heartbeat. Existing accepted execution facts and meaningful transition edges should supply activity anchors.

When execution ends or uncertainty clears, start a fresh full timeout rather than consuming a deadline accumulated while work was running. A deliberately opened thread with an unresolved prompt remains protected even though it is now Present.

### Loop and recovery

- Start after projection bootstrap and initial runtime reconciliation.
- Subscribe to relevant accepted events and persisted settings changes.
- Query indexed due work in bounded batches and use bounded concurrency.
- Back off blocked candidates so an overdue row does not cause a hot loop.
- Reconcile indexed dirty/current-generation metadata on startup and periodically.
- If claims/leases are needed, make them expiring and derived; revision/receipt fences remain final authority.

A practical initial target is a five-second cadence, batches near 50, and concurrency near three, subject to focused measurement. These are proposed tuning values, not delivery guarantees.

On startup, wake, or a long event-loop discontinuity, reconcile provider ownership, give idle candidates a fresh timeout barrier, and process overdue snoozes after bootstrap. Never assume a missing local provider process means remote work is finished.

Snooze uses UTC wall-clock deadlines. A forward clock adjustment may make it due; a backward adjustment delays it. Idle additionally uses awake/startup/wake barriers so sleep or clock jumps do not immediately clear Present.

No owner process means no timer execution. On recovery, overdue snoozes move once to Needs you without launching an agent.

## 11. Settings and first-use behavior

Add a focused Threads subsection in General, separated from destructive retention settings:

| Control                | Proposed behavior                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| Automatic idle cleanup | User-controlled on/off; enabled for the Ìtútù experience after explicit first-use activation. |
| Idle timeout           | Default 10 minutes; integer minutes; minimum 1.                                               |
| Idle destination       | Done by default; only Done or Later accepted.                                                 |
| Layout preference      | Projects or Ìtútù; persisted separately from automation.                                      |

Do not start moving existing users' threads merely because an upgrade installed new columns. First-use activation is explicit and starts a full grace period; after activation, changing the visible arrangement does not implicitly toggle the server's automation policy. Clearly describe this in the settings/help text.

This reconciles the requested automatic behavior with a safe upgrade: existing installations remain unactivated until the user opts into Ìtútù. The first-use mechanism and existing settings persistence scope must be verified before UI wiring; do not add a new onboarding flow if a simple explicit enablement in existing settings suffices.

The server owns idle policy and per-thread organization. Reuse existing client preference persistence for arrangement/collapse state, respecting server/profile scoping. Handle settings write errors; do not show a policy as active before persistence succeeds.

## 12. Agent capabilities, transports, and completion

### Canonical tools

Propose `move_thread` and `snooze_thread`, implemented through the same server transition path as UI operations.

- Move: destination plus optional authorized target; optionally include a typed ordinary-attention signal for the current thread when moving to Needs you.
- Snooze: integer duration 2–1440 minutes plus optional authorized target.
- Return canonical target ID, organization state/revision, relevant snooze/attention details, command ID, and resulting sequence.
- Default target to authenticated caller's thread.
- Apply existing eligible same-project/direct-delegation target resolution, workspace binding, token TTL, and provider permission policy.
- Reject archived/deleting/deleted targets instead of silently unarchiving them.
- Keep ordinary-question/completion signalling current-thread scoped initially.
- Never treat an attached ID or a global pinned result as authorization by itself.

Source/actor authority comes from the authenticated tool context, not tool-supplied claims. A current-state field in a tool result is information, not authorization to perform further moves.

### Transport parity

Extend shared definitions, canonical dispatcher, HTTP action schema, and explicit HTTP handlers before wiring every supported transport:

- Codex dynamic tools/MCP.
- Claude MCP and explicit allowed-tool list.
- Copilot SDK tools.
- OpenCode tools/MCP.
- Pi generated bridge.
- Cursor/Devin ACP bridges.
- Muse MCP bridge.
- OpenCode V2's versioned protocol/plugin boundary.

The inspected HTTP route includes an archive fallback: add explicit new action branches and exhaustiveness tests so move/snooze cannot fall into archive. Preserve token ownership, invocation fencing, body limits, transport boundaries, and permission modes; no wildcard grants or generic bypasses.

Version OpenCode V2 compatibly, preserving frozen implementations. Generic MCP changes alone do not prove feature coverage there. Split generated bridges at their generator/source boundary to respect file limits.

### Discovery and live awareness

Expose organization in authorized status/list results, selected-thread context, tool results, capability guides/catalog, and the standard capability reminder path. Refresh dynamic state on normal provider input even if the static catalog revision is unchanged. Do not run a new model turn when another client or a timer moves a thread.

### Actual task-completion confirmation

Use an instruction contract equivalent to:

> When the requested task is actually complete, ask whether the user wants this thread moved to Done or Later. Ask as part of the existing response. Do not ask merely because a response or provider turn ended. Do not choose the destination without their choice unless they already explicitly authorized it.

For reliable confirmation:

1. Agent explicitly signals a typed completion-attention occurrence through the canonical organization path.
2. It asks the question in the same existing response.
3. Needs you/attention protects the unanswered choice from idle cleanup.
4. A deterministic Done/Later/Keep Present action strip can resolve the marker without generating an extra assistant response or model invocation.
5. A textual human answer can use the ordinary response/tool path, bound to that occurrence.
6. Deduplicate repeated signalling for the same source task/turn; a real new task may create a new occurrence.

If the user has already told the agent to move the completed task to a specific state, follow that instruction instead of asking redundantly. Record the normal move through the authorized tool.

Do not implement semantic completion with `turn.completed`, `end_turn`, workflow-complete status, regexes over the final answer, or an extra classifier call. Arbitrary uninstrumented prose cannot be detected perfectly; document explicit signalling as the reliability boundary and test it across transports.

## 13. Sidebar/menu implementation details

### Layout and rows

Replace only the thread-arrangement portion, preserving shared header, fixed actions, settings access, and footer. Use one constrained scroll viewport with an inner minimum-height layout: Present, then a wrapper for Needs you/Later/Done with `margin-top: auto`. When content overflows, the spacer collapses and all groups scroll normally.

Extract reusable first-line row content rather than copying `SidebarThreadRow` into a second implementation. Add a mode-specific second line only.

Location must reflect the workspace, not the provider runtime; these can differ. Existing reference points are `apps/web/src/components/sidebar/Sidebar.remoteWorkspaces.logic.ts:163–188` and `apps/web/src/components/sidebar/Sidebar.remoteThreadActivation.ts:31–50`. Use configured display names/safe fallbacks, not raw connection strings. The row should say only the requested project/VPS name or Chat; do not add an unnecessary `Local PC ·` text prefix beside the PC icon.

### Snooze within the agreed menu

Keep the top-level menu from Section 1 exactly ordered. Inside Move to, use:

1. Present
2. Needs you
3. Later
4. Done
5. Separator
6. Snooze…

A snoozed thread is checked as Later. Snooze opens a small picker with 2m, 5m, 10m, 30m, 1h, 4h, 8h, 24h presets and custom integer minutes in the supported bounds. While snoozed, expose its wake time, rescheduling, and Cancel snooze without adding a persistent row badge. Cancel snooze activates Present; an explicit Move to Later cancels the timer but deliberately keeps Later.

### Native/browser submenu contract

Extend shared menu items with bounded recursive children and checked/radio state. Normalize depth and item counts, require unique action IDs, preserve disabled states, and deduplicate separators around destructive items. Implement native Electron and browser fallback together, including arrows, Enter, Escape, focus restoration, dismissal, submenu positioning, and touch access.

### Dragging and navigation

Add an organization payload while retaining existing thread-context/text payloads. State drops dispatch authorized moves; conversation drops continue to attach context. Do not trust arbitrary dropped IDs.

For multi-select movement/snooze, bound batches, dispatch per-thread operations, and surface partial/stale failures rather than pretending the entire batch succeeded. Use current visible arrangement order for range selection, previous/next navigation, and mod+1…9; do not keep project-only ordering in Ìtútù.

## 14. Proposed module boundaries and phases

The following names are proposed new modules, not files claimed to exist:

| Responsibility                    | Proposed location/pattern                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Organization definitions          | `packages/contracts/src/orchestration/orchestration.organization.ts`                                                |
| Command/event definitions         | Separate organization command/event modules beside existing schemas                                                 |
| Transition decision               | `apps/server/src/orchestration/deciderThreads.organization.ts`                                                      |
| In-memory projection              | `apps/server/src/orchestration/projectorThreadOrganization.ts`                                                      |
| Persisted organization projection | `apps/server/src/orchestration/Layers/ProjectionPipeline.projector.threads.organization.ts`                         |
| Due work/eligibility/recovery     | Separate organization reactor, eligibility, and reconciliation modules following existing service/layer conventions |
| Bounded group query               | `apps/server/src/orchestration/Layers/ProjectionCatalogQuery.organization.ts`                                       |
| Agent surface                     | Focused shared definitions plus organization tool handlers beside existing thread tools                             |
| Sidebar                           | Separate arrangement control, state groups, location line, and menu builder                                         |
| Settings rows                     | `apps/web/src/components/settings/ThreadOrganizationSettingsRows.tsx`                                               |

Keep new/materially edited source and tests at 400 lines or fewer. Extract existing near-cap files by concern first. Plans are documentation and are not subject to the code-file limit. Do not sweep unrelated changes into these extractions.

### Phase 0 — Confirm integration seams

Verify the remaining concrete boundaries listed in Section 16, especially runtime admission versus transactional eligibility. Establish focused fixtures for old data and bounded catalogs before adding automation.

### Phase 1 — Durable manual organization

Add schemas, migration, commands, events, both projectors, legacy defaults, and serialization. Build the shared move/snooze service path and authorization tests. Keep automatic workers disabled.

Checkpoint: accepted moves survive restart/replay, match across detail/status/catalog, and do not affect provider execution or archive.

### Phase 2 — Bounded catalog and UI

Add indexed keyset state pages and sequence-aware client membership. Implement arrangement preference, bottom block, location line, complete native/browser menus, DnD, multi-selection, and navigation.

Checkpoint: threads from unloaded projects are discoverable without a full snapshot; first-line behavior and drag-to-chat still work.

### Phase 3 — Agent tool parity and attention

Wire move/snooze across all transports and discovery/context paths. Implement explicit attention signalling and completion-choice resolution. Add user acknowledgement and fresh-blocker routing.

Checkpoint: each transport moves only authorized targets; ordinary turn settlement never asks or marks semantic completion; no extra model call is introduced.

### Phase 4 — Snooze delivery and recovery

Enable indexed due processing, occurrence fencing, expiry, startup recovery, rescheduling, cancellation, lifecycle invalidation, and early-response/new-prompt precedence.

Checkpoint: downtime and duplicate processing yield one observable reminder; stale deadlines cannot override newer actions.

### Phase 5 — Idle policy

Add General → Threads controls, explicit activation, bounded policy-generation recalculation, runtime eligibility, transactional admission checks, and startup/sleep barriers.

Checkpoint: every execution/attention/recovery blocker independently prevents cleanup; default/minimum/target settings behave correctly without large scans.

### Phase 6 — Release validation

Complete platform, multi-client, remote-owner, packaged-database, performance, and transport compatibility checks. Document the verified setup/behavior after implementation passes, without replacing existing docs unnecessarily.

## 15. Focused test and release matrix

These are required implementation checks, not tests claimed to have passed during planning.

| Area                 | Required cases                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compatibility/replay | Old events/snapshots; pre-feature/current baseline; retained-event gap; deterministic timestamps; no scheduler side effects on replay.                                                |
| Moves                | Every state pair; same-state Present refresh; running-agent move; unresolved native input preserved; Done distinct from Archive.                                                      |
| Authorization        | Current thread; eligible same-project/delegated child; forbidden/archived/deleting target; forged actor; expired token; invocation argument mismatch.                                 |
| Snooze               | Inclusive 2m/24h bounds; invalid durations; immediate Later; re-snooze; cancel; open-without-cancel; actual early response; downtime; duplicate workers.                              |
| Races                | Expiry versus response/move/archive/delete; stale acknowledgement versus new prompt; old deferred versus genuinely new prompt; admitted work versus idle cleanup.                     |
| Attention/completion | Explicit opening versus background restoration; pending request remains unresolved; deduplicated completion question; deterministic action resolution; no ask on ordinary settlement. |
| Idle                 | Minimum/default timeout; Done/Later targets; disabled policy; activation/settings grace; startup/wake barriers; each execution/task/lease/attention gate independently.               |
| Provider fencing     | Late old-session/turn events do not create false activity/attention; unknown remote work is not considered idle.                                                                      |
| Catalog/store        | Keyset ties; unloaded projects; bounded pages; stale response after live move; reconnect/replay gap; no duplicate/lost rows.                                                          |
| Menus                | Exact ordering; checkmarks; native/browser parity; bounded input; separators; keyboard/focus; snooze picker; partial multi-select failure.                                            |
| UI                   | Empty/collapsed groups; large middle whitespace; overflow; restored preference; correct workspace location; existing row actions/status; drag-to-chat preserved.                      |
| Settings             | Validation/persistence errors; scope; policy generation; first activation; view toggle does not secretly disable automation.                                                          |
| Scale                | Index/query plans; bounded activation/recovery; no message/event-history scan/full snapshot; migration time and WAL growth measured on representative copied data.                    |

Manual smoke checks:

- macOS packaged: native submenu/checkmarks, Cmd shortcuts, sleep/wake, and representative large-database upgrade.
- Windows: native menu, Ctrl shortcuts, DnD, bridge path/executable handling, restart.
- Linux and browser: native/fallback menus, keyboard access, constrained scrolling, sleep/resume where supported.
- Two clients: stale-open/new-attention, competing moves, and snooze races converge to authoritative server state.
- Remote workspace/provider combinations: location is correct, access failure does not acknowledge, uncertain execution blocks idle, and owner restarts reconcile safely.
- Owner stopped: no false promise of background delivery; restart applies overdue snoozes once.

Run explicit-file formatting/lint/length checks, affected-package configured typechecks, and focused Vitest/browser tests only. Server tests stay sequential. Never run `bun test`. Obtain fresh approval before any full-suite/workspace-wide validation, commit, or push.

## 16. Remaining implementation verification gates

The architecture is grounded in the inspected files, but these details must be proven while implementing rather than represented as completed work:

1. Exact RPC/export registrations and every mobile/snapshot mapper carrying organization.
2. Legacy baseline restore defaults for new columns and derived schedules.
3. Atomic ordering between idle application and runtime admissions outside the main event projection.
4. Existing client preference namespacing by server/profile.
5. OpenCode V2's exact backward-compatible action/protocol/plugin version change.
6. Existing General → Threads component wiring and the smallest explicit first-use activation mechanism.
7. Real query plans and migration behavior on representative packaged userdata, without modifying live user data for tests.

None requires a new architecture or a broad repository rewrite. Manual organization and UI can proceed while the automation-specific gates are resolved; automatic cleanup must not ship until its eligibility/race tests pass.

## 17. Planning verification and implementation handoff

The planning agent performed read-only repository investigation. No production feature was implemented, no production tests were run, and no commit/push was made. Only this plan and the previously requested prototype are authored deliverables of this thread so far.

Implementation should follow the phase checkpoints above, preserve all unrelated working-tree changes on the checked-out branch, and not create a worktree unless explicitly requested. Each phase should report its exact focused checks and any remaining unverified platform/transport behavior.

## 18. Worktree integration log

Implementation runs on branch `feature/itutu-mode` in the worktree `../bigbud-itutu`, created from `feature/computer-use` at `5ae5cc00ca`. The original checkout keeps its uncommitted backend work. At every phase checkpoint, compare the original checkout's working tree with the previous checkpoint snapshot (stored outside the repository in the worktree's git directory), record overlap and behavioral dependencies here, and integrate committed upstream work into this branch before starting work that depends on it.

### Checkpoint 0 — worktree creation

- Original checkout: 111 uncommitted files (106 backend source/test files: Codex reliability, provider inspection/recovery, checkpointing, rewind; plus the Ìtútù plan and prototype, copied here).
- No migrations among them; the next free migration number was 141.

### Checkpoint 1 — Phase 1, durable manual organization

Implemented here:

- Contracts: `orchestration.organization.ts` (states, snooze bounds 2–1440 minutes, `ThreadOrganization`, move/snooze commands, `thread.organization-updated`), wired into the thread read model, client command unions, and the event union. Legacy threads decode as Present at revision 0.
- Migration 141 adds `organization_*` columns to `projection_threads` with Present defaults; no backfill, no index yet (indexes belong to the phases that query them).
- Decider `deciderThreads.organization.ts` with pure transitions in `threadOrganization.logic.ts`. Archive cancels a pending snooze and unarchive returns the thread to Present, each recorded as an additional `thread.organization-updated` event, so replay never consults the clock.
- In-memory and persisted projectors apply the recorded organization. Organization events do not advance retention activity or project recency.
- Every thread hydration query selects organization through one shared SQL fragment (`threadOrganizationJsonSql`).
- `ProjectionThreads.ts` was split (row schemas moved to `ProjectionThreads.rows.ts`) before editing.

Not in Phase 1, by design: agent tools and authorization (Phase 3), UI and catalog (Phase 2), timers (Phases 4–5). The shared transition path that all of them must use is the decider above.

Original checkout since checkpoint 0: 143 uncommitted files. New workstream: provider session/MCP controls (`codexAppServerManager.controls*`, `ProviderService.controls*`, `wsRpcHandlers.providerControls*`, `ProviderSessionControls*` UI, `rpc.providerControls.ts`), with edits to `packages/contracts/package.json`, `server/rpc.ts`, `server/ipc.nativeApi.ts`, `ws/ws.ts`, `rpc/wsNativeApi.ts`, `rpc/wsRpcClient*.ts`, and `ChatHeader.tsx`.

- File overlap with this branch: none.
- Still no new migrations there; 141 remains free. Recheck before merging.
- Plan adjustment for Phase 2: add the organization catalog RPC as its own `rpc.*` module and handler file, so the shared `rpc.ts`, `wsNativeApi.ts`, and `wsRpcClient*.ts` edits stay to single registration lines that are easy to merge with the provider-controls work.

### Checkpoint 2 — before Phase 2

- Phase 1 committed as `b5c3792855`. `feature/computer-use` has no new commits since `5ae5cc00ca`, so there is nothing to integrate yet.
- Original checkout: 145 uncommitted files, still the backend reliability work plus provider session/MCP controls (now with browser and unit tests). It touches no sidebar, context-menu, catalog, store, or migration files.
- Expected Phase 2 overlap: one-line registrations in `packages/contracts/src/server/rpc.ts` and `constants/websocket.constant.ts`, and possibly `rpc/wsNativeApi.ts` / `rpc/wsRpcClient*.ts`. Keep these to single lines.

### Phase 2 refined design (from the checkpoint 2 investigation)

Findings that shape the design:

- The web client only knows a bounded subset of threads: startup loads built-in Chats recents, pinned threads, two local projects, one remote project, and per-project pages of five. Pinned threads from unloaded projects already appear through summaries that carry no project membership; organization pages follow that precedent.
- `ThreadSummary`, the web `Thread`/`SidebarThreadSummary` types, and their mappers carry no organization. The web ignores `thread.organization-updated`.
- Context menus are flat in the contract, the Electron handler, and the browser fallback. The Electron handler strips unknown fields.
- Thread rows use HTML5 drag with a copy-only thread-context payload for dropping into chat.
- UI preferences are hand-persisted to `bigbud:ui-state:v1` without per-server namespacing.
- Navigation order (`Sidebar.renderedProjects.ts`) is chats then project threads.

Server and contracts:

1. Add `organization` to `ThreadSummary` (defaulting field). Move the duplicated thread-summary column list from the sidebar and project-page queries into one shared SQL fragment that also selects organization, so every summary carries it.
2. New contract module `orchestration.catalog.organization.ts`: `getOrganizationThreadSummaries({ state, limit?, cursor? })` returns `{ projectionSequence, state, threads, nextCursor? }`. Default page 20, maximum 50. Keyset order `updated_at DESC, thread_id ASC`, the same as project pages. It covers active, non-deleting, unarchived standard threads from every project, including Chats.
3. Migration 142: partial index on `(organization_state, updated_at DESC, thread_id)` for active rows.
4. RPC in its own `rpc.organization.ts` contract module and `wsRpcHandlers.organization.ts` server module, with single-line registrations in shared files.

Web:

5. Map `organization` into `Thread` and `SidebarThreadSummary`, including the summary-equality check. Apply `thread.organization-updated` to known threads and summaries.
6. A dedicated organization membership store (ids per state, per-state cursor, load status, projection sequence). Page summaries are upserted into the summary map without project membership, like pinned threads. Live events move ids between states immediately; a page response older than the last applied event cannot restore stale membership. An event for an unknown thread refreshes that state's first page.
7. Arrangement (`projects` | `itutu`) and collapsed Ìtútù groups persist through the existing UI-state persistence.
8. Ìtútù layout replaces only the section list inside `SidebarNavigation`: Present at the top, then a `margin-top: auto` block with Needs you, Later, and Done in one scroll viewport. Plain `SidebarSectionLabel` headings without icons, collapsible, each with "Show more" when the state has another page. The arrangement toggle lives in the fixed actions row, not the drag-region header.
9. Rows reuse `SidebarThreadRow`, adding an optional second line through a prop: location icon plus project name, remote workspace name, or Chat. The location comes from the summary's workspace target and project, with a safe fallback when the project is not loaded.
10. Context menu contract: optional `checked` and bounded `children` (one submenu level, maximum 16 items each), implemented in the Electron handler (submenu and checkbox) and the browser fallback (nested panel, keyboard and Escape). The thread menu uses the agreed order. Move to has the four states with a check on the current one, a separator, then Snooze (2m, 10m, 30m, 1h, 4h, 24h presets) and Cancel snooze while snoozed. Custom duration input follows in Phase 4 alongside the timers.
11. Drag between Ìtútù groups uses a separate organization drag MIME added to the existing payload, with `effectAllowed` `copyMove`. Group drop targets dispatch a move only for a known thread id. Drag into chat keeps working.
12. Multi-select context menu adds Move to for the selection, dispatched per thread with a partial-failure toast.
13. In Ìtútù, visible order for previous/next and mod+1..9 follows the expanded groups in display order.

Snooze expiry and idle cleanup stay disabled until Phases 4 and 5.

### Checkpoint 3 — Phase 2, catalog and sidebar

Implemented here, following the refined Phase 2 design:

- `ThreadSummary.organization`, with the two duplicated summary column lists replaced by one shared fragment (`ProjectionCatalogQuery.summaryColumns.ts`) that selects organization for every summary.
- `orchestration.getOrganizationThreadSummaries`: keyset pages per state across all projects (default 20, maximum 50), served by migration 142's partial index (verified with a query-plan test). Contract and server handler live in their own modules.
- Web: organization mapped into threads and summaries; `thread.organization-updated` applied live; page summaries merged like pinned threads without project membership; a higher organization revision always wins, so a late page cannot undo a live move; moves of threads this client has never loaded mark that state stale so the open view reloads its first page.
- Groups are derived from known summaries, so a move regroups immediately without a second membership list.
- Ìtútù UI: Projects | Ìtútù switch above New chat and Search, persisted with collapsed groups under `bigbud:itutu-ui:v1`; Present at the top and Needs you, Later, Done anchored at the bottom; existing rows with a smaller location line (Chat, local project, or remote workspace); Show more per state; drag between groups with a separate payload while drag into chat keeps working; keyboard traversal and mod+1..9 follow the visible groups.
- Context menus: optional `checked` and one bounded submenu level in the contract, Electron handler, and browser fallback (keyboard: arrows, Enter, Escape, Left; focus restored on close). The thread menu follows the agreed order with Move to. Snooze presets and Cancel snooze sit inside Move to, because menus allow one submenu level; the custom-duration picker moves to Phase 4. The multi-select menu offers Move to for the selection with a partial-failure toast.
- The Electron handler no longer emits a duplicate separator before Delete when an explicit separator precedes it.

Known limits until later phases: snoozed threads stay in Later because expiry is Phase 4; Needs you is only reached by manual moves until Phase 3; agents cannot move threads until Phase 3.

Original checkout since checkpoint 2: 154 uncommitted files, adding provider compaction and rewind-boundary work (`ProviderCompaction`, `ProviderSessionDirectory.compaction`, `codexAppServerManager.rewind.boundary`) and a provider-controls native API test. `feature/computer-use` still has no new commits.

- Overlapping files: `wsNativeApi.ts`, `wsNativeApi.test.helpers.ts`, `wsRpcClient.ts`, `wsRpcClient.types.ts`, `websocket.constant.ts`, `ipc.nativeApi.ts`, `server/rpc.ts`. Both sides only insert registration lines, at different positions (6–30 lines apart), so a merge should apply cleanly or need trivial manual resolution in `wsNativeApi.ts`.
- No migrations there; 141 and 142 remain free.
- Pre-existing, unrelated failure observed: `apps/web/src/rpc/client.test.ts` expects server settings without the Muse provider (2 tests). That file is untouched on this branch.

### Checkpoint 4 — before Phase 3

- `feature/computer-use` has no new commits. The original checkout is unchanged since checkpoint 3 (154 files). Its only file near the agent-tool area, the untracked `codexAppServerManager.capabilities.ts`, gates Codex protocol versions and does not touch tool registration.
- The original checkout is still rewriting `ProviderRuntimeIngestion*`. Phase 3 therefore does not edit ingestion; provider-driven attention consumes accepted domain events in its own reactor instead.

### Phase 3 refined design (from the checkpoint 4 investigation)

Findings that shape the design:

- No single list generates the thread tools; each transport hand-lists them and shares only description strings.
- `pin_thread` has no target authorization. `rename_thread` is the authorization model (`resolveThreadToolParticipants`, same project or direct delegated child), and `send_thread_message` is the replay model.
- The HTTP thread-tool route archives the caller's thread for any action without its own branch. A new action without a branch would archive threads.
- The command payload digest includes `createdAt`, so a retried tool call with a stable command id and a fresh `createdAt` would conflict instead of replaying.
- `resolveThreadToolParticipants` allows archived targets; send rejects them explicitly.
- OpenCode V2 has a frozen native action ABI (bootstrap v1, generated manifest) and a generic orchestration passthrough.

Phase 3a — agent tools:

1. Shared definitions in `threadOrganizationTool.shared.ts`: names, descriptions, JSON input schemas, and decoders for `move_thread` (`state`, optional `threadId`) and `snooze_thread` (`minutes` 2–1440, optional `threadId`).
2. Tool implementation in `ThreadOrchestrationTools.organization.ts`: default target is the caller; explicit targets go through `resolveThreadToolParticipants`; archived and deleting targets are refused; command ids are derived from the invocation; a replay returns the committed outcome, and a command-id conflict from a retried no-op returns the current organization instead of failing. Results carry the target id, resulting organization, and whether it changed.
3. Dispatcher: optional `move`/`snooze`, so existing mock dispatchers stay valid.
4. HTTP: explicit `move`/`snooze` branches in a separate handler module, and the fallback archives only for `action: "archive"`; every other unmatched action is a 400. A test proves unknown, move, and snooze actions never archive.
5. Transports: Codex dynamic tools, the generated MCP server (Claude, Cursor, Devin, Muse, OpenCode v1, Codex MCP), the Claude allowed-tools list (auto-approved like rename, because organizing is reversible and never touches execution), Copilot, Pi (split into its own template module), and the OpenCode V2 generic orchestration passthrough. The OpenCode V2 native ABI stays frozen in this phase; a compatible ABI version bump is recorded as an open gate, not claimed as coverage. The legacy OpenCode v1 file generator has no production importer and is skipped.
6. Discovery: `get_thread_status` and `list_threads` results include organization; capability tracks `thread.move` and `thread.snooze`, with guides that require an explicit user request or the completion flow and forbid acting on attached history; friendly tool names in the web tool presentation.

Phase 3b — attention:

7. Completion flow: the thread-context instructions tell agents to ask "Done or Later?" only when the requested task is actually complete, inside the existing response, and to call `move_thread` only after the user chooses or already said so. No end-of-turn detection, classifier, or extra model call.
8. Needs you from blockers: a dedicated reactor consumes accepted approval-requested and user-input-requested activity events and moves the thread to Needs you, deduplicated by request id, without touching ingestion. Each new blocking request cancels an older snooze through the normal move path.
9. Acknowledgement: a deliberate user open of a Needs you thread (row click, keyboard open, search result) moves it to Present, fenced by the revision the user saw. Route restoration, hydration, hover, and status reads never acknowledge. Opening never answers or approves anything.

Snooze expiry (Phase 4) and idle cleanup (Phase 5) stay disabled.

### Checkpoint 5 — Phase 3a, agent tools

Implemented here:

- `move_thread` and `snooze_thread` share one implementation (`ThreadOrchestrationTools.organization.ts`): caller-default targets, rename's same-project or delegated-child authorization, archived targets refused, invocation-derived command ids, replay from committed events, and a retried no-op returns the current organization instead of a command-id conflict.
- HTTP: explicit `move`/`snooze` handling in its own module; the route now archives only for `action: "archive"`, and every unmatched action is a 400. Tested.
- Transports: Codex dynamic tools and Copilot through one shared runner; the generated MCP server (Claude, Cursor, Devin, Muse, OpenCode v1, Codex MCP), with the generated JavaScript executed in tests; the Claude allowed-tools list; Pi through its own template module; the OpenCode V2 generic orchestration passthrough.
- Discovery: `get_thread_status` and `list_threads` include organization; `thread.move` and `thread.snooze` capability tracks (kept within the 1,200-token overview budget); thread-context instructions for the completion flow ("Done or Later?" only when the requested task is actually complete, and moving only after the user answers); friendly tool names in the web UI.
- Open gate: OpenCode V2's frozen native action ABI (bootstrap v1) is unchanged. A compatible ABI version for native move and snooze actions needs its own step following `docs/plans/2026-10-12-opencode-v2-canonical-thread-tools-plan.md`; until then V2 reaches the tools only through the generic passthrough.

Original checkout since checkpoint 4: 156 uncommitted files, continuing Codex controls, compaction, and rewind work. No new overlap; the same seven registration files remain. `feature/computer-use` still has no new commits.

### Checkpoint 6 — Phase 3b, attention

Implemented here:

- `ThreadOrganizationReactor` consumes accepted domain events, started with the other orchestration reactors. Ingestion is untouched. Its pure rules live in `ThreadOrganizationReactor.logic.ts`:
  - Approval-requested, user-input-requested, and delegated model-choice-requested activities move the thread to Needs you. Delegated model choices were added after checking that a model-choice hold also waits on the user.
  - The user's own approval or user-input response returns the thread to Present. Only the web UI dispatches those commands.
  - The user's own message returns the thread to Present: complete, not a replace, and every origin segment authored by the user. Agent, automation, and recovery text never moves a thread.
  - A prompt the user queued behind a pending request also counts. Without this, a message sent while an approval was open would never return the thread to Present. The prompt shares its key with the message sent when the queue flushes, so the flush cannot undo a later move.
- Each causing fact gets one command id derived from its key, with `createdAt` set to the event time. A repeated request id therefore never moves the thread twice, and an explicit Done survives a replayed request. A move is skipped when the thread already rests in the target state with no snooze; a pending snooze is cancelled by the move.
- Acknowledgement (`lib/threadOrganizationAcknowledge.ts`) runs on deliberate opens only: sidebar row click, keyboard thread navigation, search thread and message results, and command-palette thread items. It is fenced by the revision the user saw, deduplicated per revision, and silent on a stale revision. Route restoration, hydration, hover, and status reads do not call it.
- Tests:
  - The reaction rules.
  - An end-to-end reactor run on a real engine and SQLite: Needs you, then Present after the user's queued message, then Done surviving a replayed request, then Needs you again on a new request.
  - The reactor start order.
  - The acknowledgement fence.

Original checkout since checkpoint 5: unchanged (156 uncommitted files). Phase 3b touches none of its files. Across the whole branch, the only overlap is still the seven pure-insertion registration files and the copied plan and prototype. `feature/computer-use` still has no new commits. Migrations 141 and 142 are still free there.
