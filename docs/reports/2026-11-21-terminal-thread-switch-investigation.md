# Terminal closes after switching threads: investigation (2026-11-21)

Investigation only. No source code was changed. The only file written is this report.

## User report

> If in a thread I open the terminal and use, say, opencode or claude (an interactive TUI), and
> switch to 2–5 other threads to work, the terminal in the first thread gets closed.

- **Expected:** the TUI in thread A keeps running and looks the same when the user comes back.
- **Observed:** after visiting a few other threads, thread A's terminal looks "closed".

"Closed" can mean three different things here, and they have different causes:

| What the user sees                                                | Process state                          | Cause in this report      |
| ----------------------------------------------------------------- | -------------------------------------- | ------------------------- |
| Blank or partial screen and an amber "terminal reconnected" toast | Alive. Only the xterm view was rebuilt | RC1 + RC2                 |
| A fresh shell prompt. The TUI is gone                             | Killed                                 | RC3                       |
| The terminal drawer or tab itself is gone                         | Usually alive (orphaned)               | Not reproduced (see §2.4) |

## TL;DR

1. **The server never kills a PTY because of a thread switch.** The only server paths that kill
   PTYs are explicit close, archive, delete, explicit remote disconnect and backend shutdown
   (§2.1). The user's logs show exactly those: 7 explicit `terminal.close` RPCs and one backend
   shutdown that killed 7 PTYs at once (§3).
2. **RC1 (main regression, client side). Thread switches throw away hidden terminal views.**
   bigbud is meant to keep up to 10 hidden thread drawers mounted. Since the cross-project
   gating change of 2026-11-09 (`e3e8efb854`), several common transitions unmount them anyway:
   - **Releasing a thread's project evicts it from the client store, which unmounts that
     thread's hidden drawer.** Only the active route retains its project. When the user moves to
     a thread in another project, the old project's ref count drops to zero. If that project is
     "dependency-only" (not on the first sidebar catalog page), `pruneProjectDependencies` evicts
     it at once. The hidden `PersistentThreadTerminalDrawer` then sees `project === undefined`,
     returns `null`, and its xterm is disposed.
   - **`ThreadProjectGate` unmounts the whole `ChatView` while it loads a project that is not in
     the store yet.** That takes every hidden drawer with it. So does the route loader shown
     while a new draft thread's ownership is checked, or while an unloaded thread is fetched.
   - **The right-panel terminal tab only ever renders the active thread**, so every switch
     disposes its views.
3. **RC2 (why a rebuilt view looks dead).** A long-running TUI goes past the 1 MiB / 5000-line
   history cap within minutes. When the cap is hit, the server **discards the whole history**.
   The headless recovery mirror that could rebuild the screen is **off by default**
   (`BIGBUD_TERMINAL_RECOVERY=1` is required). So a rebuilt view starts blank and relies on a
   one-row SIGWINCH "repaint probe". Inline renderers such as Claude Code's Ink UI may not redraw
   earlier output, so the pane looks closed even though the process is alive.
4. **RC3 (real kills, not tied to switching).** Local PTYs are children of the backend process.
   Any backend restart (update, crash, SIGINT) kills them all. The logs show this at 15:29:38
   local time on 2026-11-21: `terminal.cleanupSessions` was followed by 7 `runKillEscalation`
   spans.
5. **What Orca does.** PTYs live in a **detached daemon** that outlives the app. Every session
   has an **always-on headless emulator** with 1000 rows. The renderer **parks** hidden terminal
   views with hysteresis (30 s delay, 4–6 warm, 5–15 min TTL) and restores them from the daemon
   snapshot. Terminals that cannot be restored are **never evicted**. Killing idle agents
   ("hibernation") is experimental, off by default, and resumes the agent through its resume
   command.

**Recommended first fix (small, and it fixes the regression):** make mounted terminal drawers
independent of the project catalog and of route gates. Concretely:

- Retain the project dependency for every mounted terminal thread.
- Stop returning `null` when the project lookup disappears; use the cwd that was bound at mount.
- Lift the drawer host above `ThreadProjectGate` and the route loader.
- Fix the LRU order of the hidden-drawer cap.

After that, turn on the recovery mirror by default, then make local PTYs survive backend
restarts (§6).

## 1. Method and scope

- I read the web terminal lifecycle: chat view drawer host, terminal viewport session, the
  terminal and project stores, and the route gates.
- I read the server lifecycle: manager open/close/eviction/idle/shutdown, output delivery and
  holds, the recovery model, read-model residency, and archive/delete/remote-disconnect.
- I read the user's logs read-only: `~/.bigbud/userdata/logs/server.trace.ndjson*`,
  `~/Library/Application Support/bigbud/logs/{server-child,desktop-main}.log`, and
  `~/.bigbud/userdata/logs/terminals/`.
- I ran two existing focused test files (no code changes). See §4.
- I cloned Orca read-only at
  [`da1c201e2b`](https://github.com/stablyai/orca/tree/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6)
  (MIT licence) into the job tmp directory and deleted it afterwards. No code was copied.
- **Prior art:** `docs/reports/terminal-recovery-2026-11-01.md` covered the same symptom ("TUI
  unusable after switching among roughly 2–4 threads"). It shipped "live reattach" (`375ea2d7b7`)
  on the premise that "hidden drawers stay mounted for up to ten threads, so plain switching was
  not the trigger". RC1 shows that premise has not held since 2026-11-09.

**Not done:** a live GUI reproduction with a real opencode/claude TUI. There is no driveable
desktop session from this agent. §4 gives exact manual steps and the built-in diagnostics hook
to confirm the mechanism.

## 2. bigbud terminal lifecycle

### 2.1 Server: what can actually kill a PTY

| Path                                                                       | Evidence                                                                                                                                                                                                                                                                                     | Triggered by a thread switch? |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| Explicit close RPC                                                         | `apps/web/src/components/terminal/terminalLifecycle.operations.ts:37-83`, called only from the close buttons and `mod+w` (`useThreadTerminalDrawer.ts:245-262`, `ChatView.terminalActions.logic.ts:165-182`, `ChatView.keybindings.logic.ts:96-101`, the binding is `when: "terminalFocus"`) | No                            |
| Thread archive                                                             | `apps/server/src/ws/wsRpcHandlers.orchestrationServer.ts:195-204`                                                                                                                                                                                                                            | No                            |
| Thread delete                                                              | `ProviderCommandReactorHandlers.delete.ts:145`, `…delete.cleanup.ts:70`                                                                                                                                                                                                                      | No                            |
| Remote disconnect of a direct-SSH target                                   | `apps/server/src/ws/wsRemoteConnection.steps.ts:70-86` (explicit Disconnect only)                                                                                                                                                                                                            | No                            |
| Backend shutdown                                                           | `apps/server/src/terminal/Layers/Manager.process.shutdown.ts:15-38`: kill escalation unless `process.detach` exists (owned or supervisor PTYs)                                                                                                                                               | No, but it looks the same     |
| Inactive-session eviction (`DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128`) | `Manager.process.eviction.ts:12-16`: only sessions with **no process** that are not running                                                                                                                                                                                                  | No (never a live PTY)         |
| Read-model eviction (F-B4)                                                 | `ReadModelResidencySweeper.ts:11,28-36`: threads with an active terminal are kept                                                                                                                                                                                                            | No                            |
| Idle organisation rules                                                    | `Manager.idleWork.ts:14-42`: a running subprocess or agent counts as busy. The rules move threads between buckets; they do not close terminals                                                                                                                                               | No                            |
| Recovery-model budget                                                      | `TerminalRecoveryModel.budget.ts:14-16` "Never evict a PTY"                                                                                                                                                                                                                                  | No                            |

Reattach is safe. `Manager.session.open.ts:79-80` says "Open means reattach, never reinterpret
mutable chat launch settings as a restart". An existing process gets a resize and a snapshot,
never a respawn. Delivery holds are released when a subscription closes
(`TerminalOutputDelivery.ts:91-99`). Unmounting a view
(`TerminalViewport.session.ts:329-350`) only unsubscribes and disposes the renderer. It never
calls close.

### 2.2 Web: how hidden terminals are kept, and where that breaks (RC1)

The design keeps one `PersistentThreadTerminalDrawer` per recently used thread:

- `ChatViewContent.tsx:145-166` maps `base.mountedTerminalThreadIds`. Non-active threads get
  `presentation="hidden"`; they stay `invisible absolute` (`ChatView.terminalDrawer.tsx:95`).
- `ChatView.logic.ts:46,93-121`: `MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10`.
- `chat-view-thread-derived.hooks.ts:91-110` reconciles the list on every switch.
- Hidden views keep parsing output on a paced lane (`TerminalWriteBatcher.ts:107`) and keep
  their WebGL context for 30 s (`TerminalRendererController.ts:9`, policy file lines 1-7).

That design is sound. The problem is that the drawer host lives inside `ChatView`, which sits
inside the route gates, and each hidden drawer depends on live catalog data:

**RC1a: project eviction unmounts the hidden drawer (the most likely match for "2–5 threads").**

1. `ThreadProjectGate` → `useProjectReadiness` retains only the **active route's** project
   (`apps/web/src/hooks/useProjectReadiness.ts:17-19`). Nothing else retains a hidden terminal
   thread's project (`grep useProjectReadiness(` finds only `ThreadProjectGate.tsx:15` and
   `useCompactChatThread.ts:82`).
2. On release, `retainProjectDependency` calls `pruneProjectDependencies(next, projectId)`
   (`apps/web/src/lib/projectDependencies.ts:7-15`). That function **evicts the released project
   immediately** if it is dependency-only (`helpers.projectDependencies.store.ts:52-63`: the
   `project.id === releaseId` branch ignores `PROJECT_DEPENDENCY_CACHE_LIMIT`). The existing
   test asserts this behaviour (`apps/web/src/lib/projectDependencies.test.ts`, "releases mounted
   … lookups": projects go from 2 to 1 on release).
3. Projects become dependency-only easily:
   - Startup loads only 2 local projects (`-__root.bounded-bootstrap.ts:24`) and 1 remote
     (`STARTUP_PROJECT_CATALOG_DEFAULT_LIMIT = 1`).
   - Every bounded bootstrap or recovery re-marks projects outside the page as dependency-only
     (`projectDependencyMembership`, `helpers.projectDependencies.store.ts:16-47`).
   - `runBoundedBootstrap` also runs whenever the user opens a thread that is not in the store
     (`_chat.$threadId.tsx:205-228`).
4. The hidden drawer reads `useProjectById(...)` (`useThreadTerminalDrawer.ts:73`). That becomes
   `undefined`, so `PersistentThreadTerminalDrawer` returns `null`
   (`ChatView.terminalDrawer.tsx:48,81-83`). `ThreadTerminalDrawer` and every `TerminalViewport`
   unmount, and the xterm instances are disposed. The PTY keeps running on the server.
5. When the user returns, the project is re-fetched, the drawer re-renders (`shouldRender` stayed
   true), and a **fresh** viewport attaches through snapshot. This runs into RC2.

So the trigger is "switched to a thread in another project whose catalog entry was only a lookup".
Two to five switches is a natural count for that. Switching between threads in the **same**
project, or in projects on the first sidebar page, does not trigger it. That explains why the
problem looks intermittent.

**RC1b: `ThreadProjectGate` unmounts `ChatView` when the target project is not loaded yet.**
`ThreadProjectGate.tsx:41-43` renders `{ready || readyProjectId === projectId ? children : null}`.
When the user switches into project Q that is not in the store, `ready` is false and
`readyProjectId` still holds the previous project. Children become `null` and `ChatView`
unmounts. `mountedTerminalThreadIds` is local `useState`
(`chat-view-base-state.ephemeral.hooks.ts:137`), so **every** hidden drawer of **every** thread
is lost. After `ChatView` remounts, only the active thread's drawer comes back. Introduced with
the gate in `e3e8efb854` (2026-11-09).

**RC1c: other route-level unmounts.**

- `_chat.$threadId.tsx:234-247` renders a logo placeholder instead of the gates and `ChatView`
  while `!bootstrapComplete || !routeThreadExists`. That happens while a new draft thread's
  ownership is checked (`resolvingDraftOwnership`, lines 80-85 and 120-194) and while an unloaded
  thread is bootstrapped. Creating a new thread with `mod+n` and starting work there is a common
  "switch to another thread to work" path.
- `ThreadRemoteTargetGate.tsx:178` replaces children while a remote workspace is gated
  (`25f3f33953`).
- Leaving the `/_chat/$threadId` route (settings, automations) unmounts everything.

**RC1d: the right-panel terminal tab keeps no hidden threads.**
`RightPanelHost.tsx:205-221` → `TerminalPanel.tsx:30,67-95` renders `ThreadTerminalDrawer` for
`activeThreadId` only. Terminal viewports are keyed by terminal id, so every switch disposes the
previous thread's views.

**RC1e: the 10-drawer cap is not LRU.** `reconcileMountedTerminalThreadIds`
(`ChatView.logic.ts:100-120`) keeps `currentThreadIds` in first-mount order. It pushes the
active thread only if it is absent, then `slice(-max)` drops the **earliest mounted**, even if
that thread was just used. This only matters past 10 threads with open terminals, but it should
be fixed with the rest.

### 2.3 Why a rebuilt view looks closed (RC2)

- History: `TERMINAL_HISTORY_BYTE_LIMIT = 1 MiB`, `DEFAULT_HISTORY_LINE_LIMIT = 5000`
  (`Manager.history.retention.ts:4`, `Manager.types.ts:41`). Past the cap, `discard()` clears the
  **entire** history and sets `historyTruncated` (`Manager.history.retention.ts:29-38`). There is
  no rolling tail. A spinner-heavy TUI such as opencode or Claude Code gets there in minutes.
- The recovery mirror (`@xterm/headless`, `TerminalRecoveryModel.ts:1,338-362`) returns
  `undefined` unless `BIGBUD_TERMINAL_RECOVERY=1`. Nothing in the repo sets that variable
  (`grep` finds only the source and `dist`). Its budget also admits only about 4–6 models
  server-wide: 256 MB total at roughly 41–54 MB each (`TerminalRecoveryModel.budget.ts:9-30`).
- The default "live reattach" path (`375ea2d7b7`) re-asserts input modes and nudges a one-row
  resize. It then shows the amber toast "Earlier output couldn't be restored, so the program was
  asked to redraw. Nothing was restarted." (`TerminalViewportStatus.toasts.ts:103`). The earlier
  report lists the limits: programs that do not fully repaint on SIGWINCH stay blank, and
  scrolled-away output is gone.

### 2.4 Paths checked and ruled out

- `removeOrphanedTerminalStates` (`terminal.store.ts:332`, called from
  `-__root.recovery.snapshot.ts:28-36`) drops terminal UI state for threads that are missing from
  the client store. Client thread lists are merged, never trimmed (`helpers.lazy.store.ts:37-78`),
  so a thread the user worked in stays. The legacy `syncServerReadModel` does replace the list,
  but nothing in the current boot path calls it. If it ever ran with an F-B4-evicted read model,
  it would orphan terminal tabs while their PTYs kept running. Worth a guard (§6, P1).
- Inventory reconciliation (`terminal.store.inventory.ts:8-45`) clears observations only, not
  panes.
- Output holds: hidden views keep acknowledging output, and holds are released on unsubscribe.
  Overflow ends the subscription, which leads to a client resync and RC2, never a kill
  (`TerminalOutputDelivery.ts:126-143`).
- `MAX_HYDRATED_THREADS = 8` (`helpers.lazy.eviction.store.ts:9`) unloads transcripts only. It
  does not touch terminals.

## 3. Evidence from the user's logs (read-only)

- `server.trace.ndjson*` covers 2026-11-19 to 2026-11-21. The only kill-related spans are:
  - 7 × `ws.rpc.terminal.close` → `terminal.closeSession` → `terminal.stopProcess`, all on
    11-21: 09:09:59, 09:10:13, 09:16:57, 09:26:36, 13:37:59, 13:50:49 and 13:51:33. These are
    client-initiated closes; the RPC is only sent by the close button or `mod+w` in a focused
    terminal.
  - 1 × `terminal.cleanupSessions` at **15:29:38**, followed by **7 ×
    `terminal.runKillEscalation`**. That is backend shutdown killing 7 live PTYs.
  - There are no eviction or reap spans. Terminal spans carry no `threadId`/`terminalId`/reason
    attributes, so a close cannot be tied to a thread from the trace (see recommendation P1-e).
- `~/Library/Application Support/bigbud/logs/server-child.log`:
  - `[2026-11-21T14:29:39.794Z] event=child_exit generation=1 pid=88899 code=130`, i.e. the
    backend exited on SIGINT.
  - It was preceded by `delivery.end_reason: server-shutdown` and `provider adapter stopAll timed
out`, then `event=startup_requested generation=2`.
  - `desktop-main.log` has no lines in that window, so the source of the SIGINT is unknown.
- The terminal history files in `~/.bigbud/userdata/logs/terminals/` are small and contain no
  exit markers. They are not conclusive.

**Conclusion:** the logs support "the server never closed a terminal on its own during
switching". They show one real mass kill caused by a backend restart (RC3). Whether a given
"closed" report was RC1/RC2 (process alive) or RC3 (process killed) cannot be told from the logs.

## 4. Reproduction and tests

**Focused tests run (unchanged code):**
`bun run --cwd apps/web vitest run src/lib/projectDependencies.test.ts src/components/chat/view/ChatView.logic.test.ts`
→ 2 files, 25 tests passed. The first file shows that releasing the last owner evicts a
dependency-only project immediately (the RC1a precondition). The second shows that the cap only
keeps threads in `currentThreadIds` order (RC1e).

**Existing tests that assume hidden drawers stay mounted (they do not cover RC1):**

- `ChatView.terminalDrawer.browser.tsx` uses a fixture with fixed project data, so the project
  never disappears.
- `TerminalViewport.navigationDiagnostics.browser.tsx` and `Manager.navigationRecovery.test.ts`
  check that the same process survives four other threads, using a fake PTY.

**Manual reproduction (recommended before fixing):**

1. Have more than 2 local projects, so that project P is not on the first catalog page. Restart
   the app so that P becomes dependency-only.
2. In DevTools run `window.__bigbudTerminalLifecycleDiagnostics.setEnabled(true)` (defined in
   `TerminalLifecycleDiagnostics.ts:37-55`).
3. Open thread A in P, open the terminal and run `opencode` until it has produced more than
   1 MiB of output (a few minutes of spinner).
4. Switch to a thread in project Q, then to one or two more, then back to A.
5. Run `window.__bigbudTerminalLifecycleDiagnostics.read()`. RC1 predicts a `disposed` event for
   A's `viewId` right after the first switch, then a new `mounted` event, then
   `hydration: "reattached"` on return. Check that the PID in the `snapshot` event is unchanged
   (process alive).
6. Control: repeat with threads in the **same** project. RC1 predicts no `disposed` event.

## 5. Orca: how it keeps terminals alive

Pinned to
[`da1c201e2b`](https://github.com/stablyai/orca/tree/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6).
MIT licence (copyright Lovecast Inc.). Ideas are adapted below; no code was copied.

| Topic                          | Orca                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PTY ownership                  | Detached terminal daemon that outlives Electron: `detached: true`, plain Node via `ELECTRON_RUN_AS_NODE`, cwd set to userData ([daemon-launched-child-spawn.ts L95-L112](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/launch/daemon-launched-child-spawn.ts#L95-L112)). Its socket-ownership rules ([daemon/AGENTS.md](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/AGENTS.md)) exist because a lost socket "reads to the user as terminals that accept keystrokes and never run them".                                                                                                                                                                                                                                                                                                      |
| Screen state                   | Every session's output plane owns a `HeadlessEmulator`, always on ([session-output-plane.ts L51-L66](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/sessions/session-output-plane.ts#L51-L66)), with a 1000-row live window "to bound live grid memory across many terminals; durable history supplies the deeper restore window" ([daemon-session-scrollback-window.ts L4-L5](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/sessions/daemon-session-scrollback-window.ts#L4-L5)).                                                                                                                                                                                                                                                                                                              |
| Durable history / cold restore | On-disk history and checkpoints for restore after a daemon or app death ([history/storage](https://github.com/stablyai/orca/tree/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/history/storage), [history/restoration](https://github.com/stablyai/orca/tree/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/history/restoration)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Hidden views                   | "Parking" with hysteresis: `TERMINAL_WORKTREE_COLD_PARK_DELAY_MS = 30_000`, hot-retain 4 worktrees or 6 tabs for 5 min ([terminal-hidden-view-parking.ts L8-L15](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/components/terminal-pane/parking/retention/terminal-hidden-view-parking.ts#L8-L15)), and a hidden-worktree cap of 4 with a 15 min TTL ([terminal-hidden-worktree-retention.ts L14-L16](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/components/terminal-pane/parking/retention/terminal-hidden-worktree-retention.ts#L14-L16)). Real LRU with the last-active exemption ([L207-L230](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/components/terminal-pane/parking/retention/terminal-hidden-view-parking.ts#L207-L230)). |
| Safety rule                    | Only views with an authoritative daemon snapshot are parked. "Unrestorable live local PTYs keep their tab mounted through force-park" ([terminal-hidden-worktree-retention.ts L45-L71](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/components/terminal-pane/parking/retention/terminal-hidden-worktree-retention.ts#L45-L71), [L61-L72 of the parking file](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/components/terminal-pane/parking/retention/terminal-hidden-view-parking.ts#L61-L72)).                                                                                                                                                                                                                                                                                            |
| Parked output                  | Parked tabs keep byte, command-status and agent watchers, so attention and completion still work while unmounted ([parking/output-watchers](https://github.com/stablyai/orca/tree/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/components/terminal-pane/parking/output-watchers)).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Repaint on reattach            | The daemon owns a one-row resize nudge, so the restore survives a lost client; not used on Windows (ConPTY) ([session-repaint-nudge.ts L1-L40](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/sessions/session-repaint-nudge.ts#L1-L40)). bigbud already has the client-side equivalent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Limits                         | Admission rather than eviction: `DEFAULT_MAX_HOST_TERMINALS = 256`, "leave roughly half the default macOS PTY limit" ([host-terminal-ledger.ts L22-L36](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/admission/host-terminal-ledger.ts#L22-L36)). Optional cgroup memory limits on Linux only ([terminal-memory-limits.ts](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/main/daemon/process-scopes/terminal-memory-limits.ts)).                                                                                                                                                                                                                                                                                                                                                                          |
| Killing idle agents            | "Agent hibernation" is **experimental and off by default** (`experimentalAgentHibernation: false`, 30 min idle; [default-global-settings.ts L303-L304](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/shared/settings/default-global-settings.ts#L303-L304)). It only targets resumable TUI agents and wakes them through the agent's resume command ([agent-hibernation-planner.ts L12-L14](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/lib/agent-session/hibernation/agent-hibernation-planner.ts#L12-L14), [pane eligibility](https://github.com/stablyai/orca/blob/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6/src/renderer/src/lib/agent-session/hibernation/agent-hibernation-pane-eligibility.ts)).                                                                                                  |

**Takeaways for bigbud:**

1. Never let view lifetime decide process lifetime. bigbud already gets this right on the server.
2. Unmount a hidden view only when an authoritative snapshot can restore it. Otherwise keep it
   mounted. bigbud does the opposite today: it unmounts as a side effect of catalog and route
   state, while its snapshot path is off by default.
3. Make the backend-side emulator always on, with a bounded window.
4. Keep PTYs in a process that survives app and backend restarts.
5. Prefer admission limits with clear messages over silent eviction.

## 6. Recommendations

### Options compared

| Option                                                                                    | Fixes                                                   | Cost / risk                                                                                                                                                  |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A. Decouple mounted drawers from project catalog and route gates (P1)                     | RC1a–e                                                  | Small. Hidden xterms stay in memory (about 5000-row scrollback each). The cap of 10 still bounds it                                                          |
| B. Recovery mirror on by default, plus a rolling history tail instead of discard-all (P2) | RC2 for every remaining remount, reconnect and overflow | CPU about 80 ms/MiB parsed (prior measurement); about 40–55 MB reserved per model; budget needs rework                                                       |
| C. Local PTYs owned by the Rust supervisor, detached on backend shutdown (P3)             | RC3                                                     | Larger. The supervisor path exists (`remote-backend/localSupervisorPty.ts`, `process.detach` in shutdown) but is not the default for local desktop terminals |
| D. Orca-style parking with hysteresis instead of a fixed mount cap (P4)                   | Memory at scale                                         | Only safe after B. Views without a restorable snapshot must never be parked                                                                                  |
| E. Opt-in agent hibernation (kill idle agent, resume through its resume command)          | Memory/CPU with many idle agents                        | Product decision. Off by default, as in Orca                                                                                                                 |

### Recommended plan

**P1: fix the regression (client only, small)**

- a. While a `PersistentThreadTerminalDrawer` is mounted with an open terminal, retain its
  thread's project with `retainProjectDependency`, in that component or in
  `useThreadTerminalDrawer` for `mode === "drawer"`. Files:
  `apps/web/src/components/chat/view/ChatView.terminalDrawer.tsx`,
  `apps/web/src/components/terminal/useThreadTerminalDrawer.ts`.
- b. Once a drawer has mounted, do not return `null` when `project` or `cwd` briefly disappears.
  Viewports already freeze their launch binding (`TerminalViewport.launch.ts:7-31`); keep the
  last-known cwd for the drawer too.
- c. Lift the `mountedTerminalThreadIds` state and the drawer list out of `ChatView` into a host
  above the route gates: the `/_chat` layout (`apps/web/src/routes/_chat.tsx`), rendering into
  the active chat's terminal slot through a portal. This keeps drawers alive across
  `ThreadProjectGate` loading, the route placeholder, draft ownership checks and remote-gate
  states. A smaller alternative for `ThreadProjectGate.tsx:41-43` alone is to keep the previous
  children mounted (hidden) while the new project loads, instead of rendering `null`.
- d. Give the right-panel terminal tab the same per-thread retention: render panel drawers for
  recently used threads, not only the active one (`TerminalPanel.tsx`, `RightPanelHost.tsx`).
- e. Make `reconcileMountedTerminalThreadIds` a true LRU: move the active thread to the end on
  every activation (`ChatView.logic.ts`).
- f. Observability: add `threadId`, `terminalId` and a `reason` (`user-close`, `archive`,
  `delete`, `remote-disconnect`, `shutdown`) as attributes on `terminal.closeSession`,
  `terminal.stopProcess` and `terminal.cleanupSessions`. Have the web viewport record why it was
  disposed in lifecycle diagnostics. Then the next report can be traced to a cause.
- g. Guard `removeOrphanedTerminalStates`: never drop terminal UI state for a thread whose
  terminals the server inventory still reports as running.
- Tests:
  - A browser test that switches across threads in different dependency-only projects and
    asserts `Terminal.prototype.dispose` is not called for the hidden thread (extend
    `ChatView.terminalDrawer.browser.tsx`).
  - A `ThreadProjectGate` browser test: switching into an unloaded project keeps the drawers
    mounted.
  - A `projectDependencies.test.ts` case: a mounted terminal drawer retains its project.
  - A unit test for LRU ordering in `ChatView.logic.test.ts`.
  - A server test asserting the close spans carry a reason.

**P2: make remounts lossless**

- Default `BIGBUD_TERMINAL_RECOVERY` to on, after the remaining qualification items in
  `terminal-recovery-2026-11-01.md` ("Still open before default-on").
- Revisit the reservation formula (`TerminalRecoveryModel.budget.ts:22-30`). Its fixed 36 MB of
  headroom per model limits the server to about 5 mirrors. Orca runs one per session with 1000
  rows. When the budget is exhausted, show a warning rather than degrading silently.
- Replace discard-all history (`Manager.history.retention.ts:29-38`) with "mirror snapshot plus
  post-cut tail". Never treat an arbitrary VT suffix as a baseline (keep the existing
  invariant).

**P3: survive backend restarts**

- Make local desktop terminals run through the Rust supervisor/agent-owned PTY by default, so
  that `cleanupTerminalSessions` detaches instead of killing (`Manager.process.shutdown.ts:21-24`).
- Reattach on startup through the existing owned-recovery path (`Manager.owned-recovery.test.ts`
  covers it).
- Show a clear "terminals were stopped because the backend restarted" notice when a kill was
  unavoidable.

**P4: scale (only after P2)**

- Replace the fixed 10-drawer cap with Orca-style parking: a warm set of about 4–6 threads, a
  30 s cold-park delay and a 5–15 min TTL. Park a view only when its mirror can restore it; keep
  everything else mounted.
- Keep server-side activity and attention for parked terminals. The global
  `subscribeTerminalEvents` stream already provides this.
- Add an admission limit for live PTYs with a visible message (in the spirit of Orca's 256),
  never silent closes.

### Trade-offs to keep in mind

- **Memory.** Each hidden xterm holds its own scrollback (5000 rows). That is roughly tens of MB
  for wide panes. 10 hidden drawers with several panes each is the realistic upper bound before
  P4.
- **WebGL.** Visible and retained contexts are already budgeted (8 + 6 < 16). Hidden views fall
  back to the DOM renderer after 30 s.
- **CPU.** Hidden views keep parsing output on the paced lane. The mirror adds server-side
  parsing (about 1% of a core per terminal at 100 KB/s).
- **Remote terminals.** Remote-agent PTYs already live on the host, so P1/P2 are what matter for
  them. Direct-SSH terminals still die on Disconnect, which is by design.

## 7. Open questions for the user

1. When the terminal is "closed", which of these do you see?
   - (a) The drawer or tab is gone.
   - (b) The drawer is there but blank or partial, with an amber "reconnected … nothing was
     restarted" toast.
   - (c) A fresh shell prompt, and the TUI has exited.
2. Were the 2–5 other threads in **different projects** from the first one? Were any of them new
   threads (`mod+n`) or threads opened from search or other non-sidebar entry points?
3. Do you use the terminal in the **right panel** tab, the chat drawer, or both?
4. Did the app or backend restart around the time you noticed it? The logs show one backend
   restart at 15:29 today that killed 7 terminals.
5. Are you OK with the memory cost of keeping more hidden terminal views mounted (P1)? Should the
   recovery mirror become default-on (P2), at about 40–55 MB reserved per terminal?
6. Should local terminals survive backend and app restarts through the Rust supervisor (P3), even
   though that makes "quit bigbud" no longer stop running terminal programs unless you close
   them explicitly?
7. Do you want Orca-style opt-in agent hibernation (kill idle TUI agents and resume them through
   their resume command), or should bigbud never stop a process the user did not close?
