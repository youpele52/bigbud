# CLIProxy Claude harness parity plan

Date: 2026-11-05
Branch: existing `dev`; no worktrees, commits, or pushes.

## Goal and safety boundaries

Treat CLIProxy as the Claude Code harness using a different model connection. Share lifecycle, tool approval callbacks, task details and runtime mappings. Retain differences only where credential separation or demonstrated compatibility requires them. Preserve existing parallel workspace, idle-aging and terminal changes.

Settings restoration is explicitly authorized: load user, project and local settings, including hooks. This is execution authorization, not authorization to inherit arbitrary host credentials. Keep an allowlisted child environment and explicitly pin endpoint, proxy token and model aliases. Verify settings merge precedence before enabling loading: settings must not redirect the selected proxy route. Do not write user proxy configuration or change session-affinity settings.

Approval-required remains SDK default/manual; accept-edits remains `acceptEdits`; full-access remains `bypassPermissions`. Never replace `canUseTool` with unconditional allow. Explicit SDK asks must still reach the user, including in classifier Auto mode.

## Implementation sequence

1. Read repository and scoped instructions, baseline dirty paths, installed SDK declarations and shared harness construction.
2. Introduce explicit common Claude Code harness capabilities instead of interpreting resolver presence as a capability. CLIProxy uses the same SDK lifecycle/details/stop implementation and native field mapping as Claude, with fields emitted only when actual native frames supply them. Mapping support is distinct from live gateway/model qualification. Exercise the wrapper, identity remapping, non-agent exclusion and stop ownership with focused regressions; do not invent proxy-specific child mechanisms.
3. Restore the three settings sources with routing protection at the SDK boundary. Test conflicting settings environment, host credentials, selected model aliases and hooks/settings options. Do not spread `process.env`.
4. User clarification during implementation: existing bigbud Claude Code behavior is the source of truth. Do not add a new global classifier Auto mode or change contracts/persisted modes/UI. Preserve the three existing permission mappings and the shared approval callback. Any initially attempted Auto additions are removed; no unsupported classifier is enabled for gateway models.
5. Qualify child lifecycle behavior using actual installed executable and proxy version. Existing handwritten D11 replay fixtures are regression inputs, not live qualification evidence. A live probe, if necessary, uses existing credentials without printing them, a disposable workspace, a strict timeout/request budget, no production restart and sanitized event shapes only. If bounded cost cannot be established, report the blocker and retain conservative capability flags.
6. Fix proven shared resume attribution: assistant/user `agent_id` matches task identity; `parent_tool_use_id` is only a fallback and must not override authoritative identity. Cover reused parent tool IDs, nesting, concurrent children, foreground/background and non-agent tasks.
7. Verify native run-order guarantees rather than infer them from UUID format. Final review confirmed installed SDK 0.3.310 `sdk.d.ts:6389-6396` (`SDKTaskUpdatedMessage.run_id`) explicitly guarantees plain-string ordering within a task and correlation across every task frame, background membership and saved notification. Use that documented ordering to reject stale frames and recover newer runs even when their start was missed. Preserve `task_updated.run_id` through decoding; new runs clear stale settlement data. Earlier opaque-ID/retired-run assumptions were superseded by this verified contract.
8. Reuse native child stop only after validating ownership and SDK support. Do not expose CLIProxy per-child stop until tested; denial or unknown ownership must fail closed.

## Validation

Run focused Vitest through `bun run --cwd apps/server vitest run` with explicit changed/affected test paths. Never use `bun test`. Run formatter and linter with explicit paths, directly count authored source/test lengths (maximum 400), and run the configured affected-package typecheck. Broad repository/workspace checks require separate approval and are not part of this plan.

Regression matrix: settings sources and route protection; denied and explicit approvals; native and proxy capability defaults; foreground/background attribution; resume/nesting/concurrent identity; non-agent exclusion; stop ownership; documented native run-order transitions, missing-start recovery and stale frames. Report exact commands/results, pre-existing failures and remaining unverified gateway behavior.

## Acceptance criteria

- No unrelated dirty work is modified.
- Shared code no longer infers child support from resolver presence.
- Settings restoration cannot silently switch proxy endpoint, token or selected model.
- Existing Claude permission modes and callback semantics remain unchanged; no new Auto mode is introduced.
- Run chronology uses only the installed SDK's documented per-task plain-string ordering guarantee, never assumed UUID internals.
- Resume routing respects authoritative agent identity.
- Unsupported child fields and stop are not advertised as verified.
- Focused checks pass or blockers are explicitly reported.

## Executed qualification (2026-11-05)

### Installed software

- `/Users/youpele/.local/bin/claude --version`: Claude Code 2.1.318, exit 0.
- Installed server Agent SDK package: 0.3.310.
- `/opt/homebrew/bin/CLIProxyAPI --version`: prints CLIProxyAPI 8.0.51, Homebrew build 2026-11-01, then exits 2 because this executable does not recognize the version flag. No proxy daemon was started or restarted.

### Actual harness settings and hook precedence, without paid inference

An isolated local mock used fake credentials and disposable HOME/project directories. User, project and local settings each supplied conflicting endpoint/token/model environment values and a SessionStart marker hook. With the same inline flag-settings protection used by production, all three hooks executed, no request reached the inherited route, every messages request used the protected bearer token without an API-key header, and the selected model stayed pinned. The mock deliberately returned 401; its error was expected. The first instrumentation attempt incorrectly applied the message-auth assertion to unauthenticated `/api/hello`; the endpoint-specific assertion was corrected and rerun successfully.

This also demonstrated that `maxTurns` alone does not bound HTTP attempts: the actual CLI retried 401 responses. Consequently the paid probe below used a hard counting relay, not SDK cost/turn accounting, as its request-budget authority.

### Authorized bounded live CLIProxy probe

The user approved running the bounded test. The relay enforced at most six upstream messages requests including child/retry requests, JSON input at most 256 KiB per request, and `max_tokens` at most 256 per request (1,536 output tokens total maximum). Shutdown began before a 60-second hard deadline. Native tools were restricted to Agent, the predefined child had no tools, non-Agent approval callbacks denied execution, the workspace/HOME were disposable, and the relay replaced the local-only token with the configured proxy credential in memory. No credentials, raw prompts or raw provider responses were printed or persisted. Production settings, sessions and proxy configuration were untouched.

Observed run: live catalog model `gpt-6-astra`; six upstream messages requests forwarded, three subsequent attempts rejected locally without forwarding; largest incoming JSON 10,925 bytes; elapsed 15,330 ms. No limit was extended and no further paid probe was run.

| Case                                                               | Actual result                                                                                                                            |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Foreground child                                                   | `task_started` with `task_type=local_agent`, `is_backgrounded=false`, `run_id`, `prompt`, `spawn_depth` and tool/task identity keys      |
| Child frames                                                       | User and assistant frames carried `agent_id` and parent tool reference; assistant frame carried model                                    |
| Foreground settlement                                              | `task_notification` status `completed`, usage present; root result `success`                                                             |
| Background child                                                   | `background_tasks_changed`, then `task_started` with `is_backgrounded=true`                                                              |
| Native child stop                                                  | `query.stopTask(task_id)` accepted; `task_notification` status `stopped` observed; root result `success`                                 |
| Live resume, nested/concurrent attribution                         | Not exercised under this budget; synthetic shared regressions cover attribution and nesting preservation, not a live qualification claim |
| Live child tool steps, effort variations, alternate model families | Not exercised; optional fields are mapped only when emitted, never synthesized                                                           |

A server code reload/restart is required to load the adapter changes. Start a new CLIProxy session to obtain restored settings/hooks and shared rollout options; existing query processes keep their launch-time options. This implementation did not restart production processes.

### Focused validation scope

The implementation-stage run passed 25 files / 190 tests. The independent final review expanded the directly affected matrix to 32 files / 204 tests, all passing (Vitest exit 0), including protected settings-file preparation/spawn failure, stop/disposal cleanup, task update run-ID propagation, stale/repeated native runs and missed-start recovery. Explicit-path formatter write/check and linter exited 0 (zero warnings/errors). All 24 owned source/test files are within 400 lines; maximum 383. Explicit owned-file `git diff --check` exited 0. No repository-wide test/format/lint/type suite or additional paid probe was run.

The configured `bun run --cwd /Users/youpele/DevWorld/bigbud/apps/server typecheck` initially passed during review, then caught and prompted correction of a review-introduced branded-ID error. Its latest rerun exited 2 exclusively in concurrent out-of-scope workspace integration: `OrchestrationEngine.commandProcessing.ts:84` TS2375/TS1 (unknown Effect context), `:124` TS2304 (`withProjectWorkspaceMutation` missing), `:226` TS7006 (implicit-any candidate). No parity diagnostic remains. This is not an all-green package state or commit authorization.

### Independent review corrections

- Protect the proxy token in a unique private settings file (directory 0700, file 0600), not inline `--settings` argv or SDK spawn diagnostics. Reuse the session cleanup lifecycle for preparation/spawn failure, session stop and layer disposal; cleanup is idempotent. Existing authorized user/project/local settings and hooks remain enabled. The earlier mock verified inline flag-settings precedence; production now supplies the same settings through the SDK's supported file-path form.
- Clear inherited custom credential headers and every verified native alternate-provider selector (including Anthropic AWS/Google Cloud, Mantle and Gateway), pin the proxy child default, and disable forced global child-model selection. Explicit Agent/definition model choices remain supported. Configured application subagent caps are pinned in the same protected settings environment.
- Preserve `task_updated.run_id` through its decoder and handler. Use the installed SDK's documented per-task ordering guarantee, removing the unnecessary retired-run registry/explicit-start-only restriction. New runs clear stale result/end/reason/usage/metrics, including transitions recovered from progress, membership or settlement without a start frame.
- Route assistant/user frames with authoritative `agent_id` even when the parent reference is absent. Progress activities use the resolved child's spawning tool and launching turn, never a stale parent's tool ID, and share the bounded/redacted summary plus forwarding gate. Unknown child identities do not emit misleading progress.

The final owned scope is the original 22 files plus the explicitly approved `Claude/Adapter.sdk.messages.tasks.ts`, `Claude/Adapter.sdk.messages.tasks.test.ts` and `Claude/Adapter.stream.system.tasks.ts`. No workspace, idle-aging, terminal, Muse, OpenCode, UI or contract changes were made by this review.
