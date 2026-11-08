# OpenCode 2 bigbud Fit Assessment

**Date:** 29 September, 2026

**Status:** Historical assessment — implementation in progress

> **8 October 2026:** The separate provider is now integrated. Use the [current completion plan](./2026-10-08-opencode-v2-preview-completion-plan.md) for code status, documentation changes and remaining implementation. Findings below describe the September 2.0.19 research baseline; they are not fresh claims about latest 2.0.26 behavior. The questions below were subsequently addressed in the original implementation plan's D1–D8; do not restart those decisions from this assessment.

**Owner:** bigbud

## Summary

OpenCode 2 is a strong architectural fit for a **new, separate bigbud provider**, but it is not a drop-in or perfect production replacement for the existing OpenCode provider today.

The released `@opencode/client@2.0.19` and `opencode v2.0.19` provide nearly every functional primitive bigbud needs: external server operation, explicit workspace locations, sessions, queued prompts, model switching, attachments, permissions, forms, MCP servers, rich lifecycle events, message reconciliation, usage, and interruption.

The safe direction is:

- keep `opencode` and KiloCode on the existing V1-compatible adapter;
- add a permanent internal provider ID such as `opencodeV2` using a separate adapter and server manager;
- expose it initially as **OpenCode v2 (Preview)**;
- later make its display name **OpenCode** without changing persisted provider IDs.

OpenCode 2 should not replace the current provider until event-gap recovery, interaction loss, MCP isolation, remote execution, packaging, and critical experimental API dependencies are proven under bigbud's workloads.

## Related Work

- Actionable side-by-side rollout plan: [`2026-09-29-opencode-v2-provider-implementation-plan.md`](./2026-09-29-opencode-v2-provider-implementation-plan.md)
- Existing research: [`OPENCODE-V2-SDK-WAIT.md`](./OPENCODE-V2-SDK-WAIT.md)
- OpenCode V1-to-V2 guide: <https://opencode.ai/v2/docs/migrate-v1/>
- OpenCode JavaScript client: <https://opencode.ai/v2/docs/build/client>
- OpenCode generated API reference: <https://opencode.ai/v2/docs/api>
- OpenCode `v2.0.19` source: <https://github.com/anomalyco/opencode/tree/v2.0.19>
- KiloCode V2 migration epic: <https://github.com/Kilo-Org/kilocode/issues/12887>

No bigbud note or Kanban card was identified for this investigation.

## Problem

bigbud's current OpenCode integration is a mature provider implementation, not a thin SDK wrapper. It owns:

- local and SSH server processes;
- local-runtime/remote-workspace separation;
- per-thread orchestration and remote-workspace MCP bridges;
- model discovery and persisted caches;
- prompt attachments and dynamic system instructions;
- streaming text, reasoning, tools, plans, permissions, and questions;
- bounded SDK deadlines, event reconnects, final-output reconciliation, and duplicate-settlement prevention;
- canonical usage and lifecycle events;
- KiloCode compatibility through shared V1 protocol modules.

A new provider fits only if OpenCode 2 can preserve those guarantees without silently routing KiloCode through incompatible contracts.

## Goals

- Determine whether OpenCode 2 exposes every capability required by bigbud.
- Identify protocol gaps, experimental dependencies, and reliability risks.
- Define the adapter architecture needed to avoid regressions and cross-thread leakage.
- Establish explicit gates for preview and eventual replacement of the current OpenCode provider.

## Non-Goals

- Implement the provider in this assessment.
- Replace or migrate existing OpenCode/KiloCode sessions.
- Rename persisted provider IDs.
- Claim production parity from documentation or type compatibility alone.
- Adopt the embedded `@opencode/sdk`; bigbud requires the external process boundary provided by `opencode serve` and `@opencode/client`.

## Current State

### bigbud

The existing implementation spans approximately 9,000 lines across `apps/server/src/provider/Layers/Opencode/` and its tests. Important seams include:

- adapter composition: `apps/server/src/provider/Layers/Opencode/Adapter.ts`;
- session creation: `Adapter.session.start.ts`;
- prompt completion and recovery: `Adapter.session.prompt.ts` and `Adapter.session.turn.sendTurn.ts`;
- canonical event mapping: `Adapter.stream.ts` and `Adapter.stream.mapEvent*.ts`;
- liveness inspection: `Adapter.activeTurnInspection.ts`;
- process ownership: `ServerManager.ts` and `ServerManager.child.ts`;
- orchestration MCP: `apps/server/src/orchestration-tools/orchestrationMcpBridge.session.ts`;
- remote workspace bridge: `OpencodeRemoteWorkspaceBridge.ts`;
- shared Kilo boundary: `apps/server/src/provider/Layers/Kilocode/Adapter.ts`.

The current provider uses `@opencode-ai/sdk@^1.17.13` through its `/v2` export. That export belongs to the OpenCode 1 server architecture and is unrelated to released OpenCode 2.

### OpenCode 2 evidence baseline

This assessment checked:

- npm packages `@opencode/client@2.0.19`, `@opencode/sdk@2.0.19`, and related protocol/schema packages;
- OpenCode tag `v2.0.19` (`1fd016ef32286de9489b7b24f1029f52c49a27b3`);
- current `v2` branch (`a565ea8c74307e407b1a5e45689d87b5e36c005d` at investigation time);
- official V2 documentation;
- a bounded local probe using the installed `opencode v2.0.19` and published `@opencode/client@2.0.19`.

The probe successfully exercised authenticated startup, server information, Location resolution, provider/model discovery, session creation, active-session inspection, message listing, permission/form listing, MCP listing, live event subscription, interruption, and deletion.

A bounded prompt probe observed these live events in order:

1. `session.inbox.enqueued`
2. `session.execution.started`
3. `session.instructions.updated`
4. `session.inbox.delivered`
5. `session.step.started`
6. `session.step.failed`
7. `session.execution.failed`

`session.wait()` returned and the final projected assistant/idle messages were available. The model request itself failed with a scoped free-tier authorization rejection, so the probe does not claim successful provider-generation parity.

## Capability Fit Matrix

| bigbud requirement               | OpenCode 2 evidence                                                                                 | Fit                                                       |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| External process and HTTP client | `opencode serve` plus `@opencode/client`; verified locally                                          | Strong after startup adapter changes                      |
| Session create/get/delete        | Stable `/api/session` operations; verified                                                          | Strong                                                    |
| Prompt admission and queueing    | Durable inbox with `steer`/`queue`, `resume`, idempotent message ID                                 | Strong                                                    |
| Completion and interruption      | Execution terminal events, `session.active`, projected outcome, messages, `session.wait`, interrupt | Strong, but `wait` is experimental                        |
| Model/provider discovery         | Rich model limits, capabilities, variants, costs, provider IDs                                      | Functionally strong; routes are marked experimental       |
| In-session model switching       | `session.switchModel` with provider/model/variant references                                        | Strong                                                    |
| Text/reasoning/tool streaming    | Explicit start/delta/end and terminal tool events                                                   | Strong while connected                                    |
| Usage                            | Session totals and step events expose input/output/reasoning/cache tokens and cost                  | Strong                                                    |
| Attachments                      | Data URLs and `file:` URIs, image normalization, PDF/image support, 20 MiB limit                    | Strong with bigbud translation                            |
| Dynamic system instructions      | Keyed session instruction-entry APIs                                                                | Strong replacement for per-turn `system`                  |
| Permissions                      | Session rules, pending-list API, replies, saved approvals                                           | Strong while the server process survives                  |
| Questions/user input             | Session forms support structured fields, list/get/reply/cancel                                      | Stronger schema than V1 questions, but process-local      |
| MCP runtime registration         | Add/remove/connect/disconnect and per-Location catalogs                                             | Functionally strong; mutation routes are experimental     |
| Per-thread tool isolation        | Session permission rules can remove denied MCP tools from the model-visible snapshot                | Feasible; requires exact namespace rules and tests        |
| Remote directory scope           | Explicit `Location` on relevant operations                                                          | Strong for paths visible to the provider runtime          |
| bigbud remote workspace bridge   | Can run from a synthetic local Location with built-ins denied and remote MCP allowed                | Plausible, not yet proven end to end                      |
| SSH provider runtime             | CLI supports explicit host/port; bigbud can retain SSH forwarding                                   | Feasible after authentication/startup changes             |
| Native title/summary             | `session.generate` and normal prompt paths return text                                              | Usable, but no V1-style structured-output contract        |
| Session history/reconciliation   | Projected session/messages and active/outcome state are authoritative                               | Strong for state backfill                                 |
| Event replay                     | Experimental `session.log` exists                                                                   | Not reliable in the standard server configuration         |
| Process-restart continuation     | Managed-service code has restart continuity                                                         | Does not directly match bigbud-owned standalone processes |
| KiloCode compatibility           | Kilo remains on the V1 architecture                                                                 | No shared V2 adapter; deliberate separation required      |

## Critical Findings

### 1. The current bigbud process manager is incompatible as written

OpenCode 2 startup differs from OpenCode 1:

- `--stdio --port 0` prints a JSON readiness line such as `{ "url": "..." }`.
- Every server is password-protected.
- An explicit `OPENCODE_PASSWORD` should be generated and passed to the process.
- `@opencode/client` must receive Basic authorization headers.
- `--stdio` treats stdin EOF as the ownership lease.
- Default output is `server listening on ...`, not the V1 line parsed by `readManagedServerListeningUrl()`.

A V2-specific manager is required. Reusing the V1/Kilo parser or unauthenticated client would fail.

Source evidence:

- OpenCode: `packages/cli/src/server-process.ts`
- OpenCode: `packages/cli/src/services/standalone.ts`
- bigbud: `apps/server/src/provider/Layers/Opencode/ServerManager.child.ts`

### 2. V2 needs one server-level event hub, not one subscription per session

`/api/event` is process-global and carries events for every active Location and session. OpenCode issue [#36441](https://github.com/anomalyco/opencode/issues/36441) tracks server-side scoping and payload bounds.

The current bigbud adapter opens an event subscription per active session. Copying that design would cause every V2 session to receive and decode every event, producing N-way duplicate work and potentially N² filtering behavior.

The V2 manager should own exactly one authenticated client and one live event connection per server process. A bounded hub should demultiplex by session ID/Location into adapter records. Reconnect must replace, never overlap, the previous stream.

### 3. The documented durable session log is not a recovery foundation today

The API describes `/api/experimental/session/:sessionID/log` as a durable replay stream. In the `v2.0.19` standard server path:

- `packages/server/src/routes.ts` passes `options.events?.persist` into the Bus;
- `packages/core/src/bus.ts` defaults persistence to `false`;
- `packages/cli/src/server-process.ts` does not enable event persistence for ordinary `serve` processes.

The local probe confirmed the consequence. After a turn reached aggregate sequence 7, the log returned only:

```text
log.synced seq=7
```

It returned none of the seven historical lifecycle events that had been observed live.

Therefore bigbud must not rely on `session.log()` for gap recovery unless upstream changes or a supported server option enables persistence. Recovery should use projected messages, session outcome/idle time, `session.active`, pending permissions, and pending forms—similar to bigbud's current authoritative reconciliation strategy.

### 4. Live event loss is expected by contract

Official client documentation states that live subscriptions have no replay or automatic reconnection. The event endpoint is explicitly volatile and can terminate when a consumer overflows.

A V2 adapter must retain bigbud's bounded reconnect, deadline, fencing, and duplicate-settlement logic. On every reconnect it must reconcile:

- `session.active()`;
- `session.get()` outcome and idle watermark;
- `message.list()` or `session.message.get()`;
- `permission.list({ sessionID })`;
- `session.form.list({ sessionID })`.

Live text/reasoning deltas may be lost; terminal full-value events and projected messages must repair the final output.

### 5. Pending permissions and forms are process-local

OpenCode `v2.0.19` keeps pending permissions in a `Map` and forms in an in-memory `Cache`. They are not restored after server replacement. Relevant open issues include:

- [#36347](https://github.com/anomalyco/opencode/issues/36347): preserve permission/question waits across restart;
- [#36585](https://github.com/anomalyco/opencode/issues/36585): pending forms become unanswerable after restart;
- [#34853](https://github.com/anomalyco/opencode/issues/34853): serialize concurrent prompt settlement.

bigbud must treat provider-process death during an interaction as an explicit interrupted/failed turn, clear stale UI requests, and offer retry. It cannot promise transparent continuation of an in-flight approval or form yet.

### 6. MCP isolation is feasible but must be redesigned

The V1 adapter asks for all tool IDs and sends a per-prompt boolean map. OpenCode 2 does not expose the same prompt tool map.

OpenCode 2 constructs MCP permission action names as:

```text
<sanitized-server-name>_<sanitized-tool-name>
```

Before each model step, tools wholly denied by session permissions are removed from the model-visible snapshot. bigbud can therefore:

1. deny `bigbud_orchestration_*` by default;
2. allow only the current thread's orchestration namespace;
3. deny default local file/shell tools for synthetic remote workspaces;
4. allow only the current remote-workspace MCP namespace;
5. remove, not merely disconnect, per-thread runtime MCP entries during cleanup.

This needs conformance tests proving one thread cannot discover or invoke another thread's tools.

### 7. Version coupling must be explicit

The V2 client is generated from the server contract. bigbud should pin an exact `@opencode/client` version and reject incompatible CLI versions during provider readiness checks.

`@opencode/client@2.0.19` expects Effect `4.0.0-rc.112`, while bigbud currently uses `4.0.0-beta.43`. Bun can install the Promise client with isolated transitive Effect copies, and a runtime import probe succeeded, but this creates:

- duplicate Effect versions in the dependency graph;
- potential bundle-size impact because the server build inlines dependencies;
- a risk if code accidentally imports the Effect client entrypoint.

Use only the Promise entrypoint and measure the packaged server delta before shipping.

### 8. Structured output is a parity gap

OpenCode 2 has no equivalent of the V1 prompt `outputFormat`/JSON-schema contract in the inspected `v2.0.19` protocol. bigbud's native title/summary path must use constrained text/JSON prompting plus existing parser fallback, or wait for a supported structured-output operation.

This is not a chat blocker, but it prevents exact feature parity.

## Recommended Architecture

### Provider identity

- Add internal ID `opencodeV2`.
- Initial label: **OpenCode v2 (Preview)**.
- Keep `opencode` and `kilocode` unchanged.
- At cutover, rename labels only:
  - `opencodeV2` → **OpenCode**;
  - `opencode` → **OpenCode Legacy**.
- Never reinterpret V1 resume cursors or persisted sessions as V2 sessions.

### Server ownership

Create a V2-only manager with:

- exact major/version validation;
- random per-process password;
- `opencode serve --stdio --hostname=127.0.0.1 --port=0` locally;
- explicit authenticated SSH equivalent remotely;
- one `@opencode/client` Promise client per process;
- one event hub per process;
- explicit `Location` on each location-scoped request;
- generation fencing on process death or binary changes.

### Session adapter

Create a separate V2 adapter that:

- stores V2 session and message IDs independently;
- writes dynamic bigbud instructions through keyed instruction entries;
- maps model effort to V2 variant IDs;
- translates bigbud attachments to data/file URIs;
- admits prompts with deterministic IDs;
- settles from execution terminal events while reconciling from session/messages;
- maps permission and form requests to bigbud canonical UI events;
- registers thread MCP bridges with session-level namespace permissions;
- never imports V1 SDK types or KiloCode modules.

### Recovery

Use live events for responsiveness and projected state for authority:

1. consume one server-level stream;
2. demultiplex events to session records;
3. reconnect with bounded jitter and a single stream owner;
4. invalidate incomplete live deltas after a gap;
5. query active/session/message/permission/form state;
6. emit exactly one terminal settlement;
7. fail explicitly if authoritative completion cannot be established within the recovery window.

Do not base correctness on the experimental session log in its current standard-server behavior.

## Phases

### Phase 1: Isolated transport and compatibility spike

- Add no user-facing provider yet.
- Prove authenticated local and SSH startup, exact version checks, one event hub, Location routing, model discovery, and clean shutdown.
- Measure dependency and packaged-bundle size impact.

**Exit gate:** repeated process start/stop/reconnect tests pass without leaked processes, duplicate streams, or cross-Location events reaching the wrong session.

### Phase 2: Core session parity behind a hidden provider

- Implement create, prompt, model switching, attachments, instructions, streaming, completion, interruption, usage, and message reconciliation.
- Run real authenticated turns across representative providers and reasoning variants.

**Exit gate:** canonical lifecycle and final output match existing provider expectations under success, provider failure, timeout, and stream loss.

### Phase 3: Interactive and orchestration parity

- Implement permissions, forms, orchestration MCP, remote-workspace MCP, namespace isolation, and cleanup.
- Add explicit process-death behavior for pending interactions.

**Exit gate:** no cross-thread tool exposure/invocation; stale approvals/forms are cleared deterministically after process loss.

### Phase 4: Preview provider

- Add contracts, settings, model picker, status, icons, desktop binary-path handling, and user-facing preview labeling.
- Keep the legacy OpenCode and KiloCode paths untouched.

**Exit gate:** local macOS/Windows/Linux and SSH/remote-workspace matrices pass with a pinned OpenCode 2 release.

### Phase 5: Replacement decision

Only make V2 the default after several pinned upgrades pass the same conformance suite and all production gates below are met. Change display names, not provider IDs.

## Risks And Decision Gates

### Preview blockers

- No tested server-level event hub and reconnect reconciliation.
- No proven per-thread MCP isolation.
- No real-provider completion matrix.
- No local/SSH/remote-workspace cross-platform validation.
- No measured bundle and memory impact from the new client dependency.

### Default-provider blockers

- Reliance on experimental model/provider, MCP mutation, event, or wait routes without a pinned compatibility policy.
- Unresolved stale interaction behavior after process death.
- Unbounded/process-global event behavior causing unacceptable CPU or memory under many sessions.
- Any inability to prove final completion after a missed terminal event.
- KiloCode or legacy OpenCode regressions caused by shared-module changes.

### Upstream gates worth monitoring

- scoped and bounded event delivery: [#36441](https://github.com/anomalyco/opencode/issues/36441);
- durable pending interactions: [#36347](https://github.com/anomalyco/opencode/issues/36347);
- interaction settlement serialization: [#34853](https://github.com/anomalyco/opencode/issues/34853);
- stable documented event replay for ordinary external-server clients.

## Testing And Validation

The implementation plan should require:

- contract tests for the new provider ID/settings and backward compatibility;
- V2 client request/response fixture tests independent of V1 fixtures;
- server-manager tests for password handling, JSON readiness, stdin lease, SSH forwarding, version mismatch, process death, and cleanup;
- one-stream event-hub tests with many sessions and Locations;
- event-gap tests for text, reasoning, tools, terminal outcomes, permissions, and forms;
- duplicate terminal and stale-response fencing tests;
- MCP cross-thread isolation and cleanup tests;
- attachment tests for text, images, PDFs, data URLs, local files, and remote-workspace metadata;
- usage tests for input/output/reasoning/cache tokens and unavailable data;
- real-provider smoke tests with authenticated OpenCode 2;
- manual macOS, Windows, Linux, SSH-provider-runtime, and local-runtime/remote-workspace checks;
- packaged desktop size/startup/memory measurements.

Required repository checks remain:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Never use `bun test`.

## Acceptance Criteria

- `opencodeV2` operates without changing `opencode` or `kilocode` behavior.
- The configured binary is authenticated and version-compatible before readiness is reported.
- One live event connection serves all sessions owned by one V2 server process.
- Stream loss converges to authoritative session/message/interaction state.
- Final output and terminal lifecycle settle exactly once.
- Thread-specific MCP tools are neither visible nor executable from other sessions.
- Pending interactions fail or recover explicitly after provider-process loss; no stale UI remains.
- Local and remote execution preserve bigbud's existing execution-target semantics.
- Existing V1 sessions retain their original provider IDs and resume cursors.
- V2 can be relabeled later without a persisted-ID migration.

## Open Questions

1. Should the preview package its own OpenCode 2 binary, require a user-supplied binary path, or both?
2. What exact CLI compatibility policy should bigbud enforce: exact patch, same minor, or tested allowlist?
3. Is explicit turn failure/retry acceptable when a process dies during a pending permission/form?
4. Should bigbud ship while model/provider and MCP mutation routes remain marked experimental?
5. Is loss of native structured output acceptable for title/summary generation?
6. What measured session count and event volume define acceptable preview performance?
7. Should V2 session persistence remain provider-owned after bigbud stops a thread, or should bigbud continue deleting native sessions as the current adapter does?
