# Queue decisions and recovery

Status: Implemented and reviewed. Code green and Implementation/Plan green verified.

## Requirements

- Preserve FIFO, compatible settings, explicit queue holds, reservation ownership, pending-start
  protection (including existing server-time stale-start release), and uncertain-delivery safety.
- Return explicit ready, blocked, stale-selection, and invalid-owner decisions from one evaluator.
  Known refusals are durable rejected attempts, never accepted delivery or unknown transport outcomes.
- Send now submits captured prompt IDs, expected turn/session, and composer options in one command.
  The serialized server chooses safe idle start or interruption of the captured turn. It never
  interrupts a newer turn, changes settings mid-turn, or expands a captured selection.
- Automatic attempts use immutable payloads keyed by queue incarnation and canonical revision.
  Later lifecycle/recovery attempts recheck authoritative eligibility. Keep logical message identity
  independent of attempts. Version the producer without modifying old claims or global digests.
- Carry typed reasons through persisted outcome queries and transport; display expected refusal as
  a factual queue status. Only committed receipt/event evidence establishes acceptance.
- Cover identity/retry races, restart, concurrent releases, removed selections, mixed settings,
  null production state, reservations, and pending starts with focused tests.

## Implementation

1. Extract typed queue decision schemas and evaluator; retain the prefix convenience wrapper.
2. Persist structured rejection reasons through the existing rejected-receipt path and RPC mapping.
3. Extend manual flush with expected turn/session and options; reuse interrupt continuation and
   turn-start machinery. Remove renderer-side settings mutation before release.
4. Version automatic attempt identity; derive stable timestamps from canonical state and trigger
   bounded retries on relevant committed state changes, including approval/input/model-choice.
5. Run focused length, formatting, lint, package typechecks, tests, then requirements review.

## Legacy claims

A claim without receipt cannot establish delivery. Current exact queued incarnation is checked in
serialized processing; accepted consumption atomically removes that incarnation with its receipt.
Thus a new v2 attempt may consume a still-present incarnation without altering an old claim. A later
busy redelivery has a distinct queue timestamp/flag. If consumption committed, current state cannot
select it again. Unknown provider acknowledgement remains protected by existing control state.

## Validation scope

Only changed-file formatter/linter/length checks, affected package configured typechecks, and named
focused Vitest/browser files. No repository-wide checks, staging, commits, or pushes.

Validation commands and outcomes: [focused validation record](2026-10-28-queue-decision-recovery-validation.md).
