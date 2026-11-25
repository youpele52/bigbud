# Rust SSH ownership: finish-line plan to S4 accepted

- **Status:** Draft. All product decisions U1–U12 were accepted on 2026-11-25 (§4) and are now work items. The plan stays Draft only until the external prerequisites E1–E8 (§5) are committed. Workstreams W0–W3 and W5 can start now.
- **Created:** 2026-11-25 · **Last modified:** 2026-11-25 09:51 CET (revision 2: code re-verification)
- **Project root:** `/Users/youpele/DevWorld/bigbud`
- **Inspected:** branch `dev`, HEAD `a259080c62b0dc0d2cfd15109f4626bfefb75767` ("Added creating and deleting files and folders in Files").
  - The worktree is dirty with **668** `git status --short` entries, including the untracked `rust-ssh-ownership` docs, and concurrent edits are ongoing.
  - The ledger was 719 lines at inspection; its newest entries run through ledger line 134.
- **Authoritative inputs:**
  - [Plan](2026-11-22-rust-ssh-ownership-plan.md)
  - [S0 ledger](2026-11-22-rust-ssh-ownership-s0-ledger.md)
  - [S4 cutover design](2026-11-23-rust-ssh-ownership-s4-cutover-design.md)
  - [S3/S4 backlog](2026-11-23-rust-ssh-ownership-s3-s4-backlog.md). The backlog is stale wherever the ledger supersedes it.

  This plan sequences those documents and records the user's U1–U12 decisions. Where it conflicts with the plan or the ledger, the plan and the ledger win.

**W0 reconciliation (2026-11-25).** Re-read against the working tree:

- The [ledger](2026-11-22-rust-ssh-ownership-s0-ledger.md) was **719 lines** at inspection, with its newest pre-slice entries through **ledger line 134** (`C05 / first-visit New File on Debian`). The W1 owner-core slice appended unit-only entries (729 lines), and the W1.3/W1.7 slice appended retirement/status evidence (**755 lines**). Its S2-closed statement and named gates match §1 below.
- The worktree is still `dev@a259080c62` with **668** dirty entries.
- The [backlog](2026-11-23-rust-ssh-ownership-s3-s4-backlog.md) is marked **superseded** by this plan.
- §4 records all twelve decisions **U1–U12**; none is open.
- The §2.2 line-anchor corrections and the 13/39/3/0 disposition counts were applied to [cutover design §a](2026-11-23-rust-ssh-ownership-s4-cutover-design.md#a-legacy-launch-inventory), together with D1–D5 and the closed Q2–Q8.

## 1. Goal, definition of done, current state

**Goal.** Record **S4 accepted** for one build. All managed SSH runs through the Rust owner on every supported initiating profile, with no TS executor and no fallback. Build A ships first as the rollback floor, and the transfer handoff contract is published.

**Done when all of these hold:**

1. Every gap in §2 is closed in the ledger, either with parity evidence or with a documented denial approved under U1–U3.
2. Every Pre-cutover deferred row passes on release-trusted artifacts and runners.
3. Build A has shipped before Build B.
4. One activation change set removes legacy rows 1–51 and the type dependents D1–D5 (§2.2).
5. The structural checker and the `cutover/` traces both show zero bypasses.
6. The S4 accepted record lists the protocol version, capabilities (including Windows password status), typed errors, grant-issuance limits and artifact IDs.

**Current state:**

- **S0:** Closed for contracts and local baselines only.
- **S1/S2:** Closed for the macOS/Linux dev scope only. Named open gates remain:
  - signed pre-A/A/B rollback
  - owner-death identity retirement, with automatic retirement disabled
  - Debian GSSAPI
  - Windows password denial
  - keyboard-interactive
  - port 22
  - release rows
- **S3:** Not accepted.
- **S4:** Nothing has been activated.

**Wire fact (verified).** The [v1.proto](../../protocol/ssh-owner/v1.proto) `Request.operation` oneof has production verbs only for:

- `inspect_trust`
- `approve_trust`
- `connect`
- `disconnect`
- `list_folders`

Every other operation is a `proof_*` variant (fields 15–60, the newest being `proof_workspace_create = 60`). `ErrorCode` stops at `ROUTE_UNAVAILABLE = 27`.

None of the following exists in any `.proto`, in the Rust owner crate or in `apps/server/src`:

- `windowsPasswordUnsupported`. It appears only in the [Rust gate doc comment](../../crates/bigbud-ssh-owner/src/windows_password_gate.rs) and in `release-evidence/matrix/catalog.ts`.
- a keyboard-interactive outcome
- a session-quota or `MaxSessions` outcome. The only `maxSessions` in the tree belongs to OpenCode v2.
- `transferStream` or `packagedRsync`
- `runThreadShell` or `runProviderWorkspaceShell`
- `ensurePeerCoordinatorKey` or `inspectPeerHostKey`
- `subscribeStatus`, `terminalInspect`, `agentAction` or `gitRemoteTransport`

`deploymentAction`, `runAcpCommand`, `probeProvider`, `openClientRelay` and `openPeerRelay` appear only as TS names, not on the wire. `protocol/ssh-owner/release-evidence/structural/` does not exist.

## 2. Gap register (re-verified 2026-11-25)

**Blocker types:**

- **code:** implementation is missing.
- **run:** code exists, but evidence is missing.
- **ext:** an external runner or artifact is required.

No row is blocked on a user decision any more. "Δ" marks a change since revision 1. Wherever this table says "Evidence", the ledger is the authority.

### 2.1 Rows

| ID                          | Current evidence                                                                                                                                                                                                                                                                                                                 | Missing                                                                                                                                                                                                        | Blocker   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| C01                         | Generated-alias Save and reopen; Linux direct and jump browse; policy v2                                                                                                                                                                                                                                                         | General user-profile and alias admission; jump routes beyond browse; multi-bastion; port 22                                                                                                                    | code, run |
| C02                         | Fixture trust; POSIX password master on macOS and Linux                                                                                                                                                                                                                                                                          | Real credential and passphrase parity; **U2** and **U3** typed refusals (absent from the wire)                                                                                                                 | code      |
| C02-D                       | Stock Debian refused at `GSSAPIAuthentication` (line 53)                                                                                                                                                                                                                                                                         | **U1** policy v3 work                                                                                                                                                                                          | code      |
| C03 Δ                       | Native health on the generated fixture. Shared-probe caller cancellation and authenticated WebSocket cancellation (`healthCancelled`) on macOS ([test](../../apps/server/src/ssh/sshMonitor.healthOwner.websocket.test.ts)). **Narrowed.**                                                                                       | `subscribeStatus` verb, sequenced pushes, typed stats, slow-writer isolation                                                                                                                                   | code      |
| C04                         | macOS and Debian FD3 watch cancellation                                                                                                                                                                                                                                                                                          | Guarded and retained modes                                                                                                                                                                                     | run       |
| C05 Δ                       | Preview, search, 48 KiB write, guarded save. Exclusive create in the selected app with macOS and Debian browser New File. Browser recovery after an uncertain guarded save at the app boundary ([FilePreview.editRecovery.browser.tsx](../../apps/web/src/components/files/FilePreview.editRecovery.browser.tsx)). **Narrowed.** | Tool transport; session-FS and Copilot (still fenced); folder create and delete over the owner (HEAD added the Files UI; ledger says folders are uncovered); unguarded writes over 48 KiB; live SSH reply loss | code, run |
| C06 Δ                       | Selected reads; status refresh including untracked files ([GitStatus.details.ts](../../apps/server/src/git/Layers/GitStatus.details.ts)); Debian browser refresh. **Narrowed.**                                                                                                                                                  | Mutations (HEAD added "discard changes"; not ported); accurate untracked counts; macOS browser (blocked by the sandbox's `xcode-select`)                                                                       | code, run |
| G1 Δ                        | Fence refuses unported verbs. Upstream refresh stays fenced, with refusal evidence ([GitStatus.upstream.ts](../../apps/server/src/git/Layers/GitStatus.upstream.ts)). Composition `GitCore.initiatingPush.composition.ts` has **no product importer**.                                                                           | **U7** owner-controlled Git/`gh` transport                                                                                                                                                                     | code      |
| C07                         | macOS interactive, Restart, Quit, crash and retained restart                                                                                                                                                                                                                                                                     | Linux PTY; detached idle; Electron; policy adapter by exact lease                                                                                                                                              | code, run |
| C08 Δ                       | Process poller ([Manager.process-drain.remote.ts](../../apps/server/src/terminal/Layers/Manager.process-drain.remote.ts)) reports `unknown` for native leases instead of running legacy inspection. **Narrowed (fenced).**                                                                                                       | `terminalInspect` verb and native snapshots; typed shell-profile launch                                                                                                                                        | code      |
| C09 Δ                       | Opt-in installed proxy (product import via `remoteAgentComposition.installedProxy.ts`); detector. A new [identity observation producer](../../apps/server/src/remote-agent/remoteAgentComposition.installedObservation.ts) exists but has **no product importer**. **Narrowed.**                                                 | Normal-startup observation and proxy binding; `agentAction` install, status and control; reattach; E7 agent bytes                                                                                              | code, ext |
| C10                         | `Pi/RpcProcess.owner.ts` and `Opencode/ServerManager.owner.ts` have **no product importer** (proof clients and fixtures only)                                                                                                                                                                                                    | Composition; Codex sync probe (`codexAppServerManager.process.remote.ts:116` `spawnSync`)                                                                                                                      | code      |
| C11 Δ                       | ACP terminal returns `ssh-owner-unavailable` when selected without a capability. Typed ACP session **reads** for Cursor and Devin are composed in the dev [server.providerLayers.ts](../../apps/server/src/server.providerLayers.ts), with a live native loopback read. **Narrowed.**                                            | `runAcpCommand` on the wire; ACP writes; real provider run; G2 verbs                                                                                                                                           | code, run |
| C12                         | Fresh selected reservation; manifest staging; `deployment.ssh.owner` imported by `deployment.ssh.ts`                                                                                                                                                                                                                             | Upload, reset, fetch, publish, start; cancellation; unknown outcomes                                                                                                                                           | code      |
| C13 Δ                       | Fail-closed selected admission; Linux lease lifecycle (13 tests on Debian). `clientRelay.ssh.owner` is product-imported. **Narrowed.**                                                                                                                                                                                           | Typed-owner production route; behavior under load (backpressure, half-close)                                                                                                                                   | code, run |
| C14/G3                      | macOS paired relay. `peerRelay.ssh.owner.ts` has **no product importer**.                                                                                                                                                                                                                                                        | **U9** `ensurePeerCoordinatorKey` and `inspectPeerHostKey`; **U10** rootful Linux VM evidence; deployed enrollment                                                                                             | code, run |
| C15                         | None                                                                                                                                                                                                                                                                                                                             | Reserved verbs plus a native fixture                                                                                                                                                                           | code      |
| X-WIRE                      | New: all non-picker operations are `proof_*` (Q1)                                                                                                                                                                                                                                                                                | Freeze production verb names and promote them, with goldens, before W7                                                                                                                                         | code      |
| X-BUD                       | None                                                                                                                                                                                                                                                                                                                             | Budgets and a quota outcome                                                                                                                                                                                    | code      |
| X-RET                       | Design rejected; candidate is PID plus start time                                                                                                                                                                                                                                                                                | Implementation and crash proofs                                                                                                                                                                                | code      |
| X-DRAIN                     | None                                                                                                                                                                                                                                                                                                                             | **U5/U8/U12** drain, consent, marker, host verb                                                                                                                                                                | code      |
| X-STRUCT                    | Absent                                                                                                                                                                                                                                                                                                                           | Checker                                                                                                                                                                                                        | code      |
| X-CLI                       | New from U11                                                                                                                                                                                                                                                                                                                     | Audit DB-opening CLI subcommands; `backend.lock`                                                                                                                                                               | code      |
| X-WIN, X-ELEC, X-REL, X-PKG | Unchanged                                                                                                                                                                                                                                                                                                                        | See W5/W6                                                                                                                                                                                                      | code, ext |

### 2.2 Legacy inventory recount (W0.2, done in this revision)

- **All 55 rows still exist.** Every file named in cutover design §a is present.
- **No new launch site.** A search for `buildSshCommandInvocation`, `ssh/ssh{Command,LocalCommand,Process,Session}` importers, `"ssh-*"` basenames, `?? "ssh"` and `GIT_SSH_COMMAND` outside tests and fixtures found only files that are already rows.
- **New type-only dependents of row 4 (`RunSshCommandInput`).** These do not launch SSH, but they must convert when `sshProcess.ts` is deleted:
  - D1 [remoteAgentDiagnostics.ts](../../apps/server/src/remote-agent/remoteAgentDiagnostics.ts)
  - D2 `remoteAgentInstall.inbox.ts`
  - D3 `remoteAgentInstall.transaction.ts`
  - D4 `remoteAgentLocalControl.approval.ts`
  - D5 [localSupervisorInstaller.ts](../../apps/server/src/remote-backend/localSupervisorInstaller.ts). This one reuses the shape for local supervisor control.
- **Disposition counts are now 13 delete, 39 convert, 3 keep and 0 open.** Row 50 moved from open to convert under U9. The D1–D5 type conversions come on top.
- **Line anchors that drifted (fix them in cutover design §a during W0):**

  | Row | File                                 | Cited line(s) | Current line(s) |
  | --- | ------------------------------------ | ------------- | --------------- |
  | 15  | `sshMonitor.ts`                      | 30            | 34              |
  | 7   | `sshSession.control.ts`              | 18            | 15              |
  | 27  | `WorkspaceFileSystem.remoteWatch.ts` | 144           | 155             |
  | 39  | `remoteAgentServerLayer.ts`          | 354           | 357             |
  | 44  | `remoteWorkspaceAcpTerminal.ts`      | 96, 104       | 100, 108        |
  | 47  | `clientRelay.ssh.ts`                 | 78, 100       | 81, 103         |
  | 50  | `peerSshKey.ts`                      | 89            | 90              |

  Row 25 `PtyShellExecutable.ts:52` is now the dev fence line, not a launch. Row 32 (`remoteAgentGit.ts:57`, kept) is unchanged. The other spot-checked anchors still match.

## 3. Workstreams

**Global rules (do not reopen):**

- One all-consumer S4 activation.
- No TS fallback, no per-target rollout and no release selector.
- Build A ships first.
- Transfer M0 starts only after S4 accepted.
- New consumer work stays behind `isDevSshOwnerSelected` and refuses rather than routing to legacy.

**Every item follows these conventions:**

- Split files with dot-notation and keep each file at 400 lines or fewer.
- Use `Effect.fn("name")` and no barrel imports.
- A wire change updates `protocol/ssh-owner/v1*.proto`, the Rust dispatcher, the TS codec (`apps/server/src/ssh/sshOwnerPickerProof.codec.*.ts`) and the goldens (`v1.golden.*`, `verify-rust`) together.

**Commands:**

- Rust: `cargo fmt -p bigbud-ssh-owner -- --check`, `cargo clippy --locked -p bigbud-ssh-owner --all-targets -- -D warnings` and `cargo test --locked -p bigbud-ssh-owner <filter>`.
- TS: `bun run --cwd apps/server vitest run <files>`, adding `BIGBUD_TEST_SSH_OWNER_PICKER_PROOF=1` for live runs. Then run explicit-path oxfmt and oxlint, a length check and `bun run --cwd apps/server typecheck`. The ledger notes the typecheck needed an 8 GiB heap once.
- Never run `bun test` or workspace-wide checks without approval.

**Ledger rule:** Each item ends with one ledger entry stating scope, OS/arch, OpenSSH image and version, counts and limits. Test names marked \* are new.

### W0 — Bookkeeping (docs only)

1. Reconcile the plan header with the ledger.
2. Mark the backlog superseded by this plan.
3. Record U1–U12 in the plan's decision record.
4. Apply the §2.2 anchor fixes and counts to cutover design §a, add D1–D5, and close Q2–Q8 there with links to §4.

### W1 — Owner core (parallel with W2 and W3)

1. **X-WIRE.** Freeze production verb names. This is an engineering naming decision, not a product decision. List the mapping `proof_*` → production in the proto comments and goldens. Promotion itself lands in W7.
2. **X-BUD.** Add an additive `ERROR_CODE_SESSION_QUOTA` and an owner `owner/budget.rs`\* wired into `owner_grants.rs`. Reserve interactive capacity. `MaxSessions` maps to quota, never to auth. The budget is a **grant-issuance bound**, not a live concurrent-session count.
   - Tests: `cargo test … budget`_ and `sshOwnerPickerProof.sessionBudget.test.ts`_ (sshd `MaxSessions 2`).
3. **X-RET.** Add a pre-spawn intent row and PID/start-time/namespace binding. Startup refuses on an unresolved intent, and verification is read-only. Any table goes into the **Build A** migration: the mirror is migration **184** `SshOwnerRetirement` (the owner journal remains authoritative).
   - Files: `owner/retirement.rs`_ and `persistence/Layers/SshOwnerRetirement.ts`_ (a focused sibling of the transitions module).
   - Each persistent child has its own `owner.retirement.<kind>.<slot>` record, so multi-leg jump routes never share a slot.
   - Test: `sshOwnerPickerProof.posixOwnerDeathRetirement.test.ts`\* on macOS and Linux.
   - Automatic retirement stays disabled until this passes and the user approves enabling it; the switch additionally requires a validated disposable fixture root.
4. **U3 Windows denial.** Add `ERROR_CODE_WINDOWS_PASSWORD_UNSUPPORTED` across the proto, Rust (`windows_dispatcher`, `windows_password_gate.rs`), the TS codec and goldens. The owner returns it before any credential UI. Web copy: "Use an SSH key for this host."
   - Tests: Rust `windows_password_denial`\*, plus an extended `sshOwnerPickerProof.client.windows.test.ts` asserting no prompt is shown. The native run happens in W6.
5. **U2 keyboard-interactive refusal.** Add `ERROR_CODE_KEYBOARD_INTERACTIVE_UNSUPPORTED`, triggered when the only eligible destination method is keyboard-interactive. Use OpenSSH method config, not prompt text. The password is never released or cached. Add a release-note entry, using the `bigbud-changelog` skill.
   - Test: `sshOwnerPickerProof.keyboardInteractive.linux.test.ts`\* (sshd `AuthenticationMethods keyboard-interactive`), with an OTP negative case.
6. **U1 policy v3 (GSSAPI inert).** Under `crates/bigbud-ssh-owner/src/bin/ssh_owner/config/`, admit `GSSAPIAuthentication yes` only when the policy guarantees GSSAPI is never used (forced `GSSAPIAuthentication no` in the owner's private `-F`). Keep the redacted diagnostic for other GSSAPI directives (`GSSAPIDelegateCredentials`, `GSSAPIKeyExchange`, and so on).
   - Parity fixture: stock Debian 13 config admitted unedited.
   - Negative fixtures: delegate/kex/trust-DNS refused; no GSSAPI method offered (sshd log).
   - Test: `default_policy_v3_tests.rs`\*. Rerun the Debian stock-config case from the ledger.
7. **C03 `subscribeStatus`.** Add a bounded per-subscriber queue with resync. Compose it through `sshMonitor.healthOwner.ts`. Extend `sshOwnerPickerProof.health.test.ts` with a stalled reader.

**W1 status (2026-11-25, second slice; corrected after review).** W1.1, W1.2, W1.4, W1.5 and W1.6 are recorded in the ledger. W1.3 and W1.7 are implemented and validated at the unit plus dev-fixture level:

- **W1.3** uses per-instance records (`owner.retirement.<kind>.<slot>`), so every jump leg and both-hop first-use probes are individually verified and cleared. Startup returns the additive typed `ownerRetirementUnverified` (wire 31) with a redacted remedy; only `bigbud-ssh-owner --retirement-recover --lock <stateDir>/backend.lock --record <name>` can clear a record, and only after read-only proof of absence or PID reuse. Unknown journal names and unreadable records fail closed. **Automatic retirement remains disabled** (`BIGBUD_SSH_OWNER_AUTO_RETIRE=approved-disposable` is ignored unless the validated disposable fixture root matches) pending user approval. **Tracked gap:** Windows has no owner retirement journal yet (the one-shot picker binds no child identity); Windows process-identity/ACL work and native evidence are deferred to W6.
- **W1.7** has the bounded per-subscriber broker with a monotonic publish sequence and abort guard, composition and passing unit plus macOS live evidence. No new wire verb was added; it reuses the existing typed health sample.
- **W1.2** is a **grant-issuance bound**, not a live-session count: one slot per admitted-but-unsettled grant, released on consume/expiry/revoke. The typed quota is fixture-proven; do not read it as a concurrent-session limit.
- **W1.5** the typed keyboard-interactive error is fixture-proven; the product guarantee is that the fixed key/password method configuration never **offers** keyboard-interactive. Deriving the typed error from real destination capability without prompt heuristics remains a tracked follow-up.
- **W1.3 mirror** migration 184 is unreleased and was shape-corrected in place (no shipped artifact contains it); `SshOwnerRetirement.ts` is the focused persistence module.

This does not accept S3, S4 or the whole W1 phase.

### W2 — Consumer tracks (parallel; selected dev domain)

| Track     | Work                                                                                                                                                                                                                                                                             | Key files                                                                                                                                   | Acceptance tests                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| T-files   | Tool transport, session-FS and Copilot as typed verbs; folder create and delete; unguarded writes over 48 KiB                                                                                                                                                                    | `tool-transport/toolTransport.ssh*.ts`, `remoteWorkspaceSessionFsBridge.ts`, `ws/wsSshOwnerDev.workspace*.ts`, `v1.workspace_write.proto`   | `…toolTransport.test.ts`_, `…sessionFs.test.ts`_, `…workspaceFolderOps.websocket.test.ts`\*                  |
| T-term    | Linux PTY; policy adapter by exact lease; `terminalInspect` and profiles; **U6** settings copy in [TerminalLifecycleSettings.tsx](../../apps/web/src/components/settings/TerminalLifecycleSettings.tsx) (direct SSH excluded; remote-agent terminals keep the setting)           | `terminal-host/localTerminalHost.directSsh.owner.*.ts`, `ShellProfiles.remote*.ts`, `Manager.process-drain.remote.ts`, `owner_terminal/`    | `sshOwnerDevTerminal.linux.test.ts`_, `…policyAdapter.test.ts`_, `…terminalInspect.test.ts`_, web copy test_ |
| T-git     | Mutations including discard; accurate untracked counts; **U7** owner-controlled transport for fetch, pull, push, PR and `gh`, including background upstream fetch per the binding in `GitStatus.upstream.ts`; descendant traces; compose `GitCore.initiatingPush.composition.ts` | `GitCore.ssh.selected.ts`, `GitCoreExecutor.ts`, `GitStatus.upstream.ts`, `GitHubCli*.ts`, `git_receive_gate*.rs`, `v1.workspace_git.proto` | `…gitMutation.test.ts`_, `GitCore.initiating.fetch.test.ts`_, `GitHubCli.owner.test.ts`\*                    |
| T-agent   | Normal-startup observation and proxy binding (compose `installedObservation`); `agentAction` install (artifact stdin), status, control; reattach; convert D1–D4                                                                                                                  | `remote-agent/remoteAgent{Install*,Platform,ReadOnlyStatus,Composition*,Diagnostics,LocalControl.approval}.ts`, `v1.agent_proxy.proto`      | `…agentInstall.linux.test.ts`_, `…agentReattach.linux.test.ts`_ (needs E7)                                   |
| T-prov    | Compose Pi and OpenCode v1 owners; Codex sync probe via a typed probe                                                                                                                                                                                                            | `Pi/RpcProcess{,.capabilities,.owner}.ts`, `Opencode/ServerManager{.child,.owner}.ts`, `codexAppServerManager.process.remote.ts`            | `…pi.selected.test.ts`_, `…opencode.selected.test.ts`_, `…codexProbe.test.ts`\*                              |
| T-shell   | `runAcpCommand`, ACP writes; G2 `runThreadShell` and `runProviderWorkspaceShell` (separate grants; no stdin, PTY or env)                                                                                                                                                         | `remoteWorkspaceAcpTerminal*.ts`, `sshShellRunner.ts`, `wsShellDispatch.ts`, `http.threadTools.remoteWorkspace.ts`                          | `…threadShell.test.ts`_, `…providerShell.test.ts`_, `…acpCommand.test.ts`\*, cross-role grant goldens        |
| T-backend | Deployment upload, reset, fetch, publish, start, cancel and unknown; production relay route; load; convert D5                                                                                                                                                                    | `deployment.ssh.owner*.ts`, `clientRelay.{ssh.owner,owner.channel,route}.ts`, `localSupervisorInstaller.ts`                                 | extend `…deployment.test.ts` and `…clientRelay.test.ts`                                                      |
| T-peer    | **U9** `ensurePeerCoordinatorKey` and `inspectPeerHostKey` in the owner; delete TS `ssh-keygen` and `ssh-keyscan` (rows 49, 50; no allowlist); compose `peerRelay.ssh.owner.ts`; **U10** rootful disposable Linux VM fixture, root-UID guard unchanged                           | `peer-orchestration/peer{SshKey,Coordinator.transport,Pairing}.ts`, `remote-backend/peerRelay.ssh*.ts`                                      | `…peerEnrollment.test.ts`_, `…peerRelay.linux.test.ts`_ (rootful VM)                                         |
| T-xfer    | C15 reserved verbs; stream plus supervised child fixture                                                                                                                                                                                                                         | `owner/transfer_fixture.rs`\*                                                                                                               | `cargo test … transfer_fixture`\*                                                                            |
| T-alias   | General profile and alias admission; port 22                                                                                                                                                                                                                                     | `sshOwnerDevRuntime.profileConfig.ts`, `config/`                                                                                            | `sshOwnerDevRuntime.userProfile.test.ts`\*                                                                   |

**W2 exit (= S3 exit):** every C/G row has parity evidence or an approved U1–U3 denial. There is no unclassified path and no unbounded channel. The ledger records cross-cutting cancellation under load and byte-bound evidence.

**W2 status (25 November 2026).** All ten tracks have code in the selected dev domain and are recorded in the ledger. **This is not the W2/S3 exit.** Code-complete tracks with live evidence pending: T-files, T-git, T-prov, T-shell, T-agent, T-backend, T-peer, T-alias. Outstanding items:

- `listAliases` is a TypeScript profile resolver, not a native owner verb; the selected descriptor and every admission decision still come from the owner.
- Live evidence pending for: real Pi/OpenCode binaries, a real ACP session, the 512 KiB and folder-op WebSocket cases, `.git` fetch/pull/PR/`gh pr checkout`, agent install/reattach, the rootful Linux peer relay, real-profile alias admission, live port 22 and IPv6.
- Push is not activated (no trusted approval producer for expected old OIDs); no native owner cancel operation, so cancellation is consumer-signal only with typed `outcomeUnknown`.
- `agentAction` artifacts are 48 KiB per frame; the chunked staging lane is not wired.
- Windows retirement, drain control and native evidence remain open.

The crate is green at this point: 394 owner binary tests (6 ignored), 65 library tests, 8 and 2 integration tests, clean `cargo fmt` and strict Clippy, and 10 protocol golden tests on each side.

### W3 — Cutover machinery (parallel with W2)

1. **X-STRUCT.** Create `protocol/ssh-owner/release-evidence/structural/` with `check.ts`, `verify.ts`, `check.test.ts`, `vitest.config.ts`, `README.md` and `allowlist.json`, following cutover design §e. Under U9 the allowlist covers rows 32, 52 and 55 plus the owner crate only, with no `ssh-keygen`. Negative fixtures cover every deleted row, D1–D5 imports and indirect shapes. The checker runs only on explicit paths.
2. **U5/U8 drain (Build A side).** A drain-on-quit runs in this order:
   1. Monitors, relays and providers stop.
   2. A **pane-listing consent dialog** offers "save and close" or "drain now". **Cancel aborts the upgrade** and leaves A running.
   3. Drained panes are marked closed with no respawn.
   4. `ssh -O exit` runs for A's own masters.
   5. One transaction writes the retirement record and the `sshLegacyRetired` marker, then checkpoints the WAL and releases the lock.

   Files: terminal manager, legacy teardown under `apps/server/src/ssh/`, web dialog component (one component per file), and the A migration.

   Tests: `sshOwnerPickerProof.legacyPtyDrain.test.ts`_, `legacyRetirementMarker.test.ts`_, and a browser test for the dialog where Cancel blocks\*.

3. **U12 X2 host verb (Build A).** Add `inventory` and `retireSshSpawn` to the native terminal-host protocol, and to the legacy host launcher (`localTerminalHost.launch.ts`). B uses the verb. If the verb is not shipped in A, B **requires host exit**, which drains non-SSH panes too, with the same consent dialog.
   - Test: `localTerminalHost.retireSshSpawn.test.ts`\*.
4. **U12 R systemd.** Add a unit `ExecStop` that runs A's drain before graph replacement. Followers drain through the coordinator.
   - Files: `apps/server/src/cli/cli.backend.operations.ts` and the unit template.
   - Test: `cli.backend.drainOnStop.test.ts`\*.
5. **U11 CLI lock.** Audit `apps/server/scripts/cli.ts` and `src/cli/*` subcommands that open the DB directly. Each must hold `startup/stateDirLock.ts`'s `backend.lock` or delegate to the running backend.
   - Test: `cli.stateLock.test.ts`\* covering competing startup.
   - `SSH_AUTH_SOCK` from `syncShellEnvironment.ts` (row 52) feeds the owner's agent policy on D and V only. On N and R the profile env is used. The test asserts N/R never import it.
6. **B startup refusal.** When the marker is missing, B refuses with `legacyEntryFenced` and offers an explicit drain action.
   - Test: `server.sshOwner.startupRefusal.test.ts`\*.
7. **Production `configureSshOwner`.** Prepare it on an unmerged B branch only (cutover design §f).

**W3 status (2026-11-25, third slice).** W3.1, W3.2, W3.3 and W3.5 are implemented and validated at the focused unit plus browser level; W3.4 is implemented at the CLI/unit-template contract with its production drain hook still typed unavailable; W3.6 composition and W3.7 remain open.

- **W3.2 / U5/U8 drain-on-quit core.** `sshLegacyDrain.ts` runs only for `installer`, `updater` or `cli-for-upgrade`: stop monitors, relays and providers; list panes; show the consent contract; close the recorded direct-SSH panes (and remote-agent panes unless U6 keep mode preserves them) with no respawn; run `ssh -O exit` for only the masters recorded by this process; write the retirement record and `sshLegacyRetired` marker in one transaction; checkpoint the WAL; then release the lock. Cancel writes no marker and releases nothing; every pre-commit failure leaves the lock held and no marker. Migration **185** adds the record and marker to the Build A ceiling after 184 (184 is unchanged). The web consent component lists thread/pane identity and exposes only Cancel, Save and close, and Drain now, with retry after a list error. **Not yet composed** into the installer/updater entry or the systemd `ExecStop` (W3.4); no product path invokes it.
- **W3.6 / B startup refusal core.** `readSshOwnerStartupState` reads the marker and record before any owner start; a missing marker fences SSH with the typed `legacyEntryFenced/retirement-marker-missing`, a non-empty pending list fences with `legacy-panes-pending`, and a missing owner after a valid marker reports `sshOwnerUnavailable` (distinct from a schema-too-new refusal). `startSshOwnerAfterLegacyGate` never evaluates the owner start on refusal, and `drainIdentified` is an explicit UI action. The production B composition lands with W3.7.
- **W3.3 / X2 host verbs.** Protocol 1.10 adds `terminal_host_inventory_{request,response}` (frames 128/129) and `terminal_host_retire_ssh_spawn_{request,response}` (130/131), capability `terminal.host-retirement` v1. Inventory is bounded to 64 panes and returns exact lease identity, local/managed-SSH kind, thread/pane identity, the host artifact id and per-pane retirement eligibility. `retireSshSpawn` is all-or-nothing: every lease must be an exact live managed-SSH pane of the expected epoch and build; then the host durably writes its retirement marker, refuses new managed-SSH creates (`SSH_SPAWN_RETIRED`) and keeps serving non-SSH panes. An older host without the capability is reported `terminalHostRetirementUnsupported`; B must then require host exit, never infer retirement. TS and Rust tests cover inventory, exact leases, unsupported hosts, tampered/foreign leases and bounded/oversized responses.
- **W3.4 / systemd `ExecStop` and backend drain endpoint.** The deployed backend unit renders one `ExecStop` that runs `--backend-service drain` before `ExecStopPost`; the Rust action invokes the installed CLI `backend stop --for-upgrade`. The CLI reaches an authenticated same-user Unix-socket control endpoint (0600 socket/token, bounded 8 KiB single request). The live handler is registered under the held lock: it enumerates live panes from the terminal manager (local, direct-SSH, remote-agent with keep mode), publishes UI consent, runs the existing W3.2 core in order, commits the record+marker, checkpoints WAL and requests backend shutdown so the lock is released for the upgrade. Non-interactive consent uses `--i-have-saved-my-work`; no UI and no flag returns `consent-required`. Cancel/timeout returns `cancelled` before any close, master exit or marker. A second concurrent drain returns `busy`; unknown artifacts and foreign tokens are refused. Offline drain is permitted only with proof of zero live panes (`planOfflineDrain`); otherwise it refuses with `offline-panes-unknown`.
- **W3.4 / WebSocket consent and coordinator drain.** The pending snapshot is now published over authenticated WS with bounded typed contracts (`server.getBackendDrainConsent`, `server.decideBackendDrainConsent`) and the root-mounted dialog host. Reconnect reads the same snapshot; exactly one decision wins; late/duplicate/unknown drains and unauthenticated routes are refused. The peer coordinator now exposes `drainFollowers` through the real cancel path, and the live handler calls it before the core when a coordinator exists. **Remaining:** monitor/relay/provider stop effects are logging placeholders (the following shutdown performs the real teardown); real unit installation, a real upgrade run, a real coordinator run and the installer/updater hook remain written-not-run; Windows drain control remains unsupported.
- **W3.7 (production `configureSshOwner`) remains open**, along with W4–W7. Until W3.4's production hook lands, B's host-exit requirement and the unsupported-host fallback remain the safe paths.
- **Not run here:** installer/updater-driven drain, CLI `stop --for-upgrade`, systemd `ExecStop`, and the real B startup path.

- **W3.1** adds `protocol/ssh-owner/release-evidence/structural/` with the five source-shape rules, reviewed allowlist (keep rows 32, 52, 55 and the owner crate; no `ssh-keygen` entry), negative fixtures for every deleted row, D1–D5 and indirect shapes, and an explicit-path CLI. **The checker is structural-only** (`structuralOnly: true`, `s4Accepted: false`). It cannot detect Git/`gh` → `ssh`, OpenSSH `ProxyCommand`/`ProxyJump` helpers or `LocalCommand`; the [cutover trace checker](../2026-11-23-rust-ssh-ownership-s4-cutover-design.md#e-structural-zero-bypass-checker) remains required for S4.
- **W3.5** makes all three direct-database CLI commands (`canonical-thread-cleanup`, `canonical-event-compaction`, `legacy-orphan-recovery`) hold `backend.lock` for dry-run and `--apply` before the database or migrations open, with scoped release. Delegating commands (`backend`, `mobile`, `peer`, `remote-agent`, `command-line`, root server) are classified. `SSH_AUTH_SOCK` import is explicit for D/V only; N/R request and assign no value, and the owner's SSH children clear the ambient environment. **No product SSH path was promoted and automatic retirement was not enabled.**

### W4 — Build A release

Build A contains the legacy TS executor only. It also ships:

- migration 181, the W1.3 retirement mirror (migration 184), the W3.2 legacy retirement record/marker (migration 185) and the W3.2 tables (frozen schema ceiling). Migration 184 is unreleased, so its DDL comment/constraint were shape-corrected in place; if any A artifact has already been distributed with 184, add a new migration instead of editing it.
- drain-on-quit with consent
- the host verb
- the systemd `ExecStop`
- the CLI lock

Record A's artifact IDs. Gate: a schema-ceiling review.

### W5 — Packaging for B (parallel)

Stage and verify the owner in `release-desktop-build.yml`, `release.yml`, `release-remote-backend-graph.yml`, `apps/server/scripts/cli.ts` and `scripts/verify-packaged-ssh-owner.ts`. Wire N discovery via `sshOwnerExecutable.ts`.

**U4 matrix scope:**

| Profile | Cells                                         |
| ------- | --------------------------------------------- |
| N       | Linux x64/arm64, macOS arm64/x64, Windows x64 |
| R       | Linux x64/arm64                               |

Windows arm64 for N is unsupported in v1. Update `release-evidence/matrix/catalog.ts` and the ledger's deferred N row to match.

### W6 — Pre-cutover qualification (needs W4, W5, a B candidate and E1–E8)

Run every deferred ledger row on release-trusted inputs:

- the actual pre-A→A→B→A→B lifecycle on the same DB/WAL
- an upgrade with a live relay, terminal and monitor, using the consent dialog
- a relaunch of every legacy entry
- Electron
- port 22
- Windows: key, ConPTY, and the U3 denial before credential collection

Feed the `matrix/`, `rollback/`, `forward/` and `cutover/` checkers.

### W7 — S4 activation (one change set; needs W2, W3 and W6)

1. Promote the frozen production verbs (W1.1).
2. Apply cutover design §f: delete rows 1–51, D1–D5 legacy types, `sshOwnerDevMode.ts` and the selectors.
3. Run the structural checker on the changed files and the `cutover/` B traces, expecting zero outside-owner launches.
4. Run the crash and version-mismatch fixtures.
5. Write the S4 accepted record. Only after that, hand off transfer M0.

**Critical path:**

1. W1.3 (retirement) and W3.2–W3.5 (drain, host verb, systemd, lock) feed the Build A schema and behavior.
2. W4 ships Build A.
3. W6 qualifies, gated on E1–E8.
4. W7 activates.

Run the W1 and W2 tracks in parallel. T-agent waits on E7. T-peer needs the rootful VM (U10).

## 4. User decisions (accepted 2026-11-25)

All twelve decisions are recorded below (W0.3): U1–U12, each mapped to its work item. There is no open product decision.

| #   | Decision                                                                                                               | Work item       |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| U1  | Debian stock `GSSAPIAuthentication yes` admitted as inert under versioned policy v3, with parity and negative fixtures | W1.6            |
| U2  | Keyboard-interactive is unqualified: typed refusal, no cached password, release note                                   | W1.5            |
| U3  | Windows ships key-only, with `windowsPasswordUnsupported` returned before collection                                   | W1.4, W6        |
| U4  | N: Linux x64/arm64, macOS arm64/x64, Windows x64 (no Windows arm64). R: x64/arm64                                      | W5              |
| U5  | Drain at cutover with notice and consent; no survival guarantee                                                        | W3.2            |
| U6  | Remote-agent terminals keep honoring keep mode; settings copy names the direct SSH exclusion                           | W2 T-term       |
| U7  | Product Git and `gh` use an owner-controlled transport; unported verbs stay refused                                    | W2 T-git        |
| U8  | Pane-listing consent dialog; Cancel blocks the upgrade                                                                 | W3.2            |
| U9  | `ensurePeerCoordinatorKey` moves into the owner; no `ssh-keygen` allowlist entry                                       | W2 T-peer, W3.1 |
| U10 | Rootful disposable VM fixture for Linux C14; helper guard unchanged                                                    | W2 T-peer       |
| U11 | `backend.lock` held by every DB-opening CLI subcommand; `SSH_AUTH_SOCK` only on D/V                                    | W3.5            |
| U12 | systemd `ExecStop` drain; terminal-host `inventory`/`retireSshSpawn` in Build A, otherwise B requires host exit        | W3.3, W3.4      |

## 5. External prerequisites

| #   | Prerequisite                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------ |
| E1  | Signed and notarized macOS arm64 and x64 DMG A/B pairs; clean GUI accounts or VMs                                  |
| E2  | Linux x64 AppImage A/B pair (plus `.deb` if supported); clean Linux x64 GUI runner                                 |
| E3  | Windows x64 NSIS A/B pair with recorded Authenticode mode; native Win10 22H2 (inbox 8.1p1) and Win11 inbox runners |
| E4  | npm tarball identity, digests and native closure for each U4 N cell; a clean host                                  |
| E5  | Signed R Linux x64 and arm64 graph archives, manifests and provenance; clean systemd runners                       |
| E6  | Disposable sshd on live port 22 for each environment                                                               |
| E7  | Verified Linux workspace-agent bytes from the release pipeline                                                     |
| E8  | A rootful disposable Linux VM (U10) and reviewers for the S4 record                                                |

## 6. Risks

| Risk                                                                                             | Mitigation                                                                  |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| The Build A schema or behavior misses something B needs (retirement table, marker, host verb)    | Freeze it at W4 through the schema and behavior review; no B-only migration |
| Retirement design fails review                                                                   | S4 stays blocked                                                            |
| Concurrent edits move anchors and add callers (HEAD just added Files folder ops and Git discard) | Repeat the §2.2 recount at W0 and at the W7 diff                            |
| The U1 inert admission accidentally enables GSSAPI                                               | Negative fixture asserting no GSSAPI method in the sshd log                 |
| U2 detection relies on heuristics                                                                | Decide from method config only; OTP negative case                           |
| Structural checker false negatives                                                               | Always paired with `cutover/` traces                                        |
| Server typecheck heap exhaustion                                                                 | Document the 8 GiB heap in COMMANDS if it becomes needed regularly          |
| Rollback                                                                                         | Offline only (cutover design §d)                                            |

## 7. Definition-of-done checklist

| Criterion                                                           | Evidence                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| AC1 isolated real lifecycle first                                   | Ledger S1 review (dev scope); reconfirmed on B in W6                                                 |
| AC2 all consumers together, no TS SSH, denials documented           | W2 exit; W7 single change set; structural and `cutover/` zero bypass; U1–U3 errors and release notes |
| AC3 no stale resurrection or replay; missing owner means local-only | S2 transitions rerun on B; X-RET; W7 crash and version fixtures; W6 A/B lifecycle                    |
| AC4 transfer consumes only the owner contract after S4 accepted     | C15 fixture; S4 record with protocol, capabilities, errors, limits and artifacts                     |

## 8. Validity and handoff

- **Basis:** `dev@a259080c62` with 668 dirty entries. Revalidate if any of these change: the plan or ledger, `protocol/ssh-owner/*.proto`, `sshOwnerDev*.ts`, the release workflows, migrations, or the §2.2 files.
- **Settled:** the plan's decision record, the §3 global rules and U1–U12.
- **Blocking "Ready":** commitments for E1–E8 only.
- **Start with:** W0, W1.1–W1.7, W3.1 and W3.5, plus the T-files, T-term, T-prov, T-shell, T-backend, T-xfer and T-alias tracks.
