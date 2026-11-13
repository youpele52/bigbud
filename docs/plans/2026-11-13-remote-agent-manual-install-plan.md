# Remote agent installation, persistence and orchestration

**Date:** 13 November, 2026 (decisions recorded the same day)
**Status:** Proposed — implementation design specified for all eight phases; runtime validation pending
**Owner:** Unassigned

## Summary

Let a user, or an agent acting for them, install or replace the bigbud remote agent without
depending on the in-app consent dialog succeeding. Three routes are planned, sharing one
server-side install transaction:

1. **Remote-side manual placement.** The user downloads the agent on the remote machine with a
   published script. bigbud then registers and activates those bytes without uploading anything.
2. **Local CLI.** `bigbud remote-agent install <target> [--replace]` runs the existing install
   transaction through the running backend.
3. **Agent tool.** The same operation is exposed as a bigbud capability so agents can request it.

A static Linux build and honest error reporting are included because they remove the most likely
reasons the automatic install fails today.

Subsequent phases in this same plan harden persistent terminals, introduce Rust-owned persistent
provider sessions, and then add remote orchestration. They do not block independent delivery
of the installation phases. No implementation or provider compatibility is implied by this roadmap.

## Related Work

- Bigbud note or Kanban card: None identified. This plan came from a chat investigation on
  13 November, 2026.
- Prior remote agent investigation: [remote-agent-0.2.205-upgrade.md](./remote-agent-0.2.205-upgrade.md).
- Reference design: herdr-core machines documentation,
  <https://github.com/herdrdev/herdr-core/blob/master/docs/machines.md>.

## Problem

The automatic install often fails, and the user cannot tell why or work around it.

Observed facts:

- The published release is healthy. `remote-agent-install-source.json` for v0.3.3 downloads,
  parses and verifies its signature with the current shared artifact module. Both Linux binaries
  are present.
- The published x86_64 agent is dynamically linked and requires `GLIBC_2.34`. It cannot run on
  Ubuntu 20.04, Debian 11, RHEL/Rocky/Alma 8, Amazon Linux 2 or Alpine. The release job builds
  glibc targets on `ubuntu-22.04` (`.github/workflows/release.yml:144-147`).
- The install uploads the whole binary as base64 through one SSH command with a 60 second limit
  and truncated output (`apps/server/src/remote-agent/remoteAgentInstall.ts:174`, `:231-233`).
- The install script needs GNU `stat -c`, `sha256sum`, `flock`, `readlink -f`, `sync -f` and
  `install -d`. It aborts when an existing directory under `~/.bigbud/agent` is not mode 700.
- Every SSH failure becomes "The SSH setup command failed (exit N)" and remote stderr is dropped
  (`apps/server/src/remote-agent/remoteAgentFailure.ts:4-6`).
- The remote keeps at most two build payloads. When both slots are occupied and the predecessor
  cannot be safely retired, installation stops with a capacity error
  (`apps/server/src/remote-agent/remoteAgentInstall.capacity.ts:22`, `:42`).
- Install is reachable only from the UI dialog through the `server.installRemoteAgent` RPC
  (`apps/server/src/ws/wsExecutionTargetVerification.ts:99`). It stages the build only; activation
  happens on the next connection (`:125`).
- No supported manual route exists. An undocumented legacy adoption path accepts an executable at
  `~/.bigbud/agent/bin/current` on a remote with no registered current build. It pins the adopted
  build to `unknown-legacy-owner` (`apps/server/src/remote-agent/remoteAgentLegacyBinding.ts:169`),
  which can block later retirement. It must not be documented as the manual route.

Hypothesis, not yet proven: the glibc floor is the most common failure on real servers. Phase 1
must capture real error output to test this hypothesis; static-build work does not depend on
proving it is the most common cause.

## Goals

- A failed install reports the real remote cause in the app and the CLI.
- A user can place the agent on the remote by hand and bigbud adopts it as a normal managed build,
  with signature-backed trust, no upload, and no legacy pin.
- A user or agent can run one command that installs, or replaces, the agent for a target.
- Replacing an existing install retires the old build when it is safe, and reports clearly when
  retirement is deferred because live work still uses it.
- The released agent runs on any supported Linux distribution regardless of glibc version.

- Later phases: remote terminal work and supported provider turns survive laptop disconnection,
  and the normal bigbud UI catches up when reconnected.
- Eventually, explicitly enabled remote workflows continue without the laptop.

## Non-Goals

- macOS or Windows remote hosts.
- Installing an agent whose bytes do not match a signed release manifest, except through the
  existing explicit development-artifact setting.
- A remote-side download script that writes the installation registry. Authorized desktop
  backends coordinate installation-registry mutations through remote CAS; Rust owns separate
  runtime/session/provider state. These state domains must not share an ambiguous writer.
- Killing live remote terminals or processes to force a replacement.

## Current State

- Install transaction: `makeRemoteAgentInstallManager().install`
  (`apps/server/src/remote-agent/remoteAgentInstallManager.ts:196`). It resolves the artifact,
  downloads bytes on the desktop (`:209`), reserves a registry stage (`:215`), uploads and checks
  (`:246`), then publishes the stage.
- Remote layout: `~/.bigbud/agent/bin/<version>/<sha256>/bigbud-remote-agent`, mode 700, owned by
  the account. The upload script is already idempotent when identical bytes exist at that path
  (`apps/server/src/remote-agent/remoteAgentInstall.ts:179`).
- Trust: artifacts are selected from the signed manifest and checked by size and SHA-256 before
  use. The candidate is executed with `--check` and its identity is compared with the manifest.
- Supported targets are hardcoded to the two glibc triples
  (`packages/shared/src/remoteAgentArtifact.ts:5`, `:48-51`, `:98`).
- The server CLI already has subcommands (`apps/server/src/cli/cli.ts:332-343`) and ships as the
  `bigbud` binary (`apps/server/package.json`).

## Decisions

These were agreed with the user on 13 November, 2026. They follow herdr's design, which was
checked against herdr-core's `docs/security.md` and `docs/machines.md` and its published
`releases.herdr.dev/core/install.sh` and `releases.herdr.dev/app/install.sh`.

### D1: The CLI reaches the backend through an owner-only local socket

- The backend opens a dedicated Unix domain socket inside a mode 700 directory under the state
  directory. On Windows it uses a named pipe whose access rules allow only the current account.
- No secret is written to disk. The trust boundary is the user's OS account, as in herdr, whose
  core uses an account-only socket and has "no separate API password or per-client permission
  check".
- The socket accepts only remote-agent operations: `status`, read-only `doctor`, `install` and `install --replace`.
  It is deliberately separate from the backend lock's existing control port and secret, which
  can shut the backend down.
- Agents running inside bigbud threads do not use the CLI. They call a capability tool, which
  already has per-thread authentication through `ThreadOrchestrationToolAuth.ts`. The CLI serves
  people and agents running outside bigbud.
- Rejected: reusing the lock file's control secret, because it grants shutdown authority. Rejected:
  a token file for the WebSocket RPC, because it puts a full-access credential on disk.

### D2: A `bigbud` launcher is placed on PATH the herdr way

- The launcher goes into `~/.local/bin/bigbud` on macOS and Linux. It is created only when no
  other `bigbud` command exists, matching how herdr creates `hc` only when none exists.
- Shell startup files are never edited. When `~/.local/bin` is not on PATH, the user is told to
  add it, as herdr's installers do.
- Two entry points create it: a Settings action named "Install command-line tool", and the
  existing desktop install script.
- The launcher runs the server CLI already bundled in the app, so nothing extra is downloaded.
  On Windows the installer adds it to the user's PATH.

### D3: The remote install script lives on bigbud.app and pins the selected artifact

- The script is served from `https://bigbud.app/remote-agent.sh`. Binaries and the signed manifest
  stay on GitHub releases. The same script is also attached to every release so older app
  versions keep a matching copy.
- The remote agent must satisfy negotiated protocol/capability compatibility; exact app-version
  equality is not required for every connected client. The script takes `BIGBUD_AGENT_VERSION`
  from the verified selected artifact. When
  an install fails or a user chooses manual install, the app shows the exact command with the
  version already pinned and a copy button, the way herdr shows "what to run in your own
  terminal" for steps that need a person.
- Like herdr's installer, the script reads the release manifest, verifies the download's SHA-256,
  stages bytes in a private inbox, and reports failures plainly. The app verifies signature-backed
  identity before executing the candidate; the script does not execute downloaded bytes.
- The website's install button stops fetching scripts from the repository's `main` branch on
  raw.githubusercontent.com and points at bigbud.app instead.

### D4: glibc builds are dropped after one transition release

- The first release with static musl builds also ships the glibc builds, so app versions that only
  recognise glibc targets still find a match.
- The following release ships musl builds only. Its manifest, release workflow stop producing glibc triples. The shared parser retains historic triple
  compatibility for pinned releases and cleanup, while new selection prefers musl.
- Remotes still running a glibc build are moved to musl by the normal automatic update, because
  the new build has a different digest.

### D5: The CLI skips consent for hosts already approved in the app

- No per-host consent record exists today. The in-app dialog asks before the first install, and
  the automatic update coordinator then upgrades known hosts without asking again.
- "Already approved" is derived from existing state, without new storage. A host counts as
  approved when it is a saved remote project whose connection method is the bigbud remote agent,
  or when its remote registry already holds a managed build.
- For an approved host, `bigbud remote-agent install` and `--replace` run without a prompt.
- For any other host, the CLI asks interactively. In a non-interactive shell it refuses unless
  `--yes` is passed, matching herdr's `--install` flag for scripts.
- The capability tool follows the same rule, so an agent never installs on an unapproved host
  without the user's consent in the thread.

### D6: The app owns clean installation and replacement, with a manual VPS fallback

- The app must offer Install, Update/Replace and Copy remote command actions for a remote VPS.
  Manual commands are available proactively as well as after a failed automatic operation.
- App installation and replacement use the same transaction as the CLI: verify, stage, connect,
  activate, then retire unused builds. Repeating an operation for the same build is safe.
- The copyable command runs in the VPS terminal and pins the artifact version selected by the
  app. It supports both a fresh install and staging an update to an existing managed install.
- Under the coordinated desktop-writer design, the remote script stages bytes only. Its output and
  the app must explicitly say to return to bigbud and choose Finish install/update to register
  and activate them. Downloaded or staged must never be presented as an active update.
- Failed downloads, verification failures and interrupted staging preserve the working build.
  Concurrent script and app operations must not overwrite a running binary or publish partial
  bytes; use temporary files and coordinated publication of verified immutable build paths.
- Report separately whether the new build is active and whether old-build cleanup is deferred.
  Live work is never killed to make replacement succeed.

### D7: Rust owns remote execution and persistence

- Keep persistent provider sessions and remote orchestration as later phases of this plan.
- Rust is the preferred owner of remote process lifecycles, durable session events, pending
  approvals and eventually remote workflow state. TypeScript services provide the connected
  application experience and communicate with that owner while the laptop is available.
- Connection changes do not transfer session authority back to the laptop. Define one writer
  for each state domain; the installation registry remains desktop-owned under D6 unless a
  future explicit migration changes that contract.
- User approval waits only while the provider request remains valid. Laptop-only tool calls
  return a typed unavailable response while disconnected; a workflow may then wait for explicit
  continuation. Never silently approve, rerun the call, or promise all work continues offline.
- Audit provider protocols individually. Small SDK helpers remain possible where required;
  a remote TypeScript backend or a rewrite of all providers is not a prerequisite.
- Grow incrementally with bounded storage and measured resource costs. A shared local/remote
  Rust runtime is a future investigation, not a requirement for these phases.

## Phases

### Phase 1: Report the real failure

Goal: make every install failure diagnosable before changing behaviour.

- Capture a bounded, control-character-stripped tail of remote stderr for install, check and
  platform probe commands. Changed `outputMode` for those commands so stderr is retained.
- Map known failures to plain messages: glibc version too old, missing GNU tool, directory
  permission mismatch, upload timeout, capacity deferred, unsupported platform.
- Add a pre-flight probe that reports `ldd --version`, required tool presence and existing
  directory modes before uploading.
- Keep scripts and tokens out of user-visible messages, as the current sanitiser intends.

Files: `remoteAgentFailure.ts`, `remoteAgentInstall.ts`, `remoteAgentPlatform.ts`, new
`remoteAgentInstall.preflight.ts`.

Exit: a failing install against a glibc 2.31 container shows a message naming the glibc floor.

### Phase 2: Static Linux build

Goal: remove the glibc floor.

- Add `x86_64-unknown-linux-musl` and `aarch64-unknown-linux-musl` to the release build and the
  signed manifest. Kept the glibc assets for one transition release so older clients still find a
  match, then removed them in the next release, as decided in D4.
- Extend the shared target triple type, resolver and validator to prefer musl when present.
- Verify in CI that the agent builds, passes its Rust tests, and runs `--check` on Alpine,
  Debian 11 and Rocky 8 containers.

Decision gate: the agent's file locking, PTY and process code must pass its existing Linux tests
under musl before the manifest prefers musl.

### Phase 3: Adopt pre-placed bytes

Goal: make manual placement a first-class install route that reuses the managed transaction.

- Before uploading, probe the managed build path. When an owned, mode 700 file with the expected
  size and SHA-256 exists, skip the download and upload. Otherwise inspect the manual inbox
  before downloading. Reserve capacity and publish trusted bytes before the normal identity check.
- Publish `remote-agent.sh` on bigbud.app and as a release asset, as decided in D3. It
  detects the architecture, reads the release manifest for `BIGBUD_AGENT_VERSION`, downloads the
  matching binary, verifies its SHA-256, and places it in the private inbox specified below with
  mode 700. The app performs trusted promotion and `--check`. It prints the next step. It never touches the registry or the `current` link.
- Add Install, Update/Replace and Copy remote command actions in the app, including failure
  recovery. Commands are version-pinned and usable on fresh and previously installed VPS hosts.
  Provide Finish install/update for manual staging, with the explicit activation boundary in D6.
- Trust is unchanged: bigbud only promotes bytes whose hash matches the signed manifest.

Exit: on a fresh container, running the script and then the app's Install performs no upload and
reaches a ready connection.

### Phase 4: Install and replace from the CLI

Goal: one command for users and agents.

- Add `bigbud remote-agent status <target>` and `bigbud remote-agent install <target>
[--replace] [--yes]`.
- The command talks to the running backend through the owner-only socket from D1, so the
  registry mutations coordinate across backends and each local connection pool has one owner. If no backend is running, it fails
  with a clear message instead of writing state.
- Add the PATH launcher from D2 through a Settings action and the desktop install script.
- Install performs stage, connect and activation in one call, rather than stopping at "staged".
- `--replace` retires non-current builds through the existing retirement flow after activation.
  When the new build is active but old work pins the predecessor, report active with cleanup
  deferred. Report replacement deferred only when activation itself cannot complete.
- Consent follows D5. Approved hosts install without a prompt. Unapproved hosts are asked, and
  non-interactive runs need `--yes`.

Decision gate: the launcher must be proven to start the bundled server CLI from the packaged app
on macOS, Linux and Windows before the Settings action ships.

### Phase 5: Agent capability

Goal: let agents request install or replacement.

- Expose `remote_agent.install` and `remote_agent.status` as bigbud capability tools that call
  the same server operation as the CLI. They authenticate with the existing per-thread tool
  credential, not the CLI socket, as decided in D1.
- Apply the D5 approval rule. Unapproved hosts require explicit user consent in the thread.

### Phase 6: Harden persistent terminals and reconnection

Goal: leave terminal work running and reattach predictably. Depends on reliable installation
and replacement from phases 1–4; phase 5 can ship independently.

- Audit existing supervisor, PTY ownership, replay and shutdown behavior before extending it.
  Reconcile the existing remote disconnect and recovery plans with this phase.
- Define Detach versus Stop, reconnect backoff, authentication recovery and discovery after
  restarting the local backend. Never retry an uncertain process launch blindly.
- Bound output, logs, retained sessions and disk consumption; report replay gaps explicitly.
  Add status/doctor diagnostics for versions, active work and actionable connection failures.
- Preserve live work during updates by deferring activation or retirement when necessary.
  Surviving a remote reboot or supervisor crash is distinct from surviving a client disconnect.

Likely modules: `crates/bigbud-remote-agent/src/supervisor`, `src/pty`,
`apps/server/src/remote-agent`, and the web terminal controls. Use these existing boundaries and the concrete contract below.

Tests and exit: network loss, app closure and local backend restart leave supported terminals
running and reattach correctly; Stop terminates the intended work; noisy output stays bounded.
Test Linux remote hosts with macOS, Linux and Windows clients. Record unsupported cases.

### Phase 7: Rust-owned persistent provider sessions

Goal: turns for every supported provider continue remotely while the laptop is disconnected, and
bigbud's normal chat catches up. Depends on phase 6 and the implementation contract below (all-provider scope below).

- Audit all current provider adapters for process/network protocols, SDK dependencies, tool
  callbacks, credentials, attachments and approval timeouts. Implement the complete provider matrix in the expanded design below.
- Compare a durable Rust protocol bridge with Rust-owned provider logic and narrowly scoped SDK
  helpers. Keep event interpretation in existing TypeScript adapters where practical, but move
  every dependency required for offline progress to the remote side.
- Specify stable session and command IDs, ordered durable events, acknowledgement/replay cursors,
  cancellation, pending approvals and compatibility negotiation. Deduplicate retries; reconcile
  uncertain outcomes instead of claiming exactly-once external effects.
- Define event retention, snapshots or explicit replay-gap recovery, disk-full behavior, secret
  handling, remote credential setup and attachment transfer before execution.
- Give the remote runtime authority over its sessions. TypeScript maintains a synchronized view;
  reconnect must not create another turn or answer an approval twice. Use one mutation-controller lease
  per session with multiple viewers, explicit takeover and generation fencing.
- Make unsupported laptop-only callbacks visibly wait or fail with a recoverable explanation.
  Verify provider timeout behavior rather than assuming approvals can wait indefinitely.
- Introduce versioned state and protocol changes with an opt-in rollout. Keep existing sessions
  on their original execution path; rollback must not replay or migrate live work automatically.

Likely modules: Rust agent and protocol crates, server provider adapters and remote-agent layer,
server orchestration persistence, and web conversation/recovery UI. Use the expanded implementation design below; current adapters are TypeScript, not existing
Rust integrations.

Tests and exit: start a real provider turn, disconnect and close the laptop app, reconnect and
recover ordered chat/tool events and final status. Cover pending approval, cancellation,
duplicate commands, lost acknowledgements, disk exhaustion, version mismatch and remote crash.
Remote crash/reboot recovery may report interruption; it must not claim the original process
survived. Measure download size, idle memory, CPU and retained disk use before expanding support.

### Phase 8: Remote workflow and multi-agent orchestration

Goal: explicitly enabled workflows continue beyond a single provider turn without the laptop.
Depends on phase 7 proving reliable session ownership and the implementation contract below (multiple-host/controller scope below).

- Move only the required scheduling, task dependencies and child-session coordination into Rust.
  Reuse existing contracts and migrate ownership explicitly to avoid competing local schedulers.
- Persist workflow decisions, cancellation and completion; recover partial steps without
  duplicating child work. Define concurrency, resource and retry budgets.
- Route approvals and unavailable laptop capabilities into explicit waiting states. Keep remote
  authorization scoped to the user's workflow; connectivity must not expand permissions.
- Expand provider support only after provider-specific acceptance tests. Evaluate shared local
  Rust services incrementally if that removes duplication without disrupting existing behavior.

Likely modules: Rust runtime/protocol, server orchestration and orchestration tools, provider
integration and workflow UI. Extraction and migration boundaries are specified in the implementation contract below.

Tests and exit: a bounded multi-step workflow with child work continues offline, reconciles
correctly on reconnect, respects approvals and cancellation, and avoids duplicate scheduling
under reconnects and restart recovery. Rollback disables new remote workflows while preserving
inspection and safe handling of existing ones. Do not migrate active workflows implicitly.

## Implementation Contract (13 November Code Review)

This section resolves technical choices for all phases and takes precedence over earlier
high-level phase wording. The expanded implementation design at the end further specifies and
supersedes any narrower provider/controller assumptions here. Product scope decisions P1/P2 below supersede the narrower initial design. Proposed files
are new unless explicitly described as existing. No runtime tests were executed for this plan.

### Evidence and corrections

- `remoteAgentInstallManager.ts` resolves and verifies artifacts, downloads before staging, and
  returns `staged`. Move remote-byte discovery before `readArtifactBytes`, but retain signature
  verification before any remote execution. Its in-memory lock alone does not coordinate scripts.
- `remoteAgentInstall.orphan.ts` can reclaim unregistered managed-layout payloads. Therefore
  manual downloads must use a separate inbox, not the managed `bin` tree. This supersedes the
  earlier manual-placement path, not the user's manual-install requirement.
- `remoteAgentInstall.activation.ts` explicitly contains retired legacy helpers. Use
  `remoteAgentUpdate.coordinator.ts`, `remoteAgentUpdate.prepare.ts` and admission instead.
  Preserve registry CAS and its `control/registry.lock` synchronization.
- Rust `supervisor/core.rs` removes connection subscribers on disconnect while spawned jobs
  remain independently owned. `pty/core.rs` bounds output at 4 MiB; `pty/handle.rs` also limits
  retained chunks. `operations/journal.rs` has a 64 MiB journal and restart interruption semantics.
  Preserve these guarantees; a durable journal does not preserve a live process after reboot.
- `codexAppServerManager.process.remote.ts` currently spawns `codex app-server` through SSH.
  `OrchestrationEngine.commandProcessing.ts` uses local SQL command receipts and event commits.
  Neither establishes Rust-owned persistent provider sessions or remote workflow scheduling.
- Current provider integration paths: Codex uses app-server; Pi uses `--mode rpc`; Cursor and
  Devin use ACP; Claude and Copilot use JavaScript SDK integrations; OpenCode uses its SDK/server;
  Muse exposes an SDK-backed MSP transport; CLI proxy shares Claude integration machinery;
  OpenCode V2 has explicit preview restrictions. These are code observations, not certification
  that their protocols all support offline persistence. Every supported provider needs its own persistence acceptance coverage before phase 7 is complete.
- Official [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) describes
  structured thread/turn operations, events and approval requests. Pin a supported CLI version
  and generate protocol fixtures from it during implementation; do not infer timeout guarantees.

### Phases 1–3: precise installer transaction

1. Add `remoteAgentInstall.preflight.ts` and focused fixtures. Capture at most 8 KiB sanitized
   stderr; redact known credentials, remove terminal controls, and expose typed failure reasons.
   A missing `ldd` is informational for musl, not fatal. Probe required tools explicitly; static
   linking does not make GNU shell dependencies disappear. Report exact missing prerequisites.
2. Update `.github/workflows/release.yml`, shared artifact selection, identity fixtures and
   `remoteAgentPlatform.ts` together. Select musl from manifest availability, with glibc fallback
   only for transition artifacts. Preserve historic manifest parsing after glibc publication stops:
   stop producing old triples without breaking pinned older clients or cleanup of older builds.
3. Implement `apps/marketing/public/remote-agent.sh` plus focused shell fixtures. Require a pinned
   version; never silently choose latest for an app-generated command. Allow an expected digest
   and size supplied by the app's verified manifest. Download to a private temporary directory,
   bound download size/time, verify and atomically publish to `~/.bigbud/agent/inbox/<sha256>/`.
   Never execute the downloaded binary from this script: signature trust is enforced by the app
   before `--check`. A checksum obtained from the same download origin is not a signature.
4. The inbox holds one completed candidate plus one bounded temporary download. Serialize inbox
   writers with an owner-only lock; reuse identical bytes, reject a different pending candidate
   with actionable cleanup instructions. No automatic deletion of an unknown existing payload.
5. Add `remoteAgentInstall.inbox.ts`: claim the candidate under the inbox lock, validate ownership,
   regular-file/no-symlink ancestry, size and digest. Under the existing registry stage reservation,
   publish to the managed path using the same capacity checks as upload. Do not bypass the two-build
   limit. On capacity deferral leave the inbox candidate intact. Verify identity only after trust
   validation. Remove the inbox candidate only after successful managed publication.
6. Supply the script as a release asset and serve the same source from the website; test parity.
   Generate commands from the resolved artifact version, including dev overrides, not an assumed
   desktop version. Incompatible dev/release protocols fail with a targeted explanation.
7. Preserve original permissions on suspicious existing directories; report remediation instead
   of recursively chmod/chown. Verify failed or interrupted installs leave the active build usable.

### Phases 4–5: one operation for app, CLI and tools

- Create `remoteAgentInstall.operation.ts` over the existing manager/coordinator/admission flow.
  Its result separates `staged`, `active`, `deferred`, `failed`, and `uncertain`, and includes
  `cleanupDeferred` and an operation ID. Stage, prepare, health-check and admit before reporting
  active. Use existing retirement APIs; never invoke retired activation scripts.
- Bind app RPC, CLI and capability tools to this operation. Extend
  `SidebarRemoteAgentInstallDialog.tsx` and `SidebarRemoteAgentStatus.tsx` with the manual command
  and Finish install/update. Losing a client response does not cancel an accepted operation;
  query by ID before retrying. CLI returns structured JSON on `--json`, with distinct exit codes:
  0 active, 2 consent needed, 3 deferred, 4 failed, 5 uncertain, 6 backend unavailable.
- Add `remoteAgentLocalControl.ts` and split codecs/server/client modules. Use length-delimited
  requests capped at 64 KiB, 16 simultaneous clients, a 5-second admission timeout and an
  allow-list of status/install/doctor operations. Long installs return an ID for polling.
  Resolve targets through saved execution-target IDs or unambiguous saved SSH aliases; reject
  arbitrary shell fragments and ambiguous aliases. Host identity uses the existing SSH target
  configuration and host-key verification. Updating connection identity invalidates consent reuse.
- Implement packaged launchers with explicit CLI-only entry mode, so they cannot bootstrap a
  second backend. macOS/Linux use the bundled runtime and server entry; Windows uses an equivalent
  user command shim. Test paths with spaces, app relocation, stale links and conflicting commands.
  Never claim PATH is available immediately in an already-open Windows shell.
- D5 consent remains scoped to saved approved targets. A managed registry from a different target
  identity is not authorization. Tools require thread authentication and explicit consent evidence
  for unknown targets; a model-supplied boolean is not evidence. Share policy with CLI and UI.
- Test real packaged launch on all client OSs as a release gate; if absent, keep the Settings
  action hidden and report the phase incomplete. No fallback to launching another server.

### Terminal implementation: ownership and bounded reconnect

- Extend existing `remoteAgentOwnedPty`, `remoteAgentPtyClient` and terminal manager boundaries:
  transport disposal detaches; explicit Stop closes. Persist target, generation, epoch, PTY ID
  and last committed output cursor in the existing owner store before acknowledging creation.
- Add a paginated PTY inventory protocol and client codec to reconcile retained owner records;
  do not spawn replacements for unknown outcomes. Input remains single-writer with existing
  input operation deduplication. Keep the 4 MiB suffix bound and show a visible replay-gap marker.
- Retry transient transport failures with jitter at 1, 2, 4, 8, 16, then 30 seconds, at most ten
  attempts per episode; stop on authentication/host-key errors. Manual retry or network recovery
  starts a new episode. Reattach by identity; never replay an unacknowledged launch blindly.
- Keep live PTYs indefinitely until Stop or remote process exit; retain exited terminal metadata
  for 24 hours, subject to existing tighter limits. Reject new work at capacity, never evict live
  work. Updates pin generations with active terminals or provider/workflow sessions.
- Add read-only doctor output for source version, capabilities, pending update, pinned owners,
  resource bounds and authentication/transport category. Do not include secrets or raw output.

### Provider implementation: durable Codex transport in Rust

Support all providers, with provider runtimes provisioned only on demand per VPS. Codex may be
an internal implementation slice, not the phase release boundary. Extend the existing agent crate with `provider/` and
`provider/journal/`; do not start a parallel general-purpose backend. Rust owns the process,
wire request ledger, normalized session snapshot and event journal; TypeScript consumes the
canonical projection. Shared SDK helper mapping is reused where applicable, and Rust native
reducers have cross-language parity fixtures against existing mappings. Reuse the existing journal framing/atomic-compaction patterns in a separate versioned
provider journal; do not change process-journal records in place.

- Add `protocol/remote-agent/provider.proto` and additive frame capabilities. Operations:
  open, submit, attach, inspect, respond, cancel, close. Each mutation has installation ID,
  session ID, command ID, payload digest and controller generation. Attach includes epoch and
  last committed sequence. Events carry session/epoch/sequence and canonical item updates with bounded native recovery data.
- Use one Codex app-server child per remote session with private stdin/stdout; initialize once
  in Rust. Negotiate supported CLI/protocol capabilities before accepting a turn. Keep request
  ID mapping and server-request lifecycle in Rust; never attach two independent JSON-RPC clients
  to the same process. Separate bounded stderr diagnostics from the event stream.
- Persist command acceptance before dispatch and dispatch intent before writing provider stdin.
  On a crash between write and response mark the command outcome unknown; inspect provider
  state if supported, otherwise require explicit recovery. Never resend an uncertain turn.
- Persist each provider event before publishing. TypeScript imports events transactionally with
  a unique `(target, session, epoch, sequence)` receipt and canonical event commit, then ACKs.
  Give replayed events stable IDs derived from that receipt. Rehydrate adapter state before
  displaying new events; replay must not execute tools or schedule old work again.
- Add a transport seam adjacent to `codexAppServerManager.process.remote.ts`; keep the current
  SSH transport for existing sessions. Add `remoteAgentProviderClient.ts` and an orchestration
  remote-event importer. New opted-in threads persist `executionAuthority=remote` and binding
  identity via a registered SQLite migration. Local reactors skip execution for those threads.
- Support multiple authorized controller installations. The remote host remains the session
  authority. Serialize mutating commands and fence stale writers with a controller generation;
  support read-only observers and explicit control transfer. Independent replay cursors must
  not let one client acknowledgement discard events another client still needs. Bound retention
  with snapshot/gap recovery for stale clients. Use the SSH-account enrollment and revocation contract below.
- Store approvals/user-input requests before delivery. Replies use the original server request ID
  plus a deduplicated command ID. A provider cancellation or timeout makes the request stale;
  reject late replies. No approval is inferred from disconnect or expiration.
- Use remote provider credentials already configured by the user; do not copy laptop credentials.
  Transfer supported attachments through the existing safe workspace path operations before turn
  acceptance, with digest/size checks. Keep paths and attachment references remote for the turn.
- Classify callbacks: provider-native tools stay remote; approval/user input waits; laptop-only
  tool calls return a clear unavailable result when disconnected rather than hang indefinitely.
  Advertise this limitation in the session capabilities. Phase 8 supplies remote orchestration
  callbacks. Do not expose laptop-only tools as offline-capable.
- Defaults: 4 MiB incoming frame ceiling (or the stricter existing negotiated limit), 8 MiB
  outbound queue/session, 64 MiB journal/session and 512 MiB total provider journal budget.
  Reserve control-record space before accepting work. At 80% quota request cancellation of the
  active turn and reject new turns; drain bounded output, then terminate if cancellation fails.
  Disk I/O failure fences dispatch and reports uncertain/interrupted work; never silently discard
  events and continue claiming complete replay. Redact secrets from diagnostics, not protocol data
  needed for recovery; store sensitive journals mode 600 under mode 700 directories.
- Retain unacknowledged events until quota handling intervenes; compact acknowledged output with
  a durable state snapshot and approval/command receipts. Keep completed session receipts seven
  days; expired session IDs are rejected, never recreated by retry. Reboot/crash marks active
  turns interrupted, with explicit user-driven provider resume into a new epoch.
- Roll out only for new opted-in threads. Downgrade can inspect retained records but cannot open
  an unsupported state schema. Do not migrate running sessions to old binaries. No automatic
  provider resume after a crash, and no claim of seamless supervisor updates.

### Workflow implementation: bounded remote workflows

Add `workflow/` inside the agent crate plus `workflow.proto`. Support multiple VPSs and
authorized controlling installations. Each workflow has one authoritative remote coordinator;
each host owns its local processes. Cross-host execution must not depend on a laptop relay.
A workflow is a versioned graph of turn nodes with explicit dependencies, prompt/model/workspace,
allowed tools, and cancellation policy. Rust schedules ready nodes; TypeScript displays its
projection and submits commands. This is not a port of the entire local orchestration engine.

- Commands: create, inspect, attach, pause, resume, cancel, add-child, send-child-message. Persist
  workflow/node/command identity and digest. Validate acyclic dependencies and workspace scope.
- Node states: pending, ready, dispatch-intent, running, waiting-user, succeeded, failed,
  cancelled, outcome-unknown. Persist transitions before launching a phase-7 session. Child IDs
  derive from workflow/node identity; on restart reconcile sessions before scheduling anything.
- Provide a remote-local tool endpoint for child creation, status and messages, authenticated
  with session-scoped grants bound to the workflow. Implement only these supported coordination
  tools; laptop browser, desktop and cross-project tools remain unavailable offline.
- Defaults: two active child sessions per workflow, depth two, 32 total nodes, 100 queued
  messages and a 24-hour admission deadline. These are configurable implementation defaults,
  not a promise of a precise provider-spend cap. Never retry failed/unknown turns automatically.
- Root cancellation persists first, prevents new dispatch and propagates to owned children;
  completion is reported only after children settle or are explicitly marked outcome-unknown.
  Dependency failure blocks descendants. Resume requires a healthy journal and explicit command.
- Persist canonical thread UUIDs allocated for children and emit child-created events before
  child output. Import them via the remote-event receipt transaction even when created offline.
  Keep thread organization locally owned; runtime/session/workflow state is remotely owned.
- Gate local queue/recovery reactors by execution authority to prevent double dispatch. Compare
  remote event application with existing command receipt, deletion-fence and queue-recovery tests.
  A local deletion while disconnected is pending remote cancellation, not proof work stopped.
- Opt-in new workflows only; rollback disables creation and preserves inspect/cancel support.
  Cross-VPS scheduling, controller transfer and all-provider coverage are required scope.
  Use the coordinator-to-worker SSH and reconciliation contract below.

### Focused verification matrix and handoff

- Phases 1–3: extend `remoteAgentInstallManager.test.ts`, artifact/target tests, registry Linux
  tests and `remoteAgentInstall.stage.race.linux.test.ts`; add inbox tests for symlinks, trust,
  interrupted downloads, full capacity, competing script/app and safe cleanup. Smoke musl
  `--check`, PTY and process operations on Alpine, Debian 11 and Rocky 8 (with stated prerequisites).
- Phases 4–5: add operation/socket/consent tests, packaged launcher checks, and extend
  `SidebarRemoteAgentInstallDialog.browser.tsx` and status browser tests for each result state.
- Phase 6: extend `pty/reliability.tests.rs`, `supervisor/reliability.tests.rs`, owned-PTY restart
  tests and `remoteAgentPtyClient.durability.test.ts`; verify detach never emits close, Stop does,
  reconnect preserves cursors and a missing generation is reported instead of recreated.
- Phase 7: new Rust fake app-server integration tests inject every acceptance/write/ACK crash
  boundary; golden Rust/TS protocol fixtures; local SQL importer rollback/dedup tests; browser
  tests for catch-up, stale approvals, unknown outcomes and unsupported providers. Live Codex
  smoke: remote turn, laptop disconnect, reconnect, approval reply, cancellation and app restart.
- Phase 8: deterministic graph scheduler tests plus real child-process tests for duplicate
  requests, fan-out limits, cancellation, offline children, disk full, restart and local-reactor
  suppression. Verify parent completion cannot precede unsettled children.
- For changed TS files run explicit `bun run fmt:check <paths>`, `bun run oxlint <paths>`, and
  affected configured package checks such as `bun run --cwd apps/server typecheck` and web or
  desktop equivalents. Run focused Vitest via `bun run --cwd apps/server vitest run <files>`;
  web browser tests via `bun run --cwd apps/web test:browser <files>`.
- For changed Rust use crate-scoped `cargo fmt --package bigbud-remote-agent -- --check`,
  `cargo clippy --locked -p bigbud-remote-agent --all-targets -- -D warnings`, and focused
  `cargo test --locked -p bigbud-remote-agent <filter>`; include protocol crate checks when changed.
  Check authored file lengths directly against 400 lines; split materially edited oversized
  files by concern. New dependencies require the review/approval specified in `crates/AGENTS.md`.
- Record actual commands/results per phase; full-workspace checks, commits and pushes each need
  their own approval. Hardware/remote smoke tests are release acceptance work, not claimed done
  by this planning review. Compare artifact size and idle/busy resource use to the pre-change
  build; reject unbounded growth and document any measured tradeoff before rollout.

## Risks And Decision Gates

- Replacement must never terminate live remote work. Deferred retirement is the safe outcome.
- Partial failure during adoption leaves a reserved stage. The existing ambiguous and definitive
  failure classification in `remoteAgentInstall.stage.ts` must still apply.
- A concurrent automatic update and a manual install on the same target must serialise through the
  existing per-target install lock and preparation queue.
- Shipping musl and glibc assets together doubles release artifacts for one transition release.
- The pull script requires outbound internet on the remote. The push route stays available for
  air-gapped hosts.
- Every process under the user's account can use the CLI socket. This matches the account trust
  boundary that bigbud's owner-only state files already rely on, and the socket's operations are
  limited to remote-agent install, status and read-only doctor.
- A stale socket file can remain after a crash. The backend must remove and recreate it only
  after confirming it holds the backend lock.
- Windows named pipes need their own access-rule tests. Unix permission tests do not cover them.

## Testing And Validation

- Unit: failure mapping, pre-flight parsing, target triple resolution, CLI flag parsing,
  socket operation allow-list, launcher conflict detection, the D5 approval rule for saved
  projects, managed registries, unknown hosts and non-interactive runs.
- Release: the transition release manifest lists both musl and glibc assets, and the next
  release lists musl only.
- Socket: directory and socket permissions on macOS and Linux, pipe access rules on Windows,
  stale socket recovery, rejection of non-remote-agent operations.
- Script: shell tests for architecture detection, version pinning, hash mismatch and proof that
  downloaded bytes are never executed. App adoption tests cover a binary that fails to execute.
- Server integration: adoption of pre-placed bytes, hash mismatch rejection, replacement with and
  without pinned owners, concurrency with the update coordinator.
- Linux container tests, extending the existing `*.linux.test.ts` suites: glibc 2.31 failure
  message, musl agent on Alpine, script placement followed by adoption.
- Manual: install, replace and status against a real SSH server from the packaged app and CLI.
- Manual fallback: fresh install and existing-install update from the VPS terminal, followed by
  app activation; repeated commands, interrupted downloads and concurrent app/script staging
  preserve the working build and report staged, active and cleanup-deferred states accurately.
- Commands: focused `bun run --cwd apps/server vitest run <file>` runs, focused `oxfmt` and
  `oxlint` paths, the server typecheck, `cargo fmt`, Clippy and tests scoped to
  `bigbud-remote-agent`. Broad checks require approval.

## Acceptance Criteria

### Installation milestone: phases 1–5

- Install failures name their cause.
- The released agent runs on Ubuntu 20.04, Debian 11, Rocky 8 and Alpine.
- A manually placed agent becomes a normal managed build without upload or legacy pin.
- `bigbud remote-agent install <target> --replace` installs, activates and retires the old build,
  or reports a deferred replacement without losing work.
- An agent can install the remote agent through a capability tool after user consent.
- The app installs and replaces a remote VPS agent through the shared managed transaction.
- Both install and update offer copyable, version-pinned remote-terminal commands proactively
  and after failure, with explicit instructions to finish activation in the app.
- Interrupted or repeated manual staging leaves the working installation intact.
- The Settings action installs a usable launcher without editing shell files and explicitly
  reports any PATH setup or new-shell step needed before `bigbud` resolves.

### Subsequent milestones: phases 6–8

- Phase 6 proves terminal survival and reattachment across client disconnections with bounded resources.
- Phase 7 proves normal chat catch-up for every supported provider, including approvals and failures,
  while provisioning only the selected provider runtimes on each host.
- First selection reuses a compatible existing provider or installs only the selected missing one.
  Reconnect, app restart and switching away/back perform no redundant installation. Concurrent
  clients selecting the same missing provider produce one installation, with consistent results.
- Provider switching never reinstalls the base remote agent merely to enable another provider;
  actual compatibility updates are explicit and preserve live work.
- Phase 8 proves bounded cross-host workflow continuation, multiple-controller recovery and
  single authoritative scheduling under network partitions.
- Completing installation does not imply these later milestones are implemented or validated.

## Product Decisions And Expanded Implementation Design

### P1: Every provider at launch, install on first selection and reuse — agreed

- Cover every bigbud-supported provider from the first release of persistent remote provider
  sessions (phase 7), not a Codex-only launch. Earlier installation/terminal phases can ship
  independently. Internal provider-by-provider development does not narrow the release scope.
- Install the bigbud remote agent once with integration support for every supported provider.
  Do not bundle every provider executable/SDK. Optional provider helpers are fetched only when
  needed; selecting another provider never requires reinstalling the base agent solely to switch.
- On first selection per VPS/account, discover and validate an existing compatible installation.
  Reuse it if present; otherwise offer to install that selected provider and its required helper
  under the agreed consent policy. Install no unrelated providers.
- Retain successfully installed providers across SSH disconnects, app restarts and provider
  switches. Subsequent selections reuse them after a lightweight availability/compatibility
  check. Install again only if missing, explicitly updated/repaired, or incompatible with a
  required version; explain that condition rather than reinstalling on every connection.
- Coordinate simultaneous first-selection requests from multiple clients using a per-host,
  per-account, per-provider installation lock and durable result. Publish verified installations
  atomically; failures preserve existing working versions. Keep user-managed installations
  separate and never overwrite them automatically.
- Discover existing remote installations and reuse compatible user-managed executables without
  replacing them. Provider selection is per remote session/project, not inferred from laptop defaults.
- Only offer installation of a missing provider when the user selects it. SSH connection alone
  does not authorize installing providers. Show the provider, version and required helper/runtime;
  use explicit install consent or previously granted provisioning policy.
- If no supported automated installation exists, provide remote setup instructions and report
  that provider unavailable until configured. Never substitute a different provider silently.
- Keep credentials on the selected remote host. Authentication, version compatibility and
  platform availability are checked per provider. Unsupported combinations are explicit failures,
  not grounds to install unrelated providers.
- Optional SDK helpers are per-provider and downloaded only when needed. Define ownership,
  signing/versioning, cancellation and cleanup for each helper; Rust remains session authority.

### P2: Multiple VPSs and multiple controlling installations — agreed scope

- Support multiple remote hosts and authorized bigbud clients. Preserve one authority per session
  and workflow, even when several clients observe or submit commands.
- Define host identity, client enrollment/revocation, controller transfer, per-client replay and
  remote-created thread import without depending on one laptop's local database.
- A cross-host workflow must have a reachable, authenticated remote coordinator. Loss of access
  to another host produces an explicit uncertain/waiting state, never duplicate scheduling.

### Expanded scope resolution: provider integrations

The release inventory is `PROVIDER_KINDS` in
`packages/contracts/src/constants/provider.constant.ts`, currently ten provider IDs. Add a
contract test that requires one remote manifest entry per ID, including optional/preview entries;
preview flags and provider capability restrictions remain enforced. This is integration coverage,
not a promise that every upstream tool supports every Linux architecture or feature.

| Provider ID | Selected remote integration                        | Reuse boundary and required remote components                                                                 |
| ----------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| codex       | Rust app-server transport described above          | Configured Codex executable and remote account; existing TypeScript event mapping                             |
| pi          | Rust NDJSON RPC driver                             | Pi executable; move the existing Pi orchestration extension bridge to remote callbacks                        |
| cursor      | Rust ACP client                                    | Cursor executable with ACP; remote filesystem/terminal handlers replace laptop callbacks                      |
| devin       | Same ACP client, provider-specific initialization  | Devin executable with ACP; preserve elicitation and capability differences                                    |
| claudeAgent | Optional Claude SDK helper supervised by Rust      | Selected Claude runtime plus pinned Claude SDK; extract query/permission callbacks from existing adapter      |
| cliProxy    | Claude helper with explicit CLIProxy configuration | Reuse Claude helper package but require configured proxy endpoint/auth; never silently select ordinary Claude |
| copilot     | Optional Copilot SDK helper supervised by Rust     | Existing compatible CLI or managed CLI plus pinned SDK; reuse Runtime discovery/install rules                 |
| muse        | Optional MSP SDK helper supervised by Rust         | `muse serve` and pinned SDK; preserve lifecycle/fingerprint and callback rules                                |
| opencode    | Optional SDK helper over owned server              | Existing server manager semantics, pinned SDK and compatible OpenCode executable                              |
| opencodeV2  | Separate version-pinned SDK helper                 | Preserve V2 isolated profile/version admission and preview restrictions; never alias V1                       |

Implement drivers under `crates/bigbud-remote-agent/src/provider/{codex,pi,acp}`. Share ACP
framing and lifecycle, not provider-specific capabilities. Implement SDK helpers under a new
`packages/remote-provider-helper` package with explicit provider entry points and no barrel.
Extract provider-specific pure mapping/configuration helpers from `apps/server/src/provider`
into explicit subpaths only where both server and helper consume them; do not import the server
bootstrap, SQL orchestration engine, UI or all provider SDKs into a helper.

Helper protocol lives in `protocol/remote-agent/provider_helper.proto`, with bounded framed
stdin/stdout and the same generated Rust/TypeScript golden fixtures as the remote protocol.
Messages: initialize, execute(command ID/digest), event(sequence), event-ack, callback(request ID),
callback-result, cancel, close. Helpers retain at most 8 MiB unacknowledged events, then apply
backpressure or terminate with an explicit failure; they never discard silently. Rust persists
events before acknowledging them. If a helper dies with an unacknowledged command, report its
outcome unknown/interrupted rather than restarting the command. Rust owns helper process groups,
timeouts, durable requests and callback policy; helpers own only SDK objects and translations.

Package each helper separately with its dependency closure. Reuse one verified private Node
runtime per compatible version on the host; do not alter global Node/npm or shell configuration.
An SDK helper is an implementation dependency, not another user-selected provider. The UI must
show its runtime/disk requirement before installation. Keep provider-native credentials in their
normal remote profile; do not put them in helper launch arguments, logs or client snapshots.

Provider manifest fields: provider ID, helper ABI, supported OS/arch, tested executable versions,
probe arguments, managed-package recipe, required runtime, authentication status probe,
capability flags, artifact digest/signature and manual setup fallback. Store recipes as data with
allow-listed installers, never executable commands supplied by a remote manifest. Use vendor
packages fetched on demand for third-party software rather than redistributing vendor binaries
without verified permission. Resolve exact versions/recipes from installed lockfiles and vendor
release metadata at release preparation; changing a pin requires its conformance tests. Where
installation cannot be automated, first selection offers precise manual setup and recheck; it
must not report that provider ready or that release platform certified until verified.

Discovery order: explicit remote executable/profile, compatible executable on remote PATH,
then bigbud-managed installation. Persist provider/version/path provenance; do not overwrite
user-managed paths. Separate presence, compatibility and authentication states. Provider switching
selects an existing session or creates a new session explicitly; it does not switch the provider
inside an active session. Runtime updates pin old helper/CLI versions while live sessions use them.

Per-provider conformance is mandatory: bootstrap/auth-required, text and attachment turn,
approval/question or explicit unsupported response, tool callbacks, cancellation, disconnect,
replay, helper/provider death, version rejection and first-install reuse. Generate the test matrix
from the manifest; no skipped row may be counted as passing. Native feature differences remain
explicit. All-provider release coverage is on advertised supported host combinations; unavailable
upstream platforms remain visibly unsupported. Release scripts must produce a coverage report.

### Expanded scope resolution: multiple clients and canonical state

Keep SSH as the authentication/encryption boundary. The remote Unix account is the trust unit;
client installation IDs identify and coordinate clients but are not credentials. All programs
with access to that account can act as the user. Avoid claiming application revocation can block
someone who still has SSH access; real revocation removes their SSH access/key as well.

Persist an account-scoped random `hostId` under `control-v1`, bound locally to verified SSH host
key and remote user. A changed key or reused identity requires explicit reconfirmation. Discover
sessions/workflows by this identity, not host alias or a laptop's project ID. Add paginated catalog
operations (100 items/page) and remote canonical project/thread IDs; clients map them into local
projections using `(hostId, remoteThreadId)` uniqueness. Never deduplicate by title/path alone.
New laptops explicitly attach/import a remote project; unrelated laptop notes/settings do not sync.

Add client registration and viewer/controller role records on the remote. Registration follows
successful SSH and explicit Attach in the UI. Default viewer until control is acquired. A session
has one mutation controller lease: remote monotonic deadline 30 seconds, renewed every 10 seconds,
with durable monotonically increasing fencing generation. Other viewers may observe; mutation
requires current generation. Offline autonomous work continues without a controller lease. An
expired lease permits explicit acquisition by another authorized client; takeover while a lease
is live requires explicit confirmation and a CAS generation increment. On supervisor restart,
expire all leases and increment the boot epoch; reject stale commands and late approval replies.

Persist controller-independent session snapshots and event receipts. Track per-client cursors,
but cap inactive cursor retention at seven days and total storage using the existing limits.
A stale/new client receives a snapshot at sequence S followed by events after S. Snapshots contain
canonical messages/items, lifecycle and unresolved requests, not only opaque native bytes. Rust
native drivers reduce their events into this snapshot schema; helpers emit normalized item updates
using extracted shared mapping logic. This extends the original raw-event-only Codex design.
Snapshots have explicit truncation metadata when retained historical content is unavailable.
Pending requests and active-turn state are never silently truncated.

Snapshot import and event import are transactional and idempotent. Archive/title organization
is local presentation state; runtime cancellation/deletion is remote authority and requires the
controller lease. Disconnected deletion remains pending until remote confirmation. Revoking a
client invalidates its lease and subscriptions, without destroying running sessions.

Tests: simultaneous acquire, stale response, explicit takeover, expired lease while work runs,
clock changes, new laptop snapshot import, one viewer lagging beyond retention, revoked client,
SSH host-key change, duplicate alias and local database loss. Define protocol messages in
`provider.proto` and shared snapshot contracts; add Rust `provider/catalog`, `provider/control`
and server `remoteAgentSessionCatalog`/projection modules rather than overloading owner-store rows.

### Expanded scope resolution: cross-VPS coordination

Each workflow chooses an existing remote host as its permanent coordinator. That Rust process
owns workflow state and reaches worker hosts through ordinary SSH from the coordinator account.
Require user-configured, verified host-to-host access before enabling a cross-host node. Do not
forward laptop SSH agents, copy private keys, disable host verification or silently open public
listeners. Validate connectivity from the coordinator during workflow admission. If no route
exists, show setup requirements; laptop-connected execution is not labeled offline-capable.

A worker starts `bigbud-remote-agent --workflow-worker-proxy` over SSH, negotiating host identity,
protocol and limits through the same private socket path. Add a worker grant scoped to coordinator
host ID, workflow ID, allowed workspace roots/providers and concurrency. Provision/revoke grants
through an authenticated user action. SSH account access remains the outer security boundary;
grants prevent accidental capability expansion, not a hostile account owner.

Coordinator persists node dispatch intent and a stable `(workflowId,nodeId,attempt)` command ID
before sending. Worker durably accepts that ID/digest and returns the same receipt on retry.
Worker owns the process and retains status/events independently of the SSH connection. During
partitions the coordinator retries status with bounded backoff; it never launches an alternative
copy on another host. Worker may finish already accepted work; dependent nodes wait for confirmed
completion. Cancellation is a durable intent retried until acknowledged; UI reports cancel-pending
or outcome-unknown rather than claiming a partitioned child stopped.

One coordinator process holds an exclusive OS lock on its workflow store. Persist workflow state
and worker receipts using the versioned journal/snapshot mechanism. Coordinator restart on the
same host reconciles every dispatch-intent/running child before scheduling. There is no automatic
coordinator failover to another host in this version: permanent loss is reported as unavailable,
with explicit worker inspect/stop recovery. Multiple VPS support does not imply consensus/high
availability. Do not clone coordinator state while active; host migration is offline maintenance.

Cross-host dependencies exchange bounded result summaries (1 MiB/node), not implicit filesystem
replication. Explicit attachments use digest-verified transfers; each node names its own remote
workspace. Do not assume identical paths or synchronize Git repositories automatically. Credentials
for a provider stay on its worker host. Multiple laptop clients control the coordinator using
workflow controller leases and fencing, never competing local schedulers.

Add Rust `workflow/transport`, `workflow/worker`, `workflow/reconcile`, plus worker grant/receipt
messages in `workflow.proto`. Add server preflight and UI for coordinator/worker selection,
connectivity failure and pending cancellation. Test with two real local SSH/container endpoints:
partition before/after acceptance, coordinator restart, lost completion, cancellation partition,
worker crash, version mismatch and attempted duplicate dispatch. All provider-specific execution
uses the phase-7 manifest/driver; no second provider integration layer in the scheduler.

### Expanded scope resolution: installation across controllers

The existing `remoteAgentInstall.registry.store.ts` already implements cross-controller CAS,
with `control-v1/registry.lock` in `registry.shell.ts`. Preserve it; the previous statement that
multi-controller coordination was entirely absent was too broad. The missing work is global
liveness evidence and fencing across reservations, helper installs and retirement.

Add a stable per-account control generation and install operation records under `control-v1`,
outside versioned runtime directories. Record controller ID, operation ID/digest, expected
registry revision, stage and candidate identity. All backend writers use the same CAS transitions;
a runtime file lock protects publication only, never the network download duration. If a writer
disconnects, its reserved operation persists for inspection/reconciliation; timeout alone cannot
prove a launched process or staging write is dead.

Before retirement, query the candidate generation's Rust supervisor for authoritative live PTY,
provider, helper and workflow references. Union those pins with registry reservations and existing
legacy owner evidence. Missing/unreachable supervisors or unknown writers defer cleanup. Never
use one laptop's local owner database as proof that another client's work is idle. Extend
retirement/admission schemas and tests without weakening the two-managed-build bound.

Use per-provider private filesystem locks for managed provider publication, with immutable version
paths and registry pin records. Concurrent selection returns the same installation operation;
conflicting requested versions stage separately only within configured disk bounds. Preserve
user-managed binaries and live-version pins. Inbox publication/adoption retains its own lock;
lock order is inbox/provider publication first, short registry CAS second, never the reverse.

Introduce a minimum writer protocol revision before activating multi-client writes. Older desktop
clients must refuse mutation on a newer registry schema; validate this against released parsers.
If an old parser cannot fail closed, use a new control-root version with an explicit legacy fence
recognized by the transition release before enabling the feature. Do not handwave backward
compatibility or migrate active work. Test old/new client contention and lost acknowledgements.

### Review corrections and additional acceptance gates

This review resolves conflicting earlier statements in place. The following conditions are
required in addition to the phase-level criteria; no broad implementation readiness claim
replaces these empirical gates.

- **Platform separation:** certify the static Rust base separately from each optional Node,
  SDK and vendor executable. A working musl agent on Alpine/older Linux does not imply that
  Node or every provider works there. Each manifest records OS/arch/libc constraints and exact
  certified tuples. Reject an incompatible helper before download or execution and present
  remediation. Do not silently label a glibc-only helper portable or automatically install a
  compatibility layer. All ten provider IDs must have a certified working remote path on their
  supported tuples before phase 7 ships; an unsupported response alone cannot satisfy coverage.
- **Helper installation:** verify bigbud-authored helper/runtime manifests with pinned trust
  roots and artifact hashes; validate upstream package provenance separately. No shell-string
  installation recipes, global package mutation or unreviewed package lifecycle scripts. Test
  extraction traversal/symlinks, interrupted install, helper ABI mismatch, offline reuse,
  malicious artifact, missing auth and disk exhaustion. Include dependency/license review and
  publish compressed download, installed size and idle RSS measurements for each helper.
- **Shared runtime cleanup:** keep provider/helper/Node versions pinned while any session uses
  them. Uninstall removes only explicitly selected managed components; never user-managed
  tools, credentials or unrelated providers. A shared Node runtime is removed only after all
  dependent helpers and sessions release it. Two-client cleanup/install tests are mandatory.
- **Two builds and mixed clients:** test two different compatible desktop versions against one
  live remote generation. Negotiate capabilities instead of oscillating updates to each laptop's
  release. An incompatible client is refused with update guidance. A third requested build when
  two are live is deferred; no silent eviction. Older writers must fail closed before migration.
  A newer fence cannot retroactively constrain an old executable that ignores it: if released
  clients do not honor the fence, require their upgrade/disconnection and a verified quiescent
  migration before enabling multi-controller writes. Keep this a release blocker, not a fallback.
- **Global resource bounds:** the 512 MiB journal budget includes snapshots and compaction files;
  reserve space for atomic rewrite and control records. Enforce host-wide active-session and
  memory/queue admission limits in addition to per-session limits. Start with eight provider
  sessions/host, four active workflows, two active children/workflow and 64 MiB total outbound
  queue budget, configurable downward. Pending approvals and active state count toward quotas.
  At pressure reject new work, compact safe history, then explicitly interrupt affected work if
  required; do not discard state and pretend replay is complete. Test maximal concurrent load.
- **Snapshot consistency:** one canonical reducer per provider execution path; native Rust
  reducers and reused SDK mapping must pass shared fixtures. Snapshot S and subsequent events
  are an atomic replay boundary. Test UTF-8/large-message chunking below frame limits, concurrent
  snapshot compaction, new laptop import, expired cursor, stable IDs and no replayed tool effects.
- **Receipts and expiry:** no clock-based retry may resurrect completed or expired work. Allocate
  new session/workflow IDs through server-issued durable allocation records; unknown IDs cannot
  be created through submit/retry. Retain deletion/expiry tombstones or an epoch admission fence
  after compacting receipts, with a bounded retirement design. Test delayed create/submit after
  seven-day expiry and after restore; neither may launch a second process.
- **Control transfer:** lease expiry only changes who may submit commands; it never cancels work.
  Test simultaneous takeover/approval/cancel and reject commands from the old generation. SSH
  access remains account-level trust; application client revocation is not hostile-user isolation.
- **Cross-host offline proof:** two workers on separate SSH endpoints and two desktop clients;
  disconnect both desktops and verify workflow completion or an explicit approval wait. Partition
  a worker before/after dispatch and cancellation; reconnect without duplicate effects. A worker
  may complete accepted work after revocation/disconnect; cancellation is not confirmed until
  acknowledged. Coordinator permanent loss has inspect/stop recovery, not automatic failover.
- **Credentials:** test expired provider auth mid-turn and unavailable SSH key/passphrase while
  laptops are offline. Report needs-auth and preserve receipts. No browser login, sudo prompt,
  agent forwarding or laptop secret copy is required implicitly during background work.

### Practical delivery: helpers and coordinator SSH

For SDK helpers, keep setup within first provider selection: show one combined installation
summary for the selected provider and required helper/runtime, reuse existing compatible tools,
and install a private version-pinned runtime only when necessary. Reuse that managed runtime
across helpers with compatible requirements. Start helpers on demand and stop them when their
last live session closes; never tie their lifetime to a desktop connection. Keep Rust's control
plane usable when a helper cannot run, and expose a targeted repair action rather than reinstall
all providers. Prefer the existing SDK boundary over a rushed Rust reimplementation; move a
helper to Rust only when protocol conformance and measured maintenance benefit justify it.

For cross-VPS workflows, provide an explicit Connection setup screen. The user selects one VPS
as coordinator and other VPSs as workers. First test existing coordinator-side SSH configuration
using noninteractive mode, strict host checking and bounded timeouts. Reuse access that already
works. If it fails, show the exact failing hop and commands to establish access; never assume
laptop-to-worker access proves coordinator-to-worker access.

Offer an optional guided dedicated-key setup only after explicit approval: generate the private
key on the coordinator, display only its public key, and help authorize that public key on each
worker. Prefer a key constrained to the worker-proxy command with no forwarding or PTY; test
that restriction supports required worker operations. Do not automatically grant shell access or
fall back to an unrestricted key. Keep verification of the worker host-key fingerprint explicit.
Do not persist private-key material in the laptop database or logs. Users may use their own SSH
configuration instead; bigbud must not edit unrelated SSH entries.

The setup finishes only after a coordinator-origin handshake and a disposable no-op operation
round trip confirm worker identity, grant scope and protocol compatibility. Record readiness per
hop. Revoking a worker connection removes its scoped grant and, for a bigbud-created key, offers
removal of that exact authorized public key; it never rewrites the whole authorized_keys file.
Ordinary multi-VPS browsing/independent sessions need only laptop-to-VPS SSH; these extra hops
are required only for autonomous workflows spanning hosts. This avoids burdening every user
with cross-host setup.

### Completion gates after design resolution

The design now selects the provider/helper, multi-client, cross-host and shared-installation paths.
Implementation can proceed in phase order. This is not certification that provider runtimes work
on all platforms. Each phase must pass its specified fault tests and actual packaged/runtime smoke
checks. Dependency choices, helper redistribution licenses and exact vendor install recipes must
pass the repository's normal dependency/release checks before publication; failures are blockers,
not permission to silently omit a provider from the promised release.

The agreed product scope is unchanged by this review. Two practical setup requirements
must be visible: some providers need an optional JavaScript SDK/runtime helper, and offline
cross-VPS workflows require SSH access from their chosen remote coordinator to worker hosts.
