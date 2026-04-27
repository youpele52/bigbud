# Browser Integration Plan

## Goal

Let users open and use a real Chromium browser from bigbud chat sessions.

Phase 1 ships browser support through `opencode` only. The browser must feel native to bigbud, including matching the current app background theme.

## Scope

Phase 1 includes:

1. Launching a Chromium session from an OpenCode-backed thread.
2. Letting the agent navigate, inspect, click, type, capture screenshots, and report results.
3. Showing browser activity in the existing runtime/tool event UI.
4. Letting users intentionally drive browser usage through prompts.
5. Keeping browser visuals aligned with bigbud's current light/dark background treatment.

Phase 1 does not include:

1. A provider-agnostic browser abstraction for all adapters.
2. Full multi-provider rollout.
3. A separate browser-first product surface outside the current chat flow.

## Product Requirements

1. Users can ask the agent to open Chromium and use it freely for web tasks.
2. The agent knows browser capability exists and when to use it.
3. Browser actions remain visible, reviewable, and predictable.
4. Approval behavior stays consistent with the selected runtime mode.
5. Browser failures surface as normal runtime/tool failures, not silent hangs.

## Recommended Architecture

Use browser as an OpenCode-exposed tool capability, not as a new BigBud provider.

Why this is the right first step:

1. `opencode` already has dedicated adapter, server manager, skill discovery, and event mapping.
2. The app already understands generic tool lifecycle events.
3. This avoids inventing a second orchestration path before the first browser workflow is proven.

## Phase 1 Design

### 1. Runtime

Add a Chromium-capable tool/runtime behind the OpenCode session.

Expected behavior:

1. OpenCode sessions can start or attach to a browser context.
2. Browser actions flow through the existing provider event stream.
3. Screenshots and page metadata can be emitted as artifacts or tool summaries.

### 2. Agent Awareness

OpenCode must be explicitly told that browser is available.

The instruction should tell the agent:

1. Browser exists and can be used when the task requires live web interaction.
2. Prefer codebase inspection first when the task is local-only.
3. Use browser for UI verification, login flows, repros, navigation, scraping, and screenshots.
4. Summarize what was verified, including URL and important observations.
5. Avoid unnecessary browser use when terminal or file tools are sufficient.

Important: do not rely on prompt text alone. The runtime must actually expose the tool.

### 3. User Experience

The initial UX should stay inside the current chat/thread model.

Users should be able to:

1. Ask the agent to open Chromium.
2. See browser progress in the conversation timeline.
3. Review screenshots, errors, and summaries.
4. Approve sensitive actions when required by runtime mode.

The first release can reuse the existing tool event UI before adding browser-specific chrome.

### 4. Theme Requirements

The browser surface should assume the current bigbud background theme.

That means:

1. Default browser presentation should follow bigbud light/dark state.
2. Any embedded or previewed browser frame should inherit `bg-background`-style treatment rather than introducing a separate neutral shell.
3. Screenshots and loading states shown in chat should sit on the same visual background language as the rest of the app.
4. If the browser runtime supports theme emulation, prefer syncing it with bigbud's resolved theme.

This should follow the same source of truth already used by the web app theme system instead of creating browser-only theme state.

## Likely Implementation Areas

1. `apps/server/src/provider/Layers/OpencodeAdapter.session.ts`
2. `apps/server/src/provider/Layers/OpencodeAdapter.stream.ts`
3. `apps/server/src/provider/Layers/OpencodeProvider.ts`
4. `apps/server/src/provider/Layers/DiscoveryRegistry.descriptors.ts`
5. `apps/web/src/stores/main/events.store.ts`
6. `apps/web/src/logic/session/worklog.logic.ts`
7. `apps/web/src/hooks/useTheme.ts`

## Risks

1. Prompt says browser exists but runtime exposure is incomplete.
2. Browser events are too generic, making activity hard to understand in the UI.
3. Theme drift between bigbud and Chromium preview surfaces.
4. Approval semantics become confusing for navigation, auth, downloads, or form submission.
5. Long-lived browser contexts leak resources across sessions.

## Rollout Plan

1. Expose Chromium capability in OpenCode only.
2. Add OpenCode-specific instruction/skill text for browser usage.
3. Map browser activity into existing tool progress and summary events.
4. Add minimal UI support for screenshots and clearer browser labels if needed.
5. Verify theme sync against bigbud light, dark, and system modes.
6. After OpenCode is stable, decide whether to generalize browser support for other providers.

## Acceptance Criteria

1. In an OpenCode thread, a user can ask to open Chromium and the agent can use it successfully.
2. The agent visibly reports browser actions in the thread timeline.
3. Failures are surfaced clearly.
4. The browser surface matches bigbud's current background theme.
5. The design remains compatible with later rollout to other providers without forcing it now.
