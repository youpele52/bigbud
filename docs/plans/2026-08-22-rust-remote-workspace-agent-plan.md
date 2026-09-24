# Rust Remote Workspace Agent Plan

**Date:** 22 August, 2026
**Status:** In progress
**Owner:** bigbud team

## Summary

Introduce a thin, provider-neutral Rust agent that bigbud installs and launches over SSH to make remote projects behave like local projects without requiring bigbud's providers, credentials, orchestration, or canonical state to move to the remote host.

The local TypeScript server remains the authority for projects, threads, messages, permissions, provider adapters, tool approvals, and SQLite. The Rust agent becomes a normalized remote workspace backend for filesystem, search, Git, process, PTY, watch, and platform operations. Local and remote projects should ultimately use the same narrow runtime contracts and conformance tests.

The first implementation prioritizes faster reconnect and resumability, remote Files and Git parity, bounded resource use, and a safe migration path from one-shot SSH commands. It does not move provider processes remotely. A transient SSH interruption may pause a local provider while its remote tool operation reconnects, but laptop suspension still pauses the local provider.

## Related Work

- [Remote Access Setup](../REMOTE.md) documents remote access to the bigbud UI and server. That is separate from this plan's SSH-backed remote workspace execution.
- [README remote projects](../../README.md#remote-projects) describes the current user-facing SSH project behavior.
- [Changelog remote SSH history](../CHANGELOG.md) records the existing SSH project, reconnect, editing, password, provider-runtime, and terminal behavior that this plan must preserve during migration.
- [Zed Remote Development](https://zed.dev/docs/remote-development) is the primary architectural reference for automatic installation, SSH ControlMaster multiplexing, a version-matched remote binary, a proxy/daemon split, and reconnecting to a short-lived remote workspace process.
- Architecture decision record: [Local Authority And Remote Workspace Agent Boundary](../decisions/2026-08-22-rust-remote-workspace-agent-boundary.md)
- Project Kanban card: [Rust remote workspace agent](bigbud-kanban://kanban/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/1787414695466-bd26330b.md)
- None identified for a repository issue or pull request.

## Problem

bigbud can already open SSH-backed projects and use their files and Git repositories through provider tools and remote terminals. The current implementation is useful and must remain available, but remote behavior is fragmented across one-shot SSH commands and provider-specific bridges.

The fragmentation creates four user-visible limitations:

- Files preview, content search, directory listing, watching, binary preview, and several other Files-panel paths reject remote workspaces or omit the execution target.
- First-class Git status, diffs, branches, history, commits, checkout, worktrees, and status subscriptions reject remote targets even though users can run Git manually in the remote terminal.
- Key-backed tools frequently start a new SSH process per operation, while password mode alone has explicit ControlMaster reuse. High-latency links therefore amplify small file and search operations.
- Remote terminals and long-running operations are attached to the current SSH child. A transport interruption does not provide stable operation identity, acknowledgement, replay, or reattachment.

Provider support is also inconsistent. Codex and Claude use generated MCP bridges, Copilot uses a custom session filesystem and Bash tool, OpenCode and KiloCode override built-ins, and Pi uses a generated extension. Cursor declares no remote workspace support, while Devin's declared support needs validation against its local-path startup behavior. Adding capabilities separately to each bridge would increase duplication and make local parity harder to prove.

A full remote bigbud server would solve some parity issues but conflicts with the desired product boundary. Providers, provider credentials, orchestration, and canonical state must remain local. The remote component should be as small as practical, expose no network listener by default, and retain only bounded temporary state required to survive a transport interruption.

## Goals

- Keep provider processes, credentials, conversations, tool approvals, threads, messages, orchestration events, and canonical SQLite records local for agent-backed local-runtime/remote-workspace sessions.
- Introduce provider-neutral, target-aware runtime contracts for filesystem, search, Git, process, PTY, watch, platform, and operation-lifecycle behavior.
- Implement local and remote backends beneath existing services rather than replacing every caller at once.
- Install and run one small versioned Rust binary on supported SSH hosts without requiring Bun, Node.js, Electron, Docker, or a remote bigbud server.
- Reuse the user's OpenSSH configuration, host verification, jump hosts, agents, keys, password unlock flow, and established execution target.
- Make remote Files, Git, terminal, search, and watcher behavior semantically equivalent to local behavior wherever the remote platform supports it.
- Allow accepted remote operations to survive transient SSH transport loss and support attach, replay, cancellation, status, and bounded terminal-result retention.
- Prevent duplicate acceptance of the same mutating request and report uncertain outcomes rather than retrying mutations blindly.
- Support every bigbud provider through its existing local integration mode after provider-specific conformance proves equivalent remote workspace behavior.
- Keep the existing direct-SSH implementation as a controlled fallback until agent parity and reliability have soaked in real use.
- Bound remote memory, disk, process, output, watch, and operation usage under disconnects and failures.
- Make installation, protocol compatibility, reconnect, replay, fallback, and cleanup observable without recording file contents, command input, environment secrets, or provider credentials.

## Non-Goals

- Running provider processes or provider SDKs in the Rust agent.
- Making local providers continue while the local machine is suspended, offline, restarted, or powered off.
- Moving canonical project, thread, message, provider, or orchestration state to the remote host.
- Building a remote bigbud web server, pairing service, cloud relay, account system, or multi-device environment in this work.
- Translating Codex, Claude, Copilot, OpenCode, KiloCode, Pi, Cursor, or Devin protocol state in Rust.
- Claiming exactly-once execution across host crashes, spool loss, or agent state loss.
- Automatically retrying a mutating operation after an ambiguous outcome.
- Treating filesystem watches as lossless event streams; watches remain invalidation hints that can require a rescan.
- Sandboxing an intentionally unrestricted shell command to the workspace root. Root-confined file APIs and unrestricted shell execution are separate capabilities and security boundaries.
- Forwarding local Git or provider credentials to the remote host. Remote Git uses the remote user's existing credentials and configuration.
- Replacing SSH authentication or weakening OpenSSH host-key checking.
- Shipping all capabilities, platforms, and providers in one release.
- Removing the legacy direct-SSH path before the rollback gates in this plan are satisfied.

## Current State

### Execution targets and provider placement

- `apps/server/src/workspace-target/workspaceTarget.ts:5-47` normalizes local and SSH workspace targets.
- `apps/server/src/provider/providerSessionExecutionTargets.ts:18-41` and `providerExecutionContext.ts:20-50` preserve separate workspace and provider-runtime targets. This separation must remain unchanged.
- `apps/server/src/provider/providerCapabilities.ts:12-84` declares local-runtime/remote-workspace and remote-provider-runtime support independently for each provider.
- `apps/web/src/lib/providerExecutionTargets.ts:21-38` lets the renderer keep providers local or select the workspace SSH target where remote provider runtime is supported.

This plan changes workspace transport, not provider placement. Agent-backed local-runtime/remote-workspace sessions keep providers local. Existing user-selected remote-provider execution remains a separate capability and must not become an agent dependency or be removed by this work.

### SSH transport and verification

- `apps/server/src/ssh/sshExecutionTarget.ts` parses persisted SSH targets while excluding passwords from the target identifier.
- `apps/server/src/ssh/sshCommand.ts:23-90` builds POSIX-escaped one-shot SSH invocations.
- `apps/server/src/ssh/sshVerification.ts:109-286` verifies paths and SSH access and supports passphrase unlock.
- `apps/server/src/ssh/sshSession.ts:162-261` creates a ten-minute password-authenticated ControlMaster, uses short control socket paths, and cleans sessions at process exit.
- `apps/server/src/tool-transport/toolTransport.ssh.ts:31-45` is a thin wrapper over one-shot SSH command execution.
- `apps/web/src/hooks/useRemoteExecutionAccessGate.ts` and related helpers verify access before activation, distinguish authentication failures, and allow long checks to continue in the background.

These paths remain the bootstrap and fallback transport. The agent must not create a second SSH credential model.

### Workspace files and search

- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts:120-175` rejects remote text preview and content search.
- `WorkspaceFileSystem.ts:252-285` rejects remote file watching.
- `WorkspaceFileSystem.ts:298-335` supports remote writes through one-shot SSH.
- `apps/server/src/workspace/Layers/WorkspaceEntries.ts:296-306` rejects remote directory listing.
- `apps/server/src/workspace/Layers/WorkspaceEntries.remote.ts:16-227` builds a bounded remote index with `git ls-files` or `find`, but repeated remote searches can rebuild it.
- `apps/server/src/ws/http.workspace.ts:92-161` serves binary workspace content from a local-only route without an execution target.
- `apps/web/src/lib/workspaceFilePreview.ts:78-89` and Files preview components therefore cannot request remote binary/image/PDF/video content through the normal preview route.
- `apps/web/src/components/files/useFilesPanelDirectoryRefresh.ts:67-101` and `useFilePreviewRefresh.ts:44-61` intentionally disable remote watcher behavior.

Existing preview size, UTF-8 validation, search bounds, truncation, and path containment behavior must become backend-neutral contracts rather than remote exceptions.

### Git and shell

- `apps/server/src/git/Layers/GitCore.ts:48-137` rejects remote targets for status, branches, history, diffs, checkout, branch mutation, initialization, and worktrees.
- `apps/server/src/git/Layers/GitCoreExecutor.ts:14-217` already centralizes useful timeout, output, execution, and error semantics that a remote backend can preserve.
- `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts:37-46` rejects remote Git-status subscriptions.
- `apps/server/src/ws/wsShellDispatch.ts:123-138` rejects orchestration shell commands for remote targets.
- `apps/server/src/terminal/Layers/Manager.remote.ts:4-22` launches remote terminals through `ssh -tt`.
- `apps/server/src/terminal/Services/PTY.ts:20-58` and `terminal/Services/Manager.ts:37-125` provide useful local interfaces and ownership behavior for an agent-backed PTY adapter.

### Provider-specific remote workspace bridges

- Codex uses `apps/server/src/codex/codexRemoteWorkspaceBridge.ts` and a generated SSH-backed MCP implementation.
- Claude uses `apps/server/src/provider/Layers/Claude/ClaudeRemoteWorkspaceBridge.ts`, currently with a deliberately narrower remote tool set.
- Copilot uses `apps/server/src/provider/Layers/Copilot/CopilotRemoteWorkspaceBridge.ts` and `remoteWorkspaceSessionFsBridge.ts`.
- OpenCode and KiloCode use built-in overrides under `apps/server/src/provider/Layers/Opencode/OpencodeRemoteWorkspaceBridge.ts`.
- Pi uses a generated extension under `apps/server/src/provider/Layers/Pi/PiRemoteWorkspaceBridge.ts`.
- Cursor declares no remote workspace support in `providerCapabilities.ts:40-47`.
- Devin declares local-runtime/remote-workspace support, but `apps/server/src/provider/Layers/Devin/Adapter.startSession.ts:68-77` resolves a local path and needs an implementation audit before that declaration can be trusted.
- `apps/server/src/remote-workspace-bridge/remoteWorkspaceMcpBridge.template.ts:49-248` and `remoteWorkspaceSessionFsBridge.ts:91-330` duplicate remote process and filesystem behavior.

Provider bridges should keep translating provider-native requests locally, but their workspace operations should converge on one provider-neutral tool API.

### Existing replay foundation

- `apps/server/src/ws/wsRpcHandlers.orchestrationServer.ts:196-203` exposes orchestration replay from a sequence.
- `apps/server/src/ws/wsStreams.ts:39-66` merges replayed and live events while preserving sequence order and detecting gaps.
- Provider sessions already retain provider-specific resume cursors where supported, for example `apps/server/src/codex/codexAppServerManager.turn.ts` and `codexAppServerManager.startSession.ts`.

This event infrastructure can consume completed remote operation outcomes after TypeScript receives them, but it does not replace the agent protocol's temporary operation replay. The local server must first receive, validate, and persist remote results.

### Rust and release tooling

- The repository currently has no `Cargo.toml` or Rust workspace.
- `.github/workflows/ci.yml` and `.github/workflows/release.yml` currently build the TypeScript/Electron product matrix but do not publish remote-agent artifacts selected by remote OS and architecture.
- `scripts/lib/desktop-artifact/build.ts` and `resources.ts` contain existing artifact staging patterns, but the remote agent needs its own signed manifest because the remote host can differ from the desktop host.

## Phases

The first usable agent milestone comprises Phases 0-6: normalized local contracts, the Rust protocol and supervisor, secure installation, Files/search parity, resumable process semantics, and first-class remote Git. Watchers, PTY reattachment, all-provider normalization, default cutover, and legacy retirement remain later gated milestones. This ordering keeps the first implementation focused on the requested reconnect, Files, and Git outcomes without coupling them to every provider migration.

### Phase 0: Freeze Semantics, Threat Model, And Capability Matrix

**Goal:** Define local behavior, security boundaries, and reconnect semantics before Rust code makes remote behavior the accidental specification.

**Scope and implementation:**

Implementation policy now includes a formal hard limit of 400 lines for every
authored source and test code file, including Rust. Existing oversized Rust
modules are being split by concern before further behavior is added; generated
outputs must be split at their generator boundary.

The current implementation tranche also split every changed or newly authored
source/test module that crossed the limit: workspace/runtime helpers,
WebSocket context and handler concerns, server test-layer fixtures, Files-panel
rendering, and server contract/provider schemas. All Rust agent/protocol files
are now below the limit; the repository's unrelated pre-existing oversized test
files remain tracked as maintainability debt and were not expanded by this
work.

1. Create an architecture decision record for the local-authority/remote-agent boundary. Record that providers and canonical state remain local and that bounded remote operation metadata is temporary delivery state.
2. Inventory every local filesystem, search, Git, process, PTY, watch, and platform operation used by the web app and provider bridges.
3. Define semantic capability contracts rather than one oversized interface:
   - `WorkspaceFiles`
   - `WorkspaceSearch`
   - `WorkspaceGit`
   - `WorkspaceProcess`
   - `WorkspacePty`
   - `WorkspaceWatch`
   - `WorkspacePlatform`
   - `WorkspaceOperationRegistry`
4. Let a `WorkspaceRuntime` façade aggregate those contracts, but make callers depend on the narrowest service.
5. Define a capability matrix comparing local behavior, current SSH behavior, required agent behavior, platform restrictions, error semantics, size/output limits, cancellation, and reconnect behavior.
6. Classify every operation as retryable read, idempotent mutation, deduplicated spawn, streaming attachment, lossy watch, or non-repeatable mutation.
7. Define workspace-root confinement, symlink policy, unrestricted shell policy, Git hook policy, filename encoding, binary file support, case sensitivity, executable lookup, and remote credential behavior.
8. Define user-visible connection states: unavailable, installing, connecting, ready, reconnecting, degraded, authentication required, incompatible, and failed.
9. Define the initial supported remote platform. Prefer Linux x86_64 and arm64 for the first vertical slice; expand only after artifact and integration coverage exists.

**Likely files:**

- A new ADR under the repository's chosen decision-record location
- `apps/server/src/workspace-runtime/Services/*`
- Focused capability and conformance test fixtures
- `apps/server/src/provider/providerCapabilities.ts`

**Exit criteria:**

- The architecture and threat model are reviewed.
- Every initial operation has defined retry, cancellation, confinement, and uncertain-outcome behavior.
- The local-versus-required-remote capability matrix is complete.
- No Rust implementation is required to answer what a request means.

### Phase 1: Introduce Narrow Local Runtime Backends

**Goal:** Prove the abstraction against current local behavior before adding a remote implementation.

**Dependencies:** Phase 0 contracts and security decisions are approved.

**Scope and implementation:**

The initial implementation slice is underway:

- Added focused `WorkspaceFiles` and `WorkspaceSearch` Effect contracts plus
  the aggregate `WorkspaceRuntime` façade under
  `apps/server/src/workspace-runtime/`.
- Added a local adapter layer that delegates to the existing workspace file
  system and entry services without duplicating filesystem or search logic.
- Routed read-only preview, directory listing, filename search, and content
  search WebSocket handlers through the façade. Writes and watches remain on
  their existing services.
- Added a local runtime conformance test covering all four routed read
  surfaces.

1. Add `apps/server/src/workspace-runtime/` with narrow Effect services and a resolving façade.
2. Implement local adapters by delegating to existing filesystem, Git, process, PTY, watcher, and platform services. Do not duplicate local logic.
3. Route one low-risk local surface, such as text preview and directory listing, through the new contracts without changing public RPC results.
4. Add backend-neutral contract tests that can later execute against both local and remote implementations.
5. Preserve all current limits, typed errors, cancellation, path validation, and output truncation.
6. Keep existing public contracts in `packages/contracts` stable unless target-aware binary streaming requires an additive field.

**Likely files:**

- `apps/server/src/workspace-runtime/Services/`
- `apps/server/src/workspace-runtime/Layers/`
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`
- `apps/server/src/workspace/Layers/WorkspaceEntries.ts`
- Focused local conformance tests

**Exit criteria:**

- Selected local behavior runs through the new contracts with no user-visible change.
- Contract tests preserve existing bounds and errors.
- The interfaces remain narrow enough that Files does not depend on PTY or provider concepts.

### Phase 2: Establish The Rust Workspace And Versioned Protocol

**Goal:** Create the smallest secure agent and a language-neutral compatibility contract.

**Dependencies:** Phase 1 has proven the local contracts.

**Scope and implementation:**

Implemented foundation:

- Added a pinned Rust workspace with `bigbud-protocol` and
  `bigbud-remote-agent` crates, plus the schema-first protobuf source under
  `protocol/remote-agent/v1.proto` and its concern-specific imported schemas
  under `protocol/remote-agent/`.
- Added bounded four-byte length framing, major-version negotiation,
  capability hello, protocol errors, operation IDs/request digests, and
  shared Rust/TypeScript golden frames.
- Added workspace-open, bounded file/list/search, process acceptance/output/
  completion, and process-attach message families to the schema and codecs.
- Added Rust and TypeScript malformed-frame, unknown-field, digest-conflict,
  cancellation, and operation-registry tests.
- Split the Rust agent session, workspace, operation, journal, PTY, and
  supervisor modules so every authored Rust file is at or below 400 lines.
- Added descriptor-relative no-follow opens for agent file reads and content
  search, bounded search traversal, explicit environment policy, and a
  directory modification timestamp used by polling watches to detect same-size
  edits.

1. Add a Rust workspace and one binary crate, tentatively `crates/bigbud-workspace-agent`.
2. Keep the binary provider-neutral. Initial modules should cover protocol, handshake, workspace handles, operation registry, bounded spool, platform information, and controlled shutdown.
3. Use a schema-first, length-prefixed binary protocol over stdio. Prefer Protobuf unless a bounded Phase 0 comparison demonstrates a simpler encoding with equivalent generated TypeScript/Rust compatibility, binary payloads, forward compatibility, and golden fixtures.
4. Include protocol version range, agent version and digest, OS, architecture, path semantics, capability versions, limits, agent epoch, and installation identity in `hello`.
5. Establish an immutable canonical workspace-root handle after the local server requests a root. Do not send arbitrary roots with every file operation.
6. Define the operation state machine:

   ```text
   submitted -> accepted -> running -> completed
                                 |-> cancelling -> cancelled
                                 |-> failed
                                 |-> expired
   ```

7. Include `clientInstanceId`, `connectionId`, `workspaceHandle`, `operationId`, `operationKind`, request digest, correlation ID, deadline/TTL, and sequence metadata where applicable.
8. Add golden protocol fixtures consumed by Rust and TypeScript tests. Reject incompatible major versions and negotiate optional capabilities instead of assuming them.
9. Add frame, request, output, concurrency, process, spool, and retention limits from the first protocol version.
10. Keep control/completion records in a protected quota separate from bulk stream output.

**Likely files:**

- `Cargo.toml`
- `crates/bigbud-workspace-agent/Cargo.toml`
- `crates/bigbud-workspace-agent/src/`
- A schema source and generated TypeScript/Rust protocol package
- TypeScript protocol client tests

**Exit criteria:**

- TypeScript and Rust exchange `hello`, capabilities, one bounded diagnostic request, cancellation, and a terminal result through golden-tested frames.
- Incompatible versions fail with a stable actionable error.
- Fuzz/property tests reject malformed lengths, oversized frames, invalid state transitions, and operation-ID digest conflicts without unbounded allocation.

### Phase 3: Add Secure Installation, Proxy, And Supervisor Lifecycle

**Goal:** Install and reconnect to the agent through existing SSH credentials without exposing a remote network service.

**Dependencies:** Phase 2 protocol and artifact format are stable enough for a vertical slice.

**Scope and implementation:**

Initial lifecycle slice implemented:

- Added Linux x86_64/arm64 target detection and explicit unsupported-target
  handling.
- Added manifest parsing, target selection, SHA-256 verification, Ed25519
  trust-store verification, user-only path checks, restrictive permissions,
  and atomic versioned install-script generation.
- Added stdio process transport over the existing SSH command/session builder;
  it does not open a remote network listener or change SSH host-key policy.
- Added a same-user Unix-domain supervisor and stdio proxy. The SSH-facing
  proxy can reconnect to a stable agent epoch while the supervisor retains
  bounded operation state; direct stdio remains available for diagnostics and
  local testing.
- Added an explicit per-execution-target connection pool with single-flight
  connection establishment, transport-loss invalidation, epoch continuity
  checks, and typed workspace/process client resolvers. The pool is injectable
  and is not part of the default server composition yet.
- Added an opt-in live server composition behind
  `BIGBUD_REMOTE_AGENT_BINARY`. When configured, the server shares one
  per-target pool across Files/watch, Git, and shell adapters; without it, the
  existing composition is unchanged. Automatic installation and default
  cutover remain gated.
- Added an injectable installation coordinator that probes the SSH host, selects
  the matching signed-manifest artifact, delegates digest/signature verification
  to the atomic installer, and activates the versioned binary through the
  existing SSH command path. It does not change default routing or claim live
  clean-host handshake, upgrade, or rollback coverage.
- Added an explicit candidate check after activation. The installed binary
  reports its version, protocol, and build identity through `--check`; the
  coordinator validates that response and runs a bounded rollback script when
  activation or candidate verification fails. A clean install with no previous
  link remains safe because rollback is a no-op when there is no prior target.
- Agent hello metadata is now retained per execution target, including the
  build identity, advertised capabilities, and negotiated resource limits.
  Workspace, process, and PTY client resolvers reject targets that do not
  advertise the capability they require instead of sending unsupported frames.
- Access-gate integration and live clean-host/upgrade/rollback coverage remain
  explicit Phase 3 gates; installation is not treated as successful merely
  because activation returned.
- When the opt-in agent composition is enabled, the existing execution-target
  verification RPC now performs the SSH check and then requires a complete
  agent hello before reporting the target ready. SSH-only verification remains
  unchanged when the agent composition is not configured.

1. Detect remote OS and architecture through the verified SSH target.
2. Select a release artifact from a signed manifest containing agent version, protocol range, target triple, URL or bundled path, size, SHA-256, and signature metadata.
3. Upload to a user-owned temporary path, verify digest/signature remotely or before upload as appropriate, set restrictive permissions, and atomically rename into a versioned `~/.bigbud/agent/bin/` path.
4. Refuse existing installation or state paths owned by another user or writable by group/others.
5. Launch a short-lived SSH proxy over stdio. The proxy connects to a detached, same-user supervisor through a user-only Unix socket or Windows named pipe when that platform is supported.
6. Do not open a TCP listener. Do not weaken `StrictHostKeyChecking`, replace the user's SSH configuration, or write credentials into agent state.
7. Give each agent boot an epoch. A changed epoch invalidates assumptions about running operations and requires explicit unknown/expired outcomes.
8. Use leases and bounded TTL cleanup for abandoned sessions, sockets, processes, binaries, and spool files.
9. Retain the previous compatible binary until the new version completes a handshake, enabling rollback.
10. Integrate installation and connection status with the existing remote access gate and actionable SSH errors.

**Likely files:**

- `apps/server/src/remote-agent/`
- Existing `apps/server/src/ssh/` bootstrap and verification modules
- Agent install/session state under the remote user's `~/.bigbud/agent/`
- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- Release artifact and manifest scripts

**Exit criteria:**

- A supported clean host can install, verify, launch, handshake, reconnect, upgrade, and roll back the agent using its existing SSH target.
- Unsupported platforms and failed verification remain on the existing direct-SSH path without mutating the project target.
- The agent exposes no network listener and all state paths are user-only.

### Phase 4: Deliver Root-Confined Files And Search Parity

**Goal:** Ship an independently useful read-mostly vertical slice and close the largest Files-panel gaps.

**Dependencies:** Phases 1-3 pass security and compatibility gates.

**Scope and implementation:**

Read-mostly slice implemented:

- Added Rust root handles with lexical traversal rejection, symlink-component
  rejection, bounded ranged/binary reads, directory limits, ignored-directory
  traversal, filename entry kinds, and bounded UTF-8 content matches.
- Directory enumeration now uses the already-open root-relative directory
  descriptor and `fstatat(..., AT_SYMLINK_NOFOLLOW)` on Unix, closing the
  remaining resolve-then-enumerate race for read-only directory listings.
- Added TypeScript workspace client/runtime adapters that preserve existing
  preview, directory, filename-search, and content-search result shapes.
- Added manual local-binary exchange validation for handshake, workspace open,
  and bounded file read through the framed stdio transport.
- Added a bounded byte-range contract and target-aware workspace preview route.
  Remote previews aggregate agent chunks within a 32 MiB HTTP budget, preserve
  `Range`/`Content-Range` behavior, carry the execution target through Files
  preview URLs, and use the existing SSH transport when no explicit agent
  backend is composed. Local preview serving remains unchanged.
- Restored the existing SSH transport as a read-only fallback for remote
  directory listing and bounded text previews when the opt-in agent backend is
  not configured. Agent-backed Files operations remain selected whenever the
  configured agent advertises the required capability.
- Hardened the SSH fallback command boundary so `find` receives escaped
  printf separators rather than an illegal NUL process argument. Remote
  content search keeps the remote root remote instead of checking it against
  the local filesystem, and reports an actionable error when host `rg` is
  unavailable.
- Remote direct-directory expansion now uses a bounded depth-one `find`
  request instead of consuming the recursive workspace-search index. Large
  home directories therefore retain later dotfiles and dot directories in
  the Files panel instead of losing them when the recursive scan reaches its
  output bound.
- Added bounded SSH base64 range reads for remote binary previews when the
  agent is absent. The HTTP range route selects the agent backend when
  available and the SSH-backed workspace runtime otherwise.
- Read-only agent operations now reopen the workspace and retry once after a
  transport failure using the same operation IDs/digests; writes retain the
  explicit unknown-outcome/no-retry rule.
- Added a bounded remote write request that creates missing parents and uses a
  same-directory temporary file plus atomic rename. Failed writes do not
  poison the operation ID; accepted writes are never retried by the client.
- Added an optional expected SHA-256 precondition to local and agent-backed
  writes. Stale versions return a typed write conflict with the current digest;
  a transport loss before the response returns `UNKNOWN_OUTCOME` without a
  retry; disconnect-resume during a write remains a later gate.
- Unix agent writes now create missing parents with `mkdirat`, stage bytes with
  `openat`, replace the target with `renameat`, and sync the parent directory.
  The target lock and expected-hash check remain bounded and user-owned; true
  cross-process compare-and-swap semantics are still called out as a later
  write gate.

1. Implement root-scoped `stat`, ranged/binary read, directory list, bounded path index, glob, and content search.
2. Resolve paths on the remote host using remote path semantics. Reject NULs, disallowed absolute paths, lexical traversal, and symlink-assisted escapes according to the Phase 0 policy.
3. Preserve current text-preview size, encoding, truncation, search-count, output-byte, ignored-directory, and timeout behavior.
4. Add resumable byte streaming with sequence acknowledgements and explicit retained-range errors.
5. Add target-aware binary streaming to the workspace HTTP route so image, PDF, video, and binary preview can read agent-backed files without exposing the agent directly to the renderer.
6. Route remote `WorkspaceFileSystem` and `WorkspaceEntries` reads through the agent backend while retaining direct SSH as pre-acceptance fallback.
7. Cache bounded remote indexes locally and invalidate them deliberately. Do not introduce a permanent remote project database.
8. Add atomic write with expected hash/version only after read confinement and replay behavior are proven. Write to a sibling temporary file, fsync where supported, and rename atomically.
9. Return `UNKNOWN_OUTCOME` if the agent cannot prove whether a mutation was accepted or completed. Never create a new operation ID automatically to retry it.

**Likely files:**

- Rust filesystem and search modules
- `apps/server/src/workspace-runtime/Layers/WorkspaceRuntime.agent.ts`
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`
- `apps/server/src/workspace/Layers/WorkspaceEntries.ts`
- `apps/server/src/ws/http.workspace.ts`
- `apps/web/src/lib/workspaceFilePreview.ts`
- Files-panel preview components and tests

The initial binary-preview and bounded atomic-write slices are implemented;
expected-hash conflicts and full write disconnect-resume coverage remain gated
on the write/replay design. Read reconnect coverage is now explicit and
covered by a runtime adapter test.

**Exit criteria:**

- Remote text and binary preview, directory listing, filename search, content search, and atomic write match the approved local contract.
- Path escape and spool-limit tests pass on every supported remote platform.
- Disconnecting during a read resumes within retained ranges without duplicated or missing bytes.

### Phase 5: Prove Resumable Process Operations

**Goal:** Establish correct attach/replay behavior before routing Git, shell, PTY, or provider tools through the agent.

**Dependencies:** The supervisor survives proxy loss and the spool is bounded.

**Scope and implementation:**

Initial process slice implemented:

- Added a bounded process runner with separate stdout/stderr capture,
  timeout termination, output truncation, operation acceptance, output
  sequence retention, replay-gap reporting, terminal retention, and attach
  responses.
- Added TypeScript process client support and manual local-binary validation
  for output, terminal completion, and replay after completion.
- Added explicit process stdin/environment fields, Unix process-group timeout
  cleanup, client-side sequence deduplication, and a supervisor/proxy manual
  exchange covering handshake, workspace open, and process completion.

The supervisor/proxy boundary, detached Unix process-group cleanup, and a
user-only size-bounded operation journal are now implemented. Journal records
reconstruct accepted output and terminal metadata on startup; non-terminal
operations are explicitly marked expired with `AGENT_RESTARTED` rather than
being presented as still running. Journal compaction now reclaims acknowledged
output through sequence watermarks without resetting replay ranges. Supervisor
process execution now runs outside the session lock, so control requests and
cancellation can mark the running process while it is still executing; direct
stdio remains synchronous for diagnostics. Incremental output delivery,
running-operation attach status, live proxy handoff, and idempotent
cancellation are covered by focused tests and rebuilt-binary supervisor smoke
tests. Wall-clock retention deadlines are now persisted in the journal and
replayed without extending expired results. Accepted process clients now use a
bounded reconnect-by-attach path from the last acknowledged sequence; they
never rerun a request after acceptance. Failure injection across every
transport boundary and the remaining process resource quotas remain gated
before claiming full Phase 5 exit.

Repeated Git and shell dispatches now receive fresh operation IDs unless an
explicit retry ID is supplied. Shared connection process streams are
demultiplexed by operation ID, and duplicate process requests replay retained
output before terminal completion.

1. Implement non-interactive process spawn with cwd, an allowlisted environment, stdin, separate stdout/stderr, timeout, output bounds, cancellation, and process-tree cleanup.
2. Assign stable operation IDs and enforce at-most-once acceptance for `(clientInstanceId, operationId)`.
3. Reject reuse of an operation ID with a different request digest as `OPERATION_ID_CONFLICT`.
4. Sequence output per operation. Treat acknowledgement as the highest contiguous sequence durably consumed by the local server.
5. Permit duplicate replay after reconnect and require the TypeScript client to deduplicate and detect gaps.
6. Persist only bounded unacknowledged output and immutable terminal metadata under user-only remote state.
7. Return running, completed, expired, or unknown on attach. Never convert unknown into an automatic rerun.
8. Make cancellation idempotent and report success only after the process tree is reaped or a winning terminal state is known.
9. Distinguish execution deadline, idle timeout, transport timeout, disconnect grace period, and result-retention TTL.
10. Test with diagnostic commands before enabling arbitrary provider shell operations.

**Exit criteria:**

- Failure injection before acceptance, after acceptance, during output, during cancellation, and after completion produces the specified deterministic outcome.
- Reconnect replays every retained sequence once to the local consumer after deduplication.
- Overflow emits an explicit gap/range error without losing completion or cancellation metadata.
- Agent restart reports unknown/expired honestly instead of fabricating continuity.

### Phase 6: Route Shell And Git Through The Runtime

**Goal:** Provide first-class remote Git and bounded shell behavior through the same backend used locally.

**Dependencies:** Phase 5 process semantics and uncertain outcomes are proven.

**Scope and implementation:**

The first shell routing slice is now injectable: `wsShellDispatch` selects an
optional remote process-backed shell runner for non-local execution targets,
while local shell behavior and the explicit unsupported-target error remain
unchanged. The runner opens the canonical workspace handle, executes through
`/bin/sh -lc`, bounds the process through the existing agent contract, and
supports cancellation through the process client. Production agent
installation/pool composition remains a later lifecycle gate.

The read-only Git path now has the same injectable composition boundary:
remote execution reuses the existing Git parsers through the agent process
client, and remote Git-status subscriptions emit an initial target-aware
snapshot followed by change-only, bounded polling updates. Local Git status
continues to use its existing broadcaster. A shared remote-agent composition
factory now keeps Files, Git, and shell adapters on one per-target connection
pool; server-wide production wiring is intentionally still gated on install,
artifact selection, and rollback behavior.

The first mutation slice is now target-aware as well: branch create, checkout,
rename, delete, upstream setup, repository initialization, explicit-path
worktree create/remove, fetch, pull, discard, commit, and push can execute
through the composed agent executor. The stacked commit/push workflow carries
the workspace target and never falls back to the local path. Pull-request
creation remains explicitly local because its GitHub CLI and canonical PR
state are local integrations. If the agent backend is not composed, every
target-aware mutation fails with the existing unsupported-target error rather
than reading a synthetic local cwd.

The no-agent composition now supplies the existing SSH transport as a
read-only Git fallback. Status, branches, diffs, logs, commit details, and
other read surfaces reuse the existing Git parsers, so remote Git history is
available without requiring the optional agent. Mutating Git commands remain
rejected by this fallback and require the agent-backed executor.

1. Refactor the Git executor below existing parsing and higher-level Git services so local and agent backends share result semantics.
2. Ship read-only Git first: repository discovery, status, status details, diffs, branches, upstreams, logs, commit details, worktree listing, and remote metadata.
3. Enable remote Git status subscriptions by polling or watcher invalidation with bounded coalescing before relying on lossless watch delivery.
4. Add mutations one class at a time: stage/unstage, discard, branch operations, checkout, worktrees, commit, fetch, pull, and push.
5. Define operation-specific idempotency and unknown-outcome UX. Commit, push, append, patch, rename, checkout, worktree creation, and process spawn must not share one generic retry rule.
6. Preserve remote Git hooks and credentials as remote-host behavior. Surface non-interactive prompt failures rather than forwarding local credentials silently.
7. Route orchestration shell dispatch through `WorkspaceProcess` while preserving local approval/runtime-mode enforcement.
8. Keep unrestricted shell access explicitly separate from root-confined Files methods.

**Likely files:**

- `apps/server/src/git/Layers/GitCore.ts`
- `apps/server/src/git/Layers/GitCoreExecutor.ts`
- `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts`
- `apps/server/src/ws/wsShellDispatch.ts`
- Rust process and Git capability modules
- Git and shell conformance tests

**Exit criteria:**

- Approved remote Git operations match local parsing, errors, bounds, and UI behavior.
- Remote Git status subscriptions use bounded invalidation polling and no longer
  reject supported non-local execution targets at the WebSocket boundary.
- The implemented remote mutation slice routes branch, checkout, init,
  explicit-path worktree, fetch, pull, discard, commit, and push operations
  through the agent executor, with no local-path fallback when the executor is
  unavailable. PR creation remains a later local-authority integration gate.
- Mutating operations never retry automatically after an unknown outcome.
- Remote Git status, diff, branch, history, and worktree surfaces no longer require terminal use where local bigbud provides a first-class surface.

### Phase 7: Add Watch Invalidations And PTY Reattachment

**Goal:** Complete interactive Files and terminal parity without treating lossy streams as canonical state.

**Dependencies:** Process sequencing, supervisor cleanup, and resource quotas are stable.

Initial watcher slice implemented:

- Added a separate `WorkspaceWatch` runtime capability so watcher callers do
  not depend on PTY, process, or provider services.
- Routed the existing WebSocket directory subscription through the target-aware
  `WorkspaceRuntime` façade while preserving local `fs.watch` behavior.
- Added an agent-backed bounded polling watcher over root-scoped directory
  listing. It emits generation-tagged change-only invalidations, coalesces
  unchanged snapshots, emits `rescanRequired` after transport loss and agent
  recovery, and closes after its lease expires.
- Added focused tests for initial snapshots, stable polling, changes,
  transport recovery, and lease expiry.

The server-side watcher and terminal slices are now composed behind the
configured agent backend. The server advertises the opt-in watcher capability
in its config snapshot, and the Files panel enables remote subscriptions only
when that signal is present; direct-SSH fallback remains suppressed. Full
Phase 7 completion remains gated on native agent-owned filesystem watch
delivery, exhaustive failure injection, and live SSH/platform coverage.

PTY slice implemented:

- Added versioned PTY create/input/output/ack/resize/signal/attach/close/exit
  frames with bounded sequence replay and explicit gaps.
- Added a Unix `forkpty` agent backend with root-confined cwd, explicit
  environment allowlisting, process-group cleanup, input deduplication, and
  bounded output retention.
- Added a TypeScript terminal adapter with reconnect-by-attach that never
  reruns an accepted shell, and composed it behind the opt-in agent pool.

**Scope and implementation:**

1. Implement watcher subscriptions with generation IDs, coalescing, leases, cancellation, and `RESCAN_REQUIRED` after reconnect, overflow, agent restart, or detected gaps.
2. Gate web-side remote watcher subscriptions on the server capability signal
   only after server subscriptions can rescan safely; native watch delivery is
   still a later optimization.
3. Implement agent-owned PTYs with stable IDs, input and output sequences, resize, signal, EOF, detach, attach, close, and process-tree termination.
4. Deduplicate retransmitted input using a separate monotonically increasing input sequence so reconnect cannot duplicate keystrokes or stdin bytes.
5. Keep a bounded terminal-output ring and emit explicit replay-gap metadata when older output is unavailable.
6. Reuse the existing terminal manager and history ownership through an agent-backed `PtyProcess` adapter.
7. Define local UI close, project switch, SSH loss, explicit terminal close, app shutdown, and remote TTL as distinct lifecycle events.
8. Treat PTY replay as output history, not full terminal-screen reconstruction. Add snapshots later only if measured UX requires them.

**Likely files:**

- Rust watch and PTY modules
- `apps/server/src/terminal/Services/PTY.ts`
- `apps/server/src/terminal/Layers/Manager.remote.ts`
- `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`
- Files refresh hooks
- Terminal reconnect and history tests

**Exit criteria:**

- Remote file changes invalidate the Files UI and trigger bounded rescans after gaps.
- A PTY survives transient SSH proxy loss and reattaches without duplicated input.
- Closing a viewer does not kill a PTY unless the defined lifecycle requests termination.

### Phase 8: Normalize Every Local Provider Integration

**Goal:** Give every provider a tested path to the same remote workspace semantics while keeping provider state local.

**Dependencies:** The required runtime capabilities are stable and existing Files/Git consumers have proven them.

**Scope and implementation:**

1. Create provider-neutral local workspace tool adapters backed by the narrow runtime contracts.
2. Keep provider protocol translation in TypeScript. The Rust agent must never parse provider messages or know provider names.
3. Migrate provider integration modes separately:
   - MCP-backed providers call a local generic MCP server backed by `WorkspaceRuntime` instead of generated direct-SSH code.
   - Session-filesystem providers implement their filesystem contract through `WorkspaceFiles` and `WorkspaceSearch`.
   - Built-in overrides call the same runtime adapters.
   - Custom extensions/tools call the same runtime adapters.
4. Preserve provider-specific safety and semantic differences. Do not widen Claude's current remote write behavior, disable a built-in, or claim shell support merely to make matrices look identical.
5. Add conformance suites for Codex, Claude, Copilot, OpenCode, KiloCode, Pi, Devin, Cursor, and every future registered provider.
6. Audit Devin's declared support before migration and enable Cursor only after its custom integration actually routes remote operations correctly.
7. Use semantic parity, not identical native APIs: the same user task should read, edit, search, and execute against the intended remote workspace with equivalent approvals and errors.
8. Roll providers onto the agent independently behind provider/execution-target flags. Keep legacy bridges until each provider passes its conformance gate and soak period.

**Likely files:**

- `apps/server/src/remote-workspace-bridge/`
- Provider-specific remote workspace bridge modules
- Provider session start paths
- `apps/server/src/provider/providerCapabilities.ts`
- Shared provider-neutral workspace tool adapters and conformance tests

**Exit criteria:**

- Every enabled provider has authoritative tests for its declared remote workspace capabilities.
- No provider receives SSH arguments, credentials, agent resume tokens, or direct protocol access.
- Provider processes, state, credentials, approvals, and normalized events remain local.
- Unsupported provider operations fail explicitly rather than accessing the synthetic local workspace accidentally.

Provider audit update:

- Cursor remains explicitly unsupported for remote workspace execution.
- Devin is now also explicitly unsupported: its ACP adapter resolves a local
  `cwd` and has no remote workspace bridge. Its capability declaration will be
  revisited only after the adapter uses the provider-neutral runtime.
- `providerRemoteWorkspaceConformance.ts` is now the authoritative matrix:
  Codex, Claude, Copilot, OpenCode, KiloCode, Pi, and optional CLIProxy remain
  on legacy SSH bridges; Cursor and Devin are explicitly unsupported. Provider
  capability declarations derive from this matrix so support cannot drift from
  the declared backend.

### Phase 9: Default Cutover, Soak, And Legacy Retirement

**Goal:** Make the agent the normal remote workspace backend only after parity and rollback are proven.

**Dependencies:** Security review, supported-platform artifacts, operation reliability, and provider conformance gates pass.

**Scope and implementation:**

1. Enable agent transport by default for supported targets while retaining explicit direct-SSH fallback.
2. Allow fallback only before the agent accepts an operation. Never fall back after ambiguous acceptance or generate a new mutation ID automatically.
3. Measure install success, handshake compatibility, reconnect count, replay bytes, gaps, operation latency, spool usage, cancellation latency, unknown outcomes, and fallback rate without sensitive payloads.
4. Retain the previous compatible agent binary and a user-visible repair/reinstall path.
5. Soak read-only Files, search, and Git before mutations; soak process operations before PTYs; soak each provider independently.
6. Remove duplicated direct-SSH bridges only when their replacement meets the same capability matrix on every claimed platform and the fallback rate is acceptably low.
7. Keep a small diagnostic direct-SSH path for agent repair even after workspace operations stop using direct commands.
8. Update README, remote-project documentation, troubleshooting, release documentation, and changelog only when behavior ships.

**Exit criteria:**

- Supported SSH projects use the agent by default with no local-project regression.
- Rollback to the previous agent and direct-SSH fallback are tested.
- Duplicate provider bridges are removed only after their provider-specific gates pass.
- User documentation accurately distinguishes reconnectable remote operations from local-provider continuity during laptop suspension.

## Risks And Decision Gates

- **Local provider continuity:** A remote agent cannot keep a local provider running while the local machine sleeps or powers off. This plan promises remote operation reconnect, not uninterrupted offline AI execution.
- **Persistent supervisor scope:** Attach/replay requires a detached same-user supervisor. If the design remains a plain SSH stdio child, process and PTY survival across transport loss is a no-go.
- **Remote temporary state:** Canonical state remains local, but resumability requires bounded remote operation metadata and unacknowledged output. If no remote disk state is acceptable, resumability must be narrowed to connection recreation without process/output survival.
- **Unknown outcomes:** At-most-once acceptance is achievable while dedupe state exists; exactly once is not. Agent state loss after a mutation may produce `UNKNOWN_OUTCOME`. The UI and callers must not conceal it.
- **Workspace confinement:** String normalization alone is insufficient. Root handles, remote path semantics, symlink policy, ownership checks, and adversarial tests are release gates. Arbitrary shell remains intentionally outside file-API confinement.
- **Provider parity:** “All providers” is a final target, not permission for a single generic bridge to erase provider differences. No provider capability flag changes until its real adapter passes conformance tests.
- **Devin and Cursor:** Current declarations and implementations require audit. Do not plan around unsupported behavior or make optimistic capability claims.
- **Protocol choice:** The protocol must support binary streams, generated Rust/TypeScript types, bounded framing, version negotiation, and golden fixtures. If Protobuf introduces unacceptable build or distribution complexity, decide the alternative in Phase 0 rather than changing wire format after release.
- **Supply chain:** Automated installation is blocked until signed/checksummed artifacts, atomic installation, host ownership checks, and rollback are implemented.
- **Remote platform matrix:** Artifact availability follows the remote host, not the desktop host. Do not claim Linux arm64, macOS, or Windows remote support until that target has live SSH integration coverage.
- **Git credentials and hooks:** Git executes as the remote SSH user and may invoke hooks. Interactive credential prompts cannot be assumed. This must be documented and tested without forwarding provider or local application secrets.
- **Environment leakage:** Never forward `process.env` wholesale. Define per-operation environment allowlists and redact audit metadata.
- **Spool sensitivity:** Source text, terminal output, Git output, and process output may contain secrets. Use user-only permissions, strict quotas, short TTLs, and no content telemetry. Secure deletion cannot be guaranteed on every filesystem.
- **Resource exhaustion:** A disconnected client cannot create unbounded output or orphan processes. Per-user, per-session, and per-operation quotas are mandatory before process or PTY rollout.
- **Agent upgrades:** Do not replace an in-use binary or supervisor blindly. New sessions may use the new version while old operations drain under the previous compatible version.
- **Fallback ambiguity:** Fallback is safe only before acceptance is known to be absent. After uncertain submission, surface status and recovery actions instead of executing through legacy SSH.
- **Scope control:** Files/search, resumable process execution, Git, watchers, PTYs, and all providers are separate gates. A failure in a later phase must not block shipping an independently safe earlier phase.

## Testing And Validation

Current implementation-slice validation (23 August 2026):

- `bun fmt` passed.
- `bun lint` passed with the same three existing repository warnings only.
- The latest complete `bun run test` passed all 9 Turbo tasks: 551 server test
  files passed, 2 were skipped, and 2,148 server tests passed with 2 skipped.
- The full suite also passed after the 400-line source splits and rollback-test
  correction; no remote-agent-related test failed.
- `bun typecheck` passed with two existing non-fatal Effect language-service
  diagnostics in `PluginRegistry.ts` and `server.test.app.ts`.
- Focused workspace/runtime, remote Git, remote shell, HTTP preview, and web
  preview Vitest suites passed.
- Focused remote-agent/workspace-runtime Vitest coverage now includes protocol,
  artifact, transport, lifecycle-pool, process-client, Git-adapter,
  workspace-runtime, shell, binary-preview, and bounded remote watcher paths.
- Process-client failure-injection coverage now verifies that transport loss
  before acceptance is surfaced without reconnect, accepted operations resume
  through attach after acknowledgement transport loss, and cancellation waits
  for a terminal cancellation result rather than reporting success at request
  acceptance time.
- Rust workspace format, tests, and clippy passed; the workspace currently
  covers 38 remote-agent tests plus 4 protocol tests, including partial-tail
  journal recovery, expiration-aware compaction and restart replay, byte and
  concurrency bounds, PTY create deduplication, process groups, incremental
  output, and cancellation coverage.
- Workspace operation identities are fresh per user action and remain stable
  only across an in-flight retry. Retryable reads release their transient
  identity slots, while mutation and PTY identities retain bounded dedupe
  windows.
- A local built `bigbud-remote-agent` binary was exercised through the
  TypeScript stdio and supervisor-proxy clients for hello, workspace open,
  bounded file read, explicit process input/environment, process output,
  terminal completion, completed-operation replay, supervisor cancellation
  while a process was still running, and a second proxy attaching to a live
  operation from its last contiguous acknowledgement.
- Release CI verifies the exact packaged x86_64 and arm64 assets against the
  generated signed manifest before publication. Local tests cover signature,
  byte-integrity, duplicate-target, activation, and rollback metadata.
- The provider conformance matrix is tested for every registered provider,
  including optional CLIProxy registration.

### Contract and protocol tests

- Run the same runtime conformance suite against the local backend and every supported agent backend.
- Add golden Rust/TypeScript fixtures for handshake, request, acceptance, stream, acknowledgement, cancellation, completion, expiration, gaps, and unknown outcomes.
- Add compatibility tests for current/current, current/previous, optional capability absence, and rejected major versions.
- Fuzz frame lengths, malformed payloads, invalid operation transitions, oversized fields, sequence gaps, request-digest conflicts, and decompression/allocation limits if compression is introduced.

### Security tests

- Reject `..`, absolute paths where prohibited, NULs, mixed separators, invalid encodings, reserved paths, symlink escapes, root replacement, inode/device swaps, and state paths with unsafe ownership or permissions.
- Verify SSH installation and runtime preserve host-key checking and the configured SSH destination.
- Verify artifact digest/signature failure leaves the previous binary untouched.
- Verify environment allowlists never expose provider keys, bigbud auth tokens, SSH passphrases, or unrelated local variables.
- Verify operation authorization and runtime mode are enforced locally before dispatch.

### Reconnect and failure-injection tests

- Drop SSH before acceptance, after acceptance, during stdin, during stdout/stderr, during file transfer, during cancellation, and after remote completion but before local acknowledgement.
- Reconnect with the last contiguous acknowledgement and verify duplicates are deduplicated, retained data has no gaps, and unretained ranges produce explicit errors.
- Kill the proxy without killing the supervisor; kill the supervisor; restart the agent; change the agent epoch; exhaust spool quota; fill remote disk; and expire an operation result.
- Verify mutations with the same operation ID do not execute twice and conflicting request digests fail.
- Verify no automatic fallback occurs after ambiguous acceptance.

### Files and search tests

- Preserve existing 5 MiB text-preview bounds, UTF-8 behavior, truncation, search-result bounds, ignored directories, timeout behavior, and typed errors.
- Test binary/ranged reads, image/PDF/video routes, atomic writes, expected-hash conflicts, partial uploads, remote deletion, and reconnect during transfer.
- Test watcher coalescing, leases, overflow, reconnect, `RESCAN_REQUIRED`, and cache invalidation.

### Git tests

- Run Git executor conformance for status, details, diff, branches, history, remotes, worktrees, timeout, cancellation, progress, output truncation, and nonzero exits.
- Test each mutation's operation-ID behavior and unknown-outcome handling.
- Test remote hooks, missing credentials, non-interactive prompts, detached heads, bare repositories, submodules, worktrees, large diffs, and repository replacement.

### Process and PTY tests

- Test process groups, grandchildren, signals, timeout races, cancellation races, stdin sequencing, EOF, separate stdout/stderr, output overflow, and terminal-result retention.
- Test PTY create, input, output, resize, signal, detach, attach, close, reconnect, replay gaps, and local terminal history integration.
- Test Linux x86_64 and arm64 first, then add equivalent live SSH coverage before each additional platform claim.

### Provider conformance tests

- Add provider-specific suites for MCP, session filesystem, built-in overrides, and custom tool/extension modes.
- Verify each provider reads and edits the remote workspace rather than the synthetic local bridge directory.
- Verify local provider credentials, state, approvals, and events never enter the remote agent protocol or spool.
- Verify unsupported operations fail explicitly and capability metadata matches real behavior.
- Validate every registered provider independently before claiming complete provider support.

### Performance and resource validation

- Measure cold install, warm connection, handshake, first operation, small-file read, search, Git status, reconnect, and replay latency against current direct SSH.
- Define and enforce idle RSS, peak RSS, binary size, spool bytes, open files, process count, watch count, concurrent operation count, and cleanup latency budgets before default cutover.
- Test high-latency, packet-loss, and bandwidth-constrained SSH links.

### Repository commands

- Add Rust formatting, linting, unit tests, and target builds to CI using pinned toolchains.
- Run focused Rust and TypeScript suites during each phase.
- Run `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` before implementation completion. Never run `bun test`.
- Run packaged artifact verification for every claimed remote target.

### Manual validation

- Add, edit, reconnect, and remove an SSH project using keys, an agent/default identity, an explicit key, a passphrase, a password session, a custom port, an SSH alias, and a jump host.
- Disconnect and restore the network during Files reads, search, Git status, a bounded process, a mutation, watcher activity, and a terminal.
- Restart the renderer while the local server remains running and verify active remote operations remain coherent.
- Suspend the local machine and confirm the UI accurately communicates that local providers pause even if a remote tool operation remains retained.
- Upgrade and roll back the agent while old operations drain.
- Verify direct-SSH fallback on unsupported hosts and agent repair after corrupted installation.

## Acceptance Criteria

- bigbud has narrow provider-neutral runtime contracts with local and agent-backed implementations.
- Provider processes, credentials, state, and approvals remain local for agent-backed local-runtime/remote-workspace sessions; orchestration and canonical SQLite state remain local in every agent-backed session.
- The remote agent has no provider-specific code and exposes no network listener by default.
- Supported SSH hosts require no Bun, Node.js, Electron, Docker, or remote bigbud server installation.
- Agent artifacts are versioned, signed/checksummed, atomically installed, permission-checked, and rollback-capable.
- Remote filesystem, search, Git, process, terminal, watch, and platform operations meet their approved local semantic contracts on each claimed platform.
- Root-confined file operations reject lexical and symlink-assisted workspace escapes according to the documented policy.
- Accepted operations have stable IDs, immutable terminal states, bounded replay, contiguous acknowledgements, idempotent cancellation, and explicit gap/expired/unknown outcomes.
- A transient SSH proxy loss can reconnect and attach to retained operations without blindly rerunning them.
- No mutating operation is automatically retried after an uncertain outcome.
- Remote resource usage remains within defined memory, disk, process, watch, output, and retention limits.
- Every registered provider has a provider-specific conformance result before its remote workspace capability is claimed.
- Existing SSH project identifiers and saved projects require no irreversible migration for the initial rollout.
- Direct SSH remains available as a pre-acceptance fallback until the agent path passes its soak and rollback gates.
- User-facing documentation distinguishes remote operation resumability from local-provider execution during laptop suspension.
- `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, Rust formatting/lint/tests, live SSH integration tests, and artifact verification pass before the broad rollout is considered complete.

## Open Questions

- Should the first supported remote targets be Linux x86_64 and arm64 only, or must macOS and Windows remote hosts be included in the first release?
- Is a small disk-backed remote spool acceptable as temporary delivery state, or must the first release limit resumability to an in-memory reconnect window?
- What disconnect grace period and completed-result retention TTL should apply to file/process operations and PTYs?
- What are the initial per-user and per-operation spool, process, watch, and concurrency budgets?
- Should users explicitly enable the experimental agent per SSH project, or should supported targets attempt installation automatically behind a global experimental setting?
- Should the first vertical slice permit writes, or ship read-only Files/search until confinement and replay telemetry have soaked?
- Should general shell execution be agent-backed in the first process release, or remain direct SSH until Git and bounded diagnostic processes prove the lifecycle?
- Which Git mutations are required for the first parity milestone, and how should the UI present `UNKNOWN_OUTCOME` for commit, checkout, worktree, push, and pull?
- Should remote PTYs survive only SSH transport loss, or also local bigbud server restart? The latter requires locally persisted attachment metadata and does not preserve a local provider process.
- Where should the protocol schema and generated TypeScript/Rust code live so it follows explicit subpath exports without turning `packages/contracts` into a runtime package?
- Should remote agent binaries be bundled with desktop artifacts, downloaded from release storage, or support both for offline hosts?
- What signing scheme and key-rotation process should protect the remote-agent manifest and binaries?
- How should multiple local bigbud installations belonging to the same remote Unix user isolate workspace handles, resume tokens, quotas, and cleanup?
- Should old compatible agents drain existing operations across upgrades, or should upgrades wait until the supervisor reports no active operations?
- Which telemetry is acceptable for rollout decisions while guaranteeing that file contents, command input/output, paths, and credentials are not collected?
- Should an issue or project Kanban card be created to track the multi-release phases and decision gates in this plan?
