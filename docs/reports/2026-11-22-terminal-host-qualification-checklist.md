# Terminal host qualification checklist (Q1)

Manual checks for milestone Q1 of the [terminal lifecycle plan](../plans/2026-11-21-terminal-lifecycle-plan.md) (§16.4). Run every item on **macOS and on Linux**, record the outcome in the tables at the end, and attach anything unexpected (screenshot, `supervisor.log`, the soak JSON). The terminal host stays **opt-in** until this checklist, the 24-hour soak and the dogfood period all pass. Do not change the default as part of this checklist.

The plan's Q1 criterion (d) refers to the macOS privacy (TCC) check as "item 13", but the §16.4 list numbers it 11. This checklist keeps the §16.4 numbers, so the TCC check is item 11.

## Before you start

1. Build the host binary:
   - for items 1–7 and 9–13: `cargo build --release --locked -p bigbud-remote-agent`;
   - for item 8 and the debug clocks: `bun run build:workspace-agent` (debug build). Release builds ignore every `BIGBUD_DEBUG_TERMINAL_*` variable.
2. Start bigbud with the host enabled:
   - development: `BIGBUD_TERMINAL_HOST=1 bun run dev:desktop`;
   - packaged macOS app: `BIGBUD_TERMINAL_HOST=1 /Applications/bigbud.app/Contents/MacOS/bigbud` (Finder and `open` do not pass the variable);
   - packaged Linux AppImage: `BIGBUD_TERMINAL_HOST=1 ./bigbud-<version>.AppImage`.
3. Confirm the host runs: `pgrep -fl 'bigbud-remote-agent.*--local-desktop-host'` prints one process after you open the first terminal.
4. Useful commands while testing:
   - shell PID inside a terminal: `echo $$`;
   - all host-run shells: `pgrep -P <host pid>` (macOS and Linux);
   - host logs: `<state dir>/terminal-host/state-<n>/supervisor.log` and `host.log` (state dir: `userdata` under `~/.bigbud`, or under its release-channel subfolder, for packaged builds; `~/.bigbud/dev` for development);
   - kill switch: start with `BIGBUD_TERMINAL_HOST=0` to run new terminals in-process again.

Every item lists its steps and the expected result. "Toast colours" follow the UI conventions: blue for in progress, green for done, amber for warnings, red for failures.

## 1. Thread switching keeps the same program and screen

1. In thread A (project 1), open the terminal and run `claude` (or another full-screen agent). Note its PID with `pgrep -n claude`.
2. Switch through 5 threads in 3 projects: one dependency-only project, a new thread from **Mod+N**, the settings page (**Mod+,**), and a remote thread whose host is disconnected (the gate screen).
3. Return to thread A.

**Expected:** the same PID (`pgrep -n claude`); the same screen with no flicker or blank frame; typing reaches the agent at once; no amber toast. Switching with the right panel open never creates a terminal in the other threads.

## 2. A minimized window parks and restores exactly

1. In a terminal, run a redrawing program, for example `top` (macOS) or `htop`.
2. Minimize bigbud for 2 minutes. Views park after 30 seconds out of sight.
3. Restore the window.
4. Run `printf '\033]11;?\007'; sleep 120` in a hidden terminal, switch away for 2 minutes and come back.

**Expected:** the restored screen matches what the program shows (no stale rows, cursor in place). The OSC 11 query is answered while parked: the shell prints no garbage and the program does not hang.

## 3. Backend kill keeps every terminal

1. Open 3 terminals: a prompt, `claude`, and `sleep 900`. Note each PID (`echo $$` in each shell before starting the program).
2. Kill the backend: `pkill -9 -f 'apps/server/src/bin.ts'` (development) or the backend `node` child of the app (packaged: `pgrep -fl bigbud` to find it).
3. Wait for bigbud to reconnect.

**Expected:** all 3 terminals come back with the same PIDs and their screens; input works. No terminal shows "ended".

## 4. Quit with the default setting leaves nothing behind

1. Make sure **Settings → Terminal → Keep terminals running after quitting** is off.
2. Open 2 terminals and note their PIDs. Quit bigbud (**Cmd+Q** / **Ctrl+Q**).
3. After 60 seconds run `ps -p <pid1>,<pid2>` and `pgrep -fl 'bigbud-remote-agent.*--local-desktop-host'`.
4. Relaunch bigbud.

**Expected:** no shells and no host after 60 seconds. On relaunch the threads show no terminals (open them again to get fresh shells).

## 5. Keep mode survives quitting, and idle prompts still close

1. Turn on **Keep terminals running after quitting**.
2. Open a terminal, run `echo kept-$$`, quit bigbud, wait 10 seconds and relaunch.
3. Open a second terminal at a prompt. Quit bigbud and leave it closed for 11 minutes, then relaunch.

**Expected:** step 2 reattaches with the exact screen (the `kept-…` line, same PID). In step 3 the idle prompt is gone on relaunch and one notice says how many terminals closed while bigbud was closed.

## 6. Idle warning, Keep open and idle close

1. Open a terminal at a prompt and switch to another thread so it is not visible.
2. At 9 minutes an amber warning appears with **Keep open**, and the sidebar row shows an amber countdown. Click **Keep open**.
3. Leave it again for 10 minutes without clicking.
4. Leave each of these hidden for 15 minutes: an agent TUI waiting at its own prompt; `exec sleep 900`; a shell running `(while :; do date; sleep 300; done) &` and then left at its prompt (a background job printing every 5 minutes).
5. Leave a p10k (powerlevel10k) prompt, whose `gitstatusd` helper runs silently, hidden for 10 minutes.

**Expected:** **Keep open** resets the timer and the warning disappears. The expiry closes the terminal with a toast, and the pane shows it ended because it was idle. The three terminals in step 4 are never closed: the TUI and `sleep` are foreground programs, and the background job's output restarts the idle timer every 5 minutes. The p10k prompt **does** close, because silent helpers never count as activity. A terminal visible on screen is never idle-closed.

Fast variant (debug build only): start with `BIGBUD_DEBUG_TERMINAL_IDLE_MS=60000` for a warning at 30 seconds and a close at 60 seconds.

## 7. Terminal limit dialog and setup scripts

1. Open 24 terminals across several threads (a quick way: split repeatedly with **Mod+D**).
2. Keep the oldest one visible. Open a 25th.
3. Click **Cancel**. Open the 25th again and confirm.
4. With 24 terminals open, create a worktree whose project has a setup script.
5. Retry from the setup toast; repeat and dismiss the toast instead.

**Expected:** the dialog names the least recently used terminal that is **not** visible. Cancel opens nothing and closes nothing. Confirm closes exactly the named terminal (its pane shows it was closed for the limit) and opens the new one. The setup script shows the setup toast at the limit; retry closes the named terminal and runs the script; dismissing marks the setup as failed.

## 8. Memory pressure closes only hidden, idle terminals

Debug build only.

1. Start with `BIGBUD_TERMINAL_HOST=1 BIGBUD_DEBUG_TERMINAL_PRESSURE=low` (the plan text calls this `BIGBUD_TERMINAL_HOST_PRESSURE_OVERRIDE`; the implemented variable is `BIGBUD_DEBUG_TERMINAL_PRESSURE`, values `normal`, `low` or `critical`).
2. Open 6 terminals: 2 visible, 2 hidden prompts, 2 hidden running `sleep 900`.

**Expected:** only the hidden prompts close, oldest first, each with a toast. Visible terminals and busy programs stay.

## 9. Updating with live terminals

1. Turn on keep mode. Open 2 terminals and note their PIDs.
2. Install an app update (or replace the app with a newer build). On Linux use the AppImage.
3. Repeat with keep mode off.

**Expected:** with keep mode on, the host survives the update (on Linux too, although the AppImage mount goes away) and the new version adopts it: same PIDs and screens. With keep mode off, the update closes everything.

## 10. Development rebuild while terminals run

1. With terminals running under `bun run dev:desktop`, rebuild the agent (`bun run build:workspace-agent`) and restart the dev backend.
2. Check out an older commit whose host lacks newer capabilities (any commit before the R5 host lifecycle work), build and start it, then return to the current build.

**Expected:** the running host is adopted through its hello (no digest check) and keeps its terminals. An older host keeps its terminals while new terminals start in a new `state-<n+1>` folder; bigbud shows the one-time "older terminal host" notice, and **Close them** only closes hosts whose process identity it can verify.

## 11. macOS privacy (TCC) in keep mode

macOS only.

1. Turn on keep mode. In a bigbud terminal run `ls ~/Documents` and record the result (macOS may ask for permission).
2. In the same terminal start `(while :; do ls ~/Documents >/tmp/tcc.txt 2>&1; sleep 10; done) &`, then quit bigbud.
3. After 30 seconds, read `/tmp/tcc.txt` from Terminal.app. Relaunch bigbud and close that terminal to stop the loop.

**Expected:** record both outcomes. If access fails after the quit (for example "Operation not permitted"), the keep-mode helper text on macOS must gain: "Some protected folders may be unavailable to terminals while bigbud is closed." File that as a follow-up before Q1 sign-off.

## 12. Remote-agent targets

1. Repeat items 1, 2, 3 and 6 with a remote workspace that uses the bigbud remote agent (agent updated to the version with protocol 1.9).
2. On a container with a cgroup memory limit, run `stress-ng --vm 1 --vm-bytes 90%` (or similar) next to hidden idle terminals.

**Expected:** the same results as on the local host. Memory pressure follows the container's cgroup limit, not the machine's total memory.

## 13. Direct SSH terminals

1. With the host enabled, open a Direct SSH terminal (a workspace using Direct SSH, not the agent). Repeat items 1 and 3.
2. Disconnect the network (Wi-Fi off) for 2 minutes.

**Expected:** the SSH terminal survives thread switches and a backend kill (same local `ssh` PID). After the backend kill its sidebar busy hint keeps working (a program running remotely shows busy). Pulling the network ends the terminal and keeps its last screen.

## Soak and dogfood (Q1 criteria (b) and (c))

- **Soak, 24 hours on macOS and on Linux:**

  ```sh
  cargo build --release --locked -p bigbud-remote-agent
  bun run --cwd apps/server soak:terminal-host -- --minutes 1440 --release --out ~/terminal-soak-$(uname -s).json
  ```

  Pass when the report's `pass` is `true`: RSS growth ≤ 10% after the first hour, no growth in file descriptors or workspace roots, zero unexpected closes, zero `modelInvalid`, restore p95 ≤ 150 ms, ≥ 99.5% cell-identical restores. Keep the machine awake (`caffeinate -dimsu` on macOS).

- **Release bench on an idle machine:** `bun run --cwd apps/server benchmark:terminal-host -- --runs 3`. Pass: ingest median ≥ 50 MiB/s and peak RSS ≤ 256 MiB.
- **Dogfood:** at least 2 people use `BIGBUD_TERMINAL_HOST=1` for 7 days. Pass: no lost-terminal reports caused by the host.

## Results

| Item | macOS result | Linux result | Notes |
| ---- | ------------ | ------------ | ----- |
| 1    |              |              |       |
| 2    |              |              |       |
| 3    |              |              |       |
| 4    |              |              |       |
| 5    |              |              |       |
| 6    |              |              |       |
| 7    |              |              |       |
| 8    |              |              |       |
| 9    |              |              |       |
| 10   |              |              |       |
| 11   |              | n/a          |       |
| 12   |              |              |       |
| 13   |              |              |       |

| Gate                    | Result | Evidence |
| ----------------------- | ------ | -------- |
| Soak, macOS (24 h)      |        |          |
| Soak, Linux (24 h)      |        |          |
| Release bench           |        |          |
| Dogfood (2 people, 7 d) |        |          |
