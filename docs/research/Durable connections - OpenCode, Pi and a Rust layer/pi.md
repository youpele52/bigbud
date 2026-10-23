# Pi: durability model

Research date: 2026-10-21. Upstream baseline: `badlogic/pi-mono` commit `8c4e873899b97f6abd14bc45928ccb465f83010c` (2026-10-21, all packages at 1.3.0, renamed from `@mariozechner/*` to `@earendil-works/*`). bigbud runs the bundled `@earendil-works/pi-coding-agent` **0.80.3** (`apps/server/package.json:35`, launched through node by `apps/server/src/provider/Layers/Pi/Cli.ts:16–33`, `:43–63`), not the global `/opt/homebrew/bin/pi` 1.3.0. Upstream paths below are relative to `packages/coding-agent/src/` unless another package is named. Tags: **[V]** verified in code or docs, **[I]** inferred.

## Takeaway

There are two Pi products. Only one of them is a durable agent, and it is not the one bigbud runs.

The **Pi coding agent** (`pi --mode rpc`) is file-durable and process-ephemeral. The durable artifact is an append-only JSONL session file of completed messages. The running turn, the live event stream and the in-memory branch position die with the process. There is no server mode, no attach, no event sequence number and no replay. A client resumes by starting a new process on the same file. The 1 October 2026 post [Pi Durable](https://earendil.com/posts/pi-durable/) says this is intentional: if that process dies, a person looks at what happened and tells it to continue, and Pi 1.0 is not changing that.

**Pi Durable** (`@earendil-works/pi-durable` 1.3.0) is a separate experimental harness for an agent that resumes itself after the process dies. The coding-agent package at 1.3.0 does not depend on it. The post's demo, `packages/coding-agent/src/experimental/durable/main.ts`, exists on the `v1.0.0` tag and is absent from the coding-agent tree at `8c4e873` (that `experimental/` directory contains only `source-resolver.ts`).

## What is persisted, where and when

- **Where.** `~/.pi/agent/sessions/--<cwd-slug>--/<ISO-timestamp>_<uuidv7>.jsonl`, overridable by `--session-dir`, `PI_CODING_AGENT_SESSION_DIR` or the `sessionDir` setting. [V: `docs/sessions.md`]
- **Shape.** A header line `{type:"session",version:3,id,timestamp,cwd,parentSession?}`, then entries `{type,id,parentId,timestamp,…}` of types such as `message`, `model_change`, `compaction`, `branch_summary`, `label` and `session_info`. The `id`/`parentId` links make the file a tree. [V: `core/session-manager.ts:43–197`]
- **Granularity.** One entry per **finished** message, written in the `message_end` handler. Streaming deltas, partial assistant text and in-progress tool output are never written. [V: `core/agent-session.ts:1147–1167`]
- **Write durability.** `appendFileSync` with no fsync. A power loss can drop the last entries. [V: `core/session-manager.ts:1124–1133`, `:1172–1189`]
- **Ordering.** `message_end` is emitted to listeners, including RPC stdout, **before** it is appended to disk, so a client can see a message the file never gets. [V: `core/agent-session.ts:1144–1148`]
- **Lazy creation.** In 0.80.3 the file is created only at the first assistant message, so an interrupted first turn loses the user prompt and `get_state.sessionFile` can name a file that does not exist yet. 1.3.0 writes once the first user message exists (upstream "#10000"). [V: 0.80.3 `dist/core/session-manager.js:641–654`; 1.3.0 `core/session-manager.ts:1160–1170`]
- **Crash tolerance on load.** Malformed lines are skipped and a missing trailing newline is repaired. [V: `core/session-manager.ts:627–670`]

## How a client reconnects and resumes

- **No reconnect.** Modes are `text`, `json` and `rpc`; RPC is one client over stdio. [V: `cli/args.ts:11`, `:103`; `docs/rpc.md:3`]
- **Resume is a new process.** `--session <path|id>`, `--continue`, `--resume`, `--session-id`, or the RPC command `switch_session {sessionPath}`. [V: `cli/args.ts:111–140`; `modes/rpc/rpc-mode.ts:603–609`]
- **Cursor.** The session file plus an entry id. `get_entries {since: <entryId>}` returns later entries and the current `leafId`, and the docs call the id a durable cursor across client restarts. Present in both 0.80.3 and 1.3.0. [V: `modes/rpc/rpc-mode.ts:636–647`; `docs/rpc-commands.md:689–717`]
- **Leaf position is not persisted.** On load the leaf is the last entry; `/tree` navigation that is not followed by an append is lost on restart. [V: `core/session-manager.ts:1104–1111`, `:1579–1584`]
- **Live events are not replayable.** No event ids or sequence numbers exist in the RPC types. [V by absence: `modes/rpc/rpc-types.ts`]

## In-flight work

| Event                         | Behavior                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client disconnect (stdin EOF) | `shutdown()` → `runtimeHost.dispose()` → `agent.abort()`, then the persistence listener detaches and the process exits. The turn is **aborted**, not continued. [V: `modes/rpc/rpc-mode.ts:802–805`, `:726–743`; `core/agent-session.ts:1397–1411`] The partial message is most likely never written because the listener is already gone. [I]                                         |
| Parent (bigbud server) death  | bigbud spawns Pi non-detached, so stdin EOFs as above. A stdout EPIPE calls `process.exit(1)` with no dispose. [V: bigbud `Pi/RpcProcess.ts:162–167`; upstream `modes/output-guard.ts:85–93`]                                                                                                                                                                                          |
| Pi restart or crash           | Completed messages survive; the partial message is lost; no code resumes an interrupted run. [V for persistence, I for absence of resume] An assistant message with tool calls but no persisted results is patched with synthetic `"No result provided"` results on the next model call, even though the tool may have run. [V: `packages/ai` `transform-messages.ts:179–196`, `:244`] |
| Laptop sleep                  | No sleep handling. [I] On wake a cut provider stream becomes an error; retryable errors are retried by default, 3 attempts from a 2 s base. [V: `core/settings-defaults.ts:18–26`; `packages/ai/src/utils/retry.ts:266–271`]                                                                                                                                                           |
| Slow or suspended client      | The agent loop awaits every listener and RPC waits for stdout drain, so a client that stops reading stalls the agent. [V: `packages/agent/src/agent.ts:615–620`; `modes/rpc/rpc-mode.ts:361–363`; `docs/rpc.md:56`]                                                                                                                                                                    |

## Branch, fork and compaction

- `/tree` moves within one file and may append a `branch_summary`. `fork {entryId}`, `clone` and `createBranchedSession` write a new file holding the root-to-leaf path with `parentSession` set. [V: `modes/rpc/rpc-mode.ts:611–629`; `core/session-manager.ts:1632`]
- Compaction appends a `compaction` entry and deletes nothing, so history stays auditable. [V: `core/agent-session.ts:2898`, `:3228`]

## Pi Durable: the harness the CLI does not run

Sources: the [post](https://earendil.com/posts/pi-durable/) and `packages/durable/README.md` at `8c4e873`. The post's samples match the README's public API. Where the README is more precise, this section follows the README. [V]

The post's definition: a harness is storage plus the machinery that runs conversations. A conversation is a transcript. The agent is the model, its settings and its tools. Every model call and every tool call is a task. [V: post]

- **Admit, then run.** `submit()` writes the input before the run starts and returns a handle. The same `requestId` returns the original submission, so a client retry after a crash does not ask twice. [V: README, Persist and Resume]
- **Commit before show.** Nothing is shown before its commit is stored. Partial answers and tool output commit at most every 100 ms (`settings.progress`), so a crash loses at most that window. [V: README, Concepts and Watching a Conversation]
- **Checkpoint per phase.** A task saves a checkpoint at every step. A phase has no checkpoint in its middle: after a restart the phase reruns from the top, and anything that must survive is written into the checkpoint first. Built-in retry backoff is itself a stored sleep, not an in-memory timer. [V: README, Concepts and Sleeping and Waking Up]
- **Tool intent before the tool runs.** The call is committed before `execute()`. On reopen it reruns only when the tool says `replay: "safe"`. Otherwise the model is given an `interrupted` result plus the output committed so far, and decides. Nested calls reattach by key, so a safe caller gets the calls it already made instead of starting them again. A caller that is not safe abandons its unfinished nested calls. [V: README, Tools]
- **Resume is a call, not a new prompt.** A new process opens the same storage and calls `harness.resume()`. Submitting or waiting starts the scheduler too. [V: README, Persist and Resume]
- **Crash loops park.** Open counts each task a crash, eviction or reset cut off. At `settings.restartLimit` (default 5) the task is parked with reason `restart_limit` until `harness.retryTask(id)`. A clean close is not counted. [V: README, Failures and Recovery]
- **Provider session identity survives.** Each conversation stores a UUIDv7 in `pi.provider` and sends it to pi-ai as `sessionId` across reopen, retry, reset, compaction and model changes. A fork gets a fresh one. [V: README, Persist and Resume]
- **Clients attach to current state.** `viewState()` and `watch()` start from the committed view. A client that joins late does not replay a log. A slow watch keeps 100 frames, then replaces them with the newest view. [V: README, Watching a Conversation]
- **One process owns the storage.** There is no cross-process lock. SQLite is WAL with `synchronous = NORMAL`: commits survive a process crash, and the newest can be lost on power loss. JSONL fsync is opt-in (`{ fsync: true }`) and the backend keeps the whole history in memory. [V: README, Storage]
- **Subagents are owned conversations.** A tool creates a child conversation owned by that call and submits to it with a `requestId` derived from the task id. Aborting the call aborts the child. A `replay: "safe"` tool finds the same child after a crash. [V: README, Abort and Subagents; post]
- **Application state shares the commit.** Documents (a plan, a todo list) change in the same atomic commit as the transcript entry that produced them. [V: README, Your Own State]
- **Laptop sleep is not its own feature.** The README's sleep is a stored timer (`sleepUntil`) for reminders and retries. The post lists laptop sleep beside container eviction and out-of-memory as a case for resuming from the last checkpoint. That holds when the process is killed or evicted. A freeze that leaves the process alive continues the in-memory phase; a cut model HTTP request is then that phase's own retry. [V for the timer; I for the freeze]

The post is explicit that this harness does not replace the coding agent, and that the implementation stays in TypeScript for now. A Rust port is described as possible later, not as the design. [V: post, "Why TypeScript again?"]

Embedding the package in bigbud would add a second agent runtime with an API the README marks as changing without notice, and a second store beside canonical SQLite. It would leave Codex, Claude, Copilot and OpenCode on their own durability. [I, from the package boundary and `docs/plans/2026-08-25-rust-systems-core-plan.md`]

## How bigbud uses Pi today

- One `pi --mode rpc [--session <file>]` per thread, local or over SSH. [V: `Pi/RpcProcess.ts:52–73`, `:139–146`]
- Commands used: `get_state`, `set_model`, `set_thinking_level`, `prompt` (with `streamingBehavior:"steer"` while busy), `steer`, `abort` (fire-and-forget) and `extension_ui_response`. `get_entries`, `get_messages`, `switch_session` and `fork` are unused. [V: `Pi/Adapter.methods.ts:84–90`, `:141–155`]
- The resume cursor `{sessionId, sessionFile}` comes from `get_state` and is stored in `provider_session_runtime.resume_cursor_json`; restart passes `--session`. [V: `Pi/Adapter.session.helpers.ts:45–46`, `:67–72`; `persistence/Layers/ProviderSessionRuntime.ts:128`, `:154`; `Pi/Adapter.methods.startSession.ts:38`, `:80`]
- Process exit emits `session.exited {recoverable:true}` with no automatic restart; a missing `agent_end` is handled by polling `get_state.isStreaming`. [V: `Pi/Adapter.stream.ts:17–50`; `Pi/Adapter.stream.missingAgentEnd.ts`]

## Known weaknesses

1. A running turn dies with the bigbud server, because the coding agent aborts on stdin EOF. Pi Durable would survive that death, and bigbud does not run Pi Durable.
2. Partial output is never persisted, and events reach the client before the disk.
3. No fsync; no event replay; one client only.
4. Tool side effects can be recorded as `"No result provided"` after a crash, which is the exact ambiguity bigbud's `may-have-been-sent` design exists to catch.
5. On 0.80.3 an interrupted first turn loses the prompt and leaves a dangling `sessionFile`.
6. bigbud does not use `get_entries since`, so after a backend restart it cannot reconcile its transcript against Pi's file.
