# Floating bigbud Mascot Chat Window Plan

**Date:** 15 August, 2026
**Status:** Proposed
**Owner:** Codex

## Summary

Add an optional desktop-only floating bigbud mascot that remains available above other applications while the bigbud main window is closed. The initial mascot is the existing bigbud `b` logo. It can be repositioned anywhere on the user's displays, expands into a compact chat window when clicked, and collapses without interrupting an active response.

Each mascot conversation is an ordinary `standard` thread in the built-in Chats project. Sent mascot conversations therefore appear in Chats → Recent, survive restarts, and can be opened in the main bigbud window. A new mascot conversation starts with the model selection from the most recently accepted user turn, subject to provider availability and a deterministic fallback.

The implementation must preserve bigbud's server-owned thread and provider lifecycle, avoid duplicate renderer coordinators, isolate drafts between native windows, and behave predictably through main-window closure, reconnects, display changes, renderer crashes, and application updates.

## Related Work

None identified. This plan was produced from direct repository investigation and the user's floating-mascot request; no stable note, Kanban card, repository issue, or pull request was linked.

## Problem

bigbud currently requires users to interact through the main desktop window. The existing Sidecar provides an appropriately compact conversation UI, but it is rendered inside the main chat page and cannot remain visible over unrelated applications. Users who want a quick answer must restore or reopen the complete application window, locate or create a conversation, and then return to their previous application.

The existing Sidecar is not a correct persistence model for an operating-system-level mascot:

- Sidecar is tied to an active main thread and copies that thread's project, execution targets, model, and runtime mode.
- Sidecar threads use purpose `side-chat`, are deliberately hidden from ordinary navigation and Recent, and are deleted when the Sidecar is closed.
- Sidecar layout assumes it is absolutely positioned inside a full chat viewport and measures the main composer to calculate its height.

The desktop runtime also assumes one renderer and one native window in several places. Adding a second window without correcting those assumptions would create concrete reliability problems:

- composer drafts and sticky model state can overwrite each other through shared local storage;
- global task notifications, approval coordination, startup toasts, and recovery effects can mount twice;
- some IPC handlers authorize only the main renderer or target whichever window happens to be focused;
- second-instance and application-activation logic can focus the mascot instead of opening the main window;
- the floating window can become unreachable after display removal or scaling changes;
- the current new-thread default is `full-access`, which is too consequential to inherit silently in a consumer-style quick-chat surface.

The goal is therefore not merely to create an always-on-top `BrowserWindow`. The feature needs an explicit native window role, a compact renderer shell, normal Chats-thread semantics, authoritative last-used-model selection, window-local draft ownership, and platform-specific lifecycle handling.

## Goals

- Let a desktop user click the floating bigbud `b` while the main bigbud window is closed and immediately access a compact chat.
- Keep the mascot above normal application windows without stealing focus until the user interacts with it.
- Let the user move the collapsed mascot and retain a valid position across restarts, monitor removal, monitor scaling, and work-area changes.
- Expand and collapse one native window without interrupting provider work, streaming, approvals, queued prompts, or recovery.
- Materialize sent mascot conversations as `standard` threads in the built-in Chats project so they appear under Chats → Recent.
- Preserve an unsent mascot draft when the mascot is collapsed, the main window is opened, or the mascot renderer reloads.
- Start each new mascot conversation with the model selection from the most recently accepted user turn across supported providers.
- Fall back predictably when the recorded provider or model is disabled, unavailable, unauthenticated, removed, or absent from an authoritative catalog.
- Keep a started thread bound to its own model/session semantics; a later model selection elsewhere affects only the next mascot conversation.
- Prevent the main and mascot renderers from corrupting each other's drafts or mounting duplicate global coordinators.
- Preserve the current sandbox, context-isolation, authentication-token, projection replay, provider-session, and auto-update guarantees.
- Provide reliable escape paths: collapse, open in bigbud, disable the floating assistant, and quit bigbud.
- Meet keyboard, screen-reader, reduced-motion, contrast, and focus-management expectations.

## Non-Goals

- Do not add an animated character, generated mascot, lip synchronization, or voice-call orb in the first release. Reuse the existing bigbud `b` logo.
- Do not make the floating assistant available in the browser, mobile web, or remote-control surfaces.
- Do not promise visibility over secure desktops, lock screens, UAC prompts, operating-system permission dialogs, or every exclusive-fullscreen application.
- Do not convert existing Sidecar threads into visible Chats threads or change Sidecar's attach-as-context behavior.
- Do not reuse Sidecar's destructive close behavior for mascot conversations.
- Do not keep the hidden main renderer alive solely to power the mascot.
- Do not introduce a second backend or a second provider process manager. Both windows use the existing desktop backend and orchestration engine.
- Do not automatically move a partially typed main-window draft into the mascot or vice versa.
- Do not silently change the model of a mascot thread after its first turn.
- Do not add cloud synchronization for mascot position, window state, or drafts.
- Do not add launch-at-login behavior in this plan.
- Do not require a tray icon for the first release. Revisit a tray recovery surface only if packaged Windows or Linux testing shows that the mascot and second-instance recovery are insufficient.

## Current State

### Desktop window and application lifecycle

- `apps/desktop/src/window/windowManager.ts:104-135` constructs one 1100×780 main `BrowserWindow` with a hidden-inset title bar, shared preload, sandboxing, context isolation, and `webviewTag` enabled.
- `apps/desktop/src/main.ts:105-106` tracks only `mainWindow` and `isQuitting`.
- `apps/desktop/src/main.ts:252-267` exposes one main-window factory, while `apps/desktop/src/main.ts:375-376` creates the main window before requesting backend startup.
- `apps/desktop/src/main.ts:469-473` creates a main window on macOS activation only when there are no `BrowserWindow` instances. A live mascot would make that condition false.
- `apps/desktop/src/main.ts:479-483` quits on Windows and Linux after the last native window closes. A live mascot can intentionally keep the backend alive after the main window closes.
- `apps/desktop/src/main.runtime.ts:15-30` falls back to `BrowserWindow.getAllWindows()[0]` for a second application launch. With multiple roles, this can select the mascot instead of the main window.
- There is no persisted native-window position manager and no display-change handling in the desktop package.
- `apps/desktop/src/main.ts` is already above the non-test TypeScript target at 495 lines. Mascot lifecycle code must be added in focused modules rather than extending it inline.

### IPC and security boundary

- `apps/desktop/src/preload.ts` exposes one broad `DesktopBridge` to the main renderer.
- `apps/desktop/src/window/ipcHandlers.ts:122-128` restricts backend startup state to `getMainWindow().webContents`, so a trusted mascot renderer cannot use the existing startup coordinator.
- `apps/desktop/src/window/ipcHandlers.ts:168-190` assigns dialogs to the focused window or main window rather than the IPC sender.
- `apps/desktop/src/window/ipcHandlers.ts:202-215` applies window material to the focused window or main window rather than the sender's window.
- The main window enables plugins and `webviewTag`; the mascot does not need either capability.
- Microphone permission handling is installed through the shared Electron session by the main-window factory. A future mascot-only startup path cannot assume the main window configured the session first.

### Existing compact chat surface

- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:52-135` already composes `MessagesTimeline`, `WorkingIndicator`, and compact `ChatViewComposer` behavior.
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx:198-266` positions the Sidecar inside a main chat viewport and derives available height from the main composer.
- `apps/web/src/components/chat/view/ThreadComposerSurface.tsx:24-93` packages thread, composer, runtime, timeline, effects, and interaction hooks for an embedded thread surface.
- `apps/web/src/components/chat/view/chat-view/ChatViewComposer.tsx:46-57` already supports a `compact` presentation and retains provider/model, runtime, approval, microphone, and send controls.
- `apps/web/src/components/sidebar/SidebarProjectItem.tsx:30-49` contains the reusable SVG bigbud `b`, but the asset is coupled to a sidebar-specific module.
- Compact presentation currently still initializes broad chat behavior such as provider discovery, skills, agents, keybindings, Git queries, and attachment logic. A mascot-specific capability profile does not yet exist.

### Sidecar persistence semantics

- `apps/web/src/components/chat/side-chat/sideChat.actions.ts:101-146` creates a `side-chat` thread under the active thread's project and copies its execution targets, model selection, and runtime mode.
- `apps/web/src/components/chat/side-chat/sideChat.actions.ts:174-193` deletes that thread when Sidecar is closed.
- `apps/web/src/logic/thread/threadVisibility.logic.ts:5-10` treats `side-chat` threads as invisible.
- `apps/web/src/stores/main/events.store.projects.ts:261-297` excludes `side-chat` threads from sidebar membership and prepends visible Chats threads to `sidebarRecentThreadIds`.
- Mascot threads therefore must reuse compact presentation but not Sidecar thread purpose, store, recovery, close, or attachment behavior.

### Chats and Recent

- `packages/contracts/src/constants/project.constant.ts` defines the built-in Chats project as `__chats__`.
- `apps/server/src/orchestration/Layers/ProjectionCatalogQuery.sidebar.ts:24-45` builds Recent membership from non-deleted, non-archived Chats threads ordered by latest user-message activity and creation time.
- `apps/server/src/orchestration/Layers/ProjectionCatalogQuery.sidebar.ts:118-140` returns Recent IDs and normalized thread summaries.
- A normal thread created in the Chats project already participates in Recent without a new sidebar concept.

### Model selection

- `apps/web/src/models/recentlyUsedModels.ts:7-12` stores recent model use in renderer local storage.
- `apps/web/src/models/recentlyUsedModels.ts:107-129` records use after a turn-start command is accepted by the renderer's RPC call.
- `apps/web/src/stores/composer/actions.model.store.ts:93-150` maintains a persisted sticky model map and applies it to new local drafts.
- `apps/web/src/stores/composer/persistence.store.ts:153-159` persists sticky model state in the same composer storage document as drafts.
- `apps/web/src/components/chat/view/chat-view/chat-view-provider-switch.hooks.ts:139-178` persists explicit picker changes as sticky selection.
- These values are renderer-owned. Their custom local-storage event does not provide a canonical multi-window source and the persisted Zustand store does not safely merge concurrent document writes.
- `thread.turn-start-requested` already carries the effective `ModelSelection` when the client supplies one, making it an appropriate durable event from which to project canonical recent-model state.

### Renderer bootstrap and duplicate effects

- `apps/web/src/routes/__root.tsx:91-125` mounts server synchronization, orchestration event routing, WebSocket recovery, startup coordination, plugin/provider recovery, pending-approval coordination, task-completion notifications, the command palette, sidebar layout, permission dialogs, and computer-use repair in one root.
- `apps/web/src/routes/-__root.logic.tsx:67-103` performs main-route bootstrap navigation and can create a fresh Chats draft when the route is `/`.
- A mascot renderer needs domain-event synchronization and bounded recovery, but must not mount the main layout, global navigation, global approval coordinator, system task notifications, file-access prompt, or computer-use startup repair.

### Runtime safety

- `packages/contracts/src/constants/runtime.constant.ts:1-16` defines `full-access` as command/file execution without approval and makes it the current default for new threads.
- The mascot is presented as quick chat and may be invoked over unrelated applications. It must not silently imply a less capable assistant while actually inheriting unrestricted agent execution.

## Architecture Decisions

### 1. Use one native mascot window with two presentations

Use a single `BrowserWindow` per desktop session and resize/reposition it between collapsed and expanded bounds. Do not use separate logo and chat windows. One window avoids z-order races, duplicated renderer state, handoff flicker, and focus ambiguity.

- Collapsed target: 64×64 device-independent pixels, with a 48×48 interactive logo and an 8-pixel draggable ring.
- Expanded target: 420×560 device-independent pixels, clamped to the selected display's work area. Final dimensions remain theme/design constants, not scattered literals.
- The expanded window grows inward from the nearest horizontal and vertical work-area edges, then clamps fully on-screen.
- The collapsed anchor is retained independently of expanded top-left bounds so collapse returns to the user's chosen mascot position.
- Closing the expanded surface collapses it. It does not destroy the window, delete the thread, stop the turn, or quit the app.

### 2. Use explicit native window roles

Define `DesktopWindowRole = "main" | "mascot"` in contracts. Register every trusted `webContents.id` with its role in the desktop main process and expose a read-only role query through preload. Do not infer security policy only from a URL query parameter.

Role-aware code must:

- authorize trusted startup and mascot IPC;
- target the IPC sender's `BrowserWindow` rather than the focused window;
- decide which renderer coordinators and layouts mount;
- make second-instance and Dock/app activation open the main window explicitly;
- route renderer-crash recovery by role.

### 3. Keep native state and conversation state separate

Persist native geometry under Electron `userData` in a versioned desktop-window-state document. Store only finite, validated device-local values and write atomically with a short move-event debounce.

Persist mascot conversation identity and draft state in a mascot-specific renderer storage namespace. Do not put window position in server settings and do not let the mascot renderer write the main composer-storage document.

### 4. Materialize only sent conversations

Opening the mascot creates or restores a local standalone Chats draft. The draft is materialized through the existing first-turn bootstrap path only when the first message is sent. This prevents empty mascot clicks from filling Recent with unused threads.

The materialized thread must have:

- project: `BUILT_IN_CHATS_PROJECT_ID`;
- purpose: `standard` or omitted when the contract defaults to `standard`;
- branch and worktree: `null`;
- interaction mode: `default` initially;
- provider/workspace execution targets resolved through the built-in Chats project using existing helpers;
- model selection from the canonical recent-model query with deterministic fallback;
- runtime mode: `approval-required` initially, with the existing compact control available for an explicit user change.

### 5. Project canonical last-used model selection on the server

Add a singleton projection representing the model selection from the latest accepted `thread.turn-start-requested` event. This matches current renderer semantics: `recordModelUsage` runs after the command is accepted, not after a completed assistant response.

The projection record should include:

- complete `ModelSelection`, including provider-specific options and `subProviderID` where applicable;
- `usedAt` from the event;
- source thread and message IDs for diagnostics only;
- source sequence for monotonic replay protection.

Expose a read-only RPC that returns the record or `null`. Query it only when creating a new mascot draft; do not mutate an already-started thread when newer use occurs elsewhere.

If an older event lacks `modelSelection`, resolve the effective selection from the thread projection at that sequence when possible. If it cannot be proven, leave the canonical row unchanged rather than fabricate a model.

### 6. Use deterministic model fallback

When the canonical model is selectable and its provider is ready, use it exactly. Otherwise:

1. try a current selectable model from the same provider when provider metadata supports a safe normalization;
2. try the built-in Chats project's default model selection;
3. use `getDefaultModelSelection` over ready server providers;
4. block send with an actionable provider-unavailable state when no provider is ready.

Show a short inline notice whenever fallback changes provider or model. Never overwrite the canonical record merely because a provider is temporarily unavailable.

### 7. Keep mascot and main drafts isolated

Select the composer persistence key from the trusted window role before creating the Zustand persist middleware:

- main keeps its existing composer storage and migrations;
- mascot uses a new versioned mascot composer-storage key;
- no renderer rewrites the other role's full persisted draft document;
- sent messages, thread state, approvals, and provider lifecycle remain server-authoritative and converge through domain events.

Opening the same materialized thread in both windows may show different unsent drafts. This is preferable to silent overwrites. “Open in bigbud” collapses the mascot and keeps any mascot-only unsent text intact; it must state that the unsent draft remains in the floating assistant rather than pretending it transferred.

### 8. Split shared event synchronization from main-only effects

Create a common renderer shell containing only:

- server-state synchronization;
- ordered orchestration event ingestion and bounded recovery;
- WebSocket connection/reconnect handling;
- minimal theme and compact toast infrastructure.

The main shell retains navigation, command palette, sidebar, global approval coordination, task-completion notifications, permission prompts, plugin/provider recovery, and computer-use repair. The mascot shell mounts only the compact conversation and mascot-specific activity/error UI.

### 9. Preserve least privilege in the mascot renderer

Use a focused mascot preload or role-gated bridge surface. The mascot must not enable `webviewTag` or renderer plugins. Expose only the native functions required for backend connection, trusted role discovery, backend startup state, file-path resolution when attachments are supported, external-link opening, context menus, and mascot window actions.

Configure shared session permissions independently of main-window creation. Continue allowing only microphone media requests required by the existing composer and deny unrelated permission classes.

### 10. Ship opt-in first

Add `floatingAssistantEnabled` to client settings with a decoding default of `false`. Enabling it creates and shows the mascot immediately and restores it on later desktop launches. Disabling it from Settings destroys the mascot only while the main window is available. The mascot context menu's disable action first opens the main window, then disables/destroys the mascot, so Windows and Linux users are never left with an invisible running process and no recovery surface.

## User-Visible Behavior

### Collapsed

- Display the existing bigbud `b` in a compact circular surface.
- A click expands the chat and focuses the composer.
- The outer ring is a native drag region with a grab cursor; the inner logo button is `no-drag` and remains clickable.
- While a turn is active, show a reduced-motion-aware activity treatment.
- When a response completes while collapsed, show a bounded unread indicator. Do not add a second system notification in the mascot renderer.
- Right-click opens native actions: Open bigbud, New chat, Disable floating assistant, and Quit bigbud.

### Expanded

- Show a draggable header with the bigbud logo, current model label, New chat, Open in bigbud, Collapse, and a more-actions menu.
- Reuse the Sidecar-scale timeline and compact composer rather than the full chat chrome.
- Support streaming, queued prompts, pending approvals, pending user input, provider/model selection, runtime-mode visibility, microphone input, copy, Markdown, images already supported by the compact timeline, and reconnect/error states.
- Hide workspace-only controls that cannot work in the Chats project, including Git/worktree actions, terminal controls, diff navigation, Sidecar attachment, and orchestra entry points.
- `Escape` closes a transient menu/dialog first; otherwise it collapses the mascot without clearing the draft.

### Conversation lifecycle

- Collapse and application focus changes preserve the current draft and thread.
- New chat creates a fresh standalone draft. If the current draft has unsent content, require explicit discard confirmation before replacing it.
- Once the current conversation has sent content, New chat retains that thread in Recent and creates a new local draft.
- Open in bigbud materializes no empty draft. It is available for a server-backed thread and opens/focuses the main window at `/$threadId`.
- If the current mascot thread is archived, deleted, or purged elsewhere, show a concise status and create a new draft only after user confirmation or the next New chat action.
- If the provider turn continues after collapse, main-window closure, renderer reload, or transient WebSocket loss, recover from the server instead of starting a duplicate turn.

## Phases

### Phase 0: Validate Native Window Behavior With A Bounded Spike

**Goal:** Prove the chosen collapsed/expanded window model on supported desktop environments before building thread behavior on top of it.

**Scope:**

- Build a development-only spike behind an environment flag using a frameless, transparent, non-resizable, always-on-top window.
- Validate `acceptFirstMouse` on macOS so one click opens the chat rather than only activating bigbud.
- Validate `setAlwaysOnTop(true, "floating")` and `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` behavior on macOS. Call the workspace API only when the desired value changes to avoid process-type/Dock flicker.
- Validate Windows behavior over normal, maximized, and fullscreen applications, explicitly excluding secure desktop and UAC.
- Validate Linux behavior under at least one X11 window manager and one Wayland compositor. Record any compositor that prevents programmatic positioning or all-workspace behavior.
- Validate the 8-pixel drag ring and inner clickable button. Do not proceed with a full-window CSS drag region that makes the logo require two clicks or prevents click handling.
- Validate transparent hit areas and rounded-corner behavior. Keep collapsed native bounds tight rather than attempting per-pixel click-through.
- Measure idle renderer memory and expand/collapse latency with the main window open and closed.

**Likely files:**

- `apps/desktop/src/window/mascotWindow.spike.ts` or a temporary focused equivalent
- Focused desktop tests for option resolution and bounds math

**Exit criteria:**

- One-click expand and native drag are usable on macOS, Windows, X11, and the supported Wayland target.
- The mascot remains reachable and does not reserve a large invisible mouse-hit rectangle.
- Any platform degradation is documented with a product-approved fallback before production implementation.

### Phase 1: Add Window Roles, Contracts, And Native State Foundations

**Goal:** Make the desktop main process safely own more than one native window.

**Dependencies:** Phase 0 confirms the viable window flags and drag treatment.

**Scope:**

- Add `DesktopWindowRole`, mascot window-state types, and narrow mascot IPC request/response contracts under direct `@bigbud/contracts/server/...` subpaths.
- Add a main-process window registry keyed by `webContents.id` and clean it on destruction.
- Refactor generic window lookup helpers to resolve the sender's `BrowserWindow` and role.
- Generalize backend-startup-state authorization from “main renderer only” to trusted local window roles.
- Add a shared default-session permission configurator that is idempotent and independent of window creation order.
- Add versioned `MascotWindowState` persistence under `app.getPath("userData")` with:
  - collapsed anchor point;
  - last display ID when available;
  - schema version;
  - atomic replacement;
  - finite-number validation;
  - debounced writes;
  - safe fallback when the file is missing, corrupt, locked, or from a newer version.
- Add pure bounds helpers that choose a display, grow inward, clamp to `workArea`, and recover from display removal or scale changes.
- Extract main-window lifecycle orchestration from `main.ts` before adding mascot ownership so non-test source files remain within repository size limits.

**Likely files:**

- `packages/contracts/src/server/ipc.desktop.ts`
- `packages/contracts/src/server/ipc.ts`
- `apps/desktop/src/main.channels.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/main.runtime.ts`
- `apps/desktop/src/window/windowRegistry.ts`
- `apps/desktop/src/window/mascotWindowState.ts`
- `apps/desktop/src/window/mascotWindowBounds.ts`
- `apps/desktop/src/window/sessionPermissions.ts`
- Corresponding focused tests

**Failure behavior:**

- Corrupt or off-screen state falls back to a safe inset on the primary display without deleting unrelated desktop state.
- A failed position write logs a bounded diagnostic and keeps the in-memory position; it does not crash the app or retry in a tight loop.
- An IPC call from an unregistered or wrong-role renderer is rejected without changing any window.

**Exit criteria:**

- Main-window behavior is unchanged.
- Trusted roles are explicit and tested.
- Bounds restoration is deterministic across missing displays and scale changes.
- IPC actions always affect the calling/target role rather than the arbitrarily focused window.

### Phase 2: Implement The Production Mascot Window Manager

**Goal:** Create a reliable collapsed/expanded native window without chat behavior yet.

**Dependencies:** Phase 1 role and state foundations.

**Scope:**

- Add `MascotWindowManager` with idempotent `ensure`, `showCollapsed`, `expand`, `collapse`, `openMainWindow`, `disable`, and `destroyForQuit` operations.
- Use a single-flight creation promise so concurrent settings, app-activation, and renderer-recovery paths cannot create duplicate mascot windows.
- Use production options proven in Phase 0:
  - `frame: false`;
  - `transparent: true`;
  - `alwaysOnTop: true` plus explicit level where supported;
  - `skipTaskbar: true`;
  - `resizable: false`;
  - `fullscreenable: false`;
  - `maximizable: false` and `minimizable: false` where implemented;
  - `acceptFirstMouse: true` on macOS;
  - `webviewTag: false`, `plugins: false`, sandbox and context isolation retained.
- Load a dedicated mascot route and keep the window hidden until its renderer reports ready.
- Use `showInactive()` for passive collapsed restoration and `show()`/`focus()` only after user expansion.
- Resize/reposition atomically enough to avoid visible jumps; preserve the collapsed anchor separately.
- Observe display added/removed/metrics-changed events and re-clamp only when necessary.
- Update application activation:
  - a second instance opens/restores the main window;
  - macOS app activation opens/restores the main window even if mascot exists;
  - main-window closure leaves mascot and backend running;
  - explicit Quit closes both windows and the backend through the existing teardown path.
- On mascot renderer crash, reload once for an isolated crash, then open the main window and surface a diagnostic after a bounded repeated-crash threshold. Never enter an unbounded recreate loop.
- Ensure updater state broadcasts and quit-for-update cover both windows.

**Likely files:**

- `apps/desktop/src/window/mascotWindowManager.ts`
- `apps/desktop/src/window/mascotWindowManager.test.ts`
- `apps/desktop/src/window/mascotWindowBounds.ts`
- `apps/desktop/src/window/ipcHandlers.mascot.ts`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/main.runtime.ts`
- `apps/desktop/src/preload.mascot.ts`
- `apps/desktop/tsdown.config.ts` or current bundle configuration if another preload entry is required

**Exit criteria:**

- Enabling creates exactly one mascot window.
- Expand/collapse and multi-display restoration work without a renderer chat implementation.
- Closing the main window does not stop the backend while mascot is enabled.
- Second-instance, Dock activation, Quit, and update behavior target the correct windows.

### Phase 3: Split Renderer Shells And Isolate Persistence

**Goal:** Let the mascot renderer connect and recover without mounting the main application shell or writing main-window drafts.

**Dependencies:** Phase 1 role query and Phase 2 route loading.

**Scope:**

- Resolve trusted window role before constructing role-sensitive persisted stores.
- Split `RootRouteView` into common connection/event infrastructure plus lazy main and mascot shells.
- Extract data-only orchestration event synchronization from main-route navigation and main-only notifications/toasts.
- Add a dedicated mascot route that never renders `AppSidebarLayout`, `CommandPalette`, settings routes, right-panel hosts, global permission dialogs, or main-only repair coordinators.
- Keep bounded bootstrap targeted at the mascot's current server thread when one exists. Do not load every project or hydrate unrelated thread histories merely to show the mascot.
- Add a mascot-specific composer storage key and migration boundary. Main storage keys and existing draft migrations remain unchanged.
- Add a small `floatingAssistant` store containing presentation state, current local/server thread ID, unread state, and versioned recovery metadata. Do not persist response content outside the canonical thread projection.
- Handle invalid stored IDs:
  - server thread exists and is active: hydrate it;
  - thread is archived/deleting/deleted: show status and offer New chat;
  - local draft exists: restore it;
  - neither exists: create a fresh local mascot draft.
- Add compact connection states for backend starting, reconnecting, exhausted reconnect, and retry. Do not reuse a full-screen main splash inside the 64-pixel mascot.

**Likely files:**

- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/-__root.logic.tsx`
- `apps/web/src/routes/_mascot.tsx` or the route name selected during implementation
- `apps/web/src/components/mascot/MascotAppShell.tsx`
- `apps/web/src/components/mascot/MascotConnectionState.tsx`
- `apps/web/src/stores/composer/composer.store.ts`
- `apps/web/src/stores/mascot/mascot.store.ts`
- `apps/web/src/rpc/nativeApi.ts`
- Focused root, recovery, and persistence tests

**Failure behavior:**

- A mascot WebSocket reconnect never creates a new thread or resends a prompt by inference.
- A malformed mascot store resets only mascot-local state.
- Failure to resolve a trusted window role blocks mascot-specific persistence rather than falling back to the main storage key.

**Exit criteria:**

- Main and mascot renderers can run concurrently with separate composer storage documents.
- Only one set of global coordinators is mounted.
- The mascot can recover a selected thread through a server restart without duplicate commands.

### Phase 4: Project And Query Canonical Recent Model Selection

**Goal:** Give every new mascot conversation a reliable server-authoritative starting model.

**Dependencies:** None on native window work; this phase can be developed in parallel after the contract is agreed.

**Scope:**

- Add the next available SQLite migration for a singleton recent-model projection table. Follow the required migration registration in `Migrations.ts` and `migrationEntries`.
- Add the table to projection baseline capture/restore requirements so restart and baseline recovery preserve or deterministically rebuild it.
- Add a focused projection repository with direct source imports and no barrel.
- Add a projector for accepted `thread.turn-start-requested` events with source-sequence monotonicity.
- Store complete JSON-encoded `ModelSelection` using the existing schema decoder and canonicalization helpers.
- Preserve the last record when a source thread is later archived, deleted, purged, or removed by retention.
- Add a read-only orchestration/server RPC returning `{ modelSelection, usedAt } | null`.
- Implement renderer fallback as a pure, tested function against current provider statuses and Chats project defaults.
- Keep existing recently-used lists for picker ordering unless a separate cleanup is approved. This phase changes the mascot's authoritative initial selection, not every picker UX.

**Likely files:**

- `apps/server/src/persistence/Migrations/<next>_ProjectionRecentModelSelection.ts`
- `apps/server/src/persistence/Migrations/Migrations.ts`
- `apps/server/src/persistence/ProjectionBaselineSchema.ts`
- `apps/server/src/persistence/Services/ProjectionRecentModelSelection.ts`
- `apps/server/src/persistence/Layers/ProjectionRecentModelSelection.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.projector.recentModelSelection.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.projectors.ts`
- `packages/contracts/src/server/rpc.core.ts` or a focused direct subpath
- `apps/server/src/ws/wsRpcHandlers.orchestrationServer.ts`
- `apps/web/src/models/provider/mascotModelSelection.ts`
- Migration, projection replay, baseline, RPC, and fallback tests

**Failure behavior:**

- Projection decode failure reports a bounded persistence error and returns `null`; it never sends fabricated model data.
- A missing or unavailable model follows the explicit fallback chain and surfaces the fallback to the user.
- Temporary provider unavailability does not erase the canonical record.

**Exit criteria:**

- Turns from every provider update one canonical model selection in event sequence order.
- Restart, replay, and baseline restore return the same record.
- A new mascot draft selects the expected model or a tested fallback without mutating an existing thread.

### Phase 5: Extract The Compact Conversation And Add Mascot Thread Lifecycle

**Goal:** Deliver the actual quick-chat experience while preserving normal thread semantics.

**Dependencies:** Phases 3 and 4.

**Scope:**

- Move `BigbudLogo` from the sidebar-specific module to a shared branding component and retain the existing sidebar import through the direct new path.
- Extract a reusable `CompactThreadConversation` from `FloatingSideChat` containing timeline, autoscroll, working state, and compact composer.
- Keep Sidecar-specific header actions, attach-as-context behavior, main-composer measurement, resize handle, store, and deletion lifecycle in Sidecar modules.
- Add a compact capability profile to `ThreadComposerSurface` and derived hooks so mascot and Sidecar can explicitly disable workspace-only queries and actions without forking the entire chat stack.
- Add a standalone mascot draft creator that does not occupy the main store's one-draft-per-project mapping.
- Resolve the built-in Chats project and execution targets through existing project/catalog helpers.
- On first send, use the existing `thread.turn.start` bootstrap path to create a normal Chats thread and seed its title from the first prompt.
- Verify the `thread.created` event adds the thread to Recent and clears only the promoted mascot draft state.
- Add header and context actions:
  - New chat;
  - Open in bigbud;
  - Collapse;
  - Disable floating assistant;
  - Quit bigbud.
- Keep active responses running while collapsed and derive activity/unread state from canonical thread transitions.
- Show pending approvals and user-input requests inline. Do not mount a second global approval coordinator.
- Block or clearly explain unsupported workspace actions in the Chats project rather than invoking them with an invented working directory.

**Likely files:**

- `apps/web/src/components/branding/BigbudLogo.tsx`
- `apps/web/src/components/chat/compact/CompactThreadConversation.tsx`
- `apps/web/src/components/chat/side-chat/FloatingSideChat.tsx`
- `apps/web/src/components/chat/view/ThreadComposerSurface.tsx`
- `apps/web/src/components/mascot/MascotCollapsedButton.tsx`
- `apps/web/src/components/mascot/MascotChatWindow.tsx`
- `apps/web/src/components/mascot/mascotConversation.actions.ts`
- `apps/web/src/stores/mascot/mascot.store.ts`
- `apps/web/src/stores/composer/actions.draftThread.store.ts`
- Focused Sidecar regression, mascot lifecycle, and browser tests

**Failure behavior:**

- If bootstrap dispatch fails, restore the mascot prompt and attachments exactly once through the existing send failure path.
- If a turn-start outcome is uncertain after connection loss, recover by command/event identity; never create a replacement thread or resend automatically.
- If New chat is requested with unsent content, require explicit confirmation and do not silently clear it.
- If Open in bigbud fails, keep the mascot thread and draft unchanged and present a retryable inline error.

**Exit criteria:**

- A first mascot send creates one standard Chats thread and one user turn.
- That thread appears under Recent and opens normally in the main window.
- Collapse/reopen, main-window close, reconnect, and app restart preserve the conversation without duplicate sends.
- Existing Sidecar behavior and visibility remain unchanged.

### Phase 6: Add Settings, Accessibility, And Cross-Window UX Hardening

**Goal:** Make the feature controllable, understandable, and safe for daily use.

**Dependencies:** Phase 5 end-to-end behavior.

**Scope:**

- Add `floatingAssistantEnabled` to `ClientSettingsSchema`, defaults, restore behavior, and General settings UI. Hide or disable it with accurate copy outside Electron.
- Add searchable settings copy explaining that bigbud remains running when the main window closes and that Quit stops active local work.
- Enabling creates the mascot immediately; disabling from main Settings destroys it after persisting a valid state.
- Make the mascot's disable context action open the main window before disabling.
- Add keyboard and accessibility behavior:
  - accessible logo-button name and state;
  - visible focus indication;
  - semantic activity and unread labels;
  - reduced-motion alternatives;
  - `Escape` precedence for menus/dialogs before collapse;
  - focus composer on expansion and restore focus predictably on transient-dialog close;
  - minimum contrast in light, dark, solid, and translucent materials.
- Ensure main-window material changes target only the main window and mascot material is resolved independently.
- Add a bounded, non-content diagnostic event for create/show/collapse/recovery failures. Do not log prompts, responses, model credentials, attachment paths, or window titles derived from user content.
- Verify only the main renderer emits global system task-completion notifications. The mascot uses its inline unread/activity indicator.

**Likely files:**

- `packages/contracts/src/core/settings.ts`
- `packages/contracts/src/core/settings.test.ts`
- `apps/web/src/hooks/useSettings.ts`
- `apps/web/src/components/settings/GeneralSettingsSection.tsx`
- `apps/web/src/components/settings/SettingsSearch.logic.ts`
- Mascot UI and accessibility tests

**Exit criteria:**

- The opt-in setting survives restart and can never strand the user without a visible recovery path.
- Keyboard-only and screen-reader users can expand, chat, resolve approvals, collapse, open bigbud, disable, and quit.
- Multiple windows do not generate duplicate system notifications or target the wrong material/dialog owner.

### Phase 7: Packaged Platform Validation And Staged Rollout

**Goal:** Validate real window-manager behavior and ship conservatively.

**Dependencies:** All prior phases and repository validation are green.

**Scope:**

- Build signed/notarized or locally equivalent packaged artifacts for macOS arm64/x64, Windows x64, and Linux AppImage/deb targets used by the project.
- Execute the manual matrix in Testing And Validation.
- Keep `floatingAssistantEnabled` default-off for the initial release.
- Document known compositor/fullscreen limitations in user-facing help and release notes.
- Add a rollback path that hides the setting and prevents mascot creation without deleting Chats threads, drafts, or the canonical recent-model projection.
- After a stable release window, review crash reports, support feedback, idle memory, and platform behavior before considering default-on or launch-at-login behavior.

**Exit criteria:**

- No supported packaged target has an unrecoverable off-screen, focus, quit, update, or duplicate-window defect.
- Disabling rollout leaves all mascot-created threads available in Chats → Recent.
- Product owner approves documented platform limitations.

## Risks And Decision Gates

### Gate 1: Native window behavior by platform

Always-on-top and all-workspace behavior is window-manager policy, not an absolute guarantee. Phase 0 must prove an acceptable result on supported macOS, Windows, X11, and Wayland configurations. Do not claim that the mascot appears above secure OS surfaces or unsupported exclusive-fullscreen applications.

### Gate 2: Click-versus-drag interaction

Electron CSS drag regions suppress ordinary pointer interaction. The approved first-release design uses a draggable outer ring and clickable inner button. If design requires dragging from every visible mascot pixel, a separate native/manual drag investigation is required; do not ship a two-click activation regression.

### Gate 3: Runtime authority

The current global default is `full-access`. This plan deliberately starts new mascot drafts in `approval-required` and keeps runtime mode visible. Product/security approval is required before allowing mascot chats to default to or silently inherit `full-access`.

### Gate 4: Canonical “most recently used” definition

This plan defines it as the model selection on the highest-sequence accepted `thread.turn-start-requested` event. It includes provider, model, sub-provider, and options. It does not wait for a completed assistant response. This matches current renderer recording semantics and remains deterministic through crashes. Changing the definition to “last completed response” requires a different projection and must be decided before Phase 4 migration work.

### Gate 5: Projection and migration safety

The recent-model projection must participate in migrations, projector sequence state, baseline capture/restore, and replay. Do not implement it as an opportunistic local cache or update a settings file on every turn. A projection failure must never block unrelated thread execution after the command is durably accepted; surface and repair it through existing projection recovery behavior.

### Gate 6: Multi-renderer persistence

Main and mascot Zustand stores are separate JavaScript instances even when they share an origin. Writing one whole persisted composer document from both renderers risks last-writer-wins data loss. Role-specific composer persistence is mandatory before editable mascot UI ships.

### Gate 7: Duplicate global side effects

Mounting the current root unchanged in two renderers can duplicate notifications, approval prompts, settings migration, and recovery toasts. The mascot may not ship until common data synchronization is separated from main-only coordinators and tests prove coordinator cardinality.

### Gate 8: Provider availability and model locking

The canonical model may refer to a disabled provider, expired authentication, removed model, or stale authoritative catalog entry. Fallback must be deterministic and visible. Once a mascot thread starts, existing provider locking and branching semantics remain authoritative; never hot-swap its provider because another window used a newer model.

### Gate 9: Application recovery surface

Because the mascot is skipped from the taskbar, disable/hide behavior can strand Windows and Linux users if no main window exists. The first release must keep the mascot visible while enabled, clamp it on-screen, make second launch open the main window, and open main before disabling from the mascot. If packaged testing still reveals unrecoverable states, a tray icon becomes a prerequisite rather than optional follow-up work.

### Gate 10: Resource use

A second renderer has non-trivial memory cost. Do not keep the main renderer hidden after close. Use lazy mascot/main shells and a compact capability profile. If idle mascot memory remains materially high after those changes, capture measurements and consider a smaller dedicated entry bundle before rollout.

## Testing And Validation

### Contract and schema tests

- Decode valid and invalid `DesktopWindowRole`, mascot IPC inputs, and mascot window-state payloads.
- Preserve backward decoding for client settings without `floatingAssistantEnabled`.
- Verify default-off settings and rejection of malformed native bounds.
- Decode complete model selections for every provider, including provider-specific options and sub-provider IDs.

### Desktop unit tests

- Mascot window options are frameless, sandboxed, transparent, non-resizable, skip-taskbar, and do not enable plugins or `webviewTag`.
- Concurrent `ensureMascotWindow` calls create one window.
- Expand/collapse preserves the collapsed anchor and grows inward near every display edge.
- Bounds clamp correctly after display removal, work-area shrink, negative-coordinate displays, and scale changes.
- Corrupt/newer-version window state falls back safely.
- Position writes are debounced and atomic; write failures do not crash or retry continuously.
- IPC rejects unknown roles and targets the sender/explicit role rather than the focused window.
- Second-instance and macOS activation open the main window while a mascot exists.
- Main close leaves the backend running; explicit quit closes both windows once.
- Renderer-crash recovery is bounded.

### Server migration and projection tests

- Register the migration and verify forward migration on an existing database.
- Project successive turn-start events from different providers and retain the highest sequence.
- Preserve complete model options.
- Ignore legacy events whose effective model cannot be proven.
- Rebuild the same row through replay.
- Capture and restore the row through projection baselines.
- Preserve the row after source-thread archive, deletion, purge, and retention.
- Return `null` on an empty installation and a decoded value when populated.
- Verify projection failure behavior does not fabricate a fallback value.

### Web unit and browser tests

- Trusted role selects the correct shell and composer persistence key.
- Mascot shell does not mount sidebar, command palette, global approval coordinator, task-completion notifications, file-access prompt, or computer-use repair.
- Main shell behavior remains unchanged.
- New mascot drafts use canonical recent model selection or each fallback branch.
- A fallback notice is visible and accessible.
- First send creates one standard Chats thread and Recent membership.
- Merely expanding/collapsing creates no server thread.
- Collapse preserves unsent prompt and active response state.
- New chat confirms before discarding unsent content.
- Open in bigbud targets the current server thread and does not claim to transfer a mascot-only draft.
- Archived/deleted current-thread recovery is explicit.
- Pending approvals and user input remain usable in compact mode.
- Sidecar remains hidden, attachable, minimizable, and destructively closable exactly as before.
- Mascot and main composer persistence writes cannot overwrite the other role's document.
- Only one global system-notification coordinator is mounted.

### Server and renderer integration tests

- Close the main window during a mascot turn, complete the response, and recover it in the mascot.
- Restart/reconnect during prompt dispatch and prove no duplicate thread or turn is created.
- Open the mascot thread from Recent in the main window while the mascot is collapsed.
- Send from mascot, create a main-window turn with another provider, then verify only the next mascot chat adopts the newer canonical model.
- Disable or unauthenticate the canonical provider and verify visible fallback without canonical-record mutation.
- Run two renderer connections through event replay and verify both converge on the same thread state.

### Manual packaged matrix

For macOS arm64/x64, Windows x64, Linux X11, and the supported Wayland compositor:

- enable, disable, quit, relaunch, second launch, and application/Dock activation;
- drag across primary/secondary displays, including negative coordinates and mixed scaling;
- unplug the active display and change resolution/scaling;
- expand near all four screen corners and taskbar/Dock/menu-bar edges;
- normal, maximized, native fullscreen, virtual desktops/Spaces, Mission Control/task switcher;
- one-click expansion from an inactive app;
- keyboard navigation, screen reader, reduced motion, light/dark/high-contrast themes;
- microphone permission and recording from the mascot;
- main close during idle, streaming, queued prompt, approval, pending user input, and reconnect;
- renderer crash and backend restart;
- update download/install with both windows present;
- sleep/wake and user session lock/unlock;
- provider unavailable, authentication expired, and authoritative model removed;
- CPU and memory while collapsed idle, expanded idle, and streaming.

Record explicit limitations rather than treating unsupported secure surfaces as failures.

### Required repository commands

Run focused tests while implementing, then run all required gates from repository root:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Never use `bun test`; it bypasses the repository's Vitest/Turbo path.

Before packaged validation, also build the relevant desktop artifacts through the repository's existing `dist:desktop:*` commands and run the desktop smoke test where applicable.

## Acceptance Criteria

- A user can enable the floating assistant in desktop Settings and see exactly one collapsed bigbud `b` mascot.
- The mascot can be moved and restored to a valid visible position after restart, display removal, and scaling changes.
- One click expands a Sidecar-scale chat and focuses the composer; collapse returns to the stored mascot anchor.
- The main bigbud window can be closed while the mascot and backend continue running.
- Expanding/collapsing without sending does not create an empty Recent thread.
- The first sent mascot prompt creates exactly one `standard` thread in the built-in Chats project.
- The created thread appears in Chats → Recent and opens normally in the main window.
- Collapse, main-window closure, reconnect, renderer reload, and app restart do not interrupt or duplicate a server-owned turn.
- New mascot conversations use the canonical most recently accepted model selection, including provider options, or a deterministic visible fallback.
- An existing mascot thread never changes model merely because another thread later uses a different model.
- Mascot drafts and main-window drafts cannot overwrite each other's persisted documents.
- Main-only global coordinators mount once; the mascot does not create duplicate system notifications or global approval prompts.
- Pending approvals and pending user input can be resolved from the compact surface.
- New mascot threads default to `approval-required`; changing to broader authority requires explicit user action.
- Second application launch and macOS app activation open the main window even while mascot exists.
- Disabling from the mascot opens the main window before removing the only skip-taskbar recovery surface.
- Explicit Quit stops both windows, provider/backend processes, update timers, and computer-use daemon through existing teardown.
- Existing Sidecar visibility, attach-as-context, minimize, recovery, and delete semantics remain unchanged.
- The mascot renderer retains sandboxing and context isolation and does not enable plugins or `webviewTag`.
- All focused tests and `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass.
- Packaged macOS, Windows, X11, and supported Wayland checks are recorded with approved limitations.

## Open Questions

- What final product-facing name should appear in Settings and menus: “Floating assistant”, “bigbud mascot”, or another approved label? This plan uses “Floating assistant” for controls and “mascot” internally.
- Should the initial expanded size remain fixed at 420×560, or should users be allowed to resize within bounded minimum/maximum dimensions after the first release?
- Should a collapsed completed response use only the unread/activity badge, or should it optionally produce one system notification when the main window is closed? The proposed first release uses the badge only to avoid cross-renderer notification ownership work.
- Is the current existing `b` color treatment sufficient across all themes, or does design require a dedicated circular background asset? A fully animated character remains out of scope.
- Which Wayland compositor(s) are part of the supported release matrix? The answer determines whether a platform-specific positioning limitation blocks rollout or is documented as unsupported.
