# CLIProxyAPI Integration Tightening

**Date:** 2026-09-04  
**Status:** Draft — material compatibility and activation-delivery decisions remain
**Owner:** Server, contracts, and web provider UX

## Summary

Tighten bigbud's CLIProxyAPI integration so its configuration, activation, inspection, diagnostics, and recovery behavior are safe, actionable, and capability-accurate.

CLIProxyAPI remains a local-only Claude-compatible bridge: bigbud validates a local proxy configuration, uses the existing Claude harness with a minimized server-side environment, and remaps public provider identity to `cliProxy`. This plan preserves that architecture. It removes raw credentials from inspection-flight identities, introduces a finite safe diagnostic contract, makes activation controls prerequisite-aware, and corrects fresh-restart telemetry and copy.

**Planning baseline:** Evidence was inspected on branch `main` at `26b1fb3005` with pre-existing unrelated working-tree changes. Revalidate every referenced contract, lifecycle outcome, provider-status delivery path, and the related model-lock selector immediately before implementation; the plan is invalidated by changes to those boundaries or by any unresolved decision below.

## Related Work

- [`2026-08-04-cliproxy-model-locking-and-safe-switching.md`](./2026-08-04-cliproxy-model-locking-and-safe-switching.md)

The related plan owns capability-driven active-session model locking. This plan depends on its finalized client-visible capability and session-lock state; it must not duplicate that work.

The boundary remains strict:

- A started, provider-locked session with `sessionModelSwitch: "unsupported"` keeps its active model visible but non-selectable.
- The selection callback must be guarded as well as the picker UI.
- The browser must not special-case `provider === "cliProxy"` to determine whether a model is locked.
- `apps/server/src/provider/Layers/CliProxy/Adapter.ts` remains the final backend defense against direct same-session model mismatch requests.
- A locked model-selection attempt must not stop, replace, restart, rebuild, branch, hand off, or otherwise switch a CLIProxy session.

A future model replacement or restart design needs its own state, idempotency, replay, attachment, and teardown contract. It is not part of this plan.

## Problem

The integration has a strong security and lifecycle foundation, but several boundaries need tightening.

1. **Raw API keys participate in an in-memory inspection-flight key.** `apps/server/src/provider/Layers/CliProxy/Client.ts` currently builds its key from `configPath`, `baseUrl.href`, and `config.apiKey`. The key is not persisted or deliberately exposed, but raw credentials should not be general cache identities or become eligible for incidental instrumentation.

2. **Activation and RPC boundaries can expose arbitrary error material.** Child process stdout/stderr and lifecycle details may contain configuration-derived or arbitrary text. `apps/server/src/ws/wsRpcHandlers.server.ts` currently transports generic error text and cause material for activation failures. Neither must become browser-visible diagnostics.

3. **CLIProxy prerequisite state is too coarse for useful UI actions.** The settings card and model picker can offer generic “Start / retry” behavior when the actual problem may be invalid configuration, missing credentials, an unrunnable Claude CLI, an unverifiable service-managed installation, authentication failure, or malformed model catalog.

4. **Recovery language can overstate the outcome.** `apps/server/src/provider/Layers/CliProxy/Adapter.ts` correctly advertises `sessionRecovery: "fresh-restart"`; no verified native CLIProxy or Claude resume cursor is forwarded. Telemetry and any user-facing copy must distinguish fresh-session reconstruction from native resume.

## Goals

1. Replace raw API-key inspection coalescing with a process-local opaque credential identity.
2. Make the `api-keys` selection rule explicit, deterministic, and tested.
3. Define a finite, schema-validated diagnostic for CLIProxy prerequisites and activation failures.
4. Ensure only safe diagnostic codes, classification, and remediation actions cross server, RPC, snapshot, and UI boundaries.
5. Make the settings card, activation hook, and model picker distinguish retryable proxy startup conditions from required user configuration/authentication actions.
6. Preserve current lifecycle guarantees: probe before activation, activate only after a health-probe failure, retry readiness at most five times with one-second delays, and never launch a conflicting directly-owned configuration.
7. Consume the related capability-driven model-lock work without adding model replacement or session switching.
8. Make fresh-restart recovery telemetry and UX accurate about history reconstruction and non-replay behavior.

## Non-Goals

- Implementing a CLIProxy model replacement, session restart, session handoff, or automatic model-switch operation.
- Treating CLIProxyAPI as proof of native Claude-session resume support.
- Forwarding a persisted resume cursor for `fresh-restart` recovery.
- Automatically replaying interrupted, streaming, failed, or otherwise uncertain turns.
- Relaxing the local-loopback-only endpoint policy in `apps/server/src/provider/Layers/CliProxy/config.ts`.
- Falling back to fabricated/custom CLIProxy models when the authoritative live model catalog is invalid or unavailable.
- Exposing API keys, authorization headers, config paths, endpoint URLs, child stdout/stderr, stack traces, Effect defects, arbitrary exception text, or causes in browser-visible diagnostics.
- Adding daemon supervision or multi-target lifecycle management without an explicit ownership design.

## Current State

### Configuration and credential selection

`apps/server/src/provider/Layers/CliProxy/config.ts` parses the external YAML configuration, rejects duplicate keys, enforces typed fields, and limits endpoints to loopback addresses. It currently chooses the first trimmed non-empty entry in `api-keys`.

The first usable trimmed-string rule is suitable, but non-string entries are an explicit compatibility decision: the current parser rejects a sequence containing any non-string entry rather than skipping it. Before implementation, decide whether to preserve malformed-config rejection or intentionally accept/ignore non-strings and continue scanning. The resolver's typed configuration failure tags should remain the authoritative source for safe diagnostics; their raw messages must not be serialized.

### Client inspection

`apps/server/src/provider/Layers/CliProxy/Client.ts` authenticates requests, verifies the health response identifies CLIProxyAPI, fetches the authoritative model catalog, validates the selected model, and differentiates health, authentication, catalog, malformed-catalog, and unavailable-model failures.

Its inspection single-flight key currently includes the raw API key. Successful and failed flights already clear themselves, and that behavior must be retained after credential identity changes.

### Lifecycle and activation

`apps/server/src/provider/Layers/CliProxy/Lifecycle.ts` manages only child processes it directly spawned. It deliberately avoids controlling an unverifiable service configuration. Its Homebrew probe establishes formula installation, not `brew services` ownership or running state, so implementation must distinguish installation strategy detection from verified service ownership. Its current public lifecycle results still carry arbitrary detail strings, including child-output-derived early-exit detail; typed server-only lifecycle outcomes must precede any safe diagnostic mapping. `apps/server/src/provider/Layers/CliProxy/RuntimeConfig.ts` probes before activation, starts only after `HealthProbeFailed`, and performs bounded reinspection after activation.

The Claude harness environment is intentionally minimized to `PATH`, `HOME`, Electron support when required, `ANTHROPIC_BASE_URL`, and `ANTHROPIC_AUTH_TOKEN`. The endpoint and token must remain server-only.

### Snapshot, RPC, and web presentation

`apps/server/src/provider/providerSnapshot.ts` already supports provider availability/failure classification. `packages/contracts/src/server/server.providers.ts` currently has broad provider failure reasons, while `packages/contracts/src/server/server.ts` and the activation RPC still permit a free-form error message and cause.

`apps/web/src/hooks/useCliProxyActivation.ts`, `apps/web/src/components/settings/ProviderCard.tsx`, `apps/web/src/components/settings/ProvidersSettingsSection.logic.ts`, and `apps/web/src/components/chat/provider/ProviderModelPicker.tsx` rely on broad messages and empty model lists. They do not yet receive enough structured state to decide whether activation is meaningful.

### Model selection and recovery

`apps/server/src/provider/Layers/CliProxy/Adapter.ts` advertises unsupported model switching, fresh-restart recovery, unsupported rewind, and unsupported fork. It validates model selection at session start and rejects a same-session model mismatch in `sendTurn`.

`apps/server/src/provider/Layers/ProviderServiceSessionRouting.ts` omits a persisted resume cursor for fresh restarts, but its recovery analytics terminology must not claim a generic/native resume.

## Phases

### Phase 1 — Establish credential and diagnostic primitives

**Dependencies:** None.

1. Add a server-only opaque credential identity utility near the CLIProxy configuration/client implementation.
   - Generate a process-local secret once per server process.
   - Derive a one-way keyed identity from the parsed credential for inspection coalescing.
   - Combine that opaque identity with normalized config-path and base-URL identity.
   - Keep raw credentials available only for the immediate HTTP Authorization header and the server-only Claude harness environment.
   - Do not log, serialize, expose, or otherwise retain the opaque identity outside the inspection implementation.
   - Preserve single-flight cleanup after both resolution and rejection.

2. Make API-key selection an explicit compatibility decision and resolver invariant in `apps/server/src/provider/Layers/CliProxy/config.ts`.
   - Preserve scanning YAML sequence values in source order.
   - Treat strings with a non-empty trimmed value as eligible and use the trimmed first eligible string.
   - Continue to skip blank strings.
   - Before implementation, choose and document one non-string policy: preserve the current malformed-config rejection for any non-string entry, or intentionally ignore non-strings and continue scanning.
   - Return the existing typed `MissingCredential` failure only when the selected policy yields no eligible entry.
   - Do not add automatic key rotation or attempts against subsequent configured keys.

3. Refactor the CLIProxy lifecycle and runner boundary to expose structured server-only outcomes before adding a browser-safe mapper.
   - Add finite internal tags for direct-child executable failure, timeout, conflicting owned configuration, early exit, unverified service configuration, unsupported runtime, and other lifecycle states currently represented only by `detail` strings.
   - Keep bounded child stdout/stderr and original exceptions private to lifecycle/server observability; never infer public classifications by parsing detail text.
   - Distinguish detected installation strategy from verified service ownership or running status.

4. Add a finite CLIProxy diagnostic schema in `packages/contracts/src/server/server.providers.ts`.
   - Define a stable diagnostic-code union and derive every code from structured config, client, runner, or lifecycle outcomes.
   - Define a remediation/action union, for example: `review-settings`, `configure-cli-proxy`, `install-or-configure-claude-cli`, `update-credential`, `start-or-retry-proxy`, `review-service-configuration`, and `refresh-catalog`.
   - Include only `code`, failure classification, and action in the shared structure.
   - Add it as an optional provider-snapshot field to support mixed-version snapshot consumption.

5. Replace activation RPC's free-form failure shape in `packages/contracts/src/server/server.ts` while preserving the existing RPC method in `packages/contracts/src/server/rpc.core.ts`.
   - Remove browser-visible cause material.
   - Specify the rollout contract before implementation: either retain an optional legacy-safe field during a transitional schema window, version the endpoint, or require coordinated web/server deployment.
   - Replace arbitrary activation text with the validated diagnostic object for compatible clients.
   - Keep the successful provider-update response shape stable where possible.

**Invariants:**

- No inspection `Map` key contains a raw API key.
- Public diagnostic mapping consumes structured outcome tags, never arbitrary error/detail strings.
- Contract schemas reject unknown diagnostic codes and actions.
- No RPC error field can encode arbitrary causes or process output.
- Existing non-CLIProxy snapshots remain decodable because the diagnostic field is optional.
- The RPC migration has an explicit mixed-version or coordinated-deployment compatibility policy.

### Phase 2 — Normalize server-side failures at one safe boundary

**Dependencies:** Phase 1.

1. Add a server-only mapping boundary that converts only structured CLIProxy config, client, runner, and lifecycle outcomes to the finite diagnostic schema.
   - Do not parse or classify generic `Error.message`, lifecycle `detail`, config paths, or child output.
   - Map configuration tags for missing, unreadable, malformed, unsafe, unsupported, invalid-port, and missing-credential conditions.
   - Map unavailable/timed-out Claude CLI checks separately from missing proxy executables.
   - Map 401/403 authentication failures to credential guidance.
   - Map health/startup failures and genuinely transient catalog-request failures as retryable only when retry is useful.
   - Map malformed/empty catalogs and stale selected models separately from proxy startup failures.
   - Map unverifiable service-managed configurations to user-action-required service guidance.
   - Map absence of the optional lifecycle service to a finite unsupported-runtime diagnostic.

2. Retain underlying causes only inside protected server-side diagnostics.
   - Bound child output if it is retained for internal troubleshooting.
   - Redact credential-bearing strings before any protected logs.
   - Do not attach child output or lifecycle detail to provider snapshots, runtime errors, RPC errors, telemetry attributes, or UI state.
   - Do not repeat config paths in error payloads.

3. Refactor `apps/server/src/provider/Layers/CliProxy/RuntimeConfig.ts` to preserve its existing readiness policy while returning typed internal outcomes.
   - Continue activation only after `HealthProbeFailed`.
   - Do not activate after auth, configuration, catalog, or selected-model failures.
   - Preserve the five-attempt, one-second post-activation inspection cap.
   - Keep the frozen minimized harness environment unchanged.

4. Refactor `apps/server/src/provider/Layers/CliProxy/Provider.ts` and snapshot composition.
   - Surface safe diagnostics together with shared availability classification.
   - Keep disabled provider state distinct from activation failure.
   - Preserve authoritative empty-model behavior for invalid/unavailable catalogs.

5. Refactor activation RPC handling in `apps/server/src/ws/wsRpcContext.ts` and `apps/server/src/ws/wsRpcHandlers.server.ts`.
   - Serialize only the validated diagnostic for compatible clients and retain the selected migration compatibility behavior from Phase 1.
   - Define one deterministic failed-activation delivery contract before UI work: either include a safe updated snapshot in the typed failure, or refresh/stream provider state on both success and failure while making the RPC diagnostic self-sufficient if the stream is delayed.
   - Test the selected contract against the existing provider-status stream delivery guarantees; do not make UI correctness depend on an unproven asynchronous refresh.
   - Preserve server-owned coalescing: concurrent callers join one operation, flights clear after completion, and one caller's cancellation/disconnect cannot terminate shared activation.

**Invariants:**

- Every known CLIProxy prerequisite maps from a structured outcome to exactly one reviewed code/classification/action combination.
- Raw API keys, config paths, causes, and child output never reach RPC clients.
- A stale selected model does not produce misleading “start proxy” guidance.
- A failed activation produces deterministic safe UI state under the selected RPC/snapshot delivery contract.
- A failed shared activation releases its flight so a later attempt can begin a new bounded activation.

### Phase 3 — Render finite, prerequisite-aware web UX

**Dependencies:** Phases 1 and 2.

1. Add an exhaustive web diagnostic presentation helper alongside provider/settings presentation code.
   - Derive headline, body copy, retry eligibility, action label, and status severity solely from the safe code and action.
   - Provide a safe generic fallback for older snapshots without a diagnostic.
   - Do not interpolate caught RPC strings into user-visible toasts, tooltips, banners, or labels.

2. Complete a browser-visible CLIProxy message-sink audit before wiring the helper.
   - Trace direct and transitive rendering of CLIProxy `provider.message`, provider failure reasons, activation errors, and toast text in `ProviderStatusBanner.tsx`, `ProviderModelPicker.tsx`, `ProviderModelPicker.models.ts`, `useCliProxyActivation.ts`, `ProviderCard.tsx`, and `ProvidersSettingsSection.logic.ts`.
   - Include any additional sink discovered through the trace; do not rely on the initial file list as exhaustive.
   - Route every browser-visible CLIProxy diagnostic through the presentation helper, or prove the server value is a finite, schema-validated safe string. Broad legacy `provider.message` values may be used only by the generic compatibility fallback, never as CLIProxy-specific explanation.

3. Update `apps/web/src/hooks/useCliProxyActivation.ts`.
   - Decode the typed activation failure.
   - Render fixed diagnostic-derived toast copy.
   - Retain local in-flight protection and cleanup in `finally`.
   - Apply the returned provider update on success and follow the selected failed-activation snapshot/stream delivery contract.
   - Trace the repository's established async hook lifecycle pattern before adding unmount/cancellation handling.

4. Update settings presentation in `ProvidersSettingsSection.logic.ts` and `ProviderCard.tsx`.
   - Show “Start / retry” only for retryable, activatable startup/health diagnostics.
   - For configuration, credential, Claude CLI, service-management, and malformed-catalog states, show fixed action-oriented guidance and the relevant existing configuration surface instead of a futile retry control.
   - Preserve current severity/status-color semantics.

5. Update `ProviderModelPicker.tsx`, `ProviderModelPicker.models.ts`, its availability helpers, and `ProviderStatusBanner.tsx`.
   - Explain unavailable CLIProxy models and provider status from structured snapshot diagnostics.
   - Offer activation only when the diagnostic is retryable and activation is meaningful.
   - Use the finite presentation helper instead of raw `provider.message`, retaining only the safe generic compatibility fallback.

**Invariants:**

- UI text is finite, reviewed, and not sourced from subprocess output or arbitrary errors.
- Every browser-visible CLIProxy status, toast, picker, settings, and banner sink is traced and receives finite presentation text.
- Configuration, auth, Claude CLI, proxy, service-management, and catalog problems result in different useful next steps.
- The model picker never offers retry for missing credentials, invalid configuration, or unverified service-managed setup.

### Phase 4 — Consume the related capability-driven model lock

**Dependencies:** The related model-lock plan and its final lock-state source.

Before implementation, trace the finalized selector and callback paths, including:

- `apps/web/src/components/chat/view/chat-view/chat-view-composer-derived.models.ts`
- `apps/web/src/components/chat/view/chat-view/chat-view-provider-switch.hooks.ts`
- `apps/web/src/components/chat/provider/ProviderModelPicker.tsx`
- the relevant contract/read-model path that surfaces session capability state.

Implement only the related plan's generic model-lock behavior:

1. Derive the model-selection lock from all required predicates: thread started, active provider session locked, and `sessionModelSwitch: "unsupported"`.
2. Keep provider locking distinct from model locking.
3. Leave the active model visible while preventing menu and callback state changes.
4. Guard before resolving/applying a selection, opening confirmation, setting draft/sticky selection, branching, or starting a handoff.
5. Preserve the adapter's backend rejection for bypassed clients.

**Invariants:**

- No lock behavior is determined by a CLIProxy-specific React branch.
- No locked selection changes draft/sticky state or triggers a session operation.
- No selection action is repurposed into a restart or model replacement flow.

### Phase 5 — Correct fresh-restart telemetry, copy, and regression coverage

**Dependencies:** Phases 2 through 4.

1. Update recovery telemetry in `apps/server/src/provider/Layers/ProviderServiceSessionRouting.ts`.
   - Retain `adopt-existing` for in-memory session adoption.
   - Use a distinct strategy such as `fresh-session-reconstruction` for `fresh-restart`.
   - Record adapter recovery capability separately from whether a cursor existed and whether it was forwarded.
   - Reserve native-resume terminology for providers with a verified native resume contract.

2. Audit recovery copy and toast coordination.
   - Describe CLIProxy recovery as a new Claude session with completed conversation history reconstructed before the next turn.
   - State that no unverified CLIProxy/Claude resume cursor is used.
   - State that interrupted, streaming, failed, or uncertain work is not automatically replayed.
   - Do not use generic provider-availability recovery toasts as the sole per-thread recovery disclosure.

3. Keep authored source and test files within the repository's 400-line limit.
   - Split server diagnostic mapping, credential identity, and web presentation by concern using the repository's dot-notation pattern.
   - Repeat the final ownership/path trace immediately before implementation because related model-lock work may move shared selectors or tests.

## Risks And Decision Gates

| Risk                                                             | Mitigation and decision gate                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Secret-derived state leaks through a new utility                 | Security review must verify raw credentials are used only for HTTP and harness injection; opaque identities never cross server-only inspection boundaries.                                                                                                          |
| A finite public code is inferred from arbitrary lifecycle detail | Complete the structured server-only lifecycle/runner outcome refactor first; public mapping may consume tags only, never `detail`, child output, paths, or exception text.                                                                                          |
| Diagnostics are too coarse for UX                                | Review a complete matrix of config, client, lifecycle, Claude-runner, catalog, and model outcomes before changing contracts. Each row needs one code, classification, action, and fixed web presentation.                                                           |
| Contract changes break mixed server/web versions                 | Decide and document a transitional legacy-safe field, versioned endpoint, or coordinated deployment before implementation. Validate both upgrade and rollback containment for the selected policy; keep snapshot diagnostics optional and retain safe UI fallbacks. |
| Failed activation leaves stale or indeterminate UI               | Choose a typed failure snapshot or a tested success-and-failure provider-status refresh contract. The typed diagnostic remains self-sufficient if a stream delivery is delayed or absent.                                                                           |
| Service-managed setup appears to be owned by bigbud              | Preserve refusal to start unverifiable service-managed configurations. Describe Homebrew formula detection only as installation-strategy detection, not `brew services` ownership/running verification, and classify the state as user-action-required.             |
| Caller cancellation stops shared activation                      | Trace RPC cancellation support before adding abort behavior; preserve server single-flight ownership.                                                                                                                                                               |
| Recovery metrics imply native resume                             | Gate labels on explicit adapter recovery capability and test that CLIProxy forwards no resume cursor.                                                                                                                                                               |
| Model locking expands into session replacement                   | Do not start Phase 4 without the related plan's selector/contract; reject restart, branch, handoff, or replacement additions as out of scope.                                                                                                                       |
| Readiness/supervision scope expands casually                     | Treat readiness budget and post-start supervision as explicit product decisions, not incidental hardening work.                                                                                                                                                     |

## Testing And Validation

### Server and contract coverage

Extend focused tests for:

- `apps/server/src/provider/Layers/CliProxy/config.test.ts`
  - first eligible API-key selection, blank-first ordering, whitespace trimming, all-unusable values, and the selected non-string policy: rejection compatibility or intentional skip-and-continue;
- `apps/server/src/provider/Layers/CliProxy/Client.test.ts`
  - equivalent opaque identities coalesce, distinct config/endpoint/credential identities do not, successful/rejected flights clean up, and fixtures do not expose sentinel credentials;
- `apps/server/src/provider/Layers/CliProxy/Lifecycle.test.ts` and the new/refactored server-only outcome tests
  - direct-child stdout/stderr and early-exit output remain private; missing executable, timeout, conflict, early exit, close-during-activation, installation-strategy detection, and unverified service behavior produce structured internal outcomes without public-detail parsing;
- `apps/server/src/provider/Layers/CliProxy/RuntimeConfig.test.ts`
  - exact activation matrix: only health failure activates; configuration, authentication, catalog, malformed/empty catalog, and stale-model failures do not; retry cap/delay remain five one-second reinspection attempts; and harness credentials remain server-only;
- `apps/server/src/provider/Layers/CliProxy/Provider.test.ts` and the provider snapshot classification tests
  - every structured outcome maps to its intended status, diagnostic code, classification, and action; disabled/auth/catalog states remain distinct;
- the confirmed WebSocket context/handler tests
  - activation errors decode as safe diagnostics; concurrent callers coalesce; failed flights clear; cancellation/disconnect does not cancel shared work; and the selected typed-failure snapshot or stream-refresh contract deterministically updates every caller;
- contract compatibility tests for the selected RPC rollout policy
  - current and prior compatible payloads decode across the supported upgrade path, unknown diagnostics are rejected, and the documented rollback state retains a safe fallback.

### Web coverage

Extend focused coverage for:

- `apps/web/src/components/chat/provider/ProviderModelPicker.availability.test.ts`
  - retryable proxy startup can activate while configuration, authentication, Claude CLI, service-managed, and malformed-catalog states cannot;
- `apps/web/src/components/chat/provider/ProviderModelPicker.test.ts`, `ProviderModelPicker.models.ts` coverage, and `ProviderStatusBanner.tsx` coverage after the final path trace
  - all picker and banner states use finite presentation copy rather than raw CLIProxy messages; capability-driven locks keep the active model visible and prevent changes while unlocked selection still works;
- `apps/web/src/components/chat/view/chat-view/chat-view-provider-switch.hooks.test.ts`
  - callback attempts under a lock do not mutate draft/sticky state, queue confirmation, branch, or hand off;
- activation-hook and settings tests after the final path trace
  - safe toast mapping, action-aware cards, optional-diagnostic fallback behavior, and the selected failed-activation delivery contract.

Use unique sentinel API-key, config-path, endpoint, stdout, stderr, `cause`, and arbitrary-message values in server and web boundary tests. Assert that none appear in RPC payloads, provider snapshots, toasts, settings cards, picker descriptors/tooltips, status banners, or other browser-visible sinks found by the audit.

### Recovery coverage

Extend `apps/server/src/provider/Layers/ProviderService.routing.cliProxy.test.ts` or add a dedicated routing test to prove:

- fresh restart does not forward a persisted `resumeCursor`;
- analytics reports fresh-session reconstruction rather than native resume;
- in-memory sessions retain `adopt-existing`;
- native resume terminology is used only where a provider exposes a verified cursor contract.

### Required repository verification

Run from the repository root after implementation:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Use focused Vitest runs while iterating, for example:

```sh
bun run --cwd apps/server vitest run src/provider/Layers/CliProxy/config.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/CliProxy/Client.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/CliProxy/Lifecycle.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/CliProxy/RuntimeConfig.test.ts
bun run --cwd apps/server vitest run src/provider/Layers/CliProxy/Provider.test.ts
bun run --cwd apps/web test:browser
```

Do not use `bun test`; this repository requires `bun run test`.

## Acceptance Criteria

1. Inspection coalescing never stores or compares raw API keys in its map identity, while equivalent inspections still coalesce and distinct credential/configuration/endpoint identities remain separate.
2. YAML `api-keys` selection is documented and tested as the first eligible trimmed string in source order, with the chosen non-string compatibility policy explicitly preserved or intentionally changed.
3. Lifecycle and runner failures have finite server-only outcome tags before public diagnostic mapping; no public code is inferred from `detail`, child output, paths, or arbitrary exception text.
4. `server.activateCliProxy` failures decode into a finite safe diagnostic with no arbitrary cause, process output, raw credential, raw config path, or free-form server error.
5. Every unavailable CLIProxy condition has deterministic classification and remediation: configuration, credentials/authentication, Claude CLI, proxy runtime, proxy startup/health, catalog, and stale model selection.
6. Provider snapshots expose safe prerequisite state without breaking clients that receive snapshots without the new optional field, and the selected activation-RPC migration policy passes supported upgrade and rollback compatibility tests.
7. The selected typed-failure snapshot or provider-status refresh contract makes failed activation result in deterministic safe UI state for every caller.
8. Every browser-visible CLIProxy status, toast, settings card, picker descriptor/tooltip, and banner uses finite safe presentation text; sentinel secrets, paths, endpoint, output, causes, and messages appear in none of them.
9. The UI presents retry controls only for retryable activation states and presents fixed, actionable user guidance for required configuration/authentication actions.
10. Capability-driven model locking leaves active models visible, prevents client state changes and session operations, and preserves the adapter's server-side rejection.
11. CLIProxy fresh recovery starts without a resume cursor; telemetry and copy describe fresh-session reconstruction rather than native resume.
12. No plan phase silently expands into daemon supervision, multi-configuration lifecycle management, or model replacement.
13. `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test` pass after implementation.

## Open Questions

1. **API-key compatibility:** Should a YAML `api-keys` sequence containing a non-string remain malformed configuration, as it is today, or should non-string entries be intentionally ignored while scanning for the first eligible string? This must be decided before Phase 1 implementation.
2. **Activation RPC rollout:** Does bigbud support independently deployed server and web versions? If so, choose a transitional legacy-safe field or versioned endpoint; otherwise record a coordinated-deployment policy and its rollback containment before changing the RPC failure schema.
3. **Failed-activation delivery:** Should the typed RPC failure include a safe updated provider snapshot, or should the server guarantee provider-status refresh after both success and failure while the diagnostic supplies an immediate fallback? Decide from tested delivery semantics before Phase 2 UI work.
4. Does the WebSocket transport expose per-request cancellation that can be observed without cancelling server-owned shared activation? Confirm before adding cancellation behavior.
5. Which finalized selector/contract from the related model-lock plan exposes active session lock and `sessionModelSwitch` to the web app? Confirm before Phase 4.
6. Are there user-facing recovery notifications outside the current session-routing and recovery-toast paths? Trace immediately before implementation so recovery language is updated consistently.
