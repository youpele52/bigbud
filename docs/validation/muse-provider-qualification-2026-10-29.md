# Muse Code provider qualification — 2026-10-29

Live Phase 0 qualification for the Muse Code provider integration
(plan: `docs/plans/2026-10-13-meta-muse-code-provider-plan.md`). All account
labels are redacted; no credentials were read or recorded. Sign-in was
performed by the user in the terminal via the native `muse` flow; bigbud
never signs in programmatically and never falls back to an API key.

## Environment (this record)

| Item              | Value                                                                                                                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date              | 2026-10-29                                                                                                                                                                                                      |
| OS                | macOS (Darwin, arm64) — **only platform qualified so far**                                                                                                                                                      |
| CLI               | `muse` 1.4.14-R7309.1 (user-installed, `~/.local/bin/muse`)                                                                                                                                                     |
| SDK pair A        | `@muse-code/sdk` 1.4.14 (pinned in `apps/server/package.json`)                                                                                                                                                  |
| SDK pair B        | `@muse-code/sdk` 1.4.6 (upstream pairing) — handshake OK with fingerprint warning only                                                                                                                          |
| Runtimes          | Node (system), Bun 1.3.9 (`bun run` probe)                                                                                                                                                                      |
| Schema            | `muse schema generate-json-schema`: stable fingerprint `sha256:c94c3d1f...`, experimental bundle exported                                                                                                       |
| Auth lane         | `account/read` state `accountLogin` (browser login; label is an email — redacted)                                                                                                                               |
| Subscription note | `muse usage` reported `no_allowance`/`subs_active=false`, yet qualified turns below completed; entitlement is therefore recorded as **observed-working, not explained** and must be rechecked before enablement |

## Results

| #   | Scenario                                                       | Result                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Handshake via low-level SDK `spawnMspConnection`               | Granted `sessionMcp`; `sessionDurability=durable`; sandbox `available`; fingerprint match on SDK 1.4.14                                                                                                                        |
| 2   | `model/list` without a session                                 | providerId `meta`; default row is `muse-spark-1.3-contributor` (Contributor/training); efforts are closed tiers or explicit `unknown`                                                                                          |
| 3   | `permissionProfile/list`                                       | `:read-only`, `:ask-me`, `:auto-review`, `:unrestricted` (all available, reviewer human except auto-review/none)                                                                                                               |
| 4   | Two turns + codeword recall (`:read-only`, required stdio MCP) | Completed; MCP tool call required an approval presentation, then `approval/decide` with the offered `allow_once` choice and current requirement ID; tool result returned verbatim                                              |
| 5   | Exact-ID resume after host restart                             | `session/resume` history mode `inline`; codeword recalled correctly; MCP re-injected on resume                                                                                                                                 |
| 6   | Queued Stop                                                    | Second `turn/start` ack disposition `queued` with pre-minted turn ID; exact-ID `turn/unqueue` produced `turn/unqueued` carrying the **original submission command ID**; no `turn/started`/`turn/completed` for the queued turn |
| 7   | Running Stop                                                   | Exact-ID `turn/cancel` admitted; outcome arrived as `turn/completed` terminal `cancelled` (ack was not the outcome). Repeat cancel was admitted idempotently on this build (no `already_terminal` error observed)              |
| 8   | Permission matrix, `:ask-me` + `onRequest`                     | In-workspace write executed with **no approval**; shell executed with no approval; out-of-workspace (home) write sandbox-denied with no approval offered                                                                       |
| 9   | Permission matrix, `:ask-me` + `promptUnmatched`               | In-workspace write auto-applied; shell required approval (`allow_once` approve and deny/abort both exercised); out-of-workspace write sandbox-denied                                                                           |
| 10  | Permission matrix, `:read-only`                                | File write blocked; shell surfaced an approval but could not create the file                                                                                                                                                   |
| 11  | Bun runtime                                                    | SDK handshake, catalog, account and an MCP turn all completed under `bun run`                                                                                                                                                  |
| 12  | SDK 1.4.6 vs CLI 1.4.14-R7309.1                                | Works with a schema-fingerprint **warning** only; SDK 1.4.14 is the pinned pair                                                                                                                                                |

## Qualified access-mode mapping

- bigbud `auto-accept-edits` → native `:ask-me` + approvalMode `promptUnmatched`
  (workspace edits inside the native sandbox; shell/restricted actions need
  native approval; out-of-workspace writes sandbox-denied; shell network off).
  This is the minimum approval-gated coding mode.
- bigbud `approval-required` → **unsupported**: no native profile/approval-mode
  combination gates in-workspace file writes (evidence rows 8–9). Never
  reinterpreted from a profile label.
- bigbud `full-access` → **unsupported** (not live-qualified; never derived
  from bigbud's global default).
- Plan interaction mode → unsupported (not native read-only enforcement).

## Not verified / blockers

- **Windows and Linux: not verified.** Per the 2026-10-29 user decision,
  first enablement requires macOS + Windows + Linux; until then Muse reports
  unavailable on every target (enforced in server code by the platform gate).
- Auth expiry/quota exhaustion was not live-exercised (only logged-out and
  key-lane simulations, rows 17–18). Staged approvals and `userInput/*` were
  qualified in the follow-up pass below (rows 13–15); writer-lease and the
  packaged-server host smoke in the enablement pass (row 16, smoke section).
- The `no_allowance` entitlement observation is investigated in the follow-up
  pass below: turns run on the native OAuth lane (no API key exists), but the
  entitlement source remains unexplained and must be resolved before
  enablement.

## Follow-up pass — 2026-10-29 (second session)

Disposable workspace: `<qualification-root>/phase0b/` (`probe5.mjs`, SDK 1.4.14 + CLI 1.4.14-R7309.1, `:ask-me` + `promptUnmatched`).

| #   | Scenario                         | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | Staged compound shell approval   | **Passed.** `echo stage-one && echo stage-two && echo stage-three` produced one approval with 3 stages. Stage 1 `allow_once` → `approval/decide` result `terminal:false`; stage 2 reissued with a **new requirement ID** (`sourceIndex:1`). A decide replaying the stale stage-1 requirement was rejected `-32053 approvalRequirementStale` and did **not** approve stage 2; the correct stage-2 requirement then approved (`terminal:false`), stage 3 approved (`terminal:true`), `approval/resolved` decision `approved`, turn `completed` |
| 14  | userInput question — answer path | **Passed.** Model emitted `userInput/request` (one question, options Tabs/Spaces, selection `{mode:"single"}`); `userInput/answer` with the first option label was accepted, `userInput/settled` fired, turn completed with the model's `ANSWERED` reply                                                                                                                                                                                                                                                                                     |
| 15  | userInput question — cancel path | **Passed.** `userInput/cancel` accepted; `userInput/settled` fired; the model observed the cancellation and replied `CANCELLED-SEEN`; turn completed                                                                                                                                                                                                                                                                                                                                                                                         |

Wire-shape note from row 14: native question `selection` is an object (`{mode}`), not a bare string; the bigbud question mapper was corrected to match (`Adapter.questions.ts`).

### `no_allowance` investigation (row: environment table)

Evidence gathered (names/presence only, never values):

- `muse usage` prints `No subscription allowance (no_allowance)`.
- `~/.config/muse/auth.json`: `providers/meta` mechanism `oauth`, obtained via `device_code`, storage `keychain`, `subs_active=false`. No stored API-key credential.
- `META_API_KEY` is **absent** from the qualification shell environment.
- `account/read` over MSP projects state `accountLogin` — the device-code browser-login lane. Had an env or stored key won precedence, this would project `envKey`/`apiKey` instead.
- Native settings select provider `meta` with model `muse-wonder-1.0`; the MSP catalog rows carry profileId `tbh`.
- Completed turns (rows 4–15) emitted native `session/tokenUsage` events.

Conclusion: the turns demonstrably ran on the native OAuth `accountLogin` lane — the only credential lane present. They did **not** silently run on an API key: no key exists in env or storage, and bigbud's adapter rejects `envKey`/`apiKey` lanes with remediation regardless. What remains **unexplained** is why MSP turns are entitled while the CLI's subscription-allowance surface reports `no_allowance`/`subs_active=false` (plausibly the `tbh` catalog profile carries an entitlement distinct from the consumer subscription allowance, but this cannot be proven from the client). This stays a pre-enablement unknown to resolve with Meta documentation/support; it is not evidence of a forbidden lane, and it does not block the default-disabled implementation.

### Phase 3.15 recovery-delivery seam — closed (adapter + opt-in shared seam)

Crash window closed: a native terminal settles the Muse journal, `observeProviderRuntimeEvent` claims liveness, and the process dies before canonical publication/application — previously the claim suppressed every republication, leaving the canonical turn permanently active.

Design (opt-in, additive; other providers unchanged):

- `TurnCompletedPayload.recoveryRedelivery` (contracts, optional) marks a flagged recovery republication; Muse journal recovery emits it with stable event ID `muse-recovery-terminal-<turnId>`.
- `ProviderService.turnLiveness.ts`: when `claimTerminal` already exists, only flagged recovery events may proceed to publication. Liveness is never reopened, outcomes never change, unflagged duplicates from every provider (including Muse) stay suppressed.
- `ProviderRuntimeIngestion` (`isProvenSettledRecoveryTerminal` in `ProviderRuntimeIngestion.lifecycle.ts`): a flagged event is dropped only when canonical state proves settlement (settled `latestTurn` for this turn, session no longer running it); otherwise it delivers through the normal ingestion path with all lifecycle/queue/owner fencing intact.

Crash-injection coverage: `ProviderRuntimeIngestion.museRecovery.test.ts` (missing delivery after claim/publication crash delivers once; repeated recovery after canonical application is idempotent — no duplicate message/outcome; failed-before-start settles; reclaimed-queued interruption settles), `ProviderService.turnLiveness.recovery.test.ts` (claim suppression unchanged for ordinary duplicates of all providers; flagged Muse redelivery passes; unflagged Muse duplicates stay suppressed), and `ProviderRuntimeIngestion.lifecycle.recovery.test.ts` (settled-proof predicate). Existing ingestion/liveness/publication suites for other providers pass unchanged.

### Packaged-server host smoke — passed (2026-10-29, enablement pass)

The earlier not-run note is superseded: the user authorized the build.

- `bun build:desktop` (`turbo run build --filter=@bigbud/desktop --filter=@bigbud/server`): **4 tasks successful in ~25s**, including the server thread-tool manifest/native-qualification checks.
- Packaged host: `BIGBUD_HOME=<scratch> timeout 30 node apps/server/dist/bin.mjs` — the packaged Node host started, applied migrations to a fresh state DB (verified `muse_session_bindings` table + index present in the packaged state.sqlite), ran provider recovery for all registered providers, and listened on `http://0.0.0.0:3773`. No `ERR_MODULE`/SDK load failures; the only warnings were pre-existing Cursor ACP probe timeouts. The Muse SDK (ESM, Node >=20) loads under the packaged Node host.
- Not exercised: the Electron window itself (the desktop shell embeds this same server bundle), and a settings-enabled Muse turn through the packaged host. Muse stayed default-disabled throughout the smoke.

## Enablement pass — 2026-10-29 (macOS-first)

The user superseded the all-platforms-first decision (plan §2 amendment 7):
**macOS may become ready on user opt-in; Windows/Linux report unavailable per platform.**

Additional live scenarios (probe6/probe7 in `<qualification-root>/phase0b/`):

| #   | Scenario                                                                                          | Result                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 16  | Writer-lease conflict                                                                             | **Passed.** Second host `session/resume` of a session held by the first host rejected `sessionInUse` (-32021); duplicate `session/start` with the same ID rejected `session_id_conflict`; original owner kept driving its session. bigbud behavior matches: resume failure creates no replacement and forces no takeover (binding retained, `unsafe-to-replay`) |
| 17  | Auth logged-out simulation (isolated `HOME` override to an empty dir; real credentials untouched) | **Passed.** `museHome` resolved into the isolated home and `account/read` projected `loggedOut`. Note `MUSE_HOME` is **not** honored by this CLI build; `HOME` is the working isolation lever on macOS                                                                                                                                                          |
| 18  | API-key lane precedence (bogus `META_API_KEY`, not a real key)                                    | **Passed.** `account/read` projected `envKey` — exactly the lane bigbud rejects with remediation (provider snapshot + now also adapter session-start, which requires `accountLogin` before any native side effects)                                                                                                                                             |

### no_allowance — deeper look (item E)

- `muse model-profile show` for `muse-spark-1.3`, `muse-spark-1.3-contributor`, and `muse-wonder-1.0` reports tuning/profile resolution only; no billing-lane fields.
- MSP `usage/read` returns `{}` on this account; `settings/read` shows native provider `meta`, model `muse-wonder-1.0`. Catalog rows (all `profileId: "tbh"`) carry list prices, which are catalog data, not proof of what a given turn billed.
- Auth storage is OAuth via device code (`subs_active=false`); no API key exists in env or storage, and `account/read` actively projects `accountLogin`.

Determination: client-visible evidence **cannot** establish whether turns bill a subscription, a workspace/org entitlement, or pay-as-you-go credit — that ledger is server-side at Meta. What would close it: the Meta account/billing console showing (or not showing) MSP turn charges for this account, or Meta documentation stating the `tbh` catalog profile's entitlement source. **Recommendation: this does not block macOS enablement.** The lane risk the plan guards against (silently billing an API key) is excluded by evidence and now enforced twice (provider snapshot + adapter start). It remains a disclosure/recheck item: bigbud makes no billing claims, and users should confirm their Meta account terms. Revisit if Meta-side evidence contradicts the `accountLogin` entitlement.

## Enablement gate

Muse ships default-disabled (user opt-in in settings). The per-platform
gate (`MUSE_PLATFORM_QUALIFICATION` in
`apps/server/src/provider/Layers/Muse/Provider.discovery.ts`) is lifted
for **macOS only** per the 2026-10-29 enablement amendment; Windows and
Linux each need a dated record produced with
`docs/validation/muse-windows-linux-qualification-kit.md` before their
flags flip. On unqualified platforms Muse reports unavailable with a
reason; everywhere it additionally requires the native `accountLogin`
lane, a verified catalog, and the qualified `auto-accept-edits` mapping.

## Live in-app defects — 2026-10-29 (first dev-app Muse session)

The first real bigbud thread on Muse (dev desktop app, macOS, CLI
1.4.14-R7309.1, SDK 1.4.14) surfaced two wire-contract gaps that the fake
transport in the unit tests had accepted silently. Both were reproduced with a
throwaway SDK probe against the installed CLI (durable host, disposable
workspace, no turn sent, no project content), then fixed.

| #   | Scenario                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 19  | In-session model switch (`session/setModel`)         | **Defect, fixed.** The adapter sent a bare `modelId`; the host rejects it `-32602 invalidParams: missing field \`model\``— every turn whose composer model differed from the session's start model failed. The SDK 1.4.14 type is`model: ModelSelection` (`{ modelId, providerId?, profileId?, displayLabel? }`). Probe: `{ model: { modelId } }`and`{ model: { modelId, providerId: "meta" } }`both acked`accepted`, emitted `session/modelChanged`, and `session/read`reflected the new`session.modelId`immediately while idle. Adapter now sends`{ modelId, providerId: <subProviderID> }` |
| 20  | Unknown model id via `session/setModel`              | The host **accepts** an id absent from `model/list` (`session.modelId` became `not-a-real-model`). Native admission is therefore not a catalog guard; bigbud's verified-catalog selection (UI + `validateMuseStart`) remains the only guard. No change needed, recorded as a limitation                                                                                                                                                                                                                                                                                                       |
| 21  | `session/start` `workspaceRoots` canonical-path rule | **Gap, fixed.** The host rejects a non-canonical root as invalid params (`/tmp/x` → "expected a canonical path (resolves to /private/tmp/x)"). The adapter passed the thread cwd verbatim; a project under a symlinked directory could never start a Muse session. Adapter now resolves `realpath` once (`resolveMuseWorkspace`) so session, binding and cursor share the canonical identity; an unresolvable path passes through so the native error surfaces                                                                                                                                |
| 22  | `initialize.clientInfo.name` rule                    | The host requires `^[a-z0-9_]+$` (`bigbud` passes; a hyphenated probe name was rejected). Recorded so nobody renames the client identifier                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| 23  | Ephemeral host (`muse serve --no-session-log`)       | Rejects `permissionProfile` on `session/start` (`permission_profile_ephemeral_fixed`). Confirms the adapter's existing durable-only gate is required, not optional                                                                                                                                                                                                                                                                                                                                                                                                                            |

Also observed in the dev trace before the fix: 40 fail-closed
`startSession` rejections for `full-access` on two Muse threads. That is the
intended server guard (only `auto-accept-edits` is qualified); the web
composer clamps an inherited `full-access` mode to the provider's first
qualified mode on load and on provider switch, so recheck the first-send path
in the app after this fix rather than loosening the guard.

Regression coverage: `Adapter.lifecycle.test.ts` fake host now rejects the
bare-`modelId` shape exactly like the native host and asserts the
`ModelSelection` payload, the confirmed cursor model, and fail-closed
rejection of a non-native reasoning-effort tier before `turn/start`.

## Live adapter run — 2026-10-29 (real adapter + real CLI, after the fixes)

Executed through the production adapter code (`makeMuseAdapterShape` with
`makeSdkMuseHostFactory`, no fakes) against CLI 1.4.14-R7309.1 / SDK 1.4.14 on
macOS, Node via Vitest, in a disposable `/tmp` workspace holding one README.
Models: `muse-spark-1.3` and `muse-wonder-1.0` (no Contributor models). No
MCP bridge was injected (the bridge was qualified in rows 4–5). All 8
scenarios passed in 42 s. The probe is kept as the opt-in test
`apps/server/src/provider/Layers/Muse/Adapter.live.test.ts`
(`MUSE_LIVE_PROBE=1`), skipped by default, so Windows/Linux can run the
identical matrix.

| #   | Scenario                                       | Result                                                                                                                                                                                                                |
| --- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 24  | Start from a non-canonical cwd (`/tmp/…`)      | **Passed.** `session/start` accepted; returned session `cwd` is the canonical `/private/tmp/…` path (row 21 fix)                                                                                                      |
| 25  | Plain turn                                     | **Passed.** `turn.started` → assistant `item.completed` → `turn.completed` state `completed`; reply text contained the requested word                                                                                 |
| 26  | In-session model switch, both directions       | **Passed.** `muse-spark-1.3` → `muse-wonder-1.0` → `muse-spark-1.3` via `session/setModel` with the `ModelSelection` shape (row 19 fix); each confirmed by `session/read`, cursor model updated, both turns completed |
| 27  | Shell approval (`:ask-me` + `promptUnmatched`) | **Passed.** `request.opened` with `command_execution_approval` and the exact command; `respondToRequest(accept)` → `approval/decide` with the offered `allow_once` choice; turn completed with the command output     |
| 28  | User-input question                            | **Passed.** `user-input.requested` with the two offered options; `respondToUserInput` → `userInput/answer` (`selectedLabel`); model replied with the chosen option                                                    |
| 29  | Stop on a running turn                         | **Passed.** Exact-ID `turn/cancel` after first output; exactly one `turn.completed` with state `interrupted`                                                                                                          |
| 30  | Stop on a queued turn                          | **Passed.** Second submission acked `queued`; exact-ID `turn/unqueue` → one `turn.completed` `interrupted` for it with **no** `turn.started`; the running turn then stopped `interrupted`                             |
| 31  | Restart + resume                               | **Passed.** `stopSession` closed the host (`session.exited`); a fresh adapter resumed the exact native session from the cursor; the model recalled the first turn's word from native history                          |

### First-send access mode (dev app) — reconstructed, not re-run

Dev DB: both Muse threads used today were created (09:29Z, 09:57Z) in the
global default `full-access`. The composer clamp (`resolveInheritedFullAccessDowngrade`
on load, `resolveProviderSwitchRuntimeMode` on provider switch) was written
afterwards (local 11:02–11:05) and is unit-tested (6 passing cases in
`chat-view-provider-switch.hooks.test.ts`). Thread `<thread-a>` recorded
`thread.runtime-mode-set → auto-accept-edits` at 10:17Z and started
successfully from then on; thread `<thread-b>` still carries `full-access` in
the projection because the clamp persists only on the next send. The
in-app first-send path itself could not be driven here (the embedded
browser cannot reach the dev server's WebSocket), so it remains a one-click
manual check: open either thread, confirm the Access control shows
Auto-accept edits, send.

## Enablement amendment 2 — 2026-10-29 (all platforms, user decision)

The user directed that Windows and Linux be supported regardless of live
qualification. Muse is now available on macOS, Windows and Linux on opt-in.
This record's evidence still covers **macOS only**; Windows and Linux are
**enabled, not qualified**.

What protects Windows/Linux users without a live run:

- **Sandbox refusal at runtime.** A host whose initialize reports
  `sandboxAvailability: "unavailable"` is refused at discovery and at
  session start, with a remedy per native reason (`bubblewrapUnavailable`,
  `userNamespacesDenied`, or Windows `muse sandbox windows setup`). The
  supported access mode's promise (edits inside the sandbox) is never run
  unsandboxed. An older host that omits the field is not treated as
  unavailable.
- **Windows launch.** Bare `muse` resolves through PATHEXT; `.cmd`/`.bat`
  launchers run under ComSpec `/d /c` with `@`-quoting or `^`-escaping.
- **Windows roots.** `session/start` sends the verbatim canonical root
  (`\\?\C:\…`, true case via native realpath) while the host starts in the
  plain path. Both behaviors are proven by upstream t3code's shipped tests,
  not by a bigbud run.
- **Gate bug fixed.** Session start now refuses a host that fails
  qualification instead of proceeding.

Regression after the refactor: live macOS matrix (rows 24–31) re-run, 8/8
passed.

Still owed, now as verification: one Windows and one Linux run of the live
matrix and the MCP probes from the kit. If either fails, set that
platform's flag to false to withdraw it while the fix is made.

## Windows/Linux launch research — 2026-10-29

Sources: the pinned SDK 1.4.14 source (`connection/spawn.js`), the official
SDK docs (quickstart, host operations), and Meta's official installers and
launchers (`dev.meta.ai/install.sh`, `install.ps1`,
`api.meta.ai/muse-launcher.sh`, `muse-launcher.ps1`), read without running.

Findings:

- **SDK:** spawns with no shell and no PATHEXT lookup, so Windows needs a
  resolved path; sets `windowsHide`; on POSIX owns a process group, on
  Windows ends only its direct child; `close()` closes stdin, waits the 30 s
  drain window, then SIGTERM and SIGKILL. Passing `env` replaces the whole
  environment (bigbud extends `process.env`).
- **Docs:** the SDK docs give no Windows/Linux launch guidance. Host
  operations says an unenforceable sandbox makes shell commands fail with an
  environment error rather than run unsandboxed; bigbud refuses such a host
  up front with the remedy instead of letting every shell call fail.
- **POSIX installer:** bash launcher at `${MUSE_INSTALL_DIR:-~/.local/bin}/muse`
  ending in `exec muse-bin-<version>`; stdio and process group reach the
  real host. Spawned as-is.
- **Windows installer:** `%LOCALAPPDATA%\Programs\muse\muse.cmd` runs
  Windows PowerShell, which runs `.muse-launcher.ps1`, which calls
  `muse-bin-<version>.exe` from inside a script function. Three wrapper
  processes, SDK teardown reaching only the first, and possible PowerShell
  5.1 console-codepage re-encoding of the MSP stream.

Changes:

- **Windows direct binary:** behind the official shim (sibling
  `.muse-launcher.ps1`, `.muse-version` matching the launcher's own version
  pattern, existing `muse-bin-<v>.exe`) bigbud starts the real binary
  directly. Auto-update is already off for owned hosts; only optional
  release-notice metadata is skipped. Unrecognized `.cmd`/`.bat` launchers
  still go through ComSpec.
- **Installer-location fallback:** when the default `muse` is not on PATH,
  bigbud tries the official install location (Windows
  `%LOCALAPPDATA%\Programs\muse\muse.cmd`; POSIX `MUSE_INSTALL_DIR` then
  `~/.local/bin/muse`). Covers bigbud started before the installer updated
  PATH. Explicit binary paths are never redirected.
- macOS regression: real discovery handshake through the new resolution
  reported ready.

Follow-up (user decision, same day): owned hosts now start with
`--trust-workspace`, so Muse loads the project's own skills and rules,
matching upstream t3code. Sandbox, permission profile and approval mode are
unaffected. The SDK shutdown drain is set to 20 s (`shutdownTimeoutMs`,
SDK default 30 s; upstream uses 10 s). Live macOS matrix re-run with both:
8/8 passed, including stop and exact-session resume.

## Subscription limits — 2026-10-29

Muse now feeds the usage page's Subscription limits card (source
`muse-msp`, label "Muse Code"). Read order:

1. MSP `usage/read` on a host (the status check reuses its discovery host).
2. The newest `usage/changed` from a live session host, if under 10 minutes
   old. A fresh host only knows usage it has seen in Meta's responses, so
   `usage/read` alone is usually empty; session hosts receive the same
   payload during turns.
3. `muse usage --json` (CLI 1.4.13+, no model turn), launched through the
   same platform launch resolution as the host.

Mapping: `window` → "5-hour limit" when 300 minutes, otherwise "N-hour
limit"; `weekly` → "7-day limit"; tier id → subscription label
("everyday_usage" → "Everyday Usage"). Meta percentages above 100 are
capped for the bar. No allowance (pay-as-you-go API credit, API-key lane,
signed out) is `unavailable`, which the card hides.

Live check on this account: `usage/read` on a fresh host returned `{}`; the
CLI returned `{"allowance":null,"reason":"no_allowance"}`; the reader
returned `unavailable`. Auth storage shows `subs_active=false`, consistent
with API credit rather than a subscription. Neither the CLI nor MSP exposes
an API-credit balance. The populated allowance shape comes from the SDK types
and the binary's field names, not from a live subscribed account.

## In-app defect: `commandId payload conflict` on every send — 2026-10-29

Symptom: every send in the Muse thread failed with `command <id> rejected:
commandId payload conflict`, then "Could not reconnect". The ID was the
thread's durable creation command ID (binding phase `bound`).

Cause: a start request without a resume cursor (a fresh restart path)
reached the adapter's create branch, which replayed `session/start` with the
stored creation command ID. Muse rejects a reused command ID with a changed
payload, and the payload always changes because it carries per-launch
details such as the MCP bridge config. A bound session could therefore never
be restarted without its cursor. A second latent bug: the bridge was built
for a freshly minted ID before the stored ID replaced it.

Fix (`Adapter.startSession.ts`, new `Adapter.startSession.resume.ts`,
`Adapter.model.ts`):

- A bound binding is always resumed by its exact native ID, cursor or not.
- An uncertain (reserved) creation that Muse reports as already applied
  (`commandId payload conflict` / `session_id_conflict`) is bound and
  resumed; any other start failure still blocks it, creating nothing.
- After a resume, the thread's selected model is applied with the shared
  confirmed `session/setModel` helper.
- The bridge is built for the final session ID.

Proof: unit regressions (`Adapter.startSession.bindings.test.ts`) and live
scenario I (cursorless restart of a bound session resumed the same native
session; the model recalled the first turn). Live matrix 9/9.

## In-app defect: Muse replies never rendered — 2026-10-29

Symptom: after the payload-conflict fix, sends were accepted and Muse
answered (the canonical publication log carried the assistant
`item.completed` "Hi — how can I help today?"), but the thread showed only
the user message. The session flipped from `running` to `ready` about 3 s
into the turn (`server:provider-runtime-session-reconcile`), and no
`turn.completed` was ever published, although Muse's own trace recorded the
run terminal `outcome=completed` at 11:50:35.

Three causes, all in the adapter:

1. **Session epoch missing on events.** The thread's orchestration session
   epoch was 1 (advanced by a restart). Ingestion drops non-lifecycle
   runtime events whose `sessionEpoch` differs from the projected epoch, and
   Muse events carried none, so every item and delta was discarded.
2. **`listSessions` always reported `ready`.** Right after `sendTurn`,
   ProviderService reads the live session; an idle answer means "the turn
   already finished", so it claimed the turn's liveness terminal at send time
   (`terminal_at` equalled `turn_started_at`). The real `turn.completed` then
   lost its terminal claim and was not published. The same view, with a
   fresh `updatedAt` on every call, let the 5 s reconciler reset the thread
   to `ready` mid-turn.
3. **Stream mapping.** `item/delta` carries only `itemId` and `field`; every
   delta was mapped to assistant text with no turn. Live probe: reasoning
   items carry `summary` (not `text`) and stream `field: "summary.N"`; agent
   messages stream `field: "text"`; `session/read` exposes `activeTurnId`;
   `turn/completed` follows `turn/foregroundCompleted` by about 6 s while
   reminder children settle.

Fix (`Adapter.sessionView.ts` new; `Adapter.ts`, `Adapter.types.ts`,
`Adapter.startSession*.ts`, `Adapter.sendTurn.ts`, `Adapter.stream*.ts`,
`Client.schema.ts`):

- Every Muse runtime event is stamped with the start input's session epoch.
- `listSessions` reports `running` with `activeTurnId` while a foreground or
  queued turn is open, the session epoch, and timestamps that advance only on
  a real change. A terminal that arrives before the `turn/start` ack does not
  reactivate the turn.
- A live-item index routes deltas: agent `text` becomes `assistant_text`;
  reasoning `summary.N` becomes `reasoning_summary_text` with
  `summaryIndex`; deltas of other items (reminder children) are dropped.
  Deltas carry the owning turn; completed reasoning items carry the summary.

Proof: unit regressions (`Adapter.sessionView.test.ts`,
`Adapter.stream.items.test.ts`); Muse suite 63 passed / 9 live skipped;
server typecheck clean apart from unrelated concurrent work. A temporary live
harness (real `muse serve` → real adapter → real `ProviderRuntimeIngestion`,
thread epoch advanced to 1) stored exactly one finished assistant message,
"91 is not prime because 7 × 13 = 91.", with no assistant message built from
reasoning text; the harness was removed afterwards. The dev app itself was
not re-run after the fix.
