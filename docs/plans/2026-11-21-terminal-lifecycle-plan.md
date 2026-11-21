# Terminal lifecycle: Rust-owned terminals, screen copies, parking, idle close and limits

**Date:** 21 November, 2026
**Status:** Ready for implementation (plan guide status: Proposed). Revision 2 addressed the first review (findings 1–20). Revision 3 addresses the re-review (N1–N12 and the other fixes). §24 maps them all. Two engineering gates remain. They are part of the plan, not open product decisions: dependency approval for the VT emulator crate (M0) and the Q1 qualification before default-on.
**Owner:** bigbud engineering; written by the planning agent.

## 0. Metadata

| Field                   | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Created                 | 2026-11-21T18:14+01:00                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Last modified           | 2026-11-21T19:25+01:00 (revision 4: third-review fixes F1–F8, §24)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Project root            | `/Users/youpele/DevWorld/bigbud`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Inspected branch        | `dev`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Inspected commit        | `b2e8cd0d7087f3840a0c9fa4384fbb982908dd9c`. The session started at `25f3f33953`. Another agent committed while this plan was being written                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Worktree at inspection  | Dirty with unrelated, uncommitted work by other agents (§15 lists which milestones must wait for it):<br>(a) Thread deletion and Direct SSH/WSL shell owners. Server: `DirectShellLaunchOwners.ts`, `DirectShellLaunch.owner.ts`, `DirectShellLaunch.dispatch.test.helpers.ts`, `Manager.session.close.ts`, `Manager.session.ts`, `Manager.shell.direct.policy.ts`, `terminal/Services/Manager.ts`, `ws/wsRpcHandlers.terminalRemote.ts`, `ThreadDeletion.mode.ts`, `ProviderCommandReactorHandlers.delete*.ts`, `ThreadRetention.direct.ts`, new `Manager.session.shellOwners.ts`. Web: `rpc/wsNativeApi.terminal.ts`, `rpc/wsRpcClient.terminal.ts`, `rpc/wsRpcClient.terminal.types.ts`, `-__root.recovery.ts`, `sideChat.actions.ts`, new `lib/threadDeletionRemoteShell.ts`. Contracts: `server/rpc.ts`, `server/rpc.terminalRemote.ts`, `server/ipc.nativeApi.terminal.ts`, `constants/websocket.constant.ts`, new `workspace/terminal.shellOwners.ts`.<br>(b) **W0 of this plan, in progress** by another implementer: `ChatView.terminalDrawer.tsx`, `useThreadTerminalDrawer.ts`, `ThreadProjectGate.tsx` and its browser test, `ChatView.logic.test.ts`, new `ChatView.terminalDrawer.project.browser.tsx`.<br>The planner wrote only this plan file |
| Related issue/note/card | None identified. No bigbud note or Kanban card was supplied, and none was found. None was invented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

## 1. Summary

Terminals move out of the web view and the Node backend's process tree into a **Rust terminal
host**. The host is the existing `bigbud-remote-agent` binary running in supervisor mode, from a
copy staged under bigbud's state folder. That binary is already the remote PTY owner and the
remote-backend local supervisor. For each terminal the host:

- owns the PTY;
- keeps a headless screen model of about 1,000 rows;
- saves a rolling scrollback tail to disk;
- tracks idle and busy facts;
- enforces limits and handles memory pressure, but only for PTYs whose client opted in.

The Node server keeps the domain mapping (thread → terminal → host PTY), RPCs, settings and launch
parity with today's shells. The web app keeps drawer and panel state in global stores. xterm views
live in a registry outside React route gates. Views are parked (unmounted) and restored exactly
from the host's screen copy.

What users will see:

- A new thread has no terminal.
- Switching threads never affects a terminal.
- Reopening a terminal shows exactly what was on screen.
- Terminals survive a backend restart or crash.
- Idle terminals close after 10 minutes, with a warning and a **Keep open** action.
- Under memory pressure, the least recently used terminal that is hidden and not busy closes, with a toast.
- At the hard limit, bigbud asks before closing the oldest terminal.
- Quitting closes every terminal unless **Keep terminals running after quitting** is on.

## 2. Related work

- Investigation (RC1–RC3, Orca §5, recommendations §6):
  `docs/reports/2026-11-21-terminal-thread-switch-investigation.md`.
- Recovery work and the default-off TS headless mirror:
  `docs/reports/terminal-recovery-2026-11-01.md`. This plan honours two of its rules:
  - "No separate JavaScript daemon is permitted. A hypothetical future daemon would be Rust."
  - "Do not connect the backend mirror's `onData` to PTY input". Host-side query replies run only while no renderer is attached (§8.9).
- `docs/plans/2026-10-10-terminal-rust-gpu-reliability-plan.md` §6–7. It proposed a separate
  `bigbud-terminal-owner` crate and a TS state host. Those milestones never started. This plan
  **supersedes the local-owner part** (§6.1).
- `docs/decisions/2026-08-22-rust-remote-workspace-agent-boundary.md` and `crates/AGENTS.md`.
- `docs/plans/2026-11-05-terminal-work-thread-idle-protection-plan.md` (`Manager.idleWork.ts`) and
  `docs/plans/2026-11-19-terminal-activity-recency-plan.md` (`TerminalActivity`,
  `terminalViewRegistry.ts`). Both are reused.
- Orca (MIT) at
  [`da1c201e2b`](https://github.com/stablyai/orca/tree/da1c201e2ba62ff55ecf069b99ea827b2b9b6ce6):
  ideas only (detached daemon, 1,000-row headless emulator, 30 s park delay, warm set of 4,
  admission rather than eviction). No code is copied.
- External facts checked on 2026-11-21 (crates.io API):
  [`vt100` 0.18.1](https://crates.io/crates/vt100) (MIT, released 2026-10-19) and
  [`alacritty_terminal` 0.26.0](https://crates.io/crates/alacritty_terminal) (Apache-2.0,
  released 2026-04-06).

## 3. Problem (evidence)

From the investigation report, verified against this commit where cited:

- **RC1: views are thrown away as a side effect of catalog and route state.**
  - The hidden `PersistentThreadTerminalDrawer` returns `null` when its project is evicted (`ChatView.terminalDrawer.tsx:81-83`).
  - `ThreadProjectGate.tsx:41-43` rendered `null` children while an unloaded project loaded.
  - The route logo placeholder (`_chat.$threadId.tsx:234-247`) and `ThreadRemoteTargetGate.tsx:178` replace `ChatView`.
  - `mountedTerminalThreadIds` is local to `ChatView`.
  - The right-panel terminal renders only the active thread (`TerminalPanel.tsx:30,67-95`).
  - **Correction (revision 2):** the investigation's RC1e ("the 10-drawer cap is not LRU") is wrong. The W0 implementer found that `reconcileMountedTerminalThreadIds` (`ChatView.logic.ts:100-124`) already keeps the least-recently-activated order. No LRU fix is needed.
- **RC2: a rebuilt view looks dead.**
  - Past 1 MiB or 5,000 lines, `retainTerminalHistory` discards the whole history (`Manager.history.retention.ts:4,30-38,49,60`; `Manager.types.ts:41`).
  - The headless mirror is off unless `BIGBUD_TERMINAL_RECOVERY=1`.
  - The fallback is a SIGWINCH repaint probe plus an amber "Earlier output couldn't be restored" toast.
- **RC3: local PTYs die with the backend.**
  - In local mode, `server.pty.ts:23-31` uses in-process `NodePTY`/`BunPTY`.
  - Shutdown kills each process unless it has `detach` (`Manager.process.shutdown.ts:21-31`).
- **No lifecycle policy exists.**
  - Nothing closes idle terminals, reacts to memory pressure, or limits live PTYs with a user-facing flow. The agent's only limit is a silent 64-session cap (`session/core.rs:109`).
  - A thread always lists an implicit `"default"` terminal (`helpers.store.ts:205-218`).
  - Persisted panes are re-opened, which spawns new shells, after a restart.
  - The right panel creates a terminal on every thread switch while it is open (`TerminalPanel.tsx:24-35`).

## 4. Goals and definition of done

Every user decision maps to the acceptance criteria in §21.

1. **D1 lifecycle.**
   - A new thread has no terminal. One exists only after the user opens one (drawer or right panel).
   - Minimize hides the terminal and keeps it running.
   - Close ends the process, and the thread then has no terminal.
   - The sidebar shows threads with a running terminal.
   - Nothing spawns or keeps a PTY implicitly, including the right panel.
2. **D2 ownership.**
   - Terminals run in the Rust host, outside the web view and the backend's kill tree.
   - Rust owns PTYs, screen state, scrollback persistence, idle/busy facts and limits:
     - local terminals on macOS and Linux now, Windows in M10;
     - remote-agent terminals, with the same code on the remote host;
     - Direct SSH, with the feasible scope stated in §7.2.
   - Local shells keep today's launch behavior (shell integration, PATH, hooks). That is S6.
3. **D3 screen copy.**
   - The host keeps a headless screen model (visible rows plus 1,000 scrollback rows) and a rolling tail on disk.
   - Reopening a terminal restores exactly what was shown, with no blank screen and no "couldn't be restored" toast for host-backed terminals.
   - The discard-all history is replaced by a rolling tail, both in the host and in the in-process fallback.
4. **D4 views.**
   - Views are unmounted about 30 s after the user switches away or minimizes.
   - The 4 most recent surfaces stay warm.
   - Only fully restorable views are unmounted.
   - Drawer and view state live above route gates and do not depend on project readiness.
5. **D5 idle close.**
   - An unused terminal closes after 10 minutes, with a 60 s warning and **Keep open**.
   - The user-decided busy rule applies (§8.5).
6. **D6 memory pressure.**
   - The host closes the least recently used terminal that is hidden and not busy.
   - It never closes a visible or busy one.
   - A toast names the closed terminal.
   - Measurement is defined in §8.6.
7. **D7 hard limit.**
   - At 24 live managed terminals per host, a new terminal is refused.
   - A dialog offers "Yes, continue — the oldest terminal will be closed whether it is active or not". Setup scripts follow §8.8.
8. **D8 quit.**
   - Quitting closes every terminal by default.
   - **Keep terminals running after quitting** lets them outlive the app and reattach on the next launch.
   - Terminals survive a backend restart or crash in both modes.

## 5. Non-goals

- Restoring live processes across a host crash or an OS reboot. Only the last screen is shown, read-only.
- Keeping Direct SSH sessions alive through network loss. That needs the remote agent or tmux.
- Agent hibernation and resume.
- Changing the renderer, WebGL policy, fonts or themes beyond what parking needs.
- Encrypting scrollback at rest. It is protected by OS user permissions and excluded from Time Machine (§12).
- User settings for the idle timeout or the limit. Both are server-pushed host policy constants.
- A mobile-web terminal surface. `apps/mobile-web` has no terminal UI (only orchestration events: `apps/mobile-web/src/logic/mobileOrchestrationEvents.*`), so it is unaffected.
- Copying Orca code, or putting domain or provider logic in Rust.

## 6. Current architecture map (file:line)

### 6.1 PTY ownership today

| Mode                         | Owner                                                                                                                                                                                                                                          | Survives backend restart?             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Local (desktop / standalone) | In-process `NodePTY`/`BunPTY` (`apps/server/src/server.pty.ts:23-31`)                                                                                                                                                                          | No (`Manager.process.shutdown.ts:26`) |
| Remote-backend mode          | `bigbud-remote-agent --supervisor` systemd account service in `~/.bigbud/agent`, adopted by `RemoteLocalSupervisorPtyLive` (`remote-backend/localSupervisorLayer.ts:35-182`) through `makeLocalSupervisorPty` (`localSupervisorPty.ts:28-110`) | Yes                                   |
| Remote-agent targets         | Remote supervisor, composed by `makeRemoteAgentPtyAdapter` (`remote-agent/remoteAgentPtyAdapter.ts:131-170`, wired in `server.ts:161-171`)                                                                                                     | Yes                                   |
| Direct SSH targets           | Local `ssh -tt` client in a local PTY (`Manager.shell.remote.ts:5-25`, `ShellProfiles.remote.launch.ts:75-110`, `Manager.process.spawn.ts:70-83`)                                                                                              | No                                    |

Facts about the remote agent that constrain this plan:

**PTYs and the supervisor**

- PTYs use Unix `forkpty` (`pty/core.rs`, `pty/platform.rs`).
- Each PTY keeps a 4 MiB replay ring (`pty/core.rs:16`).
- Attach supports `after_sequence` and replay gaps (`pty.proto:82-98`). There is also detach, inventory and capability negotiation (`session/hello.rs:29-52`).
- The supervisor socket is bound and chmodded to `0700` at `supervisor/bootstrap.rs:14-16`.

**Frames**

- Frames are capped at `DEFAULT_MAX_FRAME_BYTES = 1 MiB`, in Rust (`crates/bigbud-protocol/src/lib.rs:13`, enforced at `supervisor/frame_reader.rs:85`) and in TS (`remoteAgentProtocol.ts:14`). Protocol 1.8.

**Workspace roots and session caps**

- Each owned PTY opens a **unique workspace root**, `terminal-${resourceId}` (`remoteAgentOwnedPty.ts:186-191`).
- Roots are never released and are capped at `MAX_WORKSPACE_ROOTS = 64` per process (`workspace_handlers.rs:11-18`, `session/core.rs:110`).
- `MAX_PTY_SESSIONS = 64` counts live sessions, retained exited sessions (`PTY_RESULT_RETENTION = 600 s`) and create failures (`pty_create.rs:57`, `session/core.rs:109-111`).

**Version adoption**

- `--prepare-supervisor` accepts a running supervisor only on an exact version **and** build digest match (`supervisor/prepare.rs:101-104`).
- On a mismatch it stops an empty host on Linux and reports an error on macOS (`prepare.rs:140-174`).
- The TS connection pool pins `buildDigest` and epoch (`remoteAgentConnectionPool.keys.ts:5-9`, `localSupervisorTransport.ts:52-59`). The local supervisor transport accepts only remote-backend target ids.

**Launch environment**

- `remoteAgentShellLaunch.ts:43` and `localSupervisorLaunch.ts:31-41` force `integration: "disabled"` and `platform: "linux"`.
- The agent takes `PATH`, `HOME` and `SHELL` from its own environment and drops a requested `PATH` (`pty/environment.rs:3,14-43`).

Decision (from user decision 2, settled): the local host is this same binary with its own state
root and its own adoption and launch rules (S1, S6). The 2026-10-10 boundary concern is honoured:
the new terminal core is a set of self-contained module folders that take already-authorized PTY
facts.

### 6.2 Server terminal manager

- Service API: `terminal/Services/Manager.ts:113-219`. "Open means reattach" (`Manager.session.open.ts:79-80`).
- History:
  - `Manager.history.retention.ts`, with tests in `Manager.history.retention.test.ts`;
  - `Manager.history-io.ts`;
  - `Manager.search.ts`;
  - the TS mirror in `TerminalRecoveryModel*.ts`.
- Idle work facts: `Manager.idleWork.ts:14-42`.
- View state: `terminal/activity/terminalViewRegistry.ts:21-56`, with lease `TERMINAL_VIEW_LEASE_MS = 120_000`, fed by `terminal.view` from `apps/web/src/hooks/useTerminalViewReport.ts`.
- Durable mapping: the `remote_agent_runtime_owners` table (`RemoteAgentRuntimeBindings.inventory.ts:8-55`), cap 256. The owner key is `JSON.stringify([threadId, terminalId])` (`Manager.process.spawn.ts:85`).
- Server-initiated opens: project setup scripts (`project/Services/ProjectSetupScriptRunner.ts`, `ws/wsBootstrap.setup.ts`, `ws/wsBootstrap.ts:196`).
- Desktop hints:
  - one-way fd 5 pipe with kinds `suspend|resume|online|offline` (`contracts/server/desktopLifecycleHint.ts:26`);
  - writer `apps/desktop/src/backend/backendLifecycleHintPipe.ts:14-19,72-125`;
  - reader `apps/server/src/system-sleep/desktopLifecycleHintReader.ts`.
    The server→main startup status pipe is `backendStartupStatusPipe.ts`.
- Quit: `prepareForAppQuit` (`apps/desktop/src/main.ts:273-287`) stops the backend with an 8 s SIGTERM→SIGKILL window (`backendShutdown.ts:14`). Updater quiescence lives in `main.bootstrap.ts:308-372` (`prepareForUpdateInstall`).
- Near the 400-line limit: `server.ts` 397, `main.ts` 400, `main.bootstrap.ts` 397, `rpc.ts` 392, `terminal.store.ts` 400, `Manager.process.ts` 393, `Manager.session.open.ts` 395, `remoteAgentPtyClient.ts` 398, `supervisor/core.rs` 399, `TerminalViewport.session.ts` 397, `TerminalViewport.tsx` 384, `-__root.logic.tsx` 385, `SidebarThreadRow.tsx` 379.

### 6.3 Contracts

- `workspace/terminal.ts`: open/close inputs (`:46-56`, `:97-106`), snapshot (`:121-158`), events (`:214-223`), errors (`:330`).
- `workspace/terminal.stream.ts`: inventory (`:37-42`), events stream items (`:45-50`).
- `workspace/terminal.recovery.ts`: `TERMINAL_RECOVERY_ANSI_MAX_CHARS = 1_048_576`.
- `constants/websocket.constant.ts:78-95`.
- `core/settings.ts:257-316`, using the `*SettingsFields` spread pattern.

### 6.4 Web

- Drawer list: `chat-view/ChatViewContent.tsx:145-167`, `chat-view-base-state.ephemeral.hooks.ts:137`, `chat-view-thread-derived.hooks.ts:91-110`, and `ChatView.logic.ts:46,100-124` (cap 10, already least-recently-activated).
- Drawer: `ChatView.terminalDrawer.tsx:44-149`.
- Gates: `ThreadProjectGate.tsx`. After W0 it keeps the previous ready subtree mounted, hidden and inert, while the next project loads. Window-level key handlers in that hidden `ChatView` may still be live.
- Right panel: `RightPanelHost.tsx:205-221` → `TerminalPanel.tsx`.
- Store:
  - `stores/terminal/terminal.store.ts`, `terminal.store.types.ts`;
  - default `"default"` terminal in `helpers.store.ts:54,205-218`;
  - inventory reconciliation in `terminal.store.inventory.ts:8-45`.
- Global terminal events: `routes/-__root.terminal-events.ts`, wired in `-__root.logic.tsx:341-352`.
- Close: `terminalLifecycle.operations.ts:37-83`.
- Viewport: `TerminalViewport.*`, `TerminalRendererController.policy.ts:2,7`.
- Sidebar: `SidebarThreadRow.tsx:51-60`, `SidebarThreadRow.status.ts:59-70`.
- Settings: `components/settings/TerminalSettingsSection.tsx` and its siblings.

## 7. Target architecture

```text
Web (React)                                Server (Node, domain authority)                   Rust terminal host (staged bigbud-remote-agent --supervisor --local-desktop-host)
---------------------------------------   -----------------------------------------------   -----------------------------------------------------------------
terminal stores (global, persisted)        TerminalManager                                    per managed PTY:
TerminalViewRegistry (outside gates)         ownerKey -> host pty_id (existing SQLite table)    forkpty child -> reader thread (never blocked by screen/spool)
  attached | warm | parked                   open / attachOnly / evict / keepOpen               -> ScreenActor (bounded try-send, 1000 scrollback rows)
  park after 30 s, warm set 4                screen splice (chunked snapshot reassembly)        -> SpoolWriter (bounded queue; 2x4 MiB + checkpoint)
view report (document visible + slot)        view-state push + lease-expiry timer               -> replay ring (existing 4 MiB) -> subscribers
lifecycle toasts / limit dialog / sidebar    policy push (lifecycle opt-in, idle, limit, orphan) ActivityTracker (input, output, foreground program, view)
                                             quit policy (acked quit hint) on shutdown           QueryResponder (only while no renderer attached)
                                             local launch parity (S6)                           host-wide: PolicyEngine, MemorySampler (OS, cgroup v2, RSS), notice ring
      <-- WebSocket RPC + streams -->              <-- framed protobuf, <= 1 MiB frames, Unix socket via the running host's own --proxy -->
```

### 7.1 Roles

- **Rust host.**
  - Owns: PTYs, ordered ingress, the screen model and serializer, the spool, activity facts, the bounded query responder, and the idle, memory, limit and orphan decisions.
  - Policy applies only to PTYs created with `lifecycle_managed = true`, and only after an opted-in policy push.
  - Knows nothing about threads, providers or titles.
  - Survives backend restarts: it is daemonized with `setsid` (Windows: `DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`) and runs from a staged binary under the state folder.
- **Server.**
  - Owns: the domain mapping and durable owners, host selection, adoption, RPCs, settings, launch specs, "no implicit spawn" (`attachOnly`), the screen splice, notice translation, and policy and view pushes.
  - Keeps a bounded rolling search tail (S4).
- **Web.**
  - Owns: panes, presentation, parking, toasts, dialogs, the sidebar indicator, the settings row, and accurate visibility reports.
  - Decides process lifetime only through an explicit Close or a confirmed limit eviction.

### 7.2 Local vs remote vs Direct SSH

| Kind                       | PTY owner                                    | Screen / spool / policy                                                            | Survives backend restart | Survives app quit (setting on)                                       |
| -------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------ | -------------------------------------------------------------------- |
| Local, macOS/Linux         | Local Rust host (`<stateDir>/terminal-host`) | Rust                                                                               | Yes                      | Yes                                                                  |
| Local, Windows (until M10) | In-process node-pty                          | S4 rolling tail and live reattach. Never parked. No idle, pressure or limit policy | No                       | No (the setting row is disabled with "Not available on Windows yet") |
| Remote-agent target        | Remote agent supervisor                      | Rust on the remote host (cgroup-aware memory)                                      | Yes                      | Yes                                                                  |
| Remote-backend mode        | Existing `~/.bigbud/agent` supervisor        | Rust once updated. The orphan policy is pushed as keep (§14)                       | Yes                      | n/a                                                                  |
| Direct SSH (M7)            | Local Rust host runs the `ssh` client        | Rust locally. Busy facts come from server remote-inspection hints                  | Yes                      | Yes, while the connection lives                                      |
| Remote agent < 1.9         | Remote agent                                 | No new capabilities: TS rolling tail and live reattach, never parked, no policy    | Yes                      | Yes                                                                  |

### 7.3 Local host: staging, launch, adoption (review findings 3, 5, 15, 18, N5, N6, N11)

1. **Binary staging.**
   - The server resolves the packaged binary the same way `localWorkspaceWatchAgent.binary.ts` does.
   - It copies it to `<stateDir>/terminal-host/runtimes/<buildDigest>/bigbud-remote-agent`, verifies the digest, sets `0700` and fsyncs (the `localSupervisorBinary.ts` pattern).
   - Hosts always run from a staged copy, so they survive AppImage FUSE unmounts, app moves and updates.
   - Runtimes not referenced by a live generation are garbage-collected at startup.
2. **State generations.**
   - Each host runs in `<stateDir>/terminal-host/state-<n>/`, passed as `BIGBUD_AGENT_STATE_DIR`, with socket `state-<n>/supervisor.sock`.
   - `n` increases when a fresh host must start beside an old one (item 6).
   - A socket path over 100 bytes is refused with a logged reason, and new terminals use the in-process fallback.
   - Tests use short `mkdtemp("/tmp/bbth-")` roots.
3. **Host records.** `<stateDir>/terminal-host/hosts.json`, mode `0600`, written atomically.
   - One record per generation: `{ generation, state: "launching" | "running" | "draining", binaryPath, agentVersion, buildDigest, protocolMajor, protocolMinor, capabilities, epoch, pid, pidStartTime, launchedAt }`.
   - A **provisional** record (`state: "launching"`, no PID) is written **before** launch. This covers a crash between launch and the final write (`state/core.rs:58-66`, `prepare.rs:105-110`).
   - Records are used **only** to verify a PID before signalling it. They are never used to judge compatibility.
   - **Where PID and start time come from.** R4 adds `process_id` and `process_start_time_ms` to `AgentHello`; the host fills them from `/proc/self/stat` or `proc_pidinfo`. S1 verifies a PID with `LC_ALL=C ps -o lstart= -p <pid>` (macOS and Linux) against the recorded start time, within 1 s tolerance.
4. **Adoption.** The local host never uses `--prepare-supervisor`.
   - For each record, and for any `state-*/supervisor.sock` with no record (the crash case), check the socket is secure, then connect.
   - Connect through the **currently staged** binary's `--proxy`, or directly to the socket. `--proxy` is a pure byte forwarder (`supervisor/proxy.rs:4-31`), so its version does not matter.
   - Compatibility comes **only from the hello**: protocol major plus capabilities. The pool binding (digest, epoch) is taken from that hello. The dedicated transport factory in `terminal-host/` uses target id `local-terminal-host`.
   - A record found only through its socket is rewritten from the hello.
   - **Connection bindings per generation (F2).**
     - All generations share target `local-terminal-host`. Each generation is its own connection binding under that target: `connectionId = "state-<n>"`, plus the epoch from its hello. Owner rows already key on target plus connectionId and epoch (`Migrations/111_RemoteAgentRuntimeBindings.ts`, `remoteAgentOwners.ts`, `RemoteAgentRuntimeBindings.inventory.ts:40-55`).
     - The **admitted** binding (the one that receives new terminals) is the newest compatible generation.
     - A draining generation keeps its own binding for as long as any owner row references it. Reattach routes each owner to the binding named in its row.
5. **Deciding whether an old host is empty** (it cannot be reached, or it speaks another major version):
   - It is **live** if the durable owners table has `local-terminal-host` rows whose connectionId and epoch match that generation, **or** the verified PID has OS child processes (`ps -A -o ppid=,pid=` scan).
   - If the PID cannot be verified, the answer is unknown, and **unknown means live**.
   - Only a host proven empty (no owners, a verified PID, no children) is sent SIGTERM, followed by a 3 s wait. A live or unknown host is **never killed**. It is marked `draining`, and a one-time amber toast offers **Close them**: a user-confirmed SIGTERM to the verified PID, refused if the PID cannot be verified.
6. **Missing capabilities or another major version.**
   - An adopted host that lacks any required new capability (`terminal.screen`, `terminal.lifecycle`, `terminal.local-launch`, `terminal.query-responder`) never receives new terminals. The same applies to a host on another major version.
   - The server starts a **fresh host under the next state generation**, with its own socket and record.
   - The old host is marked `draining`. Its existing terminals stay attached if it is compatible and are otherwise reported per item 5. It exits by itself once it is empty if it supports `--exit-when-orphaned-and-empty`; otherwise it is sent SIGTERM only when proven empty.
   - The in-process fallback is used only when no host can be started.
7. **Launch.**
   - Command: `<staged> --supervisor --local-desktop-host --exit-when-orphaned-and-empty`. Before R5 lands, S1 uses `--supervisor` with `spawn({ detached: true })` and stdio to `state-<n>/host.log`.
   - **Minimal explicit environment**: `HOME`, `USER`, `LOGNAME`, `TMPDIR`, `LANG`/`LC_*`, a minimal `PATH`, `BIGBUD_AGENT_STATE_DIR`. Shell environment comes per PTY from S6.
   - Poll for the socket for up to 5 s, then write the final record.
8. **Policy push** on every connect (§8.7). Startup reattach uses owned recovery.
9. **Self-exit** after 60 s with no live PTYs and no connected owner.
10. **Concurrency.** Stable and dev builds have different `stateDir`s, so they get different hosts. A test runs both at once.

## 8. Data and state model

### 8.1 Identities

- `ownerKey = JSON.stringify([threadId, terminalId])` maps to a host `pty_id` through `remote_agent_runtime_owners`, with target `local-terminal-host` for the local host. There is no `authorityId` in local mode.
- Host output sequences are per PTY and monotonic. A snapshot names `through_sequence`, and the splice drops live output at or below it.
- The generation is the existing `runtimeGeneration`.

### 8.2 Registries

| Registry          | Owner                         | Persistence                                                 | Content                                                                                                                                                        |
| ----------------- | ----------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Live PTYs (truth) | Rust host                     | Memory plus `terminals/*/meta.json`                         | `pty_id`, pid, generation, `lifecycle_managed`, last input, output and focus, view and renderer state, foreground facts, warning state, model state, spool ref |
| Host identity     | Server                        | `<stateDir>/terminal-host/hosts.json`                       | §7.3 item 3                                                                                                                                                    |
| Domain mapping    | Server                        | Existing `remote_agent_runtime_owners` table (no new table) | `ownerKey` → target, `pty_id`, digest                                                                                                                          |
| Server sessions   | Server `TerminalManager`      | Memory, rebuilt from host inventory                         | Plus `screenSource`, `restorable`, `hostActivity`                                                                                                              |
| UI panes          | `terminal.store`              | localStorage (versioned migration, W1)                      | Panes per surface, groups, labels, `open`, `paneOrigin: "user-created" \| "restored"`                                                                          |
| View instances    | `TerminalViewRegistry`        | None                                                        | `attached \| warm \| parked`, last attached time, restorable                                                                                                   |
| Sidebar liveness  | `terminalLiveness.store` (W3) | None                                                        | Per thread: live terminal ids, busy flag, warning deadline                                                                                                     |

### 8.3 Scrollback files (host)

- **Layout.** `<state_root>/terminals/<hex(sha256(pty_id))[0..32]>/` contains:
  - `meta.json`;
  - `checkpoint.bin`, written via `.tmp` then fsync then rename;
  - `seg-0.raw` and `seg-1.raw`, up to 4 MiB each, rotating.
- **Rolling tail.** When the active segment is full, write a checkpoint and then reuse the older segment. Budgets:
  - about 8 MiB of raw output plus a checkpoint of at most 2 MiB per terminal;
  - 512 MiB per host. Closed and lost spools are evicted first, then live spools shrink to one segment.
- **Checkpoints and writes.**
  - Checkpoint every 30 s while output arrives, on the idle transition, on graceful shutdown, and on `PtyCloseAll`.
  - Segment writes are buffered (64 KiB) and flushed every 2 s on the spool writer's own thread.
- **Cold restore.** After a host crash, inventory reports `lost`. A snapshot rebuilds the screen from the checkpoint plus segments, with `model_state = "cold"`.
- **Retention.**
  - Delete at once on any close: user, idle, pressure, limit, orphan or quit.
  - Keep `lost` spools until dismissed, or for 7 days.
  - A startup sweep removes leftovers.
- **Permissions.** Explicit `0700` directories and `0600` files. Names are hashes.
- **Time Machine.** On macOS, R2 excludes `<stateDir>/terminal-host` from backups by setting the `com.apple.metadata:com_apple_backup_excludeItem` xattr to a **binary plist** encoding the string `com.apple.backupd` (the format `tmutil addexclusion` writes). The test checks it with `tmutil isexcluded`. If setting the xattr fails, R2 falls back to running `tmutil addexclusion <path>` and logs the result.

### 8.4 Screen model budget

- The model holds the visible rows plus 1,000 scrollback rows, about 4.2 MB at 200×50.
- **Snapshot caps.** Both must hold:
  - UTF-16 units ≤ 1,048,576 (the web contract, `TERMINAL_RECOVERY_ANSI_MAX_CHARS`);
  - UTF-8 bytes ≤ 3 MiB.
    If either is exceeded, the serializer drops the oldest scrollback rows until both fit and reports `fidelity = "trimmed"` with the row count. It never trims the visible screen.
- **Transport.** The snapshot is sent in chunks of 192 KiB or less on the paced response path (§9.1), so no frame comes near the 1 MiB frame limit.

### 8.5 Activity, busy and idle (USER-DECIDED rule, recorded as a decision; N2, N9, N12 fixes)

**Facts per PTY**

- `last_input`: accepted **client** input. Replies written by the host's query responder (§8.9) are not client input and never update it.
- `last_output`: PTY output. Output within 1,000 ms after a resize the host applied is excluded.
- `foreground_program` (Unix), checked every 2 s and on foreground-group changes. It is true when:
  - `tcgetpgrp(master_fd) != getpgid(shell_pid)` **and** the foreground group leader's executable is **not** in the shell set {`sh`, `bash`, `zsh`, `fish`, `dash`, `ksh`, `tcsh`, `csh`, `nu`, `pwsh`, `xonsh`}. The executable comes from `/proc/<pgid>/exe` on Linux and `proc_pidpath` on macOS. Nested shells (`bash`, `nix-shell`'s bash, `su -`, `poetry shell`) are therefore not programs, but a program started inside a nested shell becomes the foreground leader and is detected; or
  - the PTY's direct child is not in the shell set (a TUI launched directly, or `exec`'d), for as long as it lives.
  - If the foreground leader's executable is **unknown or unreadable** (a pipeline leader that already exited, a root-owned `sudo vim`, or a `proc_pidpath`/`/proc` failure), it counts as a foreground program. The rule is conservative: never idle.
  - `ssh`, `mosh`, `tmux` and `screen` are programs, so those PTYs are **never idle**. This is documented in the help text and the plan.
- `owner_hint` (Direct SSH): `busy | idle | unknown` for the remote foreground program. `unknown` counts as busy.
- `recent_output_10m`: output in the last 10 minutes.
- `recent_output_60s`: output in the last 60 s.
- `view_state`, `last_focus`, `keep_open_at`.

**Three uses, deliberately separate** (the user's rule "busy = foreground program or output in the last 10 minutes" is preserved, because the idle timer already measures output):

| Use                              | Counts as busy                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Idle/warning state machine       | `foreground_program \|\| owner_hint ∈ {busy, unknown}` only. Output is covered by `quiet_since`                                                   |
| Memory-pressure candidacy (§8.6) | `foreground_program \|\| owner_hint ∈ {busy, unknown} \|\| recent_output_10m`                                                                     |
| Sidebar colour (§11.2)           | `foreground_program \|\| owner_hint == busy \|\| recent_output_60s`. A quiet prompt that printed something 5 minutes ago shows as muted, not blue |

**Idle state machine**

- `quiet_since = max(last_input, last_output, last_focus_end, keep_open_at, created_at)`. A visible PTY is never idle.
- **Idle** = `lifecycle_managed && !(foreground_program || owner_hint busy/unknown) && view_state == hidden && now − quiet_since ≥ 600,000 ms`.
- **Warning** at `quiet_since + 540,000 ms`: `idle_warning { closes_at = quiet_since + 600,000 }`, once per quiet period.
  - New input, new output, focus, a foreground program starting, or Keep open emit `idle_warning_cleared` and start a new period.
  - Output **aging out** of any window never clears a warning or restarts a period.
- **Close.** At `closes_at`, re-check under the PTY lock. If still idle, run the existing `close(terminate = true)` escalation and emit `idle_closed`.
- **Offline.** The host enforces idle close with no owner connected. Notices go to the 64-entry ring.
- Silent shell helpers such as `gitstatusd` and silent background jobs never affect any of these facts. Background jobs count only through their output.

**Required fake-clock tests (R3)**

- Last output at t0 and nothing else: warning at t0+9 min and close at t0+10 min.
- Output at t0+9:30 after the warning clears it, and the warning comes back at t0+18:30.
- A foreground program blocks both the warning and the close.
- A nested `bash` at its prompt is idle; `vim` inside the nested bash is a program.
- Responder replies do not move `last_input`.
- Unknown leader executable, where it can be arranged: a `sudo -n sleep` foreground (skipped without passwordless sudo) and an injected probe failure both count as a foreground program.

### 8.6 Memory pressure (precise)

Sampled every 10 s by `terminal_policy::MemorySampler`, using std plus libc only.

| Signal               | Linux                                                                                                                                                                             | macOS                                                 | Low                                 | Critical            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------- | ------------------- |
| OS pressure          | `/proc/pressure/memory` `some avg10`; inside cgroup v2, `<cgroup>/memory.pressure`                                                                                                | `sysctlbyname("kern.memorystatus_vm_pressure_level")` | PSI ≥ 10 or level ≥ 2               | PSI ≥ 30 or level 4 |
| Available memory     | `MemAvailable`/`MemTotal`. Under cgroup v2 with a finite `memory.max`: `min(MemAvailable, memory.max − memory.current)` and total `min(MemTotal, memory.max)` (remote containers) | `hw.memsize` plus the OS level                        | available < max(8% of total, 1 GiB) | < max(4%, 512 MiB)  |
| Host RSS             | `/proc/self/statm`                                                                                                                                                                | `proc_pidinfo(PROC_PIDTASKINFO)`                      | > 512 MiB after cache trimming      | > 768 MiB           |
| Terminal process RSS | Sum of managed PTYs' process trees (`/proc`), every 30 s                                                                                                                          | `proc_pid_rusage`                                     | > 50% of the effective total        | > 70%               |

- **Level.** The maximum across the signals. It must hold for 2 samples (20 s) to act and clears after 3 samples below Low.
- **Candidates.** Managed, `hidden`, no foreground program, owner hint not busy or unknown, and no output in the last 10 minutes (the pressure row of the §8.5 table).
- **Order.** LRU by `last_used = max(last_input, last_focus)`.
- **Action.** Close one candidate, wait 30 s, re-evaluate. At most 3 closes per 5 minutes (6 at Critical). Emit `pressure_closed`.
- **Guarantees.** Never close a visible or busy terminal. With no candidate, emit `pressure_no_candidate`, at most once per 10 minutes.
- **Host relief first.** Drop cached snapshots and shrink buffers before counting host RSS.

### 8.7 Host policy and opt-in (fixes review finding 10)

- **Defaults.** The host starts with lifecycle policy **off**: no idle close, no pressure close, no limit enforcement, and no orphan termination other than today's behavior.
- **Opt-in.**
  - A client opts in per PTY with `PtyCreateRequest.lifecycle_managed = true`.
  - It sends `HostPolicyUpdate { lifecycle_enabled: true, … }`.
  - The policy applies **only** to managed PTYs, so a new client never imposes idle close on PTYs created by an older client or another owner.
- **Limit counting.** The limit counts only managed live PTYs.
- **Clamping.** Policy values are clamped in Rust:
  - idle ≥ 60 s;
  - warning ≤ idle/2;
  - limit 1..40 (below the internal session cap; see §8.10);
  - orphan 0 or ≥ 60 s.
- **Revisions.** The latest pushed `revision` wins.

### 8.8 Hard limit and server-initiated opens

**The limit**

- **Value.** `max_live_ptys = 24` managed PTYs per host. A remote host counts separately.
- **Reasoning:**
  - (1) memory: 24 agent TUIs × ~300 MB ≈ 7 GB;
  - (2) macOS `kern.tty.ptmx_max` is 511 system-wide, and Orca leaves about half of it;
  - (3) more than 24 cannot be managed from the sidebar;
  - (4) it leaves room under the internal 64-session cap after §8.10.
    Exited and lost sessions do not count.
- **"Oldest".** Least recently used (`last_used`) among managed live PTYs, busy or not ("whether it is active or not").
- **Visible exclusion.** PTYs visible right now are excluded. This is a deviation from the literal decision, and **the user accepted it** (per the coordinator's review relay): the user never loses the terminal they are looking at.

**Setup scripts (USER-DECIDED, recorded as a decision)**

- Project setup scripts that the server launches into a terminal count as user-opened. They are managed and count toward the limit.
- At the limit, the run fails with a `TerminalLimitError`, and the web shows an amber toast: "Terminal limit reached, so the setup script didn't start." Action: **Close oldest and run setup** retries with eviction.
- If the toast is dismissed or ignored, the setup activity is marked failed with: "Setup script didn't run because the terminal limit (24) is reached. Close a terminal and run it again."

### 8.9 Terminal queries without a live view (review finding 11; hydration fix)

- **The responder.** The host's `QueryResponder` (R1 parses, R5 replies) answers a bounded set:
  - DA1, with the same identity xterm.js reports;
  - DSR (`CSI 5 n`);
  - CPR (`CSI 6 n`), from the model's cursor;
  - OSC 10 and OSC 11, from the theme colours the server pushes;
  - DECRQM, for the modes the model tracks.
    Other queries get no reply, as today. Clipboard and title queries are never answered.
- **One sequence cut, so no reply is ever lost or duplicated.**
  - The host answers every query in output up to and including sequence `C`.
  - The view answers every query after `C`.
  - Attaching uses `PtyScreenSnapshotRequest.attach_renderer = true`. The host then atomically sets `C = through_sequence` of that snapshot and stops answering after it.
  - The web intake suppresses replies only for the snapshot's ANSI (sequence ≤ `C`). Queries in live output after `C` that arrive while hydration is still running are **queued, not dropped**, and answered by xterm once hydration completes. The queue holds at most 64 queries for at most 2 s; anything beyond that bound is dropped and logged.
  - **Detaching is symmetric (F8).**
    - When the last subscriber leaves, the server sends `PtyViewStateRequest.renderer_attached = false` together with `acked_sequence` (new field), the last output sequence the web acknowledged as parsed.
    - The host answers queries only in output **after** `acked_sequence`, including output it already applied after that point. Queries at or before `acked_sequence` belonged to the view.
- **No responder, no parking.** If the host lacks `terminal.query-responder`, the session reports `restorable: false` and is never parked.

### 8.10 Agent resource caps (review finding 2)

- **Shared workspace roots with an explicit reference count.**
  - New creates (S2) use handle `terminal-root-<hex(sha256(target ‖ 0x00 ‖ canonical cwd))[0..32]>`.
  - R5 keeps `refs[handle]` = live PTY sessions using it + retained exited sessions using it + in-flight operations (create, search, read) using it.
  - Each of those increments the count when it starts and decrements it when it retires.
  - The root is removed from `workspace_roots` only when the count reaches 0.
  - Legacy `terminal-<resourceId>` handles follow the same rule. An open on an existing handle increments its count instead of failing.
- **Retained exited sessions.** At `MAX_PTY_SESSIONS` (64), retire the oldest exited session whose exit was already delivered, then the oldest create failure, before refusing.
- **Churn test.** Open and close 100 PTYs, alternating between 2 cwds, within 600 s. No `RESOURCE_LIMIT` occurs, and `workspace_roots` returns to its baseline. A shared root survives while one PTY still uses it.

## 9. Protocol and contract changes (all additive)

### 9.1 Remote-agent protocol 1.9

- New `protocol/remote-agent/pty_lifecycle.proto`, imported by `v1.proto`, with `Frame` fields **80–95**. Fields 58 and 59 stay reserved.
- New capabilities, advertised only when implemented: `terminal.screen`, `terminal.lifecycle`, `terminal.spool`, `terminal.query-responder`, `terminal.local-launch` (local host only), all v1.
- `PROTOCOL_MINOR = 9` (`crates/bigbud-protocol/src/lib.rs:11`, `remoteAgentProtocol.ts:13`).

| #     | Message                                                                                                                                                                                                                                                                                                           | Direction    |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| 80    | `PtyScreenSnapshotRequest { request_id, pty_id, max_ansi_units, max_utf8_bytes, max_scrollback_rows, attach_renderer }`                                                                                                                                                                                           | client→agent |
| 81    | `PtyScreenSnapshotHeader { request_id, pty_id, accepted, error_code, through_sequence, cols, rows, scrollback_rows, alternate_screen, fidelity ("full"\|"trimmed"\|"partial"), model_state ("live"\|"cold"\|"invalid"), chunk_count (≤ 16), total_ansi_bytes (≤ 3 MiB), pending_escape_tail (≤ 16 KiB), sha256 }` | agent→client |
| 82    | `PtyScreenSnapshotChunk { request_id, index, last, bytes (≤ 192 KiB) }`                                                                                                                                                                                                                                           | agent→client |
| 83    | `PtyActivity { pty_id, idle_busy, pressure_busy, sidebar_busy, reasons, last_input_ms, last_output_ms, quiet_since_ms }`, on transitions, ≤ 1/s                                                                                                                                                                   | agent→client |
| 84    | `PtyLifecycleNotice { notice_id, pty_id, kind, closes_at_ms, occurred_at_ms }` with `kind` one of `idle_warning`, `idle_warning_cleared`, `idle_closed`, `pressure_closed`, `pressure_no_candidate`, `limit_closed`, `orphan_closed`, `quit_closed`, `model_invalid`, `spool_degraded`                            | agent→client |
| 85/86 | `HostPolicyUpdate` request/response (`lifecycle_enabled`, idle, warning, limit, orphan, memory thresholds, `revision`; the response returns the effective clamped values)                                                                                                                                         | both         |
| 87/88 | `PtyViewState` request/response (`view_state`, `renderer_attached`, `owner_busy_hint`, `theme_fg`, `theme_bg`)                                                                                                                                                                                                    | both         |
| 89/90 | `PtyKeepOpen` request/response                                                                                                                                                                                                                                                                                    | both         |
| 91/92 | `PtyCloseAll` request/response (`reason: quit\|update`, `managed_only`)                                                                                                                                                                                                                                           | both         |
| 93    | `HostResourceReport`                                                                                                                                                                                                                                                                                              | agent→client |
| 94/95 | `HostNoticeReplay` request/response                                                                                                                                                                                                                                                                               | both         |

Additive fields on existing messages:

- `PtyCreateRequest`: `evict_pty_id = 12`, `activity_source = 13`, `screen_scrollback_rows = 14`, `spool = 15`, `local_launch = 16`, `lifecycle_managed = 17`.
- `PtyCreateResponse`: `limit = 8`, `live_count = 9`, `eviction_candidate_pty_id = 10`, `evicted_pty_id = 11`, and `PTY_LIMIT_REACHED`.
- `PtyInventoryEntry`: `activity_state = 9`, `last_used_ms = 10`, `screen_available = 11`, `lost = 12`, `lifecycle_managed = 13`.
- `AgentHello` (in `v1.proto`): the next free field numbers for `process_id` and `process_start_time_ms` (§7.3 item 3).

**Snapshot transport (N3)**

- The header and the chunks go through the paced `enqueue_response` path (`supervisor/writer.rs:119-160`). They are **never** streaming frames, so the 256 KiB − 4 streaming cap (`writer.rs:10-11`) does not apply.
- Each chunk is encoded **lazily**, only when the response queue has room for it. A transfer therefore never holds more than one encoded chunk, never waits 5 s on a full queue, and never triggers the queue's cancel.
- At most **2 snapshot transfers are in flight per host**, enforced by an agent-side semaphore. Further requests wait in a bounded FIFO of 32, and a full FIFO answers `error_code = "SNAPSHOT_BUSY"` (the server retries after 250 ms).
- Snapshot bytes count against the global 8 MiB writer budget (`writer.budget.rs:7,41-45`) only while a chunk is queued: at most 2 × 192 KiB at any moment.
- The server enforces the same limit of 2 transfers in flight per host connection, so TS reassembly holds at most 2 × 3 MiB.
- The client validates the index sequence, `chunk_count`, `total_ansi_bytes` and SHA-256. It abandons a transfer after 5 s or on an interleaved error.
- R4 configures prost `boxed` for the large variants in `build.rs`. Golden frames are added at the real maximum: one 192 KiB chunk, 16 chunks totalling 3 MiB, and the largest header.
- Required test: 24 concurrent snapshot requests on one connection complete with no connection cancel, no writer-budget error, and other PTYs' output keeps flowing.

**Snapshot worker (N4)**

- Snapshot fences and serialization run on a **dedicated bounded snapshot worker** (2 threads per host, matching the transfer limit). They never run under the shared `AgentSession` mutex (`supervisor/jobs.rs:21-25`, `bootstrap.rs:18`) and never on a connection read loop.
- The worker talks only to that PTY's `ScreenActor` handle. The actor owns the model.
- **Copy at the fence (F1).**
  - At the fence, the actor clones the model's grid and state into an **immutable copy** (copy-on-write rows, or a cheap clone of about 4–6 MiB), hands it to the snapshot worker, and **resumes feeding at once**.
  - Serialization, chunking and encoding run on the copy, so a snapshot never stalls the actor's queue, and the reader's 50 ms `try_feed` never fails because of a snapshot.
  - At most 2 copies exist per host, one per in-flight transfer. They are counted in `screen_model_bytes`.
- The connection loop only enqueues the request.
- Exit criterion (R5): while a 3 MiB snapshot is being produced, input echo latency on another PTY stays under 50 ms (p99).

**Other semantics**

- **Eviction is atomic in the host.** The host verifies that the candidate is still live, managed and not visible, closes it (`limit_closed`), then creates the new PTY. If the candidate is gone and the host is still at the limit, it refuses again with a fresh candidate.
- **Snapshot fence.** The fence waits until everything already applied is serialized, with a 2 s deadline. Otherwise it returns `model_state = "invalid"`.
- **Duplicate creates** stay deterministic through `request_digest`.

### 9.2 Contracts (`packages/contracts`, schema only)

- `workspace/terminal.ts`:
  - `TerminalOpenInput`: optional `attachOnly` and `evict: { threadId, terminalId }`.
  - New `TerminalLimitError { limit, liveCount, candidate: { threadId, terminalId, lastUsedAt, busy } }` and `TerminalNotRunningError`, both in the `TerminalError` union.
  - `TerminalSessionSnapshot`: optional `screenSource`, `restorable`, `endedReason` (`user|idle|memory|limit|quit|orphan|host-lost|exited`).
- `workspace/terminal.stream.ts`:
  - `TerminalScreenItem { type: "screen", threadId, terminalId, runtimeGeneration, throughSequence (decimal string), cols, rows, ansi (≤ TERMINAL_RECOVERY_ANSI_MAX_CHARS), pendingEscapeTail (≤ 16,384), scrollbackRows, alternateScreen, fidelity, cold }`. It is sent only when the subscriber passes `acceptScreen: true` on `TerminalSessionStreamInput`, and it is always the first item after `subscribed`.
  - Inventory sessions gain optional `activity`, `restorable`, `idleClosesAt`.
- New `workspace/terminal.lifecycle.ts`:
  - `TerminalLifecycleNotice { type: "lifecycleNotice", noticeId, kind, threadId?, terminalId?, closesAt?, candidate?, createdAt }`. Kinds include `setupBlockedByLimit`. It joins `TerminalEventsStreamItem` behind the opt-in `includeLifecycle`.
  - `TerminalKeepOpenInput`.
  - `TerminalRetrySetupInput { threadId, evict }`.
- New `server/rpc.terminalLifecycle.ts`: `terminal.keepOpen` and `terminal.retrySetup`. Register in `server/rpc.ts`, which must be split first. Add the names to `websocket.constant.ts` and the types to `ipc.nativeApi.terminal.ts`.
- New `core/settings.terminalLifecycle.ts`: `terminalsKeepRunningAfterQuit`, default `false`, server-owned, plus patch fields.
- `server/desktopLifecycleHint.ts`:
  - `DesktopLifecycleHintKind` adds `"quit"`, with an optional `reason: "quit" | "update" | "restart"` and a `sequence`.
  - New server→main record `DesktopLifecycleHintAck { sequence }`.
- Compatibility: everything is optional or opt-in. Old clients against a new server keep the history path.

## 10. User decisions mapped to concrete changes

| Decision | Rust                                                                                     | Server                                                                             | Web                                                                                                           |
| -------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| D1       | n/a                                                                                      | `attachOnly` (S3); close reasons (S5)                                              | No default terminal, close-last, restored-pane reconciliation, no right-panel auto-spawn (W1); indicator (W3) |
| D2       | Daemon flags, local-launch env, workspace-root release, session caps (R5); Windows (M10) | Staging, adoption, transport (S1); launch parity (S6); Direct SSH (M7)             | Registry outside gates (W2)                                                                                   |
| D3       | `terminal_screen` (R1), `terminal_spool` (R2), chunked snapshot (R4/R5)                  | Splice and reassembly; no TS baseline for host sessions (S2/S3); rolling tail (S4) | `screen` intake (W2)                                                                                          |
| D4       | Query responder (R1/R5)                                                                  | `restorable`, `renderer_attached`, lease-expiry push (S3)                          | Parking registry and visibility reporting (W2)                                                                |
| D5       | Busy rule and idle engine (R3/R5), opt-in (R5)                                           | Pushes, notices, `keepOpen` (S2/S3)                                                | Warning toast with **Keep open** (W3)                                                                         |
| D6       | `MemorySampler` with cgroup v2 (R3/R5)                                                   | Notices (S3)                                                                       | Toast (W3)                                                                                                    |
| D7       | Admission and eviction (R3/R5)                                                           | `TerminalLimitError`, `evict`, setup-script limit path (S3)                        | Dialog (W3), call site (W2), setup toast (W3)                                                                 |
| D8       | `PtyCloseAll`, orphan policy, self-exit (R5)                                             | Acked quit intent, close vs detach, update quit (D1/S3)                            | Settings row (W3)                                                                                             |

## 11. UI specification

### 11.1 Drawer and right panel

- **Open** (`mod+j`, the toolbar button, `!cmd`, running a script, the right-panel tab):
  - If the surface has no terminal, create one user-created pane, which spawns.
  - If terminals exist, show them.
- **Right panel.** Opening the tab on a thread with no panel terminal shows an empty state ("No terminal in this thread.") with a **New terminal** button. Switching threads never creates a terminal. This removes the effect in `TerminalPanel.tsx:32-35`.
- **Minimize** (minimize, `mod+j` while open, the "chat-only" layout, closing the right-panel tab): processes keep running.
- **Close** (the X, `mod+w`): confirmed close. Closing the last terminal closes the surface and empties its pane list.
- **Ended terminals.** The pane is removed and a toast explains why. A `host-lost` terminal stays read-only with its last screen, a red inline banner "This terminal stopped because the terminal service exited unexpectedly.", and the actions **Start new terminal** and **Dismiss**.

### 11.2 Sidebar indicator

- A terminal glyph appears when the thread has at least 1 live terminal in inventory.
  - Busy: blue, with a subtle pulse.
  - Otherwise: muted.
  - Warning pending: amber.
- Label: "1 terminal running" or "3 terminals running (1 busy)". With a warning: "Terminal closes in 1 minute (idle)".
- The existing finished/failed indicator keeps priority. `terminalStatusFromRunningIds` is replaced.

### 11.3 Toasts and dialogs

Toast colours: blue means working, green done, amber warning, red failure.

| Event                          | Type  | Text                                                                                              | Action                         |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------------------- | ------------------------------ |
| `idle_warning`                 | amber | "“{label}” in “{thread}” has been idle for 9 minutes and will close in 1 minute."                 | **Keep open**                  |
| `idle_warning_cleared`         | n/a   | The warning toast is dismissed                                                                    | n/a                            |
| `idle_closed`                  | amber | "Closed idle terminal “{label}” in “{thread}”."                                                   | n/a                            |
| `pressure_closed`              | amber | "Memory is low, so bigbud closed the idle terminal “{label}” in “{thread}”."                      | n/a                            |
| `pressure_no_candidate`        | amber | "Memory is low. No hidden idle terminals could be closed."                                        | n/a                            |
| `limit_closed`                 | amber | "Closed “{label}” in “{thread}” to open a new terminal."                                          | n/a                            |
| `setupBlockedByLimit`          | amber | "Terminal limit reached, so the setup script didn't start."                                       | **Close oldest and run setup** |
| replayed offline notices       | amber | "While bigbud was closed, {n} terminal(s) were closed because they were idle."                    | n/a                            |
| host lost                      | red   | "Terminals stopped because the terminal service exited unexpectedly. Their last output is shown." | n/a                            |
| unreachable old host with PTYs | amber | "Terminals from a previous bigbud version are still running but can't be reconnected."            | **Close them**                 |
| fallback-only restart kill     | amber | "Terminals were stopped because the backend restarted."                                           | n/a                            |

**Limit dialog** (`AlertDialog`, `text-sm`):

- Title: "Terminal limit reached".
- Body: "You have {liveCount} terminals running, the most bigbud allows. Opening another one requires closing one first."
- Candidate line (`text-xs`, muted): "Oldest: “{label}” in “{thread}”, last used {relative time}{, busy}."
- Buttons: **Cancel** (removes the new pane) and **Yes, continue — the oldest terminal will be closed whether it is active or not** (destructive; retries with `evict`).

### 11.4 Settings row

Settings → Terminal → new `TerminalLifecycleSettings.tsx`:

- Switch: "Keep terminals running after quitting".
- Helper text: "Terminals keep running in the background when you quit bigbud and reconnect the next time you open it. Idle terminals still close after 10 minutes."
- Disabled on Windows until M10, with "Not available on Windows yet."

## 12. Security

- **Scrollback.**
  - Location: `<stateDir>/terminal-host/state-<n>/terminals/` (remote: `~/.bigbud/agent/state/terminals/`).
  - Explicit `0700`/`0600` permissions. Hashed names. Output only, never input bytes (echoed input still appears, as in any scrollback).
  - Deleted on close. A 7-day sweep for `lost` spools. Excluded from Time Machine.
  - The host never logs content. Paths are never sent to the web.
- **Host identity.** `hosts.json` is `0600` and records only the binary path, version, digest, epoch, PID and start time. A PID is signalled only after its start time is verified.
- **Staged runtimes.** The digest is verified before every launch. The directory is `0700`.
- **Environment.**
  - The host starts with a minimal environment.
  - Per-PTY environment comes from the server's launch spec, which already carries the user's login-shell environment today.
  - It is validated by the separate local-launch validator: any POSIX name, at most 512 entries, at most 256 KiB, no NUL (§15 R5).
  - `local_launch` is refused unless the host was started with `--local-desktop-host`, so remote hosts keep their protected-variable rule.
  - Nothing from the environment is persisted.
- **Socket.** The existing `0700` socket (`supervisor/bootstrap.rs:16`), the admission handshake and the secure-socket check. Connections go only through the running host's staged `--proxy`.
- **Queries.** The responder answers only the fixed set in §8.9, from model state and pushed theme colours. It never answers clipboard (OSC 52/5522) or title-report queries.
- **Eviction.** Only after explicit user confirmation through the RPC. The host refuses visible and unmanaged candidates.
- **Remote.** Snapshots travel over the authenticated agent channel. The remote spool stays on the remote host.

## 13. Performance budgets

| Item                              | Budget                                                                                                                |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Screen ingest                     | ≥ 50 MiB/s per terminal (Apple Silicon, release); < 2% of a core at 100 KB/s                                          |
| PTY reader                        | Never blocks longer than 50 ms on the screen or spool queues (§14)                                                    |
| Screen model                      | ≤ 6 MiB per terminal at 200×50 + 1,000 rows; host RSS ≤ 256 MiB at 24 PTYs                                            |
| Snapshot                          | Serialize p95 ≤ 15 ms; ≤ 3 MiB UTF-8 and ≤ 1,048,576 UTF-16 units; chunks ≤ 192 KiB; ≤ 2 transfers in flight per host |
| Restore (parked → visible, local) | p95 ≤ 150 ms                                                                                                          |
| Warm switch                       | ≤ 1 frame                                                                                                             |
| Spool                             | ≤ 10 MiB per terminal; host total ≤ 512 MiB                                                                           |
| Probes                            | Foreground every 2 s; memory every 10 s; tree RSS every 30 s; no descendant scans                                     |
| Web warm set                      | ≤ 4 surfaces and ≤ 12 xterm instances                                                                                 |
| Server                            | No 1 MiB history per host session; search tail ≤ 512 KiB per session                                                  |

## 14. Failure handling

### Restarts, crashes and quits

- **Backend crash or restart (both modes).**
  - The host keeps the PTYs.
  - Default mode arms the 10-minute orphan timer.
  - The new backend adopts the host (§7.3), cancels the timer, reattaches and requests snapshots.
- **Quit, default mode.** The quit handshake (N10), with Electron's synchronous `before-quit` (`main.ts:273-291`):
  1. On the **first** `before-quit`, if the handshake has not run, call `event.preventDefault()` and set `quitHandshake = "pending"`.
  2. Write `quit { sequence, reason }` on fd 5.
  3. Wait up to 1,500 ms for `DesktopLifecycleHintAck { sequence }` on the server→main status pipe.
  4. Set `quitHandshake = "done"` and call `app.quit()` again.
  5. The re-entrant `before-quit` sees `done` and runs the existing `prepareForAppQuit` teardown, which is idempotent through `quitTeardownComplete`. Further quit requests during `pending` are ignored.
  6. On SIGTERM, the server synchronously drains pending fd 5 hints before deciding.
  7. With a quit intent and keep mode off: `PtyCloseAll(quit, managed_only)` to every reachable host, with a 3 s deadline inside the 8 s window. Unconfirmed hosts fall back to the orphan timer.
- **OS shutdown or logout.** Electron `powerMonitor` `shutdown` (macOS/Linux), `session-end` (Windows), or a `before-quit` raised by the OS session ending: **no wait and no hint**. The backend sees SIGTERM without a quit intent, so it detaches. Hosts then end with the OS session, and anything that survives (for example a Linux lingering user) follows the orphan policy.
- **Quit for update** (`prepareForUpdateInstall`): the same handshake with `reason: "update"`. It runs **inside** `prepareForUpdateInstall` and sets `quitHandshake = "done"` **before** `quitAndInstall`, so the later `before-quit` never calls `preventDefault` (F7).
  - Default mode closes all.
  - Keep mode leaves the host running from its staged binary, outside the AppImage mount and install directory, so installed-process quiescence never sees it. The updated app adopts it through the hello (§7.3).
- **Quit, keep mode.** Detach. Idle close keeps running in the host, and notices are replayed on the next launch.
- **Standalone server or CLI quit** (no hint): detach. The orphan policy applies in default mode.
- **Electron crash.** Treated as a backend crash.

### Host and remote

- **Host crash.**
  - The PTYs end.
  - The server marks them `host-lost` and requests cold snapshots for display.
  - It relaunches the host on the next open, and never respawns shells automatically.
- **Several owners.**
  - The latest policy revision wins.
  - The orphan timer runs only with no owner connected.
  - Remote-backend mode pushes orphan = keep.
  - Unmanaged PTYs are never touched by the policy.
- **Old remote agent.** Degraded mode (§7.2).
- **Incompatible local host.** §7.3 item 5.

### Inside the host

- **Screen actor overload or failure.**
  - The PTY reader does a bounded `try_feed` to the actor (wait at most 50 ms). If the actor is still full, the reader drops that PTY's actor feed and the model becomes `invalid` (`model_invalid`). Output delivery and the replay ring continue.
  - The spool writer has its own bounded queue. On overflow it is marked `spool_degraded`, and the reader is never blocked.
  - **Rebuild, fenced against live feed:**
    1. The actor enters `rebuilding` and records the ring's newest sequence `R`.
    2. It stops applying live feed. Live chunks with sequence > `R` go into a bounded rebuild buffer (2 MiB).
    3. It replays the ring up to and including `R` into a fresh emulator.
    4. It applies the buffered chunks in sequence order, then resumes live feed.
    5. If the rebuild buffer overflows, the model stays `invalid` until the next attempt, 30 s later.
  - The result is `fidelity = "partial"`, or `full` when the ring starts at sequence 0 or at a full-screen reset boundary.
  - Panics are caught (`catch_unwind`). Partial or invalid sessions are not restorable and are never parked.
- **Spool error.** Disable the spool for that PTY and emit `spool_degraded`.
- **Partial frames and reconnects.** Existing validation applies. Reassembly is abandoned on a gap or timeout, with one retry. A replay gap requires a fresh snapshot. The splice drops duplicates by sequence.

### Races and visibility

- **Idle close races, limit races, multiple windows.**
  - The host checks and acts under the PTY lock.
  - Limit eviction re-checks the candidate.
  - View state is the union across callers.
  - S3 runs a lease-expiry timer that pushes `hidden` when the last view lease lapses (120 s) without an update.
- **Hidden `ChatView` during a project load (W0 behavior).** Keyboard handlers in an inert hidden subtree must not act. W1 guards window-level terminal keybindings so they act only for the surface that is active and visible. W2 refuses focus requests from borrowers inside an inert subtree.

## 15. Implementation milestones (parallel streams with file ownership)

Rules:

- Touch only the owned files. A file passes to a later milestone only after the earlier milestone's commit.
- Split any owned file over 400 lines before materially editing it.
- Run focused checks only. Never touch `.git/index.lock`. Commit only with fresh user approval.
- **Wait-for-commit rules for dirty work (§0):**
  - Contracts and web RPC files block C1.
  - `terminal/Services/Manager.ts` and `Manager.session.ts` block S3.
  - `Manager.session.close.ts` blocks S5.
  - Direct SSH files block M7.
  - W0's files block W1 and W2.
  - Each of those milestones rebases onto that commit and never reverts or overwrites it.

### Wave 1

**W0: RC1 stopgap (IN PROGRESS by another implementer)**

- Owns (until committed): `ChatView.terminalDrawer.tsx`, `useThreadTerminalDrawer.ts`, `ThreadProjectGate.tsx` and its browser test, `ChatView.logic.test.ts`, new `ChatView.terminalDrawer.project.browser.tsx`.
- Scope as implemented:
  - retain the project while a drawer has panes;
  - bind the cwd at mount;
  - the gate keeps the previous ready subtree mounted, hidden and inert, while the next project loads.
- There is no LRU change (RC1e was wrong).
- Out of W0's scope and owned later:
  - the route placeholder in `_chat.$threadId.tsx` (W2);
  - `ThreadRemoteTargetGate` replacing `ChatView` (W2);
  - right-panel retention (W2 through the registry);
  - the right-panel auto-spawn (W1).

**M0 / R0: Rust scaffold and dependency gate**

- Gate:
  - Engineering approval for `vt100 = "=0.18.1"`, pinned exactly. The crate has moved through several minor versions (0.16 → 0.18) in a short time. Serialized-snapshot output is part of bigbud's fidelity contract, so every upgrade must rerun the R1 fidelity suite deliberately.
  - Record the license, the transitive dependencies (`vte`, `unicode-width`, `itoa`), the unsafe surface and the musl binary-size delta.
  - Regenerate the Rust license inventory and notices with `bun run licenses:rust`, following the release workflow in `docs/COMMANDS.md`.
  - The fallback is `alacritty_terminal = "=0.26.0"` (`default-features = false`) with a bigbud serializer.
- Owns: `crates/bigbud-remote-agent/Cargo.toml`, `Cargo.lock`, `src/lib.rs` (three `pub mod` lines), and empty module roots under `src/terminal_screen/`, `src/terminal_spool/`, `src/terminal_policy/`.

**R1: Screen engine and query parser** (R0)

- Owns `crates/bigbud-remote-agent/src/terminal_screen/**`.
- API:
  - `ScreenModel`: `feed` returning detected queries, `resize`, `snapshot` with both caps, `checkpoint`/`restore`, `estimated_bytes`, `query_reply`;
  - `ScreenActor`: `try_feed(seq, bytes, deadline)`, `snapshot_fenced`, `stop`/`join`, the rebuild state machine in §14, and `catch_unwind` around each feed.
- Serializer order: normal buffer and scrollback, alternate screen, cursor and SGR, input modes (including focus 1004), and the pending tail last.
- **Fixtures** (synthetic):
  - SGR 16, 256 and truecolor;
  - wide CJK and emoji, combining marks;
  - scroll regions, DECSC/DECRC, alternate screen, RIS, ED2/ED3;
  - OSC 8;
  - DEC 2026;
  - focus 1004;
  - kitty keyboard push/pop;
  - resize: shrink and grow with wrapped scrollback;
  - an agent-TUI redraw stream.
- **Comparison method (N7).**
  - Compare at **equal geometry**. The harness creates `@xterm/headless` at the snapshot's `cols`×`rows` and writes the ANSI.
  - W2's intake does the same in the real view: it resizes xterm to the snapshot geometry, writes, then fits, which resizes the PTY.
  - Diffs cover each cell's character, width, foreground, background and attributes, plus cursor position and xterm-visible modes.
- **Pass criteria:**
  - **Zero diffs** on the visible screen and on scrollback rows written at the current width, for every fixture.
  - **Excluded** from the zero-diff criterion, and handled by reporting `fidelity = "trimmed"` with the count of affected rows:
    - scrollback rows written before the last width change (reflow differs between engines);
    - kitty keyboard flags, which xterm.js does not implement (the host tracks them, and they are compared as host state only);
    - OSC 8 link targets, if the chosen crate lacks them (the link text still renders).
  - Round trip: a fresh model fed the snapshot shows zero diffs.
  - The same corpus runs against an `alacritty_terminal` prototype in M0.
- **If neither crate passes:**
  1. Choose the crate with the fewest diffs on the corpus.
  2. List every remaining diff category in this plan as a documented exclusion, each reported through `fidelity`.
  3. Get explicit engineering approval before R5 starts.
     Silent exclusions are not allowed.
- Bench budgets as in §13.

**R2: Scrollback spool** (R0)

- Owns `src/terminal_spool/**`.
- API: `SpoolStore::open`, `writer` (own thread, bounded queue), `append`, `checkpoint` (opaque blob), `read_cold`, `mark`, `remove`, `sweep`, and on macOS `exclude_from_backup(root)`.
- Tests: rotation, atomicity, permissions, crash truncation, budgets, and the xattr being set (macOS).

**R3: Activity and policy engine** (R0)

- Owns `src/terminal_policy/**`, including the `cfg` folders `probe/{linux,macos,unsupported}.rs` and `memory/{linux,macos}.rs`. Linux covers PSI, `meminfo` and cgroup v2 discovery through `/proc/self/cgroup` plus `memory.max`, `memory.current` and `memory.pressure`.
- API: `ActivityTracker` (the §8.5 rule), `ProcessProbe` (`foreground_program(master_fd, child_pid) -> bool`, `tree_rss`), `MemorySampler`, `PolicyEngine::evaluate` (managed PTYs only), `admission::decide`. A debug-only pressure override is provided for tests.
- Real-PTY tests (Unix):
  - a bare prompt is not busy;
  - a p10k-style helper (the shell starts a silent background child) is not busy;
  - `exec sleep 900` (child not a shell) is busy;
  - foreground `sleep 30` is busy;
  - a background job printing every 5 minutes is busy;
  - a silent background job becomes idle after 10 minutes on a fake clock.
- cgroup tests run against fixture directories.

**R4: Protocol 1.9** (independent)

- Owns:
  - `protocol/remote-agent/pty_lifecycle.proto`, `pty.proto`, `v1.proto`;
  - `crates/bigbud-protocol/build.rs` (rerun line and `boxed` config), `src/lib.rs` (minor), new `src/frame/pty_lifecycle.tests.rs` and its registration in `frame/mod.rs`;
  - `protocol/remote-agent/v1.golden.frames`, including the maximum-size goldens;
  - TS: `remoteAgentProtocol.ts` (minor), new `remoteAgentProtocol.ptyLifecycle.ts`, new `remoteAgentProtocol.codec.pty.lifecycle.ts`, and the registration lines in `remoteAgentProtocol.codec.table.ts`, `.codec.pty.decode.ts` and `.codec.pty.encode.ts`;
  - `crates/bigbud-remote-agent/src/session/operation_handlers.rs`, a minimal "unsupported request" routing only. **Ownership passes to R5** after R4 merges.

**S1: Local terminal host: staging, launch, adoption, transport** (independent; existing frames only)

- Owns:
  - new `apps/server/src/terminal-host/**`:
    - `localTerminalHost.binary.ts`: resolve and stage to `runtimes/<digest>/`, GC;
    - `.paths.ts`;
    - `.registry.ts`: `hosts.json` (provisional and final records, state generations);
    - `.adopt.ts`;
    - `.launch.ts`: minimal environment, daemonize;
    - `.transport.ts`: dedicated factory, target `local-terminal-host`, proxy through the running host's binary, pool binding from hello;
    - `.owners.ts`;
    - `.layer.ts`: `LocalTerminalHostPtyLive`;
  - `apps/server/src/server.pty.ts`;
  - optional extraction `remote-agent/localAgentBinary.ts` from `localWorkspaceWatchAgent.binary.ts`.
- **Flag rule.**
  - Before Q1, the host is enabled only if `BIGBUD_TERMINAL_HOST === "1"`.
  - After Q1, it is enabled unless `BIGBUD_TERMINAL_HOST === "0"`.
  - With the kill switch on, the server still adopts an existing host and attaches its live PTYs. It creates no new host PTYs, and new terminals run in-process. Nothing is orphaned.
  - No hidden UI setting is added. The environment variable is the operations control.
- Reuse `makeOwnedRemoteAgentPty` and `RemoteAgentConnectionPool`. If the remote registry dependency does not fit, add a minimal adapter inside `terminal-host/`.
- Tests:
  - staging and digest verification;
  - adoption across a digest change (a dev rebuild and an app update) **with live terminals** (same PIDs, protocol major match);
  - an incompatible host, empty (replaced) and with PTYs (toast, nothing killed);
  - a crash between launch and the final record write (adoption through the socket alone);
  - **F2:** two generations with PTYs on each; after a backend restart, every owner reattaches through its own generation's binding, and new terminals go to the newest compatible generation;
  - an older host lacking new capabilities (fresh `state-<n+1>` host, old one draining);
  - an unreachable host on another major version with owner rows (never killed);
  - a too-long socket path;
  - stable and dev hosts running concurrently;
  - `detached` session isolation (kill the backend's process group, the host survives);
  - the real binary behind `BIGBUD_TERMINAL_HOST_IT=1` with `/tmp` roots.

**S4: Rolling tail for the fallback and the search tail** (independent)

- Owns `apps/server/src/terminal/Layers/Manager.history.retention.ts`, new `Manager.history.baseline.ts`, and the **existing** `Manager.history.retention.test.ts` (extended).
- Trim to the newest safe baseline boundary that fits. Boundaries are RIS, `CSI 2J` followed by home, `CSI ?1049h`/`?47h`, and `CSI 3J`.
- If none fits, cut at a line boundary outside any open control sequence, prepend the tracked SGR and modes, and set `historyTrimmed`. Never present a VT suffix as a full baseline.
- Keep a visible-text search tail of ≤ 512 KiB.
- Also owns the cross-engine test harness, `apps/server/src/terminal/Layers/TerminalScreenFidelity.harness.ts` (test-only), which R1 and Q1 use.

**S5: Close-reason tracing** (waits for the dirty `Manager.session.close.ts` to be committed)

- Owns `Manager.session.close.ts`, `Manager.process.stop.ts` and their tests.
- Add span attributes `threadId`, `terminalId` and `reason` (`user-close | archive | delete | remote-disconnect | idle | memory | limit | quit | orphan | shutdown`), defaulting to `user-close`.

**C1: Contracts and RPC scaffolding** (waits for the dirty contract and RPC files)

- Owns:
  - every §9.2 contract file;
  - `server/rpc.ts` (split first), `constants/websocket.constant.ts`, `server/ipc.nativeApi.terminal.ts`;
  - the stub `apps/server/src/ws/wsRpcHandlers.terminalLifecycle.ts`, plus one spread line next to `makeWsRpcTerminalSessionHandlers` in `apps/server/src/ws/ws.ts:82`;
  - the web facade in `rpc/wsRpcClient.terminal.ts`, `wsRpcClient.terminal.types.ts` and `wsNativeApi.terminal.ts` (`keepOpen`, `retrySetup`, the new `open` fields, `includeLifecycle`, `acceptScreen`);
  - the contract tests, including a test proving that Effect `Schema.Struct` ignores excess keys on old servers.

### Wave 2

**R5: Agent integration** (R1–R4)

- Owns:
  - `supervisor/jobs.rs`, `core.rs` (split first), `bootstrap.rs`, new `policy_loop.rs` and `daemonize.rs`;
  - `session/pty_create.rs`, `pty_handlers.rs`, `pty_screen.rs`, `pty_lifecycle.rs`, `hello.rs` (capabilities, `process_id`, `process_start_time_ms`), `workspace_handlers.rs`, `core.rs`, `retirement.rs`, `operation_handlers.rs`;
  - `pty/input.rs`, `pty/environment.rs`, `main.rs`;
  - the tests.
- **New in revision 3:**
  - **`session/protocol_helpers.rs` (N1).** Keep the existing remote validator unchanged: the 22-name allowlist plus `LC_*`/`GIT_CONFIG_*`, at most 64 entries, uppercase names only. Add a separate `validate_local_launch_environment`, used **only** when the host runs with `--local-desktop-host` **and** the create has `local_launch = true` (dispatched from `pty_create.rs:66`). It accepts:
    - any POSIX name matching `[A-Za-z_][A-Za-z0-9_]*`, lowercase allowed, with no allowlist;
    - at most 512 entries and 256 KiB in total, with 16 KiB per value;
    - no NUL bytes and no `=` in names (kept).
    - **Skipping, not failing (F3).** Entries with an invalid name (for example the exported bash function `BASH_FUNC_x%%`) or a value over 16 KiB are **skipped**, and only the name is logged. The create fails only for a NUL byte or when the total-size or entry-count cap is exceeded. Test: an environment containing `BASH_FUNC_x%%=() { …}` still launches, and that entry is absent from the child's environment.
      `pty/environment.rs` honours the requested `PATH` and `SHELL` only under the same condition.
  - **`supervisor/writer.rs` and `writer.budget.rs` (N3).** Lazy, paced chunk encoding through `enqueue_response`, plus the 2-transfer semaphore and the 32-entry FIFO.
  - **New `supervisor/snapshot_worker.rs` (N4).** A bounded 2-thread worker, outside the session mutex and the read loop.
- **Exit criteria:**
  - snapshot equality after a reconnect;
  - orphan behavior in both modes;
  - close-all with `managed_only`;
  - limit eviction is atomic;
  - unmanaged PTYs are untouched by the policy;
  - idle close under the clock hook;
  - notice replay;
  - `lost` and cold snapshots;
  - query replies only up to the cut `C` (§8.9);
  - the reader never blocks more than 50 ms under a stalled actor;
  - 24 concurrent snapshot requests with no cancel and no budget error;
  - input echo latency to other PTYs under 50 ms (p99) during a 3 MiB snapshot;
  - **F1/F4 regression:** a 3 MiB snapshot taken during 10 MB/s of output produces **no** `model_invalid`, and the snapshot reports `fidelity = "full"`;
  - **F4 memory:** with 24 PTYs, the worker's copies plus 2 concurrent snapshots keep host RSS within the §13 budget (≤ 256 MiB);
  - the explicit reference-count churn test (§8.10);
  - rebuild fencing: no sequence applied twice or skipped, under live output;
  - the local-launch validator accepts a 300-entry environment with lowercase names, while the remote validator still rejects it.

**S2: Server client** (R4)

- Owns:
  - `remoteAgentPtyClient.ts` (split first), new `remoteAgentPtyClient.screen.ts` (bounded chunk reassembly and SHA-256 check), new `remoteAgentPtyClient.lifecycle.ts`, the **existing** `remoteAgentPtyClient.types.ts`;
  - `remoteAgentOwnedPty.ts` (per-cwd workspace handle, `lifecycle_managed`, `activity_source`, `local_launch` fields);
  - `terminal/Services/PTY.ts` (optional `screen`, `onSequencedData`, `lifecycle` members) and `terminal/Services/OwnedPtyRuntime.ts` (optional `host` controls).

**S6: Local launch parity** (S1, R5)

- Owns new `terminal-host/localTerminalHost.launchSpec.ts` and `terminal/shellIntegration/**` (where needed). It does not edit `remoteAgentShellLaunch.ts` or `localSupervisorLaunch.ts`.
- The launch spec sets:
  - the real platform (`darwin` or `linux`);
  - shell integration on;
  - the server's full spawn environment, including the requested `PATH` and lowercase names;
  - `local_launch: true`.
- Hook environment is stabilized under `<stateDir>` so it survives backend restarts.
- **Parity tests:**
  - A **real login environment** (captured from `$SHELL -lic env` on the test machine, more than 64 entries, with at least one lowercase name such as `http_proxy`) passes the R5 local validator **unchanged**. The same environment is visible inside the host shell, entry for entry, compared with the node-pty launch.
  - `PATH`, `SHELL`, integration markers (prompt and cwd OSC) and hook environment match.
  - A hook event from an adopted terminal still arrives after a backend restart.

**W1: Lifecycle semantics in the store** (C1 types; waits for the W0 commit)

- Owns:
  - `stores/terminal/helpers.store.ts`, `helpers.transitions.store.ts`, `terminal.store.ts` (split first), `terminal.store.close.ts`, `terminal.store.inventory.ts`, `terminal.store.persistence.ts`, `terminal.store.panel.ts`, the **existing** `terminal.store.types.ts`;
  - `components/terminal/TerminalPanel.tsx`: remove the auto-spawn effect (`:32-35`) and add the empty state with **New terminal**;
  - `chat/view/ChatView.terminalActions.logic.ts`;
  - `ChatView.keybindings.logic.ts`: guard by active, visible surface (§14);
  - `chat-view/terminalLayout.hooks.ts`;
  - the tests.
- Behavior:
  - Empty default state. Close-last empties the surface.
  - A persisted migration marks panes `restored`. Restored panes absent from the first authoritative inventory are removed. Restored panes open with `attachOnly`.
  - Exports `selectThreadSurfacePanes` for W3.
- Tests include: switching threads with the right panel open creates no terminal.

**D1: Acknowledged quit intent** (C1)

- Owns:
  - `apps/desktop/src/main.ts`: split first, moving the quit logic into new `main.quitTeardown.ts` (handshake state machine, idempotent re-entrant `app.quit()`, OS shutdown/logout handlers per §14);
  - `main.bootstrap.ts` (split first): the updater sends `reason: "update"`;
  - `backend/backendLifecycleHintPipe.ts`;
  - `backend/backendStartupStatusPipe.ts`, or a new fd 6 ack pipe;
  - `apps/server/src/system-sleep/desktopLifecycleHintReader.ts`: route `quit`, write the ack, expose `drainPendingHints()`;
  - `SystemSleepEpochs.sources.logic.ts`;
  - new `apps/server/src/lifecycle/AppQuitIntent.ts`;
  - `apps/server/src/server.ts` (split first).
- **Tests:**
  - first `before-quit` prevented, then exactly one re-entrant `app.quit()` and teardown once;
  - **F7:** the update path runs the handshake in `prepareForUpdateInstall`, and the following `before-quit` is not prevented;
  - a second quit request during `pending` is ignored;
  - an ack timeout still quits after 1,500 ms;
  - SIGTERM 0 ms after the hint still gives quit semantics;
  - `powerMonitor` `shutdown` and `session-end` paths quit with no wait and no hint;
  - the update reason;
  - no hint means detach.

### Wave 3

**S3: Manager integration** (C1, S1, S2, D1, S6; waits for the dirty `Services/Manager.ts` and `Manager.session.ts`)

- Owns:
  - new `Manager.hostScreen.ts`: splice; the snapshot is requested with `attach_renderer = true`; at most 2 snapshot transfers in flight per host connection;
  - `Manager.hostLifecycle.ts`, `Manager.hostPolicy.ts` (including the lease-expiry timer), `Manager.quitPolicy.ts`;
  - `Manager.session.open.ts` and `Manager.process.ts` (both split first), `Manager.session.subscription.ts`, `Manager.process.shutdown.ts`, `Manager.process.state.ts` (where `historyTerminalIdsForThread` lives, F5);
  - `terminal/Services/Manager.ts`;
  - `ws/wsRpcHandlers.terminalSession.ts`, `wsRpcHandlers.terminalEvents.ts`, `wsRpcHandlers.terminalLifecycle.ts`;
  - `terminal/activity/terminalViewRegistry.ts`;
  - the setup-limit path in **`apps/server/src/project/Layers/ProjectSetupScriptRunner.ts:74`** (where `terminalManager.open` is called) and `ws/wsBootstrap.setup.ts`.
- **Pending setup for `retrySetup`.** On a limit refusal, S3 stores `{ threadId, projectId, cwd, worktreePath, env, script id, createdAt }` in a bounded in-memory map (64 entries, 30-minute TTL). `terminal.retrySetup` uses the stored inputs. If the entry is missing (backend restarted, or expired), it re-derives them from the thread's projection (worktree binding and the project's setup script). If neither works, it fails with "The setup inputs are no longer available. Run the setup script again from the project menu."
- **Pane identity for direct-shell deletion guards (N8).**
  - `knownThreadTerminalIds` (`Manager.session.shellOwners.ts:14-24`) currently relies on `historyTerminalIdsForThread`.
  - For host-backed sessions, which keep no TS history, S3 implements `historyTerminalIdsForThread` as the union of the owner-table `terminal:` keys for the thread, host inventory (including `lost` entries) and existing history-file ids. The set of known pane ids therefore never shrinks because S3 stopped writing history.
  - Regression test: a thread with a direct-shell owner record and a host-backed pane blocks deletion exactly as before.
- Tests (fake host client):
  - splice ordering and duplicate drop;
  - `attachOnly` never spawns;
  - the limit error and eviction;
  - a setup script at the limit, with retry (stored inputs and re-derived inputs) and with decline;
  - notice mapping;
  - the shutdown matrix (quit and default, quit and keep, update and default, no hint);
  - policy pushes and the lease-expiry push;
  - host-lost;
  - reattach after a restart with a `screen` item;
  - the direct-shell pane-identity regression.

**W2: View registry and parking** (C1, W0 commit, W3's `terminalLimitPrompt.ts`)

- Owns:
  - new `components/terminal/view-registry/**`:
    - `TerminalViewRegistry.ts`: acquire and release, DOM reparenting, the parking holder;
    - `.policy.ts`: 30 s park delay, warm set of 4 surfaces and ≤ 12 views, restorable-only;
    - `TerminalViewParkingHost.tsx`;
  - `routes/__root.tsx` (mount);
  - `TerminalViewport.tsx` and `TerminalViewport.session.ts` (split first), `.startup.ts`, `.intake.ts`, `.snapshot.ts`;
  - `TerminalLifecycleDiagnostics.ts`, `TerminalRendererController.ts`;
  - `hooks/useTerminalViewReport.ts`: **visible** means `document.visibilityState === "visible"` and the pane is attached to an on-screen slot (not the parking holder, not inside an inert or hidden subtree). Re-report on `visibilitychange`, attach and release;
  - **drawer mount-list removal** after the registry lands: `chat-view/ChatViewContent.tsx`, `chat-view-base-state.ephemeral.hooks.ts`, `chat-view-thread-derived.hooks.ts`, `ChatView.logic.ts` (remove `reconcileMountedTerminalThreadIds` and `MAX_HIDDEN_MOUNTED_TERMINAL_THREADS`);
  - browser tests proving that views survive the `_chat.$threadId.tsx` placeholder, the `ThreadRemoteTargetGate` replacement, route changes (settings), and right-panel thread switches. No edits to those route and gate files are expected; if one is needed, W2 owns it.
- **Intake geometry (N7).** On a `screen` item, resize xterm to the snapshot's `cols`×`rows`, write the ANSI and tail with snapshot replies suppressed, release the queued live replies (§8.9), then run fit, which resizes the PTY.
- Behavior:
  - Borrowers inside an inert subtree (W0's hidden gate subtree) cannot take focus.
  - Intake writes the `screen` item with replies suppressed, then goes live. Subscribe with `acceptScreen`.
  - Startup catches `TerminalLimitError` and calls `promptTerminalLimit`.
- Spike first: prove that reparenting keeps the buffer, WebGL and focus. The fallback is to release and reacquire the WebGL addon around moves.

**W3: Lifecycle UI** (C1, W1 selector)

- Owns:
  - new `terminalLimitPrompt.ts`, **landed first** so W2 can import `promptTerminalLimit(input): Promise<"evict" | "cancel">`;
  - `TerminalLimitDialog.tsx`, `terminalLifecycleNotices.ts` (including the setup toast and `retrySetup`);
  - `stores/terminal/terminalLiveness.store.ts`;
  - `routes/-__root.terminal-events.ts`, `-__root.logic.tsx` (a few lines or split);
  - `sidebar/SidebarThreadRow.tsx`, `SidebarThreadRow.status.ts`, new `SidebarThreadTerminalIndicator.tsx`;
  - `settings/TerminalSettingsSection.tsx`, new `TerminalLifecycleSettings.tsx`;
  - the tests.

### Wave 4

**M7: Direct SSH through the local host** (S1, S3, S6; after the Direct SSH forget-record work is committed)

- Owns:
  - `Manager.shell.direct.ts`, `DirectShellLaunch.dispatch.ts`, `terminal-host/localTerminalHost.directSsh.ts`;
  - **taken over after that commit:** `persistence/Layers/DirectShellLaunchOwners.ts`, `terminal/Layers/DirectShellLaunch.owner.ts`, `Manager.session.shellOwners.ts`, `Manager.shell.direct.policy.ts`;
  - the tests.
- First verify that `OwnedPtyRuntime.resolve.ts` and `Manager.process-drain.remote.ts` accept a local-host runtime for a non-local target.
- Create with `activity_source = owner-hint` and push busy hints from `Manager.remote-inspection.ts`.
- **Forget and delete for host-owned ssh PTYs.**
  - "Forget retained owner" closes the host PTY with terminate if the host reports it live, then removes the owner record.
  - Thread delete closes it through the existing delete close path and waits for the confirmed exit.
  - Because the host can verify liveness, a host-owned ssh PTY blocks deletion only while the host is **unreachable** (unknown). Otherwise it is closed and no longer blocks.
  - Detach (not close) happens only on backend restart or quit in keep mode, as for every host PTY.

**Q1: Qualification and default-on** (all of the above except M7 and M10)

- Owns the end-to-end tests, the default flip, the CHANGELOG, `docs/COMMANDS.md` and the `justfile` if needed.
- **The `terminalLogsDir` cleanup** in `Manager.history-io.ts` (coordinate with dirty work) must **not** delete history files for panes that have a direct-shell owner record, or that appear in the owner table or host inventory. This preserves `knownThreadTerminalIds` (N8). A regression test is required.
- **Quantitative exit criteria:**
  - (a) **Fidelity.** Zero diffs on the R1 corpus under the R1 comparison method and exclusions. ≥ 99.5% of 1,000 randomized parked → restored samples during the soak are cell-identical, and every other sample reports `fidelity` ≠ `full`.
  - (b) **Soak.** 24 h on macOS and on Linux, with 12 terminals, 4 of them agent TUIs:
    - host RSS growth ≤ 10% after the first hour;
    - no growth in file descriptors or workspace roots;
    - zero unexpected closes;
    - zero `model_invalid` events without an injected fault;
    - restore p95 ≤ 150 ms.
  - (c) **Dogfood.** ≥ 2 users for 7 days, with zero lost-terminal reports caused by the host.
  - (d) The §16.4 matrix passes, including item 13 (TCC).

### Wave 5

**M10: Windows Rust host**

- Owns:
  - `pty/windows/**` (ConPTY; the extra `windows-sys` features need dependency review);
  - `supervisor/windows/**` (named pipe, `local_control/windows/pipe.rs` patterns);
  - `terminal_policy/probe/windows.rs`: no process group exists under ConPTY, so a foreground program means the direct child is not a shell, or the shell's console process list contains a non-shell process;
  - `terminal_policy/memory/windows.rs`;
  - `terminal-host/localTerminalHost.windows.ts` (`DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB`).

### Dependency graph

```text
R0 ─┬─ R1 ─┐
    ├─ R2 ─┼─ R5 ──────────┬─ S6 ─┐
    └─ R3 ─┘               │      │
R4 ─┬─ R5                  │      │
    └─ S2 ─────────────────┼──────┼─ S3 ─┐
S1 ────────────────────────┘      │      │
C1 ─┬─ D1 ────────────────────────┘      │
    ├─ W1 (after W0 commit) ─ W3 ─┐      ├─ Q1 ─ M7
    │                    (terminalLimitPrompt.ts)
    └─ W2 (after W0 commit) ◄─────┘      │
W0 (in progress), S4, S5: independent ───┘        M10: after Q1
```

Shippable increments:

- W0, S4, S5 and W1 ship alone. They fix RC1 and stop hidden terminals.
- S1 ships behind its flag and fixes RC3.
- S3, R5, S6, W2 and W3 together deliver D3–D8.

## 16. Test plan

### 16.1 Rust

The R1–R5 tests listed in §15, using `/tmp` short socket roots for real-process tests.

```sh
cargo fmt -p bigbud-remote-agent -p bigbud-protocol --check
cargo clippy -p bigbud-remote-agent -p bigbud-protocol --locked --all-targets -- -D warnings
cargo test -p bigbud-remote-agent --locked terminal_
cargo test -p bigbud-remote-agent --locked --test terminal_host_lifecycle --test terminal_host_churn
cargo test -p bigbud-protocol --locked
```

### 16.2 Server

- S1, S2, S3, S4 and S6 tests as listed in §15.
- Existing regressions: `Manager.navigationRecovery`, `Manager.owned-recovery`, `Manager.lifecycle`, `Manager.confirmedLifecycle*`, `Manager.history*`, `Manager.search*`, `ProjectSetupScriptRunner*.test.ts`, `wsRpcHandlers.terminalSession/terminalEvents`.
- Cross-engine fidelity through the S4 harness and `@xterm/headless`.

```sh
bun run --cwd apps/server vitest run src/terminal-host src/terminal/Layers/Manager.history.retention.test.ts src/terminal/Layers/Manager.hostScreen.test.ts
bun run --cwd apps/server typecheck
bun run --cwd packages/contracts vitest run src/workspace/terminal.lifecycle.test.ts src/core/settings.terminalLifecycle.test.ts
bun run --cwd packages/contracts typecheck
bun run --cwd apps/desktop vitest run src/backend/backendLifecycleHintPipe.test.ts
```

### 16.3 Web

- **Unit:**
  - W1 store rules, including no right-panel auto-spawn and the keybinding guard;
  - W2 policy and intake;
  - W3 notices, liveness and indicator.
- **Browser:**
  - the drawer across dependency-only projects, parked and restored, with identical text;
  - `ThreadProjectGate` (hidden subtree takes no focus or keys);
  - the registry reparent;
  - the `_chat.$threadId.tsx` placeholder, `ThreadRemoteTargetGate` and settings route survival;
  - right-panel thread switching (retention, no spawn);
  - the limit dialog;
  - the sidebar indicator;
  - the settings row.

```sh
bun run --cwd apps/web vitest run src/stores/terminal src/components/terminal/view-registry
bun run --cwd apps/web test:browser src/components/chat/view/ChatView.terminalDrawer.browser.tsx src/components/terminal/view-registry/TerminalViewRegistry.browser.tsx
bun run --cwd apps/web typecheck
```

Formatting and lint use explicit file lists, guarded so that an empty list never formats the repository:
`files=(…); [ ${#files[@]} -gt 0 ] && bun run oxfmt --check "${files[@]}" && bun run oxlint --report-unused-disable-directives "${files[@]}"`.
Also run the direct ≤ 400-line check.

### 16.4 Manual matrix (Q1; macOS and Linux)

1. Run `claude` in thread A. Switch through 5 threads in 3 projects, including dependency-only ones, a new `mod+n` thread, the settings route and a gated remote thread. Return: same PID, same screen, accepts input, no amber toast.
2. Minimize for 2 minutes during a redraw. The view is parked after 30 s, and the restore is exact. A TUI that sends an OSC 11 query while parked gets an answer.
3. `kill -9` the backend: all terminals reattach with the same PIDs.
4. Quit with the default setting: no shells and no host after 60 s. Relaunch: no terminals.
5. Keep mode: quit and relaunch, exact reattach. A prompt left alone with the app closed for 11 minutes is gone on relaunch, with the replay toast.
6. Idle: a prompt shows the warning at 9 minutes, **Keep open** resets it, expiry closes the terminal with a toast. Never closed: a TUI at its own prompt, `exec sleep 900`, a background job printing every 5 minutes. A p10k prompt with a silent `gitstatusd` does close.
7. Limit: the 25th terminal shows the dialog naming the LRU, non-visible terminal. Cancel and confirm both behave correctly. A worktree setup script at the limit shows the setup toast, retry works, and dismissing it marks the setup failed.
8. Memory: in a debug build, `BIGBUD_TERMINAL_HOST_PRESSURE_OVERRIDE=low` closes only hidden, not-busy terminals, in LRU order, with toasts.
9. **Update with live terminals**: install an update in keep mode. The host survives (AppImage on Linux included), and the new version adopts it. Default mode closes everything.
10. A dev rebuild while terminals run: the running host is adopted through its hello (no digest check). An older host that lacks new capabilities keeps its terminals, and new terminals start in `state-<n+1>`.
11. **macOS TCC (N11).** In keep mode, a host shell runs `ls ~/Documents` before quitting and again after quitting bigbud. Record both outcomes. If access is lost after quit, the keep-mode helper text on macOS gains: "Some protected folders may be unavailable to terminals while bigbud is closed.", and this is filed as a follow-up before Q1 sign-off.
12. Remote-agent target: repeat 1–3 and 6. In a cgroup-limited container, pressure follows the cgroup.
13. Direct SSH (M7): repeat 1 and 3. Pulling the network ends the terminal with its last screen.

## 17. Migration from current behavior

- **Persisted web store.**
  - The version is bumped.
  - Existing panes become `restored` and are removed if they are not live, so they are never respawned.
  - The implicit `"default"` id disappears, so threads that had only it end up with no terminal.
- **Server history files.**
  - They are kept for the fallback.
  - Q1 deletes files for non-live sessions.
- **TS mirror.**
  - It is unused for host sessions and stays default-off.
  - It is retired after M10 in a separate plan.
- **Remote agents.** Old versions keep working in degraded mode, and the existing update flow offers 1.9.
- **Rollout.**
  1. W0, S4, S5 and W1 ship first.
  2. S1 and S3 run behind the flag until Q1.
  3. Parking engages only for `restorable` sessions.
  4. The host applies policy only to managed PTYs.

## 18. Rollback

- **Kill switch.** `BIGBUD_TERMINAL_HOST=0`:
  - the existing host is adopted, attach only, with no new host PTYs;
  - new terminals run in-process;
  - the web degrades automatically (non-restorable views are never parked).
- **Protocol and contracts.** Both are additive.
- **Store migration.** Harmless if rolled back: an older build normalizes back to `"default"`.
- **Host data.** `<stateDir>/terminal-host` can be deleted once no host runs. That includes `hosts.json`, every `state-<n>/` and `runtimes/`.

## 19. Risks and decision gates

| Risk                                          | Mitigation / gate                                                      |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| `vt100` fidelity gaps                         | M0 and R1 zero-diff corpus against `alacritty_terminal`; exact pin     |
| Frame size                                    | Chunked snapshots, maximum-size goldens                                |
| Agent resource exhaustion                     | Root release, per-cwd roots, retirement before refusing, churn test    |
| Version skew between app and host             | Registry, adoption by protocol major, staged runtimes, no silent kills |
| Launch regressions (PATH, integration, hooks) | S6 parity tests before Q1                                              |
| Quit and SIGTERM race                         | Acknowledged hint, drain on SIGTERM, race test                         |
| New clients closing old clients' PTYs         | Per-PTY `lifecycle_managed` opt-in, policy off by default              |
| Parked programs that query                    | Bounded responder gated on renderer attachment; otherwise never park   |
| Reparenting xterm                             | W2 spike, WebGL release and reacquire                                  |
| AppImage and updater                          | Staged runtime outside the mount, update reason in the hint            |
| Concurrent edits                              | Wait-for-commit rules (§15)                                            |

## 20. Plan assumptions (verify during implementation)

1. Effect `Schema.Struct` ignores excess keys, so W1 can send `attachOnly` early. C1 tests this. If it does not, W1 waits for S3.
2. Node `detached: true` gives the host its own session (S1 test).
3. `makeOwnedRemoteAgentPty` works with a host registry adapter (S1).
4. The desktop ships the agent binary for macOS and Linux (`workspaceAgent.ts`, `backendEnv.ts`). S1 packaged smoke test.
5. `kern.memorystatus_vm_pressure_level` is readable unprivileged. If not, use available memory alone.
6. `backendStartupStatusPipe` can stay open after startup. If not, D1 adds fd 6.

## 21. Acceptance criteria

1. **New threads.** A new thread has no terminal and no PTY, and the sidebar shows nothing for it. Switching threads with the right panel open creates nothing.
2. **Open, minimize, close.** They follow §11.1. After a close, the terminal is absent from inventory and its spool is gone.
3. **Thread switching.** The RC1 transitions and the gates never dispose a process. Text is identical after warm and parked returns.
4. **Parking.** Views park after 30 s outside the warm set of 4. Non-restorable views are never parked.
5. **Backend restart.** A backend kill keeps every host terminal (same PID) in both modes.
6. **Quit.** The default leaves nothing running after 60 s. Keep mode reattaches with exact screens. Updates behave per §14.
7. **Idle close.** It follows the §8.5 user-decided rule exactly, for managed PTYs only.
8. **Memory pressure.** Only hidden, not-busy, managed terminals close, in LRU order, with toasts.
9. **Limit.** The limit dialog and the setup-script path behave per §8.8 and §11.3.
10. **Launch parity.** S6 parity holds: the same `PATH`, integration and hooks as today, and hooks survive restarts.
11. **Churn.** 100 PTYs churn without resource-limit errors.
12. **Budgets and qualification.** §13 budgets and the Q1 quantitative criteria are met.
13. **Checks.** Focused checks pass, and every changed file is ≤ 400 lines.

## 22. Plan validity

This plan describes `dev` at `b2e8cd0d70`, with the dirty worktree in §0. Revalidate if:

- the remote-agent supervisor, session or pty modules, `protocol/remote-agent/*.proto`, or `DEFAULT_MAX_FRAME_BYTES` change;
- protocol 1.9 or fields 80–95 are taken;
- the in-flight RPC or Direct SSH changes land with other shapes;
- W0 lands with a scope different from §15;
- the store or viewport session are restructured;
- the pinned crates change.

External facts were checked on 2026-11-21.

## 23. Handoff notes

- **Order.**
  - Rust: R0 → (R1 ‖ R2 ‖ R3 ‖ R4) → R5.
  - Server: S1 ‖ S4 ‖ S5 → S2 → S6 → S3.
  - C1 first. D1 after C1.
  - Web: W0 (in progress) → W3's prompt module → W1 ‖ W2 ‖ W3.
  - Then Q1, M7, M10.
- **Settled.**
  - **Host.** The staged `bigbud-remote-agent` with its own state root, its own registry and transport, and adoption by protocol major. No new SQLite table.
  - **Busy rule.** User-decided (§8.5).
  - **Visibility exemptions.** Visible terminals are never idle-closed or pressure-closed, and never chosen as the limit's oldest (the limit exclusion is a deviation the user accepted).
  - **Policy scope.** Lifecycle policy is off by default and opt-in per PTY.
  - **Constants.**
    - Limit: 24 managed per host.
    - Idle: 10 minutes, with a 60 s warning.
    - Orphan grace: 10 minutes (default mode).
    - Spool: 2 × 4 MiB plus a checkpoint, deleted on close.
    - Screen: visible rows plus 1,000 scrollback.
    - Snapshot chunks: ≤ 192 KiB, with ≤ 2 transfers in flight per host.
    - Warm set: 4 surfaces, 30 s park delay.
  - **Setup scripts.** They count as user-opened, with the setup toast at the limit (user-decided).
  - **Windows.** In-process until M10.
- **Not blockers.** The M0 dependency approval and the Q1 qualification. Both are engineering gates with criteria.
- **Remaining questions** (non-blocking confirmations; the plan proceeds with the stated default):
  1. Should a terminal visible on screen but untouched for 10 minutes be idle-closed? Default: no. Visibility counts as use.
  2. Is deferring Windows to M10 acceptable? Until then Windows terminals close on quit even with the setting on, die on backend restart, and have no idle, pressure or limit policy and no parking.

## 24. Revision 2 change log (review findings)

| #     | Finding                                                                                                                  | Where addressed                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Snapshot vs 1 MiB frame cap                                                                                              | §8.4, §9.1 (chunk frames 81/82, `boxed`, maximum-size goldens), S2 reassembly                                                                                        |
| 2     | Workspace roots and session cap                                                                                          | §8.10, R5, S2, churn test                                                                                                                                            |
| 3     | `--prepare-supervisor` exact-digest adoption                                                                             | §7.3 (registry, own transport, protocol-major adoption, missing binary, macOS same), S1 tests                                                                        |
| 4     | Launch parity                                                                                                            | New S6, §12, `local_launch` field, R5 `environment.rs`                                                                                                               |
| 5     | AppImage and updater                                                                                                     | §7.3 item 1 staging, §14 update quit, D1 `main.bootstrap.ts`, Q1 matrix item 9                                                                                       |
| 6     | Right-panel auto-spawn                                                                                                   | §3, §11.1, W1                                                                                                                                                        |
| 7     | W0 in progress, ownership edges                                                                                          | §0, §15 W0, W1/W2 wait for W0, mount-list removal in W2, `operation_handlers.rs` R4→R5, W3→W2 edge, `server.ts` and `main.bootstrap.ts` split-first in D1            |
| 8     | Busy rule                                                                                                                | §8.5 (user-decided), R3 real-PTY tests, §16.4 item 6                                                                                                                 |
| 9     | Quit hint race                                                                                                           | §9.2 ack record, §14, D1 race test                                                                                                                                   |
| 10    | Policy opt-in                                                                                                            | §8.7, `lifecycle_managed`, R5 test                                                                                                                                   |
| 11    | Queries while parked                                                                                                     | §8.9, R1, R5, `restorable` rule                                                                                                                                      |
| 12    | Actor must not block the reader                                                                                          | §14, R1 `try_feed`, R5 exit criterion                                                                                                                                |
| 13    | Exact pin, fixtures, criteria, licenses                                                                                  | M0, R1                                                                                                                                                               |
| 14    | Flag rule and kill switch                                                                                                | S1, §18                                                                                                                                                              |
| 15    | Local target id and transport                                                                                            | §7.3 item 4, §8.1, S1                                                                                                                                                |
| 16    | Lease expiry and the definition of visible                                                                               | §14, S3 timer, W2 `useTerminalViewReport.ts`                                                                                                                         |
| 17    | Setup scripts at the limit                                                                                               | §8.8, §11.3, S3, W3, C1 `retrySetup`                                                                                                                                 |
| 18    | Short socket roots, stable+dev concurrency                                                                               | §7.3 items 2 and 9, S1 tests                                                                                                                                         |
| 19    | Time Machine                                                                                                             | §8.3, R2                                                                                                                                                             |
| 20    | Reference fixes                                                                                                          | Existing `terminal.store.types.ts`, `remoteAgentPtyClient.types.ts`, `Manager.history.retention.test.ts`; frames 80–95; socket chmod at `supervisor/bootstrap.rs:16` |
| Extra | cgroup v2, accepted deviation, mobile-web, Q1 criteria, RC1e correction, W0 out-of-scope items, hidden-gate key handlers | §8.6, §8.8, §5, Q1, §3, §15, §14                                                                                                                                     |

### Revision 3 (re-review)

| #     | Finding                                                                                                           | Where addressed                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| N1    | Environment allowlist blocks launch parity                                                                        | R5 `protocol_helpers.rs` local validator; §12; S6 real-login-environment test                                 |
| N2    | Warning could never fire                                                                                          | §8.5 three-use table, aging-out rule, fake-clock tests                                                        |
| N3    | Chunks vs writer caps and budget                                                                                  | §9.1 snapshot transport (192 KiB, paced, lazy, 2 in flight); R5; 24-request test                              |
| N4    | Snapshot under the session mutex                                                                                  | §9.1 snapshot worker; R5 latency exit criterion                                                               |
| N5    | `--proxy` is a byte forwarder                                                                                     | §7.3 item 4 (current staged proxy or direct socket; hello-only compatibility; "binary gone" dropped)          |
| N6    | Undecidable "empty host" and the launch crash window                                                              | §7.3 items 3 and 5 (owners table plus children, unknown = live, provisional record, socket-only adoption)     |
| N7    | Zero diffs likely unreachable                                                                                     | R1 comparison method and exclusions, the neither-passes rule, W2 intake geometry                              |
| N8    | Direct-shell deletion guard depends on history ids                                                                | S3 pane-identity union and test, Q1 cleanup exception, M7 ownership plus forget/delete semantics              |
| N9    | Nested shells counted as programs                                                                                 | §8.5 foreground-leader check, ssh/tmux documented, nested-bash test                                           |
| N10   | Synchronous `before-quit`                                                                                         | §14 handshake steps, OS shutdown/logout path, D1 tests                                                        |
| N11   | Older host lacking capabilities; TCC                                                                              | §7.3 item 6 (state generations), §16.4 item 13                                                                |
| N12   | Responder replies, sidebar colour, `pidStartTime` source                                                          | §8.5 (`last_input`, sidebar row), §7.3 item 3 (hello fields plus `ps -o lstart=`)                             |
| Other | Setup runner path, explicit refcount, `retrySetup` inputs, rebuild fencing, Time Machine plist, hydration queries | S3 (`project/Layers/ProjectSetupScriptRunner.ts:74`, pending-setup map), §8.10, §14 rebuild steps, §8.3, §8.9 |

### Revision 4 (third review: Ready with fixes)

| #   | Finding                                                     | Where addressed                                                                                                      |
| --- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| F1  | A snapshot during heavy output could make the model invalid | §9.1 "Copy at the fence"; R5 exit criterion (3 MiB snapshot at 10 MB/s, no `model_invalid`)                          |
| F2  | Generations share one target                                | §7.3 item 4 connection bindings per generation; item 5 "live" matches connectionId and epoch; S1 two-generation test |
| F3  | Local validator should skip, not fail                       | R5 `protocol_helpers.rs` skip rule; `BASH_FUNC_x%%` test                                                             |
| F4  | Missing regression and memory tests                         | R5 exit criteria (fidelity stays full under load; copies within the §13 RSS budget)                                  |
| F5  | `Manager.process.state.ts` ownership                        | S3 owned files                                                                                                       |
| F6  | Unknown foreground leader                                   | §8.5 conservative rule and R3 tests                                                                                  |
| F7  | Update path handshake; `ps` locale                          | §14 quit for update, D1 test, `LC_ALL=C ps` in §7.3                                                                  |
| F8  | Symmetric detach                                            | §8.9 `acked_sequence` on `renderer_attached = false`                                                                 |

### Implementation notes (accepted deviations)

- S4: a lone `CSI 3J` is not a baseline boundary, because it clears only scrollback and the visible screen survives it. It counts as one only right after a home or erase (which covers `clear`). This upholds the rule that a VT suffix must never pass as a full baseline.
- S5: span attributes use the repo naming style: `terminal.thread_id`, `terminal.terminal_id`, `terminal.close_reason`.
- R4: `AgentHello.process_id`/`process_start_time_ms` live in `common.proto`. The large goldens store only their framing bytes plus a shared fill rule (`byte i = i % 251`). Rust `Frame` grew from 216 to 256 bytes because of the flat create fields 12–17, accepted.
- C1: the quit hint is a separate `DesktopLifecycleHintLine` record (not a new `DesktopLifecycleHintKind` value), and D1's reader decodes it. Screen items use a new `TerminalSessionStreamRpcItem` union on the RPC only.
- S1 (committed 84029279af), handed to later milestones:
  - **S3:** `Manager.shell.profile.ts:40` calls `localSupervisorShellHost(runtime.targetId)`, which throws for `local-terminal-host`. Accept the local host target there.
  - **S3/W3:** surface `controller.notices()` (the one-time amber toast) and `controller.closeDrainingHost(n)` ("Close them") through an RPC and a toast.
  - **S2/S3:** add the four 1.9 capabilities to S1's required list only once R5 advertises them, and read `AgentHello.processId`/`processStartTimeMs` from the 1.9 codec.
  - **R5/S6:** add `--local-desktop-host --exit-when-orphaned-and-empty` to the launch, plus the policy push on connect (§7.3 items 8–9). S6 replaces the remote-shaped shell launch (`platform: "linux"`, integration off).
  - **Follow-up:** `assertRemoteAgentRuntimeHello` requires `os: "linux"`. S1's transport verifies the real OS and architecture, then presents `linux`. Make `remoteAgentCompatibility.ts` accept a local-host binding.
  - **Not built yet:** a direct socket transport (proxy only), a cross-process lock on `hosts.json`, and garbage collection of dead `state-<n>` folders.
- D1 (committed 7d10301b1c):
  - The ack travels on the existing fd 4 status pipe as `{"lifecycleHintAck":{"sequence":N}}`, because fd 6 is already taken.
  - **S3:** call `AppQuitIntent.resolve` on shutdown and apply `terminalsKeepRunningAfterQuit`.
  - **Electron signals:** SIGINT/SIGTERM sent to the Electron main process quit without a hint, so the server detaches.
  - **Compatibility:** a new desktop talking to an old server waits the full 1,500 ms on quit.
- W3: the "Close them" action for draining hosts needs an RPC (S3).
- R2/R3 (committed a308135992), notes for R5:
  - **Quiet period:** a change in the idle-busy fact (a foreground program or owner hint starting or ending) restarts `quiet_since`.
  - **Late ticks:** a tick that arrives after the close time with no warning sent still gives the full warning lead.
  - **Checkpoints:** R5 must poll the spool's `checkpoint_wanted()` and call `checkpoint()`. Idle, shutdown and `PtyCloseAll` checkpoints are also R5's.
  - **Segment records:** `[0xB5][seq u64][len u32][bytes]`, so cold reads keep PTY sequence numbers.
  - **xonsh:** it counts as a program (its executable is python), so it never goes idle.
  - **Memory thresholds:** the `HostPolicy` memory thresholds still need mapping onto the 1.9 wire fields.
- Pre-existing, unrelated: `operations::journal::inspect::tests::reports_nonterminal_operations_without_mutating_the_journal` fails on `dev` with `CompactionDeferred("journal directory inventory exceeded its bound")`. It fails the same way in a clean export, so it is not caused by this work.
- S2 (committed b12e8a7eea), wiring for S1/S3/S6:
  - put `host: makeRemoteAgentHostControls(...)` on the OwnedPtyRuntime objects built in `localTerminalHost.adapter.ts` and `OwnedPtyRuntime.resolve.ts`;
  - pass `hostLifecycle` (`lifecycleManaged: true`, `localLaunch: true` from the S6 launch spec) through `makeOwnedRemoteAgentPty` options or the spawn input;
  - read `RemoteAgentPtyLimitError`, which may arrive as the `cause` of S1's `PtySpawnError`;
  - `onSequencedData` emits a multi-byte UTF-8 character that is split across sequences with the later sequence;
  - the per-cwd handle normalises the cwd but does not resolve symlinks.
- R1 (committed with R0): `vt100 =0.18.1` plus a bigbud correction layer passes the corpus: 23 of 23 fixtures with zero diffs outside reported exclusions, and 985 of 1,000 randomized streams exact. The alacritty prototype does not pass and stays a dev-only comparison.
  - **Engineering approval (coordinator, 2026-11-21):** two added exclusion categories are approved. Both are reported through `fidelity` with row counts:
    - `unsupported_attributes`: blink, invisible, strikethrough, overline, underline style or colour, bold+dim;
    - `unsupported_modes`: rows written with autowrap off, insert mode on, or reverse wraparound on.
  - **Accepted residuals** (rare, not reported):
    - character-set restore follows the save-time designations only;
    - attributes on an orphaned half of an overwritten wide character;
    - ED 3 between a cursor save and restore;
    - emoji newer than Unicode 11 may differ in width. Q1 measures this.
  - **Memory budget:** a full 200×50 model with 1,000 scrollback rows is about 6.8 MB (vt100 uses 32-byte cells). The user asked for about 1,000 rows, so the §13 per-model budget is raised to 7 MiB rather than cutting scrollback.
  - **Ingest rate:** measured on a machine under heavy load at about 34 MiB/s, against the 50 MiB/s target. Q1 re-runs the release bench on an idle machine; if it is still short, optimise the layer before default-on.
  - **For S4/Q1:** xterm.js master now tracks kitty keyboard state. Re-check whether the kitty exclusion is still needed once the web app's xterm version has it.
  - **Release management:** check whether `bun run licenses:rust` must be regenerated for the dev-only `alacritty_terminal` and its transitive packages.
- R5 (committed), notes:
  - **Replay ring:** screen PTYs keep a 256 KiB replay ring (instead of 4 MiB) and a 512 KiB screen-feed queue. Reconnecting after more than 256 KiB of output falls back to a snapshot.
  - **Lost PTYs:** inventory reports them as `state = "outcome-unknown"` with `lost = true`.
  - **Session retention:** "retire the oldest delivered exit at 64 sessions" now applies on every supervisor.
  - **Snapshot size:** the UTF-16 cap limits ASCII-heavy snapshots to about 1 MiB, so tests use the largest snapshot that fits.
  - **Memory:** release RSS peaks at 244 MiB at 24 PTYs; debug sits at 251–260 MiB. Q1 measures release builds.
  - **New refusal codes** for S1/S3: `PTY_UNKNOWN`, `PTY_LIFECYCLE_UNAVAILABLE`, `SCREEN_UNAVAILABLE`, `SNAPSHOT_TOO_LARGE`, `SPOOL_UNAVAILABLE`, `INVALID_ARGUMENT`, `PTY_EPOCH_MISMATCH`. `activity_state` is `busy`, `idle` or `idle_warning`.
  - **Blocking before Q1 (R6):** the PTY reader sleeps a fixed 5 ms when its buffer is empty, which caps output at about 0.2 MB/s on macOS. The fix is a poll-based reader plus backpressure: stop reading when the per-connection window is full instead of dropping the client.
  - **Test environment:** journal tests fail when `$TMPDIR` holds thousands of old `bigbud-*` entries (about 3,700 locally). This is a test-environment issue, not a regression.
- R6 (committed): output now runs at about 79 MB/s end to end on macOS (32 MB/s for managed PTYs, paced by the screen model). A paused client throttles its PTY instead of being dropped, and echo p99 is about 0.6 ms during maximal snapshots.
  - **Blocking before Q1 (R7):** peak host RSS at 24 PTYs is now 250–259 MiB against the 256 MiB budget, because full-speed bursts fill the spool and screen queues at once. Two fixes:
    - share one copy of each output chunk between the replay ring, the screen model and the spool, instead of copying it three times (touches R1 and R2);
    - batch the macOS PTY reads, which come in about 1 KiB pieces (about 50,000 frames per 51 MB), to cut per-frame overhead.
  - **Known limit:** the global writer budget (8 MiB) can still couple PTYs once about 32 connections are stalled at once.
  - **Diagnostics:** supervisor stderr goes to `<state>/supervisor.log`. Surface it in diagnostics.
- S6 (committed 543b602fc2):
  - **Shell integration:** it travels through the environment only (`ZDOTDIR`, `PROMPT_COMMAND`, `XDG_DATA_DIRS`, hook paths), exactly as node-pty gets it. The intent's `integration` field stays `"disabled"`.
  - **PWD:** set to the requested cwd, as node-pty does.
  - **Environment limits:** an environment over 512 entries or 256 KiB, or hook paths outside `<stateDir>/shell-integration`, runs in-process.
  - **S1 fixes:** generation-based connection binding, and pin-registry promotions.
  - **Handed to S3:**
    - `Manager.ts:136` must call `shellIntegrationRoot(stateDir)`.
    - **Coordinator decision:** a custom shell outside the Rust `pty_profile` allowlist (`/bin`, `/usr/bin`, `/usr/local/bin`, `/opt/homebrew/bin`) falls back to in-process in TypeScript instead of failing on the host.
    - Quit close-all must reach draining generations too, not only the admitted one.
    - Mark lost PTYs `host-lost` and request cold snapshots.
    - `Manager.shell.profile.ts:40` must accept `local-terminal-host`.
  - **Old opt-in owners:** S1 owner rows from opt-in dev builds recorded `platform: "linux"`. Recovery is unaffected; a fresh spawn against a live one reports a launch-intent conflict.
- R7 (committed b95b2afb70): one shared allocation per output chunk, batched reads (64× fewer flood frames), 123 MB/s for unmanaged PTYs and 35 MB/s for managed ones, echo p99 4.1 ms during a flood, cached quiet snapshots, deferred flood checkpoints, and a spool backlog gate.
  - **Memory:** the live heap is now mostly screen grids (about 160 of 185 MiB at 24×1,050 rows). macOS allocator fragmentation set peak RSS at 255–263 MiB.
  - **Coordinator decision:** the local host launches with `MallocMaxMagazines=1` on macOS (host env only; PTYs never inherit it), which measured 245–252 MiB peak, within the 256 MiB §13 budget.
  - **Q1:** if more headroom is needed, evaluate a fragmentation-resistant allocator (e.g. mimalloc; a new dependency, needs approval) or a compact row format, before reducing scrollback.
- M7 (committed):
  - **Records:** Direct SSH PTYs run in the local host with `activity_source = owner-hint`. A v2 "hosted" record in `direct_shell_launch_owners` ties each pane to its SSH target; legacy methods ignore v2 rows.
  - **Owner hint:** defaults to `unknown` (busy), because Rust clears the hint when it is empty.
  - **Follow-up:** a reattached Direct SSH PTY has no remote shell PID (the marker is printed only at launch), so its hint stays `unknown` and it is never idle-closed. Store the remote PID in the owner row to fix this.
  - **Password targets:** they survive a restart only while the backend's ControlMaster lives.
  - **Stale records:** hosted records left after a default-quit close-all are removed on the next close, delete or open.
- Q1, automatable part (the default stays opt-in):
  - **History cleanup (N8):** deleting a thread's or pane's history keeps the files of panes that still have a direct-shell owner record (v1 or hosted v2), a non-terminal row in the host owner table, or a lost PTY in the host inventory; an unreadable source keeps them all. A pane whose process the same close confirmed stopped is not held back by a host row that has not caught up.
  - **M7 follow-up done:** the hosted record stores the remote shell PID (`remoteShellPid`), a reattached PTY gets it back, and a fresh PTY under a kept record clears it until its own marker arrives.
  - **Inventory:** `hostGenerations.inventory()` returns one `ok`/`unreachable` result per generation; the Direct SSH client uses it instead of its own probe.
  - **Bug found by the end-to-end tests:** a host first launched by a terminal (not adopted at startup) had no notice cursor until the 30 s tick, so a keep-mode quit within it lost the "while bigbud was closed" summary. The hub now sets the cursor when a host is first admitted after startup.
  - **Debug clocks:** `BIGBUD_DEBUG_TERMINAL_IDLE_MS` (debug builds) replaces the idle timeout, with the warning at half of it. The local host launch now passes every `BIGBUD_DEBUG_TERMINAL_*` variable through, which `BIGBUD_DEBUG_TERMINAL_PRESSURE` also needed. §16.4 item 8's `BIGBUD_TERMINAL_HOST_PRESSURE_OVERRIDE` is really `BIGBUD_DEBUG_TERMINAL_PRESSURE`. `BIGBUD_DEBUG_TERMINAL_HOST_STATS_MS` (any build) writes live PTYs, workspace roots and owners to `supervisor.log` for the soak.
  - **Fidelity:** the 23 R1 goldens restore in `@xterm/headless` with zero diffs outside reported exclusions. 1,000 exported randomized streams: 985 identical (98.5%), 9 differ with reduced fidelity reported, and 6 differ while reporting `full`, all in DEC special-graphics translation (the "save-time designations" residual). That misses criterion (a) (≥ 99.5%, and every differing sample must report reduced fidelity); fix the charset handling or report it before default-on.
  - **Kitty keyboard:** the web app's `@xterm/xterm` 6.1.0-beta.304 supports the protocol only behind `vtExtensions.kittyKeyboard`, which bigbud does not enable, and exposes no flag state, so the exclusion stays.
  - **To check:** thread deletion also purges `terminal-history` files through `ThreadDeletion.files.ts`, which does not consult the retained-pane set.
