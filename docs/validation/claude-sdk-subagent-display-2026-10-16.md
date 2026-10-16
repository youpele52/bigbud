# Validation ledger: Claude Agent SDK 0.3.301 and provider subagent display

**Date:** 16 October, 2026
**Plan:** [2026-10-16-claude-agent-sdk-and-subagent-display-plan.md](../plans/2026-10-16-claude-agent-sdk-and-subagent-display-plan.md)
**Branch / worktree:** `feat/claude-sdk-subagent-display` in `.claude/worktrees/claude-sdk-subagent-display`, starting at `4a1661223b`.
**Constraints:** no live Claude run (D2); no real provider sessions against `~/.bigbud`; `bun test` never used.

## Pre-flight reference verification (HEAD `4a1661223b`)

| Reference                                       | Plan claim                    | At HEAD |
| ----------------------------------------------- | ----------------------------- | ------- |
| `Adapter.tasks.reducer.ts`                      | 414 lines                     | 414     |
| `ProviderRuntimeIngestion.processor.runtime.ts` | 419 lines                     | 419     |
| `Adapter.utils.ts`                              | 430 lines                     | 430     |
| `orchestration.thread.ts`                       | 396 lines                     | 396     |
| `Adapter.stream.system.ts`                      | 395 lines                     | 395     |
| `ProjectionCatalogQuery.detail.ts`              | 396 lines                     | 396     |
| `events.store.threads.runtime.ts`               | 379 lines                     | 379     |
| `apps/server/package.json:33`                   | SDK pinned `0.3.293`          | matches |
| npm dist-tags                                   | `latest` = `next` = `0.3.301` | matches |

## Phase 1: SDK upgrade to 0.3.301

- `bun install`: lockfile diff limited to `@anthropic-ai/claude-agent-sdk` and its eight native optional packages (11 lines changed). Installed version: 0.3.301.
- Red: after updating `CLAUDE_AGENT_SDK_VERSION`, `bun run --cwd apps/server vitest run src/provider/Layers/Claude/Adapter.sdk.routing.test.ts` failed 1/2 (`expected { sdkVersion: '0.3.301' } to deeply equal { sdkVersion: '0.3.293' }`). Green after updating the assertion.
- No type breaks.

| Command                                                                                        | Exit | Result                                                                       |
| ---------------------------------------------------------------------------------------------- | ---- | ---------------------------------------------------------------------------- |
| `bun run --cwd apps/server vitest run src/provider/Layers/Claude src/provider/Layers/CliProxy` | 0    | 57 files passed, 3 skipped; 264 tests passed, 3 skipped (live smoke, opt-in) |
| `bun fmt`                                                                                      | 0    |                                                                              |
| `bun lint`                                                                                     | 0    |                                                                              |
| `bun typecheck`                                                                                | 0    | 9/9 tasks                                                                    |
