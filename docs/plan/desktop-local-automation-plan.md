# Desktop Local Automation Plan

## Status

Proposed.

This document defines a server-first automation system for scheduled AI jobs that is:

1. Implemented in `apps/server`
2. Available only to the desktop app in v1
3. Executed only on the local desktop backend in v1
4. Durable across restarts with execution history and retries
5. Approval-gated by default
6. Configurable per automation for provider and model selection

## Executive Summary

The right architecture is a durable scheduler and job runner inside `apps/server`, backed by SQLite and started from the existing server runtime startup flow.

The system should not be implemented in `apps/web`.

The web app should remain a client only. The desktop app already talks to a local loopback server, and that local backend is the correct place to own scheduling, persistence, execution, retries, and audit history.

V1 should ship as desktop-only and local-only:

1. Automation UI is shown only in desktop mode.
2. Automation RPC methods reject requests unless `ServerConfig.mode === "desktop"`.
3. Jobs execute only against the local execution target.
4. No browser-only support.
5. No remote-hosted enablement in product surface.

Important architectural decision:

1. Build the scheduler as a normal server subsystem so the same design could support hosted deployments later.
2. Gate availability to desktop/local mode in v1.

That resolves the product tension between "implemented in server" and "desktop/local only": the implementation is portable, but the shipped feature is desktop-local only.

## Goals

1. Let desktop users create scheduled AI automations that run on their local machine.
2. Persist schedules, execution state, retries, and history in local SQLite.
3. Reuse the existing orchestration and provider stack instead of inventing a second AI runtime.
4. Support per-automation provider and model selection.
5. Support explicit automation access policies so users understand whether a job is read-only or workspace-write.
6. Keep unattended execution safe with approval-gated behavior by default.
7. Provide a clear audit trail of what ran, when, why it failed, and what approvals were requested.

## Non-Goals

V1 should not include:

1. Browser-only scheduling.
2. Cloud-synced automation definitions.
3. Multi-node or distributed queue semantics.
4. Remote execution targets.
5. Full cron expression support if that slows down delivery.
6. Full-access unattended automation.
7. Arbitrary webhooks, email, Slack, or third-party triggers.
8. Workflow DAGs or multi-step pipeline builders.

## Product Scope

V1 user-facing object model:

1. Automation definition
2. Scheduled run
3. Execution attempt
4. Approval request and approval outcome

Example supported automations:

1. Every weekday at 9:00 AM, review repo status and summarize changes.
2. Every evening at 6:00 PM, generate a local project summary in a thread.
3. Every Monday, check open worktree health and propose cleanup actions.

Example explicitly unsupported in v1:

1. Run from a browser tab when the desktop backend is not running.
2. Execute on a hosted shared server for multiple users.
3. Modify files silently with no approval barrier.

## Product Decisions

### 1. Availability

Ship only in desktop mode.

Server rules:

1. All automation RPC and streams must reject in `web` mode.
2. All automation runs must target local execution only.
3. If the app is not running, jobs do not execute.
4. On next startup, missed runs can be marked missed or backfilled based on per-automation policy.

### 2. Scheduling Model

Start with a constrained schedule model instead of raw cron.

Recommended v1 schedule types:

1. `once`
2. `daily`
3. `weekly`
4. `monthly`
5. Optional advanced `cron` support only if a reliable parser is chosen and tested well

Required schedule fields:

1. `timezone`
2. `nextRunAt`
3. `lastScheduledFor`
4. `catchUpPolicy`

Recommended `catchUpPolicy` values:

1. `skip-missed`
2. `run-once-on-resume`

Do not start with "run every missed interval since last boot". That creates bursty, surprising behavior.

### 3. Access and Approval Model

The user asked for approval options around read-only vs write access. That should be a first-class automation policy.

V1 automation access policy:

1. `read-only`
2. `workspace-write`

V1 runtime behavior:

1. `read-only`
   The system should prefer provider sandbox `read-only` where the adapter supports it.
   Approval policy stays conservative.
2. `workspace-write`
   The system should prefer provider sandbox `workspace-write` where supported.
   Approval policy stays conservative.

V1 approval posture:

1. Default all automations to approval-gated execution.
2. Default provider runtime mode to `approval-required`.
3. Do not allow unattended `full-access` in v1.
4. Consider `auto-accept-edits` only in a later phase and only for explicit opt-in jobs.

Important implementation note:

1. The current contracts already support runtime modes `approval-required`, `auto-accept-edits`, and `full-access`.
2. The contracts also already model provider sandbox modes `read-only`, `workspace-write`, and `danger-full-access`.
3. The current provider runtime path is centered more strongly on runtime mode than a server-wide automation access policy.
4. V1 should therefore add an automation policy layer that maps into provider capabilities where available, instead of pretending every adapter already enforces identical sandbox semantics.

That means:

1. Automation definitions store a product-level `accessPolicy`.
2. Execution mapping translates that policy into provider runtime mode and sandbox/approval configuration where the provider supports it.
3. If a provider cannot honor the requested access policy exactly, the system must degrade to the safer option or reject configuration.

### 4. Provider and Model Selection

Each automation should be able to specify its own provider/model configuration.

Required behavior:

1. Users can choose provider.
2. Users can choose model.
3. Users can optionally inherit the app default if they do not choose one.
4. The chosen model selection is snapshotted into each run so history remains auditable even if defaults change later.

Recommended v1 rule:

1. Store `modelSelection` on the automation definition.
2. Copy the exact resolved `modelSelection` onto each scheduled run at enqueue time.

### 5. Thread Model

Automations should run in a dedicated automation thread model instead of mutating arbitrary active chat state.

Recommended v1 behavior:

1. Each automation owns one stable thread.
2. Every run appends activity to that automation thread.
3. Each run starts a new turn in that same thread.

Why this is the right boundary:

1. It gives the user a single audit surface per automation.
2. It reuses the existing thread/session/orchestration model.
3. It avoids hidden work in unrelated user threads.
4. It makes failure investigation and approval review much simpler.

## Architecture

### Existing Foundations To Reuse

The current server already has the core ingredients needed for this feature:

1. Long-lived runtime startup and scoped workers:
   `apps/server/src/startup/serverRuntimeStartup.ts`
2. Durable SQLite with automatic migrations:
   `apps/server/src/persistence/Layers/Sqlite.ts`
   `apps/server/src/persistence/Migrations.ts`
3. Durable orchestration command queue and event stream:
   `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
4. Provider routing and runtime event ingestion:
   `apps/server/src/provider/Layers/ProviderService.ts`
5. Desktop-local backend process and loopback websocket transport:
   `apps/desktop/src/main.ts`

Automation should be implemented as another server subsystem in this architecture, not as a special case inside the desktop shell.

### New Server Subsystems

Add the following server modules:

1. `automation/Services/AutomationRepository.ts`
2. `automation/Services/AutomationScheduler.ts`
3. `automation/Services/AutomationRunner.ts`
4. `automation/Services/AutomationApprovalCoordinator.ts`
5. `automation/Services/AutomationHistoryQuery.ts`

Recommended live layer layout:

1. `automation/Layers/AutomationRepository.ts`
2. `automation/Layers/AutomationScheduler.ts`
3. `automation/Layers/AutomationRunner.ts`
4. `automation/Layers/AutomationApprovalCoordinator.ts`
5. `automation/Layers/AutomationHistoryQuery.ts`

Recommended runtime wiring:

1. Start scheduler worker from server startup.
2. Start queue polling and lease recovery during runtime startup.
3. Publish automation lifecycle events into the existing server/eventing model.
4. Expose query and mutation RPC methods through the websocket RPC layer.

### Responsibility Split

`AutomationRepository`

1. CRUD for automation definitions
2. Read/write scheduling metadata
3. Enqueue scheduled runs
4. Lease and update run rows
5. Persist execution attempts and summaries
6. Persist approval state

`AutomationScheduler`

1. Scan active automations
2. Compute due runs
3. Create durable run records
4. Advance `nextRunAt`
5. Recover missed or stale leased jobs on startup

`AutomationRunner`

1. Claim queued runs with a lease
2. Create or resolve the automation thread
3. Dispatch execution via orchestration/provider stack
4. Track run state transitions
5. Apply retry policy
6. Finalize success, failure, cancellation, or approval wait

`AutomationApprovalCoordinator`

1. Correlate provider approval requests back to the owning automation run
2. Keep an execution blocked while approval is pending
3. Resume or fail the run when the user responds

`AutomationHistoryQuery`

1. List automations
2. List run history
3. Get attempt details
4. Get pending approvals
5. Get last-known outcome and next run info

## Data Model

Use SQLite tables plus migrations.

### 1. `automation_definitions`

Purpose:

Stores the durable definition of each automation.

Suggested columns:

1. `id TEXT PRIMARY KEY`
2. `name TEXT NOT NULL`
3. `description TEXT NULL`
4. `status TEXT NOT NULL`
5. `thread_id TEXT NOT NULL`
6. `execution_target_id TEXT NOT NULL DEFAULT 'local'`
7. `provider_kind TEXT NULL`
8. `model_selection_json TEXT NULL`
9. `interaction_mode TEXT NOT NULL DEFAULT 'default'`
10. `runtime_mode TEXT NOT NULL DEFAULT 'approval-required'`
11. `access_policy TEXT NOT NULL`
12. `prompt_template TEXT NOT NULL`
13. `schedule_kind TEXT NOT NULL`
14. `schedule_json TEXT NOT NULL`
15. `timezone TEXT NOT NULL`
16. `catch_up_policy TEXT NOT NULL`
17. `next_run_at TEXT NULL`
18. `last_scheduled_for TEXT NULL`
19. `last_enqueued_at TEXT NULL`
20. `last_run_at TEXT NULL`
21. `last_success_at TEXT NULL`
22. `last_failure_at TEXT NULL`
23. `created_at TEXT NOT NULL`
24. `updated_at TEXT NOT NULL`
25. `paused_at TEXT NULL`
26. `archived_at TEXT NULL`

Indexes:

1. status + next_run_at
2. thread_id
3. execution_target_id

### 2. `automation_runs`

Purpose:

One row per scheduled occurrence.

Suggested columns:

1. `id TEXT PRIMARY KEY`
2. `automation_id TEXT NOT NULL`
3. `thread_id TEXT NOT NULL`
4. `scheduled_for TEXT NOT NULL`
5. `enqueued_at TEXT NOT NULL`
6. `started_at TEXT NULL`
7. `completed_at TEXT NULL`
8. `status TEXT NOT NULL`
9. `attempt_count INTEGER NOT NULL DEFAULT 0`
10. `max_attempts INTEGER NOT NULL`
11. `lease_owner TEXT NULL`
12. `lease_expires_at TEXT NULL`
13. `retry_backoff_json TEXT NOT NULL`
14. `next_retry_at TEXT NULL`
15. `model_selection_json TEXT NULL`
16. `provider_kind TEXT NULL`
17. `runtime_mode TEXT NOT NULL`
18. `access_policy TEXT NOT NULL`
19. `input_snapshot_json TEXT NOT NULL`
20. `result_summary TEXT NULL`
21. `error_code TEXT NULL`
22. `error_detail TEXT NULL`
23. `approval_state TEXT NOT NULL DEFAULT 'not-required'`
24. `approval_request_id TEXT NULL`
25. `created_at TEXT NOT NULL`
26. `updated_at TEXT NOT NULL`

Indexes:

1. status + next_retry_at
2. automation_id + scheduled_for
3. lease_expires_at
4. approval_state

Enforce uniqueness on:

1. `automation_id + scheduled_for`

That prevents duplicate enqueue on restart races.

### 3. `automation_run_attempts`

Purpose:

Stores attempt-level history for retries.

Suggested columns:

1. `id TEXT PRIMARY KEY`
2. `run_id TEXT NOT NULL`
3. `attempt_number INTEGER NOT NULL`
4. `started_at TEXT NOT NULL`
5. `completed_at TEXT NULL`
6. `status TEXT NOT NULL`
7. `provider_kind TEXT NULL`
8. `model_selection_json TEXT NULL`
9. `runtime_mode TEXT NOT NULL`
10. `approval_state TEXT NOT NULL`
11. `error_code TEXT NULL`
12. `error_detail TEXT NULL`
13. `result_summary TEXT NULL`
14. `turn_id TEXT NULL`
15. `provider_session_resume_cursor TEXT NULL`
16. `created_at TEXT NOT NULL`

Indexes:

1. `run_id + attempt_number`

### 4. `automation_run_approvals`

Purpose:

Maps approval requests to automation runs and preserves an audit trail.

Suggested columns:

1. `id TEXT PRIMARY KEY`
2. `run_id TEXT NOT NULL`
3. `attempt_id TEXT NOT NULL`
4. `thread_id TEXT NOT NULL`
5. `provider_request_id TEXT NOT NULL`
6. `request_kind TEXT NOT NULL`
7. `request_payload_json TEXT NOT NULL`
8. `status TEXT NOT NULL`
9. `decided_at TEXT NULL`
10. `decision TEXT NULL`
11. `created_at TEXT NOT NULL`
12. `updated_at TEXT NOT NULL`

Indexes:

1. `provider_request_id`
2. `run_id + status`

## State Machines

### Automation Definition Status

1. `active`
2. `paused`
3. `archived`

### Run Status

1. `queued`
2. `leased`
3. `running`
4. `waiting-approval`
5. `retry-scheduled`
6. `succeeded`
7. `failed`
8. `cancelled`
9. `missed`

### Approval State

1. `not-required`
2. `pending`
3. `approved`
4. `rejected`
5. `expired`

## Scheduling Semantics

### Recommended Worker Model

Use a polling scheduler, not in-memory timer-per-job registration.

Why:

1. Polling is easier to recover after crashes.
2. Polling works naturally with SQLite durability.
3. Polling avoids rebuilding large timer heaps on every mutation.
4. Polling is good enough for minute-level scheduling.

Recommended loops:

1. Scheduler loop every 15 to 30 seconds
2. Runner lease/claim loop every 1 to 5 seconds
3. Stale lease recovery loop every 30 to 60 seconds

### Due-Run Enqueue Algorithm

For each active automation:

1. Compute whether `next_run_at <= now`
2. Insert `automation_runs` row for `scheduled_for = next_run_at`
3. Advance `next_run_at` based on schedule
4. Update `last_scheduled_for` and `last_enqueued_at`
5. If insert conflicts on `automation_id + scheduled_for`, treat as already enqueued

### Startup Recovery

On server startup:

1. Recover runs stuck in `leased` or `running` with expired leases
2. Mark them `retry-scheduled` if attempts remain
3. Otherwise mark them `failed` with recovery reason
4. Scan for missed schedules based on `catch_up_policy`

Recommended v1 recovery rule:

1. `skip-missed` marks the missed occurrence and schedules the next normal run
2. `run-once-on-resume` enqueues at most one immediate recovery run per automation

## Execution Model

### Core Decision

Automation execution should reuse orchestration commands and provider sessions.

Do not implement a second direct-to-provider pipeline.

Recommended run flow:

1. Resolve automation definition
2. Resolve or create automation thread
3. Append automation activity entry to thread
4. Dispatch `thread.turn.start` with the automation prompt and model selection
5. Observe provider/orchestration events until terminal success, failure, or pending approval
6. Persist run outcome

Benefits:

1. Keeps thread history coherent
2. Reuses existing approvals and provider routing
3. Reuses existing checkpointing and event infrastructure
4. Keeps future UI and debugging simple

### Prompt Construction

Each run should create a deterministic input snapshot.

Suggested prompt envelope:

1. Automation name
2. Schedule context
3. Current local time and timezone
4. Automation instructions
5. Optional run variables such as previous failure summary or previous successful run time

Persist the final rendered prompt snapshot into `automation_runs.input_snapshot_json` so history is auditable.

### Approval Handling

When the provider emits an approval request:

1. Correlate the request to the current run and attempt
2. Persist an `automation_run_approvals` row
3. Move the run to `waiting-approval`
4. Surface the pending approval through the desktop app
5. Resume the run only after explicit user decision

Important rule:

1. A pending approval is not a failed run.
2. Approval timeout should be configurable at the automation system level.
3. If approval expires, mark the attempt failed with `approval-timeout` and apply retry policy.

## Retry Policy

Retries are required for reliability, but they must be predictable.

Recommended v1 defaults:

1. `maxAttempts = 3`
2. Backoff = exponential with jitter
3. Retry only for transient failures
4. Do not retry user rejection or explicit cancellation

Suggested retryable failures:

1. Provider unavailable
2. Temporary adapter startup failure
3. Lease recovery after process interruption
4. Timeout waiting for a provider startup or response

Suggested non-retryable failures:

1. Invalid automation configuration
2. Unsupported provider/access-policy combination
3. User rejected approval
4. Missing local workspace for an automation that requires it

Persist the retry reason and next retry time on the run row.

## Desktop-Only Availability Plan

Even though the system lives in `apps/server`, v1 must be desktop-only in product surface.

### Backend Gating

Add server-side gating based on `ServerConfig.mode`.

Required behavior:

1. `automation.*` RPC handlers reject in `web` mode.
2. Scheduler startup is disabled in `web` mode.
3. Repository writes reject if `execution_target_id !== 'local'`.

### Desktop UI Gating

Desktop app can surface the feature because it already launches and talks to the local backend.

Required behavior:

1. Show the automation UI only when connected to desktop backend.
2. Hide the feature entirely in browser/web mode.
3. If a browser client somehow calls the RPC directly, the server still rejects it.

## RPC Surface

Add websocket RPC methods for automation management.

Suggested methods:

1. `automationList`
2. `automationGet`
3. `automationCreate`
4. `automationUpdate`
5. `automationPause`
6. `automationResume`
7. `automationArchive`
8. `automationRunNow`
9. `automationListRuns`
10. `automationGetRun`
11. `automationRetryRun`
12. `automationGetPendingApprovals`
13. `automationRespondToApproval`
14. `subscribeAutomationEvents`

Recommended stream events:

1. automation created
2. automation updated
3. run queued
4. run started
5. run waiting approval
6. run retried
7. run succeeded
8. run failed
9. approval requested
10. approval resolved

## Suggested Contracts Additions

Add new automation-specific schemas under `packages/contracts`.

Suggested shapes:

1. `AutomationDefinition`
2. `AutomationSchedule`
3. `AutomationAccessPolicy`
4. `AutomationCatchUpPolicy`
5. `AutomationRun`
6. `AutomationRunAttempt`
7. `AutomationRunApproval`
8. `AutomationEvent`
9. `AutomationCreateInput`
10. `AutomationUpdateInput`

Important design rule:

1. Keep automation policy concepts separate from raw provider concepts.
2. Do not force the UI to know provider-specific sandbox details to define a job.
3. The server is responsible for mapping automation policy into provider/runtime settings safely.

## Server File Plan

### Contracts

Add new contracts under `packages/contracts/src/automation/` and export via subpath.

Suggested files:

1. `automation.definition.ts`
2. `automation.schedule.ts`
3. `automation.run.ts`
4. `automation.events.ts`
5. `automation.rpc.ts`

### Server Persistence

Suggested files:

1. `apps/server/src/persistence/Migrations/031_AutomationDefinitions.ts`
2. `apps/server/src/persistence/Layers/AutomationRepository.ts`
3. `apps/server/src/persistence/Services/AutomationRepository.ts`

### Server Automation Domain

Suggested files:

1. `apps/server/src/automation/Services/AutomationScheduler.ts`
2. `apps/server/src/automation/Services/AutomationRunner.ts`
3. `apps/server/src/automation/Services/AutomationHistoryQuery.ts`
4. `apps/server/src/automation/Services/AutomationApprovalCoordinator.ts`
5. `apps/server/src/automation/Layers/AutomationScheduler.ts`
6. `apps/server/src/automation/Layers/AutomationRunner.ts`
7. `apps/server/src/automation/Layers/AutomationHistoryQuery.ts`
8. `apps/server/src/automation/Layers/AutomationApprovalCoordinator.ts`

### Startup and Wiring

Likely touchpoints:

1. `apps/server/src/server.ts`
2. `apps/server/src/startup/serverRuntimeStartup.ts`
3. `apps/server/src/ws/wsRpcContext.ts`
4. `apps/server/src/ws/wsRpcHandlers.orchestrationServer.ts`

## Milestones

### Milestone 1: Contracts and Persistence Foundation

1. Add automation contracts.
2. Add SQLite migration with four automation tables.
3. Add repository service and tests.
4. Add desktop-mode gating primitives.

Acceptance criteria:

1. Definitions and runs can be created and queried in SQLite.
2. Web mode rejects automation access.
3. Local execution target is enforced.

### Milestone 2: Scheduler and Run Queue

1. Implement schedule computation.
2. Implement durable enqueue logic.
3. Implement lease-based run claiming.
4. Implement startup recovery for stale leases and missed schedules.

Acceptance criteria:

1. Due automations enqueue exactly one run per scheduled occurrence.
2. Restart does not duplicate runs.
3. Lease expiry recovery works.

### Milestone 3: Execution via Orchestration

1. Resolve/create automation thread.
2. Dispatch automation runs through orchestration/provider stack.
3. Persist attempt lifecycle and run outcome.
4. Snapshot model selection and rendered prompt input.

Acceptance criteria:

1. A scheduled run creates visible thread activity.
2. The selected provider/model is used.
3. Run history shows attempt details and outcomes.

### Milestone 4: Approval Coordination

1. Correlate provider approvals to automation runs.
2. Persist approval records.
3. Expose pending approvals over RPC.
4. Resume or fail the run after decision or timeout.

Acceptance criteria:

1. Approval-gated jobs pause visibly in `waiting-approval`.
2. User approval resumes the run.
3. User rejection records a final non-retryable outcome.

### Milestone 5: Retry Policy and History UX Support

1. Implement retry policy and backoff storage.
2. Add history queries optimized for desktop UI.
3. Add run-now, pause, resume, archive mutations.
4. Add event stream for live automation status.

Acceptance criteria:

1. Transient failures retry predictably.
2. History is queryable by automation and by run.
3. Manual run-now produces a standard tracked run.

## Testing Plan

### Unit Tests

1. Schedule next-run computation
2. Catch-up policy behavior
3. Retry backoff classification
4. Access-policy to provider config mapping

### Repository Tests

1. Migration shape
2. Unique enqueue semantics
3. Lease claim and expiry recovery
4. Approval persistence and correlation

### Integration Tests

1. Startup recovery after interrupted run
2. Scheduled run dispatch through orchestration
3. Approval-requested run pauses and resumes
4. Desktop mode works, web mode rejects

### Non-Goals For Test Harness

1. Do not depend on real wall-clock waiting for long intervals.
2. Inject clock/time services for deterministic tests.

## Risks

1. Provider sandbox semantics are not yet uniform across adapters, so the first implementation must choose safety over perfect capability matching.
2. Approval correlation can get tricky if provider sessions emit multiple overlapping requests.
3. Timezone and DST bugs are easy to introduce if scheduling is implemented casually.
4. Jobs that require local workspace context may fail if the project path no longer exists.
5. Restart recovery can create duplicates unless enqueue and lease semantics are transactional.
6. Users may expect jobs to run while the app is closed; desktop-local positioning must be explicit in product copy.

## Recommended V1 Guardrails

1. Desktop-only.
2. Local execution target only.
3. `approval-required` default.
4. No unattended `full-access`.
5. `read-only` and `workspace-write` only.
6. One automation thread per automation.
7. Max one active run per automation unless explicitly expanded later.
8. Skip browser and hosted enablement in product surface.

## Open Questions

These should be resolved before implementation starts, but they do not block the architecture work.

1. Should v1 support raw cron expressions, or only structured daily/weekly/monthly schedules?
2. Should `workspace-write` still require approval for every file change, or should we allow a later opt-in `auto-accept-edits` mode per automation?
3. Should missed runs under `run-once-on-resume` execute immediately on startup or wait for the user to unlock/foreground the desktop app?
4. Should automations bind to a project/workspace explicitly, or can some jobs be workspace-agnostic?
5. Should "run now" bypass schedule-based dedupe or create a separate manual run type?

## Acceptance Criteria

This plan is complete when the shipped v1 system satisfies all of the following:

1. Users can create, pause, resume, archive, and manually run desktop-local automations.
2. Automations persist in local SQLite with schedule metadata.
3. Due runs are enqueued durably and recover cleanly after restart.
4. Runs execute through the existing orchestration/provider stack.
5. Each automation stores and uses a chosen provider/model selection or a safe inherited default.
6. Approval-gated runs pause for user review and resume correctly.
7. Execution history, attempts, retries, and approval outcomes are queryable.
8. The system is unavailable in web mode.
9. The system only executes on the local desktop backend.
