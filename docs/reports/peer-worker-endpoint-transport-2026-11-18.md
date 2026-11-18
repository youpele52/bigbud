# P8 worker peer endpoint and SSH peer transport (WP-8B, WP-8C), 2026-11-18

Scope: M6 WP-8B and WP-8C from `docs/plans/2026-11-17-remote-completion-plan.md` (Phase 8 of
`docs/plans/2026-11-13-remote-agent-manual-install-plan.md`, decision 10). Builds on WP-8A
(`25f359aebc`). No coordinator dispatch loop, tool or UI yet (WP-8D, WP-8E).

## Worker peer endpoint (WP-8B)

- **Socket.** `remote-backend/peerSocket.ts` prepares `remote-peer.sock`, a third owner-private
  Unix socket beside `remote-backend.sock` and `remote-mobile.sock`, through the shared
  `privateSocket.ts` path (private bind name, 0600, hard-link publication, stale recovery only
  under the backend lock). `RemotePeerSocketLive` binds, seals and serves it; `server.remote.ts`
  gains one merge line, so it exists in remote mode only.
- **Routes.** `remote-backend/peerRoutes.ts` mounts exactly four POST JSON routes:
  `/api/peer/v1/{delegate,status,follow,cancel}`. A global middleware answers 404 for anything else
  (including `/ws`, client RPC, owner and asset paths, query strings and other methods) and 403
  for any request that carries an `authorization` or `upgrade` header or lacks a well-formed peer
  credential, before a handler runs. Bodies are strict-decoded and bounded (192 KiB).
- **Authentication.** `remote-backend/peerAuthorization.ts`. The peer credential is the triple
  `x-bigbud-peer-grant`, `x-bigbud-peer-coordinator`, `x-bigbud-peer-key`, set only by the
  forced-command helper. Admission loads the grant by id (`grant-missing`), requires it to name
  this worker (`authority-mismatch`) and then applies WP-8A `evaluatePeerGrant`: revoked, expired,
  coordinator or key mismatch, action not in the grant, and for delegate the requested
  permissions within the ceiling. Refusals are typed `PeerError` bodies.
- **Delegate.** `peer-orchestration/peerWorker.delegate.ts` maps a dispatch onto the same
  commands `create_thread` uses: `thread.create` with the namespaced command id
  `peer:<coordinator>:<dispatch>` and `thread.turn.start` with `<id>:turn`. Migration 176
  `peer_children` (worker side) records command id, dispatch, coordinator, grant, child thread,
  request digest and creation time. A repeated delegate joins that record and dispatches
  byte-identical commands, so command receipts return the first result: one identity, one child.
  The same identity with a different request or grant is `dispatch-conflict`. The child runs with
  the request's (narrower) runtime mode; the target provider and workspace must sit inside both
  the request's permissions and the grant ceiling; a workspace root with no project is
  `workspace-unavailable` (new `PeerErrorCode`).
- **Status, follow, cancel.** `peerWorker.follow.ts`. Lookups go through
  `peer_children.findForGrant`, so only children created under the caller's grant are reachable;
  anything else is `dispatch-unknown`. Follow is a bounded long poll (at most 25 s). Cancel stores
  cancel intent first (first time kept), then interrupts with the stable command id `<id>:cancel`;
  a finished child keeps its real outcome. Results are bounded to 8192 characters with
  `truncated`.
- **Grant administration.** `remote-backend/peerGrantOwnerRoute.ts` on the authenticated client
  router (`/api/remote-backend/peer-grants`, issue, revoke, list). The worker's local ceiling is
  any provider and mode, but only workspace roots that are existing projects.

## SSH peer transport (WP-8C)

- **Helper.** `remote-backend/peerRelay.entry.ts` and `peerRelay.remote.ts`, built by
  `tsdown.clientRelay.config.ts` as a second, separate, self-contained compilation
  (`dist/remote-peer-relay/remoteBackendPeerRelay.mjs`, Node builtins only, no dynamic loaders).
  Both helpers stay single files, so the laptop's sha256 pin of the client relay entry still covers
  all of its code. argv is exactly `<worker authority> <grant> <coordinator> <sha256:key>`. The
  helper resolves `remote-peer.sock` for that authority (Linux service config, owned single-link
  0600 socket), forwards only `content-type` and `content-length`, sets the credential from argv,
  and refuses non-peer paths, upgrades, chunked bodies and oversized bodies locally.
- **Graph.** `remote-peer-relay/remoteBackendPeerRelay.mjs` is a required closure root in
  `build-remote-backend-graph.producer.ts`, and the stage copies `remote-peer-relay/` into
  `server/remote-peer-relay/`. The loader policy was not refreshed: the helper has no loader sites.
  A full graph build with `--list-loader-sites` was not run (it needs the Node archive and
  network); run it before the next graph release.
- **authorized_keys.** `remote-backend/peerAuthorizedKeys.ts` writes one line per grant:
  `restrict,command="<node> <helper> <worker> <grant> <coordinator> <sha256:fp>" ssh-ed25519 <key>
bigbud-peer:<coordinator>:<grant>`. Paths are limited to a quote-free alphabet. Updates hold
  an exclusive lock file, refuse a symlinked or foreign-owned file, write a private temp file,
  fsync, rename and fsync the directory. They are idempotent, replace any earlier line for the same
  coordinator or key, and refuse when the same key is already authorized without the restriction.
- **CLI.** `bigbud peer grant|revoke|list --authority <worker authority>`
  (`cli/cli.peer.ts`, `cli.peer.client.ts`), owner only through this account's client-socket
  credential. Grant issues in the backend first, then writes the line. Revoke removes the line
  first (cuts SSH even when the backend is down), then revokes the grant; both always run.
- **Coordinator channel.** `remote-backend/peerRelay.ssh.ts` (following `clientRelay.ssh.ts`)
  runs `ssh` with only the dedicated key (`IdentitiesOnly`, `IdentityAgent=none`, `BatchMode`),
  a private single-entry known_hosts file written atomically, `HostKeyAlias=bigbud-peer-<worker>`,
  `StrictHostKeyChecking=yes`, no forwarding, and classifies exits as `closed`,
  `host-identity-mismatch`, `authentication-refused` or `unreachable`.
  `peer-orchestration/peerSshKey.ts` generates or reuses the dedicated ed25519 key in a private
  directory and computes the grant fingerprint (matches `ssh-keygen -E sha256`).
  `peerRelay.request.ts` sends one bounded JSON request over a channel.

## Checks

- `bunx oxfmt` and `bunx oxlint` on the 44 changed paths: clean. Every file is at most 400 lines.
- `bun run --cwd apps/server typecheck`: passes (no errors on the final run).
- `bun run --cwd packages/contracts typecheck` and `bun run --cwd scripts typecheck`: pass.
- Focused vitest, all passing: `peerRoutes.test.ts`, `peerRoutes.delegate.test.ts` (real engine
  on in-memory SQLite), `peerGrantOwnerRoute.test.ts`, `peerRelay.remote.test.ts`,
  `peerRelay.ssh.test.ts` (real non-root `sshd` on 127.0.0.1, skipped when unavailable),
  `peerAuthorizedKeys.test.ts`, `peerSocket.test.ts`, `PeerChildren.test.ts`, plus the WP-8A, client
  socket, client relay, deployment relay, remote server and graph script tests.
- Pre-existing failures not caused by this work: `clientRelay.credentials.test.ts` is Linux-only
  (macOS `/tmp` is a symlink and the platform guard rejects darwin); `ServerShutdownSignal.test.ts`
  expects the `RemoteServerLive` shape that the runtime-update lane changed in `server.ts`.
- Mutation sanity: not passing the requested permissions to admission, letting the helper forward
  a coordinator-supplied grant header, ignoring the request digest on claim, keeping a superseded
  coordinator line, skipping the worker-authority check, `StrictHostKeyChecking=no`, and dropping
  grant scoping from child lookups each failed the suite (the coordinator-rotation case needed a
  new assertion first). All restored.

## Notes for WP-8D and WP-8E

- Coordinator: `ensureCoordinatorPeerKey` then `makePeerRelaySshChannels` and `sendPeerRequest`.
  Map `host-identity-mismatch` and `authentication-refused` to terminal setup errors, never
  retries.
- `status` on an identity the worker never recorded, or whose thread was never created, returns
  `dispatch-unknown`. For `sent-uncertain` that means re-send the same identity. After `accepted`
  it means the grant was superseded or the worker lost state.
- Children are scoped per grant. Re-pairing (a new grant) hides earlier children from the new
  grant, so keep the old grant until its dispatches settle, or add explicit migration later.
- A delegate re-sent after the worker re-issued the grant conflicts (`dispatch-conflict`), because
  the stored grant differs.
- Cancel of a child whose turn has not started records intent but has nothing to interrupt; the
  status keeps `cancelRequested: true`. WP-8D should keep `cancel-pending` until a terminal state.
- WP-8E: the pairing UX needs the worker's pinned host key (`ssh-keyscan` plus explicit user
  confirmation) and must show the `bigbud peer grant` command with the coordinator's public key
  file. Revoke is `bigbud peer revoke --grant <id>` on the worker.

## M6 live checklist (coordinator with two workers, fault injection)

1. Provision coordinator C and workers W1 and W2 (separate VPS accounts, remote backends running).
   On C, generate the peer key; copy only `peer_ed25519.pub` to each worker.
2. On each worker, create the target project, then run
   `bigbud peer grant --authority <W> --coordinator <C> --public-key <file> --workspace <root>
--provider codex`. Confirm `authorized_keys` has exactly one `restrict,command=` line and that
   `bigbud peer list` shows the grant.
3. From C, run the key against each worker with a wrong pinned host key. Expect
   `host-identity-mismatch` and no helper start. Run it with the correct pin and send `status` for
   an unknown dispatch. Expect `dispatch-unknown`.
4. With the peer key, try `ssh -i peer_ed25519 W1 /bin/sh`, port forwarding and the client
   socket. Every attempt reaches only the helper (the forced command), and non-peer paths are 404.
5. Delegate one child to each worker. Disconnect both laptop clients and observe completion, or an
   explicit `waiting` state for approvals.
6. Fault injection, each verifying one child launch and one result per dispatch identity:
   partition before acceptance (block SSH, then restore, then re-send); partition after acceptance
   (kill ssh mid-response, then `status` and re-send return the same child with `replayed: true`);
   lost result (drop the follow reply, then follow again); coordinator restart mid-follow;
   revocation mid-follow (`bigbud peer revoke`: SSH refused and the socket returns
   `grant-revoked`); cancellation during a partition (`cancel-pending` until the worker confirms).
7. Expire a grant (short `--expires-days` or clock skew test) and confirm `grant-expired`.
8. Restart each worker backend and confirm `remote-peer.sock` is republished 0600 and the old one
   is not reused while live.
