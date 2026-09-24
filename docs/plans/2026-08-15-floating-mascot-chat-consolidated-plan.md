# Floating Mascot And Compact Chat Consolidated Plan

**Date:** 15 August, 2026  
**Status:** Proposed  
**Owner:** bigbud team

## Summary

Add an optional desktop-only floating bigbud mascot that remains available above ordinary applications while the main bigbud window is closed. Clicking the mascot opens one small, focusable chat window sized similarly to the existing Sidecar. Users can start a normal conversation, send text prompts, receive streamed responses, resolve approvals or requested input, and open the same thread in the full application.

The production design uses two explicit Electron utility windows: a tightly bounded transparent mascot and a separate opaque or translucent compact-chat window. This avoids resizing a transparent native window between incompatible presentations, limits invisible mouse interception, and keeps the chat surface focusable and predictable. The mascot renderer remains lightweight and does not connect to orchestration; compact chat uses the existing authenticated backend, thread bootstrap, timeline, composer, and ordered event stream.

Every sent mascot conversation becomes a normal `standard` thread in the built-in Chats project and therefore appears in Chats/Recents. Empty clicks do not create durable threads. Closing or hiding compact chat never deletes its thread or stops active provider work.

New mascot drafts use `approval-required` rather than silently inheriting bigbud's current `full-access` default. The first release starts with the most recently submitted provider/model stored in the current Electron profile, validates it against current provider-specific availability, and requires explicit reselection if it is unavailable. A server-authoritative recent-model projection is deferred unless product requirements later demand cross-device history, full historical model options, or provider-accepted/completed semantics.

This is the canonical plan for the floating mascot and compact chat work. Earlier independent drafts were
consolidated here and removed after implementation.

## Related Work

- Source discussion: [Floating mascot and compact chat assessment](bigbud-thread://b6eb4057-b16e-438d-92e9-b6b07b0b1940).
- Existing compact conversation: `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx`.
- Electron reference: [Frameless windows](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles), [custom window interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions), and [`BrowserWindow`](https://www.electronjs.org/docs/latest/api/browser-window).
- No repository issue ID, pull request, note, or Kanban card was identified. Create an issue ID before implementation and link it here so product decisions, platform validation, rollout, and follow-up work remain traceable.

## Problem

bigbud currently requires users to expose and interact with the full desktop window before starting a conversation. The existing Sidecar is visually close to the requested compact experience, but it is rendered inside the main chat page and cannot remain independently accessible above unrelated applications.

The requested experience is:

1. Keep a small bigbud `b` mascot visible above ordinary applications.
2. Let users move it to a safe location on any connected display.
3. Open a compact chat with one explicit click.
4. Start with the user's most recently submitted available provider/model.
5. Chat and receive streamed responses without opening the main bigbud window.
6. Keep every sent conversation as a normal Chats thread visible under Recents.
7. Continue active work while compact chat is hidden.
8. Open the same durable thread in the full application when more space or advanced tools are needed.

The AI execution path already supports this. The desktop and renderer ownership models do not:

- The desktop process tracks only one `mainWindow` and creates it unconditionally.
- Activation, second-instance, menu, notification, and IPC paths sometimes select the focused or first arbitrary Electron window.
- Backend startup-state IPC authorizes only the main renderer.
- The web root always mounts the full sidebar shell and global coordinators.
- Composer drafts and sticky state currently share one persisted document, which is unsafe for concurrent independent renderers.
- The existing Sidecar thread is temporary, hidden from Recents, attached to a main thread, and deleted when closed.
- The current global runtime default is `full-access`, which is too consequential to inherit silently in a quick floating surface.
- Electron transparent and always-on-top behavior differs materially across macOS, Windows, X11, and Wayland.

This work is therefore a multi-window lifecycle and renderer-boundary feature, not only a new visual component. Adding an always-on-top `BrowserWindow` without those foundations would create concrete risks: duplicated notifications, wrong-window navigation, overwritten drafts, off-screen windows, hidden processes with no quit path, accidental authority, and duplicate or uncertain sends after reconnect.

## Goals

- Add one optional mascot and one optional compact-chat window to the Electron application.
- Keep the mascot above ordinary application windows where the operating system and window manager permit it.
- Avoid claiming visibility above secure prompts, elevation boundaries, lock screens, or every fullscreen surface.
- Keep the mascot idle without stealing keyboard focus.
- Open or focus exactly one compact chat after one explicit mascot click.
- Keep backend startup and provider work independent from main-window visibility.
- Create mascot conversations as normal `standard` threads in the built-in Chats project.
- Preserve empty conversations as local drafts until first send so Recents is not polluted.
- Give compact drafts a role-specific persisted composer document that cannot overwrite main-window drafts.
- Preserve unsent compact text across collapse, renderer reload, and application restart where safe.
- Confirm before replacing a compact draft that contains unsent content.
- Default every new mascot draft to `approval-required`, with broader authority requiring explicit user action.
- Use the latest valid profile-local recently submitted provider/model for each new compact draft.
- Preserve provider, model, and optional sub-provider identity; do not fabricate historical options that are not persisted.
- Require explicit reselection when a persisted provider/model is unavailable; never silently change provider.
- Keep started threads governed by their existing provider/session/model locking semantics.
- Reuse existing first-send bootstrap, orchestration, streaming, reconnect, and event-sequence recovery behavior.
- Reuse the compact timeline and composer while excluding workspace-only and full-shell controls.
- Support inline approvals and pending user input without mounting a second global approval coordinator.
- Provide **New chat**, **Open in bigbud**, **Hide mascot**, **Disable floating assistant**, and **Quit bigbud** actions.
- Persist mascot position safely and recover after monitor removal, work-area changes, and scale-factor changes.
- Prevent duplicate native notifications, approval redirects, update prompts, provider recovery prompts, and settings migrations across renderers.
- Preserve secure preload, sandbox, context isolation, authenticated backend connection, update, and shutdown guarantees.
- Ship default-off and roll out only after packaged platform and resource validation.

## Non-Goals

- Browser, mobile-web, or remote-control mascot surfaces.
- A generated character, voice-call orb, lip synchronization, continuous microphone listening, wake word, or spoken responses.
- Automatic observation, screen reading, or capture of other applications.
- Display above secure desktops, UAC, lock screens, permission prompts, or every exclusive-fullscreen application.
- A new `mascot` or modified `side-chat` thread purpose.
- Converting existing Sidecar threads into visible Chats threads.
- Reusing Sidecar's destructive close behavior for mascot conversations.
- Multiple mascots or multiple compact-chat windows in the first release.
- Keeping a hidden full main renderer alive only to power the mascot.
- Embedding the sidebar, terminal, browser, diff panel, right panel, orchestra, branch/worktree controls, or full settings inside compact chat.
- User file/image attachments, terminal context, thread references, path mentions, or microphone input in the first release. These require a separate compact capability and permission review.
- Automatically transferring an unsent draft between main and compact renderers.
- Cloud synchronization of mascot geometry, draft state, or recent-model history.
- A new server-side recent-model projection in the first release.
- Launch-at-login behavior.
- Hiding the macOS Dock identity or changing the app activation policy in the first release.
- Silent same-provider or cross-provider fallback when the recent selection is unavailable.
- Editing `apps/web/src/routeTree.gen.ts`; TanStack Router must regenerate it normally.

## Current State

### Desktop lifecycle and window ownership

- `apps/desktop/src/main.ts:105-106` tracks only `mainWindow` and `isQuitting`.
- `apps/desktop/src/main.ts:252-267` exposes one main-window factory.
- `apps/desktop/src/main.ts:375-376` creates the main window unconditionally before backend startup completes.
- `apps/desktop/src/window/windowManager.ts:104-135` creates a `1100 x 780` full-app window with minimum dimensions of `840 x 620`, `hiddenInset`, plugins, and `webviewTag` enabled.
- `apps/desktop/src/window/windowManager.ts:243-252` always shows that window at `ready-to-show` and opens detached DevTools in development.
- `apps/desktop/src/main.ts:469-473` creates a main window on activation only when no Electron window exists. A persistent mascot would make that condition permanently false.
- `apps/desktop/src/main.ts:479-483` quits after last-window close outside macOS. Utility-window close and explicit application quit therefore need separate semantics.
- `apps/desktop/src/main.runtime.ts:15-35` can focus `BrowserWindow.getAllWindows()[0]` after a second launch.
- No window-role registry, tray, always-on-top window, all-workspaces policy, skip-taskbar policy, geometry persistence, or display-change recovery currently exists.
- `apps/desktop/src/main.ts` is already 495 lines. The implementation must extract lifecycle responsibility rather than extending this file.

### IPC and security boundary

- `apps/desktop/src/preload.ts` exposes one broad desktop bridge to the main renderer.
- `apps/desktop/src/window/ipcHandlers.ts:122-128` restricts backend startup-state reads to `mainWindow.webContents`.
- `apps/desktop/src/window/ipcHandlers.ts:168-215` targets dialogs and material changes by focus/main fallback rather than the IPC sender.
- `apps/desktop/src/window/ipcHandlers.ts:217-277` uses the same focus-based ownership for context menus.
- `apps/desktop/src/window/menuManager.ts:109-132` dispatches application actions to the focused, main, or first arbitrary window.
- `apps/desktop/src/window/ipcHandlers.notifications.ts:31-37` can focus the first available window after a native notification click.
- The existing main-window factory installs microphone permission handlers on the shared Electron session. Mascot-only startup cannot assume the main window configured that session first.
- The mascot needs no backend connection, plugins, webview, microphone, file picker, or broad bridge.
- Compact chat needs the backend connection and narrow lifecycle/context-menu/external-link operations but not webview or plugins.

### Electron platform constraints

- Electron 40.6.0 is declared in `apps/desktop/package.json:22-26`.
- Electron supports frameless transparent windows, CSS drag regions, `alwaysOnTop`, `setSkipTaskbar`, `setVisibleOnAllWorkspaces`, and ignored mouse events on relevant platforms.
- Electron documents that transparent windows are not normally user-resizable, transparent pixels remain part of the native hit rectangle, opening DevTools disables transparency, and `alwaysOnTop` is unsupported on Wayland.
- `apps/desktop/src/window/windowManager.ts:116-125` enables transparency only on macOS today.
- `apps/web/src/index.css:260-271` defines drag/no-drag regions. A CSS drag region does not also behave as a normal clickable button.
- Linux runtime policy already distinguishes X11/Wayland and GPU fallback through `main.runtime.ts` and `main.linuxRuntime.ts`.

### Renderer shell and compact presentation

- `apps/web/src/routes/__root.tsx:91-130` mounts server bootstrap, event routing, reconnect coordination, startup state, global toasts, approval navigation, task notifications, command palette, sidebar layout, file access, and computer-use repair for every renderer.
- `apps/web/src/routes/-__root.logic.tsx:67-103` can create a fresh Chats draft when the route is `/`, making `/` unsuitable for a utility renderer.
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:51-135` contains a reusable compact conversation pattern built from `MessagesTimeline`, `WorkingIndicator`, and compact `ChatViewComposer`.
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:214-249` positions the Sidecar inside a main chat and measures the main composer, so its outer host cannot be reused as a native compact window.
- `apps/web/src/components/chat/view/ThreadComposerSurface.tsx` is the existing orchestration-aware boundary for one embedded thread.
- Compact presentation still initializes broad chat behavior. A focused capability profile is needed to avoid workspace-only queries and actions.

### Sidecar and normal Chats semantics

- `packages/contracts/src/orchestration/orchestration.thread.ts:35-36` defines `standard` and `side-chat` purposes.
- `apps/web/src/components/chat/side-chat/sideChat.actions.ts` creates Sidecar under another thread's project, copies execution/model/runtime context, and deletes it on close.
- `apps/web/src/logic/thread/threadVisibility.logic.ts` treats Sidecar threads as invisible.
- `apps/web/src/stores/main/events.store.projects.ts` excludes Sidecar from sidebar membership but prepends normal built-in Chats threads to Recents.
- `apps/web/src/hooks/useHandleNewThread.ts:263-294` creates a local draft and navigates without eagerly creating a server thread.
- The first `thread.turn.start` can carry `bootstrap.createThread`, producing one durable thread and then one turn through the existing server bootstrap path.
- There is no `/chat/recent` route. Recents is a sidebar collection; durable thread navigation is `/$threadId`.

### Draft persistence and multi-renderer state

- Main and compact renderers have separate JavaScript/Zustand runtimes even when they share an Electron session and origin.
- `apps/web/src/stores/composer/persistence.store.ts:153-159` persists drafts, project mappings, sticky provider/model state, and related composer data as one document.
- Letting two renderers mutate that whole document creates last-writer-wins data-loss risk even though browser `storage` events can notify other windows.
- Unsent optimistic state is renderer-local until durable orchestration events arrive.
- After materialization, both renderers can subscribe to the same server thread and converge through ordered domain events.

### Recent-model behavior

- `apps/web/src/models/recentlyUsedModels.ts:7-19` stores provider, model, optional sub-provider, and `lastUsedAt` under `bigbud:recently-used-models:v2`.
- `apps/web/src/models/recentlyUsedModels.ts:107-129` records a model after the turn-start RPC dispatch succeeds and retains up to five entries per provider.
- This means “most recently submitted/command-accepted in this profile,” not provider-accepted or completed.
- `apps/web/src/hooks/useRecentlyUsedModels.ts:14-29` exposes the normalized list.
- `apps/web/src/hooks/useLocalStorage.ts` already listens for native cross-document `storage` events; the implementation must test, not assume, compact synchronization.
- Sticky model state is persisted separately inside the current composer document and applied to new drafts.
- Recent history does not store full model options such as reasoning effort. First release must not fabricate them.

### Runtime safety

- `packages/contracts/src/constants/runtime.constant.ts:1-16` defines `full-access` as command/file execution without approval and makes it the current default.
- A quick floating assistant presented over unrelated applications should not silently begin with unrestricted execution authority.
- The existing compact composer can display runtime mode, approvals, and pending input, allowing the user to explicitly broaden authority when desired.

### Consolidated architecture decisions

1. **Two native utility windows:** use `main`, `mascot`, and `compact-chat` roles. The mascot is transparent and tightly bounded; compact chat is a normal opaque/translucent focusable window. Do not resize one transparent window into the chat presentation.
2. **Desktop-owned launch state:** store enablement, mascot visibility, and geometry in a versioned, schema-validated, atomically written file under Electron `userData`. Do not use renderer local storage to decide which native window exists before renderer startup.
3. **Role-scoped renderer persistence:** select the compact composer storage key from a main-process-authoritative role before constructing persistence middleware. Never fall back to the main key when role resolution fails.
4. **Normal Chats threads:** keep compact drafts local until first send, then use existing bootstrap to create a `standard` thread in built-in Chats.
5. **Safer runtime default:** initialize mascot drafts with `approval-required`; broader modes require explicit selection.
6. **Profile-local model recency:** reuse the existing recent-model list for the first release. Resolve the newest valid entry globally by timestamp, then validate it. Do not add a migration/projection until stronger semantics are explicitly required.
7. **No silent fallback:** unavailable recent/sticky selections block first send and open the model picker with an explanation. If there is no persisted intent at all, normal built-in Chats/default provider selection may initialize the draft.
8. **Minimal mascot renderer:** no WebSocket, orchestration store, plugins, webview, microphone, or file APIs. Mascot interactions are native window IPC.
9. **Focused compact capability:** compact chat gets text chat, model/runtime controls, approvals/input, Markdown/copy, and streamed state. Attachments, microphone, terminal, browser, diff, Sidecar attach, and workspace actions are deferred.
10. **Main-only singleton effects:** only the main renderer owns native task notifications, global approval navigation, updates, file-access prompts, provider/plugin recovery, and computer-use repair. Mascot-only operation uses compact inline activity/unread state and no OS completion notification in the first release.
11. **Explicit recovery surfaces:** macOS retains its Dock identity. Windows/Linux require a tray recovery/quit surface when the mascot is skipped from the taskbar; packaged validation may permit another equivalent only if it is demonstrably recoverable.
12. **Wayland is gated:** do not promise always-on-top or exact placement. Packaged validation decides whether to offer a clearly degraded normal window/tray flow or disable the mascot setting with an explanation.

## Phases

### Phase 0: Freeze Semantics And Validate Native Assumptions

**Goal:** Resolve user-visible behavior and prove the two-window native design before production code depends on it.

1. Create and link an implementation issue ID.
2. Record the product name used in settings and menus. This plan uses **Floating assistant** for user-facing controls and `mascot` internally.
3. Lock one mascot and one compact-chat window per application instance.
4. Lock normal built-in Chats/`standard` thread semantics and local-until-first-send materialization.
5. Lock `approval-required` as the new mascot-draft runtime default.
6. Lock first-release model semantics as the latest submitted/command-accepted profile-local selection, not provider-accepted or completed.
7. Lock explicit reselection on unavailable persisted intent; reject silent provider changes.
8. Lock main-only system notifications in the first release. Compact chat uses inline activity/unread state when no main renderer exists.
9. Lock attachments, microphone, path/thread references, and other non-text inputs out of first-release scope.
10. Lock desktop preference enablement default to `false` and start-at-login out of scope.
11. Define launch behavior:
    - when disabled, existing main-window startup remains unchanged;
    - when enabled, a normal process launch creates the mascot and backend without showing main;
    - a second launch, Dock activation, tray **Open bigbud**, or mascot **Open bigbud** creates/focuses main;
    - closing main leaves enabled mascot/backend running;
    - explicit quit stops all windows and services.
12. Build a development-only native spike with separate mascot and compact windows.
13. Validate one-click activation from an inactive app, including `acceptFirstMouse` on macOS where applicable.
14. Validate click-versus-drag with a draggable outer affordance and clickable inner logo. Reject a full drag region that requires two clicks or suppresses the logo action.
15. Validate mascot transparency, tight hit bounds, always-on-top level, all-workspaces/fullscreen options, and compact-chat adjacency.
16. Validate Windows normal/maximized/fullscreen behavior, one X11 window manager, and at least one Wayland compositor. Record unsupported behavior honestly.
17. Measure idle mascot renderer memory/CPU and warm/cold click-to-focused-composer latency.
18. Approve initial geometry constants after spike results. Start testing around a `64 x 64` mascot and `480 x 620` compact chat with minimum `360 x 440`.
19. Set concrete rollout budgets before Phase 7: idle CPU, idle mascot memory, compact renderer memory, and click-to-composer latency on reference hardware.

**Failure behavior:** The spike is development-only and cannot change stored preferences or normal startup. If transparent/always-on-top behavior is unacceptable on a platform, record a product-approved degraded or disabled mode before proceeding.

**Exit criteria:** Product owners accept thread, runtime, model, notification, attachment, startup, tray, and Wayland semantics; the separate-window click/drag/focus design is usable on target packaged environments; and measurable performance budgets exist.

### Phase 1: Build Role-Aware Desktop Foundations

**Goal:** Make multiple native windows safe while preserving current main-window behavior when the feature is disabled.

**Dependencies:** Phase 0 decisions and native flags are recorded.

1. Extract window lifecycle orchestration from the over-limit `apps/desktop/src/main.ts` into focused dot-notation modules.
2. Define typed `DesktopWindowRole = "main" | "mascot" | "compact-chat"` contracts through direct subpath imports.
3. Add a registry keyed by both role and trusted `webContents.id`. Remove entries on destruction and never infer role from URL parameters or `getAllWindows()` order.
4. Provide idempotent `ensure`, `show`, `focus`, `hide`, and `destroyForQuit` operations per role, with a single-flight creation promise.
5. Separate common secure BrowserWindow setup from role options.
6. Configure shared session permissions independently of main-window construction and creation order.
7. Preserve sandbox and context isolation everywhere. Disable plugins and `webviewTag` for mascot and compact chat.
8. Add focused preload/bridge surfaces:
   - mascot: trusted role plus compact/open-main/context-menu/hide/quit actions;
   - compact: trusted role, backend URL/startup state, compact lifecycle, open-main, external URL, context menu, theme, and safe clipboard operations;
   - main: retain existing behavior.
9. Authorize utility IPC through registered sender web contents and resolve sender-owned windows with `BrowserWindow.fromWebContents(event.sender)`.
10. Generalize backend-startup-state reads to trusted roles.
11. Route settings, update, terminal, browser, and other full-app menu actions explicitly to main.
12. Make notification clicks and second-instance/Dock activation open/focus main rather than the first window.
13. Make window-specific material, context menu, confirmation, and future dialog behavior target the sender window.
14. Preserve global updater/backend broadcasts while allowing renderer role ownership to suppress duplicate effects.
15. Add a versioned desktop preference/state service under `app.getPath("userData")` with schema validation, atomic replacement, bounded diagnostics, and corruption/newer-version fallback.
16. Persist floating-assistant enablement, mascot visibility, collapsed anchor, display identity where available, and normalized edge offsets. Do not persist prompt content there.
17. Add pure work-area helpers for negative coordinates, mixed scale factors, display removal, work-area shrink, and nearest-visible recovery.
18. Replace unconditional `mainWindow = makeWindow()` startup with preference-driven orchestration while retaining existing startup when disabled.
19. Add a feature kill switch/read failure path that safely falls back to normal main-window startup.

**Likely files:**

- `apps/desktop/src/main.ts`
- `apps/desktop/src/main.runtime.ts`
- `apps/desktop/src/main.windows.ts` (new)
- `apps/desktop/src/main.channels.ts`
- `apps/desktop/src/window/DesktopWindowRegistry.ts` (new)
- `apps/desktop/src/window/desktopPreferences.ts` (new)
- `apps/desktop/src/window/mascotBounds.ts` (new)
- `apps/desktop/src/window/sessionPermissions.ts` (new)
- `apps/desktop/src/window/windowManager.ts`
- `apps/desktop/src/window/ipcHandlers.ts`
- `apps/desktop/src/window/menuManager.ts`
- `apps/desktop/src/window/ipcHandlers.notifications.ts`
- Focused preload entries if selected during implementation
- `packages/contracts/src/server/ipc.ts` and/or a focused desktop-window direct subpath
- Focused tests for every new module

**Failure and recovery behavior:** Corrupt preferences use safe defaults without deleting unrelated desktop data. Failed writes retain in-memory state and log one bounded error without tight retries. Concurrent create calls return one role window. Unknown or mismatched senders cannot mutate native windows.

**Exit criteria:** Disabled behavior is unchanged; preference-driven startup is tested; every role is explicit; IPC targets deterministic trusted windows; main close/activate/second launch/quit/update behavior is correct with mock utility windows; and `main.ts` is reduced below the repository limit.

### Phase 2: Split Renderer Roles And Persisted State

**Goal:** Let compact chat synchronize one thread without mounting the full application shell or sharing main composer persistence.

**Dependencies:** Phase 1 provides an authoritative synchronous role through preload.

1. Resolve the trusted role before constructing role-sensitive stores or persistence middleware.
2. If role resolution fails, block utility startup with a safe error. Never default a utility renderer to the main composer storage key.
3. Refactor the root into common connection/event infrastructure and role-specific shells.
4. Keep these in shared main/compact infrastructure:
   - native API initialization;
   - server configuration bootstrap;
   - ordered orchestration event ingestion and sequence recovery;
   - WebSocket reconnect coordination/surface;
   - backend startup state;
   - theme and minimal inline toast support.
5. Keep these main-only:
   - `AppSidebarLayout` and command palette;
   - global navigation and route-welcome draft creation;
   - system task notifications;
   - global pending-approval navigation;
   - update, plugin, and provider recovery prompts;
   - file-access and computer-use startup repair;
   - full settings/right-panel/terminal/browser hosts.
6. Keep mascot as a separate minimal route/entry that mounts artwork and native actions only, with no backend connection or orchestration store.
7. Add a dedicated compact route or role entry. Never load it at `/`.
8. Add a new versioned compact composer persistence key/document. Keep existing main storage and migrations unchanged.
9. Add a focused compact-state store for presentation, current local/durable thread ID, unread/activity, and bounded recovery metadata. Do not persist server response content outside canonical projections.
10. Persist compact draft prompt/runtime/model state only in the compact composer document.
11. Hydrate a known durable compact thread directly rather than loading every project/thread page.
12. Treat stored thread states explicitly:
    - active standard Chats thread: hydrate;
    - local compact draft: restore;
    - archived/deleting/deleted/purged/retention-removed: show status and offer confirmed **New chat**;
    - unknown stale ID: clear only after bounded authoritative lookup and user-visible recovery.
13. Add compact inline backend-starting, reconnecting, exhausted-reconnect, and retry states.
14. Route unsupported compact links/actions through **Open in bigbud** rather than navigating utility renderer into full routes.
15. Regenerate the TanStack route tree normally.

**Likely files:**

- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/-__root.logic.tsx`
- Dedicated compact and mascot route/entry modules (new)
- `apps/web/src/lib/desktopWindowRole.ts` (new)
- `apps/web/src/stores/composer/composer.store.ts`
- `apps/web/src/stores/compactChat/*` (new)
- `apps/web/src/components/DesktopBackendStartupCoordinator.tsx`
- Focused root, persistence, and recovery tests

**Failure and recovery behavior:** Malformed compact persistence resets only compact-local state. Reconnect never creates a thread or resends by inference. A utility renderer that cannot prove its role receives no persisted main state or privileged native operations.

**Exit criteria:** Main and compact renderers run concurrently with separate composer documents; mascot has no WebSocket; one set of main-only coordinators exists; and compact can recover one durable thread through backend restart without duplicate commands.

### Phase 3: Implement Compact Draft, Thread, And Model Semantics

**Goal:** Create safe normal Chats conversations from compact chat with predictable runtime and model selection.

**Dependencies:** Phase 2 provides isolated compact storage and synchronization.

1. Extract reusable built-in Chats draft creation from `useHandleNewThread` without changing main behavior.
2. Create compact drafts outside the main store's one-draft-per-project mapping.
3. Set project to `BUILT_IN_CHATS_PROJECT_ID`, local environment, branch/worktree `null`, interaction mode `default`, and runtime mode `approval-required`.
4. Keep the draft local until first send.
5. On first send, reuse `thread.turn.start` with `bootstrap.createThread` and the existing prompt restoration/error path.
6. Resolve recent model selection as a pure function:
   - normalize all valid recent entries;
   - select the greatest valid ISO `lastUsedAt` globally;
   - preserve provider/model/optional sub-provider;
   - do not recover historical options from unrelated sticky state.
7. If no recent entry exists, use the compact role's sticky explicit selection, then the existing built-in Chats/default ready-provider selection.
8. Validate persisted intent with provider-specific metadata:
   - provider enabled/installed/auth/readiness;
   - sub-provider only where supported;
   - model membership only where the provider's catalog is authoritative;
   - avoid claiming every provider has an authoritative live catalog.
9. If a recent or sticky explicit selection is unavailable, preserve it as requested intent, disable first send, explain why, and open the existing model picker for explicit replacement.
10. Once the user explicitly changes selection, persist it in compact storage and use normal recent-history recording after dispatch.
11. Never change a materialized thread's provider/model because another window later used a newer model.
12. Confirm native cross-window storage events update recent history. Fix only the focused subscription if tests expose a gap.
13. On **New chat**:
    - if unsent content exists, require explicit discard confirmation;
    - if the current thread is durable, retain it in Recents and create a new compact draft;
    - never delete the prior durable thread.
14. Define concurrent main/compact command behavior:
    - server orchestration sequence is authoritative;
    - normal queue/active-turn rules apply;
    - optimistic state remains local until durable events arrive;
    - duplicate/stale approval or input responses return the existing safe conflict/error rather than being inferred as success;
    - reconnect never automatically retries a command with uncertain outcome.
15. Persist command/thread identities needed to reconcile uncertain first-send outcomes before allowing another create/send.
16. **Open in bigbud** is available only for a durable thread. An unsent compact draft remains compact-local and is described honestly rather than transferred.

**Likely files:**

- `apps/web/src/hooks/useHandleNewThread.ts`
- `apps/web/src/hooks/useCompactChatThread.ts` (new)
- `apps/web/src/models/recentlyUsedModels.ts`
- `apps/web/src/hooks/useRecentlyUsedModels.ts`
- `apps/web/src/hooks/useLocalStorage.ts`
- `apps/web/src/stores/composer/*`
- `apps/web/src/components/chat/view/ChatView.sendTurn.helpers.ts`
- Pure model resolution and compact lifecycle tests

**Failure and recovery behavior:** Immediate bootstrap failure restores prompt state exactly once. Uncertain disconnect reconciles against durable thread/event identity before retry. Missing provider/model data never fabricates a selection. Archived/deleted threads are not silently replaced.

**Exit criteria:** First send creates exactly one normal Chats thread and turn; it appears in Recents; runtime starts `approval-required`; recent selection is accurate and provider-specific; unavailable persisted intent blocks for explicit reselection; and main/compact concurrent viewing cannot overwrite drafts or duplicate a send by recovery inference.

### Phase 4: Extract And Build The Compact Chat Surface

**Goal:** Deliver the Sidecar-scale text-chat experience without full application chrome or workspace-only behavior.

**Dependencies:** Phase 3 provides a compact draft/durable thread and validated selection.

1. Move the reusable bigbud `b` artwork from any sidebar-specific module into a focused shared branding component.
2. Extract a neutral `CompactThreadConversation` from `FloatingSideChat` containing timeline, auto-scroll, working state, inline errors, and compact composer.
3. Keep Sidecar-specific positioning, measurement, attachment-as-context, temporary store, minimize, and delete lifecycle unchanged.
4. Add an explicit compact capability profile to `ThreadComposerSurface` and derived hooks rather than hiding unsupported controls only with CSS.
5. First-release compact capabilities include:
   - text prompt and queued follow-up behavior already supported by normal orchestration;
   - Markdown and copy in the timeline;
   - provider/model picker;
   - visible runtime mode;
   - pending approvals and pending user input;
   - reconnect/provider/error states;
   - **New chat**, **Open in bigbud**, hide/close, disable, and quit.
6. Disable attachments, microphone, terminal context, path/thread mentions, diff, branch/worktree, browser, orchestra, Sidecar attachment, and workspace-only actions.
7. Add a compact header with title, current provider/model, activity state, New chat, Open in bigbud, and hide/close.
8. Keep primary controls usable at `360 x 440`. Move secondary actions into existing shadcn menus instead of clipping or shrinking below `text-sm` defaults.
9. Constrain model picker, runtime picker, approval panels, menus, tooltips, and dialogs to compact viewport bounds.
10. Hide compact chat without destroying it while it has an unsent draft, active turn, pending approval/input, or unread response.
11. Continue server work while hidden and derive activity/unread from canonical thread transitions.
12. Reopening shows current projected/streamed state and never starts another turn.
13. **Open in bigbud** creates/focuses main and navigates that renderer to `/$threadId`; failure leaves compact state unchanged and provides retry.
14. Add keyboard/focus behavior:
    - focus composer after explicit open;
    - `Escape` closes transient menu/dialog first, then hides compact chat;
    - restore focus to the previously active application when chat hides where platform APIs permit;
    - accessible names, visible focus, semantic activity/unread status, reduced motion, and contrast.

**Likely files:**

- `apps/web/src/components/branding/BigbudLogo.tsx` (new or extracted)
- `apps/web/src/components/chat/compact/CompactThreadConversation.tsx` (new)
- `apps/web/src/components/chat/compact/CompactChatWindow.tsx` (new)
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx`
- `apps/web/src/components/chat/view/ThreadComposerSurface.tsx`
- `apps/web/src/components/chat/view/chat-view/ChatViewComposer.tsx`
- Compact route and browser tests

**Exit criteria:** At minimum size, users can create/send/read a text conversation, select model/runtime, resolve approval/input, hide/reopen, and open a durable thread in main; unsupported controls are absent by capability rather than broken; and existing Sidecar behavior is unchanged.

### Phase 5: Implement Production Mascot, Compact Window, Tray, And Geometry

**Goal:** Provide the native floating entry point and reliable recovery controls.

**Dependencies:** Phases 1-4 and Phase 0 native spike results.

1. Add a dedicated mascot factory:
   - small fixed bounds;
   - `frame: false`;
   - transparent where supported with opaque fallback;
   - always-on-top level proven by platform spike;
   - skip taskbar where the recovery design supports it;
   - not resizable/minimizable/maximizable/fullscreenable;
   - sandbox/context isolation;
   - plugins/webview disabled;
   - no automatic DevTools, because DevTools disables transparency.
2. Add a separate compact-chat factory:
   - opaque/translucent normal chat surface;
   - focusable and bounded/resizable only if Phase 0 approves;
   - no plugins or webview;
   - independent material and minimum dimensions.
3. Keep mascot native bounds tight around visible artwork to minimize transparent hit interception.
4. Render the repository-owned bigbud `b`, not reference third-party artwork.
5. Use a tested draggable outer affordance and clickable inner logo.
6. One click calls idempotent compact open/focus. Rapid clicks coalesce.
7. Position compact chat adjacent to mascot, grow inward from nearest work-area edges, and clamp fully onscreen.
8. Retain mascot anchor independently from compact bounds.
9. Persist mascot position after drag completion/debounce, not continuously on every pointer movement.
10. Re-clamp on startup, display add/remove, metrics/scale change, sleep/wake, and invalid persisted state.
11. Add mascot native context actions: **Open chat**, **New chat**, **Open bigbud**, **Hide mascot**, **Disable floating assistant**, and **Quit bigbud**.
12. Add a tray recovery surface on Windows/Linux when mascot is skipped from taskbar. Include show/open/new/main/disable/quit actions. Keep macOS Dock identity.
13. `showInactive()` or equivalent passive restore must not steal focus; compact chat focuses only after explicit user action.
14. Handle renderer crashes by role with one bounded reload attempt, then fall back to opening main or tray recovery. Never recreate in an unbounded loop.
15. Ensure update installation and explicit quit destroy both utility roles through existing teardown.
16. On Wayland, apply only capabilities proven by Phase 0. If always-on-top/placement is misleading, disable mascot enablement with an explanation while retaining tray/main access.

**Likely files:**

- `apps/desktop/src/window/windowManager.mascot.ts` (new)
- `apps/desktop/src/window/windowManager.compactChat.ts` (new)
- `apps/desktop/src/window/mascotMenu.ts` (new)
- `apps/desktop/src/window/desktopTray.ts` (new, platform-gated)
- `apps/desktop/src/window/mascotBounds.ts`
- `apps/desktop/src/window/ipcHandlers.floatingAssistant.ts` (new)
- Focused preload/bundle configuration if required
- `apps/web/src/components/mascot/FloatingMascot.tsx` (new)
- Window, tray, geometry, crash, and interaction tests

**Failure and recovery behavior:** Invalid/off-screen bounds are corrected before show. Transparency/GPU failure uses an opaque fallback. Utility renderer failure does not stop backend/main. Hidden mascot remains recoverable through Dock/tray/second launch. Explicit quit remains available even when renderer UI fails.

**Exit criteria:** Exactly one mascot and compact window exist; idle mascot does not focus bigbud; one click opens compact chat; drag/placement survives monitor changes; Windows/Linux cannot be stranded without tray/taskbar recovery; and quit/update stop all roles cleanly.

### Phase 6: Add Settings And Harden Lifecycle

**Goal:** Make the feature understandable, opt-in, observable, and reliable under failures and concurrent windows.

**Dependencies:** End-to-end utility behavior exists behind a default-off flag.

1. Add an IPC-backed desktop preference hook for Settings. Do not duplicate native enablement into `ClientSettingsSchema` as a second authority.
2. Add a Desktop/General setting labeled with the approved product name, hidden outside Electron.
3. Explain that enabling keeps bigbud/backend running after main closes and that explicit Quit stops active local work.
4. Enabling creates/shows mascot immediately. Disabling persists first, then closes compact/mascot while leaving normal main behavior available.
5. Disabling from mascot/tray opens or confirms a recovery path before removing the only skip-taskbar surface.
6. Define one tested lifecycle state machine covering visible/hidden/destroyed main, mascot, compact chat, and application quitting.
7. Keep backend running while floating assistant is enabled, even when main/compact are hidden.
8. Keep provider work running after compact hide or renderer reload.
9. Preserve existing update stop-and-wait behavior and ensure hidden windows cannot block `quitAndInstall`.
10. Keep system task notifications main-owned. When main is absent, compact inline unread/activity is the only first-release completion signal.
11. Add safe role/window diagnostics for create/show/hide/focus, off-screen correction, crash recovery, IPC rejection, and platform downgrade. Never log prompts, responses, credentials, model secrets, attachment paths, or user-derived window titles.
12. Measure and enforce Phase 0 resource/latency budgets. If mascot idle cost is too high, use a smaller dedicated renderer entry before rollout rather than keeping main hidden.
13. Add a preference reset/kill-switch path that restores normal main startup without deleting Chats threads, compact drafts, or recent-model history.
14. Document retained draft behavior and provide an explicit reset only for compact-local state.

**Exit criteria:** Enable/disable survives restart; no user can be stranded without open-main/quit recovery; crash/reconnect/update/quit behavior is deterministic; diagnostics contain no content; and resource budgets pass.

### Phase 7: Package, Validate, And Roll Out

**Goal:** Ship only behavior demonstrated by packaged builds.

**Dependencies:** All automated tests and lifecycle gates pass.

1. Keep floating assistant default-off for development and initial packaged preview.
2. Validate signed/notarized macOS arm64/x64 where environments are available.
3. Validate packaged Windows x64, including tray, taskbar, elevation boundaries, DPI, and mixed displays.
4. Validate Linux X11 and selected Wayland environments separately. Record compositor names and exact degradation.
5. Validate one-click activation, drag, all display edges, fullscreen/Spaces/virtual desktops, monitor removal, scale changes, sleep/wake, session lock/unlock, and screen sharing.
6. Validate idle/streaming resource use and cold/warm click latency against Phase 0 budgets.
7. Validate main close during idle, streaming, queued prompts, approval, pending input, reconnect, backend restart, and update install.
8. Validate keyboard-only, screen-reader, reduced-motion, light/dark/high-contrast, and focus restoration behavior.
9. Validate provider unavailable, authentication expired, sub-provider removed, and authoritative catalog model removed.
10. Roll out in stages: development flag, internal packaged preview, opt-in prerelease, then stable opt-in after platform gates pass.
11. Keep a rollback that hides/disables utility creation without deleting normal Chats history or compact-local draft data.
12. Add changelog/user documentation only after supported behavior is verified; state Wayland/fullscreen limitations precisely.

**Exit criteria:** No supported packaged target has an unrecoverable off-screen, focus, quit, update, duplicate-window, or draft-loss defect; platform limitations are approved and documented; performance budgets pass; and rollback preserves user conversations.

## Risks And Decision Gates

- **Native topology:** The consolidated decision is two utility windows. Phase 0 must still validate z-order, focus, adjacency, and flicker. Reopening topology is allowed only if packaged evidence shows the separate windows cannot meet the interaction contract.
- **Wayland:** Electron does not support always-on-top reliably on Wayland. Do not make Wayland support an unconditional acceptance claim; ship a clear degraded/disabled mode selected from packaged evidence.
- **Always-on-top wording:** Secure prompts, elevation boundaries, exclusive fullscreen, and OS surfaces may cover the mascot. Product copy must say “above ordinary apps.”
- **Transparent hit rectangle:** Keep native bounds tight. Do not attempt a large invisible overlay or assume transparent pixels click through.
- **Click versus drag:** CSS drag regions suppress ordinary pointer behavior. The feature cannot ship until one-click activation and drag are both proven.
- **Focus stealing:** Passive mascot restoration must not activate bigbud. Compact chat focuses only after explicit interaction.
- **Runtime authority:** New mascot drafts must use `approval-required`. Product/security approval is required before any broader default.
- **Background consent:** The feature is opt-in and must explain that closing main does not quit while enabled.
- **Desktop preference authority:** Native startup state belongs to the main process. Renderer client settings cannot be a competing authority.
- **Role trust:** URL/path is presentation, not authorization. Main-process `webContents` role registration governs IPC and persistence selection.
- **Composer data loss:** Role-specific persistence is mandatory before editable compact UI. Never have two renderers write the same full composer document.
- **Recent-model semantics:** First release means most recently submitted/command-accepted in this Electron profile. Do not claim provider acceptance or completion.
- **Historical options:** Existing recent history omits full options. Do not combine unrelated sticky options or invent them.
- **Unavailable model:** Cross-provider silent fallback is rejected. Explicit reselection protects user intent, cost, privacy, and capability expectations.
- **Provider catalogs:** Availability validation is provider-specific. Do not claim a catalog is authoritative unless provider metadata proves it.
- **Draft handoff:** Unsent compact drafts do not transfer to main. A future shared-draft design must address ownership and conflict explicitly.
- **Concurrent commands:** Server sequence and orchestration decisions are authoritative. Disconnect uncertainty must reconcile; never infer a retry.
- **Archived/deleted/purged state:** Do not silently create a replacement and hide what happened. Show status and require New chat confirmation.
- **Attachments and microphone:** Deferred from first release to avoid broadening preload, permission, persistence, and data-loss scope without user need.
- **Notification ownership:** First release intentionally omits system completion notifications when main is absent. Moving ownership requires a separate leader/main-process design.
- **Recovery surface:** Windows/Linux tray is required when skip-taskbar behavior could strand users. macOS retains Dock identity.
- **Resource cost:** Do not keep main hidden. Mascot must remain lightweight; compact is created lazily and may be destroyed only when no draft/turn/approval/unread state requires preservation.
- **Rollback:** Kill switch restores normal startup and leaves durable Chats threads and compact draft storage untouched.

## Testing And Validation

### Contract and schema tests

- Decode valid/invalid desktop roles, preference state, geometry, and focused IPC payloads.
- Reject unknown roles, non-finite bounds, invalid versions, and malformed window actions.
- Preserve safe defaults for missing preferences and fail safely for newer unknown versions.
- Verify compact runtime defaults to `approval-required`.
- Verify recent-model normalization for every supported provider and optional sub-provider.

### Desktop unit tests

- Registry creates one window per role and clears destroyed web contents.
- Concurrent ensure/open calls coalesce.
- Mascot and compact options retain sandbox/context isolation and disable plugins/webview.
- Mascot uses tight fixed bounds; compact uses approved geometry/minimums.
- Sender IPC targets the registered sender/explicit role and rejects unknown web contents.
- Backend startup state is available to trusted compact renderer.
- Shared session permissions do not depend on main-window creation.
- Main-only menu and notification actions never target utility renderers.
- Second launch and macOS activation open main while mascot exists.
- Disabled startup preserves existing main behavior; enabled startup creates mascot without main.
- Main close leaves enabled backend/mascot running; explicit quit tears down once.
- Bounds clamp after display removal, negative coordinates, scaling, work-area shrink, and corrupt state.
- Preference writes are atomic/debounced; failures do not crash or loop.
- Tray recovery remains available whenever skip-taskbar mascot can be hidden.
- Renderer crash recovery is bounded.
- Wayland capability resolution never claims unsupported always-on-top behavior.

### Web unit and component tests

- Trusted role is resolved before store creation and selects the correct persistence key.
- Missing role blocks utility startup rather than opening main storage.
- Main and compact composer documents cannot overwrite each other.
- Mascot mounts no backend/event/store graph.
- Compact mounts shared synchronization but no main-only coordinators.
- Recent-model resolver picks the newest valid global timestamp.
- Invalid timestamps, disabled/unauthenticated providers, stale sub-providers, and removed authoritative models require explicit reselection.
- No historical options are fabricated.
- New compact draft targets built-in Chats, local environment, no branch/worktree, and `approval-required`.
- Expand/open without send creates no server thread.
- First send materializes one standard Chats thread and restores prompt once on immediate failure.
- New chat confirms before discarding unsent content.
- Hide/reopen preserves draft/current thread and does not dispatch.
- Archived/deleting/deleted/purged recovery is explicit.
- Open in bigbud is disabled for local draft and targets durable `/$threadId` when materialized.
- Approval/input flows fit compact viewport and stale duplicate actions fail safely.
- Unsupported attachments/microphone/workspace controls are absent.
- Existing Sidecar attach/minimize/delete behavior remains unchanged after extraction.
- Only one main system-notification/global-approval coordinator mounts.

### Server and integration regression tests

- Existing create-and-first-turn bootstrap remains unchanged and passing.
- One first compact send produces one durable standard thread and one user turn.
- Normal built-in Chats thread enters Recents through existing events.
- Main and compact renderer subscriptions converge through ordered events and sequence-gap recovery.
- Main close or compact hide does not cancel provider work.
- Reconnect during uncertain dispatch does not create/retry automatically.
- Concurrent main/compact sends and approvals follow existing orchestration queue/conflict rules.
- No new server thread purpose, provider path, or model projection is introduced.

### Browser tests

- Run compact chat at default and minimum dimensions.
- Create, send with fake provider, stream, hide/reopen, and open the same durable thread in main.
- Validate model-required, backend-starting, reconnecting, provider-error, approval, and input-required states.
- Validate menus/popovers remain within viewport.
- Validate keyboard navigation, visible focus, names, reduced motion, and contrast.
- Mount main and compact together and prove no duplicate notification/approval side effects.

### Packaged manual matrix

- macOS arm64/x64: one-click inactive activation, Dock activation, Spaces, native fullscreen, mixed displays, sleep/wake, signed/notarized behavior.
- Windows x64: tray/taskbar, mixed DPI, negative displays, Snap/maximized/fullscreen, UAC boundary, update installation.
- Linux X11: compositor transparency, always-on-top, tray, multi-display, GPU fallback.
- Linux Wayland: exact compositor, degraded/disabled mode, positioning, tray/main recovery, honest copy.
- All: display unplug, resolution/scale change, all corners/edges, session lock/unlock, renderer crash, backend restart, provider unavailable/auth expired/model removed.
- All: main close during idle, streaming, queue, approval, input request, reconnect, and update.
- All: explicit Quit leaves no backend/provider/CUA process.

### Performance budgets

Phase 0 must set numeric pass/fail thresholds for:

- collapsed mascot idle CPU/GPU;
- mascot renderer memory;
- compact renderer idle/streaming memory;
- cold and warm click-to-focused-composer latency;
- event-stream behavior during long responses;
- geometry write frequency while dragging.

Do not declare rollout ready with measurements but no accepted thresholds.

### Repository commands

Run focused suites while implementing, then all repository gates:

```sh
bun run --cwd apps/desktop test
bun run --cwd apps/web test
bun run test
bun fmt
bun lint
bun typecheck
```

Use `bun run test`, never `bun test`. Record unrelated pre-existing failures separately and do not weaken assertions.

## Acceptance Criteria

- Floating assistant is desktop-only, default-off, and backed by one desktop-owned preference authority.
- When disabled, existing startup and main-window behavior remain unchanged.
- When enabled, bigbud can start mascot/backend without showing main.
- Exactly one mascot and one compact-chat window can exist.
- Idle mascot does not steal focus and one click opens/focuses compact chat.
- Mascot can be moved and restored or safely clamped after restart/display changes.
- Transparent mascot hit bounds do not reserve a large invisible rectangle.
- Compact chat remains usable at `360 x 440` and meets approved default geometry.
- Opening/hiding without send creates no durable thread.
- First send creates exactly one `standard` built-in Chats thread and one user turn.
- The durable thread appears in Recents and opens in the main window.
- Hide, main close, reconnect, renderer reload, and restart do not delete or duplicate the thread/turn.
- Compact and main drafts use separate persisted documents and cannot overwrite one another.
- Unsent New chat requires confirmation.
- New mascot drafts default to `approval-required` and broader authority requires explicit action.
- New compact drafts use the latest valid recently submitted profile-local provider/model.
- Persisted unavailable intent blocks first send and requires explicit reselection.
- Existing started-thread provider/model locking remains authoritative.
- No full model options are fabricated from incomplete recent history.
- Pending approvals and user input can be resolved in compact chat.
- Attachments, microphone, and workspace-only controls are absent in first release.
- Main-only singleton coordinators mount once; utility windows do not duplicate system notifications or global redirects.
- Main-only menu, notification, activation, second-instance, material, dialog, and update actions target deterministic roles.
- Windows/Linux users retain tray/main recovery when mascot is skipped from taskbar; macOS retains Dock recovery.
- Wayland behavior is explicitly supported with tested limits or disabled/degraded with accurate explanation.
- Explicit Quit and update installation stop all windows, backend/provider processes, update timers, and CUA daemon through existing teardown.
- Existing Sidecar, main-window, thread bootstrap, Recents, event recovery, provider session, and updater behavior does not regress.
- Numeric resource and latency budgets pass on reference packaged builds.
- Focused tests and `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass before implementation is complete.

## Open Questions

1. What final user-facing name should appear in Settings and menus: **Floating assistant**, **bigbud mascot**, or another approved label?
2. Should compact chat remain always on top while open, and should users receive a visible toggle? The current recommendation is on when opened from mascot, with a toggle if testing shows obstruction.
3. Should clicking outside compact chat hide it? The current recommendation is explicit close/hide for the first release so streamed responses do not disappear unexpectedly.
4. What exact default compact dimensions and resizability should design approve after Phase 0? The architecture supports bounded tuning without changing topology.
5. What numeric idle memory/CPU and click-latency budgets must pass before prerelease and stable rollout?
6. Which Wayland compositors, if any, should be supported rather than disabled/degraded?
7. Is the existing static bigbud `b` treatment sufficient across themes, or is a dedicated circular background asset needed? Animated characters remain out of scope.
8. Does product eventually require “most recently used” to mean provider-accepted or completed and synchronized across devices? If yes, design a server-authoritative projection as separate work.
9. Should historical model options such as reasoning effort be persisted for future compact drafts? Existing recent history cannot reconstruct them safely.
10. Should system completion notifications work when the main renderer is absent? This requires explicit main-process/leader ownership and is intentionally omitted from the first release.
11. Should compact attachments or microphone input be added in a follow-up? Each requires a focused capability, persistence, permission, and recovery review.
12. When compact chat is idle with only a durable thread and no unread state, should its renderer remain hidden or be destroyed and rehydrated to save memory? Decide from Phase 0/7 measurements.
