# Remote Workspace Disconnect

**Date:** 6 November, 2026
**Status:** Implemented (manual verification pending)
**Owner:** Claude (implementer)

## Summary

Add a user-initiated **Disconnect** action, and a matching **Connect** action, for remote
(SSH) workspaces. Disconnect closes bigbud's local side of every connection to that SSH
target. The choice is saved and survives an app restart. While disconnected, bigbud
never opens the target again on its own. Connect clears the flag and verifies the
target as Reconnect does today.

Work on remote-agent targets (remote processes and PTYs owned by the agent) keeps
running on the host and reattaches through the existing reattach paths after Connect.

## Related Work

- Bigbud note / Kanban card: none identified. The request came from a thread
  conversation on 6 November 2026, with a screenshot of the remote-workspace context menu.
- Existing Reconnect flow: `apps/web/src/components/sidebar/Sidebar.projectActions.reconnect.ts`.

## Problem

The remote-workspace context menu
(`apps/web/src/components/sidebar/Sidebar.projectActions.menu.ts:9-39`) offers
Reconnect, Rename, Edit, Copy path and Remove. It has no way to drop a connection.
Today a connection only closes when the app exits or the workspace is removed:

- `RemoteAgentConnectionPool.close(target)` exists
  (`apps/server/src/remote-agent/remoteAgentConnectionPool.ts:244`), but nothing calls
  it on user intent. It is also not sticky: the next `get()` silently opens a new
  SSH proxy.
- Password ControlMaster sessions stay up with `ControlPersist=600`. They are only
  closed from the process `exit` handler (`apps/server/src/ssh/sshSession.ts:342-366`).
- Many loops reopen a target automatically: process reattach, PTY recovery, workspace
  watches, terminal inspection, the remote-agent update scheduler and startup
  maintenance, and web-side verification on render and navigation. See Current State.

## Decisions (from the user, 6 November 2026)

- Disconnect applies to **all SSH workspaces** (both the `direct-ssh` and `agent`
  transports), which is the same set that shows Reconnect today.
- A disconnected workspace **stays disconnected after the app restarts**.
- In the context menu, **Disconnect/Connect sits immediately before "Remove remote
  workspace"**.
- Disconnect closes only the local side. Remote-agent work keeps running on the host.
  When threads on the target have running turns or terminals, ask for confirmation first.

## Goals

- A per-target disconnect flag that is persisted, enforced on the server, and visible
  to the web client.
- Disconnect closes, for that target: remote-agent pool connections (consumers are
  notified as a failure), the password ControlMaster session, SSH-monitor admission,
  provider sessions bound to the target, and direct-SSH terminals.
- While disconnected, every SSH spawn for the target fails fast, before running any
  local or network probe, with a clear typed error: `Remote workspace is disconnected.
Connect it to continue.`
- Background loops (update scheduler, maintenance, reattach, watches) neither spawn
  SSH nor log noisy warnings for disconnected targets.
- Web: the menu shows Disconnect or Connect right before Remove. The status icon shows
  a neutral grey "Disconnected" state, distinct from red, which means a failure. The
  access gate offers Connect instead of silently verifying. Auto-verify on mount is
  skipped while disconnected.
- Connect clears the flag, wakes waiting reattach loops, and verifies the target.

## Non-Goals

- Stopping or killing remote-agent work on the host ("Disconnect and stop remote work").
- Disconnect for local projects.
- Live push of disconnect state to other connected clients (such as the mobile
  companion). Clients re-read the state on WebSocket (re)connect. Logged as follow-up.
- Changing the existing Reconnect (restart remote service) semantics.

## Current State

Facts are from the survey on 6 November 2026.

**SSH choke points.** Almost every spawn goes through one of these:

- `buildSshTransportArgs` (`apps/server/src/ssh/sshCommand.ts:31`).
- `assertSshExecutionTargetReady(Async)` (`apps/server/src/ssh/sshVerification.ts:91,104`).
- `runSshCommand` (`apps/server/src/ssh/sshProcess.ts:26`).

The exceptions are the password branch of `remoteReadOnlyInvocation`
(`terminal/Layers/Manager.remote-inspection.ts:30-50`), `ssh/sshHostTrust.ts:71`, and
password unlock (`ssh/sshSession.ts:267`).

**Long-lived holders:**

- **Remote-agent pool connections.** Each is an `ssh … --proxy` child.
  `RemoteAgentConnection.close()` sets `closed` before `fail()` runs, so failure
  listeners never fire (`remoteAgentConnection.ts:271-277,367`).
- **Direct-SSH terminals.** `ssh -tt` children (`terminal/Layers/Manager.remote.ts`).
- **Provider SSH children.** Codex (`codexAppServerManager.process.remote.ts`), Pi
  (`Pi/RpcProcess.ts`), and the OpenCode v1 tunnel (`Opencode/ServerManager.child.ts`).
  All of these end when the provider session stops.
- **Password ControlMaster** sessions.

**Auto-reconnect:**

- Process reattach: a 24 h loop with backoff, woken by
  `notifyRemoteAgentReattachWake` (`remoteAgentProcessClient.reattach.ts:150`,
  `remoteAgentProcessClient.wake.ts`).
- PTY recovery: 3 attempts (`remoteAgentPtyClient.ts:348`).
- Workspace watch loops: `agentWorkspaceWatch.ts:223` and
  `WorkspaceFileSystem.remoteWatch.ts:69`.
- Terminal inspection: every 3 s.
- Update scheduler: every 15 min (`remoteAgentUpdate.scheduler.ts`).
- Startup maintenance (`RemoteAgentRuntimeBindings.ts:397`,
  `remoteAgentInstall.maintenance.ts:27`).
- Web:
  - `SidebarRemoteAgentStatus.tsx:49-103` verifies on mount.
  - `ensureRemoteExecutionTargetAccess` verifies in the background
    (`useRemoteExecutionAccessGate.ts:240-251`).
  - Sidebar thread activation reopens terminals (`Sidebar.remoteThreadActivation.ts:60-121`).
  - The terminal viewport opens terminals on mount.
  - The monitor poller samples every 5 s.

**Persistence.** No per-target user flag exists. Several projects can share one target,
so the flag is keyed by **execution target id**, not by project. The RPC pattern to
mirror is `restartRemoteAgent` (`packages/contracts/src/server/server.remoteRestart.ts`,
`apps/server/src/ws/wsRemoteAgentRestart.ts`, `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts:126-146`).

## Design

Disconnect is a **deliberate, sticky network loss**. Every consumer already handles
network loss (reattach, recovery, backoff, error surfaces). The feature therefore:

1. Records intent, in SQLite and in an in-memory registry.
2. Makes every connection attempt for that target fail fast with
   `RemoteTargetDisconnectedError`. This error is **non-definitive** for reattach, so
   remote-agent work is kept waiting rather than abandoned.
3. Closes the live holders, so consumers see an ordinary failure.

Connect reverses step 1 and wakes the waiting reattach loops.

Rejected alternatives:

- **A web-only flag.** Server loops (scheduler, maintenance, reattach) would keep
  connecting.
- **Per-project flags.** Targets are shared between projects, so this would
  disconnect half a connection.
- **Making the guard error definitive.** Reattach would abandon remote work. That
  breaks the "work keeps running" promise.

## Phases

### Phase 1: Server registry, persistence and guard

- Table `remote_execution_target_disconnects(target_id TEXT PRIMARY KEY, disconnected_at INTEGER NOT NULL)`,
  created with `CREATE TABLE IF NOT EXISTS` by the persistence layer itself. This
  replaced the originally planned migration 153 so that the feature could be committed
  before the uncommitted migrations 145–152. The migrator skips ids at or below the
  latest applied id.
- `apps/server/src/ssh/sshTargetDisconnects.ts`: module-level registry (same pattern
  as `configureRemoteAgentRestartStore`):
  - `isSshTargetDisconnected`, `assertSshTargetConnected`, `listDisconnectedSshTargets`,
    `markSshTargetDisconnected`, `clearSshTargetDisconnected`.
  - A `RemoteTargetDisconnectedError` class.
  - A configured persistence store.
- Persistence layer `RemoteExecutionTargetDisconnectsLive`. It loads all rows into the
  registry at construction and configures the store. It must be built before the remote
  agent services, so that startup maintenance and the scheduler see the loaded flags.
- Guard calls go into:
  - `buildSshTransportArgs`.
  - `assertSshExecutionTargetReady(Async)` (first statement, before any local probe).
  - The password-session transport args.
  - `remoteReadOnlyInvocation`.
  - `sshHostTrust`.
  - `RemoteAgentConnectionPool.get/getBound`.
- Reattach classification: confirm that the guard error is treated as retryable, not
  definitive (`remoteAgentProcessClient.reattach.ts`).
- Quiet skips: the update scheduler (`prepare`/`discoverTargets`) and maintenance
  `cleanup` skip disconnected targets without warnings.

Exit: unit tests show that the guard throws for flagged targets, that loading persists
the flags, that reattach keeps waiting, and that the scheduler skips flagged targets.

### Phase 2: Server disconnect/connect actions and RPC

- Contracts:
  - `packages/contracts/src/server/server.remoteConnection.ts`: inputs
    `{ executionTargetId }`, result `{ executionTargetId, disconnected }`, list result
    `{ executionTargetIds }`, and the error `ServerRemoteConnectionError`.
  - RPC methods `server.disconnectExecutionTarget`, `server.connectExecutionTarget`
    and `server.listDisconnectedExecutionTargets`, wired like `restartRemoteAgent`.
- Server action `ws/wsRemoteConnection.ts`. The order is chosen so that a failure
  part-way through still leaves the target guarded:
  1. Validate that the target is an SSH target. Persist the flag, then update memory.
     If persistence fails, return an error and change nothing.
  2. Stop provider sessions whose runtime or workspace target equals the target
     (`ProviderService.listSessions` + `stopSession`).
  3. Close direct-SSH terminals on that target. Agent PTYs are not terminated.
  4. Fail and close the remote-agent pool connections for the target in every configured
     composition. Add `RemoteAgentConnection.disconnect(error)`, which signals failure
     listeners first and then closes, and a pool `disconnect(target, error)`.
  5. Close the password ControlMaster for the target (`ssh -O exit`, async and bounded).
  6. `forgetSshMonitorTarget(target)`.

  Steps 2 to 6 are best-effort. A failure is logged, the remaining steps still run,
  and the guard already prevents reopening.

- Connect: clear the flag (persist, then memory), then `notifyRemoteAgentReattachWake()`.
  Verification stays with the existing web verify flow.
- Idempotent: disconnecting twice and connecting twice are both no-ops.

Exit: server tests cover the order, idempotence, persistence failure handling and the
pool disconnect notification.

### Phase 3: Web

- Store: `remoteAccess.store` gains `disconnectedExecutionTargetIds` with set, clear and
  replace operations. It is loaded from `listDisconnectedExecutionTargets` on WebSocket
  (re)connect.
- Menu (`Sidebar.projectActions.menu.ts`): for SSH workspaces, add `disconnect` or
  `connect` immediately before `delete`. Connect replaces Reconnect while disconnected.
  Reconnect is hidden while disconnected because restarting a service needs a connection.
- Action hook `Sidebar.projectActions.connection.ts`:
  - Disconnect: count active turns (`isSessionActivelyRunningTurn`) and running terminals
    on threads whose `workspaceExecutionTargetId` equals the target. If any are found,
    show a confirm dialog that also names how many other workspaces share the
    connection. Then call the RPC, update the store, clear the verified state, and show a
    toast.
  - Connect: call the RPC, update the store, then `beginRemoteExecutionTargetAccessCheck`.
- Status icon: a new `"paused"` state, grey, labelled "Disconnected". The existing red
  "Disconnected" label becomes "Unavailable", so the two states stay distinguishable.
- Access gate: `ensure`/`begin` on a disconnected target do not verify. They show a toast
  ("<name> is disconnected") with a **Connect** action, and the call does not proceed.
- Auto-verify suppression: `SidebarRemoteAgentStatus` mount verify, terminal viewport
  auto-open, thread-activation terminal reopen, and the monitor poller all skip
  disconnected targets.

Exit: unit and browser tests cover menu order, the confirm/no-confirm paths, the icon
state, and gate blocking.

## Risks And Decision Gates

- **PTY recovery gives up after 3 attempts.** An agent PTY whose client exhausts its
  recovery while disconnected reports an error locally. The remote PTY is not
  terminated, but whether reopening reattaches to the same remote PTY after Connect is
  **unverified**. This must be checked manually and reported honestly.
- **Provider sessions are stopped**, not paused. Active turns end, and the user is warned
  first. Sessions restart on the next turn after Connect.
- **ProviderTurnSupervisor** may try a server-originated continue after sleep. It
  fails fast with the guard error, which is acceptable; no new suppression is added.
- **Layer ordering:** the registry must be loaded before maintenance or the scheduler
  run. This is verified by placing the layer as a dependency and with a test.
- **Other clients** (mobile companion) see the state only after reconnecting
  (Non-Goal / follow-up).

## Testing And Validation

- Server Vitest (focused): the registry/guard unit tests, the migration, the pool
  disconnect notification, the action order, idempotence and persistence failure, the
  scheduler skip, and reattach non-definitiveness.
- Web Vitest: menu items and order, the status icon state resolver, gate blocking, and
  store load/merge.
- Focused oxfmt and oxlint on the changed files, package typechecks for
  `@bigbud/contracts`, `@bigbud/server` and `@bigbud/web`, and a 400-line check on
  changed files.
- Manual: disconnect an agent workspace while a remote process runs, confirm no SSH
  processes remain for the target (`ps`), restart the app and confirm it stays
  disconnected, then Connect and confirm reattach.

## Acceptance Criteria

- Disconnect and Connect appear right before "Remove remote workspace" for every SSH
  workspace.
- After Disconnect, no local `ssh` process for that target remains, and none is spawned
  until Connect, including across an app restart.
- The status icon shows grey "Disconnected". Sending or opening offers Connect instead
  of silently reconnecting.
- Running remote-agent processes keep running and reattach after Connect.
- Active turns or terminals trigger a confirmation before disconnecting.

## Implementation Notes (6 November 2026)

Approved deviations from the phases above:

- **Gate split.** `beginRemoteExecutionTargetAccessCheck` (navigation, project expand,
  new thread, search) proceeds on a disconnected target without verifying, because
  thread history is local. `ensureRemoteExecutionTargetAccess` (send, terminal toggle)
  blocks with an amber toast that has a **Connect** action.
- **Pool entries are kept.** Pool disconnect fails the live connection and any pending
  one, and keeps the pool entries, so existing reconnect closures reattach after
  Connect. A transport loss during setup keeps the agent epoch.
- **Adding or editing connects.** Adding or editing a remote workspace counts as an
  explicit Connect (`remoteAccess.connect.ts`). Otherwise a stale flag would block
  re-adding a removed host.
- **Startup wait.** The web client waits for the first `listDisconnectedExecutionTargets`
  result (`disconnectedTargetsLoaded`) before auto-verify, terminal auto-open and
  monitor sampling. Until then the status icon shows amber "Connecting".
- **Teardown runs detached.** The teardown runs in a detached fiber that the RPC awaits.
  A repeat Disconnect reruns the safe-to-repeat teardown.

- **Second review fixes:**
  - Teardown re-checks the flag before each step, so a Connect that lands mid-teardown
    is not undone.
  - A password unlock that finishes after Disconnect closes its new ControlMaster
    straight away.
  - Provider session starts re-check the flag after the adapter starts, then roll back.
  - The web sync merges local changes rather than discarding the server list.
  - Connect clears a stale verified state.
  - The confirm text depends on the transport.

Follow-ups:

- Flags for targets with no remaining project are not pruned. This is harmless:
  re-adding the host connects it.
- The folder browser in the add dialog does not auto-connect. Saving does.
- Other clients pick up the state only on WebSocket reconnect.
- Turn counts in the confirm dialog include only threads loaded in the sidebar.

## Open Questions

- None blocking. The PTY reattach after Connect is a manual-verification item.
