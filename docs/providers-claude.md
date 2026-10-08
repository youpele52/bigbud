# Claude in bigbud

bigbud integrates directly with Anthropic's [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk). Anthropic documents the SDK for embedding Claude Code's agent capabilities in applications. ACP is useful for interoperability; using an ACP wrapper does not by itself confer additional Anthropic approval.

## Authentication

Existing Claude CLI login and API-key authentication are preserved. bigbud uses the configured Claude executable and its existing configuration/environment; this upgrade does not change account or authentication policy. Successfully using a Claude subscription is a compatibility observation, **not evidence that Anthropic has approved bigbud, subscription use in bigbud, or its authentication policy**. Consult Anthropic's current terms and guidance for your use case.

## Permission modes

- Approval-required explicitly selects the SDK's `default` mode rather than inheriting a CLI automatic-approval default.
- Auto-accept edits selects `acceptEdits`; full access selects `bypassPermissions`.
- The SDK handles ordinary calls allowed by these modes. Any call that still reaches bigbud's approval callback waits for an explicit user decision, even in full access. There is no five-second auto-approval for Claude exceptions.
- “Allow for this session” applies only safe SDK-suggested allowance additions, scoped to the current session. It never writes user/project/local settings, changes permission modes, removes deny rules or invents a whole-tool rule. When the SDK suppresses that choice, an outdated client submitting it is treated as one-shot approval.
- Plan-mode questions and captured plan output remain supported; leaving plan mode restores the session's original mode.

## Cancellation and recovery

Cancelled SDK callbacks are denied/cancelled, including a request cancelled before it reaches the UI. Duplicate callback deliveries share one user request but honor their own cancellation signals.

One owner publishes each terminal request event. SDK decisions and session grants are finalized only after that publication finishes, with a final cancellation/session-stop check. A terminal UI event records the decision available when it was queued, not SDK response-write acknowledgement: an abort during publication cannot retract the already-queued event, but the stored SDK result is cancelled and no permission grant is applied. Duplicate callbacks wait for that final result rather than returning an earlier UI acceptance. Publication failure also caches a deny/cancel result, never an allowance.

An ended or failed SDK stream cannot be reopened by `reinitialize()`. bigbud retires that query, completes the affected turn as failed/interrupted and preserves the saved native resume cursor. The existing provider router creates a fresh resumed query on the next explicit turn. bigbud does not automatically resend the uncertain prompt. Work may already have happened before a transport failure; inspect the result before asking for further changes.

## Safe development validation

Run repository formatting, lint, typechecking and the Claude/provider routing Vitest suites. `BIGBUD_CLAUDE_SDK_CONTROL_SMOKE=1` enables an isolated real-SDK initialize/interrupt/close probe whose prompt stream never yields a user message. It does not send a model prompt.

The control probe defaults to the SDK's bundled executable. Set `BIGBUD_CLAUDE_SDK_CONTROL_BINARY=claude` to verify the installed CLI as well, without modifying it or using the user's project/configuration directory.

Real-turn tests consume API credit/subscription quota and remain **opt-in; obtain permission first**:

- `BIGBUD_CLAUDE_SDK_SMOKE=1 bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.sdk.smoke.test.ts` checks streamed text, second-turn memory on the same live query, native-history resume on a fresh query, and interruption after output starts. Defaults to the installed `claude`; `BIGBUD_CLAUDE_SDK_SMOKE_BINARY=bundled` selects the pinned SDK executable.
- `BIGBUD_CLAUDE_ADAPTER_SMOKE=1 bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.live.smoke.test.ts` checks the same scenarios through the real bigbud adapter and its generated orchestration MCP bridge, then verifies zero retained sessions or interactive requests. This is adapter-level conformance, not desktop/WebSocket end-to-end or native active-turn inspection.

These probes use temporary workspaces, ambient authentication without copying credentials, no user/project settings or hooks, a catalog-advertised Haiku model, no built-in tools, and deny any attempted tool call. SDK queries cap estimated spend at $0.15 each (two queries); adapter queries cap it at $0.075 each (two queries). Each test has a 50-second abort deadline within its existing 60-second test timeout. Set `TMPDIR` to an approved sandbox and optionally `BIGBUD_CLAUDE_SDK_SMOKE_REPORT_DIR` to an existing directory for sanitized JSON evidence without native IDs, account metadata or prompt content. SDK costs are estimates, not invoices, and resumed totals may include earlier transcript spend.

On 2026-10-08, these real-turn scenarios passed with SDK 0.3.293's bundled executable and installed Claude Code 2.1.294; the real adapter also passed on the installed CLI. Live validation exposed a native `aborted_streaming` result paired with a generic turn-limit error. bigbud now prioritizes native `aborted_streaming`/`aborted_tools` terminal reasons when classifying interruption instead of relying on error wording.
