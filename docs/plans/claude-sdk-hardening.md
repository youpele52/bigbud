# Claude direct SDK hardening

Status: **Implemented, independently reviewed and validated; full-suite and real-turn checks passed** (2026-10-08)

## Goal and boundaries

Keep bigbud's direct Anthropic Agent SDK integration and existing Claude CLI login/API-key authentication. Upgrade the latest published stable SDK and fix the permission, cancellation and exhausted-query recovery audit findings. ACP is an interoperability option, not a prerequisite for Anthropic-supported SDK embedding. Subscription authentication working does not establish Anthropic approval of bigbud or its authentication policy.

No ACP migration, authentication-policy change, unrelated provider changes, Rust changes, installed-app rebuild or release. Do not restart running user sessions. The original scope excluded real model prompts and publication; the authorized follow-up permitted bounded real-turn probes and one local commit, but no push. Validation targets source used by local development.

**Authoritative follow-up (2026-10-08):** the user subsequently authorized bounded real Claude turns in isolated temporary workspaces (at most $0.50 total estimated test spend), necessary repository-test reliability fixes, and one scoped commit after final green checks/review. This supersedes the original no-real-prompt/no-commit boundary above; the parent session owns reliability fixes, full-suite verification and the commit. No push, authentication/ACP changes, installed-app rebuilds or interference with existing sessions are authorized. Concurrent web changes remain excluded.

## Repository and SDK evidence

- Historical implementation baseline: clean `dev`, `e75f6002b26e0f2398153e88f616d53da464f0f2`. The current worktree includes this implementation and unrelated concurrent changes to `apps/web/src/components/common/BaseMarkdown.browser.tsx` and `apps/web/src/index.css`; those web changes are excluded from this task.
- npm's stable SDK is `0.3.293`; upstream's `0.3.294` changelog entry is not published. Pin the verified published version, including native optional packages in `bun.lock`.
- Existing `@anthropic-ai/sdk` `0.115.0` satisfies the new SDK's `>=0.93.0` peer requirement; do not change it unnecessarily.
- SDK 0.3.286 leaves omitted permission mode to CLI/settings. Approval-required must explicitly pass `default`.
- SDK 0.3.268 introduced `suppressAlwaysAllowRule`; 0.3.292 applies it to organization-mandated connector approvals.
- SDK `reinitialize()` re-handshakes an already-running process. The query's message iterator is single-use and finalizes its transport when exhausted. It cannot recover a failed stream.
- `ProviderServiceSessionRouting.ts` already recreates absent sessions from persisted resume cursors on the next explicit operation. Reuse it; do not add adapter-level prompt replay.
- Revalidate this plan after changes to the Claude adapter, provider routing, SDK/CLI versions, or upstream permission/connection contracts. Version currency and SDK declarations were checked for this implementation; a later upgrade requires another conformance review.

## Implementation sequence

1. **Dependency and conformance boundary.** Upgrade `apps/server/package.json` and `bun.lock`; reuse `Adapter.sdk.ts`'s version constant throughout provider snapshots, discovery and runtime diagnostics. Keep historical 0.3.219 fixtures explicitly historical. Compile current message/option types and adapt only existing functionality affected by the upgrade.
2. **Permission handling.** In `Adapter.approval.ts`, remove Claude's full-access auto-approval timer and event countdown. SDK permission modes already approve ordinary calls; reaching the callback means confirmation is needed. Preserve AskUserQuestion and captured ExitPlanMode behavior. Normalize safe allow-rule/directory suggestions to destination `session`, never write settings, never synthesize broad rules or accept mode-changing suggestions as a session grant. With `suppressAlwaysAllowRule` or no safe grant, explicitly publish `sessionApprovalAvailable: false`, omit the session-choice label, and treat a stale session acceptance as one-shot only. Duplicate callbacks must not apply grants twice.
3. **Explicit modes.** In `Adapter.session.permissions.ts` and query options, return/pass `default` for approval-required and omitted adapter runtime mode, keep acceptEdits/bypassPermissions mappings and plan/default turn restoration. Do not inherit CLI automatic approval defaults accidentally.
4. **Cancellation lifecycle.** Use a small shared callback wait helper with an early aborted-signal check, listener registration followed by a second check, and Effect finalization removing the listener. Register pending state before publishing opening events. Original request owners settle the UI/ledger once; duplicate callers independently honor their own signals without cancelling another caller's request. Cancellation returns deny/cancel, including cached-decision callers with already-aborted signals. Stop settles all requests and avoids leaks. Cover tool approvals, questions and elicitation.
5. **Recovery.** Remove exhausted-query reinitialization/retry state from `Adapter.session.runtime.ts` and context. On stream failure, report an error and fail the active turn; on interrupt/clean end, interrupt-complete it. Close/remove the context and shut its prompt queue. Preserve the emitted native resume cursor. Next user turn goes through the existing provider routing and creates a fresh resumed query. No implicit retry, accepted-prompt replay, late ready state, or new query during stop. Remove the fake query's unsupported reopen behavior and replace the old recovery tests with single-use query and routing evidence.
6. **Documentation.** Explain direct SDK, existing authentication, explicit callback approvals, session-scoped grants and next-turn recovery in a focused Claude provider document; do not make legal or endorsement claims.

## Acceptance and validation matrix

| Requirement                                             | Evidence                                                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published stable version and accurate metadata          | lockfile/native package inspection; version consistency test                                                                                                        |
| No automatic callback acceptance in full access or plan | callback regression with virtual elapsed time; no countdown payload                                                                                                 |
| Session grants cannot persist or override mandatory ask | mixed destination suggestions, suppression, no suggestions, duplicate callbacks                                                                                     |
| Approval-required is explicit default                   | permission options and plan restoration tests                                                                                                                       |
| Cancellation cannot hang or leak                        | pre-aborted, abort at publication/wait, duplicate signal, normal resolution, stop; listener removal and one UI resolution                                           |
| Single-use query recovery and no replay                 | failed/ended stream retires query, zero reinitialize calls, stale callback denial, next explicit resume uses native cursor; existing ProviderService recovery tests |
| Existing Claude features/auth preserved                 | Claude adapter/provider suites and provider-routing tests; inspect authentication diff remains unchanged                                                            |
| Safe real SDK validation                                | opt-in isolated initialize/interrupt/close test using a never-yielding prompt stream; no real prompt, no account details printed                                    |
| Repository quality                                      | `bun fmt`, `bun lint`, `bun typecheck`, relevant Vitest and repository tests; never `bun test`                                                                      |
| File-size and scope constraints                         | authored/materially edited source/test files at most 400 lines; final diff review                                                                                   |

## Risks, rollback and review

- Full-access exceptions now wait for the user rather than silently authorizing after five seconds; this is intentional SDK-contract conformance.
- Session suggestions are restricted to safe allow additions. Unrepresentable suggestions remain one-shot approval rather than widening authority.
- Session suggestions are forwarded once per request, preserving the existing idempotency boundary. SDK 0.3.293 suppresses duplicate in-flight control requests but exposes no acknowledgement that a permission update was applied after a response write. A lost response can require another approval; do not claim exactly-once native grant delivery or silently compensate with broader authorization.
- A failed uncertain turn is not retried. Some work may already have happened; the next turn resumes saved native history. The authorized follow-up verified fresh-query native-history resume with real turns; failed-query provider routing/no implicit replay remains covered separately by deterministic regressions, not a destructive live fault injection.
- SDK and external CLI versions can differ; record both in isolated probe evidence without changing the user's installed CLI.
- Rollback is reverting only this task's dependency/module/test/doc changes, never resetting user work. No database or authentication migration is needed.
- The parent session's independent plan review confirmed requirements coverage. Independent code review identified two corrections: publish explicit session-approval unavailability for the UI, and fence late cancellation/concurrent stop during request settlement. Both were implemented with regressions and accepted on targeted independent re-review. No remaining blocking finding was identified; passing focused tests does not establish a clean full-suite result.

## Verification outcomes

- `bun fmt`, `bun lint` and `bun typecheck` passed; lint retains 22 existing warnings and typecheck passed all nine workspace tasks.
- Initial post-review focused Claude/provider-service tests: 302 passed, two opt-in tests skipped, including producer-to-UI availability and late settlement/cancellation regressions. The authorized live follow-up increased this to 305 passing tests and three opt-in skips, exercised separately below.
- No-prompt SDK control smoke passed against both the bundled runtime and installed Claude Code 2.1.294. Real model-turn testing was initially unauthorized/unverified; the authorized follow-up below supersedes that limitation.
- The first `bun run test` completed eight of nine workspace tasks successfully; the server had 3,792 passing tests, 83 skipped tests and one temporary-directory cleanup failure (`ENOTEMPTY`) outside the task's changed files. The failing file passed its isolated eight-test retry.
- A subsequent completed full-suite run overlapped review corrections and reported seven failures: five WebSocket timeouts outside changed task files and two Claude availability assertions added before the corresponding producer fix. Both WebSocket files passed their focused retry (nine tests), and the Claude assertions passed in focused validation. These historical failures were resolved before the final validation below.
- Running user sessions and application data were left untouched. The user authorized one commit containing all task-owned changes, with no push; unrelated concurrent web/resource-monitor work is excluded.

## Authorized real-turn validation follow-up

- SDK lifecycle smoke now validates four real turns: initial streamed marker response, second-turn memory on the same single-use query generator, saved native-history resume on a new query with the same native session ID, and interruption after output begins. It passed against installed Claude Code 2.1.294 and SDK 0.3.293's bundled executable.
- A separate opt-in real-adapter test validates those scenarios with the production adapter, generated orchestration MCP bridge and canonical runtime events, then verifies no retained sessions or interactive requests. It is not full-app/WebSocket end-to-end and does not claim native active-turn inspection.
- Live adapter validation reproduced an interruption-status bug: current CLI results can carry `terminal_reason: aborted_streaming` alongside a generic turn-limit subtype/error. `Adapter.utils.sdk.ts` now prioritizes explicit native streaming/tool abort causes; focused regressions reproduced the failure before the fix and preserve ordinary success/turn-limit failure classification.
- Tests use catalog-advertised Haiku, isolated temporary workspaces, ambient authentication without secret copies, disabled settings/hooks/built-in tools and denial of attempted tool calls, bounded output and explicit query budgets. Sanitized optional reports contain scenario booleans, message/event counts and estimated costs, never native IDs/account metadata. The parent session will record final global checks/review/commit outcomes; historical full-suite failures above are not overwritten by this scoped live validation.
- Final live checks passed: installed SDK lifecycle plus adapter lifecycle plus status regressions (five tests), and bundled SDK lifecycle (one test). The last SDK runs each processed four turns and preserved the native session ID across fresh-query resume; the adapter recorded 80 canonical events, with zero retained sessions or interactive requests. Across all 11 bounded live attempts, controlled native transcripts reported approximately $0.053724 estimated spend, below the $0.50 authorization (estimates are not invoices).
- Post-follow-up focused Claude/provider-service checks passed 305 tests, with three paid/no-prompt opt-in tests intentionally skipped in the ordinary run; all paid scenarios were explicitly exercised above. `bun fmt`, `bun lint` (22 pre-existing warnings, zero errors) and `bun typecheck` (nine tasks) passed after the source/test changes. Every newly authored/materially edited code file is at most 400 lines. No full repository test run or git staging/commit/push was performed by this delegated live-validation task.

## Final reliability fixes and validation

- Reactor test cleanup now closes event intake, drains worker/native filesystem work, then disposes the runtime before deleting temporary directories. A gated native-write regression failed before the fix and passed afterward.
- Socket integration tests explicitly use a live clock for handshakes and retry/open-timeout timers, preventing frozen TestClock retries. Regressions preserve the six-attempt limit and immediate propagation of ordinary RPC errors. No timeout inflation, skipped coverage or arbitrary cleanup delay was added.
- Related reliability coverage passed 191 tests across 48 files; a focused repeat passed 20 tests across five files. Independent review accepted both reliability fixes and the live-discovered native interruption classification fix without blocking findings.
- Final `bun run test` passed all nine workspace tasks. Server: 3,813 passed, 84 skipped; web: 2,272 passed; desktop: 411 passed, four skipped; mobile-web: 211 passed; contracts: 174 passed; shared: 228 passed; scripts: 94 passed. Opt-in live probes were run separately with authorization, not silently enabled for the default suite.
- Final parent-session lint passed with 22 pre-existing warnings and zero errors; typecheck passed all nine workspace tasks. Full-app/desktop WebSocket real-model end-to-end and native active-turn inspection are not claimed by the adapter-level smoke tests.

## Sources

- https://code.claude.com/docs/en/agent-sdk
- https://code.claude.com/docs/en/agent-sdk/permissions
- https://code.claude.com/docs/en/agent-sdk/user-input
- https://registry.npmjs.org/@anthropic-ai%2fclaude-agent-sdk/latest
- https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md (only entries through the published version are implementation targets)
