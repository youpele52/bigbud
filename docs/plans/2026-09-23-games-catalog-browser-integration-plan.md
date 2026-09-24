# Games catalog and in-app browser integration

**Date:** 23 September, 2026
**Created:** 23 September, 2026, 23:12 SAST (UTC+02:00)
**Last modified:** 24 September, 2026, updated for Retro Games catalog addition
**Status:** Ready for implementation (24 September refinement incorporated)
**Owner:** Planning agent
**Project root:** `/Users/youpele/DevWorld/bigbud`
**Inspected revision:** `dev` at `8389575de327b436c12416f87e457ba983c4b636` (`Fixed: Made terminal harness icons follow the active pane`)

## Summary

Add a **Games** entry immediately after Scheduled in bigbud's left sidebar. It opens a full-page, searchable game catalog styled after Plugins. Selecting a game leaves the catalog, returns to the active chat, opens the exact game link in a new tab of the existing in-app browser on the right, collapses the left sidebar, and temporarily sizes chat/browser to one-third/two-thirds of available content width. At the five-tab limit, try to close the earliest-created tab automatically; if that cannot be done safely, ask the user to close a browser tab. After more than ten minutes of continuous agent work, automatically show one nonblocking Games toast during that working period. Website metadata is fetched live with fallbacks and cached only for the current app-open session. The catalog includes the separately categorized Retro Games destination `https://www.retrogames.cz/` in addition to the original approved list.

## Related Work

- Source: this thread's approved 11-game list, navigation discussion, and Games/Plugins screenshot. No stable bigbud note or Kanban link is available; workspace note creation returned `Workspace tools are not ready`.
- No issue ID supplied.
- Relevant existing browser UI plan: `docs/plans/2026-09-11-right-panel-thread-tabs-plan.md`; revalidate against the live implementation before use.

## Problem

The existing browser can play third-party games, but there is no discoverable Games catalog or way for a waiting user to launch a curated game from a dedicated page. Ordinary browser-tab creation currently rejects a sixth tab; it does not evict the oldest. A naive catalog click could also leave the game invisible: the Plugins-like standalone route closes the right panel.

## Goals

**Latest product refinement:** Games must appear immediately after Scheduled in the sidebar. On a successful game launch, collapse the left sidebar and temporarily size chat to one third and the right browser to two thirds of available app content width. Preserve the established minimum chat width on narrow screens. Recompute the ratio when the viewport/sidebar changes, and restore the user's ordinary right-panel width when the game panel closes, the user changes tabs or leaves chat, or the user manually resizes. This supersedes prior implicit sidebar ordering and default panel width only for Games launches.

- A left-sidebar **Games** item opens a full-page catalog visually following the Plugins page: header, search, category sections, responsive two-column rows, favicon, website-derived title, and website-derived description.
- The catalog contains the original 11 fixed, free-to-play browser game URLs below plus Retro Games in its own “Retro Games” section. A click creates and activates a tab pointing to the **exact listed URL**, and makes the game visible in the existing in-app browser.
- At the five-browser-tab limit, a Games click targets the earliest-created browser tab even if tabs were manually reordered. Try automatic closure first while respecting existing agent-lease protections; if agent-controlled or otherwise unsafe, ask the user to close a browser tab, explaining the limit. Never silently interrupt an agent's browser control.
- All agents are aware Games exists. After more than ten minutes of continuous agent work on a thread, the app automatically shows exactly one nonblocking Games toast during that continuous working period; the agent must not also send a chat suggestion.
- Failures to load metadata, create a tab, or close a protected tab have predictable, user-visible outcomes; unrelated browser entry points keep their established behavior.

### Approved starting catalog (fixed destinations)

| Game                 | Exact destination                                   |
| -------------------- | --------------------------------------------------- |
| PAC-MAN              | `https://www.google.com/logos/2010/pacman10-i.html` |
| Snake                | `https://playsnake.org/`                            |
| Tetris               | `https://tetris.com/play-tetris`                    |
| Cookie Clicker       | `https://orteil.dashnet.org/cookieclicker/`         |
| Universal Paperclips | `https://www.decisionproblem.com/paperclips/`       |
| A Dark Room          | `https://adarkroom.doublespeakgames.com/`           |
| Little Alchemy 2     | `https://littlealchemy2.com/`                       |
| Infinite Craft       | `https://neal.fun/infinite-craft/`                  |
| skribbl.io           | `https://skribbl.io/`                               |
| Solitaire            | `https://cardgames.io/solitaire/`                   |
| Word Wipe            | `https://www.crazygames.com/game/word-wipe`         |
| Retro Games          | `https://www.retrogames.cz/`                        |

The names above identify the approved games; Retro Games has its own “Retro Games” catalog section. The displayed titles, descriptions, and favicons should be fetched live from their websites, with fallbacks. Cache fetched metadata only for the current app-open session; discard it and refetch at the next app launch. Do not silently replace a destination with a redirect target or a similarly named game.

## Non-Goals

- Build, host, mirror, or modify third-party games; install native games; add paid games.
- Raise the five-tab limit or globally change how unrelated browser opens and agent browser control handle that limit.
- Replace the Plugins page or the app's shared standalone-page geometry.
- Present games as health treatment or claim measured cognitive or performance benefits.

## Current State

- `apps/web/src/components/sidebar/Sidebar.actionsSection.tsx:9-23,81-139` owns left-sidebar actions, including Plugins, Scheduled, and Usage; `Sidebar.tsx` wires navigation. The icon convention here is `lucide-react`. `apps/web/src/components/ui/sidebar.shared.tsx` exposes `useSidebar().setOpen` for an idempotent collapse; `apps/web/src/components/layout/ContentPanelHeaderBar.tsx` shows the sidebar control when closed.
- `apps/web/src/components/plugins/PluginStorePage.tsx:14,85-136` renders the Plugins header, search, categorized responsive two-column list, and shared `StandaloneChatPageShell` / `StandalonePageContent`. `PluginCatalogRow.tsx` is the row presentation reference, not reusable install logic.
- `apps/web/src/routes/_chat.plugins.tsx:6-11` closes the right panel on entering Plugins. `RightPanelHost.tsx` mounts the browser in the chat layout; the Games click transition must make its newly created tab visible. New standalone routes must be classified appropriately in `routes/-__root.startup-restoration.ts` and `routes/-__root.bounded-bootstrap.ts`. `routeTree.gen.ts` is generated; never hand-edit it.
- `apps/web/src/stores/rightPanel/rightPanelTabs.store.ts:15,201-235` caps browser tabs at five and permits tab reordering. The visual `openTabs` order cannot reliably identify the agreed earliest-created tab after reordering; add store-owned creation-order metadata at the common `openBrowserTab()` allocation point, used by normal UI and `BrowserAgentControlBridge.tsx`, and remove it on close. Use it regardless of `openedByAgent`; the browser store separately tracks `openedByAgent` and active `agentLease`.
- `apps/web/src/stores/browser/browserPanel.actions.ts:14-66` has `openBrowserPanel`, which may reuse and overwrite an existing tab, and `openNewBrowserTab`, which rejects a sixth tab with an error toast. Neither directly satisfies the new Games-only behavior.
- `apps/web/src/stores/browser/browserPanel.actions.ts:89-129` confirms closing agent-leased tabs rather than immediately removing them. `apps/web/src/components/browser/BrowserCloseConfirmation.tsx:16-45` revokes agent leases before closure. A Games click must not call the ordinary close action and assume capacity is immediately freed when a confirmation is pending.
- Electron's browser webview can observe page title/favicon after navigation through `BrowserPanel.viewport.webview.lifecycle.ts`; website description is not supplied by that browser tab state. Cross-origin iframe behavior in the web app can differ from Electron and some sites may refuse embedding. Live metadata and actual in-app playability of all 12 destinations still require validation.
- `apps/web/src/stores/main/selectors.store.ts:25-37` defines the common active-work signal: session status `running`, non-null `activeTurnId`, and not health-unconfirmed. `events.store.threads.runtime.ts:118-155` reconciles active-turn identity and `latestTurn.startedAt`, including stale-running correction; use these canonical client projections rather than provider-specific progress messages.
- `apps/server/src/capabilities/BigbudCapabilityTracks.ts` and provider capability-context composition are the agent-awareness surface; verify every provider path and tell agents Games exists, while directing them not to send separate suggestions because the app owns the toast.
- Current worktree at inspection has only this Games plan as an untracked file and no modified tracked files. The inspected commit is one commit ahead of `origin/dev`; preserve the user's plan file and revalidate if the branch advances.

## Phases

### Phase 0: Settle product and external-site gates

Verify all 12 exact URLs in the intended desktop environment. Web-app playback is desirable but not required; if possible, report which games are blocked by third-party framing. Inspect titles, descriptions, favicons, redirects, and site-specific load failures. Fetch website metadata live with safe fallbacks and cache only for the current app-open session: discard the cache and refetch at app relaunch. Investigate a bounded, secure fetch path if browser cross-origin restrictions prevent fetching descriptions/favicons; do not let slow or unavailable websites block catalog rendering. Restrict metadata fetching to the fixed approved URLs, validate redirects, apply timeouts and response/content-type/size limits, and use safe favicon URLs. Keep the navigation URL independent of a site's metadata or redirect URL. Exit criterion: all entries render promptly with live metadata where available and a tested fallback otherwise.

### Phase 1: Add catalog and sidebar route

Create focused files under `apps/web/src/components/games/` for the fixed catalog data, grouping/search, row rendering, and Games page. Follow `PluginStorePage.tsx` and shared standalone-page primitives for layout; do not duplicate plugin installation behavior. Add a Games sidebar action in `Sidebar.actionsSection.tsx`, wire it in `Sidebar.tsx`, and add file-based Games route(s) alongside the Plugins route. Use the selected lucide `Gamepad2` section/page icon. Include keyboard-accessible clickable rows and meaningful image alt/fallback treatment. Extend startup/route classification and focused route tests. Keep edited or new source/test files at or below 400 lines. Exit criterion: catalog reliably opens and displays all entries, including metadata-failure fallbacks.

### Phase 2: Safe game opening and tab-capacity policy

Add a Games-specific browser-open orchestration near `apps/web/src/stores/browser/browserPanel.actions.ts` that reuses right-panel tabs, browser store, and panel coordinator. Record browser-tab creation order at the common `openBrowserTab()` allocation point, independent of manual reorder and opener. When full, target the earliest-created tab: if it has no active lease, close it automatically; if leased, do not invoke lease revocation or skip to a newer tab, but show a toast/popup stating the five-tab limit and that the oldest tab is agent-controlled, and ask the user to close a browser tab manually. Do not label `openedByAgent` alone as unclosable when no active lease exists. After the user closes any tab, provide an explicit retry action for the pending game launch; if no tab was freed, leave the request pending without replacing an existing tab. Handle races by rechecking capacity before allocation; preserve existing tab contents on close failure. On game selection, leave the Games route for the active chat, activate the new browser tab in the right panel, and collapse the left sidebar via `useSidebar().setOpen(false)` (idempotently). Provide a clear way for the user to reopen the sidebar/catalog. Do not alter ordinary links or agent-controlled browser tab-limit behavior without separate approval. Exit criterion: exact URL opens in a new tab below and at capacity, with leased and unleased agent-opened oldest tabs covered.

### Phase 3: Agent awareness and suggestion etiquette

Add concise Games-aware guidance at the proven agent-awareness surface so every provider understands the Games destination; explicitly direct agents not to send separate unsolicited game suggestions, because the app owns the notification. Verify reachability for every supported provider. Separately, make the app show **one automatic, nonblocking toast with a Games action** after more than ten minutes of continuous agent work on a thread. Key a working period by `(threadId, activeTurnId)` and start elapsed time from `latestTurn.startedAt`. Count against that authoritative start time; do not restart the elapsed clock on progress updates, renderer reload, or reconnect. Transient session-health uncertainty/recovery is not a period boundary—even if `selectIsThreadRunning` temporarily returns false or an active-turn field is temporarily absent. Preserve both the period identity and its durable shown marker until authoritative lifecycle state confirms the turn ended (completed, failed, interrupted, or stopped/closed session) or a different non-null active turn ID starts. A temporary missing/uncertain state must neither clear the marker nor trigger another toast after the same turn recovers. Trigger strictly after 10 minutes (not at exactly 10:00). Persist the shown marker by period key in the existing durable renderer preference/state mechanism so reload/reconnect cannot duplicate the toast; prune only after an authoritative end/new-turn transition. If user closes the toast, keep the marker for that period. The toast must not block agent work or start a game unasked. Exit criterion: one toast per qualifying continuous working period without repeats through recovery.

## Risks And Decision Gates

- **Lost browsing or game progress:** closing even an ordinary tab can discard unsaved state. Limit automatic eviction to the Games launch path and identify the closed tab to the user where practical; never silently close an agent-leased tab.
- **Lease interruption:** automatically close the earliest-created tab only when it has no active lease, regardless of whether an agent originally opened it. If leased, do not invoke lease revocation on the user's behalf; prompt the user to close a browser tab manually and explain that the oldest tab is currently agent-controlled. Never open a sixth tab on failure.
- **Site metadata and embedding:** titles/descriptions/icons may be missing, misleading, or change; web iframes may be blocked. Constrain live metadata fetches to the fixed approved URLs, with timeouts, response size/content-type checks, safe favicon URLs, per-session cache, and fallbacks; avoid an arbitrary-URL fetch endpoint or persistent cache. Validate source URLs before release; do not silently redirect to an alternative game.
- **Route visibility:** on selection, Games navigation must return to the active chat before opening/activating the browser; verify active thread preservation and idempotent sidebar collapse.
- **Agent noise:** prompt guidance alone cannot reliably detect ten elapsed minutes or enforce the once-per-period rule. Use an app-owned working-duration tracker and test all supported provider paths and restart/reconnect behavior.
- **Rollout/rollback:** the catalog and game-specific launcher can be disabled/removed without changing the core browser's normal tab-opening policy. No migration is anticipated, subject to the metadata and tab-age design decisions.

## Testing And Validation

- Regression tests for Scheduled → Games sidebar order; Games-launch-only 1:2 chat/browser split after sidebar collapse; viewport responsiveness and minimum chat width; ordinary panel width restoration after closing, switching, leaving chat, or manual resize. Unrelated browser and right-panel actions must not adopt the Games width.

- Focused web/server tests for the 12 fixed exact URLs, the distinct Retro Games category, category/order/search, live metadata timeout/failure/safe fallback, one-session cache and relaunch refetch, sidebar navigation, standalone route classification, and keyboard-accessible selection.
- Browser store/action tests for fewer than five tabs, five tabs, reorder-independent creation order, ordinary oldest tab auto-close, agent-opened but unleased oldest auto-close, leased oldest fallback prompt without lease revocation, failed close/open, retry after manual closure, and double-click/concurrent launch; assert unrelated browser opens still reject overflow.
- Agent-context/timer/toast tests using canonical turn state: no toast at exactly ten minutes, one after ten minutes, one per `(threadId, activeTurnId)`, same period and marker through health-unconfirmed/recovery states and reconnect/reload, no pruning until authoritative completion/failure/interruption/stop or a new active turn, and a new toast only for the new period. Verify Games guidance reaches Codex, Claude, Copilot, and OpenCode through their actual context paths.
- Manual desktop checks of all 12 links and representative play/input; confirm live favicon/title/description, session cache then relaunch refetch, return-to-active-chat behavior, right-panel tab selection, collapsed/reopenable sidebar, responsive one-third/two-thirds game layout, and capacity flow. Test web-app playback separately as a nice-to-have; record framing limitations. External page load success is an observed validation result, not a guarantee from reading HTML.
- Implementation completion requires `bun fmt`, `bun lint`, `bun typecheck`, and `bun run test`; **never** `bun test`. Rust checks apply only if Rust is changed. No tests were run for this planning-only draft.

## Acceptance Criteria

- Games is immediately after Scheduled in the left sidebar.
- A successful Games launch uses a responsive 1/3 chat and 2/3 right-browser split of available app content width, bounded by the existing chat minimum. Closing or leaving the game panel and manual resizing restore ordinary, previously persisted panel width; unrelated panels and browser opens retain their sizing behavior.

- Games is immediately after Scheduled in the left sidebar and resembles the Plugins full-page layout, with all 12 approved free game destinations, including a distinct “Retro Games” section, live website-sourced presentation, safe fallbacks, and a cache limited to the app-open session.
- Each game click leaves Games, returns to the active chat, opens a new visible browser tab at the exact approved URL, and collapses the left sidebar. At capacity, the earliest-created tab is targeted regardless of reorder or opener; if it cannot close safely, the user is asked to close a browser tab. Other browser actions and agent control retain expected behavior.
- Metadata is fetched live, falls back safely, is cached during one app-open session, and is refetched after relaunch.
- On a thread with agent work continuing beyond ten minutes, one nonblocking toast with a Games action appears during that continuous period; agent work continues and no duplicate chat suggestion is sent.
- Required checks and focused/manual verification have passed; any third-party loading limitations are reported accurately.

## Plan Validity And Handoff

This plan describes `dev` at `8389575de327b436c12416f87e457ba983c4b636`, with this plan as the only untracked file and no modified tracked files at inspection; the branch is one commit ahead of `origin/dev`. Revalidate relevant routes, browser stores, capability injection, live metadata-fetch constraints, timer behavior, and external game pages if implementation starts after changes to those surfaces. All product decisions are settled: exact approved URLs, Plugins-like catalog, left sidebar, return-to-active-chat/right-browser/collapse-left-sidebar layout, earliest-created-tab policy regardless of reorder or opener, auto-close when no active lease and a manual-close prompt when leased, live metadata with per-app-session caching and fallbacks, lucide `Gamepad2`, and one toast after ten minutes of continuous agent work. Implement these behaviors without reopening the choices absent contrary repository evidence. Preserve the user's plan file and any subsequent worktree changes.

## Implementation Validation Update

The catalog was extended to 12 entries with `Retro Games` at the exact URL `https://www.retrogames.cz/`, grouped in its own “Retro Games” category. The existing fixed-URL metadata allowlist now includes it automatically, so it uses the live metadata endpoint, safe per-site fallback, and in-memory session cache; game launch uses the same new-tab flow. The temporary game-width lifecycle was hardened so tab switching, closing the game tab or right panel, opening another panel, and manual resize clear Games sizing immediately; focused tests cover each state transition and select ordinary versus Games width only when the launched tab is visible. Automated focused checks passed for the approved URL/category, launch URL, sidebar placement after Scheduled, responsive one-third/two-thirds sizing, and width lifecycle. `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, and `git diff --check` passed. The first aggregate attempt had one concurrent mobile-web dev-server publication failure; its test passed in isolation, and a subsequent complete aggregate passed with all 9 tasks successful. Full aggregate server Vitest: 786 files / 3,396 tests passed (16 files and 64 tests skipped by suite configuration). Desktop interaction and live play of external sites were not manually rechecked in this implementation update.
