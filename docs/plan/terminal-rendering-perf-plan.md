# Terminal Rendering Performance Plan

## Implementation Status

This plan has been implemented partially, but not completely.

Implemented:

1. Client-side terminal write batching exists via `TerminalWriteBatcher`, and terminal output now flows through it from `TerminalViewport.events.ts` and `TerminalViewport.session.ts`.
2. Pending output is flushed before non-output terminal events such as snapshot replace, clear, error, and exit handling.
3. Resize churn reductions are in place: drawer drag height updates are rAF-throttled in `ThreadTerminalDrawer.resize.ts`, window resize is debounced, and resize RPCs are coalesced in `TerminalViewport.tsx` with an in-flight guard.
4. The store-side subscribe optimization is in place: `terminalEventLastIdsByKey` exists and `TerminalViewport.session.ts` now does an O(1) last-id change check before reading entries.
5. Tests were added for the batching/event wiring (`TerminalWriteBatcher.test.ts`, `TerminalViewport.events.test.ts`).

Still missing relative to this plan:

1. Phase 4 has not been implemented. The server still publishes one output event per PTY chunk; there is no server-side PTY output batching in `apps/server/src/terminal/Layers/Manager.process-drain.ts`.
2. Phase 1 was implemented with xterm `write(..., callback)` serialization rather than the exact rAF accumulator proposed here, so the specific "max 60 writes/sec" design from this document is not what shipped.
3. The manual validation matrix listed at the end of this document is not recorded here as completed.

Keep this file until Phase 4 is either implemented or explicitly rejected.

## Executive Summary

| Root Cause                                         | Confidence | Verdict                                                                                                                                                                    |
| -------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unbatched synchronous `terminal.write()` per event | **90%**    | **Primary bottleneck.** Each PTY chunk → zustand `set()` → synchronous DOM mutation. rAF pattern already used elsewhere in same codebase for resize/focus, but not writes. |
| Server publishes one event per small PTY chunk     | **85%**    | Amplifies #1. Node-pty delivers chunks as small as 1 byte for ANSI spinners. Server has zero batching.                                                                     |
| Terminal resize churn during drag                  | **80%**    | Every pointermove pixel triggers `xterm.fit()` + server resize RPC. Clear waste, but only during user resize.                                                              |
| Zustand subscribe fires per-event                  | **60%**    | Each `set()` fires subscribe synchronously (not batched by React — comes from WebSocket). Real cost is the `write()` inside, not the subscribe overhead.                   |
| xterm.js configs (`allowProposedApi`, etc.)        | **~10%**   | **I was wrong about this.** `allowProposedApi` enables new addon APIs, not internal write buffering. Removed from fix plan.                                                |

**Recommended approach:** Start with Phase 1 only (~50 lines, trivially revertible). If the terminal still doesn't fully render after that, the problem is likely ANSI escape handling or a lifecycle bug, not performance — pivot to correctness debugging rather than Phases 2-4.

---

## Problem Statement

The terminal UI in bigbud has two symptoms:

1. **Doesn't fully render** — output appears incomplete, cuts off mid-stream, or lags behind actual PTY output
2. **Choppy when opening Claude Code / OpenCode** — feels janky/stuttery during provider tool execution

This document analyzes the root causes with confidence assessments and proposes a phased fix plan.

---

## System Architecture (traced end-to-end)

```
Server-side PTY (node-pty)
  → onData callback fires per-chunk (chunk size varies: 1 byte to 4096)
  → enqueueProcessEvent → drainProcessEvents loop (forked per session)
  → publishEvent({ type: "output", data }) — one event PER PTY chunk
  → terminalEventListeners.forEach → WebSocket stream.offer
  → Effect RPC WebSocket transport → browser

Client receive:
  → api.terminal.onEvent callback
  → Zustand applyTerminalEvent(one event) → set() call
  → useTerminalStateStore.subscribe fires (every set)
  → applyPendingTerminalEvents() reads all new entries from store
  → terminal.write(event.data) — synchronous DOM mutation × N
```

Key insight: **The server publishes one `terminal.output` event per PTY data chunk.** Node-pty delivers data in chunks that can be as small as 1 byte for certain output patterns (ANSI progress bars, spinner updates, cursor positioning). For a command like `npm install` that produces rapid ANSI updates, this means **hundreds or thousands of small terminal output events per second** flowing through the pipeline, each individually triggering a zustand store update and a synchronous `terminal.write()` on the client.

---

## Root Cause Analysis (with confidence)

### 🔴 Root Cause 1: Unbatched Synchronous xterm.js Writes — **CONFIDENCE: HIGH (90%)**

**Where:** `apps/web/src/components/terminal/TerminalViewport.events.ts:41`

```typescript
if (event.type === "output") {
  activeTerminal.write(event.data); // ← synchronous DOM mutation per event
  input.clearSelectionAction();
  return;
}
```

**The problem:** Each `terminal.write()` call triggers xterm.js to parse the data through its ANSI parser and apply DOM mutations (text node creation/update, reflow, paint). When hundreds of events arrive per second, each one causes a synchronous DOM update. This is the dominant bottleneck.

**Why this is the primary issue:**

- `requestAnimationFrame` is used for resize and focus in the terminal but NOT for writes — the pattern exists but isn't applied to the hot path
- The server publishes events per-PTY-chunk with no server-side batching
- xterm.js has internal queuing but still does DOM work synchronously within each `write()` call
- This is a well-known anti-pattern in terminal emulators — VS Code, Hyper, and iTerm2 all batch writes per frame

**Confidence note:** The 90% (not 100%) comes from the possibility that there's an additional issue — see Unknown Factor below.

### 🟡 Root Cause 2: Server Generates Many Small Events — **CONFIDENCE: HIGH (85%)**

**Where:** `apps/server/src/terminal/Layers/Manager.process-drain.ts:56-63`

```typescript
const unsubscribeData = ptyProcess.onData((data) => {
  if (!enqueueProcessEvent(session, processPid, { type: "output", data })) return;
  ctx.runFork(drainProcessEvents(session, processPid));
});
```

**The problem:** Node-pty's `onData` fires once per kernel PTY buffer read. On macOS, the default PTY read buffer is typically 1024 bytes, but for certain output patterns (ANSI escape sequences, line-buffered I/O), the actual data chunks can be much smaller — often 1-32 bytes for spinner/progress bar updates. Each chunk becomes a separate `terminal.output` event, a separate WebSocket message, and ultimately a separate `terminal.write()`.

**Evidence from code:**

- `drainProcessEvents` processes events one-by-one in a `while(true)` loop
- Each output event is published individually via `ctx.publishEvent`
- No server-side batching/throttling exists before publish

**This amplifies Root Cause 1:** Small chunks × synchronous writes = maximum DOM thrash.

### 🟡 Root Cause 3: Zustand Subscribe Fires Per-Event — **CONFIDENCE: MEDIUM (60%)**

**Where:** `apps/web/src/components/terminal/TerminalViewport.session.ts` (~line 210)

```typescript
const unsubscribeTerminalEvents = useTerminalStateStore.subscribe((state, previousState) => {
  if (!terminalHydratedRef.current) return;
  // ... reads full entries array, checks last id, filters pending
  applyPendingTerminalEvents({...});
});
```

**The problem:** Each `applyTerminalEvent()` → `set()` triggers the subscribe. For 100 events/sec, the subscribe fires 100 times/sec. Each invocation:

1. Reads the full entries array from state (`selectTerminalEventEntries`)
2. Checks `entries.at(-1)?.id` (O(1))
3. Calls `applyPendingTerminalEvents` which filters with `entry.id > lastAppliedId` (O(n) scan of ≤200 entries)
4. Iterates and writes each new entry

**Why confidence is only MEDIUM:**

- The `lastAppliedTerminalEventIdRef` prevents re-processing, so most invocations do O(1) + O(n) cheap array ops
- The real cost is the `terminal.write()` call inside the loop, which is Root Cause 1
- zustand's subscribe runs synchronously outside React's scheduler, so it doesn't block paint — but it does block the JS event loop briefly
- The overhead is measurable but likely small compared to the DOM work from Root Cause 1

**Note:** Since `api.terminal.onEvent` fires from a WebSocket callback (not a React event handler), React 18's automatic batching does NOT batch these `set()` calls. Each event triggers its own `set()` + subscribe fire.

### 🟢 Root Cause 4: Terminal Resize Churn During Drag — **CONFIDENCE: HIGH (80%)**

**Where:** `apps/web/src/components/terminal/TerminalViewport.tsx`

```typescript
useEffect(() => {
  void drawerHeight; void resizeEpoch;
  const frame = window.requestAnimationFrame(() => {
    fitAddon.fit();                          // DOM mutation
    if (wasAtBottom) terminal.scrollToBottom();
    void api.terminal.resize({...});         // Server RPC round-trip
  });
}, [drawerHeight, resizeEpoch, terminalId, threadId]);
```

**The problem:** During drawer resize drag, `setDrawerHeight` fires on every `pointermove` event (up to 60+/sec on high-refresh displays). Each state update triggers this effect, which calls `xterm.fit()` (forces reflow) AND sends a `terminal.resize` WebSocket RPC to the server. This competes directly with output writes.

**Evidence:**

- `handleResizePointerMove` in `ThreadTerminalDrawer.tsx` calls `setDrawerHeight` on every move
- No guard against sending resize while a previous resize is in-flight
- The fit+resize path is in the same `useEffect` as the output processing subscribe

### ⬜ Root Cause 5: Weak Evidence — Minor Contributors

These were in the initial analysis but after deeper code review, I assess them as unlikely to be significant:

| Suspect                                 | Assessment                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `allowProposedApi: true` missing        | **UNLIKELY** — This enables newer addon APIs in xterm.js 6.x, not internal write buffering. The `WriteBuffer` concept I referenced doesn't exist as an internal mechanism. |
| `fastScrollModifier` missing            | **UNLIKELY** — Controls user scroll speed, irrelevant to output rendering performance                                                                                      |
| `smoothScrollDuration: 0` missing       | **UNLIKELY** — Already the default; making it explicit has zero effect                                                                                                     |
| 200-entry buffer limit causing eviction | **UNLIKELY** — Events are consumed in real-time; the buffer only matters for replay on reconnect                                                                           |
| React reconciliation overhead           | **UNLIKELY** — Terminal uses manual zustand subscribe (not React hooks), so no React re-renders are triggered by terminal events                                           |

### ⬛ Unknown Factor: "Doesn't fully render" could be a correctness bug

The "doesn't fully render" symptom might not be purely performance-related. Possible non-performance causes I haven't ruled out:

- **ANSI escape sequence corruption** — If `sanitizeTerminalHistoryChunk` in `Manager.process-drain.ts` incorrectly strips or modifies certain escape sequences, the terminal could show garbled/incomplete output
- **Resize race condition** — If the terminal is resized while output is streaming, the PTY and xterm dimensions could diverge, causing output to appear truncated
- **WebSocket message ordering** — If terminal events arrive out-of-order due to the Effect stream merge/replay logic, output could appear incomplete
- **`writeTerminalSnapshot` clearing** — On session start/restart, `terminal.write("\u001bc")` clears the screen. If initial output arrives before the snapshot replay completes, it could be lost

**Recommendation:** If Phase 1 (write batching) doesn't fix the "doesn't fully render" symptom, the next step should be checking ANSI escape sequence handling, not further performance optimization.

---

## Corrections from Initial Analysis

During a second pass through the code, I found several things I was wrong about in my first analysis:

1. **`allowProposedApi: true` does NOT enable write buffering.** I incorrectly claimed xterm.js 6.x had an internal `WriteBuffer` mechanism gated behind this flag. In reality, `allowProposedApi` gates newer addon APIs (like the v5+ addon system). It has no effect on `terminal.write()` performance. I removed the xterm.js config phase from the plan.

2. **`fastScrollModifier` and `fastScrollSensitivity` are about user scrolling, not output rendering.** These control how fast the terminal scrolls when the user scrolls with a modifier key held. They have zero impact on programmatic output rendering.

3. **`smoothScrollDuration: 0` is already the default.** Making it explicit adds nothing.

4. **The 200-entry event buffer limit is not causing data loss during normal operation.** Events are consumed in real-time. The buffer only matters for replay after reconnection. Eviction would only happen if the client falls >200 events behind, which would manifest as much worse symptoms than "choppy."

5. **React reconciliation is not contributing.** The terminal uses a manual zustand `subscribe()` (not React's `useSyncExternalStore`), so terminal events never trigger React re-renders. The DOM mutations happen directly through xterm.js.

---

## Fix Plan (Prioritized by Confidence & Impact)

### Phase 1: rAF-Batched Write Accumulator (MUST FIX — HIGH confidence, HIGH impact)

**Confidence:** 90% this is the primary fix needed

**Files:**

- NEW: `apps/web/src/components/terminal/TerminalWriteBatcher.ts`
- MODIFY: `apps/web/src/components/terminal/TerminalViewport.events.ts`
- MODIFY: `apps/web/src/components/terminal/TerminalViewport.session.ts`

**Design:**

```typescript
// TerminalWriteBatcher.ts
class TerminalWriteBatcher {
  private pending = "";
  private rafId: number | null = null;
  private terminal: Terminal | null = null;

  write(terminal: Terminal, data: string): void {
    this.terminal = terminal;
    this.pending += data;
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flush());
    }
  }

  private flush(): void {
    this.rafId = null;
    if (this.pending.length > 0 && this.terminal) {
      this.terminal.write(this.pending);
      this.pending = "";
      this.terminal = null;
    }
  }

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pending = "";
    this.terminal = null;
  }
}
```

**Changes to `makeApplyTerminalEvent`:**

- Accept a `writeBatcher: TerminalWriteBatcher` parameter
- Replace `activeTerminal.write(event.data)` with `writeBatcher.write(activeTerminal, event.data)`

**Changes to `useTerminalViewportSession`:**

- Create a `TerminalWriteBatcher` instance at effect start
- Pass it to `makeApplyTerminalEvent`
- Call `writeBatcher.dispose()` in the cleanup

**Expected:**

- All PTY output within a ~16ms frame is concatenated and written in a single `terminal.write()` call
- xterm.js parses and renders the entire batch in one DOM update
- Max 60 writes/sec regardless of how many events the server sends
- **Potential side effect:** Output may appear in 16ms bursts rather than character-by-character. For rapid output this is imperceptible; for slow streaming it's identical.

### Phase 2: Debounce Resize During Drag (SHOULD FIX — HIGH confidence, LOW impact)

**Confidence:** 80% this helps, but the benefit is limited to user-resize scenarios

**Files:**

- MODIFY: `apps/web/src/components/terminal/TerminalViewport.tsx`
- MODIFY: `apps/web/src/components/terminal/ThreadTerminalDrawer.tsx`

**Changes:**

1. In `TerminalViewport.tsx`, the resize `useEffect`:
   - Check if a resize RPC is already in-flight (track with a ref)
   - Skip `api.terminal.resize()` if in-flight; the last call will catch up
2. In `ThreadTerminalDrawer.tsx`, `handleResizePointerMove`:
   - Add throttling: only call `setDrawerHeight` max once per 16ms (matching rAF rate)
3. Window resize event handler: add 100ms debounce

**Expected:**

- Fewer server round-trips during drag
- `xterm.fit()` called at most once per frame instead of per pixel
- Smoother drag experience

### Phase 3: Optimize Store Subscribe (NICE TO HAVE — MEDIUM confidence, LOW impact)

**Confidence:** 60% — worth doing after Phase 1 proves successful, but may be unnecessary

**Files:**

- MODIFY: `apps/web/src/stores/terminal/helpers.events.store.ts`
- MODIFY: `apps/web/src/components/terminal/TerminalViewport.session.ts`

**Changes:**

1. Add a `lastEventId: number` field alongside the entries array, so the subscribe can do an O(1) check instead of `entries.at(-1)?.id`
2. The subscribe callback becomes:
   ```typescript
   if (state._terminalEventLastIds[key] === previousState._terminalEventLastIds[key]) return;
   ```
3. Only profile this after Phase 1 — if subscribe overhead is still significant, apply this optimization

**Expected:** Minor reduction in JS overhead per subscribe invocation. Not a visible change.

### Phase 4 (If Needed): Server-Side PTY Output Batching

If Phase 1 doesn't fully resolve the choppiness, the server can batch PTY output for ~16ms before publishing. This reduces WebSocket message count and store updates.

**This is more invasive and should only be attempted if client-side batching is insufficient.**

---

## What I'm Less Confident About

1. **ANSI escape handling correctness** — I haven't reviewed `sanitizeTerminalHistoryChunk` in detail. If there's a bug there, it could cause the "doesn't fully render" symptom independently of performance.

2. **The exact chunk size distribution from node-pty** — I know node-pty uses the kernel's PTY buffer, but the actual chunk sizes depend on the writer's buffering behavior (e.g., `stdio` line buffering vs full buffering vs unbuffered). I can't predict this without testing.

3. **Effect Stream backpressure** — The server's WebSocket stream uses Effect's `Stream` which has its own buffering/backpressure semantics. If backpressure causes dropped or delayed events, that could contribute to rendering issues. I haven't traced this in detail.

4. **Whether the "doesn't fully render" symptom is actually a React lifecycle issue** — The terminal component uses `useEffect` with many dependencies. If the effect re-runs unexpectedly (due to a dependency change), the terminal gets torn down and recreated, which would cause visual glitches. I verified the session effect runs once due to the ref callback pattern, but there's room for edge cases.

---

## Validation Plan

**After Phase 1:**

1. `bun typecheck` — must pass
2. `bun run test --cwd apps/web vitest run` — terminal tests must pass
3. Manual testing:
   - `ls -laR /usr` — verify smooth scrolling, check all output rendered (compare line count to a real terminal)
   - `npm install` in a fresh project — check spinner/progress bar rendering
   - Claude Code session: ask it to read a large file, verify output renders smoothly
   - OpenCode session: ask it to run a build command, verify output renders smoothly
   - Terminal drawer resize during active output — verify no flicker or truncated output
   - Split terminal + simultaneous commands — verify both panes render correctly

**Regression checks:**

4. `bun run test` (full suite via Turbo) — must pass
5. `bun lint` — must pass

---

## File Inventory

### Files to modify:

| File                                                           | Phase | Lines | Summary                                                 |
| -------------------------------------------------------------- | ----- | ----- | ------------------------------------------------------- |
| `apps/web/src/components/terminal/TerminalViewport.events.ts`  | 1     | 105   | Wire `WriteBatcher` into `applyTerminalEvent`           |
| `apps/web/src/components/terminal/TerminalViewport.session.ts` | 1,3   | 413   | Create/cleanup batcher, optional subscribe optimization |
| `apps/web/src/components/terminal/TerminalViewport.tsx`        | 2     | 160   | Resize RPC debounce, resize throttling                  |
| `apps/web/src/components/terminal/ThreadTerminalDrawer.tsx`    | 2     | 394   | Throttle pointermove, window resize debounce            |
| `apps/web/src/stores/terminal/helpers.events.store.ts`         | 3     | ~80   | Last-event-id tracking (optional)                       |

### New files:

| File                                                            | Phase | Purpose                       |
| --------------------------------------------------------------- | ----- | ----------------------------- |
| `apps/web/src/components/terminal/TerminalWriteBatcher.ts`      | 1     | rAF-batched write accumulator |
| `apps/web/src/components/terminal/TerminalWriteBatcher.test.ts` | 1     | Unit tests for the batcher    |

### Files NOT needing changes:

- `apps/server/src/terminal/Layers/Manager.process-drain.ts` — server PTY event generation is correct, batching should happen on the client
- `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts` — WebSocket streaming is efficient
- `apps/server/src/provider/Layers/Claude/Adapter.stream*.ts` — Claude event mapping is not the bottleneck
- `apps/server/src/provider/Layers/Opencode/Adapter.stream*.ts` — OpenCode event mapping is not the bottleneck
- `apps/web/src/stores/terminal/terminal.store.ts` — store structure is fine

---

## Risk Assessment

| Phase               | Risk       | Rationale                                                                                                                                          |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 (rAF batcher)     | **Low**    | Purely additive; no data flow change. rAF batching is a proven pattern used by VS Code, Hyper, etc. Trivially revertible if it causes issues.      |
| 2 (resize debounce) | **Low**    | Cosmetic change during drag. Might need tuning for different display refresh rates.                                                                |
| 3 (subscribe opt)   | **Low**    | Simple O(1) check replacing O(n) scan. May be entirely unnecessary after Phase 1 — only implement if profiling shows remaining subscribe overhead. |
| 4 (server batching) | **Medium** | Changes server event generation timing. Could affect real-time feel and is more invasive. Only attempt if Phase 1 is insufficient.                 |

### Previously considered but REJECTED

| Idea                                            | Why rejected                                                                     |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Set `allowProposedApi: true` on Terminal        | Only enables newer addon APIs in xterm.js 6.x; does not affect write performance |
| Set `fastScrollModifier: "alt"`                 | Controls user scroll speed, not programmatic output rendering                    |
| Explicit `smoothScrollDuration: 0`              | Already the default value                                                        |
| Increase `MAX_TERMINAL_EVENT_BUFFER` beyond 200 | Events consumed in real-time; buffer size not a bottleneck                       |

All phases are independent and should be shipped incrementally, testing after each.
