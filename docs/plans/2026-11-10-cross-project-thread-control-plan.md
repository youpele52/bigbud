# Cross-project thread control with user confirmation

**Date:** 10 November, 2026
**Status:** Implemented on `dev` (uncommitted), revision 4 (a clear user request with the target attached is the approval; otherwise plain yes/no or card); live-provider checks pending
**Owner:** bigbud server (orchestration tools)
**Created:** 2026-11-10 13:55 CET
**Last modified:** 2026-11-10 20:00 CET
**Project root:** `/Users/youpele/DevWorld/bigbud`
**Inspected:** branch `dev`, commit `68902753c1`, worktree with ~213 uncommitted entries from other work (see Plan validity)

## Summary

Let an agent in one project instruct and organize threads in any other project, local or remote, without weakening safety. Reads stay open across projects. Every cross-project write needs one explicit user confirmation. The server enforces that confirmation; the agent's own judgment is not enough. One confirmation covers the calling thread acting on any thread in that target project until the bigbud server restarts.

The confirmation uses each provider's native question tool, which already renders as bigbud's question card. If a provider can't ask a question, the user can type a short code in chat instead. No new approval UI is built.

## Related Work

- None identified. The requirement came from a chat discussion in thread `3bc9d3ed-aedb-4666-b9fd-5bb85f4491fa`; no bigbud note or Kanban card exists for it.
- Background: [Inyosira mode plan](2026-10-30-inyosira-mode-plan.md) (move/snooze tools; its line 52 states the current project restriction).

## Problem

Observed behavior (verified in source):

- **Reading across projects already works.**
  - Attaching a thread copies its history and status into the prompt with no project check (`apps/server/src/orchestration/Layers/ProviderCommandReactorSessionOps.threadContext.ts:140-215`).
  - `list_threads` accepts any `projectId` (`orchestration/Layers/ProjectionCatalogQuery.listThreads.ts:104-113`; test `ThreadOrchestrationTools.listThreads.test.ts:299-317`).
- **Instructing across projects is blocked.** `requireThreadCoordinationAccess` (`orchestration-tools/ThreadOrchestrationTools.access.ts:6-27`) allows a call only for:
  - a target in the same project, or
  - a direct child the caller created through `create_thread` (`threadDelegationRepository.findDirectByChild`).

  Everything else fails with `Thread '…' is not accessible from the current project.` This gate is applied in `resolveThreadToolParticipants` (`ThreadOrchestrationTools.participants.ts:12-58`) for `send_thread_message`, `get_thread_status`, `rename_thread`, `move_thread` and `snooze_thread`.

- **`create_thread` into another project has no gate at all** (`ThreadOrchestrationTools.createThread.ts:83-90`). The new child then counts as a direct child and can be controlled freely.

The user owns every project, so the project boundary is arbitrary from their point of view. It still blocks a legitimate workflow: instructing a thread in project B from project A.

## Settled decisions (do not reopen without new evidence)

1. **Reads are open across projects with no confirmation:** `get_thread_status`, `list_threads` and thread attachment.
2. **Writes on threads in another project need confirmation:** `send_thread_message`, `rename_thread`, `move_thread`, `snooze_thread`, and `create_thread` with a `projectId` other than the caller's.
3. **Confirmation goes through the provider's native question tool, or a plain yes reply in chat.** No new server-originated approval card UI. _(Revised 2026-11-10 after live testing: typing the exact code was too fiddly. "allow" and "I approve…" were rejected, and only "allow BB-…" worked. The user chose the "plain yes reply" strength.)_
   - **Chat:** the **latest** user-typed message after the challenge decides. It counts as Allow when it clearly approves: it starts with or consists of an approval phrase such as allow, yes, yep, yeah, y, approve(d), I approve, ok(ay), sure, go ahead, do it, proceed, confirm(ed). The code is optional. It counts as Deny when it refuses: no, nope, deny, don't, do not, stop, cancel, not allowed. A question (ending in `?`) or anything else is not decisive. The trust filters stay unchanged: user role, `ordinaryUser` segments only, no `server:`/`provider:`/`queue-flush:` commandIds, no `alreadySent` prompts.
   - **Card:** the question must contain the code, come **before** the answer, and offer an `Allow` option. The project-title substring check is dropped because the random code already binds the question to the challenge.
   - Within one challenge, any decisive Deny (card or chat) wins over an Allow, including a later chat "yes" or later chatter. A denial covers **only the request being asked about**. It clears the challenge, and the next attempt, for this task or another task in the same project, issues a fresh challenge the user can approve. _(User decision, 2026-11-10: "a user can say no for a particular task for another project, but can say yes for another task for the same other project.")_
   - A chat reply without a code decides only the **most recently issued** pending challenge for that caller before the reply. Older pending challenges stay undecided. Agents ask about one project at a time, and show bigbud's `question` text, which names the project.
   - "Clearly approves": a reply that contains a refusal word anywhere (no, not, don't, do not, stop, cancel, deny, never) is Deny. A reply with a hedge (wait, hold, later, first, but, actually, instead, maybe) is undecided. A reply that quotes the question back is undecided. "I approve. Please send Say hi to the attached thread." stays Allow.
   - Agent guidance: ask with the question tool. Without one, ask the user to reply yes or no. Never tell the user to type a code.
     3a. **A clear request from the user is the approval.** _(User decision, 2026-11-10, after live testing: "if the instruction is clear enough, no need for additional [approval]".)_ A cross-project write is allowed with no question when the caller thread's **latest user-role message** meets all three conditions:
   - it is trusted user-typed (same trust filters as chat proof; a queued prompt the user typed while the agent was busy still counts through its original queued prompt);
   - it attaches the **target thread**, or for `create_thread` a thread in the target project, or references the target with an explicit mention mechanism if one exists;
   - no later user-role message from another source exists, such as a cross-thread agent, automation, scheduler or completion watch.

   This covers the current request only and records no project-wide grant. Repeated calls in the same turn ("say hi 5 times") all pass because the same message still qualifies. Every other case falls back to the question or chat-reply flow below.

4. **The server enforces confirmation.** It checks a durable record of the user's answer; the agent saying "the user agreed" is not enough.
5. **What one confirmation covers:** the caller thread acting on _any_ thread in that target project. It is held in memory until the bigbud server process restarts.
6. **Confirmation is required even in full-access runtime mode.**
7. **The target thread keeps its own runtime mode and approvals.** A cross-project message grants it nothing.
8. **These stay exempt from confirmation, as today:**
   - same-project targets;
   - direct delegated children, so children created before this change don't regress.

   A child created through a confirmed cross-project `create_thread` is a direct child, so it can be controlled without asking again.

9. **No settings toggle in this iteration.** It can be added later if requested.

## Goals

- An agent can message, rename, move or snooze any thread in any project, local or remote, after one explicit user confirmation per (caller thread, target project).
- The confirmation cannot be satisfied without a user action in the bigbud client. A provider auto-answer, a provider-reported answer, or another agent's message does not count.
- `get_thread_status` works for any thread with no confirmation.
- Agents across all providers receive guidance that tells them how to handle the confirmation step.

## Non-Goals

- No new approval card UI, settings toggle, or persisted grants (persistence across restart is intentionally excluded).
- No change to `pin_thread`/`unpin_thread` (already global) or `archive_thread` (current thread only).
- No change to OpenCode V2's frozen bootstrap ABI text (`provider/Layers/OpencodeV2/Orchestration.plugin.specs.ts`, the `.ndjson` fixture, the generated manifest). See Phase 5.
- No fix for the pre-existing issues listed under Risks (optional WebSocket token, actor-kind inference).
- No change to how the target thread displays cross-thread messages. It already shows the source thread through the `crossThreadAgent` origin segment (`ThreadOrchestrationTools.sendMessage.ts:69-77`).

## Current State

### Tool dispatch (all providers converge on one place)

- **Dispatcher:** a module-level singleton, `orchestration-tools/ThreadOrchestrationToolDispatcher.ts:33-164`.
  - Installed by `installOrchestrationEngineToolDispatchers` (`orchestration/Layers/OrchestrationEngine.toolDispatcher.ts:50-220`), called from `orchestration/Layers/OrchestrationEngine.ts:351-367`.
  - It closes over `engine` and `threadDelegationRepository` for: rename `:80`, move `:86`, snooze `:92`, status `:103`, send `:135`, create `:188`.
- **Bridges:**
  - In-process: Codex (`codexThreadDynamicTools.ts`), Copilot (`copilotThreadOrchestrationTools*.ts`, `Copilot/Adapter.session.orchestrationTools.ts`).
  - Over HTTP to `ws/http.threadTools.ts` (`/api/internal/thread-tools`):
    - Claude, Cursor, Devin, Muse and the OpenCode V2 sidecar, through the MCP bridge (`orchestrationMcpBridge.template.ts`, `threadOrchestrationBridge.shared.ts:175-198`);
    - Pi (`PiOrchestrationBridge.template*.ts`);
    - the OpenCode V2 native plugin (`OpencodeV2/Execution.orchestration.ts:65-121`).
- **How results reach the model:**
  - Success payloads (`{ok:true,result}`) reach every bridge intact.
  - Failure messages reach most bridges only as text.
  - **OpenCode V2 native discards failure text entirely** (`Execution.orchestration.ts:118`).
  - Precedent for a structured refusal on the success path: `refusedComputerUseV2Result` (`orchestration-tools/computerUseToolRequest.ts:74-90`).
  - **Rename is special:** every bridge prints `Renamed thread to "${result.title ?? title}"`. See `orchestrationMcpBridge.template.ts:108-109`, `PiOrchestrationBridge.template.ts:176`, `codexThreadDynamicTools.ts:178-181`, `copilotThreadOrchestrationTools.ts:168`.
- **Retry arguments:** OpenCode V2 native tools cannot take new arguments (`Orchestration.implementation.v1.ts:10-28`, `additionalProperties:false`). **The design must not need a token argument on retry.**

### Durable record of the user's answer (trust analysis)

- **The question:** provider `user-input.requested` becomes an activity `{ requestId?, questions[{ id, header, question, options[{label, description, id?}] }] }` (`orchestration/Layers/ProviderRuntimeIngestion.helpers.activities.ts:124-155`). It is also stored in `projection_pending_user_inputs` (`getByRequestId` exists; `ProjectionPipeline.projector.pendingUserInputs.ts:42-80`). The agent writes the question text.
- **Trustworthy "user clicked" record:** the `thread.user-input-response-requested` event, payload `{ threadId, requestId, answers }`, metadata `{ requestId }` (`orchestration/deciderThreads.turn.session.ts:200-216`).
  - It is produced only by the client command `thread.user-input.respond` (web `ChatView.turnActions.logic.ts:186-193`, mobile `MobileThread.commands.ts:199`).
  - No server code dispatches that command.
  - The event is **not projected**, so it has to be read from `orchestration_events`.
- **Untrustworthy record:** the `user-input.resolved` activity.
  - Pi auto-answers `confirm` with "Yes" after 5 s in full access (`Pi/Adapter.stream.handlers.userInput.ts:186-195`).
  - OpenCode V2 and Muse report answers settled elsewhere.
  - Adapters emit `answers: {}` on cancel.
- **Answer keys** are `question.id`, which varies by provider: Claude uses the question text; Copilot uses `"answer"`; Pi uses a fallback id; Muse uses the native id. **Values** are the option label, an option id (Muse), a `string[]` for multi-select, or free text.
- **`actor_kind` is not trustworthy for this check.** `inferActorKind` (`persistence/Layers/OrchestrationEventStore.utils.ts:25-37`) classifies any commandId not prefixed `provider:`/`server:` as `client`. Tool-generated commandIds like `command:<sha256>` (`ThreadOrchestrationTools.origins.ts:7-8`) and `agent:<tag>:<uuid>` (`ThreadOrchestrationTools.ts:10-11`) are therefore recorded as `client`.
  - Trust must come from the **event type** (for the question answer) or from **origin segments** (for the chat fallback), not from `actor_kind`.
- **Chat-message provenance:**
  - The client message-submit schema cannot carry `originSegments` (`packages/contracts/src/orchestration/orchestration.commands.client.messageSubmit.ts:42-80`).
  - Server-injected messages set segments: `crossThreadAgent`/`agent` (send), `completionWatch`/`automation`, `initialDelegation`, `sleepRecovery`.
  - Some server-generated user-role messages have no segments, namely scheduler prompts (`SchedulerReactor.logic.ts:105-114`) and fork carry-over (`deciderThreads.fork.carry.ts:80-90`). A fresh random code makes accidental matches there practically impossible.
  - **Agent replies use the same event type.** Assistant output (delta, replace, complete) is recorded as `thread.message-sent` with `role: "assistant"` and no origin segments (`orchestration/deciderThreads.turn.ts:62-91`). A proof check that ignores `role` would accept the agent's own "reply `allow BB-…`" text.
  - **Pre-existing provenance leak on busy re-queue.** When a provider refuses a turn as busy, `queueTurnStart` (`orchestration/Layers/ProviderCommandReactorHandlers.turnStart.ts:48-90`) re-submits the message with commandId `server:provider-turn-start-queued:<eventId>` but **drops `message.originSegments`**, although the server command schema accepts them (`packages/contracts/src/orchestration/orchestration.commands.client.messageSubmit.ts:42-43`). When several queued prompts are flushed together, `attributedSegments` (`orchestration/deciderThreads.turn.queue.ts:51-62`, used at `:107-113`) labels any prompt without segments as `ordinaryUser`/`user`/`verified: true`. A `send_thread_message` text from another agent can therefore come back marked as user-typed. This is a bug today, independent of this feature, and must be fixed before chat proof is trusted (Design 3b).
- **Event store:**
  - Index `(aggregate_kind, stream_id, sequence)` (`persistence/Migrations/001_OrchestrationEvents.ts:8-33`).
  - There is no query by stream and type (`persistence/Services/OrchestrationEventStore.ts:36-103`).
  - Retention keeps the newest 50k sequences or 24 h, whichever is more (`EventLogMaintenance.floor.ts:13-15`).
  - Operational thread state holds the last 50 messages and 100 activities after hydration (`ProjectionOperationalStateQuery.sql.ts:21-22`).

### Question-tool availability per provider

| Provider       | Question tool in default mode                                     | Auto-answered in full access              | Confirmation path                                                                                                                      |
| -------------- | ----------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Claude         | Yes (`Claude/Adapter.approval.ts:129-134`)                        | No                                        | Question                                                                                                                               |
| Codex          | **No**, Plan mode only (`codex/codexModeInstructions.ts:139-141`) | No                                        | Chat code (or question in Plan mode)                                                                                                   |
| Copilot        | Yes (`Copilot/Adapter.session.config.ts:148-184`)                 | No                                        | Question                                                                                                                               |
| Cursor         | Yes (`Cursor/Adapter.startSession.extensions.ts:47-90`)           | No                                        | Question                                                                                                                               |
| Pi             | Extension UI only                                                 | **`confirm` auto-"Yes" after 5 s**        | Question outside full access (the user's click in bigbud produces a client event); chat code in full access (auto-answer never counts) |
| OpenCode v1/V2 | Yes                                                               | No (V2 accepts provider-reported answers) | Question (client event required)                                                                                                       |
| Muse           | Yes                                                               | Not applicable (no full access)           | Question                                                                                                                               |

### Line budgets (400-line hard limit)

These files are near the limit, so new logic must live in new files:

- `ws/http.threadTools.ts`: 390 lines
- `OrchestrationEngine.ts`: 382 lines, and it **has uncommitted work from another thread**
- `BigbudCapabilityTracks.ts`: 365
- `codexThreadDynamicTools.ts`: 366
- `PiOrchestrationBridge.template.ts`: 340
- `createThread.ts`: 315
- `persistence/Layers/OrchestrationEventStore.ts`: 376 (full-shape test stores also exist in `OrchestrationEngine.storageFailure.test.ts:35` and `OrchestrationEngine.bootstrap.test.ts:26`)

## Design

### User-visible flow

1. The user asks the agent in thread A1 (project A) to tell thread B3 (project B) to do X.
2. The agent calls `send_thread_message`. No grant exists for (A1, B), so the server returns a **successful** tool result:
   `{ status: "confirmation_required", code: "BB-7Q4K", targetProjectId, targetProjectTitle, targetIsRemote, question, allowLabel: "Allow", denyLabel: "Deny", instructions }`.
   - `targetIsRemote` is `isRemoteExecutionTargetId(project.workspaceExecutionTargetId ?? project.executionTargetId)` using the helpers in `packages/contracts/src/core/baseSchemas.ts:13-29` (`LOCAL_EXECUTION_TARGET_ID = "local"`).
   - `targetProjectTitle` is captured when the challenge is issued and stored with it, so renaming the project in between does not break matching.
     `question` is server-prescribed text, for example: `Allow this thread to message, rename and organize threads in project "B" (remote) until bigbud restarts? Code BB-7Q4K`.
3. The agent asks with its native question tool, using that exact question and the options `Allow` and `Deny`. If it has no question tool, it asks in chat for the user to reply `allow BB-7Q4K`.
4. The user clicks **Allow** in bigbud's question card, or types the code.
5. The agent retries the same call. The server verifies the proof, records the grant (A1 → B), consumes the challenge, and performs the send.
6. Later writes from A1 to any thread in B proceed with no prompt until the server restarts.
7. **If the user denies,** the retry returns `{ status: "confirmation_denied" }` and the challenge is cleared. Guidance tells the agent not to ask again unless the user asks.

### Server components

**1. `ThreadCoordinationGrants` service (new).**

- Files: `orchestration-tools/Services/ThreadCoordinationGrants.ts` (tag and shape) and `orchestration-tools/Layers/ThreadCoordinationGrants.ts` (`ThreadCoordinationGrantsLive`). Follow the `computer-use/Services/ComputerUseActivity.ts` and `computer-use/Layers/ComputerUseActivity.ts` pattern: a `ServiceMap.Service` tag plus `Layer.effect`.
- State is held in one `Ref`/`SynchronizedRef`:
  - `grants: Map<callerThreadId, Set<projectId>>`
  - `challenges: Map<"${callerThreadId}\n${projectId}", { code, projectTitle, targetIsRemote, issuedAt, streamSequenceFloor, expiresAt }>`
- Operations:
  - `hasGrant(caller, project)`
  - `getOrIssueChallenge(caller, project, floor)` returns the existing unexpired challenge, or creates one. Codes are 8 base32 characters from `crypto.randomBytes`, prefixed `BB-`.
  - `grant(caller, project)`, which also clears the challenge
  - `clearChallenge(caller, project)`
- Challenge TTL is **30 minutes**. After expiry a new code is issued.
- All updates are atomic, so concurrent calls for the same pair share one challenge.

**2. Proof lookup: one new event-store query.**
Add a bounded reader in a **new file** `persistence/Layers/OrchestrationEventStore.threadEvents.ts`, following the existing `OrchestrationEventStore.commandEvents.ts` split (the layer file is at 376 lines):
`readThreadProofEventsAfter({ threadId, afterSequence, limit })`

- SQL: `WHERE aggregate_kind='thread' AND stream_id=? AND sequence > ? AND (event_type IN ('thread.user-input-response-requested','thread.activity-appended','thread.prompt-queued') OR (event_type='thread.message-sent' AND json_extract(payload_json,'$.role')='user')) ORDER BY sequence ASC LIMIT ?`. Confirm the payload column name in `001_OrchestrationEvents.ts`. The stream/sequence index bounds the scan; the `role` filter keeps streamed assistant chunks (each one a `thread.message-sent`) from filling the page.
- The verifier pages with `afterSequence` = last seen sequence until a page comes back short. Cap the total at 2,000 events; past the cap, return `confirmation_required` with a fresh challenge (fail closed).
- Add `readThreadMaxSequence(threadId)`, used to set `streamSequenceFloor` when a challenge is issued.
- Add both methods to `Services/OrchestrationEventStore.ts` as **optional** members (like `readByCommandId`), so the full-shape test stores keep compiling. If either is absent at runtime, the verifier fails closed.

The sequence floor keeps the scan bounded even for very large databases, where userdata is known to reach ~16 GB.

**3. Proof verifier (new pure and effectful module).**
File: `orchestration-tools/ThreadCoordinationConfirmation.ts` (plus a `.logic.ts` for pure matching).

Given a challenge, it reads the caller thread's events after `streamSequenceFloor` with types:

- `thread.user-input-response-requested`
- the user message events (`thread.message-sent`, and `thread.prompt-queued` for messages typed while the agent was busy; verify the exact event names and payload field names in `orchestration.events.thread.ts`)

It accepts the first match:

- **(a) Question proof:** a `thread.user-input-response-requested` event whose `requestId` matches a `user-input.requested` activity (`thread.activity-appended`) found **in the same caller-thread scan** after the floor, using `extractActivityRequestId(payload) ?? metadata.requestId`. Do not use `projection_pending_user_inputs`: it is keyed globally by `request_id`, stops re-projecting once resolved, and isn't wired to the tools. The matched question must:
  - contains the code **and** the target project title;
  - has an option labelled `Allow`;
  - has an answer for that `question.id` that equals `Allow`, equals that option's `id`, or is an array containing either.

  A matching answer of `Deny` returns **denied**.

- **(b) Chat proof:** a message event that satisfies **all** of:
  - `thread.message-sent` with `payload.role === "user"`, or `thread.prompt-queued`;
  - the event's commandId does not start with `server:` or `provider:` (re-queues and server-injected prompts are never proof; the original user submission is already in the scan);
  - the prompt is not marked `alreadySent: true`;
  - `originSegments` are absent or all `kind:"ordinaryUser", actor:"user"`, and when present the code sits inside an `ordinaryUser` segment's own text;
  - the text contains the code (case-insensitive).

  A message containing the code together with "deny" returns denied.

- **Prerequisite fix (provenance):** in `queueTurnStart` (`ProviderCommandReactorHandlers.turnStart.ts:61-90`), forward `...(message.originSegments ? { originSegments: message.originSegments } : {})` so a re-queued cross-thread message keeps its `crossThreadAgent` segments and `attributedSegments` never relabels it as user-typed. This fixes the existing mislabelling too.
- **Never accept a `user-input.resolved` activity or `actor_kind` as proof.**

**4. Access gate rewrite.**
Change `requireThreadCoordinationAccess` (`ThreadOrchestrationTools.access.ts`) to take `mode: "read" | "write"` and the grants service. It returns a discriminated result instead of failing:

- `read`: always allowed. It still resolves the target and keeps the deleted/deleting checks in `participants.ts`.
- `write`, in order:
  1. same project → allowed
  2. direct delegated child → allowed (existing `findDirectByChild` logic)
  3. `hasGrant` → allowed
  4. otherwise run the verifier on the current or newly issued challenge: proof → `grant` and allowed; denied → `{ kind: "denied" }`; none → `{ kind: "confirmation_required", challenge }`.

Thread `mode` and the outcome through `resolveThreadToolParticipants`: `status` is `read`; `send`, `rename` and `organize` are `write`.

**5. Structured tool results.**

- Each write function returns the confirmation or denied payload on the success path when not allowed:
  - `sendThreadMessageViaOrchestration`
  - `renameThreadViaOrchestration` (`rename.ts`)
  - `applyOrganizationCommand` (`organization.ts`)
  - `createThreadViaOrchestration` (gate inserted after `:90`, before delegation `reserve` at `:97`, so a refused create reserves nothing)
- Build the payload in one shared helper, `orchestration-tools/ThreadCoordinationConfirmation.result.ts`.
- **Replay first:** a retried, already-committed command after a restart must return its result without a new confirmation. In each tool, resolve the target in `read` mode first, then check for a committed outcome, then run the write gate:
  - **send** (`sendMessage.ts`): today participants `:45` then committed check `:59`; move the write gate after `:59`.
  - **organize** (`organization.ts:63-86`): commandId and `readEventsByCommandId` already exist after participants; keep the archived check, then the committed check, then the write gate.
  - **rename** (`rename.ts:54-76`): there is **no** committed-outcome check today; it relies on engine receipt replay at dispatch. Add one: compute `canonicalRenameThreadCommandId` first (only when `invocationId` and `sourceMessageId` exist), call `orchestrationEngine.readEventsByCommandId`, and if a `thread.meta-updated` event exists return `{ title, threadId, commandId }` without gating. Random-ID renames have nothing to replay and always gate.
- **create** (`createThread.ts`): gate only when `getByInvocation` (`:96-102`) returns `None`, i.e. between `:102` and `reserve` at `:105`. An existing delegation replays with no confirmation; a refused create reserves nothing.

**6. Wiring.**

- **Decided:** turn `installOrchestrationEngineToolDispatchers` (`OrchestrationEngine.toolDispatcher.ts:50`) into an `Effect.fn` that yields `OrchestrationEventStore` and `Effect.serviceOption(ThreadCoordinationGrants)` itself, then installs the dispatcher and returns the same finalizer. It is already yielded inside the engine layer (`OrchestrationEngine.ts:351`), whose context already requires `OrchestrationEventStore` (`:71`) and uses `Effect.serviceOption` for optional services (`:73-88`). So `OrchestrationEngine.ts` (382 lines, uncommitted work from another thread) needs no edit.
- If the grants service is absent, every cross-project write returns `confirmation_required` and no grant can be recorded (fail closed). Same-project and child writes are unaffected.
- Provide `ThreadCoordinationGrantsLive` once, in `server.ts` alongside the engine layers (`:151-169`), so it is a single shared instance. Do not provide it inside per-test or per-adapter layers in production code.
- Pass the grants service and an event-store reader handle from the installer into the tool functions.
- Update the dispatcher shape types in `ThreadOrchestrationToolDispatcher.ts:33-131`.

**7. Bridge formatting.**

- **Send, create, move and snooze** already print the result payload. Verify each bridge's formatter passes `status: "confirmation_required"`/`"confirmation_denied"` through unmodified: MCP template, Pi template and organization template, Codex `codexThreadDynamicTools.ts` and `threadOrganizationTool.run.ts`, Copilot, and OpenCode V2 `provider/Layers/OpencodeV2/Orchestration.plugin.ts:48`.
- **Rename:** in each bridge (`orchestrationMcpBridge.template.ts:108-109`, `PiOrchestrationBridge.template.ts:176`, `codexThreadDynamicTools.ts:178-181`, `copilotThreadOrchestrationTools.ts:168`), print the payload JSON when `status` is present instead of `Renamed thread to …`. Do the same in the HTTP route `ws/http.threadTools.rename.ts:50`, which spreads the result at top level. Keep the payload shape identical across HTTP and in-process bridges.

## Phases

### Phase 1: Grants service, event-store reader, verifier (no behavior change)

- **Work:** add the `ThreadCoordinationGrants` service and layer; add `readThreadProofEventsAfter` and `readThreadMaxSequence` (optional members, new `.threadEvents.ts` file); add the verifier module and its pure matching logic; apply the provenance fix in `queueTurnStart`. Only the provenance fix changes behavior.
- **Tests:**
  - Unit tests for code issuing, reuse and expiry, and concurrency (two concurrent `getOrIssueChallenge` calls return the same code).
  - Pure matcher tests per provider answer shape: Claude question-text key, Copilot `"answer"`, Muse option id, multi-select array, Deny, wrong code, question missing the project title, question on a different thread.
  - Chat-proof tests: `ordinaryUser` user message accepted; **assistant `thread.message-sent` containing the code rejected**; `crossThreadAgent` rejected; `completionWatch` rejected; `server:`-prefixed commandId rejected; `alreadySent` prompt rejected; code only in the agent segment of a merged prompt rejected.
  - Provenance test (extend `OrchestrationEngine.queuedPromptRecovery.test.ts` or the turnStart handler tests): a cross-thread message refused as busy and re-queued keeps its `crossThreadAgent` segments; after a merged flush, its text is not labelled `ordinaryUser`.
  - Event-store test: the bounded query respects `afterSequence`, returns only user-role `thread.message-sent`, and pages past a run of assistant chunks.
  - Question-proof test: the `requestId` resolves from a `user-input.requested` activity on the caller thread; an activity with the same id on another thread does not match.
- **Exit:** new modules pass their tests; existing behavior is unchanged.

### Phase 2: Gate rewrite and tool results (server behavior change)

- **Work:**
  - Rewrite `access.ts` and `participants.ts`; update `sendMessage.ts` (including the replay reorder), `rename.ts`, `organization.ts`, `ThreadOrchestrationTools.ts` (status uses `read`) and `createThread.ts` (gate for foreign `projectId`).
  - Add the shared result builder.
  - Wire the service through `OrchestrationEngine.toolDispatcher.ts` and `server.ts`.
  - Keep the HTTP route changes in the split files (`http.threadTools.rename.ts`, `.organization.ts`, `.createThread.ts`); keep `http.threadTools.ts` under 400 lines.
  - Update `http.threadTools.schema.ts` only if response typing requires it.
- **Tests (update existing assertions that encode the old rule):**
  - `ThreadOrchestrationTools.sendMessage.test.ts:126-156`: foreign target returns `confirmation_required`; after a recorded client answer it is delivered; direct child is still allowed with no prompt.
  - `ThreadOrchestrationTools.getThreadStatus.test.ts:43-110`: unrelated cross-project status now **succeeds**.
  - `ThreadOrchestrationTools.rename.test.ts:12-113`: foreign returns confirmation, then is renamed after proof; title not locked while refused.
  - `ThreadOrchestrationTools.restart.test.ts:177-221`: after a restart, status is allowed; send to a non-delegated foreign thread returns confirmation again because the grant was lost; a committed send replays without confirmation.
  - `ws/http.threadTools.sendMessage.test.ts:30-85`, `ws/http.threadTools.rename.test.ts:84-158`, `ws/http.threadTools.organization.test.ts:35-84`: 200 with `confirmation_required` instead of 400 for foreign targets; the child created via a foreign `create_thread` now needs a confirmation for the create itself.
  - `ThreadOrchestrationTools.createThread.test.ts:129-155`: foreign `projectId` returns confirmation and reserves no delegation; it succeeds after proof.
  - New: a Deny answer returns `confirmation_denied`; a Pi-style `user-input.resolved` activity with "Allow" and no client response event does **not** grant; a grant for (A1, B) does not apply to (A2, B) or (A1, C); full-access caller still gets confirmation; the target thread's runtime mode is unchanged after a cross-project send; grants service absent → cross-project write refused.
  - Replay: new `ThreadOrchestrationTools.rename.replay.test.ts` cases (committed rename replays after restart with no confirmation); create replay after restart via `getByInvocation` needs no confirmation.
  - Fixtures that call the tool functions directly and need the new inputs: `ThreadOrchestrationTools.rename.replay.test.ts`, `createThread.modelChoice.test.ts`, `listAvailableModels.test.ts`, `restart.fixture.ts`, `threadRenameTool.adapters.test.ts`.
- **Exit:** focused server tests pass and typecheck passes.

### Phase 3: Bridge formatting

- **Work:**
  - Update the rename formatters (MCP template, Pi template, Codex, Copilot) to print the status payload.
  - Verify the formatters for send, create, move and snooze.
  - Leave the legacy `opencodeThreadOrchestrationTools.ts` (test-only) consistent, or record it as untouched.
- **Tests:**
  - `codexThreadDynamicTools.test.ts`, `copilotThreadOrchestrationTools.test.ts`, `PiOrchestrationBridge.test.ts`, the MCP bridge tests (find them with `rg -l orchestrationMcpBridge apps/server/src --glob '*.test.ts'`), and `htmlRenderTool.bridges.test.ts` if it covers bridge output formatting.
  - Add a case per bridge for a `confirmation_required` rename.
- **Exit:** every bridge returns the confirmation payload text to the model.

### Phase 4: Agent guidance (provider-neutral)

- **Work:**
  - `ProviderCommandReactorSessionOps.threadContext.ts:82, 87, 91, 202-205`: replace "current project or your directly delegated child" with the new rule:
    - status works for any thread;
    - writes to threads in other projects may return `confirmation_required`;
    - in that case, ask the user with your question tool using the exact `question` text and `Allow`/`Deny` options; if you have no question tool, ask the user to reply with the code in chat;
    - if a retry still returns `confirmation_required` after the user answered (for example, they answered in a provider's own UI rather than bigbud's card), ask them to type the code in chat;
    - then retry the same call; never answer on the user's behalf;
    - attaching or reading a thread still grants nothing;
    - this guidance supersedes older tool descriptions that say cross-project targets are unavailable.
  - `capabilities/BigbudCapabilityTracks.ts:143, 151, 158, 176, 224, 257, 262, 275`: same update. Split the file by concern first if the edit would exceed 400 lines (it is at 365).
  - Shared tool descriptions in `threadOrchestrationBridge.shared.ts:31, 108, 111`, `threadRenameTool.shared.ts:16` and `threadOrganizationTool.shared.ts:12`:
    - **First** separate the frozen OpenCode V2 copies from the live constants, following the precedent at `threadOrchestrationBridge.shared.ts:35`. `OpencodeV2/Orchestration.implementation.test.ts:12-22` requires the frozen specs to equal the live Codex specs, so that test needs an explicit allowance for the frozen copy rather than a byte-for-byte equality on these descriptions.
    - Then update the live text.
  - Error message in `access.ts:24`: no longer used for writes; remove it, or keep it only for deleted/unavailable targets.
- **Tests:**
  - `capabilities/CapabilityCatalog.operations.test.ts:30-58`
  - `ProviderCommandReactorSessionOps.threadContext.test.ts:29-40`
  - `ProviderCommandReactorSessionOps.threadContext.references.test.ts:54-102`: keep the assertion that attachment history grants no authority (`:62`).
  - `OpencodeV2/Orchestration.implementation.test.ts`
  - `generateThreadToolImplementationManifest.test.ts`: must still pass unchanged, which proves the frozen ABI was not touched.
- **Exit:** guidance is consistent; frozen-ABI tests pass with no regenerated manifest.

### Phase 5: OpenCode V2 native (decision gate, no edit by default)

- Leave the frozen V2 bootstrap specs, the manifest and the `.ndjson` fixture untouched.
- V2 sessions get the new behavior through the thread-context guidance and the self-describing success payload (`plugin.ts:48` prints the whole payload).
- Updating the V2 native descriptions would need a new bootstrap ABI (new specs file, generator closure, regenerated manifest, compatibility descriptors and upgrade fixtures). That is out of scope unless manual testing shows V2 agents refusing because of the stale description.

### Phase 6: Docs

- After implementation is verified, append to `docs/CHANGELOG.md` using the `bigbud-changelog` conventions: user-facing and non-technical.
- Add this plan to `docs/plans/README.md`.
- Do not rewrite historical entries (`CHANGELOG.md:815,1117`, the Inyosira plan line 52, `docs/decisions/2026-10-20-provider-integration-checklist.md:211`). Append notes instead.

## Risks And Decision Gates

- **Forged proof.**
  - Mitigated: only `thread.user-input-response-requested` (client-only command) or an `ordinaryUser`-segment message counts; `user-input.resolved` and `actor_kind` are never trusted.
  - Residual, pre-existing and out of scope: a full-access agent with shell access sits outside this guarantee. The WebSocket token is optional (`ws/ws.ts:95-101`), per-thread tool tokens are files under the state directory (`ThreadOrchestrationToolAuth.ts:34-39`), and SQLite is writable on disk. Such an agent could submit client commands or write events itself. Record this in the handoff; do not fix it here.
  - Fixed as part of this work: the busy re-queue provenance leak (Current State, chat-message provenance).
- **Agent writes misleading question text.** Mitigated by requiring the code and the target project title in the question. The user still sees the agent-authored text; the server-prescribed wording is the default the guidance tells agents to use verbatim.
- **Codex Default mode and Pi have no usable question tool.** The chat-code fallback covers them. Pi's auto-"Yes" can never satisfy proof because it produces no client response event.
- **Server restart.** Grants and challenges are lost, by design (decision 5). A retry after restart issues a new code; an old answer with the old code doesn't match. Committed commands still replay through the replay-first ordering.
- **Concurrency.** Atomic `Ref` updates; parallel calls share one challenge. A grant is idempotent.
- **Performance.** The proof query is bounded by `stream_id` and a sequence floor, and runs only when no grant exists.
- **Line limits.** `http.threadTools.ts` (390), `OrchestrationEngine.ts` (382), `persistence/Layers/OrchestrationEventStore.ts` (376) and `BigbudCapabilityTracks.ts` (365): put new logic in new dot-notation files.
- **Concurrent uncommitted work.** `OrchestrationEngine.ts` and `Services/OrchestrationEngine.ts` have uncommitted changes from other work. Do not overwrite them; coordinate before editing.
- **Rollback.** Grants are memory-only and nothing is migrated, so reverting the code restores the old rule. The only persisted additions are read queries.

## Testing And Validation

Per `AGENTS.md`: focused checks only; never `bun test`; ask before any repository-wide check.

- **Format:** `bun run oxfmt <changed files>` (guard against an empty file list, which would format the whole repo).
- **Lint:** `bunx oxlint <changed files>`.
- **Typecheck:** the configured package typecheck for `@bigbud/server`, e.g. `bun run --cwd apps/server typecheck` (confirm the script name in `apps/server/package.json`).
- **Tests:** `bun run --cwd apps/server vitest run <file>` for each test named in Phases 1–4.
- **Length:** `wc -l` on every added or edited source and test file (≤ 400).
- **Manual, live providers (required before marking Implemented):**
  - **Claude:** from project A, ask for a message to a project-B thread; a question card appears with the code; Allow → delivered; a second send to another B thread → no prompt.
  - **Codex** (Default mode): the agent asks for the code in chat; typing `allow BB-…` → delivered.
  - **Pi** in full access: the confirm auto-answer does not grant; the chat code does.
  - **Deny path**, **restart path** (grant lost), and a **remote (SSH) target** project (message delivered to the remote thread; question says "remote").
  - **`get_thread_status`** on an unrelated foreign thread works with no prompt.

## Acceptance Criteria

- Cross-project `send_thread_message`, `rename_thread`, `move_thread`, `snooze_thread` and foreign-project `create_thread` return `confirmation_required` until a valid proof exists, then succeed. A refused call has no side effects: no message, rename, organization change, delegation reservation or title lock.
- One proof grants the (caller thread, target project) pair until server restart; no other pair is affected.
- Proof is accepted only from a client user-input response on the caller thread matching the code, project title and `Allow`, or from a user-typed `ordinaryUser` chat message containing the code. `Deny` returns `confirmation_denied`.
- Full-access mode still requires confirmation.
- `get_thread_status` works for any non-deleted thread.
- Same-project targets and direct delegated children behave exactly as before.
- Committed send, rename and organize commands replay after restart without re-confirmation.
- The frozen OpenCode V2 ABI files and generated manifest are unchanged and their tests pass.
- All changed files are ≤ 400 lines, and focused format, lint, typecheck and tests pass.

## Plan validity

- Written against branch `dev` @ `68902753c1`, with ~213 uncommitted entries from other work, including `orchestration/Layers/OrchestrationEngine.ts` and `orchestration/Services/OrchestrationEngine.ts`. None of the other planned files had uncommitted changes when inspected.
- Revalidate if any of these change:
  - `ThreadOrchestrationTools.access.ts`/`participants.ts`;
  - `ProviderCommandReactorHandlers.turnStart.ts` (`queueTurnStart`) or `deciderThreads.turn.queue.ts` (`attributedSegments`);
  - `OrchestrationEngine.toolDispatcher.ts` or the engine layer's yield of it;
  - the user-input event or command shapes (`deciderThreads.turn.session.ts`, `providerRuntime.payloads.ts`);
  - `inferActorKind`;
  - the OpenCode V2 bootstrap ABI;
  - Codex `request_user_input` mode availability.

## Handoff notes

- **Order:** Phase 1 → 2 → 3 → 4, then manual checks, then Phase 6. Phase 5 is a gate, not work.
- **Must not change without new evidence:** the settled decisions above; trusting only the client response event or `ordinaryUser` message; no retry token argument; no edits to frozen V2 ABI files.
- **To verify while implementing:**
  - the `payload_json` column name and the `thread.prompt-queued` payload fields (`originSegments`, `alreadySent`) in `packages/contracts/src/orchestration/orchestration.events.ts:256-261`;
  - whether the Codex success text reaches the model (success path assumed).
- **No remaining blockers.**

## Open Questions

None blocking. Possible follow-ups the user may request later: a settings toggle to disable cross-project writes, persisting grants across restart, and updating OpenCode V2 native tool descriptions through a new bootstrap ABI.
