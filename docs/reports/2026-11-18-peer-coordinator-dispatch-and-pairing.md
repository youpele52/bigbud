# P8 coordinator dispatch, follow, cancel and pairing UX (WP-8D, WP-8E), 2026-11-18

Scope: M6 WP-8D and WP-8E from `docs/plans/2026-11-17-remote-completion-plan.md` (Phase 8 of
`docs/plans/2026-11-13-remote-agent-manual-install-plan.md`). Builds on WP-8A (`25f359aebc`) and
WP-8B/8C (`e312c2fa1f`). Live acceptance (M6 checklist below) has not been run.

## Coordinator dispatcher (WP-8D)

- **Service.** `orchestration-tools/peerDispatch.service.ts` (`PeerDispatchService`,
  `makePeerDispatchService`), with `peerDispatch.delegate.ts`, `peerDispatch.follow.ts`,
  `peerDispatch.cancel.ts`, `peerDispatch.delivery.ts`, `peerDispatch.transport.ts` and
  `peerDispatch.deps.ts`. Composition: `peer-orchestration/peerCoordinator.layer.ts`
  (`PeerCoordinatorLive`, one line in `server.remote.ts`; remote mode only).
- **Dispatch.** The pending row and the exact delegate request are stored first. Requests live
  in the new `peer_dispatch_requests` table, so a re-send is byte-identical. The request key is
  `tool:<sha256(invocation id)>`, so a retried tool call joins the same dispatch. Permissions are
  `intersectPeerPermissions(caller runtime mode, pairing ceiling)`. One follower fiber per
  dispatch is the only writer of outcomes the worker reports:
  - `pending`: persists `send-started`, then sends the delegate. The row is `sent-uncertain`
    before anything reaches the wire.
  - `sent-uncertain`: probes `status` only. A reply naming the child moves it to `accepted`. Only
    an explicit `dispatch-unknown` re-sends the stored request, under the same identity, through
    `recordSendRetry`, which applies only while the row is still `sent-uncertain`. A partition or
    timeout means backoff (1 s doubling to 30 s), then probing again. No second dispatch id is
    ever created.
  - `accepted` moves to `following`, then long-polls `follow` (25 s) until the child is terminal.
  - Definitive worker refusals settle the row. Before acceptance these are grant and authority
    problems, `workspace-unavailable` and `dispatch-conflict`, which move the row to `failed`.
    After acceptance, grant problems and `dispatch-unknown` mean `child-failed`.
- **Results.** Summaries are bounded by the worker and stored on the row. Delivery is a
  `thread.turn.start` into the coordinator thread with command id `peer-result:<dispatchId>`
  and a stable message id. It runs before the row settles, so a crash in between re-delivers on
  resume and the command receipt deduplicates it. A digest conflict counts as already delivered.
  Delivery is retried twice. After that the row still settles and keeps the result for the status
  tool. Only dispatches the worker accepted are delivered: refusals before acceptance already
  reached the caller inline.
- **Restart.** `resume()` walks `listUnsettled` and starts one follower per row
  (`PeerCoordinatorLive` calls it on start).
- **Cancel.** Intent is persisted first:
  - `pending` becomes `cancelled`, because nothing was sent.
  - Any later non-terminal state becomes `cancel-pending`, and the follower is restarted so the
    worker `cancel` goes out at once.
  - A partition keeps the row `cancel-pending`. Only a worker reply settles it: `cancelled`, or
    `completed` / `failed` if the child finished first. An unstarted child (cancel recorded,
    nothing interrupted) stays `cancel-pending` until terminal.
  - `dispatch-unknown` for a never-accepted identity is confirmed as `cancelled`; it is never
    re-sent.
- **Setup errors.** `host-identity-mismatch` and `authentication-refused` from the SSH channel are
  stored per worker as a typed `PeerSetupError`, and that worker's followers stop without
  retrying. The tool result and the settings page show the error. Re-confirming the pin or
  recording a grant calls `kick`, which clears it and resumes probing with status only.
- **Live transport.** `peer-orchestration/peerCoordinator.transport.ts`:
  `ensureCoordinatorPeerKey`, then one `makePeerRelaySshChannels` channel per request, then
  `sendPeerRequest`. Failures are classified from the ssh exit. The key and known_hosts live
  under `<stateDir>/peer-coordinator/`.

## Tool and pairing UX (WP-8E)

- **Tools** (`orchestration-tools/peerTools.shared.ts`, `ThreadPeerTools.ts`):
  - `delegate_to_host` (`task`, optional `title`, `host`, `model`), `peer_dispatch_status` and
    `peer_dispatch_cancel`, through the new `peer` dispatcher entry.
  - Wired into Codex dynamic tools, Copilot, the MCP bridge (Claude, OpenCode and others through
    the `peer` thread-tool action) and Pi. Each passes the stable tool invocation id.
  - The typed unavailable result (`{ ok: false, unavailable: true, error: { code: "grant-missing" } }`)
    is returned when no coordinator is registered (local mode), when no pairing has an active
    grant (awaiting or revoked), and outside remote mode.
  - Dispatches are scoped to the coordinator thread that created them.
- **RPC.** Schema-only contracts in `contracts/server/remotePeer.pairing.ts` and
  `rpc.remotePeer.ts`: a single `server.peerPairing` method with the actions `status`,
  `ensure-key`, `scan-host-key`, `save` (requires `confirmPin: true`), `record-grant`, `revoke` and
  `delete-connection`, behind the owner-only mutation middleware. The handler is in
  `ws/wsRpcHandlers.peerPairing.ts` and the logic in `peer-orchestration/peerPairing.ts`.
- **Persistence.** Migration **178** `PeerPairings` (renumbered from 177 at the coordinator's
  request, because 177 is now `DirectResourceCleanupLinuxArm64`) adds `peer_pairings`, one saved
  connection per worker authority, and `peer_dispatch_requests`.
  - Revoke sets `grant_revoked_at` and keeps the connection and pin, so re-granting reuses them.
  - Deleting the saved connection is separate and never revokes on the worker. It is refused
    while that worker has unsettled dispatches.
  - Changing the workspace, provider, mode or key under an active grant is refused; revoke first.
- **Settings UI.** The "Peer hosts" section in Remote settings
  (`PeerPairingSettingsSection{,.form,.logic}.tsx`):
  - Generates or reuses the coordinator key and shows its fingerprint, public key file and
    public key.
  - Adding a worker scans its host keys. Saving stays disabled until the user picks a key and
    ticks the explicit "I confirm this fingerprint matches the worker" confirmation.
  - Each pairing shows the exact `bigbud peer grant ...` command and has a grant id field.
  - Revoke shows `bigbud peer revoke --authority <W> --grant <id>`.
  - "Delete saved connection" is a separate button.
  - Text is `text-sm`, with `text-xs` for helper text. Status colours: blue running, green
    active, amber awaiting grant or revoked, red setup error.

## Checks

- `bunx oxfmt` and `bunx oxlint` on the 54 changed paths (explicit list): clean, with one oxlint
  performance warning (a spread in a map over at most 64 pairings) left as is. Every changed file
  is at most 400 lines. The largest are `codexThreadDynamicTools.ts` (394) and contracts
  `rpc.ts` (392).
- `bun run --cwd apps/server typecheck`: passes.
- `bun run --cwd packages/contracts typecheck`: passes.
- `bun run --cwd apps/web typecheck`: passes apart from one error in `test/wsRpcHarness.ts`
  (`ProviderProvisioningSetupAuthority` missing from the Effect context). It comes from the WP-5C
  provisioning RPC, not this work.
- Focused vitest: 133 files and 310 tests pass. Coverage:
  - New: `peerDispatch.service.test.ts` (`uncertain_send_never_relaunches`, re-send only after
    `dispatch-unknown`, `restart_resumes_follow`, `lost_result_recovered_by_status`,
    `one_result_delivery_per_identity`).
  - New: `peerDispatch.cancel.test.ts` (`partition_shows_cancel_pending`, unstarted child stays
    `cancel-pending`, cancel before acceptance, typed setup errors never retried, definitive
    refusal).
  - New: `ThreadPeerTools.test.ts` (`tool_unavailable_without_grant`) and `peerPairing.test.ts`
    (`revoke_independent_of_saved_connection`, busy delete).
  - Existing: all migration tests, the WP-8A/8B peer tests, and the Codex, Copilot, MCP bridge,
    Pi, thread-tool HTTP and parity tests. The Copilot tool-list expectation gained the three
    peer tools.
- Browser: `PeerPairingSettingsSection.browser.tsx` (2 tests: the pin is saved only after
  explicit confirmation; revoke keeps the connection and shows the worker revoke command).
- Mutation sanity: six mutations were applied and each failed the suite:
  - status probe replaced by an unconditional re-send;
  - cancel inferred from an unreachable worker;
  - non-stable delivery command id;
  - `resume()` made a no-op;
  - revoked grant treated as active;
  - revoke deleting the saved connection.

  All were restored from backups in a private job directory.

## Notes

- No capability-catalog track was added for the peer tools. The tool descriptions carry the
  guidance.
- The settings page lists dispatch counts but not individual dispatches. The tools are the
  per-dispatch surface.
- Delivery uses `thread.turn.start`, like completion watches. If the coordinator thread rejects
  the turn, the result stays on the row and the status tool still returns it.

## M6 user checklist (coordinator, two workers, two laptops)

1. Provision coordinator C and workers W1 and W2 as remote backends, then connect laptops L1 and
   L2 to C. On C, open Settings > Remote > Peer hosts and click Generate coordinator key. Note the
   fingerprint and `peer_ed25519.pub` path.
2. For each worker, fill in the form and click Scan host key. Compare the fingerprint with
   `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the worker, tick the confirmation, then
   save. Saving must stay disabled until you tick it.
3. Copy `peer_ed25519.pub` to each worker and run the displayed `bigbud peer grant ...`. Paste the
   printed grant id into Record grant. The status shows Active (green).
4. In a C thread, ask the agent to `delegate_to_host` a task to W1, then another to W2. Close both
   laptop clients. Reopen and confirm both results arrived once each in the coordinator thread,
   or that the child shows an explicit approval wait on the worker.
5. Fault injection. Each run must show one child per dispatch on the worker (`bigbud peer list`,
   thread list) and one result message on C.
   - Block SSH from C to W1 before the delegate: the state is `sent-uncertain`. Unblock it: the
     status probe gets `dispatch-unknown` and the same dispatch id is re-sent.
   - Kill ssh after the worker accepts: the status probe recovers the child, and nothing is
     relaunched.
   - Drop a follow reply: the next follow returns the result.
   - Restart C mid-follow: the followers resume and deliver once.
   - Cancel during a partition: the status shows `cancel-pending` until the worker confirms
     `cancelled`, or keeps `completed` if the child finished first.
   - Change W2's host key, or use a wrong pin: a red "Host key mismatch" appears with no retries.
     Re-scan and confirm to resume.
6. Revoke: click Revoke grant for W1. The connection and pin stay, and `delegate_to_host` to W1
   returns `grant-missing` (unavailable). Run the displayed `bigbud peer revoke --grant <id>` on
   W1, then confirm that SSH with the peer key is refused. Record a new grant to re-enable W1.
   Delete saved connection is separate: try it while a W1 dispatch is unsettled (refused), then
   after it settles (removed).
