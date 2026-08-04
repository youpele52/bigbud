# DO NOT DELETE THIS FILE

This file is the required guide for agents creating or updating plans in `docs/plan/`.

## Purpose

Plans should preserve the reasoning behind non-trivial work so another agent can implement, review, or resume it without reconstructing the entire conversation.

Before creating a plan, inspect the relevant code, existing documentation, notes, Kanban cards, tests, and recent changes. Do not write a plan from assumptions alone.

## File Naming

- Use an ISO date prefix: `YYYY-MM-DD`.
- Use a short lowercase kebab-case subject.
- Use a suffix such as `-plan.md` for normal plans.
- Use `--do-not-delete.md` only for files that must remain as repository guidance or fixtures.
- Example: `2026-08-04-cliProxy-model-switching-plan.md`.

## Required Plan Structure

Every plan must contain these sections in this order unless a section is genuinely not applicable:

```markdown
# Descriptive Plan Title

**Date:** 4 August, 2026
**Status:** Proposed | In progress | Implemented | Deferred
**Owner:** Agent or team name

## Summary

Short explanation of the change and its expected user or developer impact.

## Related Work

- Bigbud note: [Note title](bigbud-note://<note-id>)
- Kanban card: [Card title](bigbud-kanban://<card-id>)
- Repository issue or PR: [Reference](https://...)

## Problem

Evidence-backed description of the current behavior, affected users, and why it matters.

## Goals

- Observable outcomes this plan must achieve.

## Non-Goals

- Explicitly excluded behavior and scope.

## Current State

Relevant architecture, code paths, constraints, and existing behavior with file and line references.

## Phases

### Phase 1: ...

Implementation steps, dependencies, and expected result.

### Phase 2: ...

Implementation steps, dependencies, and expected result.

## Risks And Decision Gates

Risks, unresolved decisions, and conditions that must be satisfied before later phases begin.

## Testing And Validation

Regression tests, integration tests, manual checks, and required repository commands.

## Acceptance Criteria

- Specific conditions that demonstrate the plan is complete.

## Open Questions

Questions that need user, product, or domain-owner decisions.
```

## Related Work Links

Link the plan to the source of the work whenever one exists. Prefer a stable bigbud note or Kanban reference over copying the entire discussion into the plan.

- Use `bigbud-note://<note-id>` for a bigbud note.
- Use `bigbud-kanban://<card-id>` for a bigbud Kanban card.
- Include the note or card title and its purpose, not only an opaque identifier.
- Include repository issue, pull request, changelog, or design-document links when relevant.
- If no related note or card exists, write `None identified` and explain why.
- Do not invent IDs or links. Record the missing reference as an open question when the work should have one.

## Writing Standards

- Write for the next engineer who must implement the work, not only for the original requester.
- Separate observed facts, decisions, hypotheses, and open questions.
- Reference exact repository paths and line ranges for important behavior.
- Describe user-visible behavior before implementation details.
- Prefer the smallest safe change and state why broader alternatives were rejected.
- Preserve existing reliability guarantees and name the tests that protect them.
- Make phase dependencies explicit. A later phase must not silently assume an unverified earlier phase.
- Include rollback or failure behavior for operations that change persisted state, provider sessions, or external resources.
- Define how retries, reconnects, cancellation, partial completion, and uncertain outcomes behave.
- Record attachment, authorization, concurrency, and data-loss considerations when they can affect the feature.
- Use past-tense or imperative action language consistently in implementation steps.
- Keep plans current: update `Status`, dates, completed phases, validation results, and links when implementation changes.

## Phase Guidance

Each phase should identify its goal, exact scope, dependencies, files or modules likely to change, tests, and exit criteria.

- Start with investigation or observability when the root cause is uncertain.
- Make the first implementation phase independently safe to ship whenever possible.
- Keep risky migrations, session replacement, destructive operations, and broad refactors behind explicit decision gates.
- Do not claim a provider supports a capability until its runtime or authoritative metadata proves it.
- Do not replace a provider-specific behavior with a generic abstraction unless the provider semantics are equivalent.
- State what must not change, especially when earlier reliability fixes are part of the existing behavior.

## Testing And Validation Guidance

Plans must identify tests at the layer where each failure can occur:

- Contract or schema tests for serialized inputs and backward compatibility.
- Unit tests for pure normalization, routing, and state transitions.
- Provider adapter tests for request ordering, errors, retries, and lifecycle behavior.
- Server integration tests for persistence, reconnect, concurrency, and event ordering.
- Browser tests for user-visible controls, disabled states, accessibility, and draft persistence.
- Manual checks for provider features that require a live external runtime.

Use the repository commands defined in `AGENTS.md`. For this project, use `bun run test`, never `bun test`. Record commands that passed and failures that are unrelated, pre-existing, or blocked by unavailable external services.

## Protected Files

- Never delete this guide.
- Never delete `docs/plan/_test-data--do-not-delete.md`.
- Before removing old plans, confirm they are implemented or intentionally superseded and preserve any user-designated exceptions.
