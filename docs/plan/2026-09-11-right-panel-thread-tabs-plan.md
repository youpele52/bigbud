# Right-panel thread tabs — initial draft

**Date:** 11 September, 2026  
**Status:** Draft — needs clarification and direction; not ready for implementation  
**Owner:** Product direction: user; planning: Codex  
**Created:** 2026-09-11 14:54:38 SAST (UTC+02:00)  
**Last modified:** 2026-09-11 14:54:38 SAST (UTC+02:00)  
**Project root:** `/Users/youpele/DevWorld/bigbud`  
**Inspected branch:** `main`  
**Inspected commit:** `75f02a937226129f2ca5e44475a64e546dfd4e3a`  
**Issue ID:** None supplied.

## Summary

Allow a thread from any project in the sidebar to open as a tab in the existing right panel. Open it by dragging the thread into the panel or selecting an action in the thread's context menu. Reuse the existing chat view and composer. Show the provider icon and truncated thread title, with a tooltip containing `Project name > Full thread title`.

This document preserves the initial requirements, repository findings, architecture options, and outstanding decisions. **Recommendations below are proposals, not approved implementation decisions. Do not begin implementation from this draft.** The user explicitly requested an initial draft needing clarification and direction.

The recommended direction is a shared ChatView with explicit thread context and pane-specific navigation/resource actions. Loading and operating on a right-panel thread must never silently use the centre thread's project or execution target. The exact interaction rules and the extent of supporting refactoring remain to be agreed.

## Related Work

- Source discussion: bigbud thread `5e577f13-c2c1-42ff-bc21-64ca7b4e1105`.
- Visual inspiration: [T3 Code split-view demonstration](https://x.com/bil0090/status/2098133207845658716). Successive playback frames were inspected. This is product inspiration; no upstream implementation was inspected or selected for transplantation.
- Existing embedded composer: `apps/web/src/components/chat/view/ThreadComposerSurface.tsx`.
- Repository plan guidance: [\_plan-authoring-guide--do-not-delete.md](./_plan-authoring-guide--do-not-delete.md).
- No note, Kanban card, issue, or PR was supplied in the discussion. Project note/card discovery was attempted, but both orchestration tools returned `dynamic tool request failed`; no related reference was verified.

## Problem

The app already has a right panel with browser, files, Git, diff, terminal, notes, and Kanban tabs. It currently has no thread tab kind. Opening a thread normally changes the centre route.

Displaying another ChatView is not sufficient on its own. The existing chat hook tree includes global keyboard listeners, focus effects, route navigation, terminal hosting, and instance-local submission state. A second unchanged instance could target the wrong pane, mount duplicate terminal clients, or race another view of the same thread.

Some resource panels explicitly follow the centre thread today. Even if sending uses the correct right-panel thread, opening files, Git, diff, or a terminal from that chat could still use the centre workspace without additional context plumbing.

## Goals

### Agreed phase-one requirements

- Reuse the existing right panel, including its tab structure and established resize, activation, reorder, and close behaviour.
- Open a thread from the thread list regardless of which project it belongs to.
- Support drag-and-drop and a thread context-menu action such as **Open in right panel**. Final wording is not settled.
- Use the thread title as the tab name and the provider icon as its logo.
- Preserve dynamic provider-icon status colouring where supported by the existing presentation logic.
- Truncate long right-panel thread titles visually with an ellipsis; show `Project name > Full thread title` on hover.
- Reuse the existing ChatView and composer. The requested presentation difference is the thread identity: provider icon, title, and project tooltip.
- Preserve the existing centre chat presentation and normal sidebar-click behaviour.
- Keep optional vertical stacking out of phase one.

### Proposed correctness criteria

- Opening or using panel thread B does not silently switch the centre from thread A.
- Every send, approval, workspace operation, and resource action resolves against its originating thread.
- Hidden views cannot steal focus, consume another pane's chat shortcuts, or clear unread state merely by remaining mounted.
- Closing a tab does not stop its provider session, delete its thread, or lose its saved draft.
- Failure to load a thread/project leaves a local, recoverable panel state rather than substituting the centre workspace.

These correctness criteria inform the recommendation, but the specific interaction policies in Open Questions still require direction.

## Non-Goals

- Phase-two top/bottom stacking or a general docking layout system.
- Redesigning the centre header or building a replacement composer.
- Moving threads between projects through drag-and-drop.
- Adding a general thread picker to the right-panel plus menu; the requested entry points are thread dragging and the context menu.
- Implementing upstream T3 Code changes directly.
- Committing, pushing, or implementing code as part of this draft task.

Tab persistence across app restarts, batch opening selected threads, and closed-panel edge-drop behaviour are not approved scope. They must not be added implicitly.

## Current State

Paths below are relative to the project root. Line references describe the inspected revision and may move.

| Area                    | Evidence and implication                                                                                                                                                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tab state               | `apps/web/src/stores/rightPanel/rightPanelTabs.store.ts:5` defines the kind/ID unions. Browsers have instance IDs; other kinds are singletons. The store is session-local and limits browser tabs to five. Thread tabs need their own instance identity rather than a singleton `thread` tab.                         |
| Panel composition       | `apps/web/src/components/right-panel/RightPanelHost.tsx` supplies the centre `activeThreadId` to several resource panels. Existing panel content generally stays mounted while inactive, with visibility and `inert` controls.                                                                                        |
| Tab presentation        | `apps/web/src/components/right-panel/RightPanelTabs.tsx` renders labels, icons, close buttons, tab reordering, and the plus menu. It is already 388 lines; adding responsibilities requires extraction before exceeding the 400-line source limit.                                                                    |
| Closing tabs            | `apps/web/src/stores/rightPanel/rightPanel.closeActiveTab.ts` dispatches closing by kind; a thread implementation must support closing one specific tab.                                                                                                                                                              |
| Thread drag payload     | `apps/web/src/components/sidebar/SidebarThreadRow.tsx:164` emits `application/x-bigbud-thread-context` with thread ID and title. `threadPanel.dnd.ts` provides serialization/parsing. Reuse this identity and resolve fresh metadata from state.                                                                      |
| Existing drop meaning   | `apps/web/src/components/chat/view/chat-view/chat-view-interactions.files.hooks.ts` accepts that same payload as a composer context attachment. Panel-opening drop precedence is an unresolved product decision.                                                                                                      |
| Context menu            | `apps/web/src/components/sidebar/Sidebar.threadActions.ts:199` builds the single-thread menu through the existing native API abstraction. Project, Chats, and favourites rows share this action plumbing.                                                                                                             |
| Provider status         | `SidebarThreadRow.tsx` combines `resolveThreadStatusPill`, `providerIconPresentationClass`, and `shouldAnimateProviderIcon` with `PROVIDER_ICON_BY_PROVIDER`. `SidebarThreadProviderIcon.tsx` renders the icon. Reuse these semantics rather than inventing another status mapping.                                   |
| Shared chat             | `apps/web/src/components/chat/view/ChatView.tsx` takes explicit `threadId` and composes shared hooks. `ThreadComposerSurface.tsx` already uses the same hook tree with embedded effects and disabled global keybindings. This is a reuse precedent, not a complete full-chat embedding solution.                      |
| Header and body         | `chat-view/ChatViewContent.tsx` renders `ChatHeader`, `ChatViewChatBody`, terminal drawers, and overlays. `ChatViewMainComposer.tsx` renders the shared composer and marks itself as the default chat focus scope. Two defaults would need correction.                                                                |
| Bounded data loading    | `apps/web/src/routes/-__root.bounded-bootstrap.ts:239` implements `hydrateSelectedThread`, including event buffering and loading-state deduplication. `stores/main/helpers.lazy.store.ts:365` requires a thread summary before merging its detail. Sidebar catalog synchronization seeds summaries into thread state. |
| Project loading         | A listed thread's project may not yet be in the bounded project catalog. `helpers.lazy.projects.store.ts` provides sequence/deletion-aware `mergeProjectCatalog`; a targeted merge must preserve unrelated projects and sidebar pagination.                                                                           |
| Route-only effects      | `routes/_chat.$threadId.tsx` handles ownership, loading, page title, and diff URL synchronization. `-_chat.$threadId.activation.ts` changes selected project and last active thread. These route effects must not be mounted wholesale in the right panel.                                                            |
| Remote access           | `Sidebar.remoteThreadActivation.ts` performs the remote access check and reconnects open terminals. Reuse the applicable policy while separating its navigation callback from centre routing.                                                                                                                         |
| Focus                   | `components/chat/ChatFocusShortcutCoordinator.tsx` and `lib/chatFocus.ts` already use chat/browser focus scopes. Chat keybindings and plan-card shortcuts also install window listeners.                                                                                                                              |
| Navigation/resources    | `chat-view-runtime.hooks.ts`, `chat-view-interactions.hooks.ts`, `ChatViewChatBody.tsx`, and `chat-view-provider-switch.hooks.ts` contain route-dependent actions. `DiffPanel.logic.ts` reads route thread/search state. File-panel coordination already supports workspace/execution-target overrides.               |
| Same-thread concurrency | Composer drafts are keyed by thread, but send-in-flight refs, local dispatch, cursor, and optimistic state include instance-local state. Two views need explicit duplicate-operation and attachment-lifetime handling.                                                                                                |
| Terminal ownership      | `ChatViewContent.tsx` renders the global mounted-terminal inventory. A second unchanged ChatView can render it again. The hosting change should be only as broad as needed to ensure one mounted owner per terminal.                                                                                                  |
| Recovery                | `routes/-__root.recovery.ts` performs bounded recovery for the selected route thread. Catalog synchronization can retain other threads' loaded hydration state. Panel freshness after a recovery baseline needs explicit handling and tests.                                                                          |

### Architecture options — decision pending

| Option                                                   | Description                                                                                                                                                                                   | Benefits                                                                          | Costs                                                                                                              |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| **1. Shared pane-aware ChatView — recommended**          | One shared chat composition with explicit thread identity and semantic host actions for navigation and resources. Centre defaults remain intact; right-panel actions target its tabs/context. | Consistent behaviour and fixes across surfaces; best matches the requested reuse. | Requires careful refactoring of effects, resource context, focus, and ownership.                                   |
| **2. Separate panel controller sharing leaf components** | Reuse messages/composer but orchestrate panel loading and actions separately.                                                                                                                 | Easier initial isolation.                                                         | Duplicates chat orchestration and risks behaviour drift; does not automatically solve shared draft/terminal races. |
| **3. Embedded app view**                                 | Load a separate route in an iframe or renderer.                                                                                                                                               | Stronger UI isolation.                                                            | More runtime overhead and complicated focus, theme, drag-and-drop, subscriptions, and shared-state integration.    |

None of these alternatives has been approved. Option 1 is the planning recommendation, independently supported by the repository review.

### Assumptions to verify

- Existing contracts and bounded APIs should be sufficient; no database migration or provider-session change is currently indicated. Verify targeted project/summary loading before treating this as settled.
- Any registered provider should use the existing icon/status resolver; an unknown provider needs a neutral fallback, not a guessed identity.
- Session-only tab state is the smallest extension of current behaviour. Restart persistence requires an explicit decision.
- Pane focus should not overwrite the app's selected project. Workspace-dependent actions should receive source context directly.

### Worktree and validity

The working tree was already dirty and remained so during read-only research. Existing changes include mobile-web screens, shell, composer, browser tests and package metadata; `bun.lock`; web `ComposerFooterLeading.tsx`, `OrchestraPlayerComposer.tsx`, and `chat-view/ChatViewComposer.tsx`; an untracked `ComposerSurface.styles.ts`; and the two 2026-09-10 plan files. Preserve this work. In particular, the shared composer is actively being edited.

Revalidate branch, SHA, `git status --short`, and these shared modules before implementation. New changes to chat effects, lazy hydration/recovery, panel coordination, or composer state may invalidate the proposed decomposition. Root `AGENTS.md` applies; no nested application instructions were found during research. Every added or materially edited source/test file must be at most 400 lines; `chat-view-runtime.hooks.ts` is already 431 lines and must be split if materially edited.

## Phases

### Planning gate: clarify direction before implementation

Resolve Open Questions, choose the architecture, and refine this draft into exact interfaces and executable steps. Preserve the agreed requirements. In particular, decide drop precedence, same-thread dual-view behaviour, panel-origin navigation/resources, and state retention before marking the plan ready.

### Phase 1: thread tabs in the existing right panel

The following is a proposed implementation sequence for option 1, not an approved specification.

1. **Define thread tabs and coordination.** Extend `rightPanelTabs.store.ts` with a thread-instance ID such as `thread:<threadId>` and dedicated opening/activation. Proposed behaviour: opening the same thread again activates its existing panel tab. Keep singleton-kind APIs distinct from instance-kind APIs; update kind switches, close-by-ID, and `rightPanel.coordinator.ts`. Extract focused tab presentation/menu modules from `RightPanelTabs.tsx` rather than growing it past 400 lines. Preserve browser limits and existing tab semantics.

2. **Provide route-neutral thread/project loading.** Add a focused loader and panel wrapper using the existing bounded hydration/event-buffer path. Load missing project context with bounded priority-project catalog requests and sequence-aware merging that does not reset sidebar cursors or selected project. Recover missing summaries through bounded canonical APIs rather than trusting drag titles. Coalesce concurrent requests. Reuse canonical draft ownership and remote-access guarantees where applicable, without centre navigation. Show loading, retry, and unavailable states within the tab. Do not create a thread or provider session merely to view it.

3. **Introduce a shared presentation/host boundary.** Extend the existing ChatView composition instead of copying its hook tree. Pass a surface identity, visibility/focus ownership, and semantic actions for opening threads and resources. Keep centre defaults unchanged. The right-panel wrapper must not invoke route activation, page-title updates, or centre diff-search synchronization. Reuse `ChatViewChatBody`, `ChatViewMainComposer`, and `ChatViewComposer`; preserve functional controls. Specify how the panel header retains existing actions at narrow widths before changing it.

4. **Render live thread identity.** Share provider-status resolution with the sidebar through a focused common module. Render provider icon, title ellipsis, and the full project/title tooltip in the agreed panel locations. Subscribe narrowly to live title, project name, provider, and status. Preserve existing status colours and reduced-motion behaviour; do not fetch thread detail just to update a tab label.

5. **Scope navigation and workspace resources.** Replace panel-sensitive route calls with source-aware host actions while retaining centre implementations. Cover branch creation, provider-switch/handoff branches, parent/watched-thread links, PR preparation/materialization, and turn diffs. Carry source workspace/execution target for files, Git, and terminal actions as well as diff. Reuse existing file-panel context overrides. Explicit panel-owned diff context must coexist with centre URL-backed diff state; centre URL synchronization must not close or overwrite it. Decide whether related-thread transitions replace the current tab or open another tab.

6. **Make focus, operation state, and terminal ownership safe.** Gate global chat shortcuts, auto-focus/blur, search focus requests, and visited-state effects by the intended visible surface. Preserve editor-local handling. Ensure only the centre is the default chat focus scope. Prevent duplicate submission of the same operation/request across views while preserving intentional overlap and existing prompt-queue behaviour; do not add a blanket thread mutex. Async work must outlive a tab switch/close without recreating or activating a closed tab. Coalesce attachment persistence and protect shared preview URL lifetimes. Ensure one mounted owner per terminal and audit side-chat/portal ownership, without building a general docking framework.

7. **Connect the requested entry points.** Add the shared context-menu action in `Sidebar.threadActions.ts` and route it through the same coordinator used by drops. Reuse the typed thread drag payload. Resolve current canonical identity, reject malformed/external data, and never reparent a thread. Distinguish thread drops from tab reordering. Implement drop-zone and composer precedence only after the interaction decision. Browser iframe/native-webview content may require a parent drop overlay during a valid thread drag; verify in Electron rather than assuming bubbling reaches the host.

8. **Define visibility, retention, and recovery.** Proposed performance direction: mount only the selected visible panel ChatView, keeping tab metadata lightweight. Before choosing this, define retention for composer cursor, scroll anchor, reader expansion state, terminal layout, and unsent pending-question responses; specify which menus/dialogs dismiss. Preserve existing canonical drafts. After bounded recovery, refresh visible panel detail with event-buffer/generation protection and refresh inactive tabs on activation. A missing summary during loading is not proof of deletion. Confirmed deletion/archive behaviour needs a product rule and must preserve canonical deletion safeguards.

**Dependencies:** Steps 2–6 must establish safe multi-view behaviour before exposing step 7 to users. Step 8 must be tested before phase one can ship.

**Proposed exit condition:** All agreed phase-one requirements and resolved decision rules have passing targeted validation, with no wrong-thread operations, duplicate terminal mounts, or centre-navigation regressions.

### Phase 2: optional vertical stacking — deferred

The user described dropping another thread above or below a right-panel thread, but explicitly considered it unnecessary for now. Do not implement nested splitters, top/bottom drop zones, or persisted split layouts in phase one. Revisit only after a separate product decision.

## Risks And Decision Gates

- **Wrong workspace or execution target:** a blocking correctness risk. Missing context must never fall back to the centre thread. Test remote/local cross-project actions, not only message sending.
- **State lost on tab switch:** active-only mounting is a recommendation, not a complete retention design. Resolve retained state before implementing unmount behaviour.
- **Duplicate operations:** sharing only a draft does not share in-flight state. Use operation/request identity and preserve existing overlap policy.
- **Focus and terminal duplication:** a second full hook tree can install competing listeners and clients. Keep ownership changes focused and test actual simultaneous views.
- **Recovery races:** stale requests must not overwrite a new recovery baseline, restore deleted content, or resurrect closed tabs. Preserve event buffering and bounded recovery.
- **Drop conflict:** thread dragging already has a useful composer meaning. Do not silently replace it without the user's decision.
- **Scope expansion:** resource-context fixes are necessary for correctness, but a general workspace/docking framework is not an approved goal.
- **Concurrent work:** shared composer changes predate this plan. Revalidate and integrate them; never revert them as part of this feature.

Rollout should remain limited to phase one. No persistence or backend migration is currently proposed. If the feature needs to be withdrawn, remove its new entry points without stopping provider sessions or deleting threads/drafts. Any future schema, terminal-lifecycle, or persisted-state changes require an updated rollout/rollback section.

## Testing And Validation

No code was implemented and no format, lint, typecheck, or test commands were run for this initial draft. Those commands are implementation completion requirements, not claimed results. Planning operations were read-only except for this Markdown file.

Reuse existing coverage around `rightPanelTabs.store.test.ts`, `rightPanel.closeActiveTab.test.ts`, `RightPanelHost.test.tsx`, `threadPanel.dnd.test.ts`, `SidebarThreadProviderIcon.test.tsx`, `ChatFocusShortcutCoordinator.browser.tsx`, ChatView browser fixtures, `ChatView.terminalLayout.browser.tsx`, send ownership tests, and bounded-bootstrap/recovery tests.

Required scenarios after the decisions are settled:

- Open from project, remote project, Chats, and favourites rows; activate, reorder, and close thread tabs alongside every existing panel kind.
- Open B from an unloaded project while A remains in the centre. Send, stop, approve, reply, change provider/model, open resources, and prepare worktrees against B's correct context.
- Verify the agreed tab/header identity, long-title tooltip, rename updates, status colours, provider fallback, and reduced motion.
- Verify drop precedence, tab reorder isolation, invalid payloads, cancelled drags, and native-browser drop interception.
- Alternate focus between composers, terminal, menus, and dialogs; each chat shortcut acts once on its intended surface.
- If the same thread is allowed in both panes, test shared draft updates, operation deduplication, attachments, and independent scroll/cursor behaviour.
- Switch/hide/close tabs during worktree preparation, attachment persistence, pending-question entry, and request submission. Verify retention and that late completions do not reopen tabs.
- Verify one mounted terminal owner, correct source-thread resource context, and no duplicated side-chat host.
- Test initial load failure/retry, remote unavailability, streaming reconnect, baseline recovery, archive/delete, and project removal.
- Check the existing 320px minimum panel width, resizing, keyboard accessibility, tooltip focus behaviour, and centre responsiveness. Manually validate Electron drag/focus behaviour on macOS, Windows, and Linux.

Implementation commands, selecting the final focused test paths once the decomposition is agreed:

```sh
bun run --cwd apps/web test <focused-test-paths>
bun run --cwd apps/web test:browser <focused-browser-test-paths>
bun fmt
bun lint
bun typecheck
```

Use `bun run test` if broader validation is justified. Never use `bun test`. Split every materially edited source/test file exceeding 400 lines. Rust checks apply only if later approved scope introduces Rust changes.

## Acceptance Criteria

### This draft

- Preserves the initial user request and researched architecture options.
- Clearly marks recommendations and unresolved choices.
- Is saved in `docs/plan` and explicitly **not ready for implementation**.
- Includes requirements-coverage and execution-readiness review, plus independent review corrections.

### Future implementation

- Delivers the agreed phase-one requirements under Goals.
- Uses shared chat/composer behaviour with correct per-thread context and the agreed navigation/drop/retention policies.
- Preserves centre behaviour and existing panel features.
- Passes targeted regression/browser validation and `bun fmt`, `bun lint`, and `bun typecheck`.
- Has no unresolved correctness findings involving routing, execution targets, duplicate operations, terminal ownership, or recovery.

## Open Questions

1. **Architecture direction:** approve the recommended shared pane-aware ChatView, or choose one of the alternatives?
2. **Composer drop precedence:** should dropping a thread directly on the panel composer continue attaching context, with the tab bar/chat area opening tabs, or should every thread drop in the panel open a tab? The recommendation is to preserve composer context drops. No answer was received.
3. **Closed panel:** must dragging to the right edge reveal/open it, or is opening the panel first sufficient, with the context menu as the direct closed-panel entry point?
4. **Same thread in both panes:** allow two views sharing the canonical draft, or avoid dual display? If allowed, explicitly agree on draft sharing and independent view-state expectations.
5. **Thread navigation inside the panel:** should branches and related-thread links replace the current panel tab or open additional tabs? Should any actions intentionally navigate the centre?
6. **Resource tools:** should a tool opened from panel B select its source context until another explicit action changes it? Clarify how that interacts with existing centre-based launcher behaviour and navigation.
7. **Header presentation:** should icon/title/tooltip appear in both the tab and the chat header, or should the tab supply identity while the header retains only actions? Existing chat functionality must remain reachable.
8. **Lifecycle and retention:** confirm close/archive/delete behaviour, inactive-tab state retention, and whether restart persistence or a thread-tab limit belongs in phase one.

### Review and handoff notes

Requirements coverage and execution readiness were reviewed during drafting. Independent read-only review supported option 1 and identified two corrections incorporated above: source context must cover files/Git/terminal as well as diff, and inactive-view state retention must be explicitly defined. It also recommended operation-specific duplicate prevention rather than a blanket mutex and keeping terminal-host refactoring narrowly scoped.

The review did not approve unresolved product decisions. This remains an initial draft awaiting clarification and direction. The next agent should resolve those decisions, tighten the proposed sequence into an implementation-ready plan, and repeat review. Do not reopen settled phase-one requirements or include phase-two stacking without new user direction. No implementation, commit, or push is authorized by the act of saving this draft.
