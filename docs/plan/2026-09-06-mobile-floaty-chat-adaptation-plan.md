# Mobile Conversation-First Floaty Chat Adaptation Plan

**Date:** 6 September, 2026  
**Status:** Draft — execution specification complete; independent review remains outstanding  
**Document lifecycle:** Proposed  
**Owner:** Planning agent; implementation owner unassigned

| Field                               | Value                                                               |
| ----------------------------------- | ------------------------------------------------------------------- |
| Project                             | bigbud                                                              |
| Created                             | 2026-09-06T15:24:32+02:00                                           |
| Last modified                       | 2026-09-06T15:37:24+02:00                                           |
| Project root                        | `/Users/youpele/DevWorld/bigbud`                                    |
| Inspected branch                    | `main`                                                              |
| Inspected commit                    | `d0bc58c9ce6b38a0f2ca6fb3d29ed54fded0f187`                          |
| Related issues                      | None supplied                                                       |
| Delivery                            | Saved Markdown plan, explicitly requested by the user               |
| Plan path                           | `docs/plan/2026-09-06-mobile-floaty-chat-adaptation-plan.md`        |
| Changes authorized for this handoff | This plan document only; no application changes, commits, or pushes |

## Summary

Remodel `apps/mobile-web` into a full-screen, conversation-first phone companion inspired by the floating assistant and Sidecar's restrained presentation—not their desktop frame or runtime.

The result must make these tasks reliable and comfortable:

1. Read and follow a conversation.
2. Switch chats and projects without losing the current draft.
3. Start a chat and choose its model.
4. Send, stop, review approvals, and answer questions without duplicate commands or misleading delivery claims.
5. Understand consequential connection problems without persistent status clutter.
6. Recover from reconnects and same-tab refreshes without silently losing composition state.

Implement this as independently reviewable reliability, layout, navigation, and presentation milestones rather than a giant rewrite. Reliability prerequisites must not be hidden inside cosmetic work.

**Review limitation:** The requested independent planning/debugging/reviewer agents were unavailable through this session's tools. Direct requirements-coverage and execution-readiness reviews informed the original plan, but an independent challenge has not been performed and cannot be marked complete. That is the remaining plan-readiness gate—not permission to implement or a request to repeat settled requirements.

This document preserves the substantive plan originally returned in chat and reorganizes it to follow `docs/plan/_plan-authoring-guide--do-not-delete.md`. The original Created timestamp is preserved. Saving this document does not imply that tests, runtime reproductions, or independent review have been performed.

## Related Work

- **None identified:** No stable bigbud note, Kanban card, issue, or PR reference was supplied for this task. The source of work is the user's planning request, two preceding read-only research rounds summarized in that request, and the source inspection recorded below. Do not invent IDs or links.
- Visual references: `apps/web/src/components/floating-assistant/FloatingAssistantShell.tsx`, `FloatingPendingApprovalCard.tsx`, and `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx`.
- Mobile deployment background: `apps/mobile-web/README.md` describes hosted mobile UI separately from the desktop backend over Tailscale Serve.
- Repository plan conventions: `docs/plan/_plan-authoring-guide--do-not-delete.md`.
- Product terminology: `docs/CONTEXT.md`. Mobile remains **Direct Unmanaged Delivery**; this plan does not move mobile under the **Desktop Delivery Supervisor** or change the TypeScript/SQLite **Canonical Domain Authority**.

## Problem

The current mobile UI does not yet provide the stable conversation-first experience suggested by the floating assistant and Sidecar:

- A fixed composer is compensated for by guessed transcript and reader-outline offsets despite variable approval/question height.
- Safe-area ownership is split across the shared stylesheet, mobile shell, and footer.
- Streaming forces the reader to the bottom even when reading older content.
- Reconnect reloads the application and discards in-memory composition.
- Individual query errors stand in for continuous connection state, while cached content is either replaced by an error screen or retained without a clear freshness indication.
- Normal sends lack a synchronous pending lock and accurate rejected-versus-uncertain delivery handling.
- Existing-thread mobile sends emit `thread.message.submit`, which the normalizer leaves unchanged and the mobile allowlist rejects. That command also has no model-selection field.
- Current draft persistence stores new-thread metadata, not the prompt and complete composition state.
- Mobile transport lifecycle, stream restart, baseline/live handoff, and retry controls need bounded coordination before the UI can make truthful recovery claims.
- Scope is validated at WebSocket admission but is not passed into per-command authorization; the remodel must not imply stronger enforced permissions than the server provides.

**Diagnostic confidence:** High for the static send rejection, missing model field, fixed layout, reload behavior, and missing lifecycle state. Actual keyboard behavior, transport retries under failures, and end-to-end delivery races require the planned tests. They were not reproduced during planning.

## Goals

### Agreed direction

- Full-screen phone conversation, not a floating desktop window.
- Restrained `[Chats | title | New]` header, rounded composer, and minimal surfaces.
- A scrolling transcript and an in-flow, nonshrinking composer sibling—not a fixed overlay with guessed offsets.
- One accessible near-full-height Chats sheet, with Settings replacing its content.
- Canonical routes, pairing, and mobile RPC infrastructure retained.
- Quiet healthy connection UX, explicit consequential failure UX, stable typing/focus, and honest freshness/delivery language.
- No invisible offline command queue and no fresh-ID resend after uncertain acceptance.
- Bounded approval/question surfaces and reader-controlled stream following.
- Planning only; application implementation is not authorized by this document-write request.

### Observable outcomes

- Phone conversation header is `[Chats | title | New]`, with accessible touch targets.
- Chats opens one near-full-height modal sheet. Settings replaces its content; it does not open a second sheet.
- Canonical pairing, project, chat, thread, and diff routes continue to work directly.
- Opening or changing sheet content does not unmount the active conversation.
- The composer is a nonshrinking, in-flow sibling of the transcript. No guessed transcript/footer clearance remains.
- Keyboard opening, approval growth, question growth, and safe-area changes do not obscure essential controls or the last message.
- Typing remains possible while disconnected or while a provider is working; sending retains the existing idle-only policy.
- Existing-thread sends work and use the displayed model selection.
- One user action produces one stable command identity. Lost acknowledgement cannot produce an automatic fresh-ID resend.
- Cached content survives ordinary refresh failures and is distinguished from current connection evidence.
- Healthy connections have no persistent connected banner.
- Retry does not reload the page.
- Same-tab refresh restores successfully stored drafts under the same backend/session/thread identity.
- Approvals and questions have bounded layouts, explicit decisions, and recoverable command states.
- Reading older messages during streaming never forces the reader back to the bottom; Latest restores following.
- All authored or materially edited source and test files are at most 400 lines.
- Required quality checks and the validation matrix pass before implementation is called complete.

### In scope

- Mobile shell, header, navigation sheet, and minimal Settings.
- Mobile conversation layout and keyboard/safe-area ownership.
- Draft preservation and request-specific composition state.
- Connection state, recovery, lifecycle fencing, and cancellation.
- Existing-thread send correction and accurate model propagation.
- Pending/error/uncertain delivery states for Send, Stop, Approve, and question submission.
- Narrow authenticated reconciliation support.
- Bounded approvals/questions and reader-controlled following.
- Mobile unit/browser tests and server mobile-RPC regression tests.
- Minimal server/contract changes required for truthful recovery.

### Behavior to preserve

- Pairing exchange and canonical routes.
- Hosted mobile versus desktop-hosted `/mobile/` deployment modes.
- Project/workspace/execution-target context.
- Existing model/provider constraints.
- Thread diff access, message rendering, and work-log functionality.
- System theme support and touch-browser input zoom mitigation.
- Existing server receipt deduplication and mobile command restrictions.

## Non-Goals

- Desktop floating windows, mascots, dragging, resizing, or desktop bridge integration.
- Importing desktop composer/runtime/coordinator stores into mobile.
- Bottom tabs, cascading menus, pervasive blur, or a permanent Settings gear.
- Provider installation, secrets, terminal access, host administration, or global permission management.
- Offline command queues or background automatic sends.
- Full mobile/desktop runtime unification.
- New state-management, drawer, animation, or persistence frameworks.
- Server-side mobile self-revocation.
- Broad authorization redesign or database migration unless the narrow recovery implementation proves one unavoidable.
- Rust changes.
- Unrelated dirty-worktree cleanup.

## Current State

### Independently inspected source evidence

These are source findings, not runtime reproductions. Line references describe the inspected revision and must be revalidated after changes.

| Finding                                                               | Evidence                                                                                                                                                                 | Consequence                                                                                                                  |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Floating assistant uses a compact full-height conversation shell      | `apps/web/src/components/floating-assistant/FloatingAssistantShell.tsx:195–264`                                                                                          | Adapt visual hierarchy, not window controls or desktop bridge behavior.                                                      |
| Sidecar places transcript and composer in flow                        | `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:93–175`                                                                                                     | Use this layout relationship on mobile.                                                                                      |
| Compact conversation is coupled to web composer/runtime               | Same file: `ThreadComposerSurfaceContext`, `ChatViewComposer`, runtime actions, stores, and no-op deep actions                                                           | Do not import `CompactThreadConversation` wholesale.                                                                         |
| Shared sheet styling cannot be changed through popup classes alone    | `apps/web/src/components/ui/sheet.tsx:21–107`                                                                                                                            | Backdrop blur and viewport spacing are separate elements. Prefer a mobile composition of existing Base UI Dialog primitives. |
| Mobile footer is fixed with guessed clearance                         | `apps/mobile-web/src/components/threads/thread/composer/MobileComposer.tsx:162–166`; `apps/mobile-web/src/screens/MobileThread.view.tsx:28,44`                           | Remove fixed positioning, `pb-44`, and the `11rem` outline offset together.                                                  |
| Mobile forces bottom scrolling while running                          | `apps/mobile-web/src/screens/MobileThread.scroll.ts:49–53`                                                                                                               | Replace running-based following with reader-intent-based following.                                                          |
| Normal send has no synchronous pending lock or handled delivery state | `apps/mobile-web/src/screens/MobileThread.tsx:276–393`; callbacks at `450–452`                                                                                           | Double activation, rejection, and acknowledgement loss need explicit handling.                                               |
| Existing-thread send is rejected by the current mobile command path   | Mobile emits `thread.message.submit`; `apps/server/src/orchestration/Normalizer.ts:92–94` returns it unchanged; `apps/server/src/ws/ws.mobile.ts:30–36,89–97` rejects it | Confirmed functional prerequisite, not a speculative grep finding.                                                           |
| Existing-thread submit cannot carry selected model                    | `packages/contracts/src/orchestration/orchestration.commands.client.ts:187–196`                                                                                          | Use an allowed model-aware command for idle sends.                                                                           |
| Turn-start supports model selection                                   | Same contracts file: `164–185,233–250`                                                                                                                                   | Reuse `thread.turn.start` for existing idle threads, without bootstrap.                                                      |
| Query errors are being used as connection errors                      | `apps/mobile-web/src/hooks/useMobileSnapshot.ts`, `useMobileThread.ts`; `apps/mobile-web/src/context/MobileRpcContext.tsx` always returns `connectionError: null`        | Separate lifecycle evidence from individual query failure.                                                                   |
| Reconnect reloads the application                                     | `apps/mobile-web/src/App.tsx:40–42`                                                                                                                                      | Replace with generation-fenced client restart.                                                                               |
| Draft metadata exists, prompt persistence does not                    | `apps/mobile-web/src/lib/mobileDraftThread.ts`; prompt/model/question state in `apps/mobile-web/src/screens/MobileThread.tsx`                                            | Introduce scoped composition storage rather than claiming drafts already survive refresh.                                    |
| Mobile retries are bounded                                            | `apps/mobile-web/src/lib/mobileRpc.protocol.ts`: seven retries, exponential delay capped at eight seconds                                                                | Preserve this schedule; add truthful lifecycle reporting around it.                                                          |
| Query timeouts do not cancel work                                     | `apps/mobile-web/src/lib/mobileRpc.ts:113–143` uses `Promise.race`                                                                                                       | Cancel/fence obsolete reads and clear timers.                                                                                |
| Subscription restart can spin                                         | `apps/mobile-web/src/lib/selfHealingStream.ts` schedules restart in a microtask                                                                                          | Add bounded, cancellable backoff and lifecycle integration.                                                                  |
| Server-config subscription is not self-healing                        | `apps/mobile-web/src/lib/mobileRpc.ts:194–214`                                                                                                                           | Recovery must restore the model/provider catalog subscription too.                                                           |
| Mobile recovery lacks a client baseline/cursor handoff                | `apps/mobile-web/src/hooks/useMobileOrchestrationSync.ts`; `apps/server/src/ws/ws.mobile.ts:154–176`; `apps/server/src/ws/wsStreams.ts:63–95`                            | A reopened socket is not proof the selected thread has caught up.                                                            |
| Scope is validated at admission but not used in command authorization | `apps/server/src/ws/ws.mobile.ts:224–242` validates a session and discards its scope                                                                                     | Do not display enforced-permission claims. Avoid expanding command privileges.                                               |
| Session expiry is currently checked at startup                        | `apps/mobile-web/src/App.tsx:134–140`; `apps/mobile-web/src/lib/mobileSession.ts`                                                                                        | Add expiry/resume handling without interpreting generic socket errors as revoked credentials.                                |
| Server session lifetime is seven days                                 | `apps/server/src/mobile/Layers/MobileRemoteControl.ts`                                                                                                                   | Display stored expiry as information; do not infer revocation from it.                                                       |
| Server receipts support command deduplication                         | `apps/server/src/orchestration/Layers/OrchestrationEngine.commandProcessing.ts:117–144,193–204`                                                                          | Preserve exact command IDs and payloads during reconciliation/retry.                                                         |
| Mobile does not expose command outcome lookup                         | `packages/contracts/src/server/rpc.mobile.ts`                                                                                                                            | Add a narrowly scoped receipt lookup only if needed for the specified delivery recovery path.                                |
| Questions auto-advance after 200 ms                                   | `apps/mobile-web/src/components/threads/thread/composer/MobileComposerPendingUserInput.tsx:53–65`                                                                        | Replace with explicit Next/Submit.                                                                                           |
| Built-in recents are not all project threads                          | `apps/mobile-web/src/lib/mobileModels.ts:177–199`                                                                                                                        | Label built-in Chats accurately; preserve project navigation separately.                                                     |
| Safe-area ownership is duplicated                                     | `apps/web/src/index.css` body padding; mobile footer padding; mobile shell `dvh`                                                                                         | Override ownership within mobile only.                                                                                       |
| Touch-browser input zoom mitigation already exists                    | `apps/web/src/index.css:275–280`, imported before `apps/mobile-web/src/mobile.css`                                                                                       | Preserve it; do not add blanket `text-base`.                                                                                 |

Additional maintainability findings:

- `apps/mobile-web/src/screens/MobileThread.tsx` is **469 lines**.
- `apps/mobile-web/src/logic/mobileOrchestrationEvents.logic.ts` is **401 lines**.
- `App.tsx`, `MobileAppHeader.tsx`, and `MobileComposerPendingUserInput.tsx` contain multiple components. Split materially edited areas into named, one-component-per-file modules.
- Mobile already has Vitest unit tests and a `test` script. It does **not** currently have a browser-test script/configuration.
- Web provides an existing Chromium/Vitest/Playwright browser-test pattern in `apps/web/vitest.browser.config.ts`.

### Reuse boundaries

All mobile-relative paths below are under `apps/mobile-web/src/`.

Reuse directly where dependency-light:

- `hooks/useMobileNewThread.ts`.
- `logic/mobileNewThread.logic.ts`.
- `logic/mobileModelSelection.logic.ts`.
- `logic/mobileReaderPosition.logic.ts`.
- `lib/mobileModels.ts` sorting and filtering.
- Existing mobile query/cache/event application logic.
- Shared work-log derivation.
- Web approval-description/action logic, after adapting the mobile approval data shape.
- Web near-bottom scroll utility and Sidecar scroll algorithm.
- Existing Base UI Dialog dependency.
- Existing server command receipts and bootstrap recovery logic.

Adapt, do not mount:

- `FloatingAssistantShell.tsx`.
- `FloatingPendingApprovalCard.tsx`.
- `FloatingSideChat.tsx`.
- `sideChat.scroll.hooks.ts`.
- `wsConnectionState.ts`.
- `WebSocketConnectionSurface.logic.ts`.

Do not make mobile depend on desktop `/ws`, the web singleton atom registry, desktop startup coordination, or the web retry cap of 64 seconds. The desktop compact picker is a visual research reference, not a reason to introduce nested phone menus or tiny touch targets.

Required concern splits:

- `MobileThread.tsx` → orchestration component plus `MobileThread.state.ts`, `MobileThread.commands.ts`, existing `MobileThread.userInput.ts`, existing `MobileThread.view.tsx`, and existing `MobileThread.scroll.ts`.
- `App.tsx` → `App.tsx`, `App.routes.tsx`, `components/shell/MobileAppFrame.tsx`, and route adapters in separate named-component files where needed.
- Move list components out of `MobileAppHeader.tsx` into individual dot-notation files.
- Move question options into `MobileComposerPendingUserInput.options.tsx`.
- If event application changes, split `mobileOrchestrationEvents.logic.ts` into snapshot and thread concerns before completion.

Create new modules only as their phase requires them—not as an empty architectural scaffold.

### Plan assumptions and recommended defaults

These defaults are recommendations for this plan, not claims that the user previously approved every detail. They are distinct from the agreed direction in Goals.

| Default                                                                                                       | Rationale and verification                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Preserve idle-only sending; allow drafting while running                                                      | Current composer prevents sending during a run. Verify server rejection remains safe if another client starts a turn concurrently.                            |
| Use existing `thread.turn.start` for existing idle-thread sends                                               | Already allowed on mobile and supports model selection. Test runtime/interaction modes and provider-lock rules.                                               |
| Preserve drafts in `sessionStorage`, not new long-lived local storage                                         | Existing draft metadata already uses tab-scoped storage. Meets same-tab refresh recovery without silently adding cross-session retention.                     |
| Persist prompt, selected model, draft metadata, pending command envelope, and request-keyed question answers  | Needed to restore the visible composition accurately. Revalidate question identity against fresh server data before restoring answers into an active request. |
| Do not restore drafts across re-pairing or backend changes                                                    | Session identity is an authorization boundary. No token-derived storage keys or automatic cross-session migration.                                            |
| Reconnect text after two seconds; escalation after ten seconds or earlier exhaustion                          | Configurable constants with fake-clock tests, not transcript countdowns.                                                                                      |
| Use explicit question progression                                                                             | Predictable for accessibility, touch, and custom answers.                                                                                                     |
| Keep current mobile thread visibility rules                                                                   | Do not silently expose archived or Sidecar-only threads as part of a visual remodel.                                                                          |
| Header New uses current project context when available; otherwise built-in Chats                              | Keeps project context meaningful without nested creation menus. Preserve the existing provider-switch/new-thread rule.                                        |
| Defer broad mobile authorization remediation, omit permission badges, and keep the existing command allowlist | Prevents an unrelated security project from swallowing the remodel. Any new recovery read must be explicitly bounded and authenticated.                       |

Storage copy must say **“Restored draft”** or **“Draft saved in this tab”** only after the corresponding operation succeeds. Do not promise recovery after closing the tab, private-browser eviction, or operating-system termination.

If an implementer needs cross-session retention, queued sending, broader permissions, or a different command-delivery policy, that is a scope change requiring approval. Do not convert an unresolved product decision into an undocumented assumption.

### Repository baseline and plan validity

This plan describes commit `d0bc58c9ce6b38a0f2ca6fb3d29ed54fded0f187` on `main`, plus the inspected dirty worktree. The root was resolved with Git rather than assumed from the current directory. The branch and commit were checked again before saving and were unchanged.

The worktree was already dirty. Its reported status was unchanged across original discovery checks and the pre-save check. Existing work includes provider/discovery changes, web status/usage/sidebar components, contracts, and the changelog. Do not stage, overwrite, format indiscriminately, or incorporate that work into this remodel.

The pre-save baseline contained these modified tracked paths:

```text
apps/server/src/provider/Layers/Claude/Provider.capabilities.ts
apps/server/src/provider/Layers/Claude/Provider.initialSnapshot.test.ts
apps/server/src/provider/Layers/Claude/Provider.initialSnapshot.ts
apps/server/src/provider/Layers/Claude/Provider.ts
apps/server/src/provider/Layers/DiscoveryRegistry.descriptors.ts
apps/server/src/provider/Layers/DiscoveryRegistry.opencode.test.ts
apps/server/src/provider/Layers/DiscoveryRegistry.parse.ts
apps/server/src/provider/Layers/DiscoveryRegistry.ts
apps/server/src/provider/Layers/ProviderRegistry.claude.test.ts
apps/server/src/provider/managedProviderSnapshot.ts
apps/server/src/provider/providerSnapshot.ts
apps/web/src/components/chat/common/ContextWindowMeter.tsx
apps/web/src/components/chat/common/ContextWindowWarningBanner.tsx
apps/web/src/components/chat/common/ThreadErrorBanner.tsx
apps/web/src/components/chat/provider/ProviderStatusBanner.tsx
apps/web/src/components/chat/view/ChatView.promptQueue.rejections.browser.tsx
apps/web/src/components/sidebar/Sidebar.projectsSection.tsx
apps/web/src/components/sidebar/SidebarUpdatePill.tsx
apps/web/src/components/usage/UsageDataStatus.tsx
apps/web/src/components/usage/UsagePage.tsx
docs/CHANGELOG.md
packages/contracts/src/index.ts
packages/contracts/src/server/server.providers.ts
```

It also contained these untracked paths:

```text
apps/server/src/provider/Layers/Claude/Provider.usageLimits.test.ts
apps/server/src/provider/Layers/Claude/Provider.usageLimits.ts
apps/server/src/provider/managedProviderSnapshot.test.ts
apps/web/src/components/chat/provider/ProviderStatusBanner.browser.tsx
apps/web/src/components/common/StatusBanner.browser.tsx
apps/web/src/components/common/StatusBanner.tsx
apps/web/src/components/usage/UsageSubscriptionLimits.browser.tsx
apps/web/src/components/usage/UsageSubscriptionLimits.tsx
packages/contracts/src/server/usageLimits.test.ts
packages/contracts/src/server/usageLimits.ts
```

Relevant constraints:

- Bun `1.3.9` package-manager declaration.
- React 19.
- Base UI already installed.
- TanStack Query/Router already installed.
- Effect `4.0.0-beta.43` catalog.
- Vitest 4 catalog.
- Mobile `~` alias points into web source.
- Oxc formatter/linter.
- No mobile browser-test configuration at inspection time.
- Root `AGENTS.md` and supplied global instructions apply; no additional nested `AGENTS.md` was found in the affected TypeScript areas during source research.
- The plan-authoring guide and supplied `docs/CONTEXT.md` apply to this saved document.

Revalidate the plan if:

- Mobile send semantics or allowed commands change.
- The baseline/live stream or receipt contracts change.
- Mobile session scopes start being enforced.
- A draft store or mobile browser harness is introduced elsewhere.
- Shared approval data, model locking, or navigation behavior changes.
- Concurrent work modifies the planned files.
- Installed-mode or supported-browser requirements change.

No application test pass, real-device result, or end-to-end reproduction is claimed by this planning pass.

## Phases

### Phase 0: Establish regression seams and isolate concerns

**Goal:** Make reliability changes independently testable without mixing them with a shell rewrite.  
**Dependencies:** None.  
**Files:** Existing mobile tests, server mobile tests, and the concern splits above.

1. Record implementation-start branch, commit, and dirty paths.
2. Add command-builder tests proving:
   - Existing mobile submit currently reaches the disallowed command path.
   - Turn-start carries the selected model and required modes.
   - New-thread bootstrap remains distinct from existing-thread sends.
3. Add characterization tests for current canonical routes, project filtering, draft creation, provider locking, and request derivation.
4. Split `MobileThread.tsx` without changing behavior.
5. Move hooks above conditional returns during the split; do not retain conditional hook ordering.
6. Keep callbacks and state keyed by session/thread, rather than relying on incidental route unmounting.

**Tests and exit criteria:**

- Behavior-preserving splits are independently reviewable.
- No materially edited file exceeds 400 lines.
- Existing unit tests pass.
- The send mismatch is covered at the actual mobile server seam, not merely by inspecting a constant.

### Phase 1: Draft ownership and safe command delivery

**Goal:** Preserve composition and make every mobile command's acceptance state honest.  
**Dependencies:** Phase 0.

**Primary files:**

- `apps/mobile-web/src/screens/MobileThread.commands.ts`.
- `apps/mobile-web/src/screens/MobileThread.state.ts`.
- `apps/mobile-web/src/lib/mobileDraftThread.ts`.
- New `apps/mobile-web/src/lib/mobileComposerDraft.ts`.
- New `apps/mobile-web/src/lib/mobileCommandDelivery.ts`.
- New `apps/mobile-web/src/lib/mobileCommandDelivery.logic.ts`.
- `apps/mobile-web/src/components/threads/thread/composer/MobileComposer.tsx`.
- `apps/mobile-web/src/lib/mobileRpc.ts`.
- `apps/server/src/ws/ws.mobile.ts`.
- New `apps/server/src/ws/ws.mobile.recovery.ts`.
- `packages/contracts/src/server/rpc.mobile.ts`.
- A new schema-only mobile recovery contract file under `packages/contracts/src/server/`.

#### 1.1 Scoped composition storage

Use a versioned record keyed by:

`normalized backend origin + sessionId + threadId`

Store:

- Ordinary prompt separately from question custom-answer text.
- Selected model.
- New-thread metadata.
- Question answers and progression keyed by request and question identity.
- Immutable submitted command envelope and delivery state.

Requirements:

- Validate stored data with the repository's existing schema approach.
- Catch denied storage, malformed data, and quota failures.
- Keep memory state usable if persistence fails; show a quiet, actionable preservation warning.
- Persist the submitted envelope before transport dispatch when storage is available.
- Do not store tokens, token URLs, raw exceptions, or connection diagnostics in draft records.
- Clear records after confirmed completion only if they still refer to the submitted revision.
- Preserve text typed after Send; acknowledgement must not erase a newer draft.
- Clear matching storage and in-memory caches on Forget.
- Quarantine expired-session composition from automatic use; purge it on Forget or replacement pairing.
- Do not automatically migrate legacy unscoped draft metadata into a different session.

#### 1.2 Correct existing-thread sends

For an existing idle thread, build `thread.turn.start` with:

- Stable command ID and message ID.
- Selected model.
- Existing thread runtime and interaction modes.
- User message text and empty attachments, matching current mobile capability.
- No bootstrap.

Retain bootstrap for new drafts.

Do **not** add `thread.message.submit` to the allowlist as a shortcut. That would introduce different delivery/queue semantics while still failing to apply the selected model. This plan does not add attachments or claim unsupported provider capabilities.

#### 1.3 Delivery state machine

Maintain command state independently of connection and provider state:

| State         | Meaning                                                               |
| ------------- | --------------------------------------------------------------------- |
| `idle`        | No submitted operation                                                |
| `pending`     | Immutable command dispatched; result outstanding                      |
| `accepted`    | Acknowledgement or matching authoritative receipt confirms acceptance |
| `rejected`    | Authoritative rejection confirms this attempt failed                  |
| `uncertain`   | Transport loss/deadline means acceptance is unknown                   |
| `reconciling` | Read-only outcome/fresh-state inspection in progress                  |

Rules:

- Acquire a synchronous lock before the first asynchronous boundary.
- Prevent duplicate activation through click, Enter, touch, or repeated response controls.
- Use a bounded application deadline; expiry means **uncertain**, not rejected.
- A generic RPC exception is not proof the command was never accepted.
- Never automatically resend after reconnect.
- Never change an uncertain command's payload, IDs, timestamp, model, or bootstrap recipe.
- Use “Checking whether your message was accepted” / “Delivery is uncertain,” not “Wasn't sent.”
- Keep typing enabled while the submitted operation is locked.

#### 1.4 Narrow reconciliation endpoint

Add a mobile-only outcome read accepting `threadId` and `commandId`.

Reuse `OrchestrationCommandReceiptRepository.getByCommandId` or the existing engine outcome abstraction, with these constraints:

- Authenticate through the mobile route.
- Return only a matching thread receipt.
- Do not expose project receipts, arbitrary aggregate metadata, payload digests, or raw error text.
- Return a small accepted/rejected/unknown result with sequence and sanitized rejection classification where available.
- Unknown means unknown, not “safe to generate a new command.”
- Revalidate the session for this new recovery operation.
- Do not add mutation privileges or advertise server-enforced scope in the UI.

Reconciliation order:

1. Read outcome.
2. Refresh relevant canonical state.
3. Accepted: resolve the operation without resending.
4. Rejected: retain editable content and show the confirmed reason.
5. Unknown: remain uncertain; offer an explicit retry of the **same operation** only after same-ID deduplication is proven by integration tests.
6. Unsupported endpoint on an older desktop: use exact message-ID evidence where available; otherwise remain uncertain and do not invent a safe retry.

For Stop and approval/question responses, absence from the refreshed UI alone is not proof that this particular command succeeded.

**Tests:** Storage denial/quota/schema/identity tests; command builder and pending-lock unit tests; server command, receipt, digest-conflict, and bootstrap retry integration tests; browser tests for revision-aware acknowledgement and uncertain delivery. Exact commands and full cases are in Testing And Validation.

**Exit criteria:**

- Rapid double activation produces one logical operation.
- Existing-thread sends use the displayed model.
- Lost acknowledgement and reconnect never create a second user message or turn.
- Accepted commands do not erase newer typing.
- Rejected and uncertain commands are visibly different.
- No offline Send/Stop/Approve queue exists.

### Phase 2: Connection lifecycle and truthful recovery

**Goal:** Coordinate bounded recovery without conflating transport, freshness, provider state, or command delivery.  
**Dependencies:** Phase 1's delivery states; can precede visual shell work.

**Primary files:**

- `apps/mobile-web/src/context/MobileRpcContext.tsx`.
- `apps/mobile-web/src/lib/mobileRpc.protocol.ts`.
- `apps/mobile-web/src/lib/mobileRpc.ts`.
- `apps/mobile-web/src/lib/selfHealingStream.ts`.
- New `apps/mobile-web/src/lib/mobileConnection.logic.ts`.
- New `apps/mobile-web/src/lib/mobileConnection.ts`.
- `apps/mobile-web/src/hooks/useMobileSnapshot.ts`.
- `apps/mobile-web/src/hooks/useMobileThread.ts`.
- `apps/mobile-web/src/hooks/useMobileServerConfig.ts`.
- `apps/mobile-web/src/hooks/useMobileOrchestrationSync.ts`.
- `apps/mobile-web/src/logic/mobileOrchestrationSync.logic.ts`.
- `apps/mobile-web/src/components/shell/MobileSessionGate.tsx`.
- `apps/server/src/ws/ws.mobile.ts`, `ws.mobile.recovery.ts`, and `wsStreams.ts` for the narrow recovery seam.
- Mobile recovery schemas under `packages/contracts/src/server/`.

#### 2.1 Independent evidence dimensions

Track:

- **Transport:** unpaired, connecting, open, retrying, exhausted, closed.
- **Authorization evidence:** unknown, locally expired, explicitly rejected.
- **Data:** unavailable, refreshing, refreshed-at-time, stale/refresh-failed.
- **Provider:** current observed state or last-known state.
- **Delivery:** Phase 1 operation state.

Do not collapse these into a single `connected` boolean.

#### 2.2 One lifecycle owner

- Create/dispose clients through one effect-owned lifecycle.
- Assign a monotonically increasing client generation.
- Fence socket callbacks, subscriptions, timers, query completions, and retry actions by generation.
- Fence selected-thread work separately so late responses cannot overwrite another thread.
- Replace all reload-based Retry/Reconnect actions with lifecycle restart.
- Preserve the existing seven-retry/eight-second-cap schedule.
- Add explicit attempt, waiting, and terminal-exhaustion evidence from the protocol—not a UI timer guessing exhaustion.
- Coalesce repeated Retry clicks.
- Online/focus/resume events may request one restart when appropriate; they must not create parallel retry loops.
- Browser offline is advisory evidence, not proof that an already-open transport has failed.

#### 2.3 Bound work and subscriptions

- Replace read `Promise.race` timers with cancellable operations and cleared deadlines.
- Include client initialization in the deadline boundary.
- Dispose obsolete work on session/generation change.
- Replace microtask stream restarts with cancellable bounded backoff.
- Restore both domain-event and server-config subscriptions.
- Stop restart loops on disposal, expiry, exhaustion, or no listeners.
- Do not let query retry, transport retry, and stream retry multiply into uncontrolled work.

#### 2.4 Recovery baseline and event handoff

Implement a narrow mobile recovery boundary rather than importing desktop delivery supervision:

1. Obtain a recovery baseline containing the trimmed snapshot and optional selected full thread from **one projection snapshot**, with its `snapshotSequence`.
2. Add this as an additive mobile recovery read; retain existing read endpoints for compatibility.
3. Subscribe from that baseline sequence.
4. Extend the ordered stream helper with an optional starting cursor, preserving existing callers' default behavior.
5. Have the mobile route honor the supplied cursor; it currently ignores it.
6. Replay and live-capture must deduplicate by sequence, preserve order, and use bounded buffers.
7. On replay unavailability, sequence gap, or overflow: mark data stale and obtain a new baseline—never silently skip and claim recovery.
8. Apply baseline and subsequent events through one controller. Ordinary query completions must not overwrite newer event-applied state.
9. Retain event coalescing and unknown-event fallback refetch.
10. On older desktops without the recovery read, use conservative refetch fallback and display freshness limitations; do not claim synchronized delivery.

This is limited to the mobile baseline/live seam. Do not migrate to desktop supervisor epochs, acknowledgements, or its complete delivery architecture. Mobile remains Direct Unmanaged Delivery, not Controlled Fallback from a failed desktop supervisor.

#### 2.5 Cached UI and expiry

- `MobileSessionGate` should render available cached content during ordinary refetch errors.
- Reserve blocking initial-load UI for no usable data or an authorization boundary.
- Mark cached working state as last-known; do not infer the provider stopped.
- Check stored expiry on a timer and on resume.
- At expiry, stop new commands and retries, preserve composition locally, and offer pairing help.
- Generic handshake/error events must remain “Unable to connect”; never label them revoked/expired without evidence.

**Tests:** Fake-clock lifecycle, retry, generation, stream cancellation, deadline, and cache-ordering tests; server baseline-to-subscription race, replay gap/overflow, and older-desktop compatibility tests; browser draft/focus recovery tests.

**Exit criteria:**

- Open socket plus failed refresh does not become “Synced.”
- Old-generation callbacks cannot alter current state.
- Recovery handles an event occurring between baseline read and stream subscription.
- Repeated failure does not spin or leak subscriptions.
- Retry preserves draft, conversation, focus, and keyboard.
- Session replacement clears old-session caches and prevents cross-session restoration.

### Phase 3: Conversation shell, Chats sheet, and Settings

**Goal:** Make conversations primary while retaining accessible canonical navigation.  
**Dependencies:** Phase 2's public lifecycle interface; draft ownership from Phase 1.

**Primary files, relative to `apps/mobile-web/src/`:**

- `App.tsx`, new `App.routes.tsx`.
- New `components/shell/MobileAppFrame.tsx`.
- `components/shell/MobileAppHeader.tsx`.
- Replace `components/shell/MobileHamburgerMenu.tsx`.
- New `components/shell/MobileNavigationSheet.tsx`.
- New `components/shell/MobileNavigationSheet.logic.ts`.
- New `components/shell/MobileNavigationSheet.chats.tsx`.
- New `components/shell/MobileNavigationSheet.settings.tsx`.
- Existing launch/chat/project screens.
- `logic/mobileHeader.logic.ts`.
- `theme/useTheme.ts`.

#### 3.1 Header and entry behavior

- Conversation: Chats, truncated title, New.
- Preserve full title access without relying solely on hover.
- Associate an inspectable connection indicator with Chats; include status in its accessible description.
- Remove duplicate new-chat FABs from remodeled surfaces.
- Keep pairing focused and free of unnecessary conversation navigation.
- Keep direct diff navigation and an explicit return to its thread.

#### 3.2 Sheet composition

Use existing Base UI Dialog primitives with mobile-owned backdrop and viewport styling:

- Near-full-height phone sheet.
- Solid/restrained surfaces; no backdrop blur requirement.
- Labelled dialog, close control, focus trap, background inertness, scroll containment, and focus restoration.
- One scrollable content area with an accessible footer.
- Built-in Chats recents and Projects are distinct sections.
- Project selection replaces the sheet's list content with project threads; no cascading menus.
- Settings replaces sheet content with Back.

Keep the route outlet mounted beneath the sheet.

#### 3.3 History behavior

Represent sheet navigation in router-managed history without changing canonical pathnames:

- Opening Chats creates one overlay history entry.
- Settings/project subviews update that overlay state rather than stacking dialogs.
- Settings Back returns to Chats.
- Browser Back dismisses the navigation overlay before leaving the conversation.
- Close/backdrop dismissal and browser Back converge on the same state transition.
- Selecting a thread closes/replaces the overlay entry with canonical thread navigation.
- Browser Forward restores a valid overlay state predictably.
- Missing/invalid history metadata falls back to the canonical route.
- Never use arbitrary multi-step `history.go()` assumptions.

#### 3.4 Minimal Settings

Include:

- System / Light / Dark, with the stored preference selected.
- Sanitized backend HTTP(S) origin.
- Connection/freshness detail and stored expiry.
- Retry connection.
- Pairing help.
- Forget this connection, with inline confirmation replacing content rather than stacking a dialog.

Forget copy must state:

> Removes this connection and its drafts from this browser. It does not revoke the desktop authorization.

On confirmation, dispose client work, clear relevant storage and query caches, clear session state, and navigate to unpaired `/mobile`.

Do not render or copy websocket URLs, query strings, fragments, URL credentials, tokens, raw exceptions, or provider configuration.

**Tests:** Header/filtering/history unit tests; mounted-conversation and draft-preservation browser tests; direct pairing/project/thread/diff route tests; theme preference and redaction tests; Forget storage/cache cleanup tests.

**Exit criteria:**

- No conversation remount from opening Chats or Settings.
- Back/Forward works from both normal and direct-entry routes.
- Theme system changes remain reactive.
- No “All chats” label for built-in-only recents.
- Forget is local-only in both behavior and copy.

### Phase 4: Keyboard-safe conversation and bounded interaction surfaces

**Goal:** Keep the transcript readable and all essential composition/review controls reachable on phones.  
**Dependencies:** Phases 1–3.

**Primary files, relative to `apps/mobile-web/src/`:**

- `screens/MobileThread.view.tsx`.
- `screens/MobileThread.scroll.ts`.
- `components/threads/thread/composer/MobileComposer.tsx`.
- New `components/threads/thread/composer/MobileComposer.approval.tsx`.
- `components/threads/thread/composer/MobileComposerPendingUserInput.tsx`.
- New `components/threads/thread/composer/MobileComposerPendingUserInput.options.tsx`.
- `components/threads/thread/composer/MobileComposerContextBar.tsx`.
- `components/threads/thread/MobileReaderOutline.tsx`.
- `components/threads/thread/MobileMessages.tsx`.
- `components/threads/thread/MobileWorkLog.tsx`.
- `mobile.css`.
- `lib/mobileModels.ts` for approval-detail derivation, split if necessary.

#### 4.1 Layout and safe areas

Use this structural order:

1. Nonshrinking header.
2. Optional status slot.
3. `min-height: 0` scrolling transcript region.
4. Nonshrinking bounded composer/review region.

Remove the fixed composer and both guessed transcript/outline offsets in the same change.

Mobile-specific safe-area ownership:

- Override shared body safe-area padding in `mobile.css`, which loads after the shared stylesheet.
- Shell owns top and horizontal safe areas.
- Bottom composition/navigation surface owns bottom safe area.
- Modal viewport owns its own safe areas.
- No double bottom inset when the keyboard changes the visible viewport.

Start with dynamic viewport layout. Add a small `MobileViewport` hook only where real-device evidence requires visual-viewport sizing. It must distinguish input focus plus viewport reduction from arbitrary resizing; no guessed keyboard pixel height.

Keep default text at `text-sm`; preserve existing touch-browser 16px input mitigation.

#### 4.2 Composer

- Rounded prompt surface, restrained border, no oversized desktop frame.
- Keep textarea enabled during running/disconnected states.
- Separate editability from action availability.
- Guard Enter during IME composition; Shift+Enter inserts a newline.
- Keep pending submitted content separate from the editable next draft.
- Retain project context; collapse optional branch/worktree detail before model and primary actions.
- Remove placeholder claims about mentions or slash commands unless mobile actually supports those interactions.

#### 4.3 Approvals

Replace the prompt surface with a bounded review card while preserving the ordinary draft.

- Adapt description/action logic from the floating approval card.
- Extend mobile approval derivation to retain available review detail; current mobile shape contains only ID, kind, and creation time.
- Do not show an empty “review” affordance when detail is unavailable.
- Keep actions visible; allow long detail to scroll.
- Expanded review replaces the bounded view or uses one accessible review surface, not stacked sheets.
- Dismissal is not acceptance or denial.
- Use delivery locks and uncertain/error handling from Phase 1.
- Preserve specialized approval semantics rather than deriving every decision from generic Approve/Deny labels.

#### 4.4 Questions

- Explicit Previous / Next / Submit.
- Remove 200 ms auto-advance.
- Announce question position and move focus predictably.
- Use accessible selection semantics for single/multiple choice.
- Bound long question/option content while keeping progression actions reachable.
- Keep ordinary prompt separate from custom answers.
- Revalidate restored answers against current request/question identity.
- Do not submit a stale question request silently.

#### 4.5 Reader following

Adapt Sidecar's near-bottom algorithm:

- Following depends on reader position before content growth.
- Provider running state never overrides manual reading.
- ResizeObserver/content growth follows only while following is enabled.
- Show a Latest button when away from the bottom.
- Latest resumes following.
- Reset appropriately on thread identity changes.
- Respect reduced motion for outline jumps and scrolling.
- Anchor the outline to the actual transcript region.

**Tests:** Browser viewport/composer growth, IME, long approval/question, prompt-mode restoration, and streaming read-back tests; physical iOS/Android keyboard and safe-area checks from the device matrix.

**Exit criteria:**

- Last message and primary action are reachable with the keyboard open.
- Long approvals/questions cannot push essential controls outside the usable viewport.
- Ordinary drafts survive entering and leaving approval/question modes.
- Streaming does not interrupt read-back.
- All important controls have approximately 44px minimum touch areas.

### Phase 5: Connection presentation and accessibility

**Goal:** Show consequential connection evidence in one appropriate place without distracting from conversation.  
**Dependencies:** Phases 2–4.

Create, under `apps/mobile-web/src/`:

- `components/shell/MobileConnectionIndicator.tsx`.
- `components/shell/MobileConnectionNotice.tsx`.
- `components/shell/MobileConnectionNotice.logic.ts`.

One selector determines placement and copy:

| Evidence/state                               | Main conversation                      | Sheet/Settings                             | Composer behavior                                          |
| -------------------------------------------- | -------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| Healthy transport, recent successful refresh | Small inspectable indicator; no banner | Connection and last refresh details        | Normal                                                     |
| Short reconnect blip                         | Quiet indicator                        | Reconnecting detail                        | Typing remains enabled                                     |
| Reconnect ≥2 seconds                         | Blue text in status slot               | Full detail                                | Block unavailable actions with explanation                 |
| Reconnect ≥10 seconds                        | Expanded consequential explanation     | Retry/help                                 | Same explanation moves near composer when keyboard is open |
| Retry exhausted                              | Confirmed connection failure, red      | Retry + pairing help                       | No queue; draft retained                                   |
| Browser reports offline                      | Amber hint where consequential         | Explain device/network hint                | Do not infer server/provider failure                       |
| Socket open, recovery reads pending          | “Refreshing chats”                     | Separate transport and refresh information | Gate state-dependent actions as needed                     |
| Refresh failed with cache                    | Amber stale-data explanation           | Last successful refresh                    | Cached provider activity labelled last-known               |
| Stored expiry reached                        | Expiry/pairing explanation             | Stored expiry and pairing help             | No new commands                                            |
| Generic handshake failure                    | “Unable to connect”                    | Retry/help; no revocation claim            | Draft retained                                             |
| Command uncertain                            | Operation-specific amber explanation   | Connection detail remains separate         | Submitted operation locked; typing enabled                 |
| Recovery after escalation                    | Brief confirmation, then quiet         | Updated timestamps                         | Reconcile commands separately                              |
| Recovery after short blip                    | No success toast/banner                | Updated detail                             | No focus change                                            |

Accessibility requirements:

- One polite live announcement per meaningful transition—not per retry attempt.
- One expanded explanation at a time.
- Suppress duplicate expanded header notice when its keyboard-open equivalent is near the composer.
- Icon and text, not color alone.
- Reduced motion.
- No automatic focus or keyboard changes caused by connection transitions.
- Redacted, structured diagnostics only; no token URL logging in UI telemetry.

**Tests and exit criteria:** Fake-clock placement/escalation tests and browser live-announcement/deduplication tests cover every matrix row; healthy status remains quiet; blocked actions explain immediately; keyboard-open placement preserves focus; no token-bearing diagnostics appear in rendered or copied content.

## Risks And Decision Gates

| Risk                                              | Mitigation                                                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Cosmetic work ships over broken sending           | Phase 1 is a release prerequisite.                                                                             |
| Hosted mobile is newer than desktop               | Additive recovery methods; explicit conservative fallback; never guess retry safety.                           |
| Recovery changes affect desktop stream consumers  | Optional cursor behavior must preserve existing defaults; run existing ordered-stream tests.                   |
| Draft retention exposes sensitive prompts         | Tab-scoped storage, validated identity, no token keys, explicit local semantics, cleanup on Forget/re-pairing. |
| Late acknowledgement deletes newer text           | Revision-aware clearing and immutable submitted envelopes.                                                     |
| Retry loops multiply                              | Single lifecycle owner, bounded schedules, generation fencing, fake-clock tests.                               |
| Approval card lacks enough review data            | Extend derivation using existing payload evidence; test unavailable-detail states.                             |
| Keyboard layout passes emulation but fails on iOS | Physical-device acceptance gate.                                                                               |
| Permission UI overstates authorization            | Omit scope badges. Track server per-command scope enforcement as a separate security follow-up.                |
| File splitting becomes a rewrite                  | Split only materially touched concerns; preserve characterization tests.                                       |
| Existing unrelated work interferes with checks    | Isolated implementation workspace and recorded baseline failures.                                              |

### Explicit gates

- Complete the independent read-only plan challenge before marking the plan **Ready for implementation**.
- Prove same-ID deduplication, payload-conflict rejection, and bootstrap retry behavior before exposing a retry of an uncertain operation.
- Do not expose enforced-permission badges without server enforcement evidence. The current omission is deliberate, not a security-fix claim.
- Keep any new recovery read narrowly authenticated and redacted; no mutation privilege expansion.
- If recovery requires a database migration or broader authorization architecture, stop and obtain scope approval rather than silently widening this plan.
- If a proposed default becomes a material unresolved product decision, keep Draft status and ask a focused question rather than choosing implicitly.
- Treat physical-device keyboard verification and old-desktop compatibility as release gates.

### Safe milestones

1. **Reliability foundation:** command correction, stable identity, drafts, lifecycle, conservative recovery.
2. **Conversation layout:** in-flow composer, bounded review, reader following.
3. **Navigation and Settings:** new shell and single-sheet history.
4. **Presentation and release validation:** quiet status system, accessibility, devices, deployment compatibility.

These are release slices, not permission to bypass phase dependencies. Layout/nav integration may be reviewed together where the shell relationship requires it. Each milestone must remain usable and testable. Do not ship halfway through replacing fixed layout or halfway through replacing command-delivery behavior.

### Rollback

- Keep server recovery additions additive so an older mobile bundle still works.
- Roll back the visual shell independently of command safety.
- Do not roll back to fresh-ID retry behavior.
- Version stored records; older clients must ignore unknown records safely.
- Do not downgrade unknown commands to unsent during rollback.
- No commit, push, release, or deployment without explicit authorization.

### Handoff notes

Recommended implementation order:

**Characterization/splits → draft and delivery safety → lifecycle/recovery → shell/history → keyboard/review/scroll → status presentation → full validation.**

Decisions not to reopen without new evidence:

- Full-screen phone conversation, not a floating desktop window.
- No desktop runtime import.
- In-flow composer, no guessed offsets.
- One Chats/Settings sheet, no permanent bottom tabs or gear.
- Quiet healthy connection state.
- Separate transport, freshness, provider, and delivery evidence.
- No invisible offline command queue.
- No fresh-ID resend after uncertain acceptance.
- Canonical routes and pairing remain.
- Forget remains honest about local-only behavior.
- Materially edited/authored source and tests stay within 400 lines.
- No implementation during planning; no commit/push permission.

## Testing And Validation

### Validation performed versus planned

Source discovery and pre-save Git baseline inspection were performed. No application tests, builds, real-device checks, or independent agent review were performed. The commands and cases below are future implementation requirements, not recorded passes.

For the documentation-only save, read back the saved file and run a read-only formatting check scoped to this Markdown path. Report its actual result in the handoff; do not run the mutating repository-wide formatter or application checks just to save a plan.

### Existing commands

Run from the project root during implementation:

```sh
bun run --cwd apps/mobile-web test
bun run --cwd apps/mobile-web typecheck

bun run --cwd apps/server vitest run src/server.mobile.ws.test.ts
bun run --cwd apps/server vitest run src/server.mobile.http.test.ts
bun run --cwd apps/server vitest run src/server.mobileWeb.http.test.ts

bun run test
bun fmt
bun lint
bun typecheck
bun fmt:check

bun run build:mobile-web
bun run --cwd apps/mobile-web build:desktop
```

**Never run `bun test`.**

`bun fmt` is mutating. Run the full completion checks in an implementation workspace isolated from unrelated user work, or coordinate that work first. Do not solve unrelated failures by sweeping formatting or reverting existing changes.

### Browser setup to add

Mobile currently lacks browser configuration.

Add `apps/mobile-web/vitest.browser.config.ts` and mobile package scripts using the existing web Vitest/Playwright pattern. Use the same dependency versions as web; do not introduce a second testing framework.

Planned commands after setup:

```sh
bun run --cwd apps/mobile-web test:browser:install
bun run --cwd apps/mobile-web test:browser
```

Ensure unit-test discovery excludes browser-only files and browser discovery includes the new shell/screen tests. Keep fixtures and tests split below 400 lines.

### Deterministic unit tests

Use injected clock/scheduler, fake WebSocket lifecycle, fake storage, and controllable RPC promises.

Cover:

- Two-second visibility and ten-second escalation boundaries.
- Exhaustion before escalation.
- Error plus close deduplication.
- Stale callbacks after client replacement.
- Rapid retry, online/focus coalescing, and resume.
- Stream synchronous exit, repeated exit, cancellation, and disposal.
- Deadline timer cleanup and ignored late reads.
- Recovery baseline/event ordering, duplicate sequences, gaps, and overflow.
- Last-known provider state.
- Send double activation and IME composition.
- Acknowledgement after newer typing.
- Rejected versus uncertain outcomes.
- Same-ID retry versus conflicting changed payload.
- Storage denied/quota/malformed records.
- Session/backend/thread isolation.
- Theme preference versus resolved appearance.
- Sheet history state transitions.
- Explicit question progression.

### Server integration tests

Add concern-specific files such as:

- `apps/server/src/server.mobile.commands.test.ts`.
- `apps/server/src/server.mobile.recovery.test.ts`.
- `apps/server/src/server.mobile.delivery.test.ts`.

Use existing `apps/server/src/server.mobile.ws.test.ts` and `server.test.helpers.ts` seams. Run each new file using the same `bun run --cwd apps/server vitest run <path>` pattern. Keep server tests sequential as required by the repository configuration.

Required cases:

1. Existing-thread turn-start succeeds and carries selected model.
2. Disallowed commands remain disallowed.
3. Missing/invalid credentials cannot use new recovery reads.
4. Outcome lookup does not expose mismatched-thread/project receipts or raw errors.
5. Accepted command with dropped response followed by same-ID retry creates one logical turn.
6. Same ID with changed payload is rejected.
7. Bootstrap retry does not duplicate thread/worktree setup.
8. Approval/question/interrupt response uncertainty does not blindly repeat a decision.
9. Baseline-to-subscription race is repaired.
10. Replay gap/overflow returns to recovery rather than silently dropping events.
11. Older desktop compatibility leaves uncertain delivery conservative.

Add contract/schema tests for the additive recovery inputs/results, malformed serialized data, redacted errors, and backward compatibility. Preserve existing receipt/ordered-stream regression coverage rather than relying only on mocked mobile tests.

### Browser interaction tests

- Header and sheet semantics.
- Active conversation mount count and draft preservation.
- Chats → Settings → Back → Close.
- Browser Back/Forward and direct thread/project/diff routes.
- Long title, empty projects, deleted thread, unavailable model.
- Composer growth and viewport resize.
- Long approval/question content.
- Streaming while scrolled away; Latest.
- Redaction in rendered text, clipboard actions, accessible labels, and error surfaces.
- No duplicate status notices/live announcements.
- Forget removes session-specific drafts and caches.

### Device/browser matrix

| Environment                                    | Required checks                                                                                |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Chromium emulation: 320–430px widths           | Layout, touch targets, overflow, long text, 200% text scaling                                  |
| Landscape emulation                            | Short viewport, bounded review, readable transcript                                            |
| WebKit automation where configured             | Routing, dialog focus, layout regressions; not a substitute for iOS keyboard testing           |
| **Real iPhone Safari**                         | Software keyboard, address-bar collapse, safe areas, rotation, IME, focus retention, reconnect |
| **Real iPhone installed mode where supported** | Standalone viewport, suspend/resume, refresh recovery, safe areas                              |
| **Real Android Chrome**                        | Keyboard resize, system Back, offline/resume, IME                                              |
| Hardware keyboard                              | Enter/Shift+Enter, IME, Escape, focus traversal                                                |
| VoiceOver/TalkBack                             | Dialog navigation, question progression, status announcements                                  |
| All representative devices                     | Offline/reconnect/exhaustion/expiry, lost acknowledgement, long approvals, streaming read-back |

Record device model, OS/browser version, installed versus browser mode, and whether results came from emulation or physical hardware. Record external-runtime checks separately from mocked tests; do not infer provider capability from a fixture.

## Acceptance Criteria

### Final implementation checklist

- [ ] Existing and new-thread sends work with the displayed model.
- [ ] Duplicate activation and lost acknowledgement cannot duplicate a turn.
- [ ] Draft, pending payload, and question state survive supported recovery boundaries.
- [ ] Retry never reloads the page.
- [ ] Recovery cannot be overwritten by stale callbacks or late query results.
- [ ] Cached state is labelled honestly.
- [ ] Chats/Settings preserve conversation mounting and canonical navigation.
- [ ] Safe areas have one owner per surface.
- [ ] Keyboard and long-review layouts pass real-device checks.
- [ ] IME and explicit question progression work.
- [ ] Read-back is not interrupted by streaming.
- [ ] Status announcements and surfaces are deduplicated.
- [ ] Tokens/raw diagnostics never appear in settings, clipboard, labels, or logs added by this work.
- [ ] Old-desktop compatibility is exercised.
- [ ] Required tests, builds, format, lint, and typecheck pass.
- [ ] All changed source/test files satisfy the 400-line limit.
- [ ] Independent read-only plan challenge is completed before marking this plan **Ready for implementation**.

Completion evidence must include targeted test results, required command results with unrelated failures explicitly classified, the physical-device matrix, and review of the intended diff against the recorded dirty-worktree baseline. Saving this plan alone satisfies none of the implementation checklist.

## Open Questions

- **Independent review gate:** Assign an independent read-only reviewer to challenge the recovery/delivery boundaries, authorization limits, proposed defaults, and phased scope. No independent review has been performed. Keep Draft status until supported findings are resolved.
- **Related-work reference:** No stable note/card/issue was supplied. Add one if the project owner wants this work tracked there; this is not a reason to invent a reference or block saving the plan.
- **Implementation ownership:** Assign the implementing agent/team and physical-device validation owner before scheduling release validation.
- **Security follow-up:** Track per-command mobile scope enforcement separately. This plan deliberately omits enforced-permission badges and does not claim to fix that server authorization gap. If product requires those badges or expanded privileges, approval and enforcement become prerequisites rather than assumed scope.
- **Scope-change triggers:** Cross-session draft retention, background/offline queues, broader mobile administration, or database migrations require explicit approval. They are not silently delegated product decisions.

No additional blocking user clarification was identified for saving the existing plan. The plan remains a proposed execution specification with an outstanding independent-review gate, not an implemented feature or a verified test report.
