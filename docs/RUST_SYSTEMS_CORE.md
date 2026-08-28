# Rust Systems Core Plan

## Status

Accepted architecture with incremental implementation. The remote workspace agent, the shared local/managed-remote workspace watcher, and the packaged-desktop orchestration delivery supervisor are implemented. Release-matrix evidence and the remaining systems-core scope retain the rollout gates in this document.

## Objective

Introduce a Rust systems core while retaining the existing Electron desktop app, React UI, Bun/TypeScript server, provider SDKs, orchestration, and local canonical state.

The first product outcome is a thin, resumable remote workspace agent that makes SSH projects approach local parity for files, search, Git, processes, terminals, and file watching. File watching now uses one shared Rust implementation for local and managed-remote workspaces: the TypeScript server launches one ephemeral local `bigbud-remote-agent` over framed stdio, while managed remote hosts run the same binary over SSH.

The intended architecture is:

```text
Electron desktop / browser clients
              |
              v
Bun/TypeScript application layer
|- providers and provider adapters
|- orchestration and permissions
|- canonical SQLite state
|- WebSocket/API and UI event models
`- normalized WorkspaceRuntime
              |
     target-neutral protocol client
              |
              v
Rust systems runtime
|- filesystem and search
|- Git
|- processes and PTYs
|- file watching
|- SSH connection supervision
`- resumable operation management
              |
       +------+------+
       |             |
       v             v
 local ephemeral agent   remote agent over SSH
```

## Product Decisions

1. Electron remains the desktop shell.
2. Providers, provider credentials, provider sessions, and provider-event normalization remain local in TypeScript.
3. Threads, messages, activities, projects, approvals, and all other canonical application state remain in local SQLite.
4. Rust owns systems execution, not product semantics.
5. The first Rust executable is a thin remote agent reached through the user's existing SSH setup.
6. The remote agent opens no inbound network port. Its initial transport is framed RPC over SSH stdio.
7. Every provider must be supported through one normalized workspace contract. Rust must not contain Codex-, Claude-, Copilot-, OpenCode-, KiloCode-, Pi-, Devin-, Cursor-, or future-provider-specific behavior.
8. Current direct SSH behavior remains available during migration and as a bounded compatibility fallback until the agent path reaches parity.
9. Disconnect is not cancellation. Explicit cancellation, timeout, deletion, shutdown, and transport loss have separate lifecycle semantics.
10. A local provider cannot continue while the local machine is suspended or powered off. The agent resumes remote workspace operations; it does not make local provider execution independent of the local machine.
11. The agent-backed workspace path initially requires a local provider runtime. Existing remote-provider runtime sessions remain on their current compatibility path until separately migrated; they are not silently changed or removed.
12. Project and thread commands enter through the TypeScript command gateway. TypeScript remains the only authority that may validate those commands, commit canonical SQLite state, and record their durable outcomes. Rust may supervise delivery of the resulting canonical events, but it does not accept product commands on TypeScript's behalf.

## Terminology

**Rust systems core**: Shared Rust libraries for workspace and operating-system operations. It does not own bigbud's domain model.

**Local sidecar**: A packaged Rust daemon launched on the same machine as the TypeScript server. This is a later migration target, not required for the first remote-agent release.

**Local workspace watch agent**: One ephemeral `bigbud-remote-agent` child per TypeScript server. It multiplexes local watch subscriptions over framed stdio, writes no journal or persistent agent state, and is not a general local-runtime migration.

**Remote agent**: A small Rust executable installed on an SSH host and invoked by bigbud. It performs bounded workspace operations and temporarily supervises resumable operations.

**Workspace runtime**: The TypeScript-facing capability contract used by application services and provider tool bridges, regardless of whether execution is local or remote.

**Canonical state**: Durable product state owned by the local TypeScript server and SQLite database.

**Operation journal**: Bounded temporary remote metadata and output retained only to resolve or resume an operation after transport loss.

## Scope

### Initial Scope

- Rust workspace and cross-platform build pipeline.
- Versioned TypeScript/Rust RPC protocol.
- Remote agent installation, verification, atomic upgrade, and cleanup.
- SSH connection multiplexing, health checks, reconnect, and capability negotiation.
- Structured filesystem, search, and read-only Git operations.
- Stable operation IDs, output sequencing, acknowledgements, cancellation, and result lookup.
- Bounded operation journals for reconnect recovery.
- A normalized TypeScript `WorkspaceRuntime` with local and remote implementations.
- Provider-neutral tool routing so all providers can use the remote runtime according to their existing injection mode.
- Local/remote conformance tests and real SSH integration tests.

### Later Scope

- Git mutations, worktrees, and progress streaming.
- Generic process execution with explicit TypeScript authorization.
- Resumable PTYs and terminal reattachment.
- Incremental file indexing and file watching.
- A local Rust sidecar using the same systems crates and protocol.
- Migration of additional performance- or reliability-sensitive systems services when measurements justify it.

### Non-Goals

- Replacing Electron with Tauri.
- Rewriting the Bun/TypeScript server in Rust.
- Moving provider adapters or SDK integrations to Rust.
- Persisting conversation or project catalogs on the remote host.
- Making a remote bigbud web server mandatory.
- Opening a remote TCP port or requiring a cloud relay.
- Guaranteeing that local providers continue while the local machine sleeps.
- Moving SQLite persistence to Rust before a separate design proves a concrete benefit and safe ownership model.
- Adding a durable Rust queue for project or thread commands while TypeScript remains the canonical executor. That would require a separate ADR proving a restart/offline requirement and defining idempotency, versioning, retention, and recovery ownership.

## Ownership Boundary

| Responsibility                               | TypeScript application layer                   | Rust systems core                                            |
| -------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Provider SDKs and credentials                | Owns                                           | Never receives unless an explicit future design changes this |
| Provider session and event normalization     | Owns                                           | Provider-agnostic                                            |
| Threads, messages, approvals, and activities | Owns                                           | Does not model                                               |
| Project/thread command semantics             | Validates, orders, fences, and decides         | Does not interpret                                           |
| Command receipts and canonical outcomes      | Persists atomically with canonical changes     | Does not acknowledge acceptance                              |
| Canonical SQLite state                       | Owns                                           | Does not own                                                 |
| Workspace capability selection               | Owns                                           | Advertises available capabilities                            |
| Filesystem and search execution              | Requests and maps results                      | Executes                                                     |
| Git execution                                | Applies product policy and maps results        | Executes structured operations                               |
| Process and PTY lifecycle                    | Requests, presents, and authorizes             | Supervises                                                   |
| Reconnect policy                             | Owns user-facing state and retry decisions     | Retains bounded resumable operation state                    |
| Remote installation and version selection    | Owns                                           | Reports identity and compatibility                           |
| Desktop orchestration-event delivery         | Supplies replay and controlled fallback        | Orders, bounds, fences, and tracks application ACKs          |
| Temporary output replay                      | Persists acknowledged canonical events locally | Retains only unacknowledged bounded output                   |

Rust must not become a second application server. The language boundary should prevent product rules from drifting into two implementations.

### Canonical command and delivery boundary

The verified application path is intentionally asymmetric:

```text
UI
 |
 v
TypeScript command gateway
|- authenticated WebSocket admission and schema normalization
|- stable command ID and durable outcome lookup
|- lifecycle invariants and deletion/ownership fences
|- serialized orchestration decision
|- SQLite transaction: events + projections + command receipt
`- canonical event publication after commit
 |
 v
Rust desktop delivery supervisor
|- bounded event queues and strict delivery order
|- consumer generations and stale-generation fencing
|- restart, replay, reconnect, and controlled fallback
`- verified application acknowledgement
 |
 v
UI applies events and reconciles canonical ownership before ACK
```

The TypeScript gateway already serializes orchestration commands through an Effect queue, deduplicates committed commands through durable command receipts, and writes the event set, projections, and accepted receipt in one SQLite transaction. In the current contract, an `accepted` command receipt means the canonical transaction committed; it must not mean merely received by the WebSocket or placed in an in-memory queue. Deterministic rejected outcomes may also be persisted. Transport loss before a receipt exists remains an unknown outcome, and a client must query by the original command ID before deciding whether to retry.

The command and startup-readiness queues are bounded and memory-only, with explicit retryable overload/deadline outcomes and queue depth metrics; all aggregates still share one serialized processing lane. These remain TypeScript gateway concerns, not Rust command responsibilities. Stable command IDs remain the recovery key: a deadline can leave a queued command unknown, so clients query the original ID before retrying. Preserve the single global lane until measurements and conflict tests justify aggregate-partitioned concurrency; project deletion and thread ownership changes cross simple aggregate boundaries.

Rust is authoritative only after canonical events exist. It improves event delivery reliability without deciding whether a project/thread action is valid or whether it committed. Create, rename, archive, and delete normally need a terminal command outcome rather than synthetic percentage progress. Multi-stage destructive or cleanup work may expose named durable stages when those stages correspond to canonical state transitions.

A future Rust command-ingress journal is permitted only if measurements demonstrate a product requirement to accept actions while the TypeScript backend is unavailable or restarting. That design must use stable idempotency keys, durable bounded storage, per-aggregate conflict ordering, protocol-version checks, expiry, explicit `unknown_outcome`, and removal only after TypeScript confirms the canonical receipt. It must remain a transport journal, never a second domain authority.

### Canonical command and delivery completion gates

The command and desktop-delivery path is complete only when all of these
invariants are implemented and covered by composed fault-injection tests:

1. The UI acknowledges only the highest contiguous sequence it successfully
   applied and reconciled. An application, recovery, or ownership-reconciliation
   failure blocks acknowledgement advancement and initiates recovery; the final
   sequence in a delivered batch is never acknowledged merely because it was
   received.
2. Replay is paged until the requested contiguous range is complete. A page or
   implementation limit must never be interpreted as the end of replay, and live
   delivery must not bridge an unresolved gap.
3. Every external side-effect identity, including Git branches and worktrees,
   is derived deterministically from persisted command recovery data. Retrying
   the same command after response loss or restart must address the same physical
   resource.
4. Only deterministic domain validation or invariant failures may be persisted
   as rejected command outcomes. Hydration, SQLite, filesystem, Git, timeout,
   and other operational failures remain retryable or `unknown` unless their
   canonical outcome is proven. A terminal rejection is returned only after its
   receipt is durably confirmed.
5. Every asynchronous event boundary has an explicit memory bound, including
   TypeScript publication/subscription paths before Rust delivery. Overflow must
   either conflate a wake-up signal backed by canonical SQLite replay or produce
   an explicit recoverable gap; it must never silently retain an unbounded backlog
   or drop canonical history.
6. Idempotency is bound to both the command ID and a canonical payload digest.
   The receipt store compares the digest atomically, returns the existing outcome
   only for the same command, and rejects reuse of an ID with different content
   as a typed conflict.

Required regression coverage includes application failure before ACK, ownership
reconciliation failure, replay spanning multiple storage pages, live events
arriving during replay, response loss around external Git side effects, restart
after a partial bootstrap, transient persistence failures, subscriber saturation,
and same-ID/different-payload conflicts.

## Repository Layout

Start with a top-level Cargo workspace:

```text
bigbud/
|- Cargo.toml
|- Cargo.lock
|- rust-toolchain.toml
|- crates/
|  |- bigbud-protocol/
|  |- bigbud-systems/
|  |- bigbud-workspace-watch/
|  |- bigbud-remote-agent/
|  `- bigbud-local-daemon/        # optional future non-watcher migration
|- protocol/
|  `- remote-agent/v1.proto
|- apps/
|- packages/
`- docs/
```

Crate responsibilities:

| Crate                    | Responsibility                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `bigbud-protocol`        | Generated protocol types, framing, compatibility negotiation, and protocol errors     |
| `bigbud-systems`         | Reusable files, search, Git, process, PTY, containment, and operation primitives      |
| `bigbud-workspace-watch` | Protocol-neutral watcher registry, reconciliation, batching, bounds, and recovery     |
| `bigbud-remote-agent`    | SSH/ephemeral stdio entrypoint, workspace registration, journal, and remote lifecycle |
| `bigbud-local-daemon`    | Optional later local sidecar using `bigbud-systems`; not part of the first milestone  |

Keep each crate narrow. A shared crate is justified only when both executables use it or when it isolates a coherent safety-critical concern.

## TypeScript Workspace Runtime

Define the normalized contract before freezing the protocol or implementing workspace methods. Existing services such as `WorkspaceFileSystem`, `GitCore`, terminal management, workspace entries, and provider tool bridges should be adapted behind focused capability interfaces rather than replaced in one change.

Conceptually:

```text
WorkspaceRuntime
|- identity and capabilities
|- files
|- search
|- git
|- processes
|- terminals
`- watch

LocalWorkspaceRuntime
RemoteAgentWorkspaceRuntime
```

`WorkspaceRuntime` is a facade composed from focused Effect services, not one large service interface. Filesystem, Git, process, terminal, and watcher services retain separate ownership and error types while sharing a lower-level execution-target runtime for operation identity, cancellation, deadlines, streaming, and capability lookup.

The focused TypeScript contracts are authoritative for application behavior. Protobuf messages are transport representations generated after these contracts define path semantics, errors, cancellation, and result bounds. The contracts must be transport-neutral and must not expose Rust-specific protocol messages to provider adapters or WebSocket handlers.

### Capability Groups

**Identity and platform**

- Runtime and protocol versions.
- OS, architecture, path separator, case sensitivity, and shell information.
- Available executable and Git versions.
- Workspace root identity and capability flags.

**Filesystem**

- `stat`, `realpath`, and containment checks.
- Bounded ranged reads and resumable transfers.
- Atomic writes with expected version or content hash.
- Directory listing, create, rename, copy, remove, links, and permissions where supported.
- Explicit binary/text metadata and truncation status.

**Search and discovery**

- Bounded glob and content search.
- Ignore-file semantics consistent with local behavior.
- Result limits, byte limits, deadlines, cancellation, and truncation markers.
- Incremental indexing only after direct operations are correct and measured.

**Git**

- Repository discovery, status, diffs, branches, history, and commit details.
- Fetch, pull, push, checkout, stage, unstage, discard, commit, and worktree operations in later phases.
- Structured results matching existing contracts where practical.
- Progress streams and explicit unknown-outcome handling for interrupted mutations.

**Processes**

- Spawn with cwd, arguments, environment, stdin mode, deadlines, and resource bounds.
- Separate ordered stdout and stderr streams.
- Stable process and operation IDs.
- Attach, status, signal, cancel, terminate, and process-tree cleanup.
- Bounded output spooling and terminal result lookup.

**Terminals**

- Create, attach, detach, input, output, resize, signal, and close PTYs.
- Bounded history and short reconnect survival.
- Explicit platform capability errors when PTY behavior is unsupported.

**Watchers**

- Recursive and non-recursive workspace watches.
- Overflow and invalidation events instead of silently losing changes.
- Re-establishment after reconnect with a required refresh when continuity is uncertain.

## Provider Support

All providers remain local and consume the same `WorkspaceRuntime`. The provider integration layer maps existing tool-injection modes to normalized workspace capabilities:

| Injection mode                               | Integration direction                                                                                         |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| MCP                                          | Expose provider-neutral MCP tools backed by `WorkspaceRuntime`                                                |
| Built-in override                            | Redirect built-in file and shell operations to `WorkspaceRuntime`                                             |
| Custom tools                                 | Implement provider-specific tool schemas as thin adapters over `WorkspaceRuntime`                             |
| Native local tools that cannot be redirected | Disable the unsafe tool for remote workspaces or declare the provider unsupported until parity is implemented |

Support is capability-based, not provider-name-based inside Rust. Each provider must pass the same remote workspace behavior matrix before being marked supported.

Provider-native state remains local. Do not attempt to translate provider conversations, sessions, or event streams into a universal Rust model. Normalize only the workspace operations providers need.

For new agent-backed sessions, `providerRuntimeExecutionTargetId` must resolve to `local`. Existing persisted sessions that intentionally use a remote provider runtime continue through the current path and are not auto-migrated. The UI and server must reject an attempt to switch an active provider runtime between local and remote. Supporting those legacy remote runtimes through the Rust agent is a separate future design, not part of provider parity here.

## Protocol

Use a versioned, length-prefixed protobuf protocol over stdin/stdout. Protobuf provides generated Rust and TypeScript types, binary chunk support, bounded framing, and explicit compatibility evolution. Standard error remains reserved for agent diagnostics and must never contain protocol frames.

The first handshake includes:

- Agent semantic version and build identity.
- Protocol major and minor versions.
- OS and architecture.
- Supported capability versions.
- Maximum frame, operation output, and transfer sizes.
- Journal and reconnect limits.
- Server nonce and agent instance ID.

Protocol rules:

1. Unknown fields are ignored within a compatible protocol major version.
2. Breaking changes require a new protocol major version.
3. Every request carries a request ID and deadline.
4. Long operations carry a stable operation ID and idempotency key.
5. Stream events carry monotonically increasing sequence numbers per operation.
6. The client acknowledges the highest contiguous persisted sequence.
7. Cancellation is an explicit request and is never inferred from transport loss.
8. The agent reports terminal outcomes independently of whether their delivery was acknowledged.
9. Invalid frames, oversize frames, and unsupported capabilities fail closed.
10. Sensitive values are omitted or redacted from diagnostics.

### Protobuf generation dependency

Rust protobuf bindings are generated locally by `prost-build` from the checked-in
schemas. The workspace pins `protoc-bin-vendored` at `3.2.0` as a build
dependency, and the protocol build script resolves that package's platform
compiler and passes its path to `prost-build`. This keeps generation
deterministic and avoids requiring a separately installed `protoc` or network
access during a build once Cargo dependencies are available, across the
supported macOS, Windows, and Linux developer/build environments. The same
generation pattern is used by the desktop supervisor protocol.

This dependency is build-time only; it supplies the compiler needed to turn the
authoritative `.proto` files into Rust bindings and does not change the runtime
wire protocol. The version and platform package checksums are recorded in
`Cargo.lock`.

`protoc-bin-vendored` version `3.2.0` is approved for this build-time use. The
approval covers the root crate and its lockfile-pinned macOS, Windows, and Linux
platform packages. The crate family declares the MIT license and is sourced
from crates.io with its upstream repository recorded as
`stepancheg/rust-protoc-bin-vendored`. It is not shipped as an application
runtime dependency and must remain isolated to protobuf binding generation.

Upgrading the crate, changing its source, adding a supported target, or using
the bundled compiler at runtime requires a fresh dependency review. Routine
maintenance must retain the exact workspace pin, committed `Cargo.lock`
checksums, locked CI and release builds, and protocol fixture tests that detect
unexpected generated wire changes.

## Resumability Semantics

The first implementation targets faster, predictable recovery after temporary SSH loss.

```text
1. TypeScript creates an operation ID and idempotency key.
2. The agent accepts and journals the operation start.
3. The agent emits sequenced output or progress.
4. TypeScript persists relevant canonical state and acknowledges sequences.
5. SSH disconnects without cancelling the operation.
6. The connection supervisor reconnects and performs a handshake.
7. TypeScript attaches using operation ID and last acknowledged sequence.
8. The agent replays missing output and reports current or terminal status.
9. TypeScript acknowledges the final outcome.
10. The agent removes the journal after acknowledgement and a safety delay.
```

### Local Operation Ledger

The last acknowledged sequence cannot live only in server memory. Add a bounded local SQLite operation ledger owned by the TypeScript server with:

- Operation ID and idempotency key.
- Execution target and workspace identity.
- Capability and operation kind.
- Last contiguous persisted sequence.
- `pending`, `running`, `completed`, `cancelled`, `failed`, or `unknown_outcome` status.
- Terminal outcome metadata and timestamps.

Persist a sequence's canonical effect and acknowledgement cursor in the same local transaction where practical. On server restart, reconcile non-terminal ledger entries with the agent before retrying anything. The ledger contains recovery metadata, not provider-native state or a second copy of streamed user content. Completed entries expire through bounded local retention after the corresponding canonical state is durable.

### Retry Classes

| Operation class      | Reconnect behavior                                                            |
| -------------------- | ----------------------------------------------------------------------------- |
| Pure read            | Safe to restart when attachment is unavailable                                |
| Streamed read/search | Prefer attach and replay; restart only when the caller accepts a new snapshot |
| Atomic file write    | Resolve the original outcome by operation ID; never blindly repeat            |
| Git read             | Safe to restart, with snapshot timestamp exposed where relevant               |
| Git mutation         | Attach or query outcome; report `unknown_outcome` if proof is unavailable     |
| Process/PTY          | Attach to the supervised process within its retention window                  |

### Temporary Remote State

True resumability requires limited remote state. Store it beneath a user-private directory such as:

```text
~/.bigbud/remote-agent/
|- bin/
|- run/
|- journals/<operation-id>/
|  |- metadata
|  |- events
|  `- outcome
`- versions/
```

Requirements:

- Directories are mode `0700` and files are mode `0600` on POSIX systems.
- Windows ACLs restrict access to the current user.
- Journals are bounded by bytes, event count, operation count, and age.
- Initial defaults are 64 MiB per operation, 512 MiB per user agent, and 128 retained operations. These are configurable downward and must be validated by measurement.
- Completed acknowledged operations expire after five minutes; completed unacknowledged outcomes expire after 24 hours.
- First-slice running operations have explicit deadlines no longer than 30 minutes and remain attachable for 30 minutes after transport loss.
- Read/search/Git operations reserve space for a terminal event. If their journal limit is reached, the agent cancels the operation and records `resource_exhausted`; it never silently drops replayable output.
- Later PTYs may use a bounded ring buffer only when they emit an explicit gap event that forces the client to refresh its terminal snapshot.
- New operations are rejected before global journal limits are exceeded. Existing bounded operations terminate predictably if they cannot retain a provable outcome.
- Journals contain operation recovery data only, not the canonical conversation or project database.
- Startup repairs incomplete temporary records conservatively and never assumes an unproven mutation outcome.

## Agent Lifecycle

### Discovery and Installation

1. Use the user's system `ssh` command and existing SSH configuration.
2. Detect remote OS and architecture with bounded commands.
3. Select a signed/checksummed version-compatible artifact.
4. Upload to a temporary path when the required version is absent.
5. Verify SHA-256 before activation.
6. Set executable and user-only permissions.
7. Atomically rename into a versioned installation directory.
8. Launch the agent through SSH stdio.
9. Retain the previous compatible version until the new version passes health checks.
10. Remove old inactive versions using bounded cleanup.

Do not execute an unverified downloaded binary. Installation errors must preserve the existing direct SSH path during migration.

### Runtime Model

Start with one agent process per active SSH connection. Add a detached, user-scoped worker only when resumable operations require survival beyond the proxy process.

The detached worker should:

- Listen only on a user-private Unix socket or Windows named pipe.
- Use a stable workspace/agent instance identifier.
- Survive transport loss for a bounded grace period.
- Stay alive while a resumable operation is running, subject to hard limits.
- Exit after all operations finish and the reconnect grace period expires.
- Never accept network connections.

### Connection Supervisor

The TypeScript supervisor owns:

- One multiplexed SSH connection per execution target where supported.
- Heartbeats and liveness state.
- Exponential reconnect with jitter and an upper bound.
- Agent compatibility and health state.
- Attach/replay coordination.
- User-visible states: `connecting`, `live`, `degraded`, `reconnecting`, `incompatible`, and `disconnected`.

Avoid presenting historical verification as a live connection.

### Desktop delivery supervisor boundary

The packaged desktop runtime must integrate `bigbud-desktop-supervisor` as the
authoritative delivery coordinator for orchestration events. The TypeScript
server owns the sidecar process and remains the canonical domain authority for
events, replay data, authorization, SQLite state, and user-visible connection
state. Electron packages, verifies, resolves, and supplies the native binary;
it does not proxy orchestration traffic through main-process IPC.

For an attached supervisor-managed consumer, canonical events cannot bypass
Rust. The consumer acknowledges a batch only after serialized application and
canonical ownership reconciliation. Rust owns bounded queues, delivery order,
consumer generations, acknowledgement tracking, timeout detection, and
recovery requests. It never owns provider sessions, credentials, threads,
messages, or canonical event history.

Supervisor failure first triggers bounded restart, handshake, reattachment,
and replay from the last verified application acknowledgement. A controlled
TypeScript fallback is permitted only after self-healing is exhausted. It must
fence the failed generation, reconcile an uncertain cursor before delivery,
remain active for the rest of that session, and never deliver concurrently
with Rust. The accepted ownership and rollout decision is recorded in
`docs/decisions/2026-08-27-desktop-delivery-supervisor-authority.md`.

This boundary is now implemented by `apps/server/src/desktop-supervisor/`, the
delivery-envelope and application-ACK contracts under
`packages/contracts/src/orchestration/`, and the serialized web application
queue. Protocol major 1, minor 1 adds an explicit ACK-accepted response so the
TypeScript owner never advances a verified cursor from an ambiguous write.
The Rust binary enforces hello-first sessions, rejects stale generation or
sequence rollback, checks ACK timeouts on an independent watchdog, and treats
partial frame prefixes as truncation. Packaged desktop builds stage the binary
under `server/delivery-supervisor/bin`; standalone server and mobile-remote
delivery remain direct until they have supported native distribution.

## Security Model

### Trust Boundary

The remote agent runs with the SSH user's privileges. It must assume that all protocol input may be malformed and that workspace paths may be adversarial.

Required controls:

- Resolve every path against an agent-registered workspace root.
- Reject traversal, symlink escape, and alternate-root access unless a capability explicitly allows it.
- Pass commands as executable plus argument arrays; do not construct shell strings by default.
- Limit environment inheritance and explicitly redact known secret keys from diagnostics.
- Bound frames, output, recursion, search results, transfers, memory, and operation duration.
- Kill complete owned process trees without touching unrelated processes.
- Require an explicit capability for destructive filesystem and Git operations.
- Preserve OpenSSH host verification behavior and surface host-key failures distinctly.
- Sign release artifacts where platform support exists and always verify checksums.
- Never silently upload provider credentials.

Threat-model and security review gates are required before enabling write, Git mutation, or persistent PTY capabilities by default.

## Local Sidecar Direction

Workspace watching is the first local Rust slice. The Bun server supervises exactly one `bigbud-remote-agent --ephemeral` child, verifies the `workspace.watch` capability, and restarts it with bounded backoff. A new agent epoch forces resubscription and a rescan before exact events resume. `bigbud-workspace-watch` owns native/poll backend selection, reconciliation, the 100 ms batch, generations, sequences, and resource bounds for both local and managed-remote workspaces. Direct SSH remains an explicit bounded-polling exception because no agent is running on that host.

A broader local sidecar for files, search, Git, processes, or PTYs remains optional and should follow only when measurements show value.

Any broader local sidecar should continue using the repository's existing daemon patterns:

- Private Unix socket on macOS/Linux and named pipe on Windows.
- Health handshake and structured readiness state.
- Bounded restart backoff.
- Graceful shutdown followed by process-tree cleanup.
- Packaged, version-matched binary with diagnostics and repair support.

Do not use N-API for the initial systems core. A sidecar provides crash isolation, avoids Electron/Node ABI coupling, and lets the local daemon and remote agent share behavior. Reconsider in-process bindings only for a measured hot path where RPC overhead is material.

## Migration Plan

These phases describe rollout and verification gates. Some deliverables are
already implemented, as recorded in the Status section; their phase entries
remain as regression and release-evidence requirements rather than future work.

### Phase 0: Architecture and Baselines

Deliverables:

- Record an ADR confirming the ownership boundary and sidecar model.
- Inventory local and SSH implementations across files, search, Git, terminals, setup scripts, and every provider injection mode.
- Define a local/remote parity matrix and baseline latency, memory, process count, and reconnect behavior.
- Define supported remote platforms for the first release.
- Choose Rust minimum supported version and pin it in `rust-toolchain.toml`.

Exit gate:

- No unresolved ownership of provider state, canonical state, operation outcomes, or credential handling.

### Phase 1: Rust Foundation and Protocol

Deliverables:

- Add the Cargo workspace, formatting, linting, tests, dependency policy, and CI cache.
- Add generated protocol bindings for Rust and TypeScript.
- Implement framing, `hello`, capabilities, health, deadlines, and typed errors.
- Implement a local test harness that can inject disconnects, corrupt frames, delays, and partial writes.
- Produce unsigned development binaries for the initial platform matrix.

Exit gate:

- Protocol compatibility and malformed-input tests pass.
- The agent remains idle with no unbounded growth and exits cleanly.

### Phase 2: WorkspaceRuntime and Read Parity

Deliverables:

- Add transport-neutral TypeScript capability interfaces.
- Adapt existing local filesystem/search behavior behind the interfaces without changing user behavior.
- Implement remote `stat`, ranged read, directory list, glob, grep, executable discovery, and read-only Git operations.
- Add operation IDs, sequencing, acknowledgements, cancellation, and terminal result lookup.
- Route Files preview/search and Git read UI through the remote runtime.

Exit gate:

- The same conformance suite passes against local and remote implementations.
- Existing local project behavior and performance do not regress beyond agreed budgets.
- Remote read operations resume or fail with a precise terminal outcome after forced disconnects.

### Phase 3: Safe Mutations

Deliverables:

- Atomic file writes with expected content hashes.
- Create, rename, copy, remove, and permission operations.
- Git stage, unstage, branch, checkout, fetch, pull, push, commit, discard, and worktree operations.
- Idempotency journals and `unknown_outcome` handling for mutations.
- Approval and user-facing error mapping remain in TypeScript.

Exit gate:

- Disconnect tests prove that mutations are not duplicated.
- Path containment and symlink-escape security tests pass on every supported platform.
- Git parity tests cover repositories, submodules where supported, worktrees, hooks, authentication prompts, and large output.

### Phase 4: Processes, Terminals, and Watchers

Deliverables:

- Structured spawn, stdin, output, attach, status, signal, cancel, and terminate.
- Process-tree ownership and cleanup.
- Resumable PTY sessions with bounded history.
- Retain the implemented shared file watcher and verify its
  overflow/invalidation semantics across supported local and remote targets.
- Incremental indexing only if direct search measurements justify it.

Exit gate:

- Active operations and PTYs reattach inside the grace period without duplicated output.
- Remote agent restart, SSH loss, local server restart, and cancellation have separately verified outcomes.
- Long-running soak tests show bounded memory, CPU, journal disk use, and process count.

### Phase 5: All-Provider Adoption

Deliverables:

- Route every provider's remote workspace tools through `WorkspaceRuntime`.
- Remove synthetic workspace behavior only where the replacement is proven equivalent.
- Publish a provider-by-capability support matrix.
- Keep unsupported native tools disabled instead of allowing accidental local-file access.

Exit gate:

- Every supported provider passes common scenarios for read, search, edit, shell, cancellation, reconnect, and error reporting.
- No provider-specific behavior exists in Rust.
- Direct SSH fallback use is observable and limited to documented compatibility cases.

### Phase 6: Local Rust Sidecar

Deliverables:

- Package a local daemon using `bigbud-systems`.
- Add `LocalRustWorkspaceRuntime` behind a feature flag.
- Compare it against the existing TypeScript local backend using conformance, performance, and fault-injection tests.
- Migrate one capability group at a time.

Exit gate:

- Each migration demonstrates a measurable reliability, performance, or maintainability benefit.
- Rollback to the TypeScript implementation remains possible until the Rust path is stable across releases.

### Phase 7: Consolidation

Deliverables:

- Remove direct SSH and duplicate TypeScript systems implementations only after telemetry-free diagnostics and support evidence show the Rust path is reliable.
- Stabilize protocol support policy and old-agent upgrade behavior.
- Document contributor workflows and release certification.

Exit gate:

- Local and remote paths share the intended systems implementation without losing platform or provider coverage.

## Platform and Distribution Plan

Initial target matrix should be selected from actual supported SSH hosts, with the likely minimum:

| Platform | Architecture | Notes                                                                       |
| -------- | ------------ | --------------------------------------------------------------------------- |
| Linux    | x64          | Validate glibc baseline and consider musl for minimal hosts                 |
| Linux    | ARM64        | Required for common ARM servers                                             |
| macOS    | x64          | Remote Mac and local sidecar support                                        |
| macOS    | ARM64        | Apple Silicon support                                                       |
| Windows  | x64          | Requires explicit OpenSSH host, process-tree, path, ACL, and PTY validation |

Do not claim Windows remote parity until live Windows OpenSSH integration tests pass. Linux packaging must be validated against the oldest supported distribution rather than only the current CI image.

Release requirements:

- Reproducible release profile and locked Cargo dependencies.
- Per-target SHA-256 manifest tied to the desktop/server release.
- Atomic managed installation and rollback.
- Software bill of materials and dependency/license review.
- macOS signing/notarization and Windows signing included when the agent is bundled or separately distributed for those platforms.
- Packaged desktop smoke tests verify binary presence, execution, protocol compatibility, and cleanup.

## Quality Gates

Add Rust checks alongside, not instead of, the repository's required Bun checks:

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
bun fmt
bun lint
bun typecheck
bun run test
```

Focused suites should include:

- Rust unit tests for framing, containment, journal bounds, process trees, and protocol errors.
- TypeScript contract and error-mapping tests.
- Shared conformance tests against local and remote runtimes.
- Live SSH tests using disposable Linux hosts or containers with real `sshd`.
- macOS, Linux, and Windows packaged smoke tests.
- Fault injection for disconnect during reads, writes, Git mutations, process output, and final acknowledgements.
- Compatibility tests between the current client and supported older agent versions.
- Soak tests for repeated reconnects, large repositories, long output, and journal pressure.

Never use `bun test`; repository tests run through `bun run test`.

## Performance and Resource Budgets

Set measured budgets in Phase 0 before implementation. At minimum track:

- Agent binary size.
- Idle RSS and CPU.
- Startup and handshake latency.
- First and warm operation latency.
- SSH process and connection count.
- Search throughput and cancellation latency.
- Git status latency on small and large repositories.
- Reconnect-to-live and reconnect-to-result latency.
- Maximum journal disk use.
- Local RPC overhead compared with current direct TypeScript execution.

The agent must not be called lightweight based only on implementation language. It earns that label by meeting published idle, startup, binary-size, and bounded-resource targets.

## Rollout and Fallback

Current implementation status:

1. Supported remote workspaces select the agent before execution by default and use the managed `$HOME/.bigbud/agent/bin/current` path unless `BIGBUD_REMOTE_AGENT_BINARY` overrides it.
2. Provider remote-workspace bridges call the authenticated per-thread bigbud endpoint; they no longer construct or launch their own SSH workspace commands.
3. `BIGBUD_REMOTE_AGENT_TRANSPORT=direct-ssh` selects the centralized compatibility transport before execution. It is a recovery mode, not an automatic per-operation fallback.
4. An accepted agent operation is never retried through direct SSH after an ambiguous result.

Remaining rollout gates:

1. Record privacy-preserving lifecycle diagnostics: versions, capability, timings, reconnect reason classes, and terminal error codes. Never record commands, paths, file contents, prompts, or provider output.
2. Retain an explicit repair/reinstall action and direct SSH recovery mode until signed artifact delivery, live-host integration, soak, and provider parity evidence pass the supported matrix.
3. Remove the recovery mode only after at least one stable release has demonstrated parity on that matrix.

## Original First Implementation Slice

This section records the initial slice used to prove the architecture. It is
historical scope, not a list of remaining implementation work.

The first vertical slice should prove the architecture rather than maximize operation count.

Build:

- `hello`, `health`, and capability negotiation.
- Workspace registration with root containment.
- `stat`, bounded ranged file read, directory list, glob, grep, and read-only Git status/diff.
- Generic process `spawn`, `attach`, output read, status, cancel, and terminate for bounded non-interactive commands.
- Stable operation IDs, sequence acknowledgements, result lookup, and a bounded journal.
- SSH installation, launch, heartbeat, forced-disconnect reconnect, and upgrade checks.
- A `RemoteAgentWorkspaceRuntime` implementation used by Files preview/search and read-only Git UI.
- Conformance and live SSH tests.

Do not include in the first slice:

- Provider process hosting.
- Git or filesystem mutations.
- PTYs.
- File watchers or persistent indexing.
- Local Rust sidecar migration.

The first slice is successful when a remote file search or Git diff can continue or be deterministically recovered after the SSH transport is killed, while all canonical state and all provider execution remain local.

## Remaining Open Decisions

1. Which remote OS/architecture targets are required for the first public release?
2. What are the concrete idle memory, binary size, reconnect latency, and journal disk budgets?
3. How long may running operations and completed unacknowledged outcomes remain on the remote host?
4. Should direct SSH remain a permanent compatibility mode or only a migration fallback?
5. Which existing service becomes the first owner of the aggregate `WorkspaceRuntime`, or should focused filesystem/Git/process services share a lower-level execution target runtime?
6. Which protobuf TypeScript generator best fits the repository without introducing runtime barrel imports or duplicated validation?
7. What release-key and signing model will protect separately downloaded remote-agent artifacts?
8. Is Windows OpenSSH-host support required in the first milestone or explicitly deferred?

Resolve each still-open decision in an ADR before expanding or releasing the
affected capability.

## Success Criteria

The overall effort is successful when:

- Remote projects expose the same supported workspace operations as local projects through one provider-neutral contract.
- All providers use the normalized runtime without provider-specific Rust code.
- Temporary SSH loss does not cancel resumable remote operations.
- Reconnect never duplicates a confirmed file or Git mutation.
- Canonical application and provider state remains local.
- Remote state is bounded, temporary, private, and safely recoverable.
- The Rust binaries meet explicit resource budgets across supported platforms.
- Electron, the React UI, and TypeScript product/orchestration layers remain independently maintainable.
- Each later migration into Rust is justified by measured reliability, performance, or maintainability gains rather than language preference alone.
