# Terminal navigation recovery: decision and implementation status

## Current status (2026-11-02)

- **Default path: fixed by live reattach.** A fresh or resynced view whose server history was
  truncated (1 MiB or 5000 lines) no longer pauses input. It re-asserts the process's tracked
  input modes, attaches live, and asks the program to repaint. Nothing is restarted. See
  "Resolution: live reattach" below for limits.
- **Headless recovery mirror.** Still behind `BIGBUD_TERMINAL_RECOVERY=1` (or the legacy shadow
  flag) and default-off. When enabled it is tried first; any refusal or failure now falls back
  to live reattach instead of pausing the view.
- **Open blockers for enabling the mirror by default.** Cumulative Unicode admission, indefinite
  pending-query refusal, remote-adapter backpressure and long-running multi-view load
  qualification. These no longer block terminal usability.

Section order: issue and decision first, then the newest implementation status, then plan and
references. Superseded milestones are kept verbatim in the appendix at the end.

## Original issue and evidence

The reported issue is a terminal/TUI becoming unusable after switching among roughly 2–4
threads, including pi/OpenCode. Restoring an interactive session must not restart its process.
The exact switch-count trigger and an actual pi/OpenCode reproduction remain **unproven**.

Repository evidence:

- `Manager.history.retention.ts` stops retaining the baseline after 1 MiB or the line/control
  budgets are exceeded. It sets `historyTruncated` and clears history, not the live PTY.
- Before this change, `TerminalViewport.intake.ts` refused a truncated/unavailable baseline and
  disabled fresh-view input. It now requests an independent ANSI baseline; refusal still never
  replays an arbitrary VT suffix or treats a healthy process as dead.
- The existing `Manager.navigationRecovery.test.ts` exercises four other threads: the same
  process survives and accepts input even when history is exhausted. It uses a fake PTY;
  it is not a pi/OpenCode reproduction. This pre-existing untracked file is preserved.
- Existing browser diagnostics distinguish hide/show from actual disposal/remount. Four
  visibility cycles retain the emulator; an explicit fresh mount with truncated mock history
  refuses hydration. Neither test proves four real chat switches always remount a terminal.
- Existing `wsRpcHandlers.terminalRecovery.test.ts` exercises a real PTY through production
  manager/RPC handlers, including resize and exhausted history. It tests legacy behavior,
  not the proposed ANSI recovery path.

This supports a concrete recovery deficiency: a surviving process can have no usable baseline
for a fresh renderer. It does not establish the entire original incident's root cause.

## Decision

The user's latest direction supersedes the exact-private-state implementation path:
use **Orca-style bounded ANSI snapshots from a continuously updated backend headless
terminal**, keeping bigbud's xterm frontend and existing terminal UX. Retain the exact
checkpoint experiment as comparative evidence, not as the runtime recovery dependency.
Default-on is approved **after focused compatibility tests**, not merely after unit tests.
No separate JavaScript daemon is permitted. A hypothetical future daemon would be Rust;
it is outside this work.

**Current status: experimental RPC/frontend thin slice, default-off pending production qualification.**
The manager owns a bounded headless model from each newly spawned generation's first read.
`terminal.recovery` exposes a generation-bound ANSI snapshot and ordered output/resize suffix.
The production intake uses it when legacy history is exhausted, without restarting the PTY.
Unsupported states refuse explicitly while preserving existing cells and the running process.
An explicit recovery/shadow flag value `1` enables new experimental models; either flag's value
`0` disables them. Enabling a flag cannot retroactively reconstruct a generation with no baseline.
See the final milestone section for qualification, memory limits and remaining limitations.
The old experiment remains `exactCapability: false`; ANSI recovery does not claim exact
private-state equivalence and does not need that experiment to become exact.

## Two approaches

|           | Exact private-state checkpoint experiment                                 | Chosen bounded ANSI snapshot approach                                                  |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Owner     | Version-specific projection of private xterm state                        | Continuously running, version-matched backend headless model per generation            |
| Restore   | Decode/validate/materialize private objects before committing             | Rebuild normal/alternate screen through ANSI plus explicit supplemental state          |
| Strength  | Potential execution-level continuation fidelity                           | Smaller compatibility surface; practical recovery after byte-history exhaustion        |
| Cost      | Private field/handler coupling, hostile decoding and memory qualification | Extra parsing and bounded live grid per terminal; serialization on demand              |
| Fidelity  | Exactness not certified despite tested continuations                      | Deliberately not exact; modes, tails, links, colors, cursor and resizing require tests |
| Retention | Full private state can exceed staging limits                              | Bounded backend recovery window; do not reduce an existing renderer's scrollback       |
| Risk      | Partial import, version drift, allocator pressure                         | Lossy reconstruction, wrong input modes, parser seams and snapshot/live overlap        |

The exact experiment passed 51 selected continuation scenarios and 29 unchanged-target
malformed-input refusals. Maximum 1000×500 geometry with 5000 scrollback was populated,
but capture was refused before projection: its staging lower bound was 264,000,000 bytes
against an unchanged 128 MiB ceiling. Those results are **not ANSI snapshot qualification**.

We choose the ANSI approach because the user needs a working view of an existing terminal,
not a general private-state migration format. The complexity should go into bounded ownership,
ordered delivery and explicitly tested TUI behavior rather than proving all private fields
serializable. This decision does not make imperfect snapshots safe automatically.

## Resolution: live reattach on the default path (2026-11-02)

**Problem.** Every resync creates a fresh intake, and a fresh intake refused any truncated
baseline: it paused the lane, disabled input and offered only "Restart terminal". Active TUIs
cross the server history cap within minutes, so a reconnect or stream overflow left a healthy
process unusable. Hidden drawers stay mounted for up to ten threads, so plain switching was
not the trigger; resync was.

**Change.** A baseline-less snapshot never pauses the view now.

1. The server keeps a small `TerminalModeTracker` per process generation, fed at the same cut
   as history. It mirrors the input-affecting modes the pinned xterm implements: application
   cursor and keypad, wraparound, cursor visibility and style, mouse protocol and encoding,
   focus events, bracketed paste, colour-scheme updates and the alternate screen. Truncated or
   unavailable snapshots carry it as the optional `liveModes` field. A control sequence split
   by the cut is re-opened so its live tail is not printed as text. Cost is one regex jump per
   control introducer; plain output is a single scan.
2. The web intake tries the recovery mirror only when it is enabled. Otherwise, or on any
   refusal or failure, it keeps existing cells, switches screens if needed, writes the modes,
   applies post-cut output, enables input and records a `reattached` diagnostic. A recovered
   view whose mirror later fails degrades the same way instead of pausing.
3. The delivery then probes a repaint: it shrinks the PTY by one row through the existing
   resize RPC, waits for output (at least 150 ms, at most 750 ms), and restores the view's
   geometry, even if the view went away. The wait matters because Node TTYs only emit
   `resize` when the size actually changed, so back-to-back resizes can coalesce into nothing.
4. An amber toast says the terminal reconnected, earlier output could not be restored, and
   nothing was restarted.

**Limits, stated plainly.**

- Output that scrolled away, and the screen of a program that does not repaint on resize (a
  build log, `cat`), are not restored. A fresh view shows them blank until new output arrives.
  A resynced view keeps its previous cells.
- The repaint relies on the program honouring SIGWINCH. A program blocked for longer than the
  probe window may miss the intermediate size. ConPTY on Windows repaints from its own buffer
  on resize. Only macOS was exercised in this session; Linux uses the same SIGWINCH path but
  was not run, and Windows was not run.
- Queries sent while no view was attached remain unanswered, as before. The program's own
  timeout handles them; no reply is invented.
- Kitty keyboard and win32 input modes are not tracked because the web renderer does not
  enable them. Adopted remote owners only track modes seen since adoption.
- The probe briefly changes the PTY size for every attached view. Mirror-recovered views in
  other windows apply that resize record too.

**Validation (focused, macOS).** Contracts, web and server typechecks passed. Explicit-path
oxfmt and oxlint passed with zero warnings for the 21 changed source and test files, and each
is at most 400 lines. A matching Chromium build (Playwright 1.59.1, headless shell 1217) was
installed because no Playwright browser was cached.

| Selection                                                                              | Result                                                                                                       |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Server: tracker, history, remote restart and the 23 terminal files above, TUI probe on | 27 files, 128 tests; the detached-query case was updated for the new behaviour and its file rerun passed 3/3 |
| Web unit: intake, live attach, polling, status toasts, diagnostics and RPC tests       | 11 files, 44 tests                                                                                           |
| Web browser: recovery, hydration, navigation, session and status files                 | 9 files, 22 tests                                                                                            |
| Contracts recovery schema                                                              | 1 file, 4 tests                                                                                              |

The tracker test compares it against the pinned xterm: one emulator parses a stream, a fresh
one receives only the restore sequence, and all observable modes must match. The real-PTY
test asserts the truncated snapshot's modes and that a real Node program reports both the
probe size and the restored size. The navigation browser test asserts a fresh mount after
exhausted history reattaches, accepts input and issues the shrink-then-restore pair.

```sh
bun run --cwd apps/server vitest run src/terminal/Layers/TerminalModeTracker.test.ts src/ws/wsRpcHandlers.terminalRecovery.test.ts src/ws/wsRpcHandlers.terminalAnsiRecovery.browser.test.ts
bun run --cwd apps/web vitest run src/components/terminal/TerminalViewport.liveAttach.test.ts src/components/terminal/TerminalViewport.intake.test.ts
bun run --cwd apps/web test:browser src/components/terminal/TerminalViewport.recovery.browser.tsx src/components/terminal/TerminalViewport.navigationDiagnostics.browser.tsx
```

**Not done.** The mirror's Unicode guard and query-ledger redesign, which would let the mirror
become default-on, were not changed. No repository-wide checks were run, and nothing was
committed.

## 2026-11-02 continuation: native backpressure fixed; Unicode/query qualification still blocked

**Current rollout remains default-off.** This continuation supersedes the fast-ingress failure
status below for the tested local NodePTY profile, not the remaining Unicode/query blockers or
the decision to keep production qualification incomplete. No separate daemon was introduced.

### Recovery-specific producer hold

The existing manager delivery hold paused native reads but did not account for the headless
model's independent queue. Each small native callback became an asynchronous headless write;
at 4096 bytes/3 ms, producer ingress could outrun applied writes and exhaust the 2 MiB pending cap.

The model now asserts a generation-owned producer hold at **512 KiB pending UTF-16 accounting
or 1024 queued operations**, and releases it below **128 KiB and 256 operations**. The hard
2 MiB/4096-operation admission remains unchanged, leaving headroom for in-flight native callbacks.
Native reads pause only for that PTY. No bytes are dropped to manufacture continuity and there is
no new unbounded queue. Parsing continues while reads are held, independent of browser attachment.

`Manager.outputPressure.ts` reconciles recovery pressure with existing delivery holders: either
can hold the producer and releasing one cannot release the other. Stop-pending overrides both
so exit can drain. The callback is installed before first-listener output, captures the process
generation, and low-water release requires no renderer acknowledgement. Model disposal, overflow,
parse failure and the existing five-second parse timeout release its hold. A replaced model cannot
release a new generation's hold. Adapters without pause/resume still fall back to bounded explicit
refusal; this is not a qualified remote-adapter backpressure protocol. Native pause/resume I/O
failure is likewise not a guarantee that an unusable descriptor can resume successfully.

The real WebSocket/native-PTY/browser test now replaces the previous expected-overload refusal
with **two concurrent fast producers**, each writing **2400 × 4096 = 9,830,400 ASCII bytes
(9.375 MiB)** plus controls at a requested 3 ms cadence. Both produce a final recoverable frame,
retain their original PID and accept input. Both have observed native pause/resume calls and no
remaining hold at completion. The main view is destroyed and remounted through production intake;
it restores the final frame and answers one subsequent query. The peer independently exercises the
actual recovery RPC and input path. Producer backpressure may lengthen elapsed emission time; this
is intentional flow control, not a promise of unrestricted throughput or an hours-long soak result.

Focused regressions also cover detached low-water release, overlapping delivery/recovery holds,
restart/close cleanup, parse-timeout release and hard overflow if an adapter ignores pause. The
existing asynchronous holder-race and confirmed-shutdown tests remain green.

### Unicode investigation: no unproven replacement for the cumulative guard

The pinned package's own source map was inspected (`BufferLine.ts`, `InputHandler.ts`, `Buffer.ts`,
and `WriteBuffer.ts`), rather than assuming current upstream internals. New characterization tests
demonstrate why scanning only public live cells or resetting a counter after visible erase is
insufficient:

- `setCellFromCodepoint` can overwrite a visible combined cell with plain text without deleting its
  private `_combined` entry. The visible cell and retained allocation are different inventories.
- Switching to/erasing the alternate buffer leaves the normal buffer's retained strings intact;
  normal scrollback retains strings outside the viewport too.
- REP (`CSI Ps b`) expands the preceding combined string without any additional non-ASCII native
  input. One combining input plus REP 64 leaves 65 combined cells. The pinned implementation allocates
  `Uint32Array(text.length * repeat)` before printing, so merely bounding incoming Unicode or auditing
  after parsing does not prove bounded intermediate allocation. The test uses only a small safe count.

A sound ongoing design must account for retained strings at pinned buffer mutation/copy/trim
boundaries (including both buffers, stale sparse-map entries and scrollback), bound REP expansion
before allocation, and preserve saved-register/charset-driven continuation semantics. A post-parse
heap sample, clear-screen heuristic or silently truncated cell is not an adequate substitute. No
global monkey-patch or unqualified private-state rewrite was introduced. The cumulative guard and
its 1025th-erased-cell refusal therefore **remain a verified production blocker**. Its existing
protection is not claimed to cover every control-driven allocation path, including REP.

### Query ledger: authoritative policy retained, indefinite refusal unresolved

Successful writes to the current PTY generation remain the acknowledgement evidence; headless
answers are never forwarded. The ledger compares replies only at/after the query's native ingress.
Timeout, navigation, a later redraw or new user input does not prove the process stopped waiting
for an earlier reply. The existing tests show that 1000 answered queries remain eligible, one
unanswered query remains pending, overflow refuses, and detached-query recovery does not invent
a reply. Exact matching, bounded received-input retention and mismatched geometry can still cause
conservative refusal. Safely recovering these states needs explicit query custody/correlation and
renderer-authority qualification, not an expiry timer. No timeout-based clearing was added.

### Validation and honest completion status

Focused formatting, lint and direct ≤400-line checks passed for the ten source/test files changed
in this continuation; the configured server typecheck passed. The affected 23-file server selection
passed **97 tests**, including native pi/OpenCode probes, actual wire/frontend recovery, pressure,
saved-state, delivery-holder and shutdown regressions. No web or contracts source changed in this
continuation; their prior focused checks remain historical evidence, not newly rerun claims.
One initial combined command timed out without Vitest output; subsequent runs completed. An initial
unit fixture ended precisely at wrap-pending and correctly refused capture; adding CR to that fixture
made its pressure assertion independent of the existing unsupported wrap-pending profile.

**Code checks: green. Production Implementation/Plan: not green.** Native ingress pressure is
implemented and qualified for the tested local profile. Ongoing Unicode/expansion accounting,
indefinite query refusal, remote adapter qualification and long-running production load remain open.
Default-on was not enabled. Parent review remains appropriate; no nested agents were delegated.
Unrelated work, the original xterm frontend and saved-state refusal policy were preserved. Nothing
was staged, committed or pushed, and this report remains exclusively under `docs/reports/`.

Exact affected test command:

```sh
files=(apps/server/src/terminal/Layers/Manager.outputPressure.ts apps/server/src/terminal/Layers/Manager.types.ts apps/server/src/terminal/Layers/Manager.session.outputHold.ts apps/server/src/terminal/Layers/Manager.recovery.ts apps/server/src/terminal/Layers/Manager.process-drain.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.ts apps/server/src/terminal/Layers/Manager.recoveryPressure.test.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.pressure.test.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.retainedUnicode.test.ts apps/server/src/ws/wsRpcHandlers.terminalAnsiRecovery.browser.test.ts)
bun run oxfmt --check "${files[@]}"
bun run oxlint --report-unused-disable-directives "${files[@]}"
python3 - "${files[@]}" <<'PY'
from pathlib import Path
import sys
for file in sys.argv[1:]:
    assert len(Path(file).read_text().splitlines()) <= 400, file
PY
BIGBUD_TERMINAL_TUI_PROBE=1 bun run --cwd apps/server vitest run src/terminal/Layers/TerminalRecoveryModel.queries.test.ts src/terminal/Layers/TerminalRecoveryModel.savedCursor.test.ts src/terminal/Layers/TerminalRecoveryModel.savedCursor.browser.test.ts src/terminal/Layers/TerminalRecoveryModel.tui.test.ts src/terminal/Layers/TerminalRecoveryModel.test.ts src/terminal/Layers/TerminalRecoveryRecords.test.ts src/terminal/Layers/Manager.recoveryModel.test.ts src/terminal/Layers/Manager.recoveryModel.browser.test.ts src/terminal/Layers/Manager.recoveryRpc.test.ts src/ws/wsRpcHandlers.terminalAnsiRecovery.browser.test.ts src/terminal/Layers/Manager.navigationRecovery.test.ts src/terminal/Layers/Manager.lifecycle.test.ts src/terminal/Layers/Manager.startup.test.ts src/terminal/Layers/Manager.hardening.test.ts src/terminal/Layers/Manager.remote.test.ts src/ws/wsRpcHandlers.terminalRecovery.test.ts src/terminal/Layers/Manager.recoveryPressure.test.ts src/terminal/Layers/TerminalRecoveryModel.pressure.test.ts src/terminal/Layers/TerminalRecoveryModel.retainedUnicode.test.ts src/terminal/Layers/Manager.session.outputHold.test.ts src/terminal/Layers/Manager.outputDelivery.test.ts src/terminal/Layers/Manager.confirmedLifecycle.test.ts src/terminal/Layers/Manager.confirmedLifecycle.races.test.ts
bun run --cwd apps/server typecheck
```

## Parent-review correction: default-off, production qualification blocked

The parent rejected the prior default-on/completion claim. That rejection is correct: the
8 MiB lifetime-input retirement only postponed exhausted-history failure, and fixed 50 ms
polling imposed perpetual per-view load. **The earlier green/default-on conclusions below
are superseded.** Recovery now requires explicit `BIGBUD_TERMINAL_RECOVERY=1` or legacy
`BIGBUD_TERMINAL_RECOVERY_SHADOW=1`; either explicit `0` still disables it. With neither flag,
new sessions have no recovery model. No PTY is restarted by this change.

### Changes and measured evidence

- Removed the cumulative byte cutoff. Ordinary redraws now rely on bounded grid/scrollback,
  parser queues and operation journals rather than total bytes since process creation.
- The native-PTY test now emits **9,830,400 ASCII payload bytes** in 300 paced redraws, exhausts
  legacy history, restores through actual WebSocket RPC, destroys/recreates the renderer and
  remounts again, then verifies same PID, one spawn, input and one query reply.
- A faster 4096-byte/3 ms native-PTY reproduction failed with `unparsed-output-budget` before
  recovery. This is a verified throughput blocker, not a repaired condition: its final regression
  asserts explicit refusal and unchanged PID. Increasing queue sizes or dropping bytes was not
  used to hide it. The paced success is not evidence of hours-long or arbitrary-rate support.
- Six concurrent headless models each parsed 9,830,400 redraw bytes and stayed snapshot-eligible
  under Node's 128 MiB heap limit. Observed peak heap was **102,490,264 bytes**, peak RSS
  **239,632,384 bytes**; post-GC heap samples at 50-round intervals ranged from 11,627,576 to
  16,007,192 bytes. This finite ASCII probe is not a general memory bound.
- Idle polling now backs off 50→100→200→400→800→1600→2000 ms. Received legacy output/activity
  only wakes/coalesces a suffix request; its bytes are never replayed or used as sequence authority.
  Wake hints during an in-flight RPC cause no parallel request. Hidden documents use a minimum
  1000 ms delay; periodic polling remains necessary because an ingress hint may precede model apply.
- Deterministic six-view tests bound idle traffic to at most **36 calls/view/minute**, including
  initial snapshot (previously 1201), and coalesce 1000 wake hints to one request. Six hidden-document
  views receiving 100 hints/second each make **61 calls/view/minute**, consume all test records and
  keep peak concurrency at one request per view. A slow-RPC/disposal test also passes. These are
  scheduler/request-count tests, not a production server CPU/network benchmark. A hidden panel in
  a visible document is not independently throttled; it uses wake/coalescing and idle backoff.
- Payload ceilings now share `TERMINAL_RECOVERY_ANSI_MAX_CHARS`: 1,048,576 UTF-16 units equals
  the model's 2,097,152-byte accounting limit. The parser tail is separately capped at 16,384 units.
  Boundary tests accept the exact ceiling and reject one extra unit. **This is not a 2 MiB wire
  limit**: JSON control escaping can use six bytes/unit (approximately 6.1 MiB for ANSI plus tail,
  plus small framing). The worst-escaping test verifies that finite bound. Serializer allocation
  occurs before the final length check and still lacks full adversarial pre-allocation qualification.

### Verified blockers retained rather than hidden

1. Unicode admission remains cumulative: even 1024 separately erased combining-cell redraws
   eventually retire capture. A regression demonstrates the 1025th contribution refusal.
   Resetting the counter on clear-screen is not safe evidence that alternate/normal scrollback,
   saved cells and parser continuations released every retained string. A bounded live-cell/resource
   accounting design needs pinned-xterm qualification before removing this guard. No truncation,
   unverified private-state mutation or silent fidelity downgrade was introduced.
2. Pending queries do not expire. Tests show 1000 answered queries remain eligible, but one
   unanswered query continues refusing later snapshots; ledger overflow is permanently refusing.
   The received-input history is bounded, so mismatched/evicted replies can also cause conservative
   refusal. Aging those entries out would falsely assume the process no longer awaits a response.
3. Faster native ingress can exhaust the bounded unapplied queue and invalidate the model.
   Recovery from that lost state cannot be manufactured from a truncated suffix.

**Code checks pass for this revision; production Implementation/Plan green is No.** Default-on
durability is not delivered. Remaining work is live Unicode/resource accounting, sustained ingress
capacity/recovery design, query custody qualification and real long-running/multi-view server-load
qualification. The original 2–4 switches incident and authenticated hours-long pi/OpenCode sessions
remain unproven. This is an explicitly disabled experimental path, not a production fix declaration.

Final focused checks for this correction: explicit-path oxfmt/oxlint and direct ≤400-line checks
passed for ten changed source/test files; configured typechecks passed for contracts, web and server.
The same 16-file server command below passed **77 tests**; contracts passed **4**, web units **8**,
and five browser files **13**. The unit command now includes
`src/components/terminal/TerminalViewport.recovery.polling.test.ts`. Browser logs included activation
and ResizeObserver-loop warnings despite exit zero; no full suites were run. No nested delegation,
staging, commits or pushes occurred; unrelated dirty work was left untouched.

Correction-specific validation commands (zsh, repository root; the unchanged 16-file server and
five-file browser selections are recorded in the earlier evidence section):

```sh
files=(apps/server/src/terminal/Layers/TerminalRecoveryModel.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.test.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.queries.test.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.budget.ts apps/server/src/ws/wsRpcHandlers.terminalAnsiRecovery.browser.test.ts apps/web/src/components/terminal/TerminalViewport.recovery.ts apps/web/src/components/terminal/TerminalViewport.intake.ts apps/web/src/components/terminal/TerminalViewport.recovery.polling.test.ts packages/contracts/src/workspace/terminal.recovery.ts packages/contracts/src/workspace/terminal.recovery.test.ts)
bun run oxfmt --check "${files[@]}"
bun run oxlint --report-unused-disable-directives "${files[@]}"
python3 - "${files[@]}" <<'PY'
import sys
from pathlib import Path
for file in sys.argv[1:]:
    assert len(Path(file).read_text().splitlines()) <= 400, file
PY
bun run --cwd packages/contracts typecheck
bun run --cwd apps/web typecheck
bun run --cwd apps/server typecheck
bun run --cwd packages/contracts vitest run src/workspace/terminal.recovery.test.ts
bun run --cwd apps/web vitest run src/components/terminal/TerminalViewport.recovery.polling.test.ts src/rpc/wsNativeApi.terminalRecovery.test.ts src/components/terminal/TerminalViewport.test.ts src/components/terminal/terminalUnicodeProvider.test.ts
```

## Ready for implementation: phased integration plan

1. **Applied-operation records (implemented).** Own a generation-scoped bounded journal
   of output and resize operations. Count operations, not timestamps. On overflow return
   `snapshot-required`; reject stale generations and invalid cuts; readers cannot consume
   another view's suffix. Record only after the model applies each operation.
2. **Backend model and packaging (implemented; bundle/Node/Electron CLI smoke checked).** Pin `@xterm/headless` to frontend `6.1.0-beta.304`,
   qualify a serialize-addon version, and share the production Unicode11/ZWJ provider through
   an appropriate shared module (the server must not import a frontend module). Instantiate
   before the first PTY read of each generation; dispose on retirement. Never build a new
   model from already-truncated history or restart a surviving process to obtain a baseline.
3. **Single ordered apply lane (implemented).** Feed output at the native ingress callback
   in `Manager.process-drain.ts`, before downstream batching can reorder it across resize, and
   successful resizes from both `Manager.session.controls.ts` and the reattach resize in
   `Manager.session.ts`. Await a fixed parse fence for an on-demand snapshot; do not block
   waiting for an always-busy queue to become empty. Cap unparsed custody separately:
   dropped unparsed output invalidates the model, unlike overflow of already-applied records.
4. **Explicit snapshot contract (implemented with guarded support).** Add a separate ANSI-recovery discriminator, generation,
   applied sequence, source dimensions and supported/unsupported result. Include normal and
   alternate state, cursor/modes, link/color supplements and bounded partial escape tail.
   Do not disguise the new payload as legacy `history` or clear `historyTruncated` dishonestly.
5. **Frontend handoff (implemented).** Subscribe before capture; hydrate a fresh replacement at source
   dimensions while suppressing historical replies. Restore tail last, then apply ordered
   post-cut output/resizes once; only live queries may reply. Abort stale-generation work.
   Preserve a healthy current view when capture/import is unsupported or fails. No automatic
   reset/restart, no healthy-view disposal as a recovery shortcut.
6. **Qualification and default-on (qualified subset enabled; not universal fidelity).** Test overflow, detach/reattach, races and memory under
   multiple sessions; run real PTYs and browser/TUI tests, including actual pi/OpenCode.
   Enable default-on only after these focused checks. No broad-suite approval is implied.

### Dependency/build findings

Dependencies are now installed with Bun and exact pins: server `@xterm/headless` **6.1.0-beta.304**,
`@xterm/addon-serialize` **0.15.0-beta.301**, and `@xterm/addon-unicode11` **0.10.0-beta.301**.
The matching browser is pinned as a server devDependency for the addons' peer/types and tests.
Serializer beta.301 shares browser commit `c58ea3637f3968e0e6e79cd92cf9aace7ef89ee2`;
beta.304 is NOT its matching addon version (it requires browser beta.308).
The lockfile diff contains only these xterm workspace/peer/package additions. `scripts` still
uses xterm 6.0.0; it is not the runtime dependency used here.

The Unicode11/ZWJ implementation moved to the DOM-free
`packages/shared/src/terminalUnicodeProvider.ts`; the frontend retains a compatibility export.
The addons' upstream TypeScript declarations import `lib.dom`, which initially broke server
fetch/stream types. A static `.mjs` addon bridge with headless-only declarations isolates this
boundary without changing unrelated HTTP/Copilot code. Runtime imports remain bundleable.

`apps/server/tsdown.config.ts` inlines the headless dependency rather than introducing a daemon
or native external. The configured server entries were bundled with tsdown into owned temporary
storage, with cleaning disabled and unrelated asset copies omitted. The resulting `bin.mjs`
successfully ran `--help` under Node and Electron's `ELECTRON_RUN_AS_NODE=1` runtime. External
dependencies were resolved through an owned temporary symlink to the server's installed modules.
This is a built-server/runtime smoke, not a packaged desktop installer or full release build.
Existing desktop runtime-dependency work remains untouched.

### Budgets and unsupported cases

The new journal caps estimated retained storage at 2 MiB (UTF-16 payload plus record allowance)
and 4096 records. This bounds journal custody, **not** emulator, serializer, transport or total
heap. A 1000-row backend live recovery window is a candidate based on Orca, not a change to
the frontend's visible scrollback. A newly reconstructed view may recover less history than
an uninterrupted view; make this limit explicit. Full durable-history recovery is separate.

The integrated model reserves estimated grid/parser headroom with 96 MiB per-model and
256 MiB aggregate admission ceilings. Its live scrollback is 1000 rows; the frontend stays
at 5000. Unparsed custody is capped at 2 MiB/4096 operations, with a five-second parse deadline.
Dropping unparsed work invalidates and disposes the model; overflow of applied records only
requires a newer snapshot. Capture callers share a fixed FIFO cut. Candidate ANSI is capped
at 2 MiB after serialization. Oversized geometry is refused rather than shrinking the PTY.
Reservations are estimates, NOT hard heap limits. New pre-parse limits retire snapshot capture
after 8 MiB of lifetime UTF-16 input or 1024 zero-width/emoji-modifier contributions, whichever
comes first. The bounded journal continues feeding already-recovered renderers after retirement.
These conservative limits bound combined-cell growth without stopping a healthy view or PTY;
new mounts then receive an explicit budget refusal. See the measured failure and correction below.
Do not raise these limits without renewed memory qualification.
Images, unsupported extensions, oversized parser tails, lost model continuity and unavailable
remote baselines need explicit refusal. ANSI replay does not preserve every private parser,
grapheme, selection, search-marker or renderer state; compatibility must be demonstrated,
not inferred from serialization API availability.

## Pinned Orca primary sources

Reviewed revision: [`be4e0719b8949dd44b6b1681f70499b486a6c1a3`](https://github.com/stablyai/orca/tree/be4e0719b8949dd44b6b1681f70499b486a6c1a3).
Use as inspiration and regression evidence, not a blind transplant into bigbud's architecture.

- [Headless model](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/headless-emulator.ts):
  serializer, Unicode provider, absolute/saved cursor repair, OSC links, modes and partial tail.
- [Live daemon scrollback](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/daemon-session-scrollback-window.ts):
  defaults to **1000 rows** to avoid aggregate grid memory growth. The standalone emulator
  constructor defaults to 5000; do not confuse that with the daemon session policy.
- [Output plane](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/session-output-plane.ts):
  pending records capped at `2 * 1024 * 1024` **UTF-16 units**, not measured heap bytes.
  Overflow invalidates pending coverage; recovery uses a fresh snapshot, not a dropped suffix.
  Output and resize records share apply order; snapshot coverage includes an output sequence.
- [Snapshot fields](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/terminal-snapshot.ts)
  and [buffer splitting](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/terminal-snapshot-ansi-buffers.ts):
  normal buffer separate from alternate frame; pending escape tail restored **last**.
- [Mode restoration](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/terminal-mode-rehydrate-sequences.ts):
  input and mouse encodings need explicit restoration; alt-screen transitions affect state.

The output-plane source explicitly leaves query replies to the renderer, except its shell-ready
startup DA1 handling. Do not connect the backend mirror's `onData` to PTY input: that would
race the renderer, particularly on background-color queries. bigbud must retain its own
startup/query policy, not copy Orca's barrier blindly.

### Known regression evidence, not a claim of perfect snapshots

- [Remote snapshot corruption #7329 regression](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/repro-7329-remote-snapshot-corruption.test.ts):
  partial escape tails and stale mouse modes can corrupt input after reattach. Shell and live
  agent restoration differ; blindly resetting modes also breaks a still-running TUI.
- [Wide-character snapshot regression tests](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/headless-emulator-wide-char-snapshot.test.ts)
  and [shrinking snapshots](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/main/daemon/headless-emulator-shrink-snapshot.test.ts)
  identify additional qualification targets. These links establish source tests, not assertions
  that every associated bug is currently open or fixed in bigbud.

## Appendix: superseded milestones (historical, kept verbatim)

These sections describe earlier checkpoints. Their conclusions were superseded by the
parent-review correction and the 2026-11-02 continuation above.

### Earlier production milestone (superseded by parent review)

The dedicated `terminal.recovery` RPC is wired through contracts, manager, WebSocket routing,
native API and production viewport intake. Snapshots carry generation, applied sequence cut,
source geometry, ANSI and pending parser tail. Independent suffix requests return contiguous
output/resize records. Recovered views poll every 50 ms with one request in flight and ignore
overlapping legacy output, retaining lifecycle events. Fit proposes server geometry; ordered
resize records alone resize recovered renderers. Healthy mounted views are not rehydrated merely
because legacy history expires. Refusal preserves cells and explicitly says the process survives.

Saved-register reconstruction preserves qualified attributes and ASCII/DEC charset state, using
VT sequences and a 47 transition instead of serializer 1049; unsupported registers refuse rather
than silently falling back to positions. Trailing alternate-buffer erase backgrounds are repaired.
The earlier exact-private-state experiment remains comparison evidence with `exactCapability: false`.

The real integration now crosses the actual `/ws` Effect RPC transport, a native NodePTY and
bundled production frontend intake. It exhausts history, restores the screen, verifies the same
PID and working input, applies ordered geometry and observes one live query reply. A detached
unanswered query initially disappeared at capture; a bounded observed-reply ledger now refuses
that cut with `pending-renderer-query`. No headless reply is written to the PTY. XTVERSION matches
the response family because browser/headless version labels differ. Existing startup handlers
remain unchanged. Native pi/OpenCode startup and unsubmitted-input probes pass.

#### Memory failure, correction and rollout limits

An isolated combining-character probe exhausted a 128 MiB Node heap before the scalar input
budget applied. Pre-parse Unicode admission fixed that reproduction without increasing the heap:
129 chunks of 32768 combining characters now refuse with `unicode-combination-budget`, with
6,865,584 peak heap bytes and 51,134,464 peak RSS bytes. Six models at 1024 contributions each
peaked at 11,029,824 heap bytes and 63,651,840 RSS bytes; the next contribution retired capture.
These measurements are specific probes, not proof of a universal hard heap ceiling.

Capture retires after 8 MiB lifetime UTF-16 input or 1024 zero-width/emoji-modifier contributions.
Oversized resize and parser-tail admission likewise retire capture while preserving raw ordered
suffix delivery to existing recovered views. Lost unparsed output still invalidates continuity.
Queues/journals are bounded at 2 MiB/4096 operations, snapshots at 2 MiB, parse time at five seconds,
and backend scrollback at 1000 rows (frontend remains 5000). Default-on is limited to admitted,
qualified sessions; `BIGBUD_TERMINAL_RECOVERY=0` or legacy shadow flag `0` disables new models.
Unsupported saved state, hyperlinks, images, parser state, budgets and missing remote baselines
remain explicit refusals. Long-lived sessions can therefore lose new-view recovery eligibility.

#### Final focused evidence

- 53 explicitly selected source/test files: formatting passed, lint reported zero warnings/errors,
  and every file was directly checked at 400 lines or fewer.
- Configured `bun run --cwd <package> typecheck` passed for `packages/contracts`, `packages/shared`,
  `apps/web` and `apps/server`. The final server rerun verifies the merged test-layer fix.
- Final server selection: **74 tests in 16 files passed**, including the newest resize/parser-tail
  retirement regressions and actual WebSocket/native-PTY/browser test.
- Contracts: 3 tests passed; web units: 5 passed; web browser: 13 passed in five files.
- Configured tsdown entries rebuilt after the retirement changes; built CLI `--help` exited zero
  under Node and Electron-as-Node. This excludes full installer/release packaging.
- Browser activation, localstorage-file and SQLite experimental warnings were observed; affected
  test commands passed. No repository-wide checks or `bun test` were run.

Exact test commands (repository root):

```sh
BIGBUD_TERMINAL_TUI_PROBE=1 bun run --cwd apps/server vitest run src/terminal/Layers/TerminalRecoveryModel.queries.test.ts src/terminal/Layers/TerminalRecoveryModel.savedCursor.test.ts src/terminal/Layers/TerminalRecoveryModel.savedCursor.browser.test.ts src/terminal/Layers/TerminalRecoveryModel.tui.test.ts src/terminal/Layers/TerminalRecoveryModel.test.ts src/terminal/Layers/TerminalRecoveryRecords.test.ts src/terminal/Layers/Manager.recoveryModel.test.ts src/terminal/Layers/Manager.recoveryModel.browser.test.ts src/terminal/Layers/Manager.recoveryRpc.test.ts src/ws/wsRpcHandlers.terminalAnsiRecovery.browser.test.ts src/terminal/Layers/Manager.navigationRecovery.test.ts src/terminal/Layers/Manager.lifecycle.test.ts src/terminal/Layers/Manager.startup.test.ts src/terminal/Layers/Manager.hardening.test.ts src/terminal/Layers/Manager.remote.test.ts src/ws/wsRpcHandlers.terminalRecovery.test.ts
bun run --cwd packages/contracts vitest run src/workspace/terminal.recovery.test.ts
bun run --cwd apps/web vitest run src/rpc/wsNativeApi.terminalRecovery.test.ts src/components/terminal/TerminalViewport.test.ts src/components/terminal/terminalUnicodeProvider.test.ts
bun run --cwd apps/web test:browser src/components/terminal/TerminalViewport.recovery.browser.tsx src/components/terminal/TerminalViewport.openResize.browser.tsx src/components/terminal/TerminalViewport.hydration.browser.tsx src/components/terminal/TerminalViewport.navigationDiagnostics.browser.tsx src/components/terminal/TerminalViewport.addons.browser.tsx
```

Final requirements review found the approved guarded production path complete. Independent nested
review was unavailable at the agent-depth limit; the implementation agent performed the review,
with parent review still available. The exact original “2–4 thread switches” incident and long-running
authenticated pi/OpenCode conversations are **not** claimed reproduced or fully qualified. No
separate daemon was added, no unrelated Copilot work was intentionally modified, and nothing was
staged, committed or pushed. This report remains exclusively under `docs/reports/`.

### Earlier validation checkpoints (historical)

At the earlier shadow checkpoint, the journal was connected to the model but public wire,
frontend hydration and default-on were not yet delivered. The final milestone below supersedes
that status; earlier results remain comparison evidence.
Local `pi --version` returned `1.4.0`; `opencode --version` returned `v2.2.5`. These are
availability checks. New isolated native/browser probes described below exercise startup and
unsubmitted typing, but not production chat navigation, model conversations or multi-view recovery.

Focused checks from the journal increment (historical):

| Check                                                                                                                                                                                           | Result and scope                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/server vitest run src/terminal/Layers/TerminalRecoveryRecords.test.ts src/terminal/Layers/Manager.navigationRecovery.test.ts src/ws/wsRpcHandlers.terminalRecovery.test.ts` | 10 tests passed across three files; seven new journal tests plus existing fake/real PTY legacy behavior     |
| `bun run --cwd apps/web test:browser src/components/terminal/TerminalViewport.navigationDiagnostics.browser.tsx src/components/terminal/TerminalViewport.hydration.browser.tsx`                 | Four tests passed across two files; existing browser lifecycle/parser-carry behavior, not new ANSI recovery |
| `bun run --cwd apps/server typecheck`                                                                                                                                                           | Passed; informational pre-existing Effect suggestions elsewhere                                             |
| Explicit `oxfmt --check` / `oxlint` paths for the two new source/test files and report formatting                                                                                               | Passed after replacing an allocating filter/map pair with a single owned-copy loop                          |
| Explicit source/test length assertions                                                                                                                                                          | 126 and 105 lines, below 400                                                                                |
| Report source links                                                                                                                                                                             | Nine pinned blob paths validated against the fetched revision tree                                          |

No broad checks, browser installations, commits or pushes were performed. No production
fallback, default-on switch, daemon, process restart or frontend scrollback change was added.
Independent nested-agent review is unavailable at this session's depth limit; the parent must
review this increment. These results do not establish production implementation/plan green.

#### Integrated shadow evidence and original decision blocker

- `Manager.recoveryModel.test.ts` exercises first-listener synchronous output, refuses to invent
  a baseline for an adopted remote owner, orders both resize paths (including synchronous native
  output during resize), preserves old model geometry after failed resize, suppresses mirror
  query replies, and disposes on explicit restart/close. Mirror failure never restarts the PTY.
- `Manager.recoveryModel.browser.test.ts` uses the real manager/NodePTY and Chromium. A fixture
  emits more than 1 MiB, exhausting legacy history, then a fresh browser restores the current
  shadow frame and consumes its ordered suffix. The same PID accepts new input; spawn count
  remains one. This demonstrates the model/browser path, **not production frontend RPC handoff**.
- `TerminalRecoveryModel.tui.test.ts` is explicitly gated by `BIGBUD_TERMINAL_TUI_PROBE=1`.
  It starts installed pi/OpenCode in fresh temporary homes, without credentials or submitted
  prompts; OpenCode uses `--standalone`, leaving the user's shared service alone. A browser
  with the shared Unicode provider owns query replies. The probe types an unsubmitted marker,
  captures at a fixed cut, and compares restored visible text, cursor, modes and mouse encoding.
- These probes exposed a real serializer defect: pi's cursor restored at column 17 instead of
  18, OpenCode's at 33 instead of 34. An absolute cursor supplement fixed these selected frames.
  Mouse encoding and normalized OSC color overrides are also supplemented. Origin/wrap-pending
  cursor states remain explicitly refused, not silently clamped.
- OpenCode emits Kitty `a=q` and `OSC 1337;Capabilities` queries; these must not be mistaken for
  image payloads. Completed capability queries are allowed; actual image state is refused.
- **At the earlier checkpoint, native OpenCode was red:** after adding a saved-register safety guard it reported
  `saved-cursor-not-qualified`. The earlier visible-frame pass did not establish continuation of
  saved cursor state. The subsequent saved-register increment is recorded below; this earlier
  failure remains comparison evidence, not the current native-probe result.

The pinned [Orca cursor adapter](https://github.com/stablyai/orca/blob/be4e0719b8949dd44b6b1681f70499b486a6c1a3/src/shared/terminal-serialize-absolute-cursor.ts)
explicitly restores saved position/origin while **not** carrying saved SGR/charset, a deliberate
fidelity tradeoff. The parent explicitly **rejected** that tradeoff: saved attributes and charset
must survive, with safe refusal for unqualified states. Live hyperlinks and Unicode join tails
are also explicitly refused; link-range reconstruction remains outstanding.

The gate cannot open on the old private-state proof, the new fixture roundtrip or a startup-only
TUI frame comparison. Complete the remaining supplements and memory qualification, then wire
the generation/sequence/resize contract and frontend handoff before default-on. Preserve the
functioning view and process in the meantime. The shadow flag is an incremental qualification
gate, not a replacement for the user's requested eventual default-on behavior.

#### Verification before the saved-register increment (historical)

| Command/check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Result                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `bun run --cwd apps/server vitest run src/terminal/Layers/TerminalRecoveryModel.test.ts src/terminal/Layers/TerminalRecoveryRecords.test.ts src/terminal/Layers/Manager.recoveryModel.test.ts src/terminal/Layers/Manager.recoveryModel.browser.test.ts src/terminal/Layers/Manager.navigationRecovery.test.ts src/terminal/Layers/Manager.lifecycle.test.ts src/terminal/Layers/Manager.startup.test.ts src/terminal/Layers/Manager.hardening.test.ts src/terminal/Layers/Manager.remote.test.ts src/ws/wsRpcHandlers.terminalRecovery.test.ts` | 47 tests passed across 10 focused files                                                     |
| `BIGBUD_TERMINAL_TUI_PROBE=1 bun run --cwd apps/server vitest run src/terminal/Layers/TerminalRecoveryModel.tui.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                         | pi passed; OpenCode failed with `saved-cursor-not-qualified`; required TUI gate remains red |
| `bun run --cwd apps/web vitest run src/components/terminal/terminalUnicodeProvider.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Two tests passed                                                                            |
| `bun run --cwd apps/web test:browser src/components/terminal/TerminalViewport.addons.browser.tsx src/components/terminal/TerminalViewport.navigationDiagnostics.browser.tsx src/components/terminal/TerminalViewport.hydration.browser.tsx`                                                                                                                                                                                                                                                                                                      | Five tests passed                                                                           |
| `bun run --cwd packages/shared typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Passed                                                                                      |
| `bun run --cwd apps/web typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Passed                                                                                      |
| `bun run --cwd apps/server typecheck`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Passed, with existing informational Effect suggestions                                      |
| `python3 scripts/terminal-reliability/checkpoint.production.py`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Existing private-state comparison harness still passes; not ANSI qualification              |
| Explicit formatter/linter paths for 19 changed/new source/test/bridge files plus the two manifests and two documents                                                                                                                                                                                                                                                                                                                                                                                                                             | Formatting passed; final lint zero warnings/errors                                          |
| Focused source/test/bridge length assertions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | All at most 400 lines                                                                       |

Focused bundle smoke command:

```sh
bun build apps/server/src/terminal/Layers/TerminalRecoveryModel.ts --target=node --format=esm --outfile=<owned-temp>/terminal-recovery.bundle.mjs
```

A Node process imported that artifact, enabled the shadow flag, created an 80×24 model,
parsed `bundled-node`, asserted the candidate ANSI contained it and disposed the model.
No full server/desktop build was run. Code/implementation gates are **not green overall**
because OpenCode continuation qualification and actual frontend delivery remain incomplete.

The report was moved to the canonical `docs/reports/` directory after checking for a target
collision. Only this task's report was moved, the harness reference was updated, and the
task-created root `reports/` directory was removed only after it was empty.

#### Saved-register increment after the no-regression resolution

The positional-only Orca approach is not enabled. `TerminalRecoveryModel.savedCursor.ts`
reads the pinned headless registers and generates VT sequences that recreate supported saved
positions, wrap mode, SGR attributes/colors, and character-set designations. The mirror is not
mutated. Normal and alternate registers are restored separately; the serialized 1049 transition
is replaced by 47 so it cannot overwrite the reconstructed normal register. Current attributes,
charset, wrap mode, and absolute cursor are restored afterward. This is still a shadow candidate,
not a production snapshot RPC or frontend recovery path.

Supported register profile: default or in-viewport non-origin positions; default, indexed and RGB
colors; bold, italic, dim, blink, inverse, invisible, strikethrough and overline; empty default
designation arrays or fully specified four-slot ASCII/DEC tables. Unsupported national charsets,
partial designation arrays, underline/extended or protected attributes, origin registers, and
offscreen nondefault registers still return `saved-cursor-not-qualified`. Filling unspecified
charset slots is deliberately forbidden: it changes which slots a future restore overwrites.
Default absolute saved row zero is left untouched rather than clamped to retained scrollback.

Focused continuation tests compare cells, colors, styles and cursor after ESC 8, CSI u, DEC 1048
and alternate-screen exit. The Chromium test additionally changes a designation after capture,
then restores to verify future charset behavior. It exposed another real defect: trailing empty
alternate-buffer cells with background palette index 123 were restored with the default background.
The supplement now rebuilds viewport erase-cell background runs, with explicit refusal for empty
cells whose attributes cannot be reproduced by ECH. The failing comparison was retained as a
regression, not weakened to text-only equality.

At the saved-register checkpoint the focused installed pi/OpenCode startup/input probes passed. This did **not**
qualify long-running conversations, production navigation, all saved-register profiles, pre-allocation
memory bounds, hyperlink ranges, view palette authority, or packaged server/Electron deployment.
Those items were still incomplete at that checkpoint; the next milestone adds production
generation/sequence/resize delivery and guarded default-on. No PTY is automatically restarted.

Independent implementation/check/review subagents are unavailable in this child session: tool calls
return `Subagent depth limit reached (1)`. Focused checks can run directly, but no independent review
approval is claimed.

Latest saved-register verification:

```sh
files=(apps/server/src/terminal/Layers/TerminalRecoveryModel.savedCursor*.ts apps/server/src/terminal/Layers/TerminalRecoveryModel.{ts,test.ts,supplements.ts})
bun run oxfmt --check "${files[@]}" docs/reports/terminal-recovery-2026-11-01.md
bun run oxlint --report-unused-disable-directives "${files[@]}"
BIGBUD_TERMINAL_TUI_PROBE=1 bun run --cwd apps/server vitest run src/terminal/Layers/TerminalRecoveryModel.savedCursor.test.ts src/terminal/Layers/TerminalRecoveryModel.savedCursor.browser.test.ts src/terminal/Layers/TerminalRecoveryModel.tui.test.ts src/terminal/Layers/TerminalRecoveryModel.test.ts src/terminal/Layers/TerminalRecoveryRecords.test.ts src/terminal/Layers/Manager.recoveryModel.test.ts src/terminal/Layers/Manager.recoveryModel.browser.test.ts src/terminal/Layers/Manager.navigationRecovery.test.ts src/terminal/Layers/Manager.lifecycle.test.ts src/terminal/Layers/Manager.startup.test.ts src/terminal/Layers/Manager.hardening.test.ts src/terminal/Layers/Manager.remote.test.ts src/ws/wsRpcHandlers.terminalRecovery.test.ts
bun run --cwd apps/server typecheck
git diff --check
```

Results: formatting passed; lint zero warnings/errors; **57 tests passed in 13 focused files**,
including both installed native probes, Chromium saved-register continuation, and the real
manager/PTY history-exhaustion roundtrip; server typecheck passed; whitespace check passed.
An explicit Python line-count assertion passed for the six affected source/test files, all ≤400
lines. No workspace-wide checks, full suites, commits, or pushes were run. The authoritative
saved-attribute/charset requirement is met only for the stated supported profile; safe refusal
remains part of the implementation, not a claim of universal saved-state recovery.
