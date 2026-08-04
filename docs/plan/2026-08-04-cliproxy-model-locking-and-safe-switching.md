# CLIProxy Model Locking And Safe Switching

**Date:** 4 August, 2026

## Problem

CLIProxyAPI sessions are created with a specific model and do not currently support safe in-session model switching. bigbud correctly keeps the active provider session on its original model, but the composer still accepts a different model selection and displays that draft choice. This can make the composer show one model while the agent correctly reports another active model.

The existing CLIProxy recovery work must remain intact:

- CLIProxy uses a persistent delegated Claude query for normal multi-turn conversations.
- It uses fresh-session recovery rather than unverified native resume cursors.
- Transcript rebuilding excludes uncertain, interrupted, and streaming turns.
- A second normal turn must not invoke core-only provider capability lookup.

## Goals

- Make the UI accurately reflect that a started CLIProxy session is model-pinned.
- Keep model selection available for new and unstarted chats.
- Avoid changing CLIProxy session, recovery, or adapter behavior in the immediate fix.
- Define the requirements for a future explicit model-replacement workflow without risking lost context or duplicated turns.

## Phase 1: Started-Session Model Lock

### Scope

Add a capability-driven UI restriction for providers whose adapter reports `sessionModelSwitch: "unsupported"`.

### Design

1. Include the adapter's session-model-switch capability in the provider snapshot sent to the web app.
2. Derive `modelSelectionLocked` only when all conditions are true:
   - The thread has started.
   - The provider is locked to the active provider session.
   - The active provider reports `sessionModelSwitch: "unsupported"`.
3. Disable the provider model picker while `modelSelectionLocked` is true.
4. Keep the active model visible in the disabled picker. Do not replace it with a default or silently rewrite stored composer preferences.
5. Explain the restriction accessibly:

   > This provider's model is fixed after the session starts. Start a new thread to choose another model.

6. Defend the model-selection callback as well as the disabled control, so keyboard and programmatic paths cannot persist an inaccurate draft selection.

### Non-Goals

- Do not special-case `cliProxy` in React. Use adapter capabilities so all unsupported providers behave consistently.
- Do not change `CliProxyAdapter` from `sessionModelSwitch: "unsupported"`.
- Do not stop, restart, or rebuild a session when the user clicks the model picker.
- Do not alter Codex, Claude, OpenCode, or providers that support in-session or restart-session switching.

### Phase 1 Files

- `packages/contracts/src/server/server.ts`: add the narrow session-model-switch capability to the server-provider snapshot schema.
- `apps/server/src/provider/providerSnapshot.ts`: include that capability in snapshots with a compatibility-safe default.
- Provider snapshot fixtures and tests: verify serialization and older/unavailable provider behavior.
- `apps/web/src/components/chat/view/chat-view/chat-view-composer-derived.models.ts`: derive the lock from started-thread, active-provider, and capability state.
- `apps/web/src/components/chat/composer/ComposerFooterLeading.tsx`: pass the lock and explanation to the picker.
- `apps/web/src/components/chat/provider/ProviderModelPicker.tsx`: keep the pinned selection visible, disable interaction, and guard the callback.
- `apps/web/src/components/chat/view/chat-view/chat-view-provider-switch.hooks.ts`: reject a locked same-provider model update before draft or sticky preference mutation.

### Phase 1 Tests

- A new or unstarted CLIProxy chat can choose any discovered model.
- A started CLIProxy chat displays its active model but cannot open or change the model picker.
- Model-picker callbacks cannot update the draft or sticky preference while locked.
- Started Claude, Codex, OpenCode, and restart-session providers retain their existing behavior.
- Provider snapshot capability serialization is backward compatible.
- Existing CLIProxy multi-turn, fresh-restart recovery, and unsupported-model backend tests continue to pass.

## Phase 2: Explicit Safe Model Replacement

Do not implement this phase until all decision gates below are satisfied. This is a new orchestration operation, not a normal model-picker update or a generic session restart.

### Admission

1. Require a fully idle thread.
2. Reject switching while a turn is running, a prompt is queued, an approval or user-input request is pending, or provider recovery/reconnect is in progress.
3. Present confirmation that the provider session will be replaced and completed conversation context rebuilt.
4. Assign a per-thread switch operation ID so retries, reconnects, and repeated clicks are idempotent.

### Replacement Flow

1. Persist the switch operation before side effects: source session and model, target model, transcript watermark, and operation phase.
2. Stop the current provider session and wait until both adapter and session-directory state confirm it is gone.
3. Start a fresh CLIProxy session with the target model and no native resume cursor.
4. Explicitly rebuild context from canonical completed transcript history.
5. Append the new user prompt exactly once after bootstrap context. Never replay an interrupted, streaming, failed, or uncertain turn.
6. Commit the thread's selected model only after fresh startup and the new turn both succeed.

### Attachments And Context

- Replay historical text only when it has canonical, deterministic storage semantics.
- Reject switching when historical image, file, or binary attachments cannot be reproduced safely. Never silently drop them.
- Include thread references only when their current expansion is deterministic.
- Define context truncation and compaction behavior before enabling replacement for long threads.

### Recovery And Late Events

- Continue using CLIProxy fresh-session recovery; never forward an unverified native resume cursor.
- Persist enough operation state to recover safely after an app restart.
- Associate replacement sessions with a new epoch or identity so late events from the stopped session cannot mutate the new session state.
- On stop, startup, bootstrap, or send failure, preserve original thread history and surface a recoverable error without leaving a half-switched binding.

### Phase 2 Decision Gates

1. Transcript reconstruction includes only confirmed history and has deterministic truncation behavior.
2. Historical attachment replay and rejection semantics are approved and tested.
3. Pending turns, queued prompts, approvals, user input, cancellation, and reconnect behavior are explicitly specified.
4. Session identity/epoch handling prevents late-event cross-contamination.
5. Failure and restart behavior is idempotent at each replacement phase.
6. Existing CLIProxy fresh-restart, normal multi-turn, rollover, Claude effort, and Pi thinking regressions pass unchanged.

### Phase 2 Tests

- A completed multi-turn CLIProxy thread stops once, starts one fresh target-model session, rebuilds completed context, and sends the new prompt once.
- Stop, startup, bootstrap, and send failures leave a recoverable, non-duplicated thread state.
- Restart or reconnect at every persisted operation phase does not create duplicate sessions or turns.
- Switching is rejected for active turns, queued prompts, approvals, user-input requests, and unsupported historical attachments.
- Late events from the old session do not affect the replacement session.

## Validation

During implementation, run focused server, contracts, and browser tests for the changed picker, snapshots, session behavior, and CLIProxy recovery. Before completion, run:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Never use `bun test`.
