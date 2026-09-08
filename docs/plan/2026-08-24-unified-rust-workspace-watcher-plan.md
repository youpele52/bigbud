# Unified Rust Workspace Watcher Implementation Plan

**Date:** 24 August, 2026
**Status:** Source implementation complete; Phase 6 external release gate blocked
**Owner:** bigbud team

## Summary

Make the existing Rust workspace watcher authoritative for local and managed-remote projects. Run one long-lived local `bigbud-remote-agent` process per TypeScript server over framed stdio, while managed remote hosts continue running the same binary over SSH. Extract the watcher into `bigbud-workspace-watch` so both modes use one implementation for native events, polling fallback, reconciliation, batching, generations, sequences, resource bounds, and recovery.

Do not create a second local-service executable. The existing binary already supports local stdio through `RemoteAgentConnection.local()` and multiplexes asynchronous watcher frames. Add an ephemeral local mode and supervise one connection per server.

TypeScript remains responsible for authorization, process supervision, capability negotiation, subscription routing, and forwarding events. It must not detect, debounce, snapshot, or sequence local or managed-remote filesystem changes. The web layer retains the existing active-preview-first refresh policy.

Direct SSH remains the explicit exception: without code running on the remote host, it cannot receive native remote filesystem events and continues using bounded compatibility polling.

Implementation work completed on 24 August, 2026. The Node local watcher and rollout flag are removed; local and managed-remote watcher mechanics now come exclusively from `bigbud-workspace-watch`. Cross-platform artifact gates are implemented for desktop and standalone server distributions. Their macOS arm64/x64, Linux x64, and Windows x64 runner results remain an external release blocker until those runners complete successfully; this document does not treat unrun platform smoke checks as evidence.

```text
Web Files panel
  active preview + watched tree directories
                         |
                         v
TypeScript WorkspaceWatch routing
  authorization + supervision + event forwarding
              |                              |
              | local framed stdio           | SSH proxy
              v                              v
bigbud-remote-agent                 bigbud-remote-agent
one process per server              one supervisor per remote host
              |                              |
              +--------------+---------------+
                             |
                  bigbud-workspace-watch
                  one Rust implementation
                             |
              +--------------+---------------+
              v                              v
       Local filesystem               Remote filesystem
```

## Related Work

- [Rust Remote Workspace Agent Plan](/Users/youpele/DevWorld/bigbud/docs/plan/2026-08-22-rust-remote-workspace-agent-plan.md) defines the local-authority and remote-agent boundary this plan extends.
- [Local Authority And Remote Workspace Agent Boundary](/Users/youpele/DevWorld/bigbud/docs/decisions/2026-08-22-rust-remote-workspace-agent-boundary.md) records why canonical state and provider processes remain local.
- No verified Kanban card, repository issue, or pull request is linked to this plan.

## Problem

bigbud currently has three watcher paths:

- Local projects use `node:fs/promises.watch` in `apps/server/src/workspace/Layers/WorkspaceFileSystem.ts`. It is native and efficient, but its coarse version-1 events, debounce, lifecycle, and recovery semantics differ from Rust.
- Managed remote projects use `WorkspaceWatchRegistry` under `crates/bigbud-remote-agent/src/workspace/`. Rust owns exact-path reconciliation, a 100 ms batch window, native-or-poll backend choice, generations, sequences, capacity bounds, and invalidation recovery.
- Direct-SSH projects use one-second TypeScript metadata polling in `WorkspaceFileSystem.remoteWatch.ts` because no agent runs on the remote host.

The local and managed-remote implementations can therefore diverge on rename handling, overflow, watch invalidation, resource exhaustion, network filesystems, and reconnect recovery. Moving only the Node callback into a Rust child would retain duplicated sequencing and debounce logic; the complete detection and reconciliation boundary must move.

The first version of this plan proposed a new `bigbud-local-workspace-service` binary. Repository inspection showed that this is unnecessary: `bigbud-remote-agent/src/main.rs` already has a persistent stdio loop with one shared watcher registry, and `RemoteAgentConnection.local()` already launches it with framed IPC.

## Goals

- Use one Rust watcher implementation for local and managed-remote projects.
- Run exactly one local agent process per TypeScript server, not per project, directory, tab, or subscription.
- Keep one logical Rust manager per canonical workspace root and deduplicate identical directory interests.
- Preserve exact-path events, bounded batching, generation/sequence tracking, invalidation recovery, and polling fallback.
- Preserve the web refresh order: active preview, active preview parent, root, then other affected expanded directories.
- Recover from local-agent crashes by restarting, resubscribing, and forcing a rescan; never silently continue after a continuity gap.
- Package the platform-native local agent with desktop releases and make development startup deterministic.
- Preserve local path containment, symlink restrictions, current preview behavior, and direct-SSH compatibility.

## Non-Goals

- Moving local file reads, writes, search, Git, terminals, providers, or canonical state into Rust.
- Creating another Rust host binary or a process per workspace.
- Moving UI refresh priority into Rust or changing Files-panel expansion behavior.
- Persisting filesystem events as a durable replay log.
- Recursively watching directories that are neither the active file's parent nor represented in the loaded tree.
- Removing direct-SSH polling until direct SSH launches the compatible remote agent.
- Renaming `bigbud-remote-agent`; the binary name can be reconsidered separately.

## Planning Baseline

### Rust watcher and protocol

- `crates/bigbud-remote-agent/src/workspace/watch.rs` owns the registry, per-root managers, subscription limits, bounded command queue, generation allocation, and the 100 ms batch window.
- `watch.backend.rs`, `watch.events.rs`, and `watch.recovery.rs` own native/poll selection, snapshot reconciliation, and invalidated-watch restoration.
- `protocol/remote-agent/workspace.proto` already defines start, event, exact changed paths, generation, sequence, rescan, and stop messages. No new wire protocol is required for the local vertical slice.
- `bigbud-remote-agent/src/main.rs` already runs the watcher in stdio mode and writes asynchronous event frames through the shared framed writer.

### TypeScript transport

- `RemoteAgentConnection.local()` already spawns the binary with piped stdio and uses the same framing, handshake, request matching, frame listeners, and failure listeners as SSH connections.
- `remoteAgentWorkspaceWatchClient.ts` already implements watch start, event routing, stop, and typed retryability.
- `remoteAgentWorkspaceWatch.ts` already converts Rust events into project events, detects generation/sequence gaps, bounds its output queue, and forces rescans after transport recovery. It currently rejects local execution targets and is coupled to the general remote connection pool.
- `RemoteAgentLifecycle` rejects an agent epoch change for operation-continuity safety. Watchers need a different policy: a new epoch is acceptable only after resubscription and a mandatory rescan.

### Runtime and UI

- `workspace-runtime/Layers/WorkspaceRuntime.ts` selects local or remote `WorkspaceWatch` backends.
- The local backend currently derives `WorkspaceWatch` from `WorkspaceFileSystem.watchDirectory`.
- `FilesPanelRefreshCoordinator.tsx` already prioritizes the active preview, its parent, root, and remaining expanded directories. This plan should not alter that ownership.

### Packaging

- Remote-agent release assets currently cover Linux x64 and arm64 remote hosts.
- Desktop releases are built natively for macOS arm64, macOS x64, Linux x64, and Windows x64, but do not stage a local agent binary.
- `scripts/lib/desktop-artifact/build.ts` already stages server resources, and `apps/desktop/src/env/pathResolver.platform.ts` provides the pattern for resolving packaged native binaries.

## Implementation Decisions

1. **Reuse the existing binary.** Launch `bigbud-remote-agent --ephemeral` locally over stdio. The mode uses `AgentSession::new()` and writes no operation journal or persistent agent state.
2. **Use the existing watch wire messages.** Keep start/stop subscriptions for the first migration. Rust already groups them under one workspace manager; a new `ReplaceWatchInterests` protocol is not required.
3. **Use a watcher-specific connection manager.** It accepts agent epoch changes as continuity resets. Process and PTY clients keep their stricter lifecycle rules.
4. **Keep one local connection.** All local workspace handles and subscriptions share one local agent connection and its single registry.
5. **Keep one coalescing owner.** Rust retains the 100 ms event batch. TypeScript forwards immediately; the web only deduplicates identical in-flight refresh work.
6. **Keep rollout mutually exclusive.** The temporary `BIGBUD_LOCAL_WORKSPACE_WATCHER=rust|node` selector was used during implementation and removed from the implementation tree. Rust-only packages cannot be published unless the complete native artifact set passes the release assembly gate; Phase 6 release validation remains pending until those runners pass.
7. **Keep direct SSH isolated.** Managed remote uses Rust; direct SSH keeps its existing bounded poller and must report that backend honestly.
8. **Do not change the Files tree reveal behavior here.** Expanding a file's immediate parent on open is a separate UI change.

## Phases

### Phase 0: Baseline And Freeze Semantics

**Goal:** Prove the current managed-remote watcher before moving ownership.

1. Run and record the focused Rust watcher, protocol, server watcher, and web coordinator tests.
2. Add a short architecture comment or test fixture defining:
   - generation changes on manager restart or lost continuity;
   - sequence increases within a generation;
   - gaps and new generations require rescan;
   - notifications are invalidation hints and require reconciliation;
   - overflow collapses fine-grained paths into one rescan signal.
3. Confirm the tracked worktree before editing and preserve unrelated changes. The plan file is under an ignored `docs/plan/` directory.

**Exit criteria:** Existing remote behavior is green and the invariants are captured by tests rather than only prose.

### Phase 1: Extract `bigbud-workspace-watch`

**Goal:** Separate watcher mechanics from protocol and session code without changing behavior.

Create:

```text
crates/bigbud-workspace-watch/
  Cargo.toml
  src/lib.rs
  src/registry.rs
  src/backend.rs
  src/events.rs
  src/recovery.rs
  src/error.rs
  src/*.tests.rs
```

1. Add the crate to the root `Cargo.toml` workspace and expose `notify`/`thiserror` through workspace dependencies.
2. Move registry, backend, snapshot, reconciliation, recovery, limits, and domain errors from the remote-agent workspace module.
3. Remove the protocol dependency from the watcher core. Its event sink returns domain data:
   - subscription ID;
   - generation and sequence;
   - normalized changed paths and kinds;
   - optional rescan reason;
   - selected backend.
4. Define a small host boundary that supplies canonical workspace identity and resolves authorized relative directories. The shared crate must not authorize arbitrary roots or know about SSH, protobuf, Effect, Electron, or web state.
5. Adapt `workspace_watch_handlers.rs` to translate domain starts/errors/events to the existing protobuf frames.
6. Move watcher tests to the shared crate; retain golden protocol tests in `bigbud-protocol` and remote-agent handler tests in `bigbud-remote-agent`.

**Exit criteria:** The remote agent passes the same focused tests and emits byte-compatible protocol frames. No local integration is added yet.

### Phase 2: Add Ephemeral Local-Agent Supervision

**Goal:** Start one reusable local Rust process and recover it safely.

1. Add `--ephemeral` handling in `bigbud-remote-agent/src/main.rs`; it must call the existing stdio loop with `AgentSession::new()` and avoid the state directory and journal.
2. Extend `RemoteAgentConnection.local()` to accept explicit arguments while retaining bounded framing and stderr-tail diagnostics.
3. Add focused modules under `apps/server/src/remote-agent/`:

   ```text
   localWorkspaceWatchAgent.ts
   localWorkspaceWatchAgent.binary.ts
   localWorkspaceWatchAgent.test.ts
   localWorkspaceWatchAgent.binary.test.ts
   ```

4. Resolve the binary in this order:
   - `BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY`;
   - packaged desktop path supplied by Electron;
   - repository `target/debug/bigbud-remote-agent` in development;
   - otherwise unavailable with an actionable diagnostic.
5. The supervisor owns one connection promise and one live connection. Concurrent callers share startup. On failure it clears the connection, applies capped exponential backoff, launches a new process, handshakes, and verifies `workspace.watch` capability.
6. Do not reuse the strict process/PTY epoch policy. Any new local-agent epoch is accepted as a watcher reset; subscribers must resubscribe and receive `rescanRequired` before exact events resume.
7. Closing the server closes stdin and terminates the child. Add Windows process-tree cleanup consistent with the desktop backend pattern.

```text
Unavailable -> Starting -> Ready
                  |          |
                  v          v
               Failed <- TransportLost
                  |
             capped backoff
                  |
                  v
               Starting -> Ready(new epoch) -> mandatory rescan
```

**Exit criteria:** Multiple local projects share one PID; killing the child causes one bounded restart and mandatory rescans without a retry storm.

### Phase 3: Route Local Watches Through The Agent

**Goal:** Use the Rust event path locally while retaining a safe rollout switch.

1. Refactor `makeRemoteWorkspaceWatch` into an internal target-neutral `makeAgentWorkspaceWatch`. Keep thin local and managed-remote wrappers for target validation and connection resolution.
2. Reuse the existing event conversion, bounded queue, gap detection, retry classification, and subscription cleanup. Do not add a second debounce.
3. Add a local `WorkspaceWatch` layer backed by the local supervisor and inject it into `makeWorkspaceRuntimeLayer` without moving local files/search into Rust.
4. Use stable workspace handles derived from canonical local roots. The Rust session must independently canonicalize and contain every requested directory.
5. Add `BIGBUD_LOCAL_WORKSPACE_WATCHER=rust|node`, defaulting to `node` for the first rollout. Select exactly one local backend during layer construction.
6. Keep managed remote routing unchanged except for shared adapter extraction. Keep direct SSH on `WorkspaceFileSystem.remoteWatch.ts`.
7. Do not modify the web event API. Local Rust events should arrive as version-2 exact-path events and flow through the existing coordinator.

**Exit criteria:** With the flag set to `rust`, local external edits refresh the open preview and affected loaded directories; with `node`, behavior is unchanged.

### Phase 4: Development And Desktop Packaging

**Goal:** Make the Rust backend available without manual binary setup.

1. Add a development build command for `cargo build --locked --package bigbud-remote-agent` and run it before server-bearing dev modes. Do not require Cargo for web-only development.
2. Extend the desktop artifact builder to compile the native agent on each existing native release runner and stage it under:

   ```text
   resources/server/workspace-agent/bin/bigbud-remote-agent[.exe]
   ```

3. Add a pure platform path resolver beside the packaged OpenCode resolver and tests for macOS, Linux, and Windows names/paths.
4. Pass `BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY` to the backend child from `backendManager.ts` only after verifying the staged file exists.
5. Extend Linux artifact verification and desktop smoke tests to assert the binary exists, is executable, responds to `--check`, and completes the protocol handshake.
6. Document the environment override for standalone/source deployments. Do not remove the Node rollback until every supported distribution supplies a binary.

**Exit criteria:** macOS arm64/x64, Linux x64, and Windows x64 desktop artifacts contain and launch their native binary; normal development startup builds or locates it automatically.

### Phase 5: Parity, Failure, And Load Validation

**Goal:** Establish that Rust is safe to become the default local backend.

Validate both local backends separately against the same conformance cases:

1. Create, modify, same-size rapid rewrite, atomic-save rename, delete, and recreate an open file.
2. Rename/delete/recreate a watched directory and continue receiving later changes.
3. Modify the active preview while its parent is also expanded; ensure one preview reload and no duplicate backend registration.
4. Open two browser clients on the same workspace and prove shared Rust registration and correct independent cleanup.
5. Kill the agent during a write burst; prove bounded restart, new generation, rescan, and eventual fresh preview.
6. Force queue overflow, invalid native watch, Linux watch exhaustion, and polling fallback.
7. Validate sleep/wake, server restart, and rapid subscribe/unsubscribe churn.
8. Measure native write-to-visible-preview p95 below 500 ms and confirm native idle mode performs no repeated directory listings.

**Exit criteria:** All automated cases pass, manual packaged checks pass on every supported platform, and no silent-stale or unbounded-retry path remains.

### Phase 6: Default Cutover And Duplication Removal

**Goal:** Make Rust authoritative locally and delete the old local watcher.

1. Change the rollout flag default to Rust for one release candidate and retain Node as an emergency rollback.
2. After the release gate passes, remove:
   - the local `node:fs/promises.watch` import;
   - `createDirectoryChangedStream` and its TypeScript debounce;
   - local Node watcher tests and the rollout flag;
   - the `WorkspaceFileSystem.watchDirectory` responsibility if no remaining caller needs it.
3. Keep `WorkspaceWatch` as the dedicated runtime capability; files and search remain separate.
4. Keep direct-SSH polling isolated and label its backend accurately in diagnostics.
5. Update the architecture document, troubleshooting guide, release smoke checks, and this plan's status.

**Exit criteria:** Local and managed-remote watching use `bigbud-workspace-watch`; TypeScript performs no detection, snapshot comparison, event debounce, or sequence generation for those paths.

**Current status:** The implementation criteria are met in the source tree. The external release criterion is not yet met: no result from the new macOS arm64/x64, Linux x64, or Windows x64 packaged/standalone artifact runners is available in this local implementation session. Publishing is blocked when any native server artifact is missing or has the wrong target identity.

## Risks And Decision Gates

| Risk                                     | Required control                                                                          | Gate                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Local agent missing or incompatible      | Typed non-retryable diagnostic; complete native-artifact publish gate; no silent fallback | Do not release until every supported artifact includes and launches the binary |
| Child crash or pipe loss                 | Single-flight restart, capped backoff, new subscription, mandatory rescan                 | Kill-process integration test must pass                                        |
| Slow TypeScript consumer                 | Bounded Rust and Effect queues; overflow becomes one rescan                               | Sustained-burst test must show bounded memory                                  |
| Duplicate subscriptions                  | One manager per canonical root and shared interest snapshot/registration                  | Two-client and preview/tree overlap tests must pass                            |
| Linux watch limits or network filesystem | Honest native/poll backend status and bounded polling fallback                            | Linux exhaustion and mounted-filesystem checks must pass                       |
| Cross-root alias or symlink escape       | Host authorization plus Rust canonical containment on every registration/recovery         | Security tests must pass before local flag exists                              |
| Process/PTY continuity regression        | Watch-specific connection lifecycle; no change to strict operation lifecycle              | Existing process and PTY reconnect suites must remain green                    |
| Desktop orphan process                   | stdin EOF exit plus explicit child/process-tree shutdown                                  | Packaged quit/restart smoke test must pass on all platforms                    |

Do not proceed to Phase 3 until extraction preserves remote protocol behavior. Do not proceed to Phase 6 until development, packaged desktop, and supported standalone paths all resolve a native binary.

## Testing And Validation

### Focused tests to add or update

- Rust crate: baseline race, exact paths, duplicate interests, batching, overflow, fallback, invalidation restoration, subscription cleanup, and manager shutdown.
- Remote-agent host: domain-event-to-protobuf mapping, ephemeral mode, EOF shutdown, unsupported request handling, and golden frames.
- Server supervisor: single-flight startup, one PID across workspaces, capability rejection, crash/restart, capped backoff, close, and Windows cleanup behavior.
- Server routing: local Rust, local rollback, managed remote Rust, and direct-SSH polling select exactly one backend.
- Web: exact active-file refresh, priority order, rescan sweep, duplicate suppression, and manual-collapse behavior remain unchanged.
- Desktop artifact: platform path resolution, staged executable presence, executable bit on POSIX, `--check`, and handshake.

### Mandatory repository gates

- `bun fmt`
- `bun lint`
- `bun typecheck`
- `bun run test`
- `cargo fmt --all --check`
- `cargo clippy --locked --workspace --all-targets -- -D warnings`
- `cargo test --locked --workspace`
- `git diff --check`

Never run `bun test`; it bypasses Vitest. Keep every authored source and test file at or below 400 lines. Preserve unrelated worktree changes. Do not commit or push without fresh explicit user approval.

## Acceptance Criteria

- One local `bigbud-remote-agent` child exists per TypeScript server, regardless of open project count.
- Local and managed-remote watcher mechanics come from `bigbud-workspace-watch`.
- Each canonical workspace has one logical manager; duplicate interests share registration and snapshot work.
- Local and managed-remote external edits update an open preview without closing and reopening it.
- Exact events refresh only affected UI state; rescan events use the existing ordered full sweep.
- Child crashes, epoch changes, sequence gaps, overflow, invalidation, and backend fallback cannot leave silent stale state.
- Rust owns the only time-based event batch for local and managed remote.
- TypeScript owns supervision and routing only; the web owns display priority only.
- Native idle mode causes no repeated directory-list traffic.
- Direct SSH remains clearly identified as bounded polling unless it launches the managed agent.
- Development and packaged macOS, Linux, and Windows paths locate and launch the correct native binary.
- All mandatory repository gates pass.

## Open Questions

None block implementation. Future work may decide whether direct SSH should eventually require the managed agent for live watching and whether the `bigbud-remote-agent` binary should be renamed after it serves both local and remote workspace roles.

## Implementation Record

- Extracted protocol-neutral watcher mechanics into `crates/bigbud-workspace-watch` and retained protobuf mapping in `bigbud-remote-agent`.
- Added `--ephemeral`, EOF shutdown, one-process supervision, capability verification, bounded restart backoff, new-epoch resubscription, and mandatory rescans.
- Added a target-neutral TypeScript watch adapter with thin local and managed-remote wrappers; direct SSH keeps the existing bounded poller.
- Removed the Node local watcher, TypeScript debounce, and temporary rollout flag. This is an implementation cutover, not evidence that a release candidate has passed the external Phase 6 gate.
- Added deterministic development builds plus platform-native desktop and standalone-server staging, target identity checks, executable checks, handshake checks, and capability checks. Standalone publishing requires all four supported native artifacts.
- Added deterministic runtime-backend reconstruction tests, native-restoration failure and Rust-poll fallback tests, Linux watch-exhaustion injection, initial-baseline race coverage, long-pause continuity, active-preview serialization, direct-SSH diagnostic identity, managed-remote behavior without credentials, and an actual spawned-child crash/restart/exact-event integration test.
- Added per-runner packaged artifact smoke gates for macOS arm64/x64, Linux x64, and Windows x64. These gates are implemented but have not run in this local session; their successful external results remain a release blocker.

## Release Handoff

The source implementation through the Rust-only cutover is complete. The remaining Phase 6 work is external release validation:

1. Run the release matrix on macOS arm64, macOS x64, Linux x64, and Windows x64.
2. On every runner, verify the packaged binary target identity and framed `workspace.watch` handshake.
3. Smoke a real local subscription, external file edit, active-preview refresh, and clean child exit in the packaged application.
4. Assemble all four `server-workspace-agent-*` artifacts and verify that the standalone server publish gate accepts the complete set and rejects a missing or mismatched target.
5. Mark the Phase 6 release gate complete only after all runner evidence is available.

If any runner exposes a protocol, security, packaging, or lifecycle regression, do not publish or mark Phase 6 complete. Fix the Rust delivery path without introducing a permanent Node watcher duplicate.
