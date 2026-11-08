# Terminal harness icon reliability plan

**Date:** 23 September, 2026
**Status:** Implemented and validated after independent review corrections
**Owner:** Codex implementer
**Project root:** `/Users/youpele/DevWorld/bigbud`
**Inspected branch/commit:** `dev` at `b1f3e1c828`

## Summary

Make the terminal sidebar icon reflect the AI CLI currently running in each pane. A Pi or Cursor pane that starts OpenCode must show OpenCode's icon, and a pane back at its shell must lose the agent icon. Keep project labels and manual terminal renames unchanged.

## Related Work

- Source discussion: current bigbud thread `dccc3630-5cc3-4d49-a219-a045ee33fd2b` and its two screenshots.
- Previous research considered Warp and Herdr as behavioral references. This implementation uses bigbud's own terminal lifecycle and code; no reference code is transplanted.
- No issue ID, note, Kanban card, or PR was supplied.

## Problem

`terminalDisplay.ts` infers an agent from accumulated terminal output. Old Pi/Cursor banners can remain in history after another harness starts, and the fixed signature order can select the wrong icon. Output may also lack a recognizable banner. The sidebar currently has no authoritative per-pane process identity. Existing uncommitted work adds one, but reconnect hydration still needs completion.

## Goals

- Local panes independently show the icon for the recognized active foreground harness, including a switch in the same pane.
- Returning to a shell, terminal exit, restart, or close clears stale agent identity promptly and predictably.
- The identity survives output-buffer eviction and is restored when a running pane is reopened or an event stream resubscribes.
- Existing labels, manual renames, terminal rendering, and remote terminal access keep their current behavior.
- Detection has bounded cost and failure behavior across macOS, Linux, and Windows.

## Non-Goals

- Replacing xterm/PTY with libghostty, changing terminal names, or adding AI-harness hooks.
- Guaranteeing foreground-process precision on Windows ConPTY or inspecting processes on a remote SSH host in this phase.
- Copying Warp or Herdr code, or pushing the work without a separate request.

## Current State At Plan Creation

- `apps/server/src/terminal/Layers/Manager.process-drain.poll.ts` already polls subprocess activity. Uncommitted code adds one process-table scan per local poll and emits `agentIdentity` changes through the existing terminal stream.
- `apps/server/src/terminal/Layers/Manager.process-lifecycle.ts` includes local identity in terminal snapshots. Restart, stop, and exit paths reset it.
- `packages/contracts/src/workspace/terminal.ts` now defines the optional snapshot field and nullable identity event.
- `apps/web/src/stores/terminal/terminal.store.panel.ts` stores identity outside the 200-event buffer. `useThreadTerminalDrawer.ts` uses it for the icon without changing labels. Remote panes retain the output heuristic.
- `apps/web/src/components/terminal/TerminalViewport.session.helpers.ts` calls `terminal.open` when mounting, but currently only writes its history to xterm; it does not hydrate the sidebar identity from that snapshot.
- `apps/web/src/routes/-__root.logic.tsx` subscribes to terminal events. Reconnecting creates a new stream, but no current identity is replayed if no identity change occurs afterward.

## Phases

### Phase 1: Review and stabilize local detection

Keep the existing process-based implementation only where it matches this plan. Use the shell's foreground process group on macOS/Linux, an unambiguous descendant on Windows, and recognized executable/runtime-wrapper mappings. Scan once for all running local panes per poll, enforce process time/output bounds, and emit only changes. Fence changes by PID and runtime epoch; debounce transient misses. Keep remote targets outside local process inspection. Verify ambiguous/background processes stay unlabeled.

### Phase 2: Complete identity lifecycle and recovery

Apply the `terminal.open` snapshot identity to the pane's icon state while respecting newer buffered events. Replay current identities when the terminal event stream subscribes or resubscribes, so a change during disconnection converges without waiting for another harness switch. Ensure restart, exit, close, and thread cleanup discard stale identity. Preserve event ordering and avoid using historical output after an authoritative local null.

### Phase 3: Validate behavior and review

Add focused tests for split panes, Pi/Cursor to OpenCode, shell/exit clearing, buffer eviction, reopen/reconnect, restart fencing, and remote fallback. Run formatting, lint, typecheck, and focused Vitest using repository commands. Inspect the diff and verify no label or manual rename behavior changed. Review each acceptance criterion against test or observed evidence; fix gaps and repeat checks.

## Risks And Decision Gates

- Process names can be generic or wrapped. Recognize only known command shapes; an unknown/ambiguous process yields no harness icon rather than an arbitrary one.
- Windows lacks a portable foreground process group, so a process tree is best effort. A bounded timeout and one shared scan avoid a per-pane WMI request. Linux must use the supported `ps` fields; macOS was observed with the expected foreground-group behavior.
- The server does not inspect remote SSH processes. Remote panes retain the existing output heuristic, which can still misidentify a switched harness; that limitation is explicit rather than a claim of universal reliability.
- A reconnect replay must not overwrite a newer live event with an older snapshot. The implementation must make the ordering rule explicit and test it before this phase is complete.
- Keep the latest accepted identity/lifecycle version outside the 200-event buffer. An older identity or snapshot must not override a newer exit, shell state, or agent switch after buffer eviction.
- Keep a per-pane close boundary until a new runtime starts. In-flight events from the closed runtime must not restore its icon.
- Terminal state timestamps and streamed event timestamps must remain ordered after rapid identity, output, and exit transitions; otherwise snapshot hydration can revive an older icon or skip newer output. Use one monotonic per-session timestamp helper for those transitions.
- No unresolved product decision remains for this scope. New hooks, remote process inspection, and exact Windows foreground tracking are later optional work.

## Testing And Validation

- Unit tests: executable mapping, POSIX foreground and Windows descendant selection, ambiguity/background exclusion, stale-output suppression.
- Manager tests: identity event sequence, switch, transient misses, exit/restart fencing, subscription recovery.
- Web tests: snapshot hydration, new-event precedence, event-buffer eviction, close/cleanup, labels and manual override preservation.
- Contract tests: new event and optional snapshot field remain compatible with existing events.
- Manual smoke: check a live macOS PTY and local OpenCode process table; Linux/Windows behavior is exercised by synthetic process-table tests unless a native runtime is available.
- Required commands: `bun fmt` on touched files, `bun lint`, `bun typecheck`, and focused Vitest via `bun run --cwd <package> vitest run ...` (never `bun test`). No Rust checks because no Rust files change.

### Validation result

- The process detector and manager tests cover split panes, Pi to OpenCode, shell clearing, replay after reconnect, an identity change during replay, exit while disconnected, restart clearing, and identity/output/exit timestamp order.
- Web tests cover snapshot hydration, newer-event precedence, buffer eviction, remote target fallback, exit clearing, and custom-label preservation. Contract tests cover the optional snapshot field and new event.
- The independent review's two races are covered by deterministic web tests: an older Pi event after exit or close cannot restore its icon, and an older Pi snapshot cannot replace a newer OpenCode or null identity after more than 200 output events. Runtime generations fence delayed events across restarts; a close tombstone fences the closed generation.
- A failed local process-table inspection preserves the last known identity; only successful no-agent detection can clear it after the existing miss debounce. A manager regression test covers both failure preservation and subsequent shell clearing.
- A live macOS PTY and an existing OpenCode process were observed with the foreground process group expected by the detector. Linux and Windows were checked with synthetic process tables, not native runtime smoke tests.
- `bun fmt`, `bun lint`, and `bun typecheck` passed. Focused Vitest passed: server terminal suite 55 tests, web terminal suite 53 tests, and contract terminal suite 20 tests. Lint reported 13 existing warnings outside the changed files and zero errors.

## Acceptance Criteria

- Two local split panes can display different correct harness icons simultaneously.
- Switching one pane from Pi/Cursor to OpenCode changes only that pane's icon; returning to shell or exiting clears it.
- Old output cannot restore an earlier local icon, including after more than 200 output events.
- An already-running pane restores the current icon after reopening or stream resubscription, even if no new harness change occurs.
- Terminal/project labels and manual rename behavior are unchanged.
- Required checks and focused tests pass, with platform/remote limitations stated honestly.

## Open Questions

None for the agreed scope.

## Final Review

Every acceptance criterion is covered by the implementation and focused validation. The latest per-pane identity version is retained outside the event buffer, and identity, exit, restart, and close handling compare timestamps and runtime generations. Local foreground detection, replacement, clearing, reopening, and resubscription are complete. Windows remains process-tree best effort; remote SSH remains output-based best effort. A commit is authorized by the follow-up request; pushing still requires a separate request.
