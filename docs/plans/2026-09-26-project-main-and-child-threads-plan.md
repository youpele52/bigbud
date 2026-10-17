# Project Trunk And Tributary Threads

**Date:** 26 September, 2026  
**Status:** Rough draft — evolving requirements; not a final or implementation-ready plan  
**Owner:** bigbud team

## Summary

Give each project one persistent **trunk** for delegating and supervising work, with persistent **tributaries** that carry out tasks. Both thread types are listed and opened from the left sidebar, following the current thread navigation pattern. Each project offers Trunk and Tributaries views there. The initial view is Trunk; the user's subsequent selection is remembered. The right panel is not a thread surface.

This is a rough plan for discussion, not the final plan or an implementation specification. Preliminary comparisons with current bigbud and t3code have been discussed, but implementation planning remains deferred while the user refines the requirements. Recommendations from those comparisons are not accepted requirements unless explicitly adopted below.

The latest revision supersedes temporary children that disappear on restart. Both thread types now persist. It also adopts the names Trunk and Tributaries, protects the trunk from individual deletion, and requires explicit user approval before trunk-initiated tributary deletion. The earlier 20-child limit is now an unresolved choice between 20 and 50.

The latest layout clarification also supersedes the original right-panel thread proposal: all trunk and tributary thread navigation belongs on the left, and selecting a thread opens its conversation in the normal main conversation area.

The user's phrase “every thread gets one trunk” is interpreted as “every project gets one trunk,” consistent with the surrounding requirements. The supplied screenshot identifies the existing project sidebar section as the context for the view switch; exact placement remains to be designed.

## Related Work

- [Right-panel thread tabs plan](2026-09-11-right-panel-thread-tabs-plan.md) is historical related work. Its right-panel thread layout is excluded from this feature by the latest user clarification.
- No issue, pull request, bigbud note, or Kanban card was supplied for this request.

## Problem

The user wants a project-level thread that stays available for coordination while other threads carry out tasks. They also want persistent, directly interactive worker threads and an easy way to switch between coordination and worker views, while preserving the behavior of ordinary recent chats.

## Goals

### Trunk

1. Every project has exactly one main thread, called its **trunk**.
2. The trunk focuses on delegation and coordination. It creates and manages tributaries, and can request their deletion subject to explicit user approval. It always delegates task execution and remains available for further requests after delegation.
3. The trunk persists across app restarts. It can only be deleted when the user removes its project; individual trunk deletion is unavailable.
4. The trunk has a 500,000-token content limit. When it exceeds that limit, its oldest messages are removed until its content is back to 250,000 tokens. This original requirement remains recorded; token accounting and preservation of important context are unresolved.
5. Each project can have up to **20 or 50 tributaries**, with the final cap still undecided. The original intended working range of about 5–10 children per task remains recorded; a separate running-agent limit has not been agreed.
6. The trunk chooses whether to reuse a tributary for related work or create another for unrelated work.

### Tributaries

7. The project's child threads are called **tributaries**.
8. Tributaries persist across app restarts, just like the trunk. Restart does not delete them.
9. Users can list and open tributaries from the left sidebar and prompt their agents directly in the normal main conversation area. Tributaries do not open in the right panel.
10. Users can change a tributary's provider or model. Each tributary reuses the composer, without a way to change its project from that composer.
11. During tributary creation, the trunk can specify its provider and model. If it does not, the tributary inherits the trunk's provider and model.
12. The trunk and the user can each queue new prompts for a tributary.
13. Tributaries report what they did back to the trunk.
14. Users can delete tributaries. The trunk can also initiate deletion of one or several tributaries, but must explicitly ask the user for approval before doing so. It cannot delete them at its own discretion.

### Project views

15. Each project offers two views in the left sidebar: **Trunk** and **Tributaries**. Users can switch between them. Both use the current left-sidebar thread navigation pattern; selecting either thread type opens it in the normal main conversation area. The right panel is not used to list or display threads.
16. Trunk is the default when the user has not selected a view.
17. The user's chosen view is persisted and restored. The scope of that preference (per project or shared, and per device or synchronised) remains to be decided.

### Supervision and existing chats

18. For longer tasks, the trunk monitors tributaries and keeps them aligned with the assigned work. About every 3–8 minutes, it gives the user a 1–3 sentence progress report covering the active tributaries and their tasks.
19. Recent chat threads continue to behave as they do today. In some cases, a recent chat can also act like a project trunk; the qualifying cases need clarification.

## Non-Goals

Implementation remains outside this rough requirements capture. Automatic deletion of tributaries on restart, independent deletion of a trunk, and thread lists or conversations in the right panel are excluded by the latest requirements.

## Current State

Preliminary source inspection found existing delegation parent references, inherited provider/model settings, queued follow-up messages, and optional completion watches in bigbud. Relevant starting points are `apps/server/src/orchestration-tools/ThreadOrchestrationTools.ts`, `ThreadOrchestrationTools.sendMessage.ts` in the same directory, and `apps/server/src/orchestration/Layers/ThreadWatchReactor.logic.ts`.

The earlier assumption that Sidecar necessarily deletes history on restart was not established. `apps/web/src/components/chat/side-chat/sideChat.actions.ts` creates a server thread, and `SideChatHost.tsx` in the same directory attempts to recover an existing Sidecar. Visibility and deletion must be treated as separate behaviours.

The t3code comparison used main commit `95030dc674883f0f2a7fd034b32ce742c8cf55d0` on 26 September 2026. Its project threads are peers, with persistent conversations and lifecycle controls including settlement, snoozing, and archiving. Those controls are reference material, not adopted requirements for this feature.

## Phases

Implementation phases are deferred until the user supplies more information and requests research or planning.

## Risks And Decision Gates

- Research the current thread, sidebar navigation, orchestration, persistence, and restart behavior before choosing an implementation.
- Define restart recovery for persistent tributaries, including active tasks, queued prompts, and reports.
- Enforce trunk deletion protection and explicit approval for trunk-initiated tributary deletion through the actual deletion paths.
- Define token accounting and safe trimming before changing persistent main-thread history.
- Define concurrency and failure behavior for the tributary cap, provider changes, queued prompts, reporting, and monitoring.
- Preserve the existing behavior of ordinary recent chats unless an explicitly defined case promotes one to a project main thread.

## Testing And Validation

The test plan is deferred until current behavior and implementation boundaries have been researched. Repository validation requirements in `AGENTS.md` will apply when implementation begins.

## Acceptance Criteria

The requested behavior in **Goals** is the initial acceptance outline. Measurable criteria will be written after the unresolved product and lifecycle decisions are made.

## Open Questions

- Is the tributary cap 20 or 50, and does it count all retained tributaries or only a defined active set?
- Is the selected view remembered independently for each project, and should it synchronise across devices?
- How are existing project threads assigned to the trunk and tributary roles when this feature is introduced?
- When can an ordinary recent chat act as a project's trunk, given that a project has exactly one trunk?
- How is approval presented for deletion of one or several tributaries, and what happens to active or queued work in an approved deletion?
- What exactly causes the 3–8 minute progress reports to start, stop, or change cadence?
- How should reports and queued prompts behave when a child fails, restarts, or is deleted?
- What content counts toward the main thread's token limit, and how should trimming preserve essential coordination context?
