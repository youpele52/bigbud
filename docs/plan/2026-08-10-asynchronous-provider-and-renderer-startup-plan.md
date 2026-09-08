# Asynchronous Provider And Renderer Startup Plan

**Date:** 10 August, 2026
**Status:** Proposed
**Owner:** Claude

## Summary

Improve application startup in two connected areas:

1. Make Copilot, Claude, and Codex availability checks asynchronous so external binaries, SDK clients, authentication checks, and model discovery do not block backend readiness.
2. Mount the renderer shell as soon as the native bridge exists, then recover the selected thread and bounded catalog progressively without weakening projection or event-order guarantees.

Users should see the application frame and meaningful checking/loading states much earlier. Providers should transition from an immediate checking snapshot to their verified state through the existing configuration stream.

## Related Work

None identified. This plan was produced from direct startup-path investigation in the repository; no stable note, Kanban card, issue, or pull request was linked.

## Problem

Server startup currently constructs some managed providers without an initial snapshot. `makeManagedServerProvider` therefore runs their real availability probe synchronously, allowing process launch, SDK startup, auth status, and model discovery to delay service-layer construction and backend readiness.

The renderer has a separate latency multiplier. `RootRouteView` hides the complete shell behind `bootstrapComplete`, even though `WebSocketConnectionSurface` intentionally supports rendering children while initial configuration is pending. The bounded bootstrap also serially loads selected-thread detail, sidebar data, every project-catalog page, and multiple thread-summary pages before marking recovery complete.

The result is that useful UI remains hidden while work that can safely run in the background completes. Simply appending deferred project pages is not safe, however: a stale page can reintroduce a project removed by a newer `project.deleted` event because the visible project collection does not retain deletion tombstones.

## Goals

- Backend readiness must not wait for Copilot, Claude, or Codex process, SDK, authentication, or model-discovery probes.
- The initial server configuration must immediately contain every registered provider as a checking, disabled, or already-ready snapshot.
- The renderer shell must mount once the native API is available, independently of bounded catalog completion.
- The selected-thread and sidebar critical path must issue independent requests concurrently.
- Initial recovery must load only data required for the first useful screen.
- Later project and thread-summary pages must load lazily without allowing stale snapshots to overwrite newer events or resurrect deleted projects.
- Projection replay, operational read-model restoration, event ordering, deep-link recovery, and permission-prompt safety must remain intact.

## Non-Goals

- Do not move projection pipeline bootstrap or startup operational-state restoration into background fibers.
- Do not treat checking providers as executable providers; workload routing must continue requiring `status: "ready"`.
- Do not redesign the provider-status contract or introduce a new provider state in this slice.
- Do not eagerly hydrate full thread history.
- Do not add a cross-layer semaphore service solely to serialize initial provider probes.
- Do not change the existing file-access permission prompt eligibility rules.

## Current State

### Managed providers

- `apps/server/src/provider/makeManagedServerProvider.ts` runs `checkProvider` during construction when `initialSnapshot` is absent. When a seed is present, it already installs that seed and forks the real refresh with `Effect.forkScoped`.
- `apps/server/src/provider/Layers/Copilot/Provider.ts`, `Claude/Provider.ts`, and `Codex/Provider.ts` omit `initialSnapshot`, making their external checks startup-blocking.
- Existing Cursor and Devin providers demonstrate an enabled checking snapshot with `installed: true`, warning status, unknown auth, and a checking message.
- `apps/web/src/components/settings/ProvidersSettingsSection.logic.ts` and `ProviderModelPicker.models.ts` treat `installed: false` as a definitive unavailable/not-found result. Using that value for an in-progress probe would produce contradictory UI.
- `apps/server/src/provider/Layers/ProviderRegistry.ts` initializes its provider ref with an empty list, then asynchronously performs its first synchronization.
- `apps/server/src/ws/wsRpcContext.ts:292-329` reads provider registry state into the initial server configuration, while the existing provider-status configuration stream publishes later changes.

### Renderer bootstrap

- `apps/web/src/routes/__root.tsx:47-136` gates the complete shell on `bootstrapComplete`. The startup splash is also reset whenever bootstrap becomes incomplete.
- `apps/web/src/components/WebSocketConnectionSurface.tsx` is already designed to render children while the first configuration snapshot is pending.
- `apps/web/src/routes/_chat.$threadId.tsx` returns no UI while bootstrap is incomplete or the route thread is not yet known.
- `apps/web/src/routes/-__root.bounded-bootstrap.ts:35-145` currently performs selected detail, sidebar catalog, first project page, remaining project pages, and first-page thread summaries in a mostly sequential flow.
- `syncSelectedThreadDetail` in `apps/web/src/stores/main/helpers.lazy.store.ts` requires the selected thread summary to have been loaded first.
- `apps/web/src/routes/-__root.recovery.ts` and `apps/web/src/logic/orchestration/recovery.logic.ts` defer domain events during snapshot recovery and replay from the minimum recovered sequence.
- `threadHydrationEventBuffer` already protects selected-thread detail and older-message hydration from snapshot/event races.
- `apps/web/src/components/sidebar/Sidebar.renderedProjects.ts` already requests a project's first thread-summary page when an expanded project has not loaded one.

### Server correctness boundary

- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts:150-153` awaits `projectionPipeline.bootstrap` and then `getStartupOperationalState()` before command processing. These remain mandatory startup work.
- Full history remains lazy through operational-versus-history thread hydration in `OrchestrationEngine.ts:116-147`.

## Phases

### Phase 1: Guarantee Immediate Managed-Provider Snapshots

**Goal:** Make provider service construction independent of external probe latency.

**Scope and implementation:**

- Make `initialSnapshot` required in `apps/server/src/provider/makeManagedServerProvider.ts` and remove the synchronous fallback to `checkProvider`.
- Preserve the current lifecycle:
  1. read provider settings;
  2. construct and install the cheap initial snapshot;
  3. fork the real probe in the provider scope;
  4. update and publish meaningful snapshot changes;
  5. continue reacting to settings changes and periodic refreshes.
- Keep timestamp-insensitive equality so a refresh that changes only `checkedAt` does not emit a redundant update.
- Add focused initial-snapshot builders to the Copilot, Claude, and Codex provider layers.
- Compose built-in and configured custom models with the existing `providerModelsFromSettings` helpers. Preserve Claude's fallback `modelDiscovery` metadata.
- For enabled providers awaiting their first probe, return:
  - `installed: true`;
  - `version: null`;
  - `status: "warning"`;
  - `auth.status: "unknown"`;
  - static/configured models;
  - an explicit checking message.
- Continue returning the existing disabled snapshot when a provider is disabled.

**Concurrency decision:**

Do not introduce a shared initial-probe semaphore. The provider set is fixed and small, probes already have provider-specific timeout/error behavior, and independent completion lets usable providers become ready sooner. If explicit refresh-all behavior requires resource protection, bound only that caller with a small fixed concurrency; do not serialize provider construction.

**Likely files:**

- `apps/server/src/provider/makeManagedServerProvider.ts`
- `apps/server/src/provider/Layers/Copilot/Provider.ts`
- `apps/server/src/provider/Layers/Claude/Provider.ts`
- `apps/server/src/provider/Layers/Codex/Provider.ts`
- Their focused provider tests

**Exit criteria:**

Constructing any managed provider returns before a deliberately blocked real probe, and its first snapshot is immediately readable.

### Phase 2: Seed Provider Registry Before It Is Exposed

**Goal:** Ensure initial configuration contains the complete provider list without waiting for real probes.

**Dependencies:** Phase 1 must guarantee that every registered provider has a cheap snapshot.

**Scope and implementation:**

- In `apps/server/src/provider/Layers/ProviderRegistry.ts`, replace the initial empty provider list with one synchronous `loadProviders(registrations)` pass.
- Install that list in `providersRef` before returning the registry.
- Resolve the ready-provider latch for any provider already ready from its seed, if applicable.
- Retain each provider's `streamChanges` subscription so completed probes replace checking snapshots.
- Keep `wsRpcContext.loadServerConfig` and `wsStreams` on their existing contracts. The first configuration snapshot now carries checking/disabled provider entries, and later transitions still arrive as `providerStatuses` events.
- Do not modify startup model selection or workload support. Both continue using only enabled, genuinely ready providers.

**Likely files:**

- `apps/server/src/provider/Layers/ProviderRegistry.ts`
- `apps/server/src/provider/ProviderRegistry.live.test.ts`
- `apps/server/src/provider/makeManagedServerProvider.test.ts`

**Exit criteria:**

The first `getProviders` call returns a complete ordered provider list, and completing a background probe produces the same streamed transition behavior as today.

### Phase 3: Mount The Renderer Shell After Native API Availability

**Goal:** Make the application frame visible independently of catalog recovery.

**Dependencies:** None; this phase is independently safe to ship.

**Scope and implementation:**

- In `apps/web/src/routes/__root.tsx`, keep `readNativeApi() === null` as the only full-screen pre-shell gate.
- Once the native API exists, always mount server-state bootstrap, event routing, connection coordinators, `AppSidebarLayout`, the route outlet, and nonblocking dialogs/coordinators.
- Render `StartupSplash` as a pointer-events-none overlay and dismiss it after the first mounted-shell animation frame using the existing 220 ms transition.
- Do not reset or re-show the splash merely because `bootstrapComplete` is false.
- Continue using `bootstrapComplete` and loaded server configuration for file-access prompt eligibility.
- In `apps/web/src/routes/_chat.$threadId.tsx`, replace the blank bootstrap branch with a stable thread-page loading skeleton or pulsing state.
- Preserve existing deep-link retry behavior and redirect only after hydration definitively fails.
- Reuse existing sidebar bootstrap spinners rather than adding another global loading surface.

**Likely files:**

- `apps/web/src/routes/__root.tsx`
- `apps/web/src/routes/_chat.$threadId.tsx`
- `apps/web/src/routes/-_chat.$threadId.test.tsx`
- A focused root rendering or extracted splash-state test

**Exit criteria:**

With `bootstrapComplete: false`, the application shell is mounted and visible after the initial splash fade, the chat route is not blank, and permission prompts remain suppressed until their existing prerequisites are satisfied.

### Phase 4: Reduce The Initial Snapshot Critical Path

**Goal:** Complete correctness-critical renderer recovery after only the first useful data set is available.

**Dependencies:** Preserve the existing recovery coordinator and thread hydration buffer semantics.

**Scope and implementation:**

Refactor `runBoundedBootstrap` in `apps/web/src/routes/-__root.bounded-bootstrap.ts`:

1. Start selected-thread detail, when present, and sidebar catalog concurrently.
2. Once selected detail identifies its project, request the first project page with `priorityProjectId`.
3. Load only the selected project's first thread-summary page when needed to establish the selected-detail summary dependency.
4. Synchronize the first project page, sidebar summaries, selected-project summary page, and selected detail.
5. Complete initial recovery using the minimum sequence among only these critical snapshots.

Additional rules:

- Do not fetch a first thread-summary page for every project in the first catalog page.
- Leave non-selected project thread pages on the existing expansion-driven lazy path.
- Continue wrapping selected-thread detail with `threadHydrationEventBuffer` and release only events newer than that detail snapshot.
- Continue deferring events while initial snapshot recovery is active and replay from the minimum critical sequence afterward.

**Likely files:**

- `apps/web/src/routes/-__root.bounded-bootstrap.ts`
- `apps/web/src/routes/-__root.recovery.ts`
- `apps/web/src/routes/-__root.bounded-bootstrap.test.ts`
- `apps/web/src/routes/-__root.bounded-bootstrap.catalog.test.ts`

**Exit criteria:**

Independent critical requests overlap, the selected thread hydrates correctly, no non-selected project thread page is loaded eagerly, and replay still closes every observed sequence gap.

### Phase 5: Add Sequence-Safe Lazy Project Pagination

**Goal:** Stop exhausting all project pages during startup without allowing stale pages to regress state.

**Dependencies:** Phase 4 must expose the first page and its next cursor without consuming the remaining cursor chain.

**Scope and implementation:**

Extend the main store in `apps/web/src/stores/main/main.store.ts` and `helpers.lazy.store.ts` with:

- project-catalog next cursor;
- loading and retry/error state for the next page;
- an authoritative project-count cache populated from `GetSidebarThreadCatalogResult.projectThreadCounts`, including projects not loaded yet;
- `latestProjectEventSequenceById`, retained after visible deletion as a tombstone;
- an `appendProjectCatalogPage` action.

Update project event reducers in `apps/web/src/stores/main/events.store.ts` and the relevant focused project-event helper so every project lifecycle event records its sequence before applying visible state changes. Deletion must remove the visible project but retain the sequence tombstone.

Apply the following merge invariant:

- A project page and its `projectionSequence` are an atomic projection snapshot because `ProjectionCatalogQuery.getStartupProjectCatalog` already reads both within `sql.withTransaction`.
- Insert or update a returned project only when its recorded project-event sequence is not newer than the page sequence.
- Never remove a project merely because it is absent from one page.
- Overlay retained authoritative sidebar counts when a project becomes visible later; do not regress counts to an older catalog-page value when a newer sidebar count is known.
- Deduplicate overlapping projects and advance the cursor only after a successful merge.
- Keep a newer `project.meta-updated` result intact and prevent a newer `project.deleted` tombstone from being reintroduced by an older page.

Trigger subsequent pages from `apps/web/src/components/sidebar/SidebarProjectList.tsx` when the project list approaches its end, or through a compact load-more row. Coalesce concurrent requests. Preserve manual sorting state while adding newly loaded projects.

Continue using the sidebar catalog refresher after project/thread lifecycle events so recents, pins, and project counts converge authoritatively.

**Failure and retry behavior:**

- A failed page request leaves the previous cursor unchanged.
- Show a local retry/load-more state; do not return the whole application to startup mode.
- Ignore a result if the component/request generation has been disposed or superseded.
- Concurrent triggers share one in-flight request and must not append the same page twice.

**Likely files:**

- `apps/web/src/stores/main/main.store.ts`
- `apps/web/src/stores/main/helpers.lazy.store.ts`
- `apps/web/src/stores/main/events.store.ts` and focused project-event helpers
- `apps/web/src/routes/-__root.bounded-bootstrap.ts`
- `apps/web/src/components/sidebar/SidebarProjectList.tsx`
- Store and bounded-bootstrap tests

**Exit criteria:**

Startup requests only the first project page. Later pages load on demand, duplicate pages are harmless, newer metadata wins, and deleting a project during a page request cannot cause it to reappear.

### Phase 6: Verify Correctness-Critical Server Boundaries Remain Unchanged

**Goal:** Prevent startup optimization from weakening persistence and command-processing guarantees.

**Scope:**

- Leave `projectionPipeline.bootstrap` awaited before orchestration service readiness.
- Leave `getStartupOperationalState()` awaited before command processing.
- Keep queued-prompt recovery and operational thread hydration in the existing startup path.
- Keep full thread history lazy and load it only for commands that require history.
- Do not change projection bootstrap concurrency as part of this work.

**Exit criteria:**

Existing projection pipeline, startup operational recovery, command hydration, and replay tests remain green without loosening their assertions.

## Risks And Decision Gates

- **Optimistic `installed: true` during checking:** This is a display-state compromise required by the existing boolean contract and UI interpretation. It must never make the provider eligible for execution; routing remains gated on `status: "ready"`. If any execution path checks only `installed`, fix that path before shipping Phase 1.
- **Provider process burst:** Background probes remain concurrent. If launch measurements show material CPU or process pressure, add bounded concurrency to explicit refresh-all behavior or introduce a dedicated limiter in a separate measured change.
- **Partial project catalog:** Manual sorting and any project-wide operations must tolerate projects that have not loaded. If an operation inherently needs the complete set, it must explicitly finish pagination before running or remain disabled until completion.
- **Snapshot/event races:** Phase 5 must not ship without sequence tombstone tests. A plain append-only merge without event sequence tracking is rejected because it can resurrect deleted projects.
- **Authoritative counts:** Confirm `projectThreadCounts` is present and complete in sidebar catalog responses before relying on it for not-yet-loaded projects. If it is not complete, extend that existing response rather than fabricating counts client-side.
- **Rollback:** Provider changes can be rolled back independently from renderer changes. Renderer pagination should retain a fallback that can finish the cursor chain using the same sequence-aware merge if lazy triggering proves unreliable.

## Testing And Validation

### Provider unit and integration tests

Update `apps/server/src/provider/makeManagedServerProvider.test.ts` with a `Deferred`-controlled probe proving:

- service construction completes while `checkProvider` is blocked;
- `getSnapshot` immediately returns the seed;
- completing the probe replaces the seed;
- `streamChanges` emits the completed result;
- timestamp-only refreshes remain suppressed.

Add or extend Copilot, Claude, and Codex tests for:

- enabled checking snapshots;
- disabled snapshots;
- built-in plus custom model composition;
- unknown auth before probing;
- Claude fallback model-discovery metadata;
- background replacement by ready, warning, or error results.

Update `apps/server/src/provider/ProviderRegistry.live.test.ts` to expect the complete initial list rather than `[]`, then retain ready/error transition coverage.

### Renderer tests

Update bounded-bootstrap tests to verify:

- selected detail and sidebar requests are simultaneously in flight;
- selected detail supplies the priority project;
- only the selected project's first thread page is critical;
- the recovery frontier uses the minimum critical projection sequence;
- later project and thread-summary pages follow lazy cursors.

Add store tests covering:

- adding unseen projects from a later page;
- preserving a newer `project.meta-updated` event over an older page;
- retaining a deletion tombstone and preventing stale re-addition;
- applying authoritative counts when a project arrives later;
- deduplicating overlapping pages;
- not advancing a cursor on failure;
- coalescing concurrent load-more calls.

Extend chat-route tests for the nonblank loading state and unchanged missing-thread redirect semantics.

Add a focused root-render test, or extract the splash state machine, proving:

- the shell mounts with `bootstrapComplete: false`;
- the splash fades after first paint;
- the splash does not reappear on bootstrap state changes;
- file-access prompting still waits for bootstrap and server config.

### Repository commands

Use repository-defined commands from `AGENTS.md`. Run focused suites first, then the relevant package validation. Use `bun run test`, never `bun test`. Record unrelated pre-existing failures separately rather than weakening assertions.

### Manual validation

Launch the desktop app with Copilot, Claude, and Codex binaries slow, unauthenticated, or unavailable and confirm:

- HTTP/WebSocket readiness does not wait for provider probes;
- settings and model surfaces show “Checking…” rather than “Not found” during the initial probe;
- providers transition through the existing configuration stream;
- checking providers cannot receive workloads;
- the frame and sidebar appear before catalog recovery completes;
- a selected thread shows a loading surface and hydrates without dropped or duplicate events;
- loading older project pages does not resurrect a project deleted during the request;
- reconnect and replay still converge to the server projection sequence.

## Acceptance Criteria

- Copilot, Claude, and Codex provider construction is demonstrably nonblocking under a suspended probe.
- Initial server configuration contains all provider snapshots immediately.
- Provider readiness updates continue streaming without reconnecting.
- The renderer shell mounts before `bootstrapComplete` and never presents a blank selected-thread route during recovery.
- Initial bootstrap does not fetch every project page or every first-page project thread list.
- Selected-thread snapshot and event buffering retain their sequence guarantees.
- Lazy project pagination is retryable, deduplicated, and protected by project event-sequence tombstones.
- A stale project page cannot overwrite newer metadata or re-add a deleted project.
- Projection bootstrap and startup operational-state tests remain unchanged and passing.
- Focused tests, type checking, and linting pass, with any unrelated existing failures documented.

## Open Questions

None currently. The recommended decisions are captured above. If implementation reveals that sidebar project counts are not complete for unloaded projects, extend the existing sidebar catalog response before completing Phase 5.
