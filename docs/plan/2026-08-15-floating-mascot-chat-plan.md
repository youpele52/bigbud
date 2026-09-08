# Floating Mascot And Compact Chat Plan

**Date:** 15 August, 2026  
**Status:** Proposed  
**Owner:** bigbud team

## Summary

Add an optional desktop-only floating bigbud mascot that remains accessible above other applications without requiring the main bigbud window to be open. Clicking the mascot opens one small, focusable chat window sized similarly to the existing Sidecar. Users can start or continue a conversation, send prompts, and receive streamed responses through the existing bigbud backend.

Mascot conversations are normal `standard` threads in the built-in Chats project. The first submitted prompt materializes the local draft as a durable thread, and the thread then appears in the existing Chats/Recents collection and can be opened in the full application. Closing or hiding the compact window never deletes its thread or cancels active work.

The first release uses two explicit Electron windows: a tightly bounded transparent mascot window and a separate compact chat window. It reuses the current orchestration, draft bootstrap, timeline, composer, and streaming infrastructure while separating utility renderers from the full sidebar application shell. It does not introduce a second AI execution path, a special temporary thread type, or a voice-first assistant mode.

## Related Work

- Source discussion: [Floating mascot and compact chat assessment](bigbud-thread://b6eb4057-b16e-438d-92e9-b6b07b0b1940).
- Electron reference: [Frameless windows](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles), [custom window interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions), and [`BrowserWindow`](https://www.electronjs.org/docs/latest/api/browser-window).
- Existing compact conversation: `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx`.
- No repository issue ID, pull request, note, or Kanban card was identified. Create an issue ID before implementation so product decisions, platform validation, rollout, and follow-up work remain traceable.

## Problem

bigbud currently requires a user to expose and interact with the main desktop window before starting a conversation. This is unnecessarily disruptive when the user is working in another application and only needs to ask a short question, provide a quick instruction, or check a response.

The requested experience is:

1. Keep a small bigbud `b` mascot visible above ordinary applications.
2. Let the user position it on any connected display.
3. Open a Sidecar-sized chat when the mascot is clicked.
4. Start a normal conversation using the user's most recently used available model.
5. Stream responses while the main bigbud window remains unopened or hidden.
6. Preserve every materialized conversation in Chats/Recents.
7. Let the user open the same thread in the full application when more space or advanced controls are needed.

The backend and orchestration layers already support this flow, but the desktop and renderer shells do not. The desktop process tracks only one `mainWindow`, creates and shows it unconditionally, and routes several actions to whichever window happens to be focused or first in Electron's global window list. The web root always mounts the full sidebar shell and global coordinators. Reusing it unchanged in a second renderer would produce a cramped layout, duplicate side effects, and incorrect window routing.

This work must therefore establish reliable multi-window ownership before adding the mascot surface. Treating the feature as only `new BrowserWindow({ alwaysOnTop: true })` would leave concrete failures in startup, activation, menus, notifications, dialogs, backend state, close behavior, and second-instance handling.

## Goals

- Provide one optional floating mascot in the Electron application on macOS, Windows, and supported Linux environments.
- Keep the mascot visible above ordinary application windows where the operating system and window manager permit it.
- Support dragging and persist a safe position per display, including recovery after monitor topology changes.
- Open one compact, keyboard-focusable chat window without creating or showing the main bigbud window.
- Keep the backend lifecycle independent from main-window visibility.
- Create mascot conversations as normal `standard` threads in the built-in Chats project.
- Reuse existing draft bootstrap so an empty abandoned draft does not pollute durable Recents.
- Keep an active mascot thread after compact-window hide/close and continue receiving server-side work.
- Use the most recently submitted available provider/model selection from the current desktop profile in the first release.
- Validate the recent selection against current provider readiness and model catalog state before first send.
- Require explicit user selection when the recent provider/model is unavailable; do not silently substitute an unrelated model.
- Reuse the existing compact timeline, composer, model controls, approvals, and streaming behavior where they fit the small surface.
- Provide explicit **New chat**, **Open in bigbud**, **Hide mascot**, and **Quit bigbud** actions.
- Prevent duplicate native notifications, approval navigation, recovery prompts, and update prompts across renderers.
- Preserve existing reconnect, event-sequence recovery, provider-session, draft, update, and application shutdown guarantees.
- Make unsupported platform behavior visible and predictable rather than claiming universal overlay behavior.

## Non-Goals

- A browser-only floating overlay; this plan is for the Electron desktop application.
- Displaying above secure operating-system prompts, Windows elevation boundaries, exclusive fullscreen applications, or every possible window-manager layer.
- Guaranteeing always-on-top behavior on Wayland, where Electron does not support `alwaysOnTop` reliably.
- A voice-first orb, continuous microphone listening, wake word, spoken responses, or voice controls. Existing explicit composer microphone behavior may remain available if it fits the compact layout.
- A screen-reading assistant that automatically observes other applications. The mascot receives only content the user explicitly submits or attaches through existing bigbud controls.
- A new `mascot` or `side-chat` thread purpose.
- Reusing the current temporary Sidecar thread lifecycle or deleting a thread when compact chat closes.
- Multiple mascot instances or multiple simultaneous compact-chat windows in the first release.
- A full copy of the main header, sidebar, terminal, browser, diff panel, orchestra controls, branch toolbar, or right panel inside compact chat.
- Cross-device synchronization of renderer-local recent-model history in the first release.
- Automatically starting bigbud at operating-system login. That may be added after background-resource and user-consent validation.
- Hiding the macOS Dock icon or changing the application activation policy in the first release. Removing the Dock identity affects keyboard focus and discoverability and needs a separate platform decision.
- Editing `apps/web/src/routeTree.gen.ts`; TanStack Router must regenerate it through the normal build process.

## Current State

### Desktop window lifecycle

- `apps/desktop/src/main.ts:105-106` tracks only `mainWindow` and global quit state.
- `apps/desktop/src/main.ts:252-267` exposes one `makeWindow()` wrapper around the full application factory.
- `apps/desktop/src/main.ts:375-376` creates the main window unconditionally before backend startup completes.
- `apps/desktop/src/window/windowManager.ts:104-135` creates a `1100 x 780` window with minimum dimensions of `840 x 620`. It uses `hiddenInset`, enables webviews, and has no utility-window role.
- `apps/desktop/src/window/windowManager.ts:243-252` always shows the window at `ready-to-show` and opens detached DevTools in development.
- `apps/desktop/src/main.ts:469-473` creates a main window only when no Electron window exists. A persistent mascot would make this condition permanently false.
- `apps/desktop/src/main.ts:479-483` quits on last-window close outside macOS. Mascot, compact chat, and main-window close semantics must therefore be explicit.
- `apps/desktop/src/main.runtime.ts:15-35` falls back from the main window to the first Electron window for second-instance activation.
- No tray, global shortcut, always-on-top window, all-workspaces policy, skip-taskbar policy, position persistence, or utility-window registry currently exists.
- `apps/desktop/src/main.ts` is already 495 lines. Multi-window work must extract lifecycle responsibilities rather than extending this file beyond the repository's source-file limit.

### Window targeting and IPC

- `apps/desktop/src/window/ipcHandlers.ts:122-128` permits backend startup-state reads only from `mainWindow.webContents`, although later startup-state broadcasts reach every window.
- `apps/desktop/src/window/ipcHandlers.ts:168-215` selects the focused window or main window for dialogs and window material rather than resolving the caller from `event.sender`.
- `apps/desktop/src/window/ipcHandlers.ts:217-277` uses the same focus-based ownership for renderer context menus.
- `apps/desktop/src/window/menuManager.ts:109-132` dispatches application actions to the focused window, main window, or first arbitrary window. A compact renderer could therefore receive full-application navigation actions.
- `apps/desktop/src/window/menuManager.ts:227-234` closes only the main window on macOS.
- `apps/desktop/src/window/ipcHandlers.notifications.ts:31-37` can focus the first available window after a notification click.
- `apps/desktop/src/preload.ts` exposes one secure context-isolated bridge that can be reused, but it has no typed utility-window role or lifecycle operations.
- `packages/contracts/src/server/ipc.ts` defines the current desktop bridge contract and needs focused additions for window role and utility actions.

### Floating-window platform support

- Electron 40.6.0 is currently declared in `apps/desktop/package.json:22-26`.
- Electron supports frameless transparent windows, CSS draggable regions, `alwaysOnTop`, `setSkipTaskbar`, `setVisibleOnAllWorkspaces`, and mouse-event ignoring on relevant platforms.
- Electron documents important limits: transparent windows are not normally resizable, transparent pixels still belong to the rectangular window hit area, opening DevTools disables transparency, and always-on-top is unsupported on Wayland.
- `apps/desktop/src/window/windowManager.ts:116-125` currently enables transparency only on macOS. Windows and Linux have no tested transparent-window path in bigbud.
- `apps/web/src/index.css:260-271` already defines Electron drag/no-drag regions. A fully draggable mascot cannot simultaneously receive normal click events over the same region, so the mascot needs an explicit click-versus-drag design.
- Linux runtime policy already distinguishes X11/Wayland and GPU fallback in `apps/desktop/src/main.runtime.ts` and `main.linuxRuntime.ts`; mascot capability reporting must use that runtime knowledge.

### Renderer root and compact UI

- `apps/web/src/routes/__root.tsx:91-130` mounts server bootstrap, event routing, WebSocket coordination, toasts, approval handling, task notifications, startup repair, command palette, and `AppSidebarLayout` for every renderer.
- `apps/web/src/components/layout/AppSidebarLayout.tsx` always mounts the normal sidebar and enforces full-application layout assumptions.
- Mounting this root unchanged in a second renderer can duplicate native notifications, approval redirects, recovery prompts, update prompts, and other global effects.
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:51-135` contains a reusable compact conversation pattern using `MessagesTimeline`, `WorkingIndicator`, and `ChatViewComposer compact`.
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:214-249` makes the outer Sidecar unsuitable for a standalone window: it measures the main chat/composer, uses absolute positioning, and sizes itself to half of its parent.
- `apps/web/src/components/chat/view/ThreadComposerSurface.tsx` is the existing orchestration-aware boundary for rendering one thread's timeline and composer.
- `apps/web/src/components/chat/view/ChatViewContent.tsx` includes main-window-only header, terminal, branch, right-panel, plan, diff, and orchestra behavior and should not be mounted in compact chat.

### Thread creation and Recents

- `packages/contracts/src/orchestration/orchestration.thread.ts:35-36` defines only `standard` and `side-chat` thread purposes.
- Side-chat threads are intentionally excluded from normal sidebar membership and routing. Their temporary close/delete behavior conflicts with durable mascot history.
- `apps/web/src/hooks/useHandleNewThread.ts:263-294` creates a renderer-local draft, applies sticky provider/model state, and navigates without immediately creating a server thread.
- The first `thread.turn.start` carries `bootstrap.createThread`, allowing the server to create the durable thread and then dispatch the turn through the existing atomic bootstrap path.
- `apps/web/src/stores/main/events.store.projects.ts` adds newly created standard built-in Chats threads to Recents.
- Later user messages promote Chats threads through `apps/web/src/stores/main/events.store.threads.runtime.ts`.
- There is no `/chat/recent` route. Chats/Recents is a sidebar collection, while durable thread navigation uses `/$threadId`.
- Draft state is renderer-local. A draft created in one renderer is not automatically available in another, so compact chat must own its draft from creation through first send.

### Recent model behavior

- `apps/web/src/hooks/useRecentlyUsedModels.ts:14-29` exposes persisted recent-model entries from local storage.
- `apps/web/src/models/recentlyUsedModels.ts:7-19` stores provider, model, optional sub-provider, and `lastUsedAt` under `bigbud:recently-used-models:v2`.
- `apps/web/src/models/recentlyUsedModels.ts:107-129` records and keeps up to five selections per provider.
- Model usage is recorded after `thread.turn.start` is accepted by the client/server dispatch path, not after provider completion. The first release must describe this honestly as the most recently submitted model.
- `apps/web/src/stores/composer/actions.model.store.ts` also persists a globally sticky active provider and one sticky selection per provider. New drafts inherit this through `applyStickyState`.
- Local storage is shared by Electron windows using the same session and origin, but each renderer has its own Zustand runtime. Existing storage hooks must be verified for cross-window `storage` events rather than assuming same-document custom events synchronize every renderer.
- Provider/model availability can change after persistence. Existing startup fallback behavior may select another provider for an unstarted draft; compact chat must instead surface the unavailable recent selection before silently changing user intent.

## Phases

### Phase 0: Freeze Product Semantics And Platform Contract

**Goal:** Resolve user-visible behavior before window lifecycle and persistence code depend on it.

1. Create an implementation issue ID and link this plan.
2. Record the supported matrix as macOS, Windows, Linux/X11, and Linux/Wayland-degraded rather than claiming identical behavior.
3. Lock one mascot and one compact window per Electron application instance.
4. Lock mascot conversations to the built-in Chats project with `purpose: "standard"`.
5. Lock draft ownership to the compact renderer. An empty draft remains local; the first send materializes it; hide/close never deletes a durable thread.
6. Define compact-session continuity:
   - reopening compact chat resumes its current draft or durable thread;
   - **New chat** creates a fresh local draft;
   - **Open in bigbud** opens the same durable thread in the main window;
   - an unsent draft can be handed off only after an explicit shared-draft design, so first release disables full-window handoff until the draft is materialized.
7. Define “most recently used model” for the first release as the latest valid entry by `lastUsedAt` in `bigbud:recently-used-models:v2`, meaning the most recently submitted model in the current Electron profile.
8. Preserve provider-qualified identity: provider, model, and optional sub-provider. Continue using existing selection defaults/options where the recent entry does not store model options; do not invent historical effort or reasoning settings.
9. Before first send, validate provider enabled/installed/auth/readiness state and authoritative model/sub-provider availability. If invalid, retain the requested selection in the UI and require the user to choose another available model.
10. Decide and record the first-release activation policy before Phase 1 exits:
    - recommended: mascot is off by default, enabled explicitly in Desktop settings, and remembered;
    - once enabled, closing the main window leaves the mascot/backend running;
    - explicit **Quit bigbud** remains available from the mascot context menu and application menu;
    - start-at-login remains off and out of scope.
11. Decide the persisted desktop preference boundary. Prefer a small desktop-owned, schema-validated, atomically written preference under Electron `userData` because the feature controls windows before the renderer/server settings are available. Do not parse unrelated server settings ad hoc.
12. Define initial geometry for implementation and usability testing: target `480 x 620`, minimum `360 x 440`, maximum bounded to the active display work area. Final dimensions may be tuned from packaged usability testing without changing architecture.
13. Define reduced-motion behavior: a static `b` logo is always available; idle floating animation is subtle, pauses when reduced motion is requested, and never moves the native window automatically.

**Exit criteria:** Product owners have accepted thread durability, model semantics, enablement/quit behavior, compact continuity, and the degraded Wayland contract. No later phase relies on an unstated startup or deletion assumption.

### Phase 1: Introduce Role-Aware Desktop Window Ownership

**Goal:** Make multiple Electron windows safe before changing visible startup behavior.

**Dependencies:** Phase 0 lifecycle decisions are recorded.

1. Extract window lifecycle responsibility from the over-limit `apps/desktop/src/main.ts` into focused modules using the repository's dot-notation pattern.
2. Add a window registry with explicit `main`, `mascot`, and `compact-chat` roles. It must never infer a role from `BrowserWindow.getAllWindows()` order.
3. Keep at most one live window per role and make create/show/focus/hide/close operations idempotent under rapid repeated calls.
4. Split common secure web preferences and navigation policy from role-specific window options. Preserve `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, safe external navigation, certificate challenge cleanup, theme cleanup, and permission handling.
5. Keep the existing main-window factory behavior initially, but route all main-window creation through `openMainWindow({ threadId? })`.
6. Change macOS `activate`, second-instance handling, notification clicks, update actions, and application-menu actions to target an explicit role.
7. Route settings, full navigation, browser, terminal, and other main-only actions to `openMainWindow` even when compact chat is focused.
8. Make **Close Window** target the focused closeable window. Hiding compact chat must not close the mascot or quit the application.
9. Resolve window-owned IPC from `BrowserWindow.fromWebContents(event.sender)` and authorize only registered app windows. Remove the main-renderer-only backend startup-state assumption.
10. Keep global theme changes global, but apply material, context menus, dialogs, and other window-specific effects to the sender window.
11. Add typed, narrow bridge methods for window role, open main, show/hide compact chat, hide mascot, update mascot bounds, and quit. Do not expose raw Electron window APIs to the renderer.
12. Preserve backend and updater broadcasts to all registered windows, while allowing renderer layers to decide which coordinators are role owners.

**Likely files:**

- `apps/desktop/src/main.ts`
- `apps/desktop/src/main.runtime.ts`
- `apps/desktop/src/main.windows.ts` (new)
- `apps/desktop/src/window/DesktopWindowRegistry.ts` (new)
- `apps/desktop/src/window/windowManager.ts`
- `apps/desktop/src/window/windowManager.main.ts` (new if needed)
- `apps/desktop/src/window/ipcHandlers.ts`
- `apps/desktop/src/window/menuManager.ts`
- `apps/desktop/src/window/ipcHandlers.notifications.ts`
- `apps/desktop/src/main.channels.ts`
- `apps/desktop/src/preload.ts`
- `packages/contracts/src/server/ipc.ts` or a focused direct-subpath desktop-window contract
- Focused desktop tests

**Failure and recovery behavior:** A failed utility-window load leaves existing windows and backend intact and produces a logged safe error. Repeated open requests coalesce on the existing window. Destroyed windows are removed from the registry before any subsequent role lookup.

**Exit criteria:** Main-window behavior is unchanged for users, but tests prove that menus, IPC, notifications, activation, second launch, close, and quit target deterministic roles when mock mascot and compact windows exist.

### Phase 2: Separate Shared Renderer Infrastructure From Full-App Ownership

**Goal:** Let utility renderers synchronize one thread without mounting the full application shell or duplicating global side effects.

**Dependencies:** Phase 1 exposes a trusted window role through the preload bridge.

1. Resolve renderer mode once from the desktop bridge as `main`, `mascot`, or `compact-chat`. Browser deployments remain `main` mode.
2. Refactor `RootRouteView` into shared data infrastructure and role-specific shells rather than adding scattered pathname checks to every coordinator.
3. Mount these in main and compact renderers:
   - native API initialization;
   - server configuration bootstrap;
   - ordered orchestration event routing and sequence recovery;
   - WebSocket connection coordination/surface;
   - desktop backend startup state;
   - theme and essential toast infrastructure.
4. Keep these main-renderer-only unless a focused review proves otherwise:
   - `AppSidebarLayout`;
   - command palette and main navigation actions;
   - task-completion native notifications;
   - pending-approval navigation;
   - update and provider-recovery notifications;
   - file-access and computer-use startup repair dialogs;
   - plugin launch/update watchers and other singleton global coordinators.
5. Give compact chat local inline states for connection failure, provider failure, approval, and input-required conditions instead of relying on main-window redirects.
6. Keep the mascot renderer minimal. It should not initialize a full orchestration store or WebSocket unless measurements prove that live status on the mascot is necessary. Mascot clicks should use IPC to open compact chat.
7. Add dedicated utility routes or a role-owned entry shell, for example `/compact-chat/$threadId` and `/compact-chat/new`. Never load the compact renderer at `/`, where root welcome logic can independently create a new draft.
8. Regenerate the TanStack route tree normally and do not edit the generated file.
9. Ensure utility-route links and unsupported actions explicitly hand off to the main window rather than navigating the compact renderer into full-app pages.

**Likely files:**

- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/-__root.logic.tsx`
- `apps/web/src/routes/_compact-chat.tsx` or an equivalent dedicated route family (new)
- `apps/web/src/lib/desktopWindowRole.ts` (new)
- `apps/web/src/components/DesktopBackendStartupCoordinator.tsx`
- Role-specific root coordinator modules and tests

**Failure and recovery behavior:** A compact renderer reconnects and performs the same bounded event recovery as the main renderer. It never becomes the owner of a native singleton notification merely because the main window is hidden or destroyed; ownership remains explicitly assigned by role.

**Exit criteria:** A compact test route can hydrate a known durable thread and stream events without rendering the sidebar or producing duplicate native notifications, approval redirects, or global startup dialogs.

### Phase 3: Build Compact Thread Creation And Recent-Model Resolution

**Goal:** Create predictable normal Chats threads from the compact renderer using the user's latest valid submitted model.

**Dependencies:** Phase 2 provides the compact renderer's shared state and route boundary.

1. Extract reusable draft creation logic from `useHandleNewThread` without changing existing main-window semantics.
2. Always target `BUILT_IN_CHATS_PROJECT_ID`, local environment mode, no branch, and no worktree for mascot-created drafts.
3. Keep one compact-owned draft ID. Do not write it into another renderer's composer store or assume renderer-local Zustand state is shared.
4. Reuse `bootstrap.createThread` on first send. Do not add an eager `thread.create` call solely to make the compact route work.
5. Resolve the newest recent-model entry globally by valid ISO `lastUsedAt`, not by provider array order.
6. Verify cross-window storage synchronization. Extend the local-storage hook only if the standard `storage` event does not update another renderer; retain the current same-document custom event for local writes.
7. Validate the recent selection against the current provider snapshot and model catalog before enabling first send.
8. If no recent entry exists, use the existing sticky active provider/model, then the built-in Chats project/default provider selection.
9. If a persisted recent or sticky selection is present but unavailable, show a concise model-required state and open the existing provider/model picker. Do not silently move to another provider.
10. Preserve model options from current sticky/default state only when they belong to the same provider/model and remain valid. The recent-history record itself does not reconstruct old options.
11. On successful first dispatch, let existing `recordModelUsage` update recency and let ordinary domain events add the materialized thread to Recents.
12. Persist only the current compact draft/thread identity required for reopen continuity. Validate it against server state at startup; clear stale/deleted IDs and create a fresh local draft.
13. Define concurrent-window behavior: if the same durable thread is open in main and compact windows, both may observe it, but only normal server sequencing is authoritative. Optimistic state remains local until the durable event arrives.

**Likely files:**

- `apps/web/src/hooks/useHandleNewThread.ts`
- `apps/web/src/hooks/useCompactChatThread.ts` (new)
- `apps/web/src/models/recentlyUsedModels.ts`
- `apps/web/src/hooks/useRecentlyUsedModels.ts`
- `apps/web/src/hooks/useLocalStorage.ts`
- `apps/web/src/stores/composer/*`
- `apps/web/src/components/chat/view/ChatView.sendTurn.helpers.ts`
- Focused model, storage, draft, and bootstrap tests

**Failure and recovery behavior:** If first-send bootstrap fails, retain the prompt and local draft through the existing send restoration path. If the connection outcome is uncertain, reconcile from the durable thread snapshot/event stream before allowing a duplicate retry. A missing/deleted persisted compact thread falls back to a fresh local draft without fabricating history.

**Exit criteria:** Compact chat can create a draft, submit the first prompt exactly once, receive streamed output, and produce one normal visible Chats thread. Recent unavailable selections require explicit recovery, and cross-window model updates are observed.

### Phase 4: Extract And Build The Compact Chat Surface

**Goal:** Deliver a small conversation UI that reuses existing behavior without carrying full ChatView dependencies into the utility window.

**Dependencies:** Phase 3 can provide a valid compact draft or durable thread.

1. Extract `SideChatConversation` from `FloatingSideChat.tsx` into a neutral compact-thread component. Keep `FloatingSideChat` as a host of that component so the existing in-app Sidecar does not regress.
2. Reuse `ThreadComposerSurface`, `MessagesTimeline`, compact `ChatViewComposer`, working state, error banners, approvals, pending user input, attachments, and side-chat auto-scroll behavior where appropriate.
3. Do not reuse the outer `FloatingSideChat` positioning or its dependency on `[data-chat-view-root]` and `[data-chat-composer-form]`.
4. Add a compact titlebar/header with:
   - thread title or **New chat**;
   - current provider/model status;
   - **New chat**;
   - **Open in bigbud** for durable threads;
   - minimize/hide and close controls.
5. Hide or hand off unsupported full-app controls: terminal, browser, diff, right panel, orchestra, branch/worktree, project switching, and main settings navigation.
6. Keep provider/model selection available before first send. Preserve valid same-provider model controls after session start according to existing provider capability rules.
7. Keep composer controls responsive at the Phase 0 minimum width. If all current footer actions do not fit, move secondary actions into an existing shadcn menu rather than clipping or reducing below the app's `text-sm` default.
8. Ensure popovers, menus, tooltips, attachment previews, approval panels, and model picker stay within the compact viewport.
9. Use a normal opaque/translucent compact chat window rather than making the entire chat transparent. This avoids a large transparent rectangle blocking applications behind it.
10. Hide the compact window instead of destroying it during normal close when a turn or draft is active. Destroy it during explicit application quit or controlled recovery.
11. Keep active server work running while hidden. Reopening must show current streamed/projected state without starting another turn.
12. Add **Open in bigbud** IPC that creates/focuses the main window and navigates that main renderer to the durable `/$threadId` route. For an unsent draft, disable the action with a clear explanation or require first send.
13. Add accessible labels, focus order, visible focus, reduced-motion handling, keyboard escape/close behavior, and focus restoration to the previously active application when the compact chat hides.

**Likely files:**

- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx`
- `apps/web/src/components/chat/side-chat/CompactThreadConversation.tsx` (new)
- `apps/web/src/components/chat/compact/CompactChatWindow.tsx` (new)
- `apps/web/src/components/chat/view/ThreadComposerSurface.tsx`
- `apps/web/src/components/chat/view/chat-view/ChatViewComposer.tsx`
- Compact chat route and browser tests
- `apps/desktop/src/window/windowManager.compactChat.ts` (new)

**Exit criteria:** At the minimum supported size, users can create/send/read a thread, handle required approvals/input, change an eligible model, hide/reopen the window, and open the durable thread in the main application without clipped primary actions or duplicate sends.

### Phase 5: Add The Mascot Window, Positioning, And Native Controls

**Goal:** Provide the floating entry point without compromising input, focus, or multi-display reliability.

**Dependencies:** Compact chat is independently functional and Phase 1 owns explicit utility roles.

1. Add a dedicated mascot factory with a small fixed-size frameless window, transparent background where supported, no maximize/minimize/fullscreen, no webview, and no automatic DevTools opening.
2. Use `alwaysOnTop` where supported, `skipTaskbar` on Windows/Linux where appropriate, and `setVisibleOnAllWorkspaces` on macOS/Linux when supported. Do not claim this works on Wayland.
3. Keep the native window bounds tight around the visible mascot so transparent pixels intercept as little of the underlying application as possible.
4. Render the existing bigbud `b` artwork or a purpose-built repository asset with light/dark/high-contrast treatment. Do not ship the reference third-party mascot artwork.
5. Separate click and drag interaction deliberately. Prefer a small explicit drag affordance or tested pointer-distance gesture; do not make the same CSS region both `app-region: drag` and a clickable button.
6. Single click opens/focuses compact chat. Rapid repeated clicks coalesce. Right click opens a native menu with **Open chat**, **New chat**, **Open bigbud**, **Hide mascot**, and **Quit bigbud**.
7. Position compact chat adjacent to the mascot when space permits, then clamp it to the active display work area. It may overlap the mascot only when the display is too small for another safe placement.
8. Persist mascot bounds after drag completion, not every pointer movement. Key position by stable display identity when available and retain normalized edge offsets as a fallback.
9. On startup, display change, resolution change, scale-factor change, sleep/wake, or monitor removal, validate persisted bounds and move the mascot into the nearest visible work area.
10. Never animate the native window around the screen. Any idle visual motion remains inside fixed bounds and respects reduced motion.
11. Keep mascot show/hide state and enablement in the Phase 0 desktop preference store. Use schema validation, bounded values, atomic replacement, and safe defaults after corruption.
12. If transparency or GPU composition is unavailable, show a small opaque fallback surface rather than failing startup.
13. On Wayland, expose the mascot as a normal focusable utility window without promising persistent absolute placement or always-on-top behavior. Consider a tray-only fallback if packaged testing shows the degraded window is misleading.

**Likely files:**

- `apps/desktop/src/window/windowManager.mascot.ts` (new)
- `apps/desktop/src/window/mascotBounds.ts` (new)
- `apps/desktop/src/window/desktopPreferences.ts` (new)
- `apps/desktop/src/window/mascotMenu.ts` (new)
- `apps/web/src/routes/_mascot.tsx` or equivalent role shell (new)
- `apps/web/src/components/mascot/FloatingMascot.tsx` (new)
- Existing or new repository-owned mascot assets
- Positioning, preference, registry, and interaction tests

**Failure and recovery behavior:** Corrupt preferences fall back to disabled/default placement without deleting unrelated desktop data. Invalid or off-screen bounds are corrected before show. Mascot renderer failure does not terminate the backend or compact/main windows; one bounded recreation may be attempted, then the user can reopen bigbud normally.

**Exit criteria:** On supported packaged platforms, the mascot can be enabled, moved, clicked, hidden, restored, and used across monitor changes without becoming unreachable, stealing focus while idle, or opening duplicate compact windows.

### Phase 6: Harden Lifecycle, Ownership, And Resource Use

**Goal:** Make background operation predictable during close, reconnect, update, crash, and concurrent-renderer scenarios.

**Dependencies:** Phases 1-5 are integrated behind a default-off rollout setting.

1. Define one explicit application state machine covering main visible/hidden/destroyed, mascot visible/hidden, compact visible/hidden/destroyed, and application quitting.
2. Keep the backend running while any enabled mascot workflow remains active, even if main and compact windows are hidden.
3. Ensure explicit quit stops provider/backend/CUA processes through the existing `prepareForAppQuit` path and destroys all windows once.
4. Ensure update installation uses the existing backend-stop-and-wait path and cannot be blocked by a hidden utility window.
5. Elect the main renderer as singleton owner for native task notifications and global prompts. If product later requires notifications with no main renderer, move ownership to an explicit main-process or leader contract rather than letting every compact renderer emit them.
6. Verify event-sequence recovery independently in main and compact renderers. A renderer reconnect must not replay a prompt or duplicate an optimistic user message.
7. Bound compact WebSocket/store cost to one renderer. Destroy dormant compact chat only when it has no unsent draft, no active turn, and its durable state can be rehydrated safely.
8. Keep mascot renderer lightweight and avoid a WebSocket connection unless a measured status feature requires it.
9. Handle backend unavailable/upgrading/failed states in compact chat with retry and **Open bigbud** actions. Never leave the mascot click apparently inert.
10. Record safe diagnostics for window-role creation, show/hide/focus transitions, corrected off-screen bounds, renderer crashes, and platform capability downgrades. Do not log prompts, responses, auth tokens, or model credentials.
11. Verify microphone permission remains user-initiated. The mascot itself must never request media permission.
12. Add a feature kill switch or desktop preference reset path that returns startup to the normal main-window behavior without requiring the mascot renderer to load.

**Exit criteria:** Restart, backend failure, renderer crash, reconnect, update install, explicit quit, rapid clicks, and concurrent main/compact viewing preserve one thread history and deterministic window ownership without leaked processes or duplicate effects.

### Phase 7: Package, Validate, And Roll Out By Platform

**Goal:** Ship only platform behavior demonstrated by packaged builds.

**Dependencies:** All automated lifecycle and compact-chat tests pass.

1. Keep the feature disabled by default for the first packaged preview.
2. Validate signed/notarized macOS builds on at least one Apple Silicon and one Intel-capable environment where available.
3. Validate packaged Windows x64 behavior including taskbar presence, scaling, multi-monitor placement, fullscreen applications, and elevated-window boundaries.
4. Validate Linux X11 separately from Wayland. Record the window manager/compositor used and preserve an opaque/tray fallback where transparency or placement is unreliable.
5. Measure idle CPU/GPU/memory with mascot only, mascot plus hidden compact chat, visible compact chat, and active streaming.
6. Measure cold click-to-composer-ready and warm click-to-focus latency. Do not preload full main-renderer state solely to improve the mascot metric.
7. Validate high-DPI displays, mixed scale factors, monitor disconnect/reconnect, virtual desktops/Spaces, sleep/wake, screen sharing, reduced motion, and keyboard-only use.
8. Roll out in stages: development flag, packaged internal preview, opt-in prerelease setting, then stable opt-in after platform gates pass.
9. Keep Wayland wording explicit in settings and release notes if always-on-top or position persistence remains unsupported.
10. Add changelog and user documentation only after the implemented behavior and supported matrix are verified.

**Exit criteria:** The feature is enabled only on platform modes with documented, tested behavior; unsupported modes degrade visibly; performance remains within agreed budgets; and users can always recover the normal main application or quit.

## Risks And Decision Gates

- **Wayland limitation:** Electron documents `alwaysOnTop` as unsupported on Wayland. Ship a declared degraded mode or tray-only entry point; do not present the same promise as macOS, Windows, or X11.
- **Always-on-top is not absolute:** Secure prompts, elevated Windows applications, exclusive fullscreen software, and OS-owned surfaces may cover the mascot. Product copy must say “above ordinary apps,” not “always above everything.”
- **Transparent hit rectangle:** Transparent native pixels still intercept input. Keep mascot bounds tight and test click behavior over underlying controls.
- **Click versus drag:** CSS drag regions suppress pointer interaction. Phase 5 cannot ship until clicking and dragging are both reliable without accidental chat opens.
- **Focus stealing:** The idle mascot must not activate bigbud. Compact chat should focus only after explicit click and return focus predictably when hidden.
- **Background consent:** Leaving backend/provider work running after the main window closes changes user expectations. The feature must be opt-in and provide obvious hide/quit controls.
- **Dock/taskbar discoverability:** The first release keeps the normal app identity. Hiding the Dock icon or changing activation policy is rejected until keyboard focus and quit discoverability are separately validated.
- **Local recent-model semantics:** The first release uses most recently submitted, not last completed or last provider-accepted. If product requires stronger semantics or cross-device continuity, add a server-authoritative usage record in a separate phase before claiming it.
- **Unavailable recent model:** Silent fallback is rejected. The compact surface must explain that the previous provider/model is unavailable and require a new choice.
- **Renderer-local drafts:** Do not hand an unsent draft ID between windows. If draft handoff becomes required, design shared persisted draft ownership rather than copying prompt state through ad hoc IPC.
- **Duplicate global effects:** Utility renderers cannot mount all existing root coordinators. Role ownership tests are a release gate.
- **Concurrent optimistic state:** Main and compact renderers can briefly differ before durable events arrive. Server sequence and projection state remain authoritative; do not create cross-window optimistic synchronization unless evidence requires it.
- **Resource footprint:** A persistent backend and utility renderer consume resources. Measure before enabling at login or keeping compact chat permanently mounted.
- **Transparent GPU behavior:** DevTools disables transparency, and compositor/GPU fallback may alter rendering. Validate packaged builds and provide an opaque fallback.
- **Notification ownership:** If the main renderer is absent, task notifications may not run in the first release. Moving notification ownership is a separate explicit decision; duplication is worse than omission.
- **Position persistence:** Display IDs, scale factors, and work areas change. Persist enough normalized information to recover, but always validate against current displays before showing.
- **Rollback:** The desktop preference kill switch must restore normal main-window startup without deleting Chats threads or recent-model history. Window-role changes should be independently reversible from compact UI changes.

## Testing And Validation

### Desktop unit tests

- Window registry returns one window per role and clears destroyed references.
- Concurrent open requests create one compact window.
- Main-only menu actions never target mascot or compact renderers.
- Sender-owned IPC resolves the correct registered window and rejects unknown web contents.
- Backend startup state is available to trusted utility renderers.
- macOS activation and second-instance launch open/focus the intended role when mascot already exists.
- Closing main, compact, and mascot windows follows the Phase 0 lifecycle contract on macOS, Windows, and Linux.
- Explicit quit invokes teardown once and cannot be cancelled by hidden windows.
- Bounds normalization handles negative coordinates, mixed scale factors, removed displays, tiny work areas, corrupt values, and partially visible windows.
- Desktop preferences decode safe defaults, write atomically, and recover from malformed data.
- Wayland capability resolution does not claim always-on-top support.

### Web unit and component tests

- Root role selection mounts shared synchronization in compact mode but excludes main-only singleton coordinators.
- Mascot mode mounts no sidebar and no unnecessary WebSocket/store graph.
- Recent-model resolution picks the newest valid cross-provider entry by timestamp.
- Invalid timestamps, removed providers, missing sub-providers, stale authoritative catalog models, and disabled providers produce explicit recovery.
- Cross-window storage events update recent-model state.
- Compact draft creation always targets built-in Chats and does not create a durable thread before first send.
- First send materializes exactly one standard thread and restores the draft after immediate failure.
- Compact close/hide preserves the current draft or durable thread.
- Reopen hydrates current stream state without dispatching another turn.
- **Open in bigbud** targets the durable thread and stays disabled for an unsent local-only draft.
- Compact composer, approval, input-required, attachment, model picker, popover, and error states fit the minimum viewport.
- Existing in-app `FloatingSideChat` behavior remains unchanged after conversation extraction.
- Utility-route links hand off to the main window instead of replacing compact chat with full-app pages.

### Server and orchestration regression tests

- Existing bootstrap create-and-turn tests remain unchanged and passing.
- Standard built-in Chats threads continue entering Recents through existing domain events.
- Multiple renderer subscriptions receive ordered events and recover from sequence gaps independently.
- Hiding or destroying a renderer does not cancel a provider turn.
- No new server thread purpose or provider-specific execution path is introduced.

### Browser tests

- Run compact routes at default and minimum dimensions.
- Create a new compact chat, send a prompt with a fake provider, observe streaming, hide/reopen, and open the same thread in the main shell.
- Verify keyboard navigation, visible focus, screen-reader names, reduced motion, and constrained menus/popovers.
- Verify unavailable recent-model recovery and backend-disconnected states.
- Verify no duplicate task notification or approval redirect is emitted when main and compact renderers are mounted.

### Packaged manual matrix

- macOS: current Space, another Space, fullscreen Space, mixed displays, sleep/wake, app activation, Dock click, signed/notarized build, microphone prompt only after explicit composer action.
- Windows: taskbar behavior, DPI changes, mixed monitors, Snap/fullscreen, elevated app boundary, startup/quit, update installation.
- Linux/X11: compositor on/off where supported, transparency fallback, always-on-top, multi-monitor placement, GPU fallback.
- Linux/Wayland: confirm and document degraded always-on-top/placement behavior; validate tray or normal-window fallback.
- All platforms: main window never appears during mascot-only chat, active work continues while compact chat is hidden, and explicit quit leaves no backend/provider process.

### Performance checks

- Idle mascot CPU and GPU usage.
- Main-process, mascot-renderer, compact-renderer, and backend memory separately.
- Cold and warm mascot-click-to-focused-composer latency.
- Compact event-stream cost during long responses.
- Position persistence write frequency during drag.
- No full main renderer preloading in mascot-only mode unless measurements justify it.

### Repository commands

Run focused Vitest suites first, then all repository-required checks:

```sh
bun run --cwd apps/desktop test
bun run --cwd apps/web test
bun run test
bun fmt
bun lint
bun typecheck
```

Use `bun run test`, never `bun test`. Record unrelated pre-existing failures separately and do not weaken assertions to make the feature pass.

## Acceptance Criteria

- Users can explicitly enable one repository-owned bigbud mascot without enabling start-at-login.
- The mascot appears without showing the main bigbud window and does not steal keyboard focus while idle.
- Clicking it opens or focuses exactly one compact chat window.
- The compact window remains usable at `360 x 440` and defaults near `480 x 620`, subject to final packaged UX tuning.
- The first prompt creates exactly one `standard` thread in built-in Chats and the thread appears in Recents.
- Closing or hiding compact chat never deletes the thread or cancels active work.
- Reopening compact chat restores the current draft or durable thread and current streamed state.
- **New chat** starts a separate local draft; the old durable thread remains in Recents.
- **Open in bigbud** opens the same durable thread in the main window.
- The latest valid recently submitted provider/model is selected across supported providers.
- An unavailable recent provider/model requires explicit reselection and is never silently replaced.
- Menus, notifications, dialogs, updates, activation, and second-instance handling target deterministic window roles.
- Main-only global coordinators do not run in utility renderers, and native notifications or approval redirects are not duplicated.
- Mascot placement survives restart and display changes or is safely clamped back onscreen.
- macOS, Windows, and Linux/X11 behavior is validated in packaged builds; Wayland behavior is explicitly degraded and documented.
- Users can always hide the mascot, open the full application, or quit bigbud from a native menu.
- Explicit quit and update installation stop backend, provider, and CUA processes through existing teardown paths.
- Existing main-window, Sidecar, thread bootstrap, event recovery, provider session, and update behavior does not regress.
- Focused tests and all of `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass before implementation is considered complete.

## Open Questions

1. Should enabling the mascot change subsequent application launches to mascot-only startup, or should the normal main window still appear after an explicit app launch? The recommended first-release behavior is mascot-only startup after explicit enablement, while Dock/taskbar activation opens the main window.
2. Should clicking outside compact chat hide it automatically, or should it remain open until explicitly closed? Explicit close is safer for reading streamed responses; click-away can be added as an option later.
3. Should compact chat remain always on top while open? The recommendation is yes while opened from the mascot, with a visible toggle if usability testing shows it obstructs work.
4. Should notification ownership move to the main process so task completion notifications work when no main renderer exists? The first release can omit those notifications in mascot-only mode rather than risk duplicates, but product should decide before rollout.
5. Is “most recently submitted model in this desktop profile” sufficient, or must this become last provider-accepted/completed and server-authoritative across devices? The latter requires a separate persisted model-usage design.
6. Should an unsent compact draft be transferable to the full main window? The recommendation is no for the first release; require materialization through first send before **Open in bigbud**.
7. Is a tray icon required in addition to the mascot context menu? It is strongly recommended on Windows/Linux for recovery and quitting, especially if the mascot is hidden.
8. What mascot animation and final dimensions should design approve? Architecture should begin with the static bigbud `b`, reduced-motion-safe subtle idle treatment, and the bounded dimensions in Phase 0.
9. On Wayland, should bigbud offer the degraded normal utility window, tray-only access, or disable the mascot setting with an explanation? Packaged testing must determine which option is least misleading.
