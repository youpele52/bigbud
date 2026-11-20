# WP-3A: laptop-driven backend deployment and persisted relay profiles

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M2 WP-3A
(decisions 5, 7 and 8)
**State:** Implemented, uncommitted. Unit and integration tested against a local stand-in host. No
VPS run yet.

## What changed

- **Deployment.** The local backend can now deploy the signed backend graph to an approved SSH
  host. RPC `server.setupRemoteBackend` takes `{executionTargetId, requestId, enableBoot}` and
  returns `{profileId, authority, status}`, where status is `"started"` or `"enabled"`.
- **Persisted profiles.** Migration `173_RemoteBackendProfiles` adds the profile directory. On the
  local backend it replaces `RemoteBackendRelayProfilesUnavailable`, so `listRemoteBackendRelayProfiles`
  returns `available` once a deployment succeeds.
- **Relay origin.** For a desktop-mode backend the relay also accepts the packaged renderer origin
  `bigbud://app` (exact match only). The loopback and dev-URL rules are unchanged.

## Deployment flow

1. **Idempotency.** A repeated `requestId` joins the running operation or returns the stored
   profile. Reusing a `requestId` with a different selection is refused with `conflict`. A second
   deployment to a host that is already running one is refused with `busy`. The operation does
   not stop if the caller disconnects, so the caller can re-join with the same `requestId`.
2. **D5 approval.** The existing rule is reused: the host must be a saved remote-agent project, or
   a read-only probe must find a managed build on it. Otherwise the request is refused with
   `approval-required` before any remote command runs. The host's SSH key is then checked against
   known hosts.
3. **Probe (read-only).** Reads the account home through `getent`, the architecture, a hash of the
   SSH host key, and any setup that already finished for this `requestId`. The last item lets a
   retry recover after the laptop lost the reply.
4. **Graph source** (`deployment.source.ts`). The laptop checks the manifest signature against the
   pinned keys before it uploads anything.
   - **Release:** set `BIGBUD_REMOTE_BACKEND_GRAPH_VERSION`. The laptop fetches the
     `<prefix>.manifest.json` and `<prefix>.tar.gz.sha256` assets from
     `github.com/<repo>/releases/download/v<version>/`.
   - **Dev override:** set `BIGBUD_REMOTE_BACKEND_GRAPH_DIR` to a producer output directory. It
     must hold one `*-<target>.tar.gz`, plus a `manifest.json` or `*.manifest.json`. If it has
     `provenance.json`, that pins the archive. Extra public keys come from
     `BIGBUD_REMOTE_BACKEND_GRAPH_TRUSTED_KEYS` (a JSON map) or a CI `*.fixture-public-key.pem`.
     The override is refused when `BIGBUD_DESKTOP_PACKAGED=1`.
   - **Rust manifest and trust:** the Rust manifest and trust store come from the existing
     remote-agent install source loader.
5. **Fetch** (`deployment.fetch.ts`). Files are staged in `~/.bigbud/backend-graphs/.staging-<request>`.
   - The VPS downloads the archive with `curl` (HTTPS only).
   - If that download fails, the laptop streams the pinned archive over SSH stdin instead.
   - The sha256 is checked after the download and again before extraction.
   - After extraction, the Node binary, the backend entry and the relay helper are checked against
     the signed manifest. Only then does anything execute.
   - A single rename publishes `<version>-<target>-<sha16>/` with `graph/`, `manifest.json` and
     `complete`. A mismatch deletes only the staging directory, and earlier installs are never
     touched.
6. **Remote setup** (`deployment.remoteSetup.ts`). Commands run over `ssh/sshCommand.ts`
   `clean-posix` with `StrictHostKeyChecking=yes`, using the graph's own Node:
   - `node bin.mjs backend setup` with `--graph-root`, `--graph-manifest`, and the private
     `--rust-manifest` and `--trusted-keys` files in `~/.bigbud/backend-setup/<request>/`.
     `--backend-home` is `~/.bigbud/backend`, and `--confirm-fresh-setup` is passed.
   - Then `backend start` (when `enableBoot` is false, D8) or `backend enable --confirm-startup`.
   - The pinned identity comes from the immutable `setup-complete-v1` record.
7. **Persist** the profile `rb-<authorityId>`.

## Profile schema (`remote_backend_profiles`)

| Group                 | Fields                                                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and request  | `profile_id` (PK), `request_id` (unique), `execution_target_id`, `label`                                                                                      |
| Pinned authority      | `authority_id` (unique), `key_fingerprint`, `key_epoch`, `installation_fingerprint`                                                                           |
| Host                  | `host_identity` (sha256 of the SSH host public key), `remote_home`                                                                                            |
| Graph                 | `graph_version`, `graph_target`, `graph_archive_sha256`, `graph_manifest_sha256`, `graph_root`, `node_binary`, `node_sha256`, `helper_entry`, `helper_sha256` |
| Startup and timestamp | `boot_enabled`, `created_at`                                                                                                                                  |

The renderer sees only `profileId`, `label`, the authority and the installation fingerprint.

## For the renderer lane (WP-3B)

- **Deploy:** call `server.setupRemoteBackend` (`WS_METHODS.serverSetupRemoteBackend`; contracts in
  `server/remoteBackendDeployment.ts` and `rpc.remoteBackendDeployment.ts`).
  - Generate one UUIDv4 `requestId` per user action, and retry with the same id after a lost reply.
  - Ask for boot startup explicitly (`enableBoot`).
  - Error codes: `approval-required`, `invalid-target`, `unsupported-host`, `host-changed`,
    `conflict`, `busy`, `graph-unavailable`, `hash-mismatch`, `setup-failed` and `unavailable`.
  - The call can take minutes, because it includes the download and Rust staging.
- **Open the window:** call `listRemoteBackendRelayProfiles` again, then open `?backend=<profileId>`.
  No renderer change is needed for listing.

## Findings that need a decision before the live run

- **Fresh setup conflicts with D5 approval.** `backend setup` refuses an account whose
  `~/.bigbud/agent` holds anything besides `account-authority-v1`. That refusal is in
  `localSupervisorService.setup.ts`, after the claim step. A host that is D5-approved through a
  managed build already has agent state there, so setup will likely fail with `setup-failed`
  (state preserved). An adoption path for existing P4 state is needed, or a host that is approved
  only through a saved project and has no agent installed. I did not change setup.
- **Graph trust.** The release graph must be signed by a key in the remote-agent install source
  trust store. The CI workflow uses the same signing key. The release URL assumes the tag
  `v<version>`.
- **Host identity.** It is recorded when the profile is created and checked on later deployments,
  which return `host-changed`. Relay opens rely on `StrictHostKeyChecking=yes` and do not
  re-probe.
- **Updates.** A second deployment to a host that already has a profile is refused with
  `conflict`. Updates are M3.

## Checks

- `bunx oxfmt` and `bunx oxlint` on the 32 changed files (explicit list): clean. All files are
  under 400 lines (largest new file: 226; `server.ts` is 382).
- Typecheck passes for `apps/server`, `packages/contracts` and `apps/web` (the RPC group consumer),
  with no errors.
- Focused vitest: 11 server files with 36 tests, and 2 contracts files with 3 tests, all pass. They
  include:
  - `deployment_refuses_unapproved_host`
  - `profile_pins_authority_and_installation`
  - `repeat_request_is_idempotent`
  - `download_hash_mismatch_preserves_previous`
  - `relay_list_returns_available_after_setup`
  - the migration 173 up test
  - the boot-consent, lost-reply recovery, laptop-upload fallback and host-changed tests
  - the D7 handler refusal test
  - the live layer composition test
  - the `bigbud://app` origin tests
- **Mutation checks:** each of these made a named test fail, and each passed again once the code
  was restored:
  - removing both remote hash checks
  - skipping approval
  - ignoring the persisted request
  - forcing the directory to `setup-required`
  - widening the origin check to any `bigbud:` origin
  - dropping the desktop origin

  Removing only one of the two hash checks is still caught by the other, by design.

- **Pre-existing, unrelated failures on macOS:** `clientRelay.credentials`/`leases` tests need Linux
  (`readClientRelayCredentials` refuses other platforms).

## Live test checklist

1. Use a glibc arm64 or x86_64 VPS approved through a saved project, with no `~/.bigbud/agent`
   state (see the first finding), or add an adoption path first.
2. Start the local backend with either `BIGBUD_REMOTE_BACKEND_GRAPH_DIR` (the M1 producer output)
   plus `BIGBUD_REMOTE_BACKEND_GRAPH_TRUSTED_KEYS`, or with
   `BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH` pointing to a source signed by the same key.
3. Deploy with `enableBoot: false`. Check that:
   - `systemctl --user is-enabled` stays `disabled`;
   - `start` works from the `env -i` SSH environment (no `XDG_RUNTIME_DIR` is passed);
   - the profile is listed;
   - a `?backend=` window binds through the relay.
4. Kill the laptop backend mid-setup, then retry with the same `requestId`. Setup must not run
   twice.
5. Corrupt the pinned `.sha256` and check that the deployment gets `hash-mismatch` and the
   previous install is unchanged. Block `curl` on the VPS and check that the laptop upload
   fallback takes over.
6. In the packaged desktop app, check the relay handshake from the `bigbud://app` origin.
