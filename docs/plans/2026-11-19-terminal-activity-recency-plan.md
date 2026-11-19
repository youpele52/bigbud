# Terminal activity: recency and finished work in Inyosira

**Status:** Ready for implementation (all open questions decided by the user on 19 November 2026;
ownership investigation and the phase 3 spike recorded below)
**Date:** 19 November 2026
**Related:** [Inyosira mode](2026-10-30-inyosira-mode-plan.md),
[Inyosira Rust organiser](2026-11-05-inyosira-rust-organiser-plan.md),
[terminal work idle protection](2026-11-05-terminal-work-thread-idle-protection-plan.md),
[native scheduling authority](../decisions/2026-11-05-inyosira-native-scheduling-authority.md)

## Problem

Inyosira sorts threads, and labels them ("2h", "3d"), by one key:
`COALESCE(latest_user_message_at, created_at)` (`Sidebar.sort.logic.ts`, `SidebarThreadRow.tsx`,
server paging in `ProjectionCatalogQuery.threadPages.ts` / `.organization.ts` / `.sidebar.ts`,
kept exact by the triggers in migration 154). Terminal use never moves that key, and terminal work
never reaches "Needs you". A thread where the user works only in the terminal (raw shell commands,
one-shot CLIs, or a TUI such as Claude Code, OpenCode, Codex CLI or herdr in a bigbud pane) sinks
below chat threads, and a long build or agent run finishing there goes unnoticed.

## Decisions (user, 19 November 2026)

1. **Only Enter counts as terminal input activity.** A submitted line (a shell command or a TUI
   prompt) is the terminal equivalent of sending a chat message. Focusing a pane, scrolling,
   resizing or typing without Enter does not count.
2. **Finished terminal work counts, and goes to "Needs you".** When work in a pane finishes while
   the user is not looking at that terminal, the thread moves up and into Needs you:
   - raw shell commands and one-shot CLIs that ran for **at least 1 minute**;
   - interactive TUIs that signal completion through a **hook** (below).
3. **The finished item shows the command and its exit code**, for example "`npm test` · exit 1 ·
   4m" or "`cargo build` · done".
4. **No guessing.** The terminal bell, idle-output heuristics and anything that only suggests the
   terminal _might_ need the user never raise attention.
5. **Local and remote terminals behave the same.**
6. **The `>_` row icon already shows a running terminal**; no new row indicator. "Last terminal
   activity 2h ago" goes into the thread's **elevator summary** hover card, and is shown on its own
   when the thread has no elevator summary.
7. **Ctrl-C stops skip Needs you.** A command that exits 130 (SIGINT) is "stopped": it still counts
   as recency but never raises attention or notifies.
8. **Recency coalescing window: 60 s.**
9. **Finished items notify twice:** an in-app toast and a desktop notification, following the
   existing task-completion pattern (`apps/web/src/notifications/taskCompletion.tsx`): the toast is
   gated by "task completion toasts", the system notification by "system task completion
   notifications" and is shown only while the app window is hidden, exactly like task completions.
   Toast severity: green (`success`) for exit 0 or unknown, red (`error`) for a non-zero exit. No
   notification when the user is viewing that pane (the server never raises it then). bigbud has no
   separate do-not-disturb setting; the two existing notification settings are respected.
10. **Rust where it fits** (see Ownership below): parsing lives where the PTY bytes are read for
    _every_ terminal; the attention decision stays in the Rust organiser.
11. **TUI hooks are auto-injected inside bigbud panes only** (phase 3 update): bigbud's pane shell
    integration defines thin per-tool shell functions that add a completion hook at launch, without
    touching the user's config files, behind the setting "Detect when terminal agents finish"
    (default on). Tools that cannot be injected safely get copyable snippets in Settings ›
    Terminal.

Non-goals: parsing terminal output text, persisting output heartbeats (the organiser plan rules
these out), bigbud-run notify commands or sockets, and writing users' TUI or shell config files.

## Ownership investigation (where each piece lives, with evidence)

- **Local PTYs are owned by the TypeScript server.** `apps/server/src/server.pty.ts` selects
  `BunPTY` (macOS/Linux) or `NodePTY` (Windows) for the default desktop profile. The Rust
  supervisor owns local PTYs only in the remote backend profile (`config.mode === "remote"`,
  `remote-backend/localSupervisorPty.ts`).
- **Remote PTYs are owned by the Rust agent** (`crates/bigbud-remote-agent/src/pty`), but their
  bytes are relayed to the same server terminal manager
  (`apps/server/src/terminal/Layers/Manager.process-drain.ts` `onData`), and every keystroke from
  any client passes through `TerminalManager.write`.
- **Decision:** a Rust parser could serve only the remote and remote-profile paths; serving the
  default local path would need new IPC (a native addon or a supervisor round trip per output
  chunk), which the user ruled out. The OSC 133 / `bigbud;done` parser, Enter detection, the 60 s
  threshold and the 130 skip are therefore implemented **once**, in the server terminal manager,
  which sees all local and remote bytes. No local PTY ownership moves in this task.
- **The attention decision is Rust.** A finished item becomes an organiser attention fact; the Rust
  scheduler (`crates/bigbud-desktop-supervisor/src/organization/scheduler.rs` `reaction`) already
  moves an `actionable` row with a new attention watermark to Needs you and returns an automatic
  Needs you placement to Present once nothing is actionable. No Rust code or protocol change is
  needed: TypeScript only reports facts, Rust decides.
- **Protocol compatibility:** no remote-agent or organiser protocol change. Markers travel inside
  the PTY byte stream that older agents already relay. The new client stream item is opt-in
  (`includeWork`, the same pattern as `includeInventory`), and every new `ThreadSummary` field is
  optional, so older clients and servers ignore them. No new crates.

## Signals

| Signal                                  | How it is detected                                                                                                                                                                                  | Local | Remote                                     |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------ |
| Enter submitted                         | a client `terminal.write` containing `\r` or `\n` outside a bracketed paste (`ESC[200~ … ESC[201~`), or kitty `CSI 13 u`; `ESC CR` (Alt+Enter) does not count; bigbud's own writes do not count     | yes   | yes, same path                             |
| Command finished, with exit code        | shell integration: **OSC 133** `C` (output start, optional `cmdline_url=`) and `D;<exit>` (finished); duration = `D` time − `C` time; a `D` without a fresh `C` is ignored (no duplicates)          | yes   | yes, markers travel in the PTY byte stream |
| Command finished, fallback (no markers) | the existing 1 s process poll's `activity` event: the pane's foreground subprocess goes from running to none; duration from the poll; no exit code; used only while no OSC 133 marker has been seen | yes   | yes (batched `ps` over SSH; not Windows)   |
| TUI turn finished                       | the exact marker `ESC ] 777 ; bigbud ; done BEL` (or ST) in the pane output; matched exactly, carries no content                                                                                    | yes   | yes, marker travels in the PTY byte stream |

## Design

### Server

- **Recency column.** `projection_threads.latest_terminal_activity_at` (nullable ISO string), added
  by migration 180 with a `terminal_finished_attention` table. The sort key everywhere becomes
  `MAX(COALESCE(latest_user_message_at, created_at), COALESCE(latest_terminal_activity_at,
created_at))`; migration 180 replaces the two migration 154 activity page indexes with indexes on
  that exact expression, so paging stays an index walk and the client and server agree.
- **`TerminalActivity` service** (`apps/server/src/terminal/activity/`):
  - `submit(threadId, terminalId, at)` from client writes (the RPC handler passes
    `{ origin: "client" }`; internal writers such as project setup scripts do not count);
  - `finished(threadId, terminalId, candidate)` from OSC 133 `D`, the poll fallback, or the hook
    marker;
  - coalesces recency per thread: the first Enter after a quiet minute is written at once, later
    ones within 60 s are folded into one trailing write (latest time wins); flushed on server
    shutdown; never touches `latest_user_message_at`, `last_activity_at` or retention aging.
- **Needs you.** A finished item is raised only when the command ran at least 60 s (or the hook
  marker arrived), the exit code is not 130, and no client is viewing that pane. It is stored in
  `terminal_finished_attention` (one row per pane, latest wins; command first 120 characters, never
  output; exit code when known; duration; source) and becomes the attention identity
  `terminal-finished:<terminalId>:<finishedAt ISO>` in `organizationFacts.query.ts` plus an
  `EXISTS` branch in `organizationAttentionSql`; the server then marks the thread for a prompt fact
  refresh (`organizationOwner(sql)?.observe`). It is cleared when the user opens the thread, views
  that pane or presses Enter in it. Rows survive restarts; rows of deleted threads are pruned at
  startup.
- **Viewing.** Clients report what they are viewing with `terminal.view`
  (`{ threadId | null, terminalIds[] }`): the open thread and its visible panes while the window is
  visible and focused. The server keeps one entry per connection with a 2-minute lease (clients
  refresh every 45 s) and forgets it on disconnect.
- **Client delivery.** Opt-in `workActivity` items on the global terminal events stream carry
  `latestActivityAt` and, when raised or cleared, the finished item for one pane.
- **Shell integration (local POSIX panes).** Injected through the environment only, never through
  user files or prompt text: zsh via a bigbud `ZDOTDIR` whose `.zshenv` restores the user's
  `ZDOTDIR` immediately, sources the user's `.zshenv`, and installs `preexec`/`precmd` hooks with
  `add-zsh-hook` (appending, so prompt frameworks keep working); bash via an exported
  `PROMPT_COMMAND` bootstrap that sources the integration once and prepends itself to the user's
  `PROMPT_COMMAND`; fish via `XDG_DATA_DIRS` `vendor_conf.d`. Hooks emit only OSC 133 `C` / `D`.
  The integration does nothing when the shell already runs a known integration
  (`ITERM_SHELL_INTEGRATION_INSTALLED`, `VSCODE_SHELL_INTEGRATION`, kitty, Ghostty, WezTerm) and
  the server ignores duplicate `D` markers. PowerShell, cmd, WSL and SSH remote shells are not
  auto-integrated in this task: they use the poll fallback, and markers from a user's own
  integration work unchanged (see "Pending" below).

### TUI hooks (phase 3, spike results)

| Tool        | Mechanism                                                                                                               | Verified here                                                                                                                                                                                                                                                                                                               | Status                                                                                                                                                      |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | `--settings <bigbud-claude-hooks.json>` with one `Stop` hook returning `{"terminalSequence":"ESC]777;bigbud;done BEL"}` | Docs: hooks run **without a controlling terminal**, so `/dev/tty` fails; `terminalSequence` (OSC 777 allowlisted) is the supported path. Local test with v2.1.328 and an isolated `CLAUDE_CONFIG_DIR`: a `SessionStart` hook from user settings **and** one from `--settings` both ran, so `--settings` hooks are additive. | **Injected.** Pending live verification: that `777;bigbud;done` passes the OSC 777 allowlist in an interactive session (docs give no parameter rules).      |
| Codex CLI   | `-c 'notify=["sh","-c","printf … > /dev/tty"]'`                                                                         | `codex --help` (v0.170.0) documents `-c key=value`. `notify` is a single value, so a per-run override would replace the user's own `notify`.                                                                                                                                                                                | **Injected only when the user's `config.toml` sets no `notify`** (otherwise snippet). Pending live verification: that the notify child can open `/dev/tty`. |
| OpenCode    | a plugin listening for `session.idle` that writes the marker to `/dev/tty`                                              | v2.3.2 installed; plugins live in the user's config directory.                                                                                                                                                                                                                                                              | **Snippet only.** Pending live verification.                                                                                                                |
| herdr       | herdr is itself a pane multiplexer with built-in agent integrations (`herdr integration`)                               | Whether inner-pane OSC sequences reach bigbud's PTY is not documented.                                                                                                                                                                                                                                                      | **Snippet only** (run the marker from herdr's own completion hook). Pending live verification.                                                              |

Injector rules: each wrapper is a shell function defined only by bigbud's pane integration (so it
never exists outside bigbud panes); it checks flag support once per shell (`--help` lists
`--settings` / `--config`) and silently calls the real binary unchanged when unsupported, when the
setting is off (`BIGBUD_TERMINAL_AGENT_HOOKS` absent), or for non-interactive subcommands
(`claude -p`, `codex exec`, `mcp`, `login`, …). No prompt text or user file is changed.

### Web

- `sortThreadsForSidebar` and the row label use the max of the three times.
- The Needs you row shows the finished item: command, "exit N" in red for a non-zero exit, "done"
  for zero or unknown, and how long ago.
- The elevator summary hover card adds "Last terminal activity 2h ago"; without an elevator summary
  the hover card shows that line alone.
- Toast and desktop notification per decision 9.
- Settings › Terminal: "Detect when terminal agents finish" toggle and "Terminal agent hooks"
  snippets.

### What does not change

- The `>_` running indicator on the row.
- Idle protection: terminal busy/idle still vetoes idle moves, as today.
- Retention aging (`last_activity_at`).
- The Rust organiser, remote agent and their protocols.

## Phases

1. **Enter-based recency and the hover line.** Submit detection, `TerminalActivity.submit`,
   migration 180, server sort/label key, summary field, web sort/label, hover line. Acceptance: in
   a thread used only through its terminal, pressing Enter moves it to the top of its section
   within one coalescing window, locally and on a remote backend; typing without Enter, focusing,
   resizing and output never move it; a busy session writes the column at most once a minute.
2. **Finished commands with exit codes.** Shell integration, signal parsing, poll fallback,
   `terminal-finished` attention fact, viewing reports, the Needs you row, clearing, toast and
   desktop notification. Acceptance: a 70 s `sleep 70; false` in an unfocused pane moves its thread
   to Needs you showing "exit 1"; a 30 s command does not; a 70 s command in the viewed pane does
   not; Ctrl-C (130) does not; opening the thread clears it; the same on a remote backend with
   markers; a shell without markers uses the poll fallback (no exit code).
3. **TUI hooks.** Marker parsing, injected wrappers, the setting, and snippets. Acceptance: with the
   setting on, a Claude Code turn finishing in an unfocused pane moves the thread to Needs you;
   with it off, nothing changes.

## Tests

- Server: Enter detection (plain Enter, `\n`, paste without Enter, Alt+Enter, kitty Enter, internal
  writes), recorder coalescing and flush, OSC 133 parsing across chunk boundaries (exit codes,
  missing `C`, duplicate `D`, `cmdline_url`), the 60 s threshold, the 130 skip, viewing
  suppression, poll fallback, hook marker exact match (similar markers ignored), attention fact
  raise and clear, persistence, paging order by the max key, migration test.
- Web: sort and label (chat-only, terminal-only, mixed), the finished line with and without an exit
  code, the hover text with and without an elevator summary.
- Shell integration: generated scripts emit only OSC 133 `C`/`D`, skip known integrations, and the
  agent wrappers pass arguments through unchanged when unsupported or disabled.

## Risks

- **Prompt frameworks** may reset hooks; zsh uses `add-zsh-hook` (append), bash prepends to
  `PROMPT_COMMAND`, and server-side duplicate suppression makes double markers harmless. A user
  `.bashrc` that overwrites `PROMPT_COMMAND` disables bash integration (poll fallback remains).
- **Recovered remote output** may replay a hook marker after reconnect; OSC 133 durations restart
  at replay so they stay below 60 s, but a replayed `bigbud;done` can re-raise one item.
- **Hook reach:** see the phase 3 table; unverified tools are marked pending.
- **Busy interactive TUIs** cost one recency write per minute per thread.

## Implementation notes (19 November 2026)

- **Where each piece lives.** TypeScript server: Enter detection
  (`terminal/activity/terminalSubmitDetector.ts`), OSC 133 / marker parsing
  (`terminalWorkSignalReader.ts`), 60 s / 130 / viewed policy (`terminalFinishedPolicy.ts`),
  coalescing (`terminalRecencyCoalescer.ts`), viewing (`terminalViewRegistry.ts`), persistence and
  organiser facts (`Layers/TerminalActivity.ts`), manager hooks (`Layers/Manager.workSignals.ts`),
  shell integration (`terminal/shellIntegration/`). Rust: the existing organiser scheduler decides
  Needs you; no Rust change.
- **bash command text** is the first simple command of the submitted line (`$BASH_COMMAND`); zsh
  and fish report the whole line.
- **Verified locally in a real PTY** (zsh 5.9, macOS bash 3.2): the user's prompt and `.zshrc` /
  `.bashrc` stay in effect, `C`/`D` markers carry the command and exit code, the agent wrappers add
  the hook only when enabled and supported, pass `-p` / `exec` through unchanged, and skip Codex when
  the user's `config.toml` sets `notify`. The generated Claude Code settings file is accepted by
  Claude Code 2.1.328.

## Pending live verification

- Claude Code accepting `ESC]777;bigbud;done BEL` through `terminalSequence` in an interactive
  session.
- Codex `notify` children opening `/dev/tty`.
- OpenCode and herdr snippets.
- fish integration (fish is not installed on the verification machine; static tests only).
- End-to-end acceptance runs of phases 1–3 locally and on a remote backend (needs a running app).
