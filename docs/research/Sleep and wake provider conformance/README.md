# Sleep and wake provider conformance

**Started:** 22 October 2026. **Status:** procedure and kit ready; no runs recorded yet.
**Plan:** Phase 6 item 1 of the [connection resilience plan](../../plans/2026-10-21-connection-resilience-plan.md). The results feed Phase 6 item 5 and the provider conformance matrix in the [auto-resume plan](../../plans/2026-09-10-rust-coordinated-thread-auto-resume-plan.md).

This folder records what each provider does when the laptop sleeps in the middle of a turn. One run is one lid close. The probe script, `scripts/sleep-wake-probe.ts`, records each run as one JSON row and one Markdown table row. You close and open the lid by hand.

## What a run measures

| Measurement                                                 | Source                                                                                                                                                                                                                                                                                                                          | Notes                                                                                                                                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Wall-clock and monotonic gap across the sleep               | The probe's own clocks, sampled every second                                                                                                                                                                                                                                                                                    | On Linux the monotonic clock stops during sleep. On macOS (`mach_continuous_time`) and Windows it keeps counting.                                                                                           |
| OS sleep and wake times                                     | `pmset -g log` on macOS, `journalctl -k` on Linux                                                                                                                                                                                                                                                                               | Windows: not read. DarkWake (Power Nap) is not counted as a wake.                                                                                                                                           |
| Desktop `suspend`, `resume`, `online` and `offline` signals | `desktop-main.log` and its rotations under Electron `userData/logs`: `~/Library/Application Support/bigbud` on macOS, `%APPDATA%\bigbud` on Windows, `$XDG_CONFIG_HOME/bigbud` (default `~/.config/bigbud`) on Linux. Prerelease channels use `bigbud-<channel>`. Stable uses the legacy `T3 Code (Alpha)` folder if it exists. | **Packaged app only**, and only builds that include `13b90621ba`. Dev does not write this log, so these columns read `–` in dev. The row gets a note when the log has no connectivity lines inside the run. |
| Socket drop and reconnect timing                            | Retained spans in `server.trace.ndjson`: `ws.connection.diagnostics` reports, `http.server GET /ws`, `server.stalled`, `server.suspected_system_sleep`                                                                                                                                                                          | Reconnect time comes from the renderer's `reconnect-success` report. If the socket never dropped, there is no reconnect time.                                                                               |
| What the turn did after wake                                | `orchestration_events` in `state.sqlite`, opened read-only from the sequence the probe started at                                                                                                                                                                                                                               | One of `continued`, `retried-internally`, `errored`, `hung`, `still-running`, `finished-during-sleep` or `finished-before-sleep`.                                                                           |
| Retry evidence                                              | Activities after wake, plus the per-thread provider log `logs/provider/<threadId>.log`                                                                                                                                                                                                                                          | Matches retry, reconnect, resume and network-error wording. bigbud writes the provider log in dev builds only, so packaged runs use activities alone.                                                       |
| Whether a tool ran twice                                    | The marker file the test command appends to                                                                                                                                                                                                                                                                                     | Every `start` line is one run of the command.                                                                                                                                                               |
| Provider and its CLI/SDK version                            | `<cli> --version`, the SDK `package.json` in `apps/server/node_modules`, or `sdkVersion` in the provider log                                                                                                                                                                                                                    | Remote runtimes: record by hand.                                                                                                                                                                            |

The probe never writes to bigbud's database or logs. It writes only to its own output folder, `$TMPDIR/bigbud-sleep-wake-probe/` by default. One harmless exception: when no bigbud server is running, SQLite may create or touch the `state.sqlite-wal` and `state.sqlite-shm` side files while the probe opens the database read-only. The database file itself is not changed.

Server span timestamps are the server's start time plus `process.hrtime`. On Linux that clock stops during sleep, so after a sleep every trace timestamp runs behind the wall clock by the time slept. On macOS (libuv uses `mach_continuous_time`) and Windows it keeps counting through sleep, so the drift there is near zero. The probe corrects for it using its own clocks. The `serverClockDriftMs` field shows the size of the correction.

### Outcome values

| Outcome                 | Meaning                                                                                                |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| `continued`             | The turn made progress after wake and finished cleanly, with no retry evidence.                        |
| `retried-internally`    | It finished cleanly after wake, and the provider or bigbud logged a retry, reconnect or resume.        |
| `errored`               | The session went to `error` or `interrupted`, or the turn start failed, after wake.                    |
| `hung`                  | Still running at the end, with no progress for 2 minutes after wake.                                   |
| `still-running`         | Still making progress. Press Enter later, or run `analyze` again.                                      |
| `finished-during-sleep` | The turn ended while the laptop slept. Expected only for remote work.                                  |
| `finished-before-sleep` | The lid closed too late. The run does not count; repeat it.                                            |
| `no-sleep`              | The probe saw no gap of 15 seconds or more. The laptop did not sleep. Takes precedence over `no-turn`. |
| `no-turn`               | The laptop slept, but no turn started after the probe did. Start the probe first, or pass `--thread`.  |

## Prerequisites

- **Provider login.** Sign in to every provider before you start, and send one ordinary message per provider so the session is warm. A login prompt during a run invalidates it.
- **Cost.** A full matrix is 9 registered providers × 3 durations × 2 scenarios = 54 runs, plus the remote run. Each streaming run asks for about 1 500 words. Each tool run is short, but it keeps a turn open for 2 minutes or more. Copilot, Cursor and Devin count against plan quotas. Claude, Codex and the OpenCode family bill per token on API keys. Use the cheapest model that streams for at least 30 seconds, and keep the same model for all six runs of one provider. The row records the model.
- **Avoiding side effects.** Run every test in a scratch project, never in a real repository:

  ```sh
  mkdir -p ~/bigbud-sleep-wake-scratch && cd ~/bigbud-sleep-wake-scratch && git init -q
  ```

  Add it as a bigbud project. Use `full-access` runtime mode only in this project, so an approval prompt does not block the turn while the lid is shut. The test command only appends to `marker.log` and sleeps. Do not give the scratch repository a git remote.

- **Machine.** Unplug external displays. With a display attached, macOS stays awake when the lid closes (clamshell mode). Note in the label whether you are on AC power or battery, because Power Nap behaves differently on each. If closing the lid does not sleep the machine, use Apple menu > Sleep, Windows Start > Power > Sleep, or `systemctl suspend` on Linux.
- **Build.** Start `bun dev:desktop` and wait until the app is idle. Do not edit code during a run: a rebuild relaunches Electron, which looks like a disconnect. To test the packaged app instead, pass `--packaged` (see [Dev and packaged builds](#dev-and-packaged-builds)).

## One run, step by step

1. In a second terminal at the repository root, start the probe:

   ```sh
   node scripts/sleep-wake-probe.ts start --provider <kind> --scenario streaming --planned-sleep 10
   ```

   For a tool run, use `--scenario tool --marker ~/bigbud-sleep-wake-scratch/marker.log`. `--marker` is required for tool runs; without it a rerun cannot be detected.

2. In bigbud, start a new thread in the scratch project with the provider and model under test. Send the prompt for the scenario:
   - **Streaming:** `Without using any tools, write a 1,500-word short story about a lighthouse keeper who restores an old radio. Do not read or write files.`
   - **Tool:** ``Run this shell command exactly once in the project directory and then tell me its output: `echo "start $(date +%s)" >> marker.log && sleep 120 && echo "done $(date +%s)" >> marker.log && echo done` ``
     On Windows the tool command needs a POSIX shell. Run the scratch project's agent shell through Git Bash or WSL, or the command fails before it writes the marker.
3. Close the lid as soon as the reply is streaming, or as soon as the command shows as running.
4. Wait the planned 1, 10 or 30 minutes. Then open the lid and unlock the machine.
5. Watch the thread. When the turn has finished, or 2½ minutes have passed with nothing happening, press Enter in the probe terminal.
6. The probe prints a summary, the JSON row and a table row. It also appends the JSON row to `results.ndjson`.

The tool prompt does not tell the agent whether to rerun the command after an error. A rerun, whether the provider or the model chose it, shows up as two `start` lines and `Tool ran twice: yes`. When that happens, read the thread to see which one it was, and write it in Notes.

## First runs

Three short runs on the installed app check the kit end to end before the full matrix. You do not need `bun dev:desktop` for these.

Before the first run:

- Make the scratch project and add it to bigbud, as in [Prerequisites](#prerequisites). Sign in to Claude and Codex, and send one ordinary message to each.
- Let every other thread finish, including agent threads. The probe follows the first turn that starts after it starts.
- Unplug external displays. If you are on battery, change `AC` to `battery` in each `--label`.

Run each command in a second terminal at the repository root, before you send the prompt. Then follow steps 2 to 6 of [One run, step by step](#one-run-step-by-step), using a new thread in the scratch project with the provider named.

1. Claude, streaming, 1-minute sleep:

   ```sh
   node scripts/sleep-wake-probe.ts start --packaged --provider claudeAgent --scenario streaming --planned-sleep 1 --label "first run, AC"
   ```

2. Claude, tool, 1-minute sleep:

   ```sh
   rm -f ~/bigbud-sleep-wake-scratch/marker.log
   node scripts/sleep-wake-probe.ts start --packaged --provider claudeAgent --scenario tool --planned-sleep 1 --marker ~/bigbud-sleep-wake-scratch/marker.log --label "first run, AC"
   ```

3. Codex, streaming, 10-minute sleep:

   ```sh
   node scripts/sleep-wake-probe.ts start --packaged --provider codex --scenario streaming --planned-sleep 10 --label "first run, AC"
   ```

What to expect from bigbud 0.3.0, the installed build on 22 October 2026:

- **Resume signal (s)** reads `–`, and the row has a note about connectivity signal lines. Version 0.3.0 predates `13b90621ba`, so its desktop log has no suspend or resume lines. The sleep is still measured from the probe's clocks and `pmset -g log`.
- **Reconnect (s)** reads `–`. Version 0.3.0 predates the renderer's `ws.connection.diagnostics` reports. **Socket dropped** still works, from the `/ws` span.
- Retry evidence comes from activities alone, because packaged builds write no per-thread provider log.
- **Version** shows the CLI set in Settings, else the one on your `PATH`, and, for Claude, the SDK in this checkout. Check them against About.
- Node prints an `ExperimentalWarning` about SQLite. It is harmless.

On a build that includes the [sleep and wake turn continuation plan](../../plans/2026-10-22-sleep-wake-turn-continuation-plan.md), the thread itself should show one of the results below. The probe does not detect these states. Read them from the thread, and write which one you saw in Notes.

| Run                     | Expected in the thread                                                                                                                                                                                                                                                                            | Not expected                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1. Claude, streaming, 1 | bigbud continues once: a new user turn with the "Your previous response was interrupted…" text (a `sleepRecovery` origin), after a blue "Resuming after sleep…" if it takes over 3 s. Or Claude carries on by itself: a blue "Claude continued on its own after sleep." for 6 s, and no new turn. | Two continuation turns. The original prompt sent again.                             |
| 2. Claude, tool, 1      | An amber prompt that names the command: "The computer slept while … was running. Its outcome is unknown. Check before continuing.", with Continue and Dismiss. Nothing is sent until you choose. If Claude carries on by itself, the blue notice of run 1 instead. `Tool ran twice` reads `no`.   | An automatic continuation. A second `start` line in the marker before you choose.   |
| 3. Codex, streaming, 10 | As run 1: one continuation turn, or a blue "Codex continued on its own after sleep." If the network is still down at wake, bigbud waits for it without counting a try, and asks with "The response was interrupted when the computer went to sleep." after 120 s awake.                           | A continuation while the network is down. "Couldn't resume" after a single failure. |

On any run, an amber "No activity since wake." (Keep waiting, Stop and continue) means the turn still showed as running but nothing arrived for 120 s after wake. A red "Couldn't resume after 3 tries." means three automatic continuations failed. Note either one with the run.

If the probe followed the wrong thread, right-click the right thread in the sidebar and choose **Copy Thread ID**. Paste it as `"threadId"` in the run's `meta.json`, then run `node scripts/sleep-wake-probe.ts analyze <run dir>`.

## Provider procedures

Registered providers come from `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` and `OptionalProviderComposition.ts`, revalidated on 22 October 2026. Each provider gets six runs: streaming and tool, at 1, 10 and 30 minutes. Pass the kind shown below to `--provider`.

| Provider          | `--provider` kind | Launch / version source                                                                       | Provider-specific notes                                                                                                                                         |
| ----------------- | ----------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex             | `codex`           | `codex app-server`, one process per session; `codex --version`                                | Watch for `session/threadResumeFallback` in the provider log. Codex may silently fall back to a fresh native thread.                                            |
| Claude            | `claudeAgent`     | `@anthropic-ai/claude-agent-sdk`; `claude --version` plus the SDK `sdkVersion`                | Native events carry `sdkVersion`. `api_retry` system messages count as retry evidence.                                                                          |
| Copilot           | `copilot`         | `@github/copilot-sdk` with the bundled `@github/copilot` CLI; `copilot --version`             | A failed resume is an error, with no fresh fallback. Expect `errored` rather than a silent restart.                                                             |
| OpenCode V2       | `opencodeV2`      | Borrows your shared OpenCode service through its registration file; `opencode --version`      | Keep the shared OpenCode service running before the run. bigbud never starts a competing daemon. Note in the row whether the service itself survived the sleep. |
| OpenCode (legacy) | `opencode`        | Not registered                                                                                | The legacy adapter is retired and kept only as read-only history. Skip it, and mark its row `n/a`.                                                              |
| Kilo              | `kilocode`        | Shared OpenCode-family server manager; `kilo --version`                                       | Validate separately from OpenCode V2. Do not infer parity.                                                                                                      |
| Cursor            | `cursor`          | ACP over `agent`; `agent --version`                                                           | A failed `session/load` falls back to `session/new` silently. Check for a new native session after wake.                                                        |
| Devin             | `devin`           | ACP over `devin`; `devin --version`                                                           | Same ACP load fallback as Cursor.                                                                                                                               |
| Pi                | `pi`              | `pi --mode rpc` child with piped stdin; `pi --version` plus `@earendil-works/pi-coding-agent` | Pi exits when its stdin closes. A sleep alone keeps stdin open; a backend restart after wake does not.                                                          |
| CLIProxy          | `cliProxy`        | Enabled unless `BIGBUD_DISABLE_CLIPROXY=1`; no local CLI version                              | Declares `fresh-restart` recovery. Record the routed upstream model in the label. Read the version from Settings.                                               |

If a provider is missing from the app, check that it is enabled in Settings and logged in. Then record `n/a` with the reason.

## SSH remote project run

Run this once on an SSH remote project. Use Codex, because it declares a remote provider runtime. Use the tool scenario with a 10-minute sleep.

1. On the remote host, make the scratch folder (and before every later run, delete the old marker with `ssh <host> rm -f ~/bigbud-sleep-wake-scratch/marker.log`): `ssh <host> 'mkdir -p ~/bigbud-sleep-wake-scratch && cd ~/bigbud-sleep-wake-scratch && git init -q'`. Add it in bigbud as a remote project, and select the remote provider runtime.
2. Start the probe with `--remote --scenario tool --planned-sleep 10 --provider codex --marker /tmp/remote-marker.log`. Remote marker times come from the remote clock, so the probe does not filter them by time and counts every line. That is why the marker file must be fresh for each run.
3. Send the tool prompt, close the lid as soon as the command runs, and open it after 10 minutes.
4. Before you press Enter, copy the marker: `scp <host>:~/bigbud-sleep-wake-scratch/marker.log /tmp/remote-marker.log`. If you forget, copy it afterwards and run `node scripts/sleep-wake-probe.ts analyze <run dir>`.
5. Record the remote CLI version by hand with `ssh <host> codex --version`, and add it to Notes. The probe reads only the local CLI version.

On this run, the remote command keeps going while the laptop sleeps. The interesting result is whether bigbud reattaches to it after wake (`continued` or `finished-during-sleep`, with one `start` line) or starts the command again (two `start` lines).

## Dev and packaged builds

- **`bun dev:desktop`** is the default. The probe reads `~/.bigbud/dev`. Desktop power signals are not logged in dev, so the signal columns are empty. The OS power log and the probe's clock still mark the sleep.
- **Packaged app.** Pass `--packaged`. The probe reads bigbud's state from `~/.bigbud/userdata` and the desktop log from Electron `userData/logs/desktop-main.log` (see the table above), including rotated `desktop-main.log.N` files written during the run. That log has the suspend, resume and online signal times. For a prerelease build, add `--channel beta`, `preview` or `nightly`; state then comes from `~/.bigbud/channels/<channel>/userdata` and the log from `bigbud-<channel>`. Use `--state-dir` and `--desktop-log` for anything else. The installed app must include `13b90621ba`, or its log has no connectivity lines and the row says so. SDK versions come from this checkout's `node_modules`, which may not match the packaged app's bundle, so check them against About.
- **`BIGBUD_HOME`.** If you set it, the probe uses it as the base folder.

## What the kit cannot observe

These need new instrumentation. They are listed here rather than added to the app.

1. **Desktop power signals in dev.** `logHeader` writes only in packaged builds (`apps/desktop/src/logging/logging.ts`, `initializePackagedLogging`). The renderer acts on the signals (`WebSocketConnectionSurface.triggers.ts`) but does not report them to the server's diagnostics ring. Possible fix: a dev desktop log, or a connectivity-signal trigger on `server.reportWsConnectionDiagnostics`.
2. **The socket opened after wake.** The `http.server GET /ws` span is written only when the socket closes, so a live new socket is invisible. Reconnect time comes from the renderer's `reconnect-success` report, which is sent only after a drop.
3. **Server-side sleep in installed builds older than the sleep-continuation work.** Those builds emit `server.suspected_system_sleep` only on Windows. Builds that include the [sleep-wake turn continuation plan](../../plans/2026-10-22-sleep-wake-turn-continuation-plan.md) detect it on all three platforms: on macOS and Windows the monotonic clock keeps counting through sleep, and on Linux boot time running ahead of monotonic time is the suspended time. The probe does not read these server events yet.
4. **Tool invocation identity.** Command activities often show only `Bash: {}`, so duplicate detection relies on the marker file. Builds with the sleep-continuation work store the runtime `itemId` on tool activities, which pairs a `tool.started` with its `tool.completed`, but the probe does not read it yet. The probe cannot tell an automatic rerun from the model choosing to rerun.
5. **Silent provider retries.** A retry inside an SDK or CLI that emits no notification is invisible. That covers HTTP retries inside the Claude SDK that do not surface as `api_retry`, and retries inside the Codex app-server.
6. **Provider version per session.** bigbud does not record which CLI or SDK version served a session. `ServerProvider.version` is an in-memory snapshot only. The probe reads versions from the machine, which is right only if nothing changed in between.
7. **Remote process state during sleep.** Whether the remote command kept running is inferred from the marker timestamps. The probe does not query the remote agent's operation journal.
8. **Whether the provider's HTTP stream survived.** The probe cannot see if the TCP stream to the model was cut. That is inferred from the outcome and the retry evidence.
9. **Thinking deltas.** They are ephemeral by design, so a lost thinking stream is not visible after wake.

## Results

Before pasting, read each row's `turn.retryEvidence` and `turn.lastError`. They quote provider logs and errors, which can contain prompt text, file paths or tokens. Redact anything sensitive. Then paste rows below the header. To print them, run:

```sh
node scripts/sleep-wake-probe.ts table                 # default results file
node scripts/sleep-wake-probe.ts table <results.ndjson> # a specific file
```

`table` keeps the newest row for each run ID, so re-running `analyze` does not create duplicates. Keep the raw JSON rows too: paste them into a fenced `json` block under [Raw rows](#raw-rows), one line per run, so the table can be regenerated. Times are seconds after the probe's wake time. `–` means the probe did not observe it.

| Date | Provider | Version | Build | Topology | Scenario | Planned min | Slept min | Resume signal (s) | Socket dropped | Reconnect (s) | Outcome | First progress (s) | Ended (s) | Tool ran twice | Notes | Run ID |
| ---- | -------- | ------- | ----- | -------- | -------- | ----------- | --------- | ----------------- | -------------- | ------------- | ------- | ------------------ | --------- | -------------- | ----- | ------ |

### Run checklist

Tick each cell when its row is in the table.

| Provider          | Streaming 1 | Streaming 10 | Streaming 30 | Tool 1 | Tool 10 | Tool 30 |
| ----------------- | ----------- | ------------ | ------------ | ------ | ------- | ------- |
| Codex             | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| Claude            | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| Copilot           | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| OpenCode V2       | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| OpenCode (legacy) | n/a         | n/a          | n/a          | n/a    | n/a     | n/a     |
| Kilo              | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| Cursor            | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| Devin             | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| Pi                | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| CLIProxy          | ☐           | ☐            | ☐            | ☐      | ☐       | ☐       |
| Codex, SSH remote |             |              |              |        | ☐       |         |

### Raw rows

```json

```

## Probe reference

```sh
node scripts/sleep-wake-probe.ts start --scenario streaming|tool [--planned-sleep 1|10|30]
    [--provider <kind>] [--thread <id>] [--marker <file>, required for tool] [--remote]
    [--packaged [--channel stable|beta|preview|nightly] | --state-dir <dir>]
    [--desktop-log <file>] [--label <text>]
    [--out <dir>] [--max-minutes <n>]
node scripts/sleep-wake-probe.ts analyze <run dir>
node scripts/sleep-wake-probe.ts table [results.ndjson]
```

- The probe picks the first thread that starts a turn after it starts. Pass `--thread` if other threads may start turns during the run.
- Each run's folder holds `meta.json`, `clock.ndjson`, `trace-offsets.ndjson`, `provider-version.json` and `row.json`. Use `analyze` to recompute a row later.
- Code: `scripts/sleep-wake-probe.ts`, with focused modules in `scripts/lib/sleep-wake-probe.*.ts`. Tests: `bun run --cwd scripts vitest run lib/sleep-wake-probe`.
