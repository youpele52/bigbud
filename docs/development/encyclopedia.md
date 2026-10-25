# Codebase glossary

This glossary explains terms used in bigbud's orchestration, provider, and checkpointing code. For an overview, see [Architecture](./architecture.md).

## Project and workspace

### Project

A project groups threads and workspace metadata. Its contract is defined in [`orchestration.project.ts`](../../packages/contracts/src/orchestration/orchestration.project.ts); see the [package roles](../../AGENTS.md#package-roles).

### Workspace root

The filesystem root associated with a project. Workspace paths and project metadata are represented by the orchestration contracts; Git and workspace operations are implemented in the server.

### Worktree

A Git worktree used as an isolated workspace. Worktree lifecycle and ownership are handled by the Git services, beginning with [`GitCore.ts`](../../apps/server/src/git/Layers/GitCore.ts).

## Thread timeline

### Thread

A durable conversation and workspace-history record. Thread state and events are described in the [orchestration contracts](../../packages/contracts/src/orchestration/orchestration.thread.ts) and applied by the server projector.

### Turn

A user-to-assistant work cycle in a thread. Provider events are ingested by [`ProviderRuntimeIngestion`](../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts); checkpoint and other follow-up work may continue after the initial request is accepted.

### Activity

A user-visible record of a non-message event, such as an approval, tool action, or failure. The orchestration contracts define the event shapes; [`projector.ts`](../../apps/server/src/orchestration/projector.ts) applies them to thread state.

## Orchestration

Orchestration converts commands and provider activity into durable domain events and projected state. The main service is [`OrchestrationEngine`](../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts), with decision logic in [`decider.ts`](../../apps/server/src/orchestration/decider.ts) and event projection in [`projector.ts`](../../apps/server/src/orchestration/projector.ts).

### Command

A typed request to change domain state. Command invariants are checked in [`commandInvariants.ts`](../../apps/server/src/orchestration/commandInvariants.ts), and accepted commands are translated into events by the decider.

### Domain event

A recorded fact that has occurred. Event contracts are defined under [`packages/contracts/src/orchestration`](../../packages/contracts/src/orchestration/); the projector applies those events to read models.

### Projection and read model

A projection is a read-optimized view derived from domain events. The server's projection pipeline is [`ProjectionPipeline.ts`](../../apps/server/src/orchestration/Services/ProjectionPipeline.ts), and snapshot queries are exposed by [`ProjectionSnapshotQuery.ts`](../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts).

### Reactor

A service that handles follow-up work triggered by domain events or provider runtime signals. Examples include [`ProviderCommandReactor`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts) and [`CheckpointReactor`](../../apps/server/src/orchestration/Layers/CheckpointReactor.ts).

### Receipt

An internal signal used to coordinate completion of a runtime milestone. The receipt service is [`RuntimeReceiptBus`](../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts); it is not a user-facing event stream.

## Provider runtime

### Provider

A provider is an agent runtime used to perform work. [`ProviderService`](../../apps/server/src/provider/Layers/ProviderService.ts) coordinates sessions and turns through the [`ProviderAdapter` contract](../../apps/server/src/provider/Services/ProviderAdapter.ts); adapter registration is maintained by [`ProviderAdapterRegistry`](../../apps/server/src/provider/Layers/ProviderAdapterRegistry.ts).

### Session

A live provider-backed runtime associated with a thread. The orchestration contract records session state, while `ProviderService` manages provider lifecycle and routing.

### Runtime mode

The thread's access policy: `approval-required`, `auto-accept-edits`, or `full-access`. These are product-level modes, not a guarantee that every provider maps them to identical native permissions. See [Runtime modes](./runtime-modes.md) and the [shared runtime constants](../../packages/contracts/src/constants/runtime.constant.ts).

### Interaction mode

Controls whether the assistant uses the default interaction style or plan mode. Values are `default` and `plan`; see the [provider interaction mode contract](../../packages/contracts/src/orchestration/orchestration.provider.ts).

### Assistant delivery mode

Describes how assistant text is delivered to the timeline, such as incrementally (`streaming`) or after completion (`buffered`). Provider and orchestration code own the delivery behavior.

### Snapshot

A point-in-time view of state. The term is used by orchestration, providers, and checkpointing; for orchestration snapshots, see [`ProjectionSnapshotQuery`](../../apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts).

## Checkpointing

Checkpointing records workspace state so bigbud can show changes over time and restore supported prior states. Its main services include [`CheckpointStore`](../../apps/server/src/checkpointing/Services/CheckpointStore.ts), [`CheckpointDiffQuery`](../../apps/server/src/checkpointing/Services/CheckpointDiffQuery.ts), and [`CheckpointReactor`](../../apps/server/src/orchestration/Layers/CheckpointReactor.ts).

### Checkpoint and checkpoint ref

A checkpoint identifies a recorded workspace state. Storage and Git-ref handling live in [`CheckpointStore`](../../apps/server/src/checkpointing/Services/CheckpointStore.ts); checkpoint-related orchestration state is projected separately.

### Checkpoint diff and turn diff

A checkpoint diff is the patch between recorded workspace states. [`CheckpointDiffQuery`](../../apps/server/src/checkpointing/Services/CheckpointDiffQuery.ts) reads the changes, and [`Diffs.ts`](../../apps/server/src/checkpointing/Diffs.ts) contains diff utilities. A turn diff is the change summary associated with a turn and represented in the orchestration contracts.

## Desktop orchestration delivery

### Canonical domain authority

The TypeScript server and SQLite state define which orchestration events exist, their order, authorization, and product meaning. This is not the desktop supervisor or a delivery transport.

### Desktop delivery supervisor

The Rust sidecar that coordinates bounded delivery of canonical events to an attached supported desktop consumer. It is not an application server or canonical event store.

### Delivery authority

The single active route allowed to deliver canonical events to a consumer. A supervisor-managed consumer uses the Rust route unless a fenced controlled fallback has occurred.

### Application acknowledgement

The consumer's confirmation that it has applied a contiguous event batch and reconciled canonical ownership. A WebSocket write, mere receipt, or partial application is not an application acknowledgement.

### Controlled fallback

A fenced transition to TypeScript delivery after bounded supervisor recovery is exhausted. The failed session does not concurrently deliver through both routes or switch back to Rust mid-session.

### Direct unmanaged delivery

The supported TypeScript delivery path for consumers without a native supervisor distribution, such as standalone-server and mobile-remote consumers. Its use is not evidence that a packaged desktop supervisor failed.

See the [delivery architecture](./architecture.md#desktop-event-delivery) and [accepted ownership decision](../decisions/2026-08-27-desktop-delivery-supervisor-authority.md). Distribution terms such as build mode, stable release, and prerelease are defined in the [release guide](./release.md#distribution-terminology).

## Practical shortcuts

- `requested` usually describes recorded intent; it does not by itself prove that an external side effect completed.
- A `completed` event records an outcome, subject to the semantics of that event.
- A receipt is an internal coordination signal, not a replacement for persisted domain state.
- A checkpoint is a workspace-state record; a diff describes changes between states.
