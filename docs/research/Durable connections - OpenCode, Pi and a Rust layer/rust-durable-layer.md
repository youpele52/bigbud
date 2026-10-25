# Should bigbud build a Rust layer that holds the WebSocket?

**Recommendation: do not build it.** Confidence: high.

The question was whether a Rust process should terminate the renderer's WebSocket, keep it open across TypeScript freezes and restarts, answer keepalives, buffer or replay from its own cursor, and reconnect upstream. That design is decision D7 in `docs/plans/2026-10-21-connection-resilience-plan.md`. The follow-up question was how to make the agents durable, the way OpenCode's agent and [Pi Durable](https://earendil.com/posts/pi-durable/) do. Those are different problems. The Rust socket answers the first and does not answer the second.

## What Pi and OpenCode actually did

Both durable agents put the durability in the process that runs the agent.

- OpenCode's service daemon admits the prompt, sets a write-ahead claim, and on the next boot asks the model to continue. The SSE connection the client holds is documented as live-only. See `opencode.md`.
- Pi Durable admits the input, checkpoints every task phase, and on the next process calls `harness.resume()`. Watchers attach to the committed view. The post's authors built this in TypeScript and said a Rust port is possible later, not that a socket layer is the harness. The Pi coding agent bigbud runs does not do this. See `pi.md`.

A process that only holds the renderer's socket is on the client side of both designs. In both designs the client is the disposable part.

## What the Rust socket would remove

Measured drops on 21 October 2026 were mostly the TypeScript server freezing its own event loop: synchronous `node:sqlite`, synchronous SSH, and long migrations (`docs/plans/2026-10-21-connection-resilience-plan.md`, "Why the server drops"). A frozen server cannot complete a request. A Rust process that answers a ping while the server is frozen changes the error the renderer sees. The send the user is waiting on still waits.

It would also hide a clean backend restart from the renderer, for the one feed that can be replayed from SQLite (orchestration events). Electron already restarts the backend on the same port, token and URL (`apps/desktop/src/backend/backendManager.ts:86–96`, `:256–264`), and the renderer already resumes from its cursor (`13b90621ba`). The socket gateway would save the user a reconnect, not a lost turn.

It would not keep a Pi turn alive. `pi --mode rpc` aborts when its stdin ends, and that stdin is the TypeScript server, not the renderer. It would not improve OpenCode V2 turns, which already survive a bigbud crash because they run in OpenCode's own daemon.

## What it costs

- An extra hop on every RPC, including the ones that are already local.
- The Effect RPC streams upstream have to be built again after every TypeScript restart. The renderer's socket staying open does not keep those streams.
- A protocol boundary to version between Rust and the TypeScript server.
- A second cursor store. Canonical sequence state is SQLite owned by TypeScript (`docs/plans/2026-08-25-rust-systems-core-plan.md`). Pi Durable's own rule is one owner per storage. A Rust cursor beside that SQLite is a second owner.
- It does not checkpoint a model call or a tool call. That is the work that makes an agent durable, and it has to happen where the provider call is made.

## How this relates to D7 and the background-service plan

D7 already defers the gateway until the freezes are gone and the Rust background-service plan owns backend lifetime. This research agrees, and narrows the reason.

The background-service plan (`docs/plans/2026-10-15-rust-background-service-plan.md`) is the piece that matches OpenCode's daemon and Pi Durable's "one process owns the storage." If that service owns the backend, a crash becomes a fast restart, and it can keep a stdio child such as Pi running because it still holds the pipe. Phase 5 of the connection-resilience plan is that lifetime, not a new protocol. D7, the socket gateway, becomes worthwhile only after that lifetime exists, and only as a way to stop the UI blinking across an announced restart. It is still not the durable agent.

The dormant `TransportHealth` state machine in `crates/bigbud-desktop-supervisor/` is the smaller version of the same idea: link health on the delivery path that already exists (connection-resilience Phase 4). That is worth wiring. It is not a second cursor store and it does not terminate the renderer's socket.

## Alternatives, in the order they pay off

1. **Finish the freezes and the never-give-up reconnect.** Phases 1b, 1 and 2. Another thread is already moving SQLite off the main thread. This removes the drops that were actually measured.
2. **Implement the durable agent bigbud already specified.** Auto-resume Phase 1 and connection-resilience Phase 6: admit the attempt, mark `may-have-been-sent`, reconcile, continue only when no tool was in flight, ask when one was. Borrow Pi Durable's `replay: "safe"` allowlist and its parked-after-N-crashes state (`lessons.md`). This is the OpenCode and Pi Durable lesson.
3. **Own stdio agents from the background service**, so a backend restart does not deliver stdin EOF to Pi. Do this inside that plan, not as a Pi-only supervisor.
4. **Wire the supervisor's link health** (Phase 4) so a stall is reported as a stall.
5. **A durable-stream protocol on the existing server** would reimplement the cursor replay bigbud already has. Pi Durable and OpenCode both declined log replay for their agent clients. There is nothing to copy.

## What would change the answer

Build the gateway later, inside the background-service plan, only if all three are true:

- Phase 1b has removed the event-loop freezes, and Phase 0 data shows the remaining disconnects are process death or restart, not stalls.
- The background service already restarts the backend behind a stable port, and the UI still drops in a way users feel during that announced restart.
- The agent turns in question are already checkpointed, so the only loss is the renderer's subscription, not the work.

If a provider still loses the turn when the socket drops, the gateway will not fix it. The fix is the checkpoint and the process owner.

If the Pi coding agent starts running on Pi Durable, revisit the Pi adapter only. As of `@earendil-works/pi-coding-agent` 1.3.0 it does not, and the post says that replacement is not the plan. Do not block on it.

## If those conditions are met later

1. The background service publishes `backend restarting` and `backend ready` on the existing bridge. The renderer keeps its cursor in `localStorage`. No new store.
2. Only then, a Rust listener on the stable port answers keepalives and replays orchestration batches from the TypeScript server's SQLite sequence, read through the server, not from a Rust copy.
3. Other feeds (terminal, git status, server lifecycle) stay live-only until each one has its own resume cursor. A gateway that pretends to hold them will stall or drop them on the upstream restart.

That outline is D7 as already written. It is a UI-continuity project. It is not how OpenCode or Pi made their agents durable.
