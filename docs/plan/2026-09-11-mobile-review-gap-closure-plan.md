# Mobile Review Gap Closure Plan

**Date:** 11 September 2026  
**Status:** Proposed — consolidated implementation specification; no implementation authorized by this request  
**Owner:** Main review thread for planning; implementation owners to be assigned

| Field             | Value                                                                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Project           | `/Users/youpele/DevWorld/bigbud`                                                                                                                |
| Branch / HEAD     | `main` / `75f02a937226129f2ca5e44475a64e546dfd4e3a`                                                                                             |
| Created           | 2026-09-11T14:50:23+02:00                                                                                                                       |
| Review R          | Current thread `3a45fb29-b906-48e5-b3e4-8db4a2ab7554`: original adaptation/recovery requirements and seven browser reproductions                |
| Review B          | Attached thread `c3eef796-b265-4108-9740-b667dc0b540f`: floating visual parity, drawer motion, accessibility and validation                     |
| Authorized work   | Compare reviews and save this plan only; no application edits, delegation, commits or pushes                                                    |
| Starting worktree | Existing uncommitted mobile visual implementation, shared web presentation extraction, dependencies, browser harnesses, and two untracked plans |

## Summary

Complete the mobile adaptation by repairing composition and delivery ownership first, then finishing connection presentation, conversation geometry, drawer behavior and actual visual acceptance. Preserve the recovery sidequest in `f2ec633ffc` and the useful portions of `75f02a9372` and the current visual worktree.

Both reviews correctly conclude **Partial**. Review R demonstrates functional failures that passing unit/smoke tests did not cover. Review B adds visual and interaction defects that Review R's initial checklist overstated as complete. Neither review's broad positive statements override the other review's concrete reproductions.

This plan governs the remaining work across all three earlier plans. It does not restart completed milestones. The later visual plan controls appearance: logo, actual/default title, `SidebarBottomIcon`, plus, and a tall bottom drawer. The original plan continues to control reliability, composition, lifecycle, accessibility and release requirements.

## Related Work

- [Original mobile adaptation plan](2026-09-06-mobile-floaty-chat-adaptation-plan.md): complete functional requirements, especially Phases 0–5 and the device matrix.
- [Recovery correctness sidequest](2026-09-09-mobile-recovery-correctness-plan.md): targeted baseline, bounded replay and verified completion.
- [Recovery evidence](../validation/2026-09-10-mobile-recovery-correctness-evidence.md): publication tests, operating limits and passing named synthetic memory fixture.
- [Floating visual-parity plan](2026-09-10-mobile-floating-chat-visual-parity-plan.md): current appearance, drawer and matched-screenshot requirements.
- Review R artifacts: `/tmp/bigbud-mobile-plan-review-probe.mjs` and `/tmp/bigbud-mobile-plan-review-probe-results.json`. These are temporary reproduction aids, not durable regression tests. The cases are specified below so implementation does not depend on these files surviving.
- Review B's attached transcript reports measured geometry and computed animation behavior. Its thread was still active when checked during planning. This document uses its supplied review, not a presumed later handoff; the attached thread has not been messaged or modified.
- Note/card/issue: none identified. Project note/card discovery returned tool errors; the supplied plans and stable thread IDs are the available references. No tracking item was created.

## Problem

The implementation has real reliability and usability defects despite green smoke tests. A question can receive unrelated draft text, accepted Stop can erase a draft, a pending command can restore data after Forget, and a refreshed uncertain send can lock the conversation indefinitely. Cold-loaded transcripts can ignore reader intent. Short review layouts can hide approval controls.

The visual implementation also centers the idle logo within the wrong box, transitions a different CSS property from the property being changed, and offers undersized logo/gesture targets. The screenshot harness validates its own short wrapper and never captures the floating reference. Existing drawer tests largely verify eventual state, not the claimed animation/race guarantees.

### Reconciled findings

Evidence labels: **R** = prior direct reproduction in this thread; **B** = attached review reproduction; **S** = current source or explicit original requirement. These are existing evidence, not newly executed runtime tests in this planning turn.

| ID  | Priority     | Finding and comparison                                                           | Evidence / disposition                                                                                                                                                        | Closure phase |
| --- | ------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| F01 | High         | Forget can be followed by storage recreation from pending delivery callbacks     | R: submitted message envelope reappeared after Forget. B's drawer cleanup test did not include an outstanding command. Confirmed functional defect                            | 1             |
| F02 | High         | Accepted Stop/approval uses ordinary-prompt cleanup                              | R: Stop acknowledgement changed the unsent prompt to empty. Shared cleanup also applies to approvals. Confirmed                                                               | 1–2           |
| F03 | High         | Question editing/submission shares the ordinary prompt                           | R: saved ordinary text became `answers.q1`, then disappeared. B's general preservation claim is superseded by this reproduction                                               | 1–2           |
| F04 | High         | Restored uncertain delivery has no usable reconciliation path                    | R: after refresh, transport/current data recovered but Send stayed disabled; no outcome lookup or recovery control. Confirmed                                                 | 2             |
| F05 | Medium       | IME Enter submits incomplete text                                                | R: `isComposing: true` dispatched `thread.turn.start`; S: no composition guard. Confirmed                                                                                     | 2             |
| F06 | Medium       | Following listeners/observer miss the transcript's asynchronous mount            | R: manual read-back showed no Latest; subsequent recovered content changed scrollTop from 0 to 11,317. Confirmed                                                              | 4             |
| F07 | High         | Combined review/composer height hides essential decisions                        | R: at 390×320, Approve occupied y=356–400. Individual section limits do not bound the complete region. Confirmed                                                              | 4             |
| F08 | Medium       | Thread Retry does not restart the lifecycle owner                                | S: thread notice calls `recovery.selectThread`; Settings uses `restart`. Wiring defect; exhaustion integration test must establish the user-visible repair                    | 3             |
| F09 | Medium       | Phase 5 connection presentation is incomplete                                    | S: selector takes freshness only; no 2s/10s escalation, offline/auth/exhaustion precedence or keyboard placement                                                              | 3             |
| F10 | High         | Empty-state centering uses the wrong reference area                              | B: 561px transcript versus 128px empty wrapper, approximately 216px vertical offset. S corroborates percentage-height chain. R's passing screenshot assertion is insufficient | 4             |
| F11 | High         | Drawer translation jumps instead of animating                                    | B: only opacity animated. S: transition lists `transform` while utilities change individual `translate`. Confirmed visual defect                                              | 5             |
| F12 | Medium       | Logo and swipe region have inadequate touch areas                                | B/S: 32px logo link and 4px visible handle with surrounding swipe-ignored content                                                                                             | 5             |
| F13 | Medium       | Drawer lifecycle assertions do not establish all claimed guarantees              | B/S: no verified exit state before reopen, immediate unpair boundary, real swipe/list-scroll separation or robust outside-dismissal check                                     | 5–6           |
| F14 | High         | Matched floating/mobile visual acceptance is missing                             | Both reviews: mobile captures only; floating screenshot always null. Existing floating browser fixture supplies a viable reference                                            | 6             |
| F15 | Medium       | Visual harness reliability and error collection are insufficient                 | R run passed; B timed out twice. Treat as unresolved reproducibility, not a universal failure or a proven production regression. Harnesses ignore `console.error`             | 0, 6          |
| F16 | Medium       | Important delivery/authentication/bootstrap integration cases remain unproved    | R/S: builders and mocked dispatch are insufficient proof for the actual mobile normalization/receipt/bootstrap path                                                           | 2, 6          |
| F17 | Medium       | Shared-web browser validation is inconclusive                                    | B reported RPC test-server failures; these are not established regressions caused by this diff                                                                                | 6             |
| F18 | Release gate | Physical keyboard, safe-area and assistive-technology matrix remains open        | Both reviews: Chromium emulation only; no physical iOS/Android pass                                                                                                           | 6             |
| F19 | Low          | Drawer root unmounts after close, unlike the planned cheap persistent controller | B/S: not independently demonstrated as a functional failure. Align ownership while fixing motion; avoid treating root presence alone as acceptance                            | 5             |
| F20 | Medium       | Old-server delivery evidence and operation-specific recovery remain incomplete   | S: unsupported outcome lookup is flattened to a generic error; no exact message-ID fallback or verified same-operation retry UI                                               | 2             |

The latest Review R run passed formatting, lint and all nine package typechecks. The earlier Rust/mobile-plan formatting reports are stale and do not represent a current mobile blocker. Unrelated Rust planning work remains outside this task.

## Goals

- Keep ordinary prompt, model choice, question answers and immutable submitted commands separate and recoverable.
- Make Forget final for the matching session's local data, including after late completions and timers.
- Offer accurate recovery of pending/uncertain actions without duplicate commands or an offline queue.
- Preserve fresh-baseline recovery, canonical replay boundaries, typing and cached conversation through reconnects.
- Complete the original connection presentation matrix through one owner/selector.
- Keep the reader in control; keep review decisions reachable in supported short viewports.
- Achieve actual transcript-centered idle presentation, smooth drawer movement and accessible touch targets.
- Demonstrate floating/mobile parity with matched fixtures and reviewable artifacts.
- Require tests that fail for the observed defects, followed by complete integrated validation.

## Non-Goals

- Rewriting the recovery engine, desktop delivery supervisor, provider adapters, canonical event store or SQLite deletion architecture.
- Reopening passed synthetic memory gates as a demand for production/allocator certification.
- New offline/background sends, fresh-ID resend of an uncertain operation, mobile scope badges, broader mutation privileges or server self-revocation.
- New attachments, voice controls, desktop window actions, provider installation or unsupported approval options.
- Changing the selected floating visual direction or replacing the bottom drawer with another navigation concept.
- Database migrations, Rust changes, unrelated formatting/cleanup, implementation during this planning request, or commit/push authority.

## Current State

### Preserved implementation

- `wsMobileRecovery.ts`, `.completion.ts` and `.deadline.ts` implement canonical paged replay, baseline-covered delayed-event handling and independent capture cleanup. Retain their real-hub lifecycle regressions.
- `mobileRecovery.controller.ts`, `.frames.ts`, `.tracking.ts` and `.stability.ts` provide baseline ownership, marker-gated cache application, generation/selection fencing and stable-period retry replenishment. Retain their budgets and conservative legacy recovery.
- `mobileRpc.requests.ts` and `mobileRpc.ts` have cancellable deferred initialization and disposed-client fencing. Fix delivery ownership above that boundary; do not remove this closeout.
- `useMobileConnection` owns clients, restart generations, expiry/resume and protocol evidence. Complete consumers rather than add another reconnection loop.
- Shared `ComposerSurface.styles.ts` contains presentation values only. Keep desktop runtime state out of mobile and preserve the existing desktop appearance.
- Router-owned overlay history, semantic navigation-view equality, provider/model rules, direct routes, theme preference and accessible logo IDs already exist.

### Concrete repair boundaries

| Area                     | Current source evidence                                                                                                                        | Required ownership change                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Draft cleanup            | `apps/mobile-web/src/lib/mobileComposerDraft.ts:285–292` clears prompt for any matching submitted revision                                     | Clear resolved operation metadata by operation identity; clear editable fields only when that operation owns their unchanged revision |
| Stale writes             | `screens/MobileThread.state.ts:113–138`, `screens/MobileThread.tsx:62–74` capture React setters in a controller without disposal               | Session-scoped operation ownership and generation-checked draft writes; route views subscribe rather than own asynchronous lifetimes  |
| Command integration      | `screens/MobileThread.commands.ts:103–206` performs one lookup after dispatch uncertainty and reuses prompt for questions                      | Reconciliation entry point for restored operations and current-generation requests; independent question editing                      |
| Existing bad expectation | `lib/mobileComposerDraft.test.ts` expects accepted interrupt cleanup to erase a prompt                                                         | Correct this test's requirement; do not preserve the defect to keep tests green                                                       |
| Thread Retry             | `screens/MobileThread.tsx:343–344` directly rebaselines                                                                                        | Public lifecycle restart callback                                                                                                     |
| Status presentation      | `components/shell/MobileConnectionNotice.logic.ts:9–42` switches only on freshness                                                             | One complete evidence/placement model shared by thread, gate, header, Settings and composer                                           |
| Transcript lifecycle     | `screens/MobileThread.scroll.ts:58–84` effects depend on thread ID but can run before a node exists                                            | Attach on actual node availability; detach/rebind for replacement nodes                                                               |
| Empty geometry           | `screens/MobileThread.view.tsx:53` and `components/threads/thread/MobileMessages.tsx:25–34` chain percentage minimum heights                   | Available-height flex/grid relationship that also grows for content                                                                   |
| Drawer                   | `components/ui/drawer.tsx:35–47,89–102`; `components/shell/MobileAppFrame.tsx` retained view                                                   | Consistent animated property, usable gesture region, explicit root/content lifetimes                                                  |
| Reference validation     | `apps/web/src/components/floating-assistant/FloatingAssistantShell.browser.tsx` renders `CompactChatShell` with fake native API/store fixtures | Reuse the real reference fixture for matched capture; lack of an Electron window is not a blocker                                     |

All paths in the phase descriptions are relative to `apps/mobile-web/src` unless otherwise stated. Exact new filenames are suggested concern boundaries; reuse existing equivalents before adding a module.

### Worktree baseline

Existing dirty groups are mobile shell/navigation/logo; message/composer/view presentation; launch/chats/project screens; mobile CSS/package metadata; drawer and empty-state logic/tests; mobile browser harnesses/README; three shared web composer consumers and `ComposerSurface.styles.ts`; `bun.lock`; the visual-parity and unrelated Rust plans. Preserve all of them. The planning snapshot recorded 31 existing dirty files and their hashes at `/tmp/bigbud-mobile-gap-plan-baseline.json`.

At implementation start record fresh HEAD, branch, dirty paths and content fingerprints. If another thread has changed an affected module, reconcile ownership and evidence before editing. Temporary manifests do not replace a fresh implementation-start baseline.

## Phases

### Phase 0: Establish durable failing cases and exact ownership

**Goal:** Make the reviewed failures independently reproducible and prevent another smoke-only completion claim.  
**Dependencies:** None.  
**Scope:** Test fixtures/helpers, implementation-start manifest and requirement-to-test map; no recovery rewrite.

1. Convert F01–F07 into focused regressions at their actual failure layer. Use controlled acknowledgement promises, asynchronous initial baselines, real route composition and the existing RPC codec. Add B's transcript-centering and movement cases, F10–F12.
2. Store one test mapping for F01–F20 and each phase exit. Record failing assertions before fixes. Include command type/request/identity and observable result, not CSS-class equality or only a test count.
3. Reuse the existing Playwright/Vite approach. Extract narrowly shared fixture/protocol/error/teardown helpers under `apps/mobile-web/tests/browser/` and keep the runner sequential to avoid shared dependency-optimizer races. Use a single owned server per run or isolated cache directories; no parallel overlapping cache mutation.
4. Collect `pageerror` and unexpected `console.error`, failed fixture requests, route/recovery phase and bounded startup timeout diagnostics. Redact URLs/credentials; do not dump real prompts or session tokens. Explicitly enumerate intentional protocol-error fixtures instead of suppressing all console errors.
5. Use deterministic clocks and valid session lifetimes relative to the fixture clock. Current browser fixtures use a 2099 expiry while real sessions last seven days; avoid out-of-range timer behavior in fixtures. This is a test hardening item, not an asserted explanation for B's timeout.
6. Before adding logic, split near-limit integration files by concern: `MobileThread.tsx`, `MobileComposer.tsx`, `MobileNavigationSheet.tsx`, and draft/controller modules as necessary. Preserve routes and all unconditional hook ordering.

**Tests:** Each repro must fail on the starting behavior for its intended reason; no generic timeout accepted as proof of a layout/delivery defect. Existing shell/recovery/delivery happy paths remain controls.  
**Exit:** A durable test and named owner exist for every confirmed defect; remaining investigations have specific distinguishing assertions.

### Phase 1: Make composition and delivery ownership safe

**Goal:** Stop data loss, cross-thread writes and post-Forget resurrection before enabling more recovery actions.  
**Dependencies:** Phase 0 cases.  
**Files:** `lib/mobileComposerDraft*`, `lib/mobileCommandDelivery*`, `screens/MobileThread.state.ts`, narrow context integration; shared local-forget helper used by `MobileAppFrame`, `MobileSessionGate`, `MobilePair` and `App`.

1. Introduce one lightweight mobile session operation owner keyed by normalized backend origin and session ID, with per-thread operation controllers. React route components subscribe by complete identity; they do not retain asynchronous callbacks that write through an old component's mutable ref. This is a small mobile owner, not desktop delivery supervision.
2. Give the owner an epoch/lease for durable writes. Check session identity, epoch, operation ID and relevant thread/request before every completion, timeout, reconciliation result, draft write and refresh side effect. Acknowledgement for thread A must not change thread B's composition or selected recovery target.
3. Add explicit idempotent disposal: clear local timers, cancel cancellable reads, settle waiting callers and invalidate callbacks. Ordinary navigation may retain session-owned pending operations; unsubscribe the old view. Same-session client replacement retains envelopes but fences the old client's callbacks. Disposal never means the remote command was rejected.
4. Define a shared Forget transition: synchronously invalidate all matching write leases and operation callbacks; stop recovery/client work; clear matching memory/storage/query data; clear session state and retained drawer content; navigate unpaired. An asynchronous finalizer must never recreate cleared data. Apply this behavior to every local Forget/Clear-session path, not only Settings.
5. On expiry, preserve composition in quarantine, disable commands and stop retries. Retain enough expired-session identity to permit correct Forget/replacement cleanup; do not discard the identity at startup and orphan its records. Replacement pairing purges the previous known session's composition before activating the new one. Never restore old-session drafts automatically into new credentials.
6. Separate ordinary prompt revision, question/request answer revisions, selected-model revision and immutable operation metadata. Remove resolved operation metadata by command ID even when newer typing exists; clear an editable field only if that operation submitted it and its revision still matches. Stop/approval never own ordinary prompt text. New-thread acknowledgement must not clear a newer model choice.
7. Use a versioned storage evolution if required. Read validated v1 records under the exact existing origin/session/thread identity. Preserve v1 pending/uncertain envelopes without changing any command field or ID; do not infer a question answer from ambiguous v1 prompt text. Unknown/malformed versions get a preservation warning, not an automatic resend. Write the new version only after successful conversion; on quota/denial retain memory and the existing warning behavior. Split schema, storage and update logic before exceeding 400 lines.
8. Keep operation admission bounded and explicit. An uncertain Send must retain its own envelope if the user invokes the supported thread-targeted Stop. At minimum support independent send/decision and Stop operation slots, with one unresolved operation per slot and synchronous duplicate guards. This is not a background queue; only explicit actions dispatch. Do not silently replace an unresolved operation to make room for another.

**Tests:** Forget during pending dispatch, timeout, outcome read and drawer exit; late resolution/rejection after Forget and replacement pairing; route A→B before acknowledgement; identity loading before controller creation; v1 uncertain restoration; denied/quota storage; accepted Send with newer typing/model choice; Stop/Approve preserve prompt; expired refresh→pair→cleanup; no stale cache/refetch selection side effects.  
**Exit:** F01/F02 and ownership portions of F03/F04 are fixed. No late event restores forgotten data or mutates another thread. Existing recovery remains green.

### Phase 2: Finish command recovery and question semantics

**Goal:** Every submitted operation can be inspected truthfully after refresh/reconnect without duplicating it.  
**Dependencies:** Phase 1 ownership/storage contract.  
**Files:** `screens/MobileThread.commands.ts`, `.userInput.ts`, focused delivery hook/reconciliation module, `lib/mobileRpc.ts`/`.errors.ts`, composer controls; `apps/server/src/server.mobile.commands.test.ts`, `server.mobile.delivery.test.ts`, existing outcome tests and narrow server/contract corrections only if demonstrated necessary.

1. Expose an operation-specific **Check delivery** action for restored or unresolved commands. After one successful current-generation recovery, perform one coalesced read-only reconciliation for eligible uncertain operations; repeated component renders must not poll. A user can check again. Never dispatch a command merely because a socket opens or a marker arrives.
2. Reconcile in this order: inspect the matching command outcome; refresh/read authoritative state for the submitted thread under the current owner; apply accepted/rejected/unknown evidence to that same operation. A known accepted receipt stays accepted if the subsequent data refresh fails; freshness remains stale separately. Return unknown/error to uncertain with a usable Check action.
3. Preserve typed unsupported-method evidence for the outcome endpoint using the existing RPC error-normalization pattern. Only that evidence enables old-server fallback. For Send, a fresh same-thread canonical user message with the exact submitted message ID can prove acceptance. Matching text, disappearance of an approval/question, provider idleness or missing history cannot. Stop/approval/question stay uncertain without a matching authoritative receipt.
4. Add an explicit **Retry same operation** action only for supported current-server behavior proved by the integration tests below, when authorized/current and the operation remains unresolved. Older/unsupported or generic-failure cases retain Check/help without guessed retry safety. Preserve command/message/request IDs, payload, model, timestamp and bootstrap recipe. Give each explicit transport attempt a fresh bounded local deadline; do not reuse an elapsed `deadlineAt` as the retry timer or modify the command timestamp. Reuse one dispatch/timeout implementation for first submit and retry.
5. Acquire locks before any asynchronous work. Handle synchronous dispatch throws as well as promise rejection. Deadline or transport loss means uncertain. Keep ordinary typing available. Show action-specific Send/Stop/approval/question status, not “Message accepted” for every command; expose sanitized confirmed rejection classification.
6. Remove ordinary `setPrompt` from question option/progression handlers. Bind the textarea in question mode to that request/question's custom answer. Clear custom answers on empty input too. Previous/Next restores each answer; Submit operates only on the active request's validated answers. Keep ordinary prompt untouched before, during and after review mode.
7. Revalidate restored question identity, option IDs/labels and current request shape against a fresh baseline before enabling Submit. Clamp invalid progression; require reselection when semantics changed. No 200ms auto-advance. Provide explicit Previous/Next/Submit and predictable focus for text-only as well as option questions.
8. Approval mode replaces the ordinary prompt surface with a bounded review; preserve its stored draft. Retain available review details and existing specialized decisions, including learning-skill labels. Use server-supported decision values only. Dismissal never dispatches acceptance/denial.
9. Guard Enter before `preventDefault`/dispatch when native composition is active; cover Safari's composition/key-event ordering where needed. Preserve Shift+Enter. Send/decision eligibility must be checked at admission, not only by disabled UI, while Stop retains its supported explicit recovery semantics.

**Server proof before retry exposure:** Use the authenticated mobile WebSocket, actual normalizer/command dispatch/receipt persistence and temporary resources. Verify model/modes and bootstrap distinction; dropped acknowledgement plus same-ID retry produces one logical turn/message; conflicting payload is rejected; bootstrap retry creates one thread/worktree; approval/question/Stop do not repeat side effects. Cover absent/invalid/expired authorization, mismatched thread/project receipts, sanitized rejection and unsupported old-server outcomes. Stub provider boundaries as needed, not the deduplication path under test.

**Exit:** F02–F05/F16/F20 pass. A refresh during a pending send eventually resolves from evidence or exposes usable conservative recovery controls. No fresh-ID or automatic resend is introduced.

### Phase 3: Complete lifecycle consumers and connection presentation

**Goal:** Connection controls use the existing owner and communicate the original matrix accurately.  
**Dependencies:** Phase 1 teardown/public identity contract; operation presentation contract from Phase 2.  
**Files:** `context/MobileRpcContext.tsx`, `lib/mobileConnection.ts`, `logic/mobileConnection.logic.ts`, connection selector/hook/notice, header/Settings/gate, thin thread integration.

1. Route every connection Retry/Reconnect through `restart`. Keep selected-history refresh as an internal data operation with a distinct API, not the connection recovery button. Fence/coalesce repeated Retry, online, focus and visible-resume triggers. Browser offline remains advisory; it does not invalidate a still-working socket.
2. Preserve existing protocol retry delays, exhaustion evidence, bounded self-healing streams and recovery stability budget. Do not add UI/query polling or parallel baseline loops. Test exhaustion with cached content and prove Retry creates one new client generation and reaches marker-applied recovery.
3. Provide one connection presentation model consuming transport/authorization evidence, recovery freshness/timestamps, browser advisory state, elapsed incident time and keyboard/viewport context. Incident timing must not reset for each protocol attempt. Use one cancellable threshold timer, not a render-loop clock.
4. Implement the matrix below and use it in header description, status slot, composer explanation and Settings. Keep operation delivery as an independent message. Replace raw internal freshness identifiers in Settings with user-facing transport/freshness, last successful refresh and stored expiry.
5. Use one polite announcement owner keyed by meaningful transition. The same incident moving near the composer must not be announced twice. No automatic focus/selection/keyboard changes. Clear timer/listener state on session replacement/unmount and honor reduced motion.
6. Ensure expired/rejected authorization is visible on direct thread routes with cached data, not only inside `MobileSessionGate`. Stop actions and retries at the authorization boundary; keep drafts readable locally and pairing help available. Do not label generic failures as revoked/expired.

| Evidence                           | Required presentation                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Healthy / short reconnect under 2s | Quiet inspectable indicator; no persistent connected banner or success toast                      |
| Reconnect at 2s                    | Blue reconnect text, with typing preserved                                                        |
| Reconnect at 10s                   | Expanded consequence and Retry/help; one equivalent near composer when the keyboard reduces space |
| Exhausted before/after thresholds  | Immediate red unable-to-connect state; owner restart and help                                     |
| Browser offline                    | Amber advisory only when useful; no invented server/provider failure                              |
| Socket open, recovery pending      | Refreshing chats; no synchronized/current claim before applied marker                             |
| Failed refresh with cache          | Amber last-known state, last successful refresh, cached provider activity described as last-known |
| Local expiry / explicit rejection  | Accurate pairing explanation; no new command/retry                                                |
| Generic handshake failure          | Unable to connect; no revocation claim                                                            |
| Command uncertain                  | Separate operation-specific amber explanation with Check delivery                                 |
| Recovery after escalation          | Brief confirmation, then quiet; no confirmation for a short blip                                  |

**Tests:** Fake-clock boundaries at 1,999/2,000 and 9,999/10,000ms; error+close deduplication; exhaustion before escalation; offline with open socket; keyboard placement without focus loss; expiry/rejection with cached thread; stale generation events; one automatic incident/reconciliation trigger; token-bearing errors redacted.  
**Exit:** F08/F09 pass and all original Phase 5 matrix rows have tests.

### Phase 4: Repair transcript, composer and review geometry

**Goal:** Restore reader control and reachable phone interaction while preserving floating presentation.  
**Dependencies:** Stable composition/status interfaces from Phases 2–3; geometry-only work may begin earlier with agreed props.  
**Files:** `screens/MobileThread.scroll.ts`, `.view.tsx`, `.view.logic.ts`, `MobileMessages`, composer review/question sections, mobile CSS and a viewport helper only if required by device evidence.

1. Bind scroll listeners and content observers to the actual mounted transcript node using a callback ref or node-aware effect. Rebind after initial loading, node replacement and thread changes. Disconnect old nodes and cancel delayed scroll work. A late initial-scroll timer must not override intervening user intent.
2. Compute following from reader position before growth; running state never overrides it. Follow message/Markdown/content resize only while enabled. When reading back, new streaming/recovery content preserves position; Latest restores following. Outline jumps respect reduced motion and the current transcript node.
3. Make the transcript content grow to at least the available inner height with an explicit flex/grid relationship. Let the idle child consume free space without relying on a percentage minimum-height chain with an indefinite parent. Populated content must continue growing so existing content observation works; never fix the entire message list to viewport height.
4. Preserve existing empty-state eligibility exclusions for pending work, questions, approvals, work logs and displayed notices. Compare logo center with the actual transcript's usable bounds, including padding, not its own empty wrapper. Require offsets ≤4 CSS pixels in deterministic fixtures.
5. Bound the **combined** composer/review region against available space. Keep header and status accounted for, detail/options scrolling, and primary/progression controls reachable. Approval mode should not also allocate an unused prompt surface. Use an in-flow flex/grid region with `min-height: 0`; permit a compact review-dominant mode on short viewports rather than clipping decisions.
6. Keep one safe-area owner per surface; avoid a full `100dvh` child plus parent top inset overflowing the viewport. Start with dynamic viewport CSS. If real-device keyboard behavior still requires `visualViewport`, use a small shared helper keyed to editable focus plus measured viewport reduction, with cleanup and no guessed keyboard height. That helper also informs Phase 3 placement.
7. Preserve floating tokens, project context and model/primary action priority. Collapse optional branch/worktree detail first. Keep mobile default text-sm and iOS editable-input 16px mitigation. Use measured overflow/focus assertions, not exact Tailwind strings.

**Tests:** Delayed cold baseline→read-back→stream/recovery update; Latest after manual reading; Markdown resize; empty→populated→empty; route switch; long approval/question and large prompt at 320×568, 390×320 and landscape; long labels, 200% text and injected nonzero safe areas. Primary buttons must be inside usable bounds and hit-testable; all long content must remain reachable through the intended scroll owner.  
**Exit:** F06/F07/F10 pass without restoring fixed-composer offsets or degrading reader behavior.

### Phase 5: Finish drawer motion, lifecycle and touch accessibility

**Goal:** Deliver the selected tall drawer with real movement and reliable dismissal.  
**Dependencies:** Phase 1's shared Forget transition; otherwise may run alongside Phases 2–4 on separate files.  
**Files:** `components/ui/drawer.tsx`, `MobileAppHeader.tsx`, `MobileAppFrame.tsx`, focused `MobileNavigationSheet` root/content splits, browser drawer cases.

1. Animate the property actually changed. With current Tailwind individual translation, include `translate` in the transition or use a consistent transform composition verified against installed Base UI 1.4.1. Preserve primitive drag styles/variables and gesture responsiveness; do not overwrite active swipe motion. Use approximately 280ms ease-out open, 220ms ease-in close and 200ms backdrop fade. Reduced motion completes without waiting for cosmetic durations.
2. Define a genuinely tall popup bounded by `100dvh`, the planned 2rem top gap and safe areas, not only an upper cap on content-sized height. Keep nonshrinking header/footer and one middle scrolling content area. Bottom inset is applied once.
3. Give the logo link at least a 44×44px target without enlarging the visible logo. Put the visual swipe bar inside a comfortably sized swipe-enabled region of at least 44px height. Keep lists/form controls swipe-ignored. Use existing primitive gestures, not custom document pointer listeners or swipe-to-open `SwipeArea` as a dismissal handle.
4. Keep the cheap Drawer root owned by the paired eligible shell; mount expensive feature content only for open/closing states. Retain the last view through normal exit and release it on primitive completion. Guard against rapid reopen and stale completion; retain semantic view equality to avoid the previously fixed render loop. Unpair/pairing-route entry clears content immediately without a sensitive exit animation.
5. Preserve the latest visual plan's history policy: push once on open; replace for subview changes and explicit dismissal; browser Back consumes the overlay and Forward reopens it. No arbitrary multi-step history. Thread selection/new chat replace/close correctly, and opening Settings never remounts the conversation.
6. Preserve focus trapping, dialog naming, background inertness, Escape/outside/Close/swipe paths and return focus after ordinary dismissal. After navigation/unpair, focus must go to the valid destination rather than a stale trigger. Do not autofocus an editable Settings field.

**Tests:** Sample actual geometry/active animation between endpoints in both directions; opacity-only animation must fail. Assert exit is in progress before rapid reopen; sample stability beyond the old close deadline. Check reduced-motion completion promptly, all dismissal paths, touch swipe versus list scroll, background locks, state/history updates exactly once, sensitive content absent immediately after unpair and still absent after late callbacks. Include F01's pending operation, not only an idle drawer.  
**Exit:** F11–F13/F19 pass and every interactive control has usable touch/focus behavior.

### Phase 6: Close evidence gaps and perform final acceptance

**Goal:** Demonstrate the actual combined behavior and design, with limitations recorded accurately.  
**Dependencies:** Prior phase exits; test/helper development begins in Phase 0.  
**Scope:** Mobile/browser harnesses, actual floating reference fixture, targeted server tests, validation evidence and final plan checklist updates.

1. Make mobile `test:browser` run all required route/delivery/question/lifecycle/layout/drawer cases sequentially. Add a documented browser-install command using the same Playwright version already used by web. Keep the current `.mjs` harness approach; this deliberately replaces the original suggested mobile Vitest-config filename while meeting its coverage/discovery requirements. Unit discovery must not execute browser fixtures.
2. Diagnose visual startup failures with phase-specific diagnostics and isolated resources. Do not merely increase timeouts or accept “passed once.” After the repair, require three consecutive clean serialized harness runs as the targeted flake check; stop repeating once this passes absent new changes.
3. Render the real `CompactChatShell` and composer using `FloatingAssistantShell.browser.tsx`/existing web fixture patterns with deterministic native API/store/provider data. Capture mobile and floating in their own appropriate harnesses. Do not import desktop runtime into mobile or recreate a reference using the mobile component itself.
4. Match theme, content width, title, prompt, model label, messages and provider/request state. Capture idle, typed, populated, running, approval/question and long-label states in light/dark; verify 320, 390 and 430px phone widths, short keyboard-height/landscape, plus matched wider reference dimensions. Record which state/dimension combinations were run.
5. Produce paired screenshots and JSON geometry/metadata under `/tmp`, with source revision/worktree fingerprints and exact commands. Visually review both surfaces; record each remaining difference and its touch-size, safe-area, typography or unsupported-functionality reason. The manifest fails visual acceptance when required floating screenshots are null. A screenshot-exists assertion alone is insufficient.
6. Run relevant floating/shared-composer browser coverage before the broad web browser suite. Diagnose RPC-test-server failures by testing isolated fixtures and comparing unchanged baseline in a separate disposable checkout if necessary. Never reset the shared worktree. Distinguish setup failures from changed-code failures with logs and reproduction; an aborted suite is not a pass. Fix attributable regressions; record unresolved unrelated failures and keep affected validation inconclusive.
7. Run the final repository gates once on the settled shared tree, including the full Vitest suite and both mobile builds. Rerun only affected gates after subsequent fixes. Do not use the unrelated Rust plan as a mobile blocker or sweep its formatting.
8. Execute the physical matrix before release acceptance, including actual supported deployment modes. Record device/browser versions, installed/browser mode and results. If hardware is unavailable, report code/browser completion separately and leave physical release checks open; do not fabricate or infer a pass.
9. Obtain a fresh requirements review of the final diff and F01–F20 matrix. Update implementation status/evidence in the plan documents only once proven; preserve their history and record any justified deviations.

**Exit:** No confirmed functional/visual defect remains, required matched evidence exists, all automated gates are accounted for, and device/deployment evidence is explicitly passed or still open.

### Proposed execution ownership after authorization

This table is a future handoff arrangement, not an instruction to create or message threads now. At most three implementation threads are needed. Every future brief/follow-up should name `@agent::implementer` or `@agent::code-consistency`, state file ownership, prohibit reverting others' work, and require a test-backed handoff with no commit/push.

| Track                       | Owns                                                                                         | Integration boundary                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| A: composition and delivery | Phases 1–2; draft/operation modules, command/question logic and narrow server/contract tests | Publishes stable identity/operation/action interfaces before UI rewiring                       |
| B: connection and status    | Phase 3; existing connection owner, selector/placement logic and focused tests               | Consumes A's teardown/operation contract; no separate recovery loop                            |
| C: geometry and navigation  | Phases 4–5; transcript, composer presentation, drawer/header and focused browser geometry    | Consumes A/B interfaces; no direct edits to their storage/RPC internals                        |
| Coordinator                 | Phase 0 ownership, Phase 6 combined evidence; thin `MobileThread.tsx`/context integration    | Serializes shared-file edits and root/browser validation; rejects handoffs without phase exits |

Never have two owners edit `MobileThread.tsx`, `MobileComposer.tsx`, `MobileAppFrame.tsx` or a shared browser helper concurrently. Land the concern splits/interfaces first, then explicitly transfer file ownership if necessary. Pending worker status or a green summary is not acceptance evidence.

## Risks And Decision Gates

- **Same-ID retries:** Mobile normalization, durable receipt and bootstrap behavior must be proved before retry UI is enabled. Unknown acceptance is never evidence for a fresh command. If the current supported-server contract cannot establish retry safety, finish Check/fallback first and identify the precise narrow capability/server correction before exposing retry.
- **Persisted data:** Client record conversion must preserve uncertain envelopes and identity. No SQLite migration is planned. If a database migration or broader authorization change becomes necessary, prepare evidence and a concrete scope change before proceeding.
- **Lifecycle:** Navigation detaches views; Forget invalidates ownership. Mixing these transitions loses pending work or recreates forgotten data. Tests must distinguish both.
- **Presentation versus evidence:** A connected socket, accepted command and current provider observation are different facts. No selector may merge them into a single successful state.
- **Scope:** Original visual directions superseded by the newer plan are intentional changes, not regressions. Shared web styling remains presentation-only and must not change floating behavior incidentally.
- **Validation:** B's web failures and visual timeout need diagnosis, not unsupported attribution. R's passing scripts do not prove matrix rows they never asserted.
- **Platform:** Real-device keyboard/assistive-technology/deployment validation is a release gate. Synthetic memory limits are already accepted within their recorded scope; production memory certification is not newly required.
- **Rollback:** Presentation can roll back independently. Retain safe delivery/Forget fixes. Read previous draft versions conservatively; never roll back by clearing uncertain envelopes or restoring fresh-ID retry. Do not downgrade to code unable to safely read new pending records without an explicit preservation strategy.

## Testing And Validation

### Existing evidence, not new planning-run claims

Review R recorded 154 mobile tests, 27 focused server tests, all nine package typechecks, lint, format check, both mobile builds, and shell/delivery/recovery/drawer/visual scripts passing. Its seven extra browser probes exposed F01–F07 despite those passes. Review B separately measured F10–F12, encountered two visual startup timeouts and inconclusive web browser failures. Physical checks were not performed by either review.

This planning turn inspected code, the supplied transcripts, existing artifacts, package scripts and installed Base UI source. Application tests/builds were not rerun just to write this document. Only the new plan receives a scoped formatting/read-back check.

### Required final commands

Run from the repository root after implementation is stable. Use the actual new focused filenames, keeping server runs sequential. The original `test:browser` currently runs shell only; expand it in Phase 6 before treating that command as complete browser coverage.

```sh
bun run --cwd apps/mobile-web test
bun run --cwd apps/mobile-web typecheck
bun run --cwd apps/server vitest run src/server.mobile.commands.test.ts src/server.mobile.delivery.test.ts src/server.mobile.recovery.test.ts src/server.mobile.ws.test.ts
bun run --cwd apps/server vitest run src/ws/wsMobileRecovery.test.ts src/ws/wsMobileRecovery.lifecycle.test.ts
bun run --cwd apps/mobile-web test:browser
node apps/mobile-web/tests/browser/visual-parity.mjs
bun run --cwd apps/web test:browser src/components/floating-assistant/FloatingAssistantShell.browser.tsx
bun run --cwd apps/web test:browser
bun run --cwd apps/mobile-web build
bun run --cwd apps/mobile-web build:desktop
bun run test
bun fmt
bun lint
bun typecheck
bun fmt:check
git diff --check
```

Use the shared web browser prerequisite if needed: `bun run --cwd apps/web test:browser:install`. The proposed mobile install alias must use the same version. Never run `bun test`. Rust checks are unnecessary because this plan changes no Rust. During implementation, scope/review formatter changes against the recorded dirty baseline; do not format unrelated user files just to make a global result green.

### Acceptance evidence matrix

| Area                   | Required cases beyond existing smoke coverage                                                                                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Composition            | Ordinary/question separation; acknowledgement after newer typing/model selection; terminal-operation cleanup; malformed/denied/quota/v1 storage; no cross-thread/session restoration                                            |
| Delivery               | All command kinds; concurrent activation; pending refresh/navigation/restart; unknown/accepted/rejected; explicit same-ID retry; old-server exact-ID fallback; synchronous throw; fresh local retry deadline; no implicit sends |
| Teardown               | Forget/expiry/re-pair during dispatch, read, timer and drawer exit; late results cannot persist or change selected data; independent explicit Stop retains unresolved Send evidence                                             |
| Recovery protection    | Baseline/cursor publication; delayed baseline-covered events; paged replay/gaps/overflow; independent watchdog cleanup; applied marker; stable reconnect budget; old-client/desktop defaults                                    |
| Connection             | Every Phase 3 matrix row; exact thresholds; deduplicated announcements; cached provider qualifiers; stable focus/selection and one restart owner                                                                                |
| Conversation           | Actual transcript-centered logo; content-growth observation; cold-load read-back; Latest; viewport and text scaling; IME/Shift+Enter; long approvals/questions and reachable actions                                            |
| Drawer                 | Real motion in both directions; reduced motion; verified exit/reopen race; all dismissal paths; gesture/list-scroll separation; history/focus/scroll locks; immediate sensitive cleanup                                         |
| Security               | Narrow authenticated outcome read; thread/project receipt isolation; no scope expansion; no raw credentials/URLs/diagnostics in new UI or test logging; matching storage removal                                                |
| Visual parity          | Paired actual floating/mobile captures for states/themes/widths; geometry checks and human comparison; documented intentional differences; unexpected console errors fail                                                       |
| Supported environments | Hosted mobile and desktop-hosted `/mobile/`; real iPhone Safari/installed mode where supported, Android Chrome, keyboard/IME, suspend/resume, rotation/safe areas, VoiceOver/TalkBack                                           |

Record exact device/OS/browser versions and distinguish fixture, authenticated real backend, emulation and physical evidence. Source/test files authored or materially edited must remain at most 400 lines, including browser scripts/helpers.

## Acceptance Criteria

- [ ] F01: Forget permanently removes matching local composition/operations despite late work.
- [ ] F02–F03: Stop/approval/question actions cannot erase or submit unrelated ordinary draft text.
- [ ] F04/F20: Restored uncertainty has usable evidence-based reconciliation and conservative old-server handling.
- [ ] F05: IME confirmation cannot dispatch or advance; Shift+Enter remains multiline.
- [ ] F06: Cold-loaded and replaced transcripts respect read-back and Latest throughout content growth.
- [ ] F07: Long review and short viewport controls remain visible, reachable and operable.
- [ ] F08–F09: All connection Retry uses the owner; every original presentation-matrix row is implemented and tested.
- [ ] F10: Idle logo is centered against actual usable transcript bounds without hiding activity.
- [ ] F11–F12: Drawer truly slides, respects reduced motion and supplies usable touch/gesture targets.
- [ ] F13/F19: Drawer lifecycle, history, focus, all dismissals and immediate unpair cleanup are proved.
- [ ] F14–F15: Reproducible paired visual evidence passes meaningful geometry/motion/error assertions.
- [ ] F16: Actual mobile-server delivery, deduplication, payload conflict, bootstrap and auth cases pass.
- [ ] F17: Shared-web browser results are conclusive for changed behavior; no unexplained failure is labeled passed.
- [ ] F18: Physical/deployment release matrix is recorded with any unavailable checks explicitly open.
- [ ] Completed recovery, provider/model constraints, canonical routes and desktop presentation are preserved.
- [ ] Full required checks pass; all changed source/test files satisfy the 400-line limit.
- [ ] Final review maps each original requirement and F01–F20 to concrete implementation and test evidence.
- [ ] No unrelated files, commits, pushes or external state were changed without the applicable authorization.

## Open Questions

No unresolved product decision blocks implementing this specification once the user authorizes implementation. The chosen visual direction, bottom drawer, local Forget semantics, conservative delivery and recovery boundaries are settled.

Before release, assign a physical-device validation owner and identify available iOS/Android devices and deployment targets. If unavailable, leave those acceptance rows open while completing the code and deterministic browser work. No additional plan/design question is needed from the user now.
