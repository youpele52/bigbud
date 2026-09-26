# Rust-owned system resources integration plan

**Date:** 26 September, 2026
**Status:** Proposed — rough plan requiring refinement before implementation
**Owner:** Planning agent
**Target branch:** `dev`

## Summary

This is intentionally a rough first plan. It captures the desired ownership boundary and phased direction, but needs smoothing, code-path validation, dependency review, protocol design, UX refinement, and platform-specific investigation before implementation.

The core rule is:

> **Rust owns system resource truth and system actions. Electron/TypeScript owns presentation and user intent.**

Phase 1 is read-only: Rust talks to the OS, samples and normalizes resource data, reports capabilities, and streams typed snapshots. Electron/React renders graphs, tables, filtering, sorting, and drill-down.

Phase 2 adds explicit resource-control commands. Electron and, later, agents may request actions, but Rust validates and performs the actual OS operation. Agent mutations use the same typed command path as human mutations and remain subject to approval/policy.

The likely portable observation foundation is the Rust `sysinfo` crate, supplemented by platform-native APIs where sysinfo is insufficient.

## Related Work

- Source: product/architecture discussion that requested this plan. No stable bigbud note, Kanban card, issue, or PR was supplied.
- `crates/AGENTS.md`: Rust native components own close-to-the-metal platform operations and a native supervisor may own native resource monitoring behind a narrow, versioned contract.
- `crates/bigbud-desktop-supervisor`: current local native sidecar.
- `crates/bigbud-remote-agent`: potential later consumer for remote resource monitoring/control.
- `crates/bigbud-protocol` and `protocol/`: existing Rust protocol infrastructure.
- `packages/contracts`: TypeScript schema boundary.
- README "Desktop Event Delivery": existing Rust/TypeScript sidecar boundary.
- Repository: https://github.com/youpele52/bigbud

Create/link a tracking issue or stable bigbud planning item if this advances toward implementation.

## Problem

bigbud does not currently expose a first-class cross-platform resource model that can be displayed consistently and later reused for safe resource-management actions.

Querying OS state independently from Electron/Node, shell commands, agents, and Rust would create competing sources of truth, duplicate platform behavior, leak Windows/macOS/Linux differences into UI code, and complicate future control operations.

The desired boundary is stronger:

- Rust communicates with the OS and owns collection.
- Rust owns normalization, sampling, capability detection, and later mutation.
- Electron/TypeScript does not independently infer authoritative resource state.
- Electron/React presents state and captures user intent.
- Agents eventually consume the same typed observation/command capabilities rather than gaining a separate privileged path.

The first milestone should validate observation, transport, cross-platform coverage, performance, and UI before destructive capabilities are introduced.

## Goals

- Establish Rust as the sole authority for system resource observation and future control.
- Define bigbud-owned resource types instead of exposing sysinfo types outside Rust.
- Support macOS, Windows, and Linux with explicit capability reporting.
- Use sysinfo where appropriate and isolate native extensions behind focused Rust modules.
- Stream bounded typed snapshots; do not make Electron poll the OS directly.
- Add an easy-to-digest System UI with graphs, summaries, process tables, filtering, sorting, and drill-down.
- Keep Phase 1 read-only and independently useful.
- Route Phase 2 human and agent mutations through the same typed Rust command interface.
- Preserve explicit approval/policy boundaries for destructive agent actions.
- Leave a path to reuse the Rust implementation for managed remote agents.

## Non-Goals

- Resource-control operations in Phase 1.
- Direct agent access to sysinfo/native OS APIs.
- A second Electron/Node OS-monitoring implementation.
- Pretending every metric/control is identical across all OSes.
- Fake zero values for unsupported metrics.
- Requiring GPU, fan, or temperature telemetry for the first shippable milestone.
- Adding cgroups, Job Objects, ETW/PDH, IOKit/Mach, or similar native integrations before a concrete requirement.
- Changing existing provider/computer-use behavior merely to support this feature.
- Requiring remote monitoring in the first local milestone.

## Current State

Revalidate exact paths/line numbers before implementation; this rough plan was written against an active `dev` branch.

### Existing boundary

- Root `AGENTS.md` assigns server logic to `apps/server`, UI to `apps/web`, the Electron shell to `apps/desktop`, and schemas to `packages/contracts`.
- `crates/AGENTS.md` defines Rust as the home for close-to-the-metal services and explicitly permits native resource monitoring.
- The Rust workspace currently contains `bigbud-desktop-supervisor`, `bigbud-protocol`, `bigbud-remote-agent`, and `bigbud-workspace-watch`.
- `bigbud-remote-agent` already demonstrates cfg/target-specific Rust dependencies.
- The desktop supervisor already communicates with TypeScript over framed stdio.
- `apps/web` already depends on Recharts, so Phase 1 should first evaluate reuse rather than add another chart dependency.

### Proposed ownership

| Responsibility | Owner |
| --- | --- |
| Read CPU/memory/process/disk/network/sensors | Rust |
| Sample counters and calculate authoritative rates/deltas | Rust |
| Normalize OS-specific values | Rust |
| Detect supported capabilities | Rust |
| Apply process/resource mutations | Rust, Phase 2 |
| Talk directly to sysinfo/native APIs | Rust only |
| Transport typed state/commands | Versioned Rust/TypeScript contract |
| Graphs/tables/search/filter/sort/drill-down | Electron/React |
| Capture human intent | Electron/React |
| Approve agent mutation | Existing app approval/policy layer |
| Execute approved mutation | Rust |

### Candidate Rust shape

Do not create a new crate until Phase 0 validates the boundary. A likely reusable shape is:

```text
crates/bigbud-system/
  src/
    observation/
      cpu.rs
      memory.rs
      process.rs
      disk.rs
      network.rs
      sensors.rs
    capabilities/
    platform/
      linux/
      windows/
      macos/
    control/       # Phase 2
```

Potential consumers are `bigbud-desktop-supervisor` locally and `bigbud-remote-agent` later. If only the supervisor is proven during Phase 1, first consider a clean internal supervisor module instead of prematurely creating a shared crate.

### Candidate resource model

The wire/public contract should use bigbud-owned types such as `SystemSnapshot`, `CpuSnapshot`, `MemorySnapshot`, `DiskSnapshot`, `NetworkSnapshot`, `ProcessSnapshot`, and `SystemCapabilities`.

Capabilities should be explicit rather than inferred from OS names, for example:

```text
cpu.read
cpu.perCore
cpu.limit
memory.read
memory.perProcess
memory.limit
process.list
process.kill
process.suspend
process.priority
disk.usage
disk.io
disk.limit
network.throughput
network.connections
pressure.cpu
pressure.memory
sensors.temperature
gpu.metrics
```

UI code should ask capabilities rather than scatter platform-name checks throughout React.

## Phases

### Phase 0 — Smooth the rough plan and prove boundaries

**Goal:** make this implementation-ready before adding production dependencies/protocol surface.

1. Reinspect current desktop-supervisor ownership, framed stdio protocol, TypeScript codecs/contracts, right-panel UI, and remote-agent protocol.
2. Review the exact sysinfo version: maintenance, license, targets, transitive dependencies, unsafe surface, binary/build cost, and default features. Obtain dependency approval required by `crates/AGENTS.md`.
3. Build a macOS/Windows/Linux metric coverage matrix. Mark metrics portable, platform-specific, unavailable, expensive, or permission-dependent.
4. Decide whether Phase 1 lives inside `bigbud-desktop-supervisor` or immediately warrants `bigbud-system`.
5. Define request/response versus streaming, subscription lifecycle, cadence, sequence semantics, stale-data behavior, reconnects, and backpressure.
6. Define Rust-derived versus UI-derived values. Default: Rust owns sampling and authoritative rates/deltas; UI owns presentation formatting/history.
7. Decide whether resource telemetry belongs in the existing supervisor protocol or a focused channel/protocol.
8. Produce initial schemas and payload/CPU estimates.

**Exit criterion:** dependency, ownership, transport, schemas, cadence, and Phase 1 metrics are reviewed rather than rough assumptions.

### Phase 1 — Read-only Rust observation and Electron display

**Goal:** ship a useful cross-platform viewer with no resource mutations.

Rust responsibilities:

- Retain collector state across samples when metrics depend on deltas.
- Collect agreed CPU, memory, process, disk, network, host, and supported sensor data.
- Normalize units/semantics into bigbud-owned types.
- Calculate authoritative rates/deltas in Rust.
- Report capabilities/unavailable fields explicitly.
- Bound sampling work, memory, queues, and process payloads.
- Give sampler tasks explicit lifecycle/cancellation.
- Reduce/stop expensive sampling when no consumer needs it where practical.
- Return typed diagnostics for permissions/unavailable data.
- Keep platform code behind small cfg-gated modules.

Transport responsibilities:

- Use a narrow, versioned contract.
- Consider separating lightweight summaries from full process data.
- Treat ~1 Hz summary sampling as a starting hypothesis, not a committed constant.
- Avoid resending static process metadata every tick if measurement justifies a delta/split model.
- Detect sequence gaps/stale streams and recover with an explicit fresh snapshot.
- Ensure telemetry cannot starve existing orchestration delivery.

Electron/React responsibilities:

- Add a System surface; a right-panel tab is the current candidate, subject to UX review.
- Display CPU total/per-core, memory/swap, disk capacity/I/O, network throughput, and processes where supported.
- Add process search/filter/sort.
- Add short rolling history graphs for useful summaries.
- Show unsupported/unavailable states clearly rather than fake zeros.
- Show enough machine/platform identity to know which host is observed.
- Use capability-aware UI.
- Keep chart/display state in UI; do not make React the authoritative sampler.

Measure 1 Hz/faster refresh cost, process-count scaling, sysinfo refresh overhead, IPC bandwidth, chart-history memory, closed-panel behavior, suspend/wake, supervisor restart, and slow-renderer backpressure.

**Exit criterion:** macOS, Windows, and Linux display the agreed baseline through the Rust-owned path with bounded overhead and no OS querying in Electron/Node.

### Phase 2 — Explicit Rust resource-control commands

**Dependency:** Phase 1 contracts/capabilities are stable.

Candidate operations, introduced individually only after semantics are understood:

- terminate process;
- suspend/resume process;
- change priority;
- later CPU, memory, and I/O limits.

Use typed commands/results. Do not rely on PID alone for destructive operations if PID reuse could target a different process; investigate process start time or native identity checks.

Rust must validate arguments, revalidate target identity, verify capability, perform the native operation, and return typed outcomes such as succeeded, denied, unsupported, stale-target, or failed. Request acceptance alone is not success.

Electron captures intent and renders confirmations/results. It must not fall back to shell commands or a second control path when Rust reports unsupported/denied.

**Exit criterion:** selected human controls execute through one typed Rust path with stale-target protection, capability checks, clear results, and tests.

### Phase 3 — Agent access through the same model

**Dependency:** Phase 2 control and approval semantics are proven for humans.

Read-only tools may expose system status, process list/details, disk status, and network status. Large inventories need bounded/filterable responses.

Mutations converge on the same command path:

```text
human UI ---------\
                   > resource command -> approval/policy -> Rust -> OS
agent request -----/
```

Agents never call sysinfo/native APIs directly and do not receive an alternate shell-based mutation path for convenience. Rust revalidates targets after approval because system state may change while approval is pending. Provider bridges should expose the same semantic tools rather than provider-specific resource behavior.

**Exit criterion:** agents can explain observed usage and, when explicitly approved, request supported mutations through the same Rust boundary as humans.

### Phase 4 — Remote resources and deeper native capabilities

**Dependency:** local observation/control is stable and remote protocol cost is justified.

Potential work:

- reuse the implementation from `bigbud-remote-agent`;
- select local/remote machine in System UI;
- add remote capability negotiation;
- add Linux PSI/cgroup v2 where required;
- add Windows Job Objects/PDH/ETW/native process APIs where required;
- add macOS Mach/IOKit/public native facilities where required;
- investigate GPU/vendor APIs separately.

Preserve remote-agent bounded journal/reconnect/security invariants and do not broaden remote authority implicitly.

## Risks And Decision Gates

- **Roughness:** Phase 0 is mandatory; this file is not implementation-ready merely because it is committed.
- **sysinfo coverage:** validate exact-version behavior per OS before promising metrics.
- **Dependency approval:** adding sysinfo requires the review/approval specified in `crates/AGENTS.md`.
- **Crate boundary:** do not create `bigbud-system` until reuse/deployment boundaries justify it.
- **Protocol interference:** telemetry must not weaken desktop-supervisor orchestration delivery.
- **Sampling overhead:** process-heavy hosts may make naive full refresh/serialization expensive.
- **Semantic mismatch:** memory, CPU, disk, sensors, pressure, and limits differ across OSes; document normalized semantics.
- **Permissions:** process details/control may be denied. Treat this as capability/diagnostic state.
- **PID reuse:** destructive commands need stale-target protection.
- **Agent safety:** agent control is gated behind proven human control and approval semantics.
- **Sensitive data:** process command lines, paths, usernames, network endpoints, and similar fields may be sensitive; include only what the UI/tool needs.
- **Remote expansion:** local success does not automatically justify extending remote authority/protocol.

## Testing And Validation

Before implementation, name exact tests after finalizing the protocol/modules. At minimum plan for:

- Rust unit tests for normalization, capabilities, rate calculations, stale identity, unsupported fields, and typed errors.
- Rust lifecycle/backpressure tests for sampler cancellation, bounded queues, slow consumers, and reconnect/resubscribe.
- Protocol compatibility tests for snapshots, capabilities, commands, unknown fields/versions, malformed frames, and size limits.
- Server/Electron integration tests proving resource traffic cannot break orchestration delivery.
- React tests for graphs/tables, unsupported states, sorting/filtering, reconnect/stale state, and accessibility.
- Cross-platform manual/smoke validation on macOS, Windows, and Linux.
- Phase 2 real-process tests using safe spawned test processes rather than arbitrary host processes.
- Phase 3 approval tests proving agents cannot bypass mutation policy.

Required repository checks for implementation changes:

```sh
bun fmt
bun lint
bun typecheck
bun run test
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets -- -D warnings
cargo test --locked --workspace
```

Do not use `bun test`.

## Acceptance Criteria

### Phase 1

- Rust is the sole OS-resource observation authority.
- Electron/Node does not independently query authoritative system metrics.
- Baseline macOS/Windows/Linux metrics render through a versioned Rust contract.
- Unsupported metrics are explicit.
- Sampling/transport are bounded and measured.
- UI presents useful graphs/tables without owning sampling logic.
- Restart/reconnect/stale-stream behavior is predictable.

### Phase 2

- Resource mutations execute only in Rust.
- Human commands use typed contracts/results and capability checks.
- Destructive process actions protect against stale/reused targets.
- Unsupported/denied actions do not silently fall back to another path.

### Phase 3

- Agents use the same observation and mutation model as humans.
- Agent mutations pass through applicable approval/policy.
- No agent-specific privileged OS-control implementation exists.

## Open Questions

- Should Phase 1 start inside `bigbud-desktop-supervisor` or create `bigbud-system` immediately?
- Should telemetry share the desktop-supervisor framed protocol or use a focused channel?
- Which exact metrics form the minimum Phase 1 cross-platform baseline?
- What default sampling cadence is acceptable after measurement?
- Should process metadata and live process stats use separate streams?
- How much chart history belongs only in renderer memory versus Rust?
- Which process fields are necessary without exposing sensitive command lines/paths?
- Is a right-panel System tab the desired UX, or should System become a larger standalone workspace?
- When should remote monitoring enter scope?
- Which Phase 2 controls are valuable enough to justify native per-OS implementations?
- What exact stable process identity should destructive commands use on each OS?
- Which read-only resource tools should agents receive before any mutation tools?
- Should capability reporting distinguish unsupported, unavailable, permission-denied, and temporarily-unobservable states?

Update this plan as those questions are answered. The immediate next step is **plan refinement and technical validation, not implementation**.
