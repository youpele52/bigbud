# Remote workspace bridge: Transport closed investigation and repair plan

## Metadata

- Status: Draft — the notification-handling defect is reproduced in the incident artifact and runtime, but the historical trigger for the transport closure is unconfirmed.
- Created: 2026-09-14T22:34:58+02:00 (Africa/Johannesburg).
- Last modified: 2026-09-14T22:47:55+02:00 (Africa/Johannesburg).
- Project root: `/Users/youpele/DevWorld/bigbud`.
- Inspected branch: `main`.
- Inspected HEAD: `9d815276ef885acc4ad8a779208721009fc8756c`.
- Initial worktree: 75 modified tracked files, 8 untracked files, no staged changes. Existing work includes remote transport changes and unrelated mobile/UI work.
- Tracked worktree diff SHA-256: `c7e52566a2b2ba352b707d200eac4dd91d15e77721a914247898cd76e8f9da11` (`git diff --binary | shasum -a 256`).
- Incident thread: `0ac5c1a0-ae96-4ad3-bb38-83d275335f26` (“whats up”). No external issue was supplied.
- Deliverable: diagnosis and implementation plan only. No product code, tests, configuration, Git state, or live sessions may be changed during this investigation.

## Goal and definition of done

Explain why remote workspace tools return `Transport closed`, distinguish the failing local MCP connection from the SSH connection, and specify the smallest supported repair and regression checks.

Implementation acceptance criteria:

1. Ordinary remote tool use remains available after initialization and client notifications, including roots changes and cancellation notifications.
2. Notifications never produce JSON-RPC responses. Unsupported requests with valid IDs still receive a method-not-found error with the same ID.
3. The connection remains usable for a subsequent `ping`, `tools/list`, and harmless remote command.
4. Tool failures from HTTP, authentication, SSH, or the remote agent return actionable tool errors without terminating the MCP protocol connection.
5. At startup, a local Codex runtime with a remote workspace includes `bigbud_remote_workspace` in its required readiness checks. A known startup failure of that required bridge must not be silently presented as a ready remote session. Continuous health monitoring or new post-start UI/session states are outside this plan.
6. Local workspace startup retains its existing compatibility behavior; remote invocation identity and replay protection remain intact.
7. A fresh application-created session passes the relevant regression tests and a read-only live remote smoke check after the repair. Existing uncertain or mutating calls must not be replayed automatically.

## Background and evidence

### Observed failure

The configured workspace is `/root` on `root@46.225.127.53`, with key path `~/.ssh/open_stack`. This comes from the active workspace configuration; the key contents were not read.

Repeated calls to `bigbud_remote_workspace/bash` return immediately:

```text
tool call error: tool call failed for `bigbud_remote_workspace/bash`

Caused by:
    Transport closed
```

The failing session reports the synthetic local cwd:

`/var/folders/2l/n21yzwk92050bbzprv854q_w0000gn/T/bigbud-codex-remote-workspace-9QmbS7`

This error says the MCP client cannot use its bridge transport. It does not establish that the VPS is down, the key is wrong, or SSH authentication failed. The earlier native `exec_command` attempt using `/root` as a local working directory failed separately before any remote command was executed and is not evidence about VPS connectivity.

### Actual incident artifact, runtime, and timeline

The incident's generated script remains at `<synthetic cwd>/.bigbud/remote-workspace-mcp-server.mjs`. It is 21,219 bytes and was created/modified at `2026-09-14T20:23:16Z`. Its line 452 contains the same unconditional null-ID response; its asynchronous error path also uses a null ID.

The running Codex process was PID `18040`, executable `/opt/homebrew/Caskroom/codex/0.153.2/bin/codex`. Its launch configuration points the bridge at the development app's Electron Helper. With `ELECTRON_RUN_AS_NODE=1`, that helper reports Electron `40.6.0` and Node `24.13.1`. A diagnostic launch of the exact generated file under that runtime passed syntax checking, initialized, listed eight tools, reproduced the two invalid notification replies, and stayed alive with stdin open and no stderr. It exited normally after the diagnostic input pipe closed. No `tools/call` was sent in that experiment, so it did not write invocation state or execute remote work.

The provider log is `/Users/youpele/.bigbud/dev/logs/provider/0ac5c1a0-ae96-4ad3-bb38-83d275335f26.log`:

| UTC timestamp   | Evidence                                                                                                    |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| `20:23:20.701Z` | Lines 55–58: MCP servers starting, followed by `thread/started`.                                            |
| `20:23:20.910Z` | Line 64: `mcpServer/startupStatus/updated` explicitly names `bigbud_remote_workspace` with `status: ready`. |
| `20:23:53.615Z` | Line 241: first remote `bash` tool fails with `Transport closed`, `durationMs: 0`.                          |
| `20:23:56.405Z` | Line 247: repeated remote `bash` fails the same way, also `durationMs: 0`.                                  |

The two failures also appear in `/Users/youpele/.codex/logs_2.sqlite`, rows `109158765` and `109158788`. The provider process remains alive, but no child for this remote bridge was present at inspection. The inspected incident-window logs did not record the bridge's exit status, a protocol-deserialization failure, or the triggering notification. Thus the evidence establishes a successful startup followed by a lost local MCP transport; it does not establish why that pipe was lost.

Five nearby Electron Helper SIGTRAP reports describe crashes at `20:23:16.645–.695Z`, before the recorded MCP readiness. Their process parents cannot be attributed to this bridge from the available evidence. One report is `/Users/youpele/Library/Logs/DiagnosticReports/Electron Helper-2026-09-14-222339.ips`. Do not label those reports as the incident's cause without PID/parent correlation.

### Relevant execution path

```text
Local Codex app-server
  -> stdio MCP: generated remote-workspace-mcp-server.mjs
  -> local HTTP POST /api/internal/thread-tools
  -> runRemoteWorkspaceProcess: resolve this thread's remote target and cwd
  -> runToolCommand: direct SSH or configured remote-agent transport
  -> remote command in /root
```

The bridge is created locally after a remote readiness probe. It does not run on the VPS. The HTTP handler chooses the execution target from the thread/project state, rather than trusting an arbitrary host supplied by the tool.

### Reproduced protocol defect

`apps/server/src/remote-workspace-bridge/remoteWorkspaceMcpBridge.template.ts:213` implements the generated request dispatcher. It special-cases `notifications/initialized`, but the fallback at line 240 responds to all other unknown methods with `request.id ?? null`. The outer asynchronous error path at line 249 also substitutes a null ID.

The following input, which has no request ID, produces a response:

```json
{ "jsonrpc": "2.0", "method": "notifications/roots/list_changed" }
```

Observed output:

```json
{
  "jsonrpc": "2.0",
  "id": null,
  "error": { "code": -32601, "message": "Method not found: notifications/roots/list_changed" }
}
```

`notifications/cancelled` produces the same invalid response shape. The installed `@modelcontextprotocol/sdk` 1.29.0 `JSONRPCMessageSchema` rejects that output; the otherwise identical error with numeric ID `1` is accepted. Its `RequestIdSchema` accepts strings or integers, and its notification schema describes notifications as messages that do not expect responses.

The existing orchestration bridge provides the local pattern to reuse: `apps/server/src/orchestration-tools/orchestrationMcpBridge.template.ts:214` only emits the unsupported-method response when `message.id !== undefined`.

Confidence: high that both the remote template and actual incident artifact contain a protocol defect. A protocol-strict client can reject its output. The exact notification and client-side closure in the original incident remain unconfirmed; schema rejection alone does not prove how every client handles the error.

### Startup readiness gap

`apps/server/src/provider/Layers/Codex/Adapter.session.ts:160` supplies only `[orchestrationConfig.serverName]` as `expectedMcpServerNames`, even when it has created a remote-workspace bridge. Remote readiness before bridge creation checks the remote command path, not the new MCP connection.

`apps/server/src/codex/codexAppServerManager.startSession.ts:56` warns and proceeds if MCP status probing fails or remains pending. Its current tests intentionally preserve this permissive behavior. Merely adding the remote name to the array will therefore improve inspection but will not reliably prevent a broken remote session from starting.

The status parser in `apps/server/src/codex/codexAppServerManager.mcp.ts` also treats a nonempty tools array as sufficient before considering status. Advertised/cached tool definitions alone cannot establish that a transport remains alive.

Confidence: high for these code findings. They explain how a broken bridge can go insufficiently checked. In this incident the remote bridge explicitly reported ready before failing, so a startup gate alone would not have prevented the later loss of transport. Treat readiness improvements as secondary hardening, not the incident's proven root cause or a complete recovery mechanism.

### Experiments performed

The diagnostic programs rendered source in memory or launched the existing incident artifact in isolated subprocesses. No test files or project caches were generated, and no live HTTP request or remote command was dispatched by these experiments.

- Rendered the current remote bridge with dummy local HTTP configuration, then launched it under Node `v25.2.1` and Bun `1.3.14` using `--input-type=module -e`.
- Sent `initialize`, kept stdin open, then sent `tools/list`. Both runtimes returned two correctly newline-delimited messages, no stderr, and remained alive during the observation window. This rules out a universal current-source syntax or startup/framing failure under those runtimes.
- Sent the initialization sequence followed by roots-change and cancellation notifications. Reproduced both null-ID responses.
- Validated the null-ID response against the locally installed MCP SDK schema; validation failed. A numeric-ID control passed.
- Inspected the existing bridge and readiness tests. The bridge creation test checks generated syntax/configuration, and the identity tests send tool requests; neither covers notification-induced transport behavior.

No full test suite, repository-wide formatter, build, installation, service restart, remote mutation, or session reset was run. Formatting is scoped to this plan file. Broad formatter/test commands can modify the dirty checkout or caches and are deferred to implementation.

## Plan assumptions

- Verified: the generated file used by the incident contains the same dispatcher defect as the inspected source. Still unverified: that defect triggered this particular historical closure. Preserve that distinction until a client-side reproduction or original protocol/exit evidence resolves it.
- MCP notifications may occur after initialization or interruption. Their handling must be safe regardless of which notification caused this incident.
- Cached tool catalogs can survive transport failure; current readiness is a separate concern. Validate the actual Codex status payload before extending the parser.
- The remote transport selection is already being changed in the dirty worktree. Reuse `resolveToolTransportTarget` and preserve the user's selected route. Do not switch between direct SSH and the remote agent as an unrelated workaround.

## Scope

In scope: remote MCP notification handling, request/error discipline, focused protocol regression tests, remote-specific Codex startup readiness, and actionable diagnosis/recovery instructions. Post-start reporting remains the existing failed-tool event/UI behavior; recovery guidance is documentation and manual verification, not a new monitoring or recovery subsystem.

Out of scope: modifying the VPS, SSH keys, firewall, remote-agent binaries or journals; migrating transports; disabling replay safety; automatic command replay; broad provider rewrites; publishing or restarting the user's current session during planning.

Preserve numeric and string request IDs, existing supported protocol versions and framing, tool schemas, HTTP authorization, output limits, remote cwd resolution, stable invocation identities, and cleanup ownership. The shared template also serves Claude and OpenCode, so changes must remain provider-neutral.

## Repository findings and reuse targets

| Concern                | Files and relevant behavior                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local bridge lifecycle | `apps/server/src/remote-workspace-bridge/remoteWorkspaceBridge.ts`; creates a temporary cwd and `.bigbud` directory, removes it on cleanup.                                   |
| Generated bridge       | `remoteWorkspaceMcpBridge.ts`; `remoteWorkspaceMcpBridge.template.ts`; `.template.shared.ts` under the same directory. Correct the generator, never a running temporary file. |
| Notification precedent | `apps/server/src/orchestration-tools/orchestrationMcpBridge.template.ts:197` and `:214`.                                                                                      |
| Codex configuration    | `apps/server/src/codex/codexRemoteWorkspaceBridge.ts`; server name is also available from `remoteWorkspaceTools.ts`.                                                          |
| Codex session wiring   | `apps/server/src/provider/Layers/Codex/Adapter.session.ts`; `Adapter.session.remoteWorkspace.ts`.                                                                             |
| Startup gate           | `apps/server/src/codex/codexAppServerManager.startSession.ts`; `.mcp.ts`; `.types.ts`.                                                                                        |
| Process diagnostics    | `apps/server/src/codex/codexAppServerManager.handlers.ts:54`; `codexStderrClassifier.ts` drops structured non-ERROR log lines.                                                |
| Remote dispatch        | `apps/server/src/ws/http.threadTools.ts:91`; `http.threadTools.remoteWorkspace.ts`; `apps/server/src/tool-transport/toolTransport.ts`.                                        |
| Existing tests         | `remoteWorkspaceMcpBridge.identity.test.ts`; `codexRemoteWorkspaceBridge.test.ts`; `codexAppServerManager.startSession.test.ts`; `provider/Layers/Codex/Adapter.test.ts`.     |

The applicable repository instruction file is root `AGENTS.md`; no nested `AGENTS.md` was found in the inspected areas. Follow the existing dot-separated module naming and the 400-line maximum for authored code/test files.

## Implementation steps

1. **Resolve the remaining client-side causal check.** The artifact, executable, and historical ready/failure timeline are already inspected above. Reproduce the initialize → notification → next request sequence with the actual Codex MCP client in an isolated diagnostic session, keeping its logs/state outside the checkout and the existing user session intact. Capture protocol/child-exit evidence with credentials redacted. If the client stays connected or evidence identifies a different cause, revise the incident diagnosis; the proven notification defect still merits its narrow fix, but must not be represented as the complete incident repair. Use the isolated client experiment specified below. Do not repeat broad log searches that cannot recover missing historical events. An inconclusive experiment does not block steps 2–3; it blocks claiming the notification fix resolves the historical incident.
2. **Correct the generated remote dispatcher.** In `remoteWorkspaceMcpBridge.template.ts`, distinguish notifications from requests before invoking request-only handlers. Consume the initialized notification, safely ignore unsupported notifications, and never send responses for them, including asynchronous error paths. Reuse the orchestration template's request-ID guard. Preserve valid request IDs exactly, including `0` and string IDs. Keep current unknown-request and tool-error behavior. Cancellation must not introduce automatic replay or falsely claim that remote work was cancelled; adding end-to-end cancellation is outside this repair.
3. **Add an actual protocol regression test.** Add `apps/server/src/remote-workspace-bridge/remoteWorkspaceMcpBridge.protocol.test.ts`, keeping it below 400 lines and splitting fixture helpers by concern if necessary. Spawn the rendered bridge with a pipe kept open, perform initialization, send notifications, then issue another request. Assert the complete output stream contains only responses to actual requests and remains valid. Cover both existing framings, fragmented input, and multiple separately framed messages delivered in one chunk; this does not add JSON-RPC batch-array support. Cover roots changes, cancellation, arbitrary future notifications, unknown requests, and numeric/string/zero IDs. Also send ID-less `ping`, `tools/list`, and `tools/call`: each must produce no response or request-only work, and a subsequent valid request must succeed. For discarded `tools/call` notifications, assert no HTTP dispatch and no invocation-state file change. Cover asynchronous failure for an actual tool request, preserving its original ID, and then a successful request. Reuse the isolated subprocess/HTTP fixture patterns from the identity tests; keep fixture state outside the checkout.
4. **Specify remote Codex readiness hardening before implementing it.** Reuse the remote server-name constant in `codexRemoteWorkspaceBridge.ts` and expose it to the adapter if necessary. Include that name when the remote bridge is created. Add a remote-specific required-server policy to `codexAppServerManager.types.ts` and startup wiring rather than changing permissive behavior globally. The captured `mcpServer/startupStatus/updated` payload is `{ threadId, name, status, error, failureReason }`, with readiness arriving after `thread/started`; do not make the existing pre-thread probe a strict gate. A gate belongs after `thread/start`/`thread/resume` resolves and before the session-ready update at `codexAppServerManager.startSession.ts:303`. Implement the readiness lifecycle contract below after verifying the installed runtime supplies the required thread-scoped signal on both start and resume. If it does not, document and verify an alternative current-status API before enabling the strict gate. Explicit failed status must take precedence over cached tools. Failure should use existing startup-error cleanup; local-only sessions retain their existing fallback. This design confirmation is a separate hardening readiness blocker and is not required to demonstrate the narrow protocol defect.
5. **Cover readiness and document recovery.** Extend `Adapter.test.ts` for remote versus local required-server lists and `codexAppServerManager.startSession.test.ts` for ready, failed, pending/deadline, and unavailable-probe cases. Cover explicit failure with a nonempty tools catalog. Add lifecycle coverage in `codexAppServerManager.startSession.mcp.test.ts` as specified below; helper tests alone cannot prove ordering or cleanup. Verify startup failure uses the existing cleanup path. Keep the existing local compatibility test. For the post-start scenario, manually record the existing `item/completed` failed-tool event and visible `Transport closed` message, and verify the recovery instructions below remain accurate. This plan does not add continuous liveness tracking or change post-start session/UI state. Do not retry a possibly dispatched tool automatically.
6. **Validate and recover deliberately.** Run the commands below in the implementation phase. After the fix is verified, use a fresh/restarted provider session so bigbud regenerates the bridge; changing the template cannot repair an already closed pipe. Coordinate that restart at an idle boundary. Verify `pwd`, `hostname`, and a directory listing through the new remote MCP bridge. Repeatedly calling the old closed transport is not recovery.

### Isolated actual-client experiment

Configure the installed Codex executable in a temporary diagnostic home/session to launch a transparent stdio proxy in front of the generated bridge, using the incident launch runtime. Give the bridge dummy authorization and an isolated loopback HTTP fixture returning harmless results; do not connect it to the live thread-tools endpoint. Keep proxy code, logs, and state outside the checkout. The proxy must preserve framing, serialize writes to the bridge, forward its responses unchanged to Codex, and record redacted direction/timestamp/message-ID and process-exit evidence on a separate channel, never protocol stdout.

After observing Codex's own initialize exchange and initialized notification, have the proxy inject one ID-less roots-change notification into the bridge's stdin. This causes the unpatched bridge's real null-ID response to reach the actual Codex MCP client. Repeat cancellation in a separate fresh diagnostic run. Trigger a harmless bridge tool through Codex before and after injection, using a supported invocation path verified for the installed executable; record whether the second call reaches the fixture, fails with `Transport closed`, or reports another error. If no supported deterministic invocation path is available, stop the causal experiment as inconclusive rather than substituting direct bridge requests as client evidence. Bound each run and clean up its diagnostic processes.

Compare unpatched, patched, and no-injection control runs with otherwise identical configuration. Separate natural Codex notifications from proxy-injected notifications in the evidence. Injection can establish this client's reaction to the defective response, but cannot prove Codex sent that notification in the historical incident. A direct subprocess notification test proves only bridge behavior. Record continued connection, closure, or inconclusive results explicitly; none supplies missing historical evidence by itself.

### Required-bridge readiness lifecycle contract

Own the tracker in each `CodexSessionContext`, with supporting logic in a focused dot-separated module. Install notification capture before `thread/start` or `thread/resume` is sent, and retain early statuses even when the response has not yet supplied the resolved provider thread ID. Key entries by provider thread ID and MCP server name within that context, not the application's thread ID or a global server-name map. After thread-open resolves, select only its returned provider thread ID. Ignore child-thread and other-thread statuses for the gate. On recoverable resume failure, discard the abandoned attempt's entries before starting the fallback; late events for the abandoned provider thread cannot satisfy the new gate. A fresh process/session starts with an empty tracker.

Only an explicit `ready` signal for every required server satisfies this gate; a nonempty tools catalog does not. For a given startup attempt, an explicit failure is terminal and takes precedence over earlier readiness or cached tools. Include the required server name and sanitized failure reason in the startup error. Keep the existing permissive probe policy for local-only sessions. If the optional status probe is unavailable but the required thread-scoped readiness event arrives, the remote gate can succeed; without verified readiness it must fail at the deadline.

Use a named 10-second gate timeout beginning when thread-open resolves, consuming any already-captured statuses immediately. This is a proposed startup policy, not a measured runtime guarantee; validate it against fresh-start and resume smoke timings before rollout and document any adjustment. Thread-open retains its own existing request timeout. Pending or missing readiness at the gate deadline rejects startup with an actionable required-bridge timeout. Process exit, transport closure, or explicit session stop while waiting must settle the waiter promptly and prevent any later `ready` update. Immediately before publishing readiness, verify the context is still the active, non-stopping session and has no terminal startup failure.

On success, failure, timeout, stop, or process exit, dispose the waiter, timers, and startup tracking state. Failure uses existing startup-error handling and `stopSession`; preserve its current error-then-closed lifecycle rather than introducing a new terminal UI state. Existing bridge cleanup may be reached from both manager and adapter paths, so retain idempotence. This tracker ends at startup and does not become continuous health monitoring. The notification handler is currently 394 lines: extract the readiness concern and keep every materially edited source/test file within 400 lines.

### Lifecycle-level readiness regression coverage

Keep parser/probe tests in `codexAppServerManager.startSession.test.ts`. Add `codexAppServerManager.startSession.mcp.test.ts` using the existing process/stream fixture patterns from `.startSession.selection.test.ts` and manager lifecycle tests. Exercise the actual startup function and notification handler together; use manager-level coverage for real stop/exit cleanup, rather than proving cleanup only by stubbing `stopSession`. Split fixture helpers by concern as necessary. Use controlled events and fake timers for deterministic ordering and deadlines.

- Hold the thread-open response, deliver matching readiness early, then resolve it: startup succeeds without losing the event. Resolve thread-open before readiness in another case: neither the returned startup promise nor a ready session/event may complete prematurely.
- Cover successful resume and recoverable resume fallback. A ready event from the abandoned resume, another thread, a child thread, or an old session context must not release the fallback gate; readiness for the returned thread must release it.
- Deliver ready followed by failed before thread-open resolves, and failed status with a nonempty catalog: both reject. Cover optional probe failure with subsequent verified readiness, plus unavailable probe without readiness and pending-until-deadline failures. Preserve local startup's permissive behavior.
- Stop the session or exit the fake child while waiting: startup rejects promptly, emits no later ready update, and removes the session/process resources through existing cleanup. For explicit bridge failure and timeout, assert startup-error reporting and eventual bridge cleanup, allowing its existing asynchronous/idempotent ownership.
- After every outcome, assert no remaining gate timers/waiters and no mutation from late readiness events; a subsequent fresh session must not inherit readiness. Retain adapter tests for local versus remote required-server wiring.

## Validation plan

Repository-defined focused command, from the project root, after implementation:

```sh
bun run --cwd apps/server vitest run \
  src/remote-workspace-bridge/remoteWorkspaceMcpBridge.protocol.test.ts \
  src/remote-workspace-bridge/remoteWorkspaceMcpBridge.identity.test.ts \
  src/codex/codexRemoteWorkspaceBridge.test.ts \
  src/codex/codexAppServerManager.startSession.test.ts \
  src/codex/codexAppServerManager.startSession.mcp.test.ts \
  src/codex/codexAppServerManager.lifecycle.test.ts \
  src/provider/Layers/Codex/Adapter.test.ts \
  src/ws/http.threadTools.remoteWorkspace.test.ts
```

Also run the existing Claude/OpenCode remote bridge tests if the shared generator or public bridge interface changes. Root `AGENTS.md` requires `bun fmt`, `bun lint`, and `bun typecheck` for implementation completion; inspect resulting diffs and preserve unrelated work. Use `bun run test` for broad Vitest coverage, never `bun test`. No Rust changes are planned.

Acceptance criterion 4 requires explicit failure-boundary assertions: in the bridge subprocess tests use isolated local HTTP fixtures for a refused/unreachable endpoint, a `401` authentication error, and a `502` response carrying a remote execution failure. Each actual tool request must return an error with its original ID, followed by a successful `ping`/`tools/list` on the same pipe. In `http.threadTools.remoteWorkspace.test.ts`, stub `runToolCommand` rejection for both selected SSH and remote-agent targets and assert the handler returns its `502`/error message without changing the selected route or replaying the call. This verifies error propagation without requiring a live VPS or injecting failures into the user's connection.

Manual evidence must include an application-created Codex session, not only a hand-launched Node process. Confirm the bridge's actual launch runtime, notification handling, successful subsequent read-only remote tools, a clear remote execution error without MCP disconnection, and a fresh-session recovery. Do not equate a startup catalog with ongoing connection health.

## Risks and rollout

- Notification suppression fixes protocol responses; it does not implement remote cancellation. Preserve honest cancellation semantics and existing replay fencing.
- A strict gate placed before lazy MCP initialization can block every remote session. Determine actual readiness timing and payload before changing startup behavior; this remains an implementation-readiness blocker until verified.
- The shared generator affects several providers. Keep the protocol fix narrow and retain their configuration/identity tests.
- Logs and generated configuration can contain bearer tokens. Record only redacted diagnostics, paths, timestamps, and error classifications.
- Roll out by regenerating bridges in new provider sessions after validation. No SSH configuration change or remote-agent upgrade follows from the current evidence. Rollback should revert only the repair's changes and start a fresh provider session, preserving unrelated work and uncertain remote operations.

## Plan validity and handoff

This plan describes the specified HEAD plus the dirty worktree, not HEAD alone. Relevant existing modifications include the template's instruction wording and direct-SSH/remote-agent routing; the null-ID dispatcher itself is present in the inspected source independently of that wording edit.

Revalidate if the branch/HEAD, relevant worktree contents, generated bridge, Codex runtime/version, launch environment, MCP protocol behavior, or selected remote transport changes. Compare worktree state before and after implementation and do not discard other work.

Settled decisions: documentation only in this turn; save this one Markdown file; preserve all existing work; investigate the bridge before changing VPS/SSH settings; retain invocation identity and no-replay guarantees. No user product decision is needed at this stage.

Remaining verification blockers: execute the actual-client experiment and validate the proposed readiness contract against the installed runtime on start and resume, including the 10-second deadline. The notification repair can proceed independently. The full plan remains Draft until readiness behavior is verified; historical incident causation remains unconfirmed unless evidence establishes it, even if an injected-response experiment reproduces closure.

Review pass 1 (requirements coverage): checked the explanation, saved-document boundary, evidence/confidence distinctions, preservation of existing work, and executable follow-up steps. Review pass 2 (execution readiness): checked file/line references, actual runtime, test commands, lazy startup ordering, protocol compatibility, and no-replay recovery. Corrected the draft to distinguish historical startup success from later transport loss.

Independent read-only review examined the complete supplied plan, root instructions, source excerpts, and runtime findings. Its supported corrections are incorporated: request-shaped notifications cannot invoke work; asynchronous error IDs are covered; coalesced frames are distinguished from batch arrays; failure-boundary checks are explicit; and post-start reporting is bounded to existing behavior and documentation. Re-review confirmed no remaining blocking document corrections and agreed with the Draft classification. The plan remains Draft for the technical blockers listed above, not because any implementation was attempted.

Original investigation workspace verification: HEAD and the tracked diff hash still match the recorded baseline. The only new status entry is this plan file; all 83 pre-existing status entries remain. The plan-only formatting check passes. No implementation, tests, services, or existing sessions were changed.

Review pass 3: specified an actual-client proxy experiment and its evidentiary limits, a thread-scoped startup tracker with resume/stop/exit race handling and a proposed bounded deadline, and lifecycle-level regression tests covering ordering and cleanup. This revision changes the plan only; the proposed experiments and new regression tests have not been executed.
