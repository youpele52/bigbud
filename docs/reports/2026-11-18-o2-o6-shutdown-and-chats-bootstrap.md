# O-2 and O-6: slow backend stop and repeated Chats bootstrap

**Date:** 18 November 2026. **Base:** `dev` at `31ad97c358`, uncommitted fixes below. Follows
[the M2/M3 live acceptance report](2026-11-18-m2-m3-live-acceptance.md) ("Observations not
fixed": O-2 and O-6).

## O-2: a backend stop waits 20 s for a connected client

**Root cause (confirmed).** Every production listener came from
`NodeHttpServer.layer(Http.createServer, …)` (`apps/server/src/server.platform.ts:21` and `:57`
before the fix). In `@effect/platform-node` 4.0.0-beta.43 (`dist/NodeHttpServer.js`):

- The serve finalizer (`:98`) runs `preemptiveShutdown`. That calls `server.close()` (`:44`) and
  waits for it, for up to `gracefulShutdownTimeout`, which defaults to 20 s (`:53`).
- The request and WebSocket handler fibers live in a child scope (`:86`). That scope closes only
  after the wait.
- Node's `close()` completes only when every accepted connection has ended. It ends idle HTTP
  connections, but never ends an upgraded (WebSocket) socket. Only its handler fiber closes that
  socket, and that fiber is still waiting behind the 20 s timeout.

So one connected client (the laptop watching an update) held every stop for 20 s, past systemd's
`TimeoutStopSec=15`, and systemd sent `SIGKILL`. The shutdown signal (`markServerShuttingDown`)
only sets a flag (`ConnectionDiagnostics.ts:153`), so nothing closed the sockets earlier.

**Why it looked update-specific.** The fast stops in the live run had no client connected. In the
live journal, the slow and fast never-ready trials (pids 19199 and 20479) log the same server-side
messages. The Node report from the stuck runtime shows no TCP or listening handle. It shows one
`pipe` with `peer: null` on the client socket path. That is an accepted connection, not the
listener. The connected client is inferred from this evidence; it was not observed live.

**Local reproduction.** This used the real built `bin.mjs` on macOS, in remote mode, with a scratch
`HOME`. Only a scratch copy of the build was patched, to skip the Linux-only check. The client was
a raw `ws+unix` client on `remote-backend.sock`, and the server was stopped with `SIGTERM`.

| Case                                                      | Before  | After      |
| --------------------------------------------------------- | ------- | ---------- |
| Fresh runtime, no client                                  | 0.09 s  | 0.09 s     |
| Trial-activated runtime (crafted journal), no client      | 0.10 s  | not re-run |
| Fresh runtime, 1 WebSocket client                         | 20.08 s | 0.09 s     |
| Fresh runtime, 3 WebSocket clients                        | —       | 0.10 s     |
| Trial-activated runtime, 1 client (operation `activated`) | —       | 0.09 s     |
| Bisection: the scratch build's grace patched to 7 s       | 7.08 s  | —          |

The exit status is the interrupt-only code (130 on this unmanaged CLI path). The managed-service
teardown maps that to 0 (`bin.serviceTeardown.ts`). No new shutdown errors were logged.

**Fix.**

- The new file `apps/server/src/server.platform.nodeHttp.ts` adds
  `createShutdownAwareHttpServer()`. It tracks upgraded sockets, and its `close()` also destroys
  them. Clients already treat a destroyed socket as a dropped connection and reconnect, which is
  what they got from the `SIGKILL`.
- The same file sets a shared 3 s `gracefulShutdownTimeout`. This also bounds long plain requests,
  such as thread-tool callbacks during an interrupting update.
- `server.platform.ts` uses both for the TCP and Unix listeners. Every production listener is
  built from these two functions: client, mobile, peer and callback.

## O-6: `project.created __chats__` appended on each start

**Root cause (confirmed).** `autoBootstrapWelcome` checked `orchestrationEngine.getReadModel()`
for the built-in Chats project (`serverRuntimeStartup.bootstrap.ts:52-59` before the fix). That is
the startup operational model. `listOperationalProjectRows` limits it to projects with an
operational thread (`ProjectionOperationalStateQuery.sql.ts:114`).

So Chats with no live thread was "missing", and `project.create` was dispatched with a random
command id (`:63`). The decider accepted it against the same partial model.

Locally this reproduced on every start, with no restore needed: 10 starts gave 10 events (stream
versions 0–9). The restore in the live run probably only made the Chats threads non-operational
(inferred).

**Fix.**

- Check the persisted projection instead: `ProjectionProjectRepository.getById`. Migration 022
  seeds this row, and the pipeline catches it up before startup.
- Dispatch with a fixed command id, `server:bootstrap:built-in-chats-project`, and the same fixed
  payload. A repeated dispatch then replays its receipt instead of appending a new event.
- After the fix, a fresh home started three times kept 0 `project.created` events and 1 projected
  Chats row.

## Files

| File                                                                     | Lines |
| ------------------------------------------------------------------------ | ----- |
| `apps/server/src/server.platform.nodeHttp.ts` (new)                      | 46    |
| `apps/server/src/server.platform.nodeHttp.test.ts` (new)                 | 106   |
| `apps/server/src/server.platform.ts`                                     | 75    |
| `apps/server/src/startup/serverRuntimeStartup.bootstrap.ts`              | 164   |
| `apps/server/src/startup/serverRuntimeStartup.bootstrap.chats.test.ts`   | 65    |
| `apps/server/src/startup/serverRuntimeStartup.bootstrap.retired.test.ts` | 44    |
| `apps/server/src/startup/serverRuntimeStartup.test.fixtures.ts` (stub)   | 104   |

## Tests and checks

**Regression tests:**

- `server.platform.nodeHttp.test.ts` times a close of the production Unix listener with a held
  WebSocket: under 1 s.
- The same file checks that a held plain request is bounded by the 3 s grace.
- `serverRuntimeStartup.bootstrap.chats.test.ts` uses real SQLite and the engine. Three starts
  with an idle Chats project append no event. A missing row is created once, even when the
  bootstrap is asked twice.

**Mutations** (backups in a private job directory, restored afterwards):

- `Http.createServer` for the Unix listener: the WebSocket test fails at 3029 ms.
- The old read-model check: the first O-6 test fails (1 event).
- A random command id: the second O-6 test fails (2 events).

**Checks on the 7 changed files:**

- Explicit-path `oxfmt`, `oxfmt --check` and `oxlint`: clean.
- `bun run --cwd apps/server typecheck`: clean.
- Focused Vitest: 17 files (the new tests and the startup, bin teardown, shutdown-signal,
  ownership-shutdown, client-socket and `server.remote.*` suites), 59 passed and 1 todo.
- No Rust changes.

**Not re-verified:** a live systemd stop on a Linux VM. No VM was created, because local
reproduction was enough.
