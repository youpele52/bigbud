# Remote thread reconnect: gate, auto-reconnect, and shared Reconnect/Disconnect actions

Date: 2026-11-21
Status: Ready for implementation (decisions recorded in section 10)
Scope: `apps/web`, `apps/server`, optional additive schema in `packages/contracts`

## 1. Problem statement

Observed (macOS desktop, SSH workspace `ice-2-kg`, password auth, connection dropped):

- Opening a thread of that workspace opens the thread and shows two red cards:
  - "Thread failed — SSH password is required for ice-2-kg. Re-enter it before using this target."
  - "Could not reconnect — This thread's provider session cannot be resumed. Continue in a new
    thread to keep working." with a "Continue in a new thread" button.
- There is no way to enter the password from there.
- The sidebar thread menu has no Reconnect/Disconnect (the remote workspace menu does).
- The composer project/thread picker submenu for a remote workspace has no Reconnect/Disconnect.

Expected:

1. A thread of a remote workspace whose connection is known dead is not opened directly. bigbud
   reconnects first: silently when no user input is needed (key/agent auth, remote agent
   transport), or by asking for what the auth needs (SSH password, key passphrase, host trust).
   The thread opens once connected. Cancel goes back.
2. "Could not reconnect … cannot be resumed" never appears just because the SSH transport was down.
3. Sidebar thread menu (remote workspace threads): the same Reconnect and Disconnect (or Connect)
   actions as the workspace menu, placed directly above Delete, with the same handlers.
4. Composer picker: the remote workspace submenu shows the same Reconnect and Disconnect (or
   Connect) after its thread list.
5. Added requirement: auto-reconnect only on explicit user navigation, never because the sidebar
   rendered or in the background. Concurrent clicks on several threads of one workspace share one
   reconnect attempt. If auto-reconnect fails, the gate shows the error with Reconnect / Cancel.

## 2. Root cause findings (with evidence)

### 2.1 Why the red cards appear: the sequence

The two cards come from a failed turn start (the "hi" message has no reply). The "Work log (4)" is
the recovery activities. They are derived from persisted server activities, so they show again on
every visit and survive reloads.

1. **The renderer keeps a stale "verified" flag.** `verifiedExecutionTargetIds` is set on a
   successful check (`apps/web/src/hooks/useRemoteExecutionAccessGate.checks.ts:193-195`). It is
   only cleared by Disconnect/Connect
   (`apps/web/src/hooks/useRemoteExecutionAccessGate.connection.ts:52,81`), the remote-agent
   settings page (`apps/web/src/components/settings/RemoteAgentManagementSection.actions.ts:137`),
   or the resource-monitor discovery loop
   (`apps/web/src/stores/resource-monitor/remoteMonitor.connections.store.ts:39-41`). That loop
   only runs while the monitor is visible
   (`apps/web/src/components/resource-monitor/useConnectedSshMonitorProjects.ts:8`). Nothing
   clears it when the SSH connection drops.
2. **Password sessions expire on their own.** The SSH ControlMaster for password targets is
   started with `ControlPersist=600` (`apps/server/src/ssh/sshSession.ts:265`). After 10 minutes
   with no SSH clients it exits. The password is never saved (it only goes through
   `BIGBUD_SSH_PASSWORD` for the unlock call, `sshSession.ts:~281`). So a dropped or idle-expired
   password session always needs the password again.
3. **Navigation skips the check for "verified" targets.** Sidebar thread click runs
   `beginRemoteExecutionTargetAccessCheck`
   (`apps/web/src/components/sidebar/Sidebar.remoteThreadActivation.ts:105-128`). It returns at
   once when the target is verified, user-disconnected, or the disconnect list has not loaded
   (`apps/web/src/hooks/useRemoteExecutionAccessGate.ts:118-127`). The composer picker calls
   `navigate` with no check at all
   (`apps/web/src/components/git/BranchToolbarProjectMenu.tsx:76-81`). About 30 other call sites
   also navigate to `/$threadId` directly (search palette, command palette, notifications,
   keybindings, fork links, and more).
4. **Send skips the check for "verified" targets too.** `ensureRemoteExecutionTargetAccess`
   returns `true` when verified (`useRemoteExecutionAccessGate.ts:217-223`), so the turn goes to
   the server.
5. **The server throws a plain `Error`.** Provider session start reaches the SSH layer, where
   `assertSshPasswordExecutionTargetReady[Async]` throws
   `new Error(formatSshPasswordRequiredMessage(...))` (`apps/server/src/ssh/sshSession.ts:158-199`,
   also `:214` for transport args). The key-passphrase path does the same with
   `formatSshKeyLoadMessage` (`apps/server/src/ssh/sshVerification.ts:96-101,117-122`).
6. **The adapter wraps it as a process error with no class.** For example, Codex wraps every
   start-up failure in `ProviderAdapterProcessError` and sets no `failureClass`
   (`apps/server/src/provider/Layers/Codex/Adapter.session.remoteWorkspace.ts:25-31`,
   `Adapter.session.ts:105-110`). Other adapters do the same (Claude, OpenCode, Copilot, Pi,
   Cursor, Devin: `grep "new ProviderAdapterProcessError"`).
7. **It is classified as `session-dead`.** `classifyError` finds no explicit class. The password
   text matches none of the text rules (`AUTH_OR_QUOTA_DETAIL` does not cover "SSH password is
   required"). The typed check `isTypedSessionDead` (any `ProviderAdapterProcessError`) then
   returns `session-dead`
   (`apps/server/src/orchestration/Layers/ProviderTurnFailureClassification.ts:39-43,92-106`).
8. **Recovery runs and fails the same way.** The error was raised before dispatch, so it counts as
   resendable (`ProviderCommandReactorSessionOps.recovery.dispatch.ts:30-35`).
   `recoverDeadSession` stops the session, then runs "revive" (when there is a resume cursor) and
   "fresh-replay". Both fail with the same SSH error, and each step writes started/failed
   activities (`ProviderCommandReactorSessionOps.recovery.turnStart.ts:137-181`). That is the
   "Work log (4)".
9. **Recording the failure triggers the "Thread failed" banner and an automatic fork.**
   `makeHandleTurnStartFailure` records `thread.turn.start.failed` with `session-dead`
   (`ProviderCommandReactorHandlers.turnStart.ts:136-152`). The detail becomes the thread error,
   which `ThreadErrorBanner` shows as **"Thread failed"**
   (`apps/web/src/components/chat/view/chat-view/ChatViewChatBody.tsx:162-166`,
   `apps/web/src/components/chat/common/ThreadErrorBanner.tsx:23`). Because the class is
   `session-dead`, it also calls `requestAutomaticFork`
   (`ProviderCommandReactorHandlers.turnStart.ts:154-166`). That dispatches a server-side
   `thread.fork` (`ProviderCommandReactorHandlers.fork.ts:91-100`), whose first turn would hit the
   same dead target. (The screenshot still offers "Continue in a new thread", so in this case the
   fork was not created or was skipped. Server logs can confirm that. The code path exists either
   way.)
10. **The client reads `session-dead` as "fork only".** `deriveServerTurnFailure` reads
    `failureClass: "session-dead"`. `isForkOnlyFailureClass` is true, so the notice becomes
    **"Could not reconnect — This thread's provider session cannot be resumed…"**
    (`apps/web/src/components/chat/view/ThreadRecoveryNotice.failure.ts:7-24`,
    `ThreadRecoveryNotice.logic.ts:81-101`).

**Conclusion:** the second card is a direct result of the dead SSH transport being misclassified
as a dead provider session. The provider session itself was never at fault: the same thread works
again once SSH is re-authenticated. Fixing the classification removes the second card, the
pointless revive/fresh-replay attempts, and the automatic fork.

### 2.2 Why there is no password entry in the thread

- The only in-thread credential action is "Unlock SSH key" on a work-log entry, and it only
  matches key-passphrase text
  (`apps/web/src/components/chat/messages/MessagesTimeline.workEntry.actions.tsx:24-30,79-93`).
  Nothing in the thread view matches password text or host trust.
- The general auth dialog (password, passphrase, host trust) exists. It is driven by
  `useRemoteAccessStore.openAuthDialog` and rendered only inside the sidebar
  (`apps/web/src/components/sidebar/Sidebar.tsx:207-...`). The reconnect and disconnect
  confirmations are also only there (`Sidebar.tsx:35-73`).
- On mobile the sidebar is a `Sheet` (`apps/web/src/components/ui/sidebar.tsx:100-104`) and
  `SheetPortal` defaults to `keepMounted = false` (`apps/web/src/components/ui/sheet.tsx:65-76`).
  So when the mobile sidebar is closed, those dialogs are probably not mounted. This affects any
  flow started outside the sidebar (composer picker, thread gate). Needs a quick check on device;
  the plan moves the dialogs to a global host either way.

### 2.3 Current Reconnect / Disconnect implementation

- Menu items: `buildProjectContextMenuItems`
  (`apps/web/src/components/sidebar/Sidebar.projectActions.menu.ts:9-50`). Only for SSH targets.
  Reconnect (disabled while pending) is shown unless user-disconnected. Then Disconnect, or
  Connect when user-disconnected. Then Remove.
- Dispatch: `useSidebarProjectActions` → `handleProjectContextMenuAsync`
  (`Sidebar.projectActions.ts:73-143`):
  - `reconnect` → `useSidebarProjectReconnectActions.requestReconnect`
    (`Sidebar.projectActions.reconnect.ts:210-233`). This opens a confirmation
    (`Sidebar.tsx:35-54`: "Reconnect restarts the bigbud remote service…"), then calls
    `api.server.restartRemoteAgent`, with persisted request reconciliation and a poller
    (`:66-258`). On an auth-required error it opens the auth dialog and resumes on verified
    (`:167-194`).
  - `disconnect` → `useSidebarProjectConnectionActions.requestDisconnect`
    (`Sidebar.projectActions.connection.ts:44-63`). This confirms when there is activity
    (`Sidebar.projectActions.connection.logic.ts`), then
    `disconnectRemoteExecutionTarget` → `api.server.disconnectExecutionTarget`
    (`useRemoteExecutionAccessGate.connection.ts:36-69`).
  - `connect` → `connectRemoteExecutionTarget`, then `beginRemoteExecutionTargetAccessCheck`
    (`Sidebar.projectActions.connection.ts:76-97`).
- All of this state lives in React hooks inside the sidebar tree, so the thread menu, composer
  picker and thread gate cannot reuse it as is.
- Note on meaning: the menu's **Reconnect restarts the bigbud remote service** (agent transport).
  It is not "re-authenticate SSH". The thread gate's "Reconnect" must mean "re-establish access"
  (verify plus auth). See open question Q1.

### 2.4 How connection state is known on the client today

`useRemoteAccessStore` (`apps/web/src/stores/remoteAccess/remoteAccess.store.ts`):

| Signal                                   | Meaning                                                                                         | Source                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `disconnectedExecutionTargetIds[target]` | user chose Disconnect (sticky, server-persisted)                                                | server list; `markExecutionTargetDisconnected`           |
| `disconnectedTargetsLoaded`              | the server disconnect list has loaded                                                           | startup                                                  |
| `verifiedExecutionTargetIds[target]`     | last check passed (**can be stale**, §2.1 step 1)                                               | `checks.ts:193-195`, auth submit                         |
| `executionTargetChecks[target].status`   | `idle` / `checking` / `verified` / `auth_required` / `error`, plus `authMode` and `promptLabel` | `startRemoteExecutionCheck`, `submitRemoteExecutionAuth` |
| `pendingAction`                          | one auth dialog at a time (any target)                                                          | `openAuthDialog` returns `false` if one is pending       |

Server truth: `RemoteTargetDisconnectedError` for user disconnects
(`apps/server/src/ssh/sshTargetDisconnects.ts:12-63`); the password ControlMaster liveness
(`sshSession.ts:124-156`); and `verifyExecutionTarget` (SSH probe plus remote-agent health,
`apps/server/src/ws/wsExecutionTargetVerification.ts:38-105`).

### 2.5 "Needs user input" vs "can reconnect silently"

- **Saved auth method** comes from the execution target id: `auth=password` gives `password`,
  anything else gives `ssh-key` (`apps/web/src/components/sidebar/Sidebar.remoteWorkspaces.logic.ts:157`).
  Transport `agent` vs `direct-ssh` comes from `transport=` (`:158`). The server's
  `parseSshExecutionTarget` mirrors this and chooses the remote-agent path via
  `isRemoteAgentExecutionTarget` (`apps/server/src/remote-agent/remoteAgentDefault.ts:50-58`).
- **The last failure reason decides.** `resolveRemoteExecutionFailureStatus(message)`
  (`apps/web/src/hooks/useRemoteExecutionAccessGate.shared.ts:62-91`) calls `getSshAuthPrompt`
  (`apps/web/src/lib/ssh.ts:~50-56`) and maps:
  - "SSH password is required for X…" or "Incorrect password for X." → `auth_required/password`
  - "SSH key 'P' requires a passphrase." → `auth_required/ssh-key-passphrase`
  - "SSH host trust is required: {…}" → `auth_required/host-trust`
  - anything else → `error` (silent retry possible)
- **Why always try silently first:** a saved method of `password` does not by itself mean a prompt
  is needed. The ControlMaster may still be alive (only the agent link dropped), or another client
  may have re-opened it. The server check is a local `ssh -O check`
  (`sshSession.ts:146-156,183-199`), with no network password. In the same way, `ssh-key` can
  still need a passphrase if ssh-agent lost the key (`sshVerification.ts:68-101`). Key probes use
  `BatchMode=yes`, so a silent attempt never blocks on a TTY prompt
  (`codexAppServerManager.process.remote.test.ts:24-30`). So the rule is: **run one bounded
  silent check; prompt only when it returns `auth_required`**. The saved method only picks the
  wording ("Checking password session…" vs "Reconnecting…") and, when the last check already said
  `auth_required/password` less than ~30 s ago, allows opening the prompt without waiting
  (optimisation, optional).
- **One shared attempt is already supported:** `startRemoteExecutionCheck` returns the existing
  in-flight check for the same target (`useRemoteExecutionAccessGate.checks.ts:168-171`). Several
  gates or clicks on one target share one verify call.

## 3. Target UX

### 3.1 Thread remote-target gate (route level)

A new `ThreadRemoteTargetGate` wraps `ChatView` in the thread route, inside `ThreadProjectGate`
(`apps/web/src/routes/_chat.$threadId.tsx:253`). Because it is at the route, every navigation path
is covered (sidebar, composer picker, palettes, keybindings, notifications, links), not only the
sidebar. It follows the `ThreadProjectGate` pattern
(`apps/web/src/components/chat/view/ThreadProjectGate.tsx:23-45`): the children stay mounted but
hidden/inert when they were mounted before, so composer drafts survive.

Target resolution: `resolveWorkspaceExecutionTargetId(project ?? thread)` (same as
`-_chat.$threadId.activation.ts:42-44`). It passes through for local projects, the built-in Chats
project, and non-SSH targets.

The state comes from a pure function, `deriveRemoteThreadGateState`:

| Input state                                                | Explicit navigation                                                                                                     | Restored on startup / not explicit                                      |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Not remote, or disconnect list not loaded                  | open                                                                                                                    | open                                                                    |
| Verified and not invalidated                               | open                                                                                                                    | open                                                                    |
| Unknown (`idle`, never checked this session)               | open now, start a background check (shared)                                                                             | open, no check                                                          |
| Known dead: `error`, or invalidated (§4.3)                 | **gate "Reconnecting to ice-2-kg…"**, start silent check (shared)                                                       | gate with error and [Reconnect] [Go back], no auto check                |
| Known `auth_required` (password / passphrase / host trust) | gate, run one silent check; if still `auth_required`, open the auth dialog over the gate                                | gate "ice-2-kg needs your SSH password" with [Enter password] [Go back] |
| `checking` (attempt already running)                       | gate "Reconnecting…", join it                                                                                           | same                                                                    |
| Silent check failed (`error`)                              | gate: error text and tip, [Reconnect] [Go back]                                                                         | same                                                                    |
| User-disconnected                                          | see Q2 (default: open read-only, keep the current "navigation reads local history" rule, show an inline Connect notice) | same                                                                    |

Gate screen (centred, same layout as the `ThreadProjectGate` error state):

- Title: "Reconnecting to ice-2-kg…" (blue/info loader), or "ice-2-kg needs your SSH password" /
  "…needs your SSH key passphrase" / "Confirm ice-2-kg's server identity" (amber), or
  "Could not reach ice-2-kg" (red).
- Secondary line, `text-xs`: "Your thread history is safe. It opens when the connection is back."
- Buttons, `text-sm`: primary [Enter password] / [Unlock key] / [Review identity] / [Reconnect];
  secondary [Go back] (history back when the previous entry is in-app, else `/`).
- Credentials use the existing global auth dialog (`SidebarUnlockSshKeyDialog` driven by
  `useRemoteAccessStore`), so host trust, password and passphrase all reuse
  `submitRemoteExecutionAuth` (`useRemoteExecutionAccessGate.auth.ts:11-68`). It opens
  automatically once per explicit navigation, then is re-openable from the button. Closing it
  leaves the gate in place.
- When it succeeds: the target is marked verified, the gate opens, and open thread terminals are
  re-attached. This moves `reconnectRemoteThreadTerminals` out of
  `Sidebar.remoteThreadActivation.ts:64-103` into a shared helper so every path gets it.
- Concurrency: if `pendingAction` is already for this same target, the gate shows "Waiting for
  password…" and does not open a second dialog or show the "Another remote authentication request
  is already pending" toast. A pending action for a **different** target keeps today's warning.
- Several threads of one workspace: every gate reads the same `executionTargetChecks[target]`, so
  one success opens all of them.

### 3.2 Thread already open when the connection dies (or state unknown)

No gate (no navigation happened). Instead:

- A new amber `ThreadRemoteTargetNotice` in the chat body replaces the red `ThreadErrorBanner` and
  the red recovery notice for remote-target failures. Example: "ice-2-kg is not connected. Your
  message was not sent." with [Enter password] / [Reconnect] (same handlers as the gate).
- The composer's send keeps using `ensureRemoteExecutionTargetAccess`. Once the stale flag is
  invalidated (§4.3), sending asks for the password before dispatch instead of failing on the
  server.
- After reconnecting, the unsent message stays as the latest user message. Resending is explicit
  (see Q4). Automatic resend is not proposed: the failure is proven pre-dispatch, but a turn must
  never be sent twice by accident.

### 3.3 Sidebar thread menu

For threads whose workspace target is SSH, insert the shared remote-target items directly above
the Delete separator, matching shot2 exactly:

`… Copy Path, Archive thread, Reconnect, Disconnect, ─, Delete`

When user-disconnected: `… Archive thread, Connect, ─, Delete`. Reconnect is disabled while a
reconnect for that project is pending. Labels, confirmations, toasts and the auth flow are the same
as the workspace menu because they use the same action source (§4.2), keyed by the thread's
`projectId`. Multi-select menus get no remote items.

### 3.4 Composer picker submenu

In `BranchToolbarProjectMenu`, for SSH workspace submenus, after the thread list (or "No recent
threads"): `MenuSeparator`, then [Reconnect] [Disconnect] (or [Connect]), `text-xs` like the other
submenu items. Choosing one closes the menu and runs the shared action. Its confirmation dialog
comes from the global host (§4.2), so it works when the sidebar is collapsed or on mobile.

## 4. Design

### 4.1 Server: stop treating a dead SSH target as a dead provider session

Default proposal, with **no change to the wire literal set** (see Q3 for the alternative):

1. **Typed SSH readiness errors** (`apps/server/src/ssh/`):
   - New `sshTargetUnavailable.ts` with `SshTargetAuthRequiredError extends Error`
     (`_tag`, `executionTargetId`, `authMode: "password" | "ssh-key-passphrase" | "host-trust"`).
     Messages stay byte-for-byte the same, because the web regexes in `lib/ssh.ts` depend on them.
   - Throw it from `assertSshPasswordExecutionTargetReady[Async]` (`sshSession.ts:167-199`), the
     key-load branches (`sshVerification.ts:96-101,117-122`) and host-trust inspection.
     `RemoteTargetDisconnectedError` already exists (`sshTargetDisconnects.ts:16-24`).
   - Add `isRemoteTargetUnavailable(error)`. It walks the `.cause` chain (adapters keep `cause`),
     with a message fallback that reuses the same message builders (a single source; no copied
     regexes): `formatSshPasswordRequiredMessage`, `formatSshKeyLoadMessage`, the host-trust
     prefix, and `REMOTE_TARGET_DISCONNECTED_MESSAGE`. The fallback covers adapters that turn the
     cause into a string across a process boundary.
2. **Classification** (`ProviderTurnFailureClassification.ts`): before the explicit/typed checks,
   if `isRemoteTargetUnavailable(error)`, return `auth-or-quota` for auth-required and `unknown`
   for user-disconnected or unreachable. Both classes are never auto-recovered and never
   auto-forked (`recovery.turnStart.ts:183-188`, `turnStart.ts:154-155`). This removes the
   revive/fresh-replay attempts and the automatic fork.
   - Split the file if needed: keep it under 400 lines by putting remote-target detection in
     `ProviderTurnFailureClassification.remoteTarget.ts`.
3. **Remote-target marker on the failure activity** (`ProviderCommandReactorHandlers.failures.ts`):
   when the cause is remote-target-unavailable, add
   `remoteTarget: { executionTargetId, reason: "auth-required" | "disconnected" | "unreachable", authMode? }`
   to the `provider.turn.start.failed` activity payload. Activity payloads are untyped on the wire,
   so older clients ignore it. A schema-only `TurnStartRemoteTargetFailure` is added to
   `packages/contracts/src/orchestration/orchestration.turnFailure.ts` so the server writer and web
   reader share one definition (decoded with `Schema.decodeUnknownOption` on the web).
4. **Optional pre-flight** (M2b, see Q5): in the turn-start path, before provider session start
   for SSH workspace targets, run `assertSshExecutionTargetReadyAsync` (bounded deadline). This
   gives the clean typed error regardless of how each adapter wraps it. It costs one local check
   per turn start (cached by `isPasswordSessionCheckFresh`).

### 4.2 Web: one "remote target actions" source

Move the reconnect/disconnect/connect logic out of sidebar hooks into a shared module and store, so
the workspace menu, thread menu, composer picker and thread gate all use one implementation:

- `apps/web/src/stores/remoteAccess/remoteTargetActions.store.ts` (zustand): `pendingReconnect`,
  `pendingDisconnect`, `activeReconnectRequestIds`; actions `requestReconnect(projectId)`,
  `confirmReconnect()`, `dismissReconnect()`, `requestDisconnect(projectId)`,
  `confirmDisconnect()`, `dismissDisconnect()`, `requestConnect(projectId)`,
  `isReconnectPending(projectId)`. Projects are read live from `useStore.getState().projects`.
- `apps/web/src/stores/remoteAccess/remoteTargetActions.reconnect.ts`: moved from
  `Sidebar.projectActions.reconnect.ts` (the restart start, finish, `phaseToast`, auth-required
  hand-off, persistence and poller). `Sidebar.projectActions.reconnect.persistence.ts` and
  `.poller.ts` move with it, or are imported from their current place (see Q7).
- `apps/web/src/stores/remoteAccess/remoteTargetActions.connection.ts`: moved from
  `Sidebar.projectActions.connection.ts`. `Sidebar.projectActions.connection.logic.ts` stays as is.
- `apps/web/src/lib/remoteTargetMenu.ts`: `buildRemoteTargetMenuItems({ executionTargetId, disconnected, reconnectPending })`
  returns `[]` for non-SSH targets, or the reconnect/disconnect/connect descriptors. Also
  `runRemoteTargetMenuAction(clicked, projectId): Promise<boolean>`.
  `buildProjectContextMenuItems` (`Sidebar.projectActions.menu.ts:33-43`) uses it, so the
  workspace and thread menus cannot drift apart.
- `apps/web/src/components/remote/RemoteTargetDialogsHost.tsx`: renders the Reconnect and
  Disconnect `AlertDialog`s (moved from `Sidebar.tsx:35-73`), the remote-execution auth dialog
  (moved from `Sidebar.tsx:207-...`), and runs the reconnect reconciler or poller lifecycle once
  (`useRemoteTargetReconnectReconciler`, moved from the hook's effects at
  `reconnect.ts:129-150`). It is mounted once in `apps/web/src/components/layout/AppSidebarLayout.tsx`,
  outside the mobile `Sheet`. The sidebar's own workspace-unlock dialog
  (`s.isRemoteWorkspaceUnlockDialogOpen`) stays in the sidebar because it belongs to the add/edit
  workspace flow.
- `useSidebarProjectActions` keeps its output shape where other code reads it. `pendingReconnect`,
  `pendingDisconnect` and similar move out of `Sidebar.types.ts` and
  `Sidebar.projectActions.types.ts`, since the host reads the store directly.

### 4.3 Web: invalidate stale verification

- `apps/web/src/stores/remoteAccess/remoteTargetInvalidation.ts`: when a thread's newest
  `provider.turn.start.failed` activity has a `remoteTarget` marker, or (legacy rows) a detail that
  `getSshAuthPrompt` recognises or that equals the disconnected message, call
  `setExecutionTargetCheck(target, resolveRemoteExecutionFailureStatus(detail))`. Only do this when
  the activity is newer than the target's last check `updatedAt`. This clears `verified`
  (`remoteAccess.store.ts:170-176`).
- Hook it where thread activities are ingested for the active thread (a small
  `useRemoteTargetFailureInvalidation(thread)` called from `ChatViewChatBody`). This keeps it
  explicit and per-visible-thread. No background polling.
- Any failed `verifyExecutionTarget` result already updates the check
  (`checks.ts:196-204`). Nothing new is needed there.

### 4.4 Web: explicit-navigation intent

Marking 30+ navigation call sites is fragile. Instead, mark the **non-explicit** one:

- `apps/web/src/stores/remoteAccess/threadNavigationIntent.ts`: `markRestoredThreadRoute(threadId)`
  is called by startup restoration (`apps/web/src/routes/-__root.logic.tsx` thread restore). The
  gate calls `consumeThreadNavigationIntent(threadId)`, which returns `"restored"` once, then
  `"explicit"`.
- Every other route entry (clicks, menus, palettes, keybindings, notification clicks) is a user
  action and counts as explicit. The sidebar rendering never mounts the route, so it never triggers
  a check (consistent with "never connect just to search").
- `Sidebar.remoteThreadActivation.ts` then becomes plain navigation, and its pre-navigation check
  is removed. This removes the duplicate flow, and the gate is the single owner. See Q6.

### 4.5 Web: thread recovery and error notices

- `ThreadRecoveryNotice.failure.ts`: `ServerTurnFailure` gets
  `remoteTarget?: TurnStartRemoteTargetFailure`. `deriveServerTurnFailure` decodes it from the
  payload, or for legacy rows infers it from a `session-dead` detail matching `getSshAuthPrompt`
  or the disconnected message.
- `ThreadRecoveryNotice.logic.ts`: when `failure.remoteTarget` is set, return no failed notice (so
  no "Could not reconnect / cannot be resumed"). The new `ThreadRemoteTargetNotice` takes over.
- `ThreadErrorBanner.tsx`: hide when the thread's remote target notice is active (same detail).
  The check goes in `ThreadErrorBanner.failure.ts` (`isRemoteTargetErrorText`), and the logic
  lives in a shared helper `apps/web/src/lib/remoteTargetFailure.ts` used by both.
- `ThreadRemoteTargetNotice.tsx`, `.logic.ts`: amber `ChatBanner` with the gate's action buttons.
  It hides once the target is verified **and** the failure is older than that verification.

### 4.6 File length (400-line limit)

| File                                                        | Now | Action                                                                          |
| ----------------------------------------------------------- | --- | ------------------------------------------------------------------------------- |
| `components/sidebar/Sidebar.threadActions.ts`               | 393 | extract the menu builder to `Sidebar.threadActions.menu.ts` before adding items |
| `components/sidebar/Sidebar.tsx`                            | 264 | shrinks (dialogs move to the host)                                              |
| `components/git/BranchToolbarProjectMenu.tsx`               | 207 | extract `BranchToolbarProjectMenu.projectSubmenu.tsx`                           |
| `routes/_chat.$threadId.tsx`                                | 266 | +3 lines (wrapper)                                                              |
| `components/sidebar/Sidebar.projectActions.ts`              | 322 | shrinks (dispatch through `runRemoteTargetMenuAction`)                          |
| `orchestration/Layers/ProviderTurnFailureClassification.ts` | 111 | add `.remoteTarget.ts` sibling                                                  |

## 5. Exact files to change

### Server

- `apps/server/src/ssh/sshTargetUnavailable.ts` (new): typed error and `isRemoteTargetUnavailable`.
- `apps/server/src/ssh/sshSession.ts`: throw `SshTargetAuthRequiredError` (`:167-199`). Keep the messages.
- `apps/server/src/ssh/sshVerification.ts`: the key-load and host-trust throws.
- `apps/server/src/orchestration/Layers/ProviderTurnFailureClassification.ts` and new
  `.remoteTarget.ts`: classify before the typed session-dead check.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.turnStart.ts`: pass the
  remote-target marker to `recordTurnStartFailure`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactorHandlers.failures.ts`: add
  `remoteTarget` to `TurnStartFailureInput` and the payload.
- (M2b optional) the turn-start path (`ProviderCommandReactorSessionOps.start.ts` or `.userTurn.ts`):
  SSH readiness pre-flight.

### Contracts (schema only, additive)

- `packages/contracts/src/orchestration/orchestration.turnFailure.ts`: `TurnStartRemoteTargetFailure`
  schema and type. Not referenced from the typed event schemas, so no wire break.

### Web

- `apps/web/src/routes/_chat.$threadId.tsx`: wrap `ChatView` with `ThreadRemoteTargetGate`.
- `apps/web/src/components/chat/view/ThreadRemoteTargetGate.tsx`, `.logic.ts` (new): pure state and UI.
- `apps/web/src/components/chat/view/ThreadRemoteTargetNotice.tsx`, `.logic.ts` (new).
- `apps/web/src/components/chat/view/ThreadRecoveryNotice.failure.ts`, `ThreadRecoveryNotice.logic.ts`.
- `apps/web/src/components/chat/common/ThreadErrorBanner.tsx`, `ThreadErrorBanner.failure.ts`.
- `apps/web/src/components/chat/view/chat-view/ChatViewChatBody.tsx`: mount the notice and the invalidation hook.
- `apps/web/src/lib/remoteTargetFailure.ts`, `apps/web/src/lib/remoteTargetMenu.ts` (new).
- `apps/web/src/stores/remoteAccess/remoteTargetActions.store.ts`, `.reconnect.ts`, `.connection.ts`,
  `remoteTargetInvalidation.ts`, `threadNavigationIntent.ts` (new).
- `apps/web/src/hooks/useRemoteExecutionAccessGate.ts`: export `openRemoteExecutionAuthDialog`;
  add the same-target pending handling.
- `apps/web/src/hooks/remoteThreadTerminals.ts` (new): moved `reconnectRemoteThreadTerminals`.
- `apps/web/src/components/remote/RemoteTargetDialogsHost.tsx` (new).
- `apps/web/src/components/layout/AppSidebarLayout.tsx`: mount the host.
- `apps/web/src/components/sidebar/Sidebar.tsx`: remove the moved dialogs.
- `apps/web/src/components/sidebar/Sidebar.projectActions.ts`, `.menu.ts`, `.types.ts`,
  `Sidebar.types.ts`; delete `Sidebar.projectActions.reconnect.ts` and `.connection.ts` once moved.
- `apps/web/src/components/sidebar/Sidebar.threadActions.ts` and new `Sidebar.threadActions.menu.ts`.
- `apps/web/src/components/sidebar/Sidebar.remoteThreadActivation.ts`: reduce to navigation (Q6).
- `apps/web/src/components/git/BranchToolbarProjectMenu.tsx` and new `.projectSubmenu.tsx`.
- `apps/web/src/routes/-__root.logic.tsx`: `markRestoredThreadRoute` on restore.

## 6. Edge cases

- **Agent transport vs Direct SSH:** both go through `verifyExecutionTarget`. The agent path also
  checks remote-agent health (`wsExecutionTargetVerification.ts:55-104`). If install or upgrade is
  required, the gate shows the existing message (`getRemoteAgentAccessError`) with
  [Edit workspace] instead of Reconnect.
- **Key auth with no passphrase / agent-loaded key:** reconnects silently (BatchMode).
- **Passphrase-protected key not in agent:** `auth_required/ssh-key-passphrase` opens the unlock
  dialog.
- **Password auth:** a silent check succeeds when the ControlMaster is alive; otherwise the password
  dialog opens. Idle expiry after 600 s is expected (see Q8).
- **Host key changed or unknown:** `host-trust` opens the existing review flow.
- **Unknown vs known dead:** unknown opens at once with a background check (explicit only). Known
  dead is gated.
- **Multiple threads open or clicked:** one shared check (`checks.ts:168-171`) and one dialog per
  target. All gates for that target open on success.
- **Reconnect fails:** the gate shows the error, tip and [Reconnect] [Go back]. No toast spam: the
  gate replaces `showRemoteExecutionFailureToast` while it is visible.
- **User cancels the prompt:** the gate stays with [Enter password] [Go back]. `pendingAction.onCancel`
  does not navigate.
- **User goes back while a check runs:** the check continues (shared). If it succeeds, the next
  visit opens directly.
- **User-disconnected target:** never auto-connects (sticky by design,
  `sshTargetDisconnects.ts:1-10`). Behaviour per Q2.
- **Local provider runtime with a remote workspace:** still gated (the workspace bridge needs SSH,
  `Codex/Adapter.session.ts:113-121`). **Remote runtime with a local workspace:** the workspace
  target is local, so not gated (the turn failure notice still applies).
- **Built-in Chats or local projects:** pass through.
- **Draft threads on a remote project:** the gate uses `draftProjectId`. Same rules.
- **Thread moved between projects:** the gate key is the resolved target, recomputed on change.
- **Disconnect list not loaded yet:** pass through (matches `useRemoteExecutionAccessGate.ts:118-123`).
  The gate re-evaluates when it loads.
- **Mobile and remote clients:** dialogs move out of the `Sheet`. Native context menus fall back
  to the web menu via `api.contextMenu.show`. Credentials travel through the same RPCs
  (`unlockSshPassword` and similar), so a phone can unlock the desktop server's target.
- **Multiple desktop windows:** each renderer has its own store. The server serialises verify and
  unlock per target. A second window may show the gate until its own check confirms.
- **Server restart:** ControlMasters are lost and the client store resets on reload. Unknown leads
  to a background check.

## 7. Tests

Run focused only (never `bun test`):

- `bun run --cwd apps/server vitest run <file>`
- `bun run --cwd apps/web vitest run <file>`
- `bun run --cwd apps/web test:browser <file>` (needs an installed Playwright browser)

Server unit:

- `ProviderTurnFailureClassification.test.ts` (+ `.adapters.test.ts`):
  `ProviderAdapterProcessError` wrapping `SshTargetAuthRequiredError` gives `auth-or-quota`;
  wrapping `RemoteTargetDisconnectedError` gives `unknown`; message-only fallback for each SSH
  message; plain `ECONNRESET` process error is still `session-dead`.
- `ProviderCommandReactor.sessionRecovery.test.ts`: session start fails with the password error,
  so no `provider.session.recovery` activities, no `thread.fork`, and the failure activity carries
  `remoteTarget`.
- `sshSession.test.ts` / `sshVerification` tests: typed errors with the same message text.

Web unit:

- `ThreadRemoteTargetGate.logic.test.ts`: the full state table in §3.1 (explicit vs restored,
  each check status, disconnect list loading, local passthrough).
- `remoteTargetMenu.test.ts`: SSH vs local vs non-SSH remote; disconnected gives Connect;
  Reconnect is disabled while pending. Parity: project menu and thread menu produce identical
  remote items.
- `Sidebar.threadActions.menu.test.ts`: items above Delete only for SSH-workspace threads; order
  matches shot2.
- `Sidebar.projectActions.menu.test.ts`: unchanged output (regression).
- `ThreadRecoveryNotice.logic.test.ts` and `.failure.test.ts`: a `remoteTarget` failure gives no
  "cannot be resumed"; a legacy `session-dead` with SSH password detail is inferred as remote.
- `remoteTargetInvalidation.test.ts`: a newer failure clears verified; an older one does not.
- `threadNavigationIntent.test.ts`: restored is consumed once.
- `remoteTargetActions.store.test.ts`: moved reconnect and connection behaviour (port the existing
  `Sidebar.projectActions.connection.logic.test.ts` and `.reconnect.poller.test.ts` expectations).

Web browser:

- `ThreadRemoteTargetGate.browser.tsx`: known `auth_required/password` shows the gate and the
  dialog, and submit opens the thread. Silent success shows "Reconnecting…" then the thread.
  Silent failure shows the error with Reconnect / Go back. Two threads of one target lead to one
  `verifyExecutionTarget` call. A restored route makes no verify call. Go back navigates. A pending
  auth for the same target shows "Waiting for password…".
- `-_chat.$threadId.projectGate.browser.tsx`: the gates compose (project loading, then remote).
- `ThreadRecoveryNotice.browser.tsx`: an SSH failure shows the amber notice, with no red "Could not
  reconnect".
- `BranchToolbarProjectMenu.browser.tsx`: an SSH submenu shows Reconnect/Disconnect after the
  threads, a local one does not, and a click opens the host confirmation.
- `RemoteTargetDialogsHost.browser.tsx`: confirmations render with the sidebar unmounted (mobile).

Checks per milestone: file-length check on changed files, `bunx oxfmt` and `oxlint` on explicit
paths, `typecheck` for `@bigbud/server`, `@bigbud/web`, `@bigbud/contracts` (package-scoped), and
the focused tests above. No repo-wide runs without approval.

## 8. Milestones

1. **M1: Server classification (fixes card 2 and the auto-fork).** Typed SSH errors, the
   classification rule, the `remoteTarget` marker, the contracts schema, and server tests. On its
   own, this replaces "Could not reconnect / cannot be resumed" with no recovery card (the red
   "Thread failed" text remains until M3).
2. **M2: Shared remote target actions and global dialog host.** Store, menu builder, host in
   `AppSidebarLayout`, and the workspace menu re-wired with no visible change. Tests ported.
   - M2b (optional): turn-start SSH pre-flight.
3. **M3: Thread notices.** Remote-target notice, error banner suppression, legacy inference, and
   stale-verification invalidation.
4. **M4: Thread gate and auto-reconnect.** Gate, intent, terminal re-attach helper, simplified
   sidebar activation, and browser tests.
5. **M5: Menus.** Thread context menu items (with the `Sidebar.threadActions.menu.ts` extraction)
   and composer picker items (with the submenu extraction).

Each milestone is self-contained and passes its focused checks. No commits or pushes without
explicit approval.

## 9. Open questions for the user

- **Q1 — What "Reconnect" means in the thread menu and composer picker.** The workspace menu's
  Reconnect **restarts the bigbud remote service** (confirmation warns it interrupts turns and
  terminals for every workspace on that service). You asked for the same action in the thread menu
  and picker. Should those be exactly that (as specified), or should Reconnect there mean
  "re-authenticate / reconnect SSH" (non-destructive), with the restart kept workspace-only? The
  gate's own button will be the non-destructive re-authenticate either way.
- **Q2 — User-disconnected workspaces.** Today, opening a thread of a workspace you chose to
  Disconnect opens it read-only (history is local) and shows Connect when you try to use it. Should
  those threads also be gated (gate with [Connect] [Go back]), or keep opening read-only with an
  inline "Disconnected — Connect" notice? Plan default: keep read-only and add the notice.
- **Q3 — Failure class on the wire.** Default: reuse existing classes (`auth-or-quota`, `unknown`)
  and add a `remoteTarget` marker in the activity payload, so older mobile/remote clients keep
  decoding events. Alternative: a new `remote-target-unavailable` literal in
  `TurnStartFailureClass` (cleaner, but an older client reading the new event may fail to decode
  it). OK with the default?
- **Q4 — After reconnecting, what happens to the unsent message?** Options: (a) leave it and let
  the user resend (plan default); (b) show a "Resend" button on the notice; (c) resend
  automatically (safe in principle because the failure is proven pre-dispatch, but it adds an
  automatic send).
- **Q5 — Turn-start SSH pre-flight (M2b).** Add the bounded local readiness check before provider
  session start for all SSH workspaces (cleaner errors for every adapter, one cached local check
  per turn), or rely on classification only?
- **Q6 — Startup-restored thread.** When bigbud starts and restores a thread of a dead workspace,
  should it auto-reconnect (opening the app is a deliberate act) or show the gate with a Reconnect
  button (plan default, strictly "explicit only")?
- **Q7 — Where the shared module lives.** `apps/web/src/stores/remoteAccess/remoteTargetActions.*`
  (plan default) vs a new `apps/web/src/lib/remoteTargets/` folder.
- **Q8 — Password session lifetime.** Password ControlMasters exit after 10 idle minutes
  (`ControlPersist=600`), so password workspaces will often need the password again after a break.
  Keep it (safer), lengthen it, or make it a setting? This is out of scope for this plan unless you
  want it added.
- **Q9 — Existing broken threads.** Threads already marked `session-dead` because of SSH (like the
  screenshot) will show the new amber notice via legacy inference. Should a server-created
  automatic fork from such a failure (if one exists) be left as is?

## 10. User decisions (2026-11-21)

- **Q1:** Reconnect in the thread menu and the composer picker is the SAME action as the workspace
  menu's Reconnect: it restarts the remote service, with the same confirmation and the same handler
  through the shared `remoteTargetActions` module. The gate's own button stays non-destructive
  (silent reconnect, or password/passphrase/host-trust prompt).
- **Q2:** Threads of a workspace the user chose to Disconnect open in read-only mode with a banner
  saying the workspace is disconnected and the thread is read-only. The banner has a Reconnect
  button with the same behaviour as the workspace menu's Connect/Reconnect for a disconnected
  workspace (the shared `requestConnect` action).
- **Q3:** Reuse the existing failure classes plus the additive `remoteTarget` payload marker. No new
  enum value.
- **Q4:** After reconnecting, show a "Resend" button for the unsent message.
- **Q5:** Add the SSH readiness pre-flight before each provider session start, in addition to the
  classification fix.
- **Q6:** A thread restored at startup on a dead workspace shows the gate with a Reconnect button.
  No auto-reconnect.
- **Q7:** The shared module lives in `apps/web/src/stores/remoteAccess/remoteTargetActions.*`.
- **Q8:** Password-session idle timeout setting (default 30 minutes) is a FOLLOW-UP, not part of
  this build.
- **Q9:** Leave existing automatic forks created from past SSH failures as they are.
- **Added requirement:** when no password is needed, opening any thread of a dropped workspace
  auto-reconnects on explicit navigation ("Reconnecting to <host>…"), with one shared attempt for
  concurrent opens. Prompt only when the attempt reports a password, passphrase, or host-trust
  need. Never reconnect in the background.
- **Required UI:** the thread context menu shows Reconnect and Disconnect directly before Delete for
  remote-workspace threads (matching the workspace menu). The composer project/thread picker
  submenu for a remote workspace shows Reconnect and Disconnect after the thread list. The
  password/passphrase/host-trust dialog and the confirmations are hosted globally (outside the
  mobile `Sheet`) so every entry point can show them.

## 11. Implementation follow-ups (2026-11-21)

- Password-session idle timeout setting (default 30 minutes): not built (decision Q8).
- Resend re-sends text, path and thread references, and files by source path. A message with
  images is not resent automatically (image bytes are not kept in the client); the notice asks the
  user to send it again from the composer.
- Remote agent install/upgrade required: the gate shows the existing message with Reconnect; an
  in-gate "Edit workspace" button is not wired (the edit dialog lives in the sidebar).
- On-device mobile check of the global dialog host is still to do.
- `-_chat.$threadId.projectGate.browser.tsx` fails independently of this work: its native API
  mock has no `terminal`, and `useTerminalViewReport` calls `terminal.view`.
