# OpenCode V2 live turn on the developer Mac: runbook (gap closure Phase 3, Gate G3)

**Status: prepared, NOT executed.** You (the user) run this runbook. No agent has started, stopped or signalled any backend or native service for it, and no billed turn has been sent.

Plan: [gap-closure plan](../plans/2026-10-15-opencode-v2-gap-closure-plan.md) §3.1–3.4. Result ledger to write afterwards: `docs/validation/opencode-v2-live-turn-<date>.md`.

**Run this only after G1.** The qualification target is now [2.1.4](opencode-v2-native-qualification-2.1.4-2026-10-24.md) and must be promoted before steps 3.2.3 and the G3 exit can pass. Since 2026-10-24 the provider card no longer shows qualification: it is green "ready" for a service at or above 2.1.4 and amber "Update recommended" below it, so a green card alone does not prove G1. A dry rehearsal of steps 1–2 is harmless, but do not send a billed turn for G3 until G1 is green.

## 0. Ground rules

- **Billed and user-operated.** Make one attempt per failure, never replay a prompt, and never retry setup automatically (see §4).
- **The native daemon is yours.** Nothing here starts, stops or reconfigures your OpenCode 2.1.4 service, and nothing touches `~/.config/opencode`, `~/.local/share/opencode` or the keychain.
- **Redaction.** Before pasting anything into the ledger, remove tokens, passwords, `authorization` headers, API keys, `service.json` contents, prompt and reply text beyond the tool names, and absolute paths outside the project.

## 1. Preconditions (§3.1)

### 1.1 Exactly one backend per state directory

Right now you run two bigbud backends from the main checkout:

- a Node backend: `--base-dir ~/.bigbud --dev-url http://127.0.0.1:5173 --port 3773`;
- the Electron app, started by `bun dev:desktop` with `--bootstrap-fd 3`.

The cross-platform ledger saw two such backends open `~/.bigbud/dev/state.sqlite` concurrently. Those builds predate the instance lock, so nothing stops them from sharing a directory.

The state directory is `<base-dir>/dev` when a `--dev-url` is given (dev mode) and `<base-dir>/userdata` otherwise. Check which files each running backend holds. This is read-only and signals nothing:

```sh
pgrep -fl "bin.ts|bin.mjs|bootstrap-fd"           # list bigbud backend processes and PIDs
lsof -p <PID> 2>/dev/null | grep -E "state\.sqlite|backend\.lock"
lsof ~/.bigbud/dev/state.sqlite                    # every process with the dev database open
```

**If two PIDs hold the same `state.sqlite`, they share a state directory.** Choose one of the options below.

- **R1 (recommended): a dedicated base directory for the live turn.**
  - Run this branch's build with `--base-dir ~/.bigbud-gap-closure` in production mode, so its state directory is `~/.bigbud-gap-closure/userdata`.
  - It cannot collide with either main-checkout backend, and their history is untouched.
  - Because this build takes `backend.lock`, a second backend on that directory refuses to start. The expected error is "Another bigbud backend (pid N, port P) owns …".
- **R2: reuse `~/.bigbud`.**
  - Quit the Electron app and stop the Node backend on 3773 yourself, then confirm `lsof ~/.bigbud/dev/state.sqlite` prints nothing.
  - Only then start this branch's build with `--base-dir ~/.bigbud --dev-url …`.
  - Older builds do not take the lock, so you must restart them only after G3 is recorded.

Record in the ledger: the option chosen, the `lsof` output (PIDs only), and the content of `<stateDir>/backend.lock` (pid, port, startedAt; no secrets). The lock must show exactly one PID: the backend you started.

### 1.2 Build from this branch without touching the main checkout

Build inside the gap-closure worktree. Do not build in `/Users/youpele/DevWorld/bigbud`: the running `dev-electron` launcher watches the main checkout's `apps/server/dist/bin.mjs`, and rebuilding it restarts the desktop app (cross-platform ledger, "Validation side effect").

```sh
cd /Users/youpele/DevWorld/bigbud/.claude/worktrees/opencode-v2-gap-closure   # or a fresh worktree at the G2/G1 SHA
git rev-parse HEAD                                  # record the SHA
bun install --frozen-lockfile
bun run --cwd apps/web build                        # served from apps/web/dist by the production server
bun run --cwd apps/server build                     # writes this worktree's apps/server/dist/bin.mjs only
bun run --cwd apps/server thread-tools:native-qualification:check   # record the output (G1: qualifiedRecords: 1)
node apps/server/dist/bin.mjs --base-dir ~/.bigbud-gap-closure --port 3790   # R1
```

Open the URL the server prints (normally `http://127.0.0.1:3790`). Keep this terminal: its log is evidence.

### 1.3 Native OpenCode 2.1.4 is running and consistent

These checks only read the registration and use the public info endpoint:

- The registration file is `${XDG_STATE_HOME:-~/.local/state}/opencode/service.json`. Record only its `version` and `pid`, never the endpoint password.
- In bigbud, **Settings → Providers → OpenCode → Show detected setup** shows the native version. It must equal the registration `version`, which must be `2.1.4` (the qualification target).

### 1.4 Location

Use `/Users/youpele/DevWorld/bigbud` (or the worktree) as the project Location. Do not use anything under `~/Documents`: macOS TCC returns EPERM there (deferred D7).

## 2. Steps (§3.2)

Record a timestamp for every step.

1. Open **Settings → Providers → OpenCode** and enable it.
2. Read and switch on **Trust native service execution**. This is the expanded `managed-thread-tools-v2` acknowledgement.
3. Wait until **Show detected setup** reports `ready` for the project Location and for its parent directory (the second Location). Confirm the provider card is **green "ready"** (amber "Update recommended" means the service is older than 2.1.4). The card no longer reflects qualification: confirm G1 by checking that `NativeCompatibility.qualification.registry.ts` holds the reviewed 2.1.4 darwin/arm64 record. If it is empty, G1 is not promoted: stop here.
4. Start a new OpenCode chat. Choose a connected native model, not a free-tier "Big Pickle" model (HTTP 403, deferred D3). Record the provider and model names.
5. Send a prompt asking the model to call `bigbud_thread_v1_get_thread_status` for this chat, then `bigbud_thread_v1_create_thread` for a small child task. For example: "Use get_thread_status on this chat, then create_thread a child chat titled 'G3 child' that lists the files in docs/plans."
6. Confirm the child chat appears in the sidebar and starts running.
7. While the child runs, press **Stop** on the parent turn.
8. After the stop settles, send a second short message to the parent, such as "Reply with OK." It must be **accepted**: no "prior physical admission remains owned" and no persistent "settlement remains unconfirmed".
9. Ask the parent to call `bigbud_thread_v1_rename_thread` on the child, for example to rename it to "G3 child renamed". Confirm the new title.

## 3. Evidence to capture (§3.3, redacted)

`<stateDir>` is `~/.bigbud-gap-closure/userdata` for R1, or `~/.bigbud/dev` for R2.

| Evidence                   | How                                                                                                                                                                                                                                                                                                                                                                                                                                | Expectation                                                                                                                                                                                         |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Server log excerpt         | `<stateDir>/logs/server.log`, lines from steps 2.5–2.9                                                                                                                                                                                                                                                                                                                                                                             | No `prior physical admission remains owned`                                                                                                                                                         |
| Provider event log excerpt | `<stateDir>/logs/provider/events.log`                                                                                                                                                                                                                                                                                                                                                                                              | Tool calls `bigbud_thread_v1_get_thread_status`, `_create_thread` and `_rename_thread`; one interrupt; the next turn accepted                                                                       |
| Hold-reason lines          | `grep -E "OpenCode v2 execution settlement held\|settlement remains unconfirmed\|hold: " <stateDir>/logs/server.log`                                                                                                                                                                                                                                                                                                               | None, or none persisting beyond 30 s. Any line names its reason, for example `coding-busy`, `native-active`, `pending-interactions` or `final-publication-pending`; copy the reason and counts only |
| Settlement released        | Step 2.8 accepted (timestamp)                                                                                                                                                                                                                                                                                                                                                                                                      | Next send accepted after the interrupt                                                                                                                                                              |
| Signed receipt count       | Count only: `find <stateDir>/opencode-v2-thread-tools -type f \| wc -l` before step 2.5 and after step 2.9 (never print the contents). For canonical command receipts, use an online backup, never the live database: `sqlite3 <stateDir>/state.sqlite ".backup '/tmp/g3-state.sqlite'"`, then `sqlite3 -readonly /tmp/g3-state.sqlite "SELECT COUNT(*) FROM orchestration_command_receipts;"`, then delete `/tmp/g3-state.sqlite` | Counts increase for the tool calls                                                                                                                                                                  |
| Qualification check        | Output of `thread-tools:native-qualification:check` from the same build (§1.2)                                                                                                                                                                                                                                                                                                                                                     | `qualifiedRecords: 1`, `qualified: true`                                                                                                                                                            |
| Lock                       | `<stateDir>/backend.lock` (pid, port, startedAt)                                                                                                                                                                                                                                                                                                                                                                                   | Exactly one owner: your backend                                                                                                                                                                     |
| Native identity            | Registration `version`/`pid` and the detected-setup version                                                                                                                                                                                                                                                                                                                                                                        | `2.1.4`, consistent before and after                                                                                                                                                                |

The ledger must state: "zero `prior physical admission remains owned` errors".

## 4. If any step fails (§3.4)

**Stop.** Do not retry setup, do not resend or replay the prompt, and do not delete lock, receipt or history files.

Record:

- the failing step and its timestamp;
- the exact user-visible message;
- the finite stage/errno diagnostics from the server log (cross-platform follow-up format);
- any hold-reason line.

Return to Phase 2 with that evidence. Afterwards, stop only the backend you started (Ctrl+C in its terminal). Leave the native daemon running.
