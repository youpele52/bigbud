# Plan: Factory Droid, Cline, and Grok Build Provider Integration

**Date:** 28 September, 2026  
**Last updated:** 29 September, 2026  
**Status:** Draft — Droid-first execution plan; transport and live-runtime gates remain open  
**Owner:** bigbud server, contracts, and provider UX

## Summary

Add Factory Droid, Cline, and Grok Build as distinct, selectable coding harnesses in bigbud. Preserve each harness's native authentication, model choices, session continuity, tool activity, approvals, and supported modes while rendering them through bigbud's existing provider contracts and UI. Implement and validate Droid first, then Grok Build and Cline. **The milestone ships only when all three are selectable and pass on macOS, Windows, and Linux**; completing one adapter or passing on only one platform is intermediate progress, not release acceptance. Ship local workspaces first; remote workspace support is a separate, per-provider decision.

**This remains a draft until pinned transport choices and authenticated, cross-platform results are recorded.** Phase 0 and the Droid spike can start now; later transport-dependent adapter steps become implementation-ready only after their gates pass. Official provider documentation determines candidate transports and features. Synara's implementation is a secondary source of failure cases to investigate, not code or architecture to transplant. bigbud's existing layering, event model, remote execution boundary, and 400-line source/test limit remain authoritative. The inspection baseline is branch `dev` at `70d95136a530baa4a89a5bd085a9c0605b99433b`, with unrelated working-tree changes; this plan is untracked. No authenticated runtime smoke test has been performed here. Revalidate the branch, commit, worktree, and pinned versions before each implementation phase, and repeat affected gates after CLI/SDK upgrades.

**Settled release decisions:** All three harnesses are required in this milestone. Each must pass on the supported macOS, Windows, and Linux desktop targets; do not release a subset or silently omit a failing platform. Droid is the first implementation focus. A provider may remain unavailable during development, but failure of any required provider or platform blocks the combined release. Remote workspaces and unverified native features remain outside this local-first release.

## Related Work

- [`2026-09-28-in-chat-agent-activity-plan.md`](./2026-09-28-in-chat-agent-activity-plan.md) defines evidence-gated child-agent activity. These integrations do not need subagent UI parity on day one.
- Factory documents the [Droid TypeScript SDK](https://docs.factory.ai/sdk/typescript), [ACP launch configuration](https://docs.factory.ai/ide-integrations), and [Droid Exec/JSON-RPC](https://docs.factory.ai/droid-exec/overview).
- Cline documents [CLI ACP](https://docs.cline.bot/usage/acp), [ClineCore](https://docs.cline.bot/sdk/clinecore), its [API reference](https://docs.cline.bot/sdk/reference/cline-core), and [tool-policy defaults](https://docs.cline.bot/sdk/tools).
- xAI documents [Grok Build ACP](https://docs.x.ai/build/cli/headless-scripting), [CLI flags](https://docs.x.ai/build/cli/reference), [permissions](https://docs.x.ai/build/features/permissions), and [authentication policy](https://docs.x.ai/build/enterprise).
- Synara's [Droid ACP support](https://github.com/Emanuele-web04/synara/blob/ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c/apps/server/src/provider/acp/DroidAcpSupport.ts), [Grok ACP support](https://github.com/Emanuele-web04/synara/blob/ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c/apps/server/src/provider/acp/GrokAcpSupport.ts), and [shared runtime](https://github.com/Emanuele-web04/synara/blob/ec3b1f6ef9c2f656f26dd9711339fe1265d8cb5c/apps/server/src/provider/acp/AcpSessionRuntime.ts) suggest concrete interoperability tests. They do not establish behavior for our pinned binaries.
- No bigbud note, Kanban card, or issue was identified. Add a stable tracking link if one is created.

## Problem

bigbud has no Droid, Cline, or Grok Build provider kind. A model-only API integration would not reproduce these harnesses' sessions, local tool behavior, approvals, and provider-specific modes. The previous rough plan considered only Droid and Cline and assumed their SDKs were the only relevant integration surfaces. Their current docs also describe ACP clients, and Grok Build explicitly documents ACP. That changes the transport investigation, but not bigbud's architecture.

There is a shared prerequisite: `apps/server/src/provider/acp/AcpSessionRuntime.start.ts:194-240` catches a failed `session/load` and creates a fresh native session. For a persisted bigbud thread, that can silently lose native conversation context. `apps/server/src/provider/acp/AcpSessionRuntime.ts:134` also uses an unbounded parsed-event queue. Both behaviors require review before adding more ACP consumers; existing Cursor and Devin behavior must remain stable. A successful `session/load` response is not, by itself, proof that the next prompt works or that historical replay will not appear as new output.

## Goals

1. Detect, configure, and select each harness, with honest install, authentication, model-catalog, and capability states.
2. Preserve exact native session identity across turns and restarts; never silently substitute a new session for a saved one or replay an uncertain turn.
3. Stream assistant text, tool activity, requests, usage where available, and one truthful terminal outcome through canonical bigbud events.
4. Route permission and user-input requests through bigbud's controls, with fail-closed behavior and cleanup on cancellation, disconnect, or shutdown.
5. Keep provider-specific model, mode, and authentication rules separate even when transports share ACP infrastructure.
6. Preserve existing providers, historical data, remote-workspace gating, and predictable behavior under concurrent sessions and partial streams.

## Non-Goals

- Copying synara adapters, event schemas, large files, UI patterns, or process topology into bigbud.
- Adding Grok API model access as a substitute for Grok Build, or treating Cline's configured LLM provider as an independent harness.
- Removing KiloCode or adding Command Code, Qwen Code, or Gemini CLI.
- Assuming all ACP agents implement the same model, mode, resume, fork, or tool semantics.
- Enabling remote workspaces from ACP filesystem/terminal support alone; native and delegated tools also need conformance proof.
- Automatically approving tools, importing unrelated provider sessions, deleting native session files on disable, or exposing unverified fork/rewind/compaction/subagent controls.

## Current State

### bigbud boundaries

- `packages/contracts/src/constants/provider.constant.ts:9-58`, `packages/contracts/src/constants/model.constant.ts:22-50`, `packages/contracts/src/orchestration/orchestration.provider.ts:32-139`, `packages/contracts/src/core/settings.ts:135-271`, and `packages/contracts/src/core/settings.serverPatch.ts:110-178` define provider identity, defaults, model selection, settings, and patches. `apps/web/src/stores/composer/actions.model.store.ts:29-88` and `apps/mobile-web/src/logic/mobileModelSelection.logic.ts:25-62` also consume provider-specific selections/defaults. Historical records and missing new-provider settings must keep decoding.
- `apps/server/src/provider/Services/ProviderAdapter.ts:28-170` defines the lifecycle and event contract. `apps/server/src/provider/Layers/ProviderService.startSession.ts:20-155` persists a starting binding, uses a 45-second startup budget, and restores a prior binding on failure. An adapter must return a real session before the first turn.
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts:15-77`, `ProviderRegistry.ts:90-115`, and `apps/server/src/server.ts:178-253` compose adapters and status providers. `apps/server/src/provider/providerCapabilities.ts:15-94`, `providerWorkloadSupport.ts:33-91`, and `providerRemoteWorkspaceConformance.ts:13-96` separately advertise capabilities.
- `apps/server/src/provider/acp/AcpSessionRuntime.ts:25-106`, `AcpSessionRuntime.start.ts:80-240`, and `AcpSessionRuntime.methods.ts:175-265` already provide ACP process, session, event, permission, mode, and configuration plumbing. `apps/server/src/provider/Layers/Cursor/Adapter.startSession.ts:1-170` shows bigbud's split adapter/remote-bridge style. `AcpRemoteWorkspace.session.ts:1-100` and the remote bridge are bigbud's execution boundary, not a property inherited from a vendor CLI.
- `packages/contracts/src/orchestration/providerRuntime.events.turn.ts:29-208` owns canonical turn events. `apps/web/src/components/chat/provider/providerDescriptors.tsx:1-180` and adjacent web/mobile selection surfaces must express actual capability and readiness states.
- `apps/server/src/provider/Layers/Cursor/Adapter.helpers.ts:154-159` and `apps/server/src/provider/Layers/Devin/Adapter.helpers.ts:141-146` currently turn malformed or unsupported-version cursors into `undefined`; their startup paths then omit the resume ID. Exact-ID continuity must reject a present but invalid cursor, not treat it as a request for a new session. `apps/server/src/provider/acp/AcpSessionRuntime.start.ts:154-165` also falls back to the first advertised auth method when the preferred ID is absent.

### Documented provider surfaces and transport decision

| Harness    | Officially documented candidate                                                                                                                                                                                                                                       | Decision gate                                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Droid      | The TypeScript SDK has `createSession`, exact-ID `resumeSession`, `stream`, `interrupt`, `listModels`, `updateSettings`, permission/AskUser handlers, and per-turn usage. Factory also documents `droid exec --output-format acp` for IDE clients.                    | Start with an SDK-versus-ACP spike. Prefer the SDK if its richer documented controls work reliably under bigbud's Bun host and meet session/approval needs; prefer ACP if it achieves equivalent required behavior with existing bigbud infrastructure. Do not infer SDK feature parity in ACP. |
| Cline      | The CLI officially supports `cline --acp` with client sign-in, model/provider selection, Plan/Act, permission prompts, images, and session loading. `ClineCore` offers persisted sessions, `start`/`send`/`subscribe`/`abort`, tool policies, and local/hub backends. | Spike CLI ACP first for user-installed/authenticated Cline. Compare `ClineCore` if ACP fails restart, mode, or tool-control gates. SDK use must prove idle `start`, exact-ID continuation, credential handling, and Bun compatibility.                                                          |
| Grok Build | xAI documents `grok agent stdio` over ACP, authenticated via cached login or API key, with assistant text delivered as `session/update` and completion metadata from `session/prompt`. CLI exposes `grok models`, permission flags, and session commands.             | ACP is the primary transport. Prove model/effort configuration, auth negotiation, exact-ID resume, approval, and Plan behavior on a pinned CLI. Do not assume its ACP `session/set_config_option` works because other agents support it.                                                        |

Factory's [SDK docs](https://docs.factory.ai/sdk/typescript) say `resumeSession` restores history/settings/cwd but handlers and SDK MCP servers must be reattached; one stream may run per session. The SDK's partial usage updates are cumulative while the terminal result reports current-turn usage. Its public `disabledToolIds` is subtractive, not a restrictive allowlist. SDK MCP tools/structured output call for Zod 3, while bigbud currently uses Zod 4. These are SDK-specific facts, not ACP guarantees.

Cline's [ACP docs](https://docs.cline.bot/usage/acp) claim loading and mode switching, but its repository has reports of a [post-load empty turn](https://github.com/cline/cline/issues/14045) and [Plan-to-Act acknowledgement without an effective switch](https://github.com/cline/cline/issues/13040) on specified CLI versions. These reports are risk evidence, not a finding against every release. Cline's [SDK reference](https://docs.cline.bot/sdk/reference/cline-core) marks `start.prompt` optional, while an older [repository reference](https://github.com/cline/cline/blob/main/.agents/skills/cline-sdk/references/clinecore/api.md) types it as required. Cline's [package manifest](https://github.com/cline/cline/blob/main/sdk/packages/sdk/package.json) declares Node 22+; bigbud runs under Bun. Its [tool docs](https://docs.cline.bot/sdk/tools) say unspecified policy entries are enabled and auto-approved.

For Grok, xAI's [ACP example](https://docs.x.ai/build/cli/headless-scripting) selects an auth method advertised by `initialize`; its [permission docs](https://docs.x.ai/build/features/permissions) distinguish approval mode from sandbox restrictions. Synara observed that one Grok CLI release needed model/effort at process start rather than `session/set_config_option`, and that Droid ACP model flags were ignored; treat both as version-specific hypotheses to reproduce, not rules inherited from synara. xAI recommends `--no-auto-update` for scripted or ACP use so background updates do not disturb a session.

## Phases

### Phase 0 — Harden shared ACP continuity, independently of new providers

**Dependencies:** None. Scope is bigbud's existing ACP runtime and Cursor/Devin regression tests.

1. Change `AcpSessionRuntime.start.ts` so a requested native ID is resumed/loaded exactly or startup fails visibly; never call `session/new` after a failed request. Distinguish a genuinely absent cursor (new thread) from a present but malformed or unsupported-version cursor (error) at the Cursor/Devin adapter boundary and for all new adapters. Preserve the prior binding and history for user-directed recovery. Test malformed/version-mismatched cursors, missing native IDs, unsupported load, transport failure, and the 45-second service startup timeout.
2. Choose `session/resume` or `session/load` only when supported by the pinned agent and the installed ACP client; otherwise fail the requested recovery. Classify updates received during load as historical until the load barrier is complete, retaining authoritative configuration/mode state but never promoting replayed text/tools to a live turn. Correlate subsequent updates to a real post-load prompt and session generation, including late updates after cancellation; a successful load response or empty prompt completion alone does not pass.
3. Replace or constrain the parsed-event `Queue.unbounded` with an explicit capacity, maximum event size, slow-consumer policy, and failure/recovery behavior that preserves ordering and does not quietly lose canonical output. Bound startup, stop, and cancellation independently of legitimate long-running tool calls; test bursts, stalled consumers, and simultaneous sessions. Reuse the existing runtime rather than importing synara's process model.
4. Authenticate only with an advertised method that meets the configured credential path. A preferred method missing from `initialize` must fail with an actionable status, not silently use the first method. Provide a provider-specific way to supply verified headless authentication metadata (the xAI example sends `_meta: { headless: true }`) without changing Cursor/Devin behavior or logging credentials.

**Exit:** Cursor/Devin fixtures and available live checks retain their behavior; failed/invalid exact-ID recovery is explicit; queue overload and authentication failure settle predictably; reconnect cannot publish old transcript updates as a new turn. Record unavailable live checks rather than declaring this phase independently safe to ship without evidence.

### Phase 1 — Droid-first transport spike and pinned-runtime gates

**Dependencies:** Phase 0 for ACP candidates; disposable repositories and authenticated test accounts for live checks. Start with Droid; complete the Grok and Cline subgates before their respective adapters in Phases 4 and 5. No new provider is exposed yet.

1. For each candidate transport, record a dated, redacted matrix: exact CLI/SDK version, executable path, supported macOS/Windows/Linux targets, host runtime (Bun and packaged desktop where applicable), account/auth method, advertised ACP capabilities, catalog source, and observed events. Probe missing binary/credentials, bad model, startup timeout, two turns, approval denial, cancellation, process death, exact-ID restart and a real post-restart follow-up, and two concurrent threads. These are measured facts, not assumptions borrowed from another provider.
2. **Droid first:** Compare the public SDK with official ACP (`droid exec --output-format acp`) on the same scenarios. For SDK, verify Bun import/process cleanup, `listModels`, cumulative partial versus current-turn terminal usage, reattached handlers, tool inventory, and supported Spec behavior. For ACP, verify advertised config/modes, model changes, permission and question coverage, recovery, and whether launch flags are authoritative. Choose a primary transport only after proving idle creation, exact-ID continuation, permission control, and a truthful terminal event; document lost capabilities and any OS-specific differences before Phase 2.
3. **Grok, before Phase 4:** Use `grok --no-auto-update agent stdio` or the equivalent flag order verified on the pinned CLI; negotiate advertised headless auth, run `grok models`, and test model/effort at process start and over ACP. Check prompt/update ordering, permission outcomes, cancellation, exact-ID load, a real follow-up, Plan mode, and CLI-owned tools in a disposable repository. Do not begin with `--always-approve`.
4. **Cline, before Phase 5:** Start with `cline --acp` and the installed user's login. Exercise `session/new`, `session/load`, the first live prompt after load, model/provider selection, permission requests, images, and Plan-to-Act after an actual plan turn. Reproduce or disprove the linked regressions on the pinned release. If a gate fails, test `ClineCore` rather than papering over it; prove idle `start({ config })`, exact-ID restart, subscriptions, approval behavior, and Bun execution before choosing it.

**Exit:** Droid's primary transport and version are chosen first, with supported/unsupported/unverified capabilities recorded. Complete the same gate for Grok and Cline before their adapters. A provider lacking reliable idle creation, permission control, exact-ID continuation, or a viable path on every required OS blocks the milestone; do not substitute an unrelated API integration or declare partial release success.

### Phase 2 — Additive contracts, readiness, and UI wiring

**Dependencies:** Droid's Phase 1 transport choice and verified model/auth source. Add Grok/Cline provider-specific options only after their Phase 1 subgates; keep all new providers internal until Phase 6.

1. Add the provider kinds and names in `provider.constant.ts`, provider-specific model/options schemas in `orchestration.provider.ts` and `core/model*`, settings/patches in `settings.ts` and `settings.serverPatch.ts`, and catalog-backed defaults in `model.constant.ts`. Start with Droid's verified options; add Cline/Grok options after their transport gates. Preserve old settings and model selections during decode/reload and represent unknown saved cursors as errors rather than fresh sessions. Split provider-specific logic into concern-sized modules under 400 lines.
2. Add immediate snapshots and bounded asynchronous probes using the existing provider registration/layer pattern. Separate installed, authenticated, model-catalog-ready, and temporarily unavailable; do not launch login flows from background probes. Droid SDK `listModels` or verified ACP options, Cline's active ACP provider/model catalog or a verified SDK source, and Grok's CLI models are candidate sources. Do not present API models, estimated context occupancy, or an unverified hardcoded default as harness readiness or usage.
3. Register each verified adapter/status service through `ProviderAdapterRegistry.ts`, `ProviderRegistry.ts`, `server.ts`, and `providerCapabilities.ts`; declare workload and tool-injection support in `providerWorkloadSupport.ts`, and add false local-runtime remote conformance in `providerRemoteWorkspaceConformance.ts`. When provider kinds enter exhaustive contracts before an adapter is ready, give them explicit non-ready composition/snapshot behavior so startup and typecheck remain sound; never route an unimplemented kind. Keep all three non-selectable while any adapter or required platform gate remains open. Wire `providerDescriptors.tsx`, web composer actions/normalization, and mobile selection/new-thread defaults to the same truthful capability and model state; supply setup guidance and disabled reasons without exposing secrets. Do not silently replace a saved provider/model selection with another harness.

**Exit:** Existing records decode, missing binaries do not delay startup, and an unverified provider cannot be selected for a turn. Internal Droid wiring can proceed first; public selection of any of the three waits for the combined release gate.

### Phase 3 — Droid local adapter

**Dependencies:** Phases 0-2 and Droid's transport decision.

1. Implement separate session, stream/event, approval/question, discovery, and recovery modules. Use bigbud's `ProviderAdapter` service and canonical events; if ACP wins, extend the existing ACP runtime narrowly. Create an idle session within the 45-second service budget and persist a versioned exact-ID cursor.
2. Map text/tool/usage/terminal events with stable item IDs and one terminal event. For SDK usage, distinguish cumulative partial updates from per-turn terminal totals. For ACP, verify event semantics rather than assuming SDK types. Route only offered permission outcomes; never map a session-scoped approval to a durable global grant.
3. Reattach callbacks/MCP on resume where the chosen transport requires it. Settle pending requests on interrupt, stop, death, and shutdown. Enable Spec mode, attachments, fork/rewind, and history operations only after their native behavior and bigbud UI mapping are tested.

**Exit:** Droid passes two-turn and two-thread local continuity, correct approval and cancellation, and exact-ID restart with a real follow-up on the pinned transport. Repeat live acceptance on macOS, Windows, and Linux during Phase 6; unsupported controls remain disabled. Droid completion is not milestone completion.

### Phase 4 — Grok Build local adapter

**Dependencies:** Phases 0-2 and Grok's Phase 1 pinned ACP subgate. Begin after the Droid-first implementation focus; transport validation can proceed independently, but public delivery is combined.

1. Add Grok-specific spawn/auth/model/mode helpers around bigbud's ACP runtime. Keep CLI authentication and model IDs separate from a standalone xAI API provider. Reconcile process-start model/effort choices with the picker; restart only when a proven safe session transition exists.
2. Map ACP updates, permissions, tool activity, usage, cancellation, and completion to canonical events. Subscribe before the first prompt; correlate late updates to the correct turn and suppress replayed history. Treat a prompt response with no expected live content as a diagnostic case, not fabricated success.
3. Gate Plan mode on a verified provider-native mode and write guard. Keep `--always-approve` and broad allow rules off by default; map bigbud full-access only after confirming xAI's permission and sandbox semantics. Expose compaction, fork, and provider-specific question extensions only after live evidence.

**Exit:** Local Grok sessions survive exact-ID restart and a real follow-up, show correct model and approval state, and fail visibly on an unsupported mode or CLI version. Cross-platform live acceptance remains required in Phase 6.

### Phase 5 — Cline local adapter

**Dependencies:** Phases 0-2 and Cline's Phase 1 ACP-versus-SDK subgate. Begin after the Droid-first implementation focus; transport validation can proceed independently, but public delivery is combined.

1. If ACP passes Phase 1, add a Cline-specific spawn/auth/model/mode layer over bigbud's ACP runtime. If SDK wins, use `ClineCore` for persisted harness sessions rather than the lower-level stateless `Agent`, with one clear owner for runtime, subscriptions, and disposal. Do not combine two native session stores for one bigbud thread.
2. Prove idle session creation, exact-ID restart, and a real follow-up after restart. Subscribe before sending, correlate all events to one turn, and reconcile final result against streamed events/history without duplicate text or phantom completion.
3. Route file/command approvals to bigbud; explicitly configure every built-in, custom, MCP, and delegated-tool policy. SDK policy omissions are auto-approved by default. Keep Plan/Act, image input, structured questions, and child-agent reporting behind individual tests, including the reported ACP mode-transition failure.

**Exit:** Local Cline two-turn and restart continuity with a real follow-up, approvals, cancellation, and terminal state pass on the pinned release. If neither transport passes, keep Cline unavailable and block the combined milestone rather than shipping silent context loss. Cross-platform live acceptance remains required in Phase 6.

### Phase 6 — Cross-platform release gate, then remote workspace decision

**Dependencies:** Local acceptance for all three providers. Remote conformance is independent per provider, but the local-workspace release is all-or-nothing across harnesses and supported OS targets.

1. For **each** of Droid, Grok Build, and Cline, run the pinned, authenticated local-workspace smoke matrix on macOS arm64/x64, Windows x64, and Linux x64, matching current `package.json` desktop artifact targets. Cover standalone/source server as well as packaged Electron wherever provider selection is exposed; verify binary resolution/spawn, account login reuse, catalog/selection, two turns, exact-ID restart plus first real follow-up, denial, cancellation, process death, concurrent threads, and truthful completion/usage. Automated mocks and one-OS runs cannot stand in for another OS. Record OS/architecture, distribution, pinned versions, auth method, result, and missing scenarios; a failed required cell blocks release until fixed and rerun.
2. Once every required cell passes, enable selection of **all three together** with diagnostics for process exit, stalled turn, resume failure, event gaps, pending approvals, and model drift. A rollback disables routing without deleting native or bigbud history and preserves saved selections for explicit recovery, never silently switching harnesses. Provider-by-provider development and testing are allowed; provider-by-provider release is not this milestone's acceptance criterion.
3. Separately inventory native built-ins, configured MCP tools, hooks, plugins, delegated agents, file/terminal callbacks, and checkpoint paths for remote workspaces. Only after each active path is bridged, denied, or isolated through bigbud's own remote transport should that provider's `providerRemoteWorkspaceConformance.ts` entry be enabled and remote conformance tests run. Otherwise retain local-only support with an actionable reason; remote support is not a blocker for the local-only milestone.

**Exit:** All three are selectable and pass on every supported desktop OS target in their ready state; provider status and capabilities match pinned evidence. No partial provider or OS release qualifies, and rollback never reinterprets a saved session as another provider.

## Risks And Decision Gates

- **Transport choice:** Droid SDK exposes richer documented behavior than its ACP integration; Cline ACP integrates the installed CLI account but has reported restart/mode failures; Grok Build officially documents ACP. Choose per provider and pinned version, not by code similarity or a single generic adapter.
- **Existing ACP fallback:** bigbud currently creates a new session after failed `session/load`. Phase 0 must fail closed and regression-test this before adding ACP providers. A successful load followed by an empty turn is also a failure.
- **Malformed persisted cursors:** Cursor/Devin currently parse an invalid present cursor as absent, bypassing the load failure path entirely. Keep new-session creation exclusive to truly new threads or explicit user-directed recovery.
- **Authentication and version drift:** Negotiate only advertised auth methods, avoid opening a browser during background probes, and never emit credentials or raw provider errors to the web. Verify CLI/SDK support on macOS, Linux, and Windows. Cline SDK's Node 22+ declaration and Droid SDK's Zod 3 guidance need isolated compatibility checks under Bun.
- **Permissions and plan safety:** Cline SDK tool names absent from policy are auto-approved. Droid's `ProceedAlways` persists a rule. Grok's always-approve mode is not equivalent to a sandbox. Use the offered native outcomes and fail closed; do not depend on prompt text alone to enforce read-only planning.
- **Recovery and partial completion:** Persist exact IDs with versioned cursors. If a process dies mid-tool, reconcile native history with bigbud's event state before accepting another turn. Do not auto-replay an uncertain prompt, delete prior history, or attach to the provider's latest session.
- **Streaming and load:** Specify queue capacity, event-size limits, overload settlement/recovery, and bounded redacted logs. Test quiet-but-alive turns and delegated work, reject stale generation events, and ensure one waiting approval cannot block unrelated sessions. Timeouts must not kill legitimate long tool calls without clear recovery.
- **Cross-platform delivery:** An SDK/CLI that passes on macOS alone does not satisfy the milestone. Verify installed executables, process lifecycle, permission prompts, resume storage, and packaged-host behavior separately on Windows and Linux; if a platform needs a distinct transport, record and test that path instead of silently omitting the platform.
- **Remote execution and privacy:** Native built-ins may operate on the server filesystem despite injected remote tools. Keep remote support off until all paths are proven. Redact auth, prompts, tool arguments, local paths, and stdout/stderr from snapshots and telemetry.
- **Maintainability:** Adapt useful synara observations as tests or small helpers in bigbud's dot-notation modules. Do not copy its large adapters or change existing provider UX to match its app.

## Testing And Validation

- Contract tests: additive kinds/settings/model options, unknown and historical cursors, and old persisted data. Pure tests: auth/mode/model selection, permission mapping, event deduplication, and terminal outcome.
- ACP runtime tests: failed exact-ID load and malformed/version-mismatched present cursors never create a new session; load replay does not enter live output; a post-load prompt produces a real turn; queue capacity/overflow handling preserves ordering or fails visibly; requested auth methods cannot silently change; startup/cancel/stop deadlines and Cursor/Devin regressions hold. SDK-boundary tests: idle start, callback reattachment, disposal, and Bun import where selected.
- Adapter/server tests: two simultaneous threads, approval/question cleanup, process death, partial streams, model changes, restart, version mismatch, uncertain previous turn, registry snapshots, canonical event ingestion, and failure rollback.
- Web/mobile tests: unavailable/setup states, model/effort/mode controls, permission severity, accessible status, draft/history persistence, and inability to select a provider before its full release gate passes. Remote conformance tests run only for a provider seeking remote support.
- Live smoke tests: pinned, authenticated Droid, Cline, and Grok Build in disposable repositories on macOS arm64/x64, Windows x64, and Linux x64, including standalone/source server and packaged-host binary startup where available, Cline's post-load follow-up and Plan-to-Act transition. Record each observed capability, OS/architecture/distribution, and failed gate; public docs, mock tests, or a successful run on another OS cannot substitute.
- Before implementation is complete run focused tests with `bun run --cwd apps/server vitest run ...`, then `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` (never `bun test`). Run Rust checks from `AGENTS.md` only if Rust changes.

## Acceptance Criteria

- **All three** providers can be installed/configured, selected, and used for multiple local turns with correct authentication and model states on macOS, Windows, and Linux supported desktop targets. A missing installation or unauthenticated account on a particular machine yields an honest disabled/setup state, not a silent alternate provider.
- Each saved bigbud thread resumes only its exact native session; a failed resume is visible and preserves history. The first post-restart turn genuinely executes, with historical replay excluded from live output.
- Streaming, tool activity, approvals, supported questions, cancellation, usage, and terminal outcomes are accurate without duplicate events or unbounded pending work.
- Existing providers, historical selections, remote-workspace gating, and unrelated project/thread behavior pass regression checks.
- Every advertised capability has pinned-runtime evidence or a test on each relevant target. A provider that fails a transport or platform gate remains unavailable during development and blocks the **combined** release, rather than receiving a fabricated fallback or being omitted from the milestone.
- Required repository checks pass and the implementation record lists any live scenarios not exercised.

## Open Questions

1. Which pinned CLI/SDK releases pass on the required macOS, Windows, and Linux targets? Can the chosen SDKs run and shut down reliably under Bun and the packaged desktop host? This is a measured transport gate, not a decision to drop a platform.
2. Does Droid ACP match the SDK's required approval, AskUser, model, usage, and exact-ID recovery behavior, or is the SDK the better primary transport for bigbud?
3. Does a current stable Cline ACP release pass post-load continuation and Plan-to-Act tests? If not, does pinned `ClineCore` pass idle start, exact-ID restart, and installed-account authentication?
4. Which Grok ACP model/effort changes are accepted mid-session versus only at process start, and what is the authoritative account-visible catalog?
5. Which native/delegated tool paths can be safely bridged to a bigbud remote workspace for each provider? This is deferred and does not block local-workspace release.
6. Is a bigbud note, Kanban card, or issue ID needed to track transport choices and live validation results? Tracking is optional; the pinned evidence matrix is required.
