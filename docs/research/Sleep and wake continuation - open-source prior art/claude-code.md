# Claude Code and the Claude Agent SDK: sleep, retries and interrupted tool calls

Research date: 2026-10-22. Sources: anthropics/claude-code at 5ed799e (2026-10-22), latest release v2.1.308; the Agent SDK bigbud ships, `@anthropic-ai/claude-agent-sdk` 0.3.301 (`apps/server/package.json:33`), which bundles CLI 2.1.301 (manifest build 2026-10-15); public docs at code.claude.com. The CLI source is closed. Tags: **[Docs]** public docs, **[CL]** CHANGELOG entry, **[Types]** the SDK's `sdk.d.ts`, **[Bundle]** strings found in the shipped 2.1.301 binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64/claude`, read with `strings`, not reverse-engineered), **[Issue]** user report.

Changelog permalinks use `https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md`. `sdk.d.ts` lines refer to `apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` in bigbud.

## Answer

Claude Code is the closest prior art to bigbud's design, and it agrees with it. It detects sleep itself by comparing wall-clock and monotonic time when a stream idle timer fires, labels the failure "Connection lost while your computer was asleep", and retries the request only if no text block or tool call had completed; after that point it keeps what finished and does not resend, "because that could execute the same tool calls twice". On resume after a crash, a tool call with no recorded result is kept and answered with a fixed synthetic result saying the outcome is unknown and the model must check before running it again. Automatic continuation of an interrupted turn exists but is opt-in (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN`), headless only, age-bounded, and sends a "Continue from where you left off" message that tells the model to re-verify time-sensitive state. bigbud already sees the retry events but not the sleep classification.

## What happens when the connection is cut mid-turn

- **Retry budget.** Up to 10 retries with exponential backoff by default (`CLAUDE_CODE_MAX_RETRIES`, capped at 15). `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429 and 529 indefinitely and raises other transient retries to 300, about three hours. [Docs: [errors, Automatic retries](https://code.claude.com/docs/en/errors), [env-vars](https://code.claude.com/docs/en/env-vars)]
- **Before any block completes.** A dropped connection is retried with the same backoff "and the turn continues, even if some text had already started streaming". If it drops after thinking but before any text or tool call, it retries up to twice quickly, then ends with "Connection lost before a response was produced". [Docs: errors]
- **After a text block or tool call completes.** Not retried. Claude Code "keeps what Claude completed, runs any tool calls Claude finished, and continues the turn from their results", and shows "The response above may be incomplete". In headless runs and subagents it may first prompt the model to continue the cut-off response. [Docs: errors; [network-config, Streaming idle watchdogs](https://code.claude.com/docs/en/network-config)] Subagents "now automatically continue" after a cut by "computer sleep, dropped connection, or server error". [CL 2.1.257: [#L3242](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L3242)]
- **Dead-socket detection.** Four timers: a first-byte deadline (180 s on the direct API), event-level and byte-level idle watchdogs (300 s and 180 s by default), and a 5-minute body idle timeout on other providers. `API_TIMEOUT_MS` (600 s) bounds only the wait for headers. [Docs: network-config]
- **Sleep detection.** [Bundle] The idle watchdog compares how far the wall clock moved with how far the monotonic clock moved while it was armed; if the gap is more than half the idle window it throws `StreamSuspendedError` with the message "Stream watchdog detected system suspend; aborting to retry on a fresh connection". `StreamSuspended` sits in the same retryable set as `ECONNRESET`, `EPIPE` and `ETIMEDOUT`, and the user-facing labels are "Connection lost while your computer was asleep", "Your computer went to sleep mid-response. The response above may be incomplete." and "Your computer went to sleep before a response was produced. Try again." [Docs: errors confirms the three labels and that a sleep-broken connection "counts as a dropped connection"]
- **Sleep fixes in the changelog.** A sleep-interrupted response was misread as a stalled stream on Bedrock, Vertex, Foundry and gateways; background agents failed with "Agent stalled" after wake. [CL 2.1.290: [#L1066-L1068](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L1066-L1068)] MCP servers that were connecting when the machine slept were reported as timed out. [CL 2.1.307: [#L14](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L14)]

## In-flight tool calls

- **Resume after a crash mid-tool.** "A tool that was still running when the previous process ended, for example in a crash, doesn't finish or get rerun when you resume. Claude sees the call marked as cut off before its result was recorded and is told to check whether it took effect before running it again." [Docs: [sessions, What a resumed session restores](https://code.claude.com/docs/en/sessions)] The changelog shows this was built in two steps: keep the call and mark it interrupted [CL 2.1.265: [#L2967](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L2967)], then tell Claude "its outcome is unknown" and stop adding a hidden "Continue" on manual resume [CL 2.1.281: [#L1937](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L1937)].
- **The synthetic results.** [Bundle] One exported group of constants:
  - `[Request interrupted by user]` and `[Request interrupted by user for tool use]`
  - "[Tool call interrupted: the session ended before this call's result was recorded, so its outcome is unknown. Check whether it took effect before relying on it or running it again.]"
  - "[Tool call result not in this copy: this session was copied from another session before that session recorded this call's result. The call may have finished there, may still be running there, or may never have run. ...]" (for forks)
  - "[Tool call did not complete: the turn was ended to deliver the message that follows. Nothing refused it; re-run it if still needed.]"
  - "[Tool call not completed: an approval request was still unanswered when the message that follows arrived ... Nobody refused it, so this is not the user's decision; ask again if it is still needed.]"
- **Wording matters.** A shutdown-interrupted call was once reported to resumed subagents as a user rejection; this was fixed. [CL 2.1.296: [#L601](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L601)]

## Automatic continuation after a restart

- `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` makes a resumed session that ended mid-turn continue without the caller resending the prompt. It is meant for SDK mode. The continuation message defaults to "Continue from where you left off." (`CLAUDE_CODE_RESUME_PROMPT`). `..._MAX_AGE_MS` skips the auto-continue when the last transcript message is too old; turns that ended with an API error only resume within six hours. [Docs: env-vars]
- [Bundle] After an unexpected process exit the message adds: "Note: this session was automatically restarted after its process exited unexpectedly; the user has not sent a new message since the restart. Re-verify anything time-sensitive (branch state, running processes, prior partial work) before continuing."
- The changelog is a list of over-eager continuations being fixed: re-running finished turns when a tool or MCP result ended the turn, re-running turns that hit `--max-turns`, re-running turns that failed over 6 hours earlier, and `=0` not disabling it. [CL: [#L522](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L522), [#L617](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L617), [#L1548](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L1548), [#L2741](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L2741), [#L4101](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L4101)]

## What is persisted, and when

- One JSONL file per session at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, "saved continuously"; one line per message, tool use or metadata entry; the format is internal and changes between versions. [Docs: sessions] The "session ended before this call's result was recorded" result implies the `tool_use` is written before the tool finishes. [Inferred from Bundle and Docs]
- **SDK options.** [Types]
  - `continue` resumes the most recent session in the cwd (`sdk.d.ts:1625`). `resume` takes a session ID (`:2118`). `forkSession` copies into a new ID (`:1740`). `persistSession: false` writes nothing (`:1848`).
  - `resumeSessionAt` truncates the resumed chain at any chain-entry UUID (`:2132`). `resumeDropsTurn` names the turn being dropped and makes the CLI refuse the resume if anything else would be discarded (`:2133-2183`). Both are honored only in the headless/SDK path; interactive `claude --resume` loads the full chain (`:2167-2172`).
  - `enableFileCheckpointing` backs up files before edits for `rewindFiles()` (`:1717-1724`).
- Sessions persist the conversation, not the filesystem. [Docs: [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)]

## What the user sees

- Retry line " · Retrying in <n> · attempt <a>/<max>". [Bundle; CL [#L4934](https://github.com/anthropics/claude-code/blob/5ed799e5cc56bea9efff57398ca43e31d82784ff/CHANGELOG.md#L4934)]
- SDK hosts get `system/api_retry` with `attempt`, `max_retries`, `retry_delay_ms`, `error_status` (null for connection errors) and an optional `no_response` block. [Types: `sdk.d.ts:3636-3656`] Also `system/session_state_changed` with `idle | running | requires_action`. [Types: `sdk.d.ts:6001-6007`]
- Sleep is named in the error text, not a separate event. [Bundle, Docs]

## Retry limits and parking

- 10 request retries by default; at most one retry after a first-byte timeout; at most one restream after a stall; two quick retries after thinking-only drops. No parked state; the turn ends with an error and the user replies or resumes. [Docs: errors, network-config]

## For bigbud

- **Confirms D4 (TypeScript).** Claude Code's dividing line is exactly D4's: re-ask only when no text block or tool call has completed, never resend once a tool may have been dispatched, and answer an unrecorded tool call with "outcome is unknown, check before running it again". bigbud's resolution prompt is the user-facing form of the same rule.
- **Confirms D2.** The CLI's backup sleep detector is a wall-clock versus monotonic gap measured when a timer fires, the same idea as bigbud's drift sampler. It works inside each provider process without OS events.
- **Adds to D3 (TypeScript).** For the Claude provider, bigbud can classify `interrupted-by-sleep` from the CLI's own text ("while your computer was asleep", "Your computer went to sleep") in addition to its suspend and resume window. Today `Adapter.stream.system.ts:168-177` maps `api_retry` to a generic runtime warning and ignores `no_response`.
- **Confirms D6, with a warning.** Within one request the CLI retries and continues on its own after wake. bigbud must observe that rather than start a second continuation. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` would make the CLI continue after a restart as well; if bigbud also continues, it double-continues. The changelog's list of fixes shows how easy it is to re-run a finished turn. Recommendation: leave it unset and let bigbud's coordinator own restart continuation.
- **Adds to D4.** Copy two details: an age bound on automatic continuation, and the "re-verify anything time-sensitive" note in the continuation message.
- **Adds to D7.** A user report says that in a Claude Desktop SSH session, tools hosted by the desktop app (SDK MCP servers) cannot run while the laptop sleeps, although the remote CLI keeps going. [Issue: [#94887](https://github.com/anthropics/claude-code/issues/94887)] bigbud's host-side MCP tools would hit the same wall for remote turns during sleep.
- **Adds to D1.** `resumeSessionAt` plus `resumeDropsTurn` gives bigbud a validated way to fork at the last kept entry instead of trusting its own view. bigbud already passes `resumeSessionAt` (`Adapter.session.ts:78-83`, `:279-281`) but not `resumeDropsTurn`.

## Could not verify

- How the CLI decides "a tool call completed" for a streamed `tool_use` block, and whether that check is per block or per message. Source is closed; only docs and strings were read.
- Exact retry backoff base and cap for non-529 errors. The docs give only the 529 values (500 ms to 32 s).
- When the transcript line for a `tool_use` is flushed relative to dispatch, and whether it is fsynced.
- Whether the monotonic clock pauses during sleep on every platform the CLI runs on. The detector depends on that.
- Nothing was run across a real sleep.
