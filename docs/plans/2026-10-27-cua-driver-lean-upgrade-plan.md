# Cua Driver lean upgrade: 0.9.1 to 0.38.0 on the existing TypeScript-managed path

**Date:** 27 October, 2026
**Status:** Ready for implementation for the dev path (M0 to M5). M6 (packaged build) is gated on the approvals and decisions in §12 and §15.
**Owner:** bigbud maintainers

## 1. Metadata

- **Created:** 2026-10-27T17:46:00+01:00. **Last modified:** 2026-10-27T17:56:37+01:00.
- **Project root:** `/Users/youpele/DevWorld/bigbud`. **Branch:** `feature/computer-use`. **HEAD:** `c015538b2ad999a1a76fb62186b8d8a3c540d9f8`.
- **Worktree at inspection:** heavily dirty with concurrent, uncommitted work (237 `git status --porcelain` entries: OpenCode V2, terminals, Cursor/ACP leak fix, IPC hardening and the parked supervised computer-use system). The status listing was identical before and after this research. This plan is the only file written.
- **Supersedes for the next step:** the "upgrade" part of [2026-10-25-cua-driver-update-plan.md](2026-10-25-cua-driver-update-plan.md). That plan and its tracker [2026-10-25-cua-driver-update-implementation-status.md](2026-10-25-cua-driver-update-implementation-status.md) stay as the record of the parked supervised design (§10). Nothing here reopens its safety design. This plan only takes the plain upgrade out of it.
- **Related work:** Kanban [v0.3.2 planned additions](bigbud-kanban://1792928468264-dd424016) (the same card the parent plan cites). No separate card exists for the lean re-scope.
- **Evidence notation.** `U/<path>:L` means `https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/<path>#L<L>`, which is the release target of tag `cua-driver-rs-v0.38.0`. Prefixes: `core/` = `libs/cua-driver/rust/crates/cua-driver-core/src/`, `drv/` = `libs/cua-driver/rust/crates/cua-driver/src/`, `mac/` = `libs/cua-driver/rust/crates/platform-macos/src/`, `wf` = `.github/workflows/cd-rust-cua-driver.yml`, `emb` = `libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md`. Repository references are `path:line`. **[V]** means verified from source or metadata. **[I]** means an inference that the implementing agent must confirm at the step named.

## 2. Summary

Move the pinned Cua Driver from 0.9.1 to 0.38.0 and keep it on the existing TypeScript-managed path: the Electron-spawned `serve --embedded` daemon, the `mcp --embedded` proxies, and the legacy (v1) public `computer_use` tool contract. The supervised system stays dormant and its gate stays closed.

The upgrade is small, but it is not just a constant change. Four 0.38 behaviours break or weaken the current path:

1. Flipping the pin silently selects the dormant v2 profile, which stops the daemon from starting.
2. The policy activation probe fails because 0.38 hides denied tools from `tools/list`.
3. After a crash, the daemon cannot respawn: an embedded 0.38 daemon refuses to bind over a leftover socket file.
4. Action results use a new outcome vocabulary.

Every fix is written to work with both 0.9.1 and 0.38.0. Rolling back is then a one-line pin flip.

## 3. Problem

`packages/shared/src/computer-use/selection.ts:37-45` derives the public contract profile from the pin: 0.9.1 gives `legacy`, 0.38.0 gives `v2`. Under `v2` the app behaves as follows:

- `apps/desktop/src/backend/backendRuntimeEnv.ts:21-24` never starts the daemon.
- Every consumer advertises the v2 schema (`orchestrationComputerUseTool.selected.ts:37-58`).
- Desktop requests decode as v2 (`computerUseToolRequest.ts:35-58`) and fail closed with `control_unavailable`, because no supervised port is wired.

The result is that changing `CUA_DRIVER_VERSION` (`packages/shared/src/cua-driver/release.ts:16`) turns computer use off everywhere. Separately, every 0.38 artifact is `null` (`release.v0_38_0.ts:23-27`), so Install refuses to run. **[V]**

## 4. Goals and definition of done

### Dev (first target: macOS arm64, `bun dev:desktop`)

1. The pin is `0.38.0`. The public contract profile is still `legacy`. `resolveSupervisedExecutionGate` returns `{open:false, reason:"legacy-profile"}` even with `BIGBUD_COMPUTER_USE_SUPERVISED_DEV=1`.
2. Settings → Computer use → Install puts a hash-verified 0.38.0 into `~/.bigbud/dev/runtime/cua-driver` and passes activation validation. Status then shows version `cua-driver 0.38.0`, `ready`, source `managed`.
3. The dev manual checklist (§14.3) passes from a real chat: list_apps, list_windows, capture, get_accessibility_tree, click, type, key or hotkey, scroll, drag, launch_app, focus_app, check_permissions, doctor.
4. bigbud's own installed-app paths (`/Applications/bigbud.app`, `~/.bigbud/userdata`, `~/.bigbud/runtime/cua-driver`) are never read or written by the dev path. Driver-owned state is private per base dir (`BIGBUD_CUA_STATE_HOME`) and the 0.38 PID file is private (`--pid-file`); what still stays shared with any Driver instance after that change is the real `HOME` (`~/Applications` discovery, the Driver config `~/.cua-driver/config.json` read but never written, the cursor-theme dir), see R5.
5. Rollback to 0.9.1 in dev works by flipping the pin back and restarting, with no reinstall when a 0.9.1 generation is retained (§11).
6. All focused checks in §14 pass. Every authored or edited code file is at most 400 lines.

### Packaged (later, macOS arm64 first)

7. A rebuilt packaged app bundles the verified 0.38.0 bare binary and policy, starts the embedded daemon and passes the packaged subset of the checklist (§14.4). It must not touch the installed app.

## 5. Non-goals

- Anything in the parked supervised system: the `crates/bigbud-computer-use` guard, owner and worker; the native admission and IPC protocol; the Stop surface and pause latch; app restrictions; delivery preference; episode warnings; the v2 public contract; and Windows or Linux containment.
- The SDK Stage 2 (M7/M8 of the parent plan).
- Exposing any of the 45 new 0.38 tools. The allow list stays at the 17 in `CUA_DRIVER_REQUIRED_TOOLS` (`packages/shared/src/cua-driver/policy.ts:3-21`).
- Typed `target`, `capture_id`, `delivery_mode`, persistent sessions, `--parent-liveness-stdio`, a separate driver HOME, and the scroll-amount clamp. These are follow-ups (§16), not upgrade requirements.
- Windows and Linux runtime qualification. The table entries and code are made compatible, but no machine is available (§8.9).
- Any change to browser automation.

## 6. Current state: how bigbud calls the driver [V]

| Concern               | Where                                                                                                 | What happens today                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pin and tables        | `packages/shared/src/cua-driver/release.ts:10-56`, `release.v0_9_1.ts`, `release.v0_38_0.ts`          | `resolveCuaDriverReleaseArtifact` throws `CuaDriverArtifactUnverifiedError` for a `null` target.                                                                                                                                                                                                  |
| Policy                | `policy.ts:3-44`                                                                                      | YAML `allow.tools` = 17, `deny.tools` = 9, digest `5209…e12b`. It is written next to each version and validated by digest (`cuaDriver.manifest.ts:10-15`).                                                                                                                                        |
| Child env             | `childEnvironment.ts:25-43`                                                                           | Only an allow list of OS keys is inherited, plus `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` and `CUA_DRIVER_RS_UPDATE_CHECK=false`.                                                                                                                                                                  |
| Invocation            | `invocation.ts:9-50`                                                                                  | `serve --embedded --socket <p> --host-bundle-id <id>` and `mcp --embedded --socket <p> --host-bundle-id <id>`, with env `CUA_DRIVER_EMBEDDED=1`, `CUA_DRIVER_HOST_BUNDLE_ID`, `CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS=300`.                                                                          |
| Daemon                | `apps/desktop/src/backend/cuaDriver.daemon.ts:53-222`                                                 | Uses a private `<root>/run/<uuid>/cua.sock` (mode 0700). Readiness is `status --socket` then `health_report`. On unexpected exit it **respawns on the same endpoint** with backoff (87-112).                                                                                                      |
| Runtime selection     | `cuaDriver.ts:162-192`                                                                                | Order: bundled (packaged only; `.app` binary preferred, 33-60) → `active.json` → `previous.json` → legacy `bin/` → `PATH` (dev only) → missing. Pointers carry no version. Status matches `--version` text against the pin (246-283).                                                             |
| Install               | `cuaDriver.install.ts:151-229`                                                                        | curl → SHA-256 → extract → copy only the bare binary into `versions/<pin>-<os>-<arch>-<uuid>/bin`, plus `CuaDriver.app` if `appPath` is set (unused at runtime) → `manifest` check → activation probe → `active.json` and `previous.json` → keep only active and previous.                        |
| Activation probe      | `cuaDriver.activation.ts:38-118`                                                                      | Starts a validation daemon with `--no-permissions-gate --no-overlay`, calls `health_report`, then requires `kill_app` to be rejected with a message starting `Permission denied:`.                                                                                                                |
| Desktop MCP client    | `cuaDriver.mcpClient.ts:222-308`                                                                      | `initialize` (protocolVersion `2025-06-18` in params, no `_meta`) → `tools/list` → requires all 17 tools and **refuses to call any tool not advertised** (250-258).                                                                                                                               |
| Server MCP client     | `apps/server/src/computer-use/Layers/CuaDriver.ts:65-245`                                             | A persistent `mcp --embedded` child that also requires the 17. Timed-out or interrupted mutations trigger `stop --socket` plus a `status` poll (`CuaDriver.reset.ts`).                                                                                                                            |
| Desktop adapter       | `ComputerUse.desktop.session.ts:10-42`, `.actions.ts`, `.target.ts`, `.observation.ts`, `.results.ts` | Opens a per-action session (`start_session {session, capture_scope:"auto"}`). Flat `pid`/`window_id` fields. Picks the frontmost window by `z_index` (`.target.ts:62-91`). Reads the outcome fields `verified`, `effect`, `path`, `escalation.recommended` (`.results.ts:36-67`).                 |
| Dev runtime isolation | `apps/desktop/src/main.config.ts:48-55`                                                               | `cuaDriverBaseDir` is `<BIGBUD_HOME>/dev` in development. `~/.bigbud/dev/runtime/` **does not exist yet** (checked read-only). The installed app's `~/.bigbud/runtime/cua-driver/active.json` points at 0.9.1.                                                                                    |
| Dev host identity     | `apps/desktop/scripts/electron-launcher.mjs:18-19,63-67`; `cuaDriver.hostIdentity.ts:1-5`             | The dev Electron bundle is patched to `ai.bigbud.desktop.dev`, which matches `--host-bundle-id`.                                                                                                                                                                                                  |
| Packaging             | `scripts/lib/desktop-artifact/cuaDriver.ts:21-105`                                                    | Downloads the pinned archive (universal maps to the arm64 entry), stages `server/cua-driver/bin/<binary>`, `policy/bigbud.yaml` and `CuaDriver.app` if `appPath` is set. Signed mac builds re-sign with `resources/entitlements.mac.plist` (`scripts/lib/desktop-artifact/resources.ts:276-289`). |

## 7. Release and stability [V]

- `gh api repos/trycua/cua/releases/tags/cua-driver-rs-v0.38.0`: published `2026-10-21T05:26:13Z`, target `85e2b13…`, `prerelease: true`, `draft: false`.
- **Every** `cua-driver-rs-v*` release is flagged prerelease, including the currently pinned 0.9.1 (`2026-07-20`, target `683e8b74…`). The repository's "latest" release is a different product (`cua-spaces-v0.16.0`). For this product, the flag does not distinguish stable from unstable.
- No `cua-driver-rs-v0.38.x` above 0.38.0, and no `v0.39`/`v1` tag, exists. Only nightlies exist (`nightly-cua-driver-rs-v0.38.1-nightly.20261027…`), and nightlies are excluded by policy.
- **Conclusion:** 0.38.0 is the latest non-nightly cua-driver-rs release. Its manifest lists 25 fixes and one feature, and none is marked breaking (`release-manifest.json` `changes[].breaking == false`).
- If a newer tag appears before implementation, M2 must re-run this check and stop for a decision rather than auto-upgrade.

## 8. Upstream 0.38.0 findings

### 8.1 Artifacts and hashes (from `SHA256SUMS`, cross-checked with the release API `digest`) [V]

The `SHA256SUMS` downloaded today hashes to `a2c338d608ded32fe3e41918cc571a2769a38fc5a1316bab7d14a9b615590645`, the same value recorded in parent plan §3.2. All five digests below (five distinct archives covering six bigbud targets) match the release API `assets[].digest` and `checksums.txt`.

| bigbud target        | Asset to use                                          | SHA-256                                                            | `binaryPath`         | `appPath` |
| -------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ | -------------------- | --------- |
| darwin arm64 and x64 | `cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz` | `2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732` | `["cua-driver"]`     | `null`    |
| linux arm64          | `cua-driver-rs-0.38.0-linux-arm64-binary.tar.gz`      | `80c9ae66bc7322052dd426c6133c96086b33894bf06c972bca8215384400b33d` | `["cua-driver"]`     | `null`    |
| linux x64            | `cua-driver-rs-0.38.0-linux-x86_64-binary.tar.gz`     | `31ab9709dd91ce73677e49b9f3e75c6f0d3e4d9625c286c9e58262bfbea698dd` | `["cua-driver"]`     | `null`    |
| win32 arm64          | `cua-driver-rs-0.38.0-windows-arm64-binary.zip`       | `d25c8ebfffb34e4c095ea170baf47b87c35dc0d1116f42e46b39df2bcbff8700` | `["cua-driver.exe"]` | `null`    |
| win32 x64            | `cua-driver-rs-0.38.0-windows-x86_64-binary.zip`      | `5edaa74d0afa1b55a9668dbc4f32736507bd2bd4d75b18ca1dc8881bb12402b5` | `["cua-driver.exe"]` | `null`    |

Each asset also has a `.sigstore.json` bundle. Reference only: the probe A archive `darwin-arm64.tar.gz` is `5f71191c…1d72`, and the bare executable extracted from it is `92067848d0eeb9de76929fbd06a137af801b0ff6caedbb3109bd7a6cc84a1f9f`.

### 8.2 Archive layout: what changed from 0.9.1 [V from the workflow source, I for the published bytes]

- **0.9.1 (today):** bigbud uses the darwin directory tarball `cua-driver-rs-0.9.1-darwin-universal/{cua-driver, CuaDriver.app}` (`release.v0_9_1.ts:4-10`). Linux and Windows use the `-binary` archives with the executable at the root.
- **0.38 darwin directory tarballs (`-arm64`, `-x86_64`, `-universal`):**
  - All three carry the _same_ universal binary plus `cua-cursor-theme`, `libcua_driver_sdk.dylib`, `cua_driver_node_runtime.node`, `cua_driver_abi.h`, `CuaDriver.app`, `LICENSE` and notices, under `cua-driver-rs-0.38.0-<label>/` (`U/wf:958-987`).
  - The `-binary` tarball holds the same files at its root, without the `.app` (`U/wf:984-986`).
- **Signing differs between the two binaries.**
  - The bare `cua-driver` is signed with hardened runtime and only the `CuaDriver.entitlements` set. The workflow asserts that it has **no** `com.apple.application-identifier` or `keychain-access-groups` entitlements (`U/wf:767-815`).
  - The `.app` is re-signed **with** those restricted entitlements plus an embedded Cua Team provisioning profile (`U/wf:857-955`). That is new compared with the 0.9.1 workflow, which has no provisioning profile.
- **Linux:** the binary tarball contains `cua-driver`, `cua-cursor-theme`, `libcua_driver_sdk.so`, the node addon, the header and `wayland-helper/` (`U/wf:296-317`).
- **Windows:** the binary zip contains `cua-driver.exe`, `cua-cursor-theme.exe`, `cua-driver-uia.exe`, `cua_driver_sdk.dll`, the node addon and the header, side by side with no wrapper directory (`U/wf:494-499`).
- **Sidecars are not needed at runtime for the 17 tools.**
  - `cua-cursor-theme` is used only by the `cursor-theme` CLI verb (`U/drv/main.rs:218-246`).
  - `cua-driver-uia.exe` has no public client route yet (`U/libs/cua-driver/rust/crates/cua-driver-uia/src/main.rs:1-18`). [I: confirm at M2 that no dynamic library is required; see the `otool -L` step.]
- **Decision (settled here):** use the `-binary` archive on every platform and set `appPath: null`. This gives the same bare, non-restricted-entitlement binary in dev and in packaged builds. It never ships a nested `.app` with another team's provisioning profile. It also downloads 53 MB instead of 85 MB on macOS. The embedded mode below does not need the bundle.

### 8.3 CLI and invocation surface used by bigbud [V]

| bigbud use                                                                                          | 0.38 evidence                                                                                                                                             | Result                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `--version`                                                                                         | probe A: `cua-driver 0.38.0`                                                                                                                              | `version.includes("0.38.0")` still works (`cuaDriver.ts:248`).                                                         |
| `manifest` → `schema_version "1"`, `binary_version`, `binary_path`, `mcp_invocation.args[0]=="mcp"` | `U/drv/cli.rs:182-184,931-937,2010-2025`                                                                                                                  | Compatible with `packages/shared/src/cua-driver/manifest.ts:13-38`.                                                    |
| `serve --embedded --socket --host-bundle-id` (+ `--no-permissions-gate --no-overlay`)               | `U/drv/cli.rs:54-82,765-773,862-881`; `--no-overlay` is consumed by the cursor config (`cli.rs:13,694`)                                                   | Compatible. New optional flags (`--permission-mode`, `--capability-manifest`, `--parent-liveness-stdio`) are not used. |
| `mcp --embedded --socket --host-bundle-id`                                                          | `U/drv/cli.rs:19-37,842-847`; embedded mode never auto-launches `CuaDriver.app` (`cli.rs:1858-1870`)                                                      | Compatible. `mcp` rejects serve-only authorization flags (`cli.rs:797-806`), and bigbud passes none.                   |
| `status --socket`, `stop --socket`                                                                  | `U/drv/serve.rs:2305-2372`; shutdown from any same-uid peer (`serve.rs:662-668,1075-1087`)                                                                | Compatible with `CuaDriver.reset.ts`.                                                                                  |
| MCP handshake                                                                                       | Legacy era when `params._meta` is absent (`U/core/mcp_wire.rs:54-63`). The unknown-tool rejection applies only in the modern era (`mcp_wire.rs:146-181`). | Compatible. bigbud stays on the legacy era.                                                                            |

### 8.4 Policy file (`CUA_DRIVER_POLICY_FILE`, `bigbud.yaml`) [V]

- The env name is unchanged (`U/core/policy.rs:11`). The `allow: {tools}` / `deny: {tools}` YAML shape is unchanged and still deny-by-default (`policy.rs:362-455,498-528`). The bytes and digest therefore stay as they are, and no policy version bump is needed.
- An invalid configured policy is now fatal at startup (`U/core/authorization.rs:1302-1308`; proxy `U/drv/proxy.rs:200-212`).
- **New:** `tools/list` hides every tool the policy does not allow (`U/core/tool.rs:1466-1471`, `policy.rs:313-338`). `kill_app` is therefore no longer advertised.
  - A direct `tools/call kill_app` still returns `isError` with text `Permission denied: user policy: tool 'kill_app' is explicitly denied`. Both proxy and daemon do this (`U/drv/proxy.rs:869-883,990-1009`; `U/drv/serve.rs:497-506`; message format `policy.rs:262-269`).
  - In 0.9.1, `kill_app` was listed and denied with a JSON-RPC `-32603` error (`scripts/fixtures/cua-driver/0.9.1/tools-list.json`, `action-outcomes.json` `denied`).
  - **This breaks the activation probe** (§6) and is fixed in M3.
- **New, not used:** a `CUA_DRIVER_MANAGED_POLICY_FILE` layer (`policy.rs:12`).

### 8.5 Authorization, session and target semantics [V]

- **Permission mode:** an unset `CUA_DRIVER_PERMISSION_MODE` means `standard` (`U/core/authorization.rs:1261-1300`).
  - In standard mode the `desktop_input` and `private_observation` adapters are `Routine`, which maps to `Allow` (`authorization.rs:170-190,428-443,462-477`).
  - `launch_app`, `start_session`, `end_session`, `health_report` and `check_permissions` are in neither adapter.
  - `kill_app` (`process_control`) is denied in standard mode, which is extra protection on top of the policy (`authorization.rs:370,547-563`).
  - `makeCuaDriverChildEnvironment` strips any inherited `CUA_DRIVER_PERMISSION_MODE` or bypass variables. That is existing, preserved behaviour.
- **`check_permissions` with `prompt:true`:** on embedded macOS it is treated as driver-owned and the prompt is ignored (`U/mac/tools/check_permissions.rs:176-178,365-375`; `U/core/tool.rs:1935-1944`). On other platforms it may be refused, but it is never executed as a prompt.
- **Session field:** every closed schema gains `session` (`U/core/tool.rs:610-637`), so bigbud's per-action session label is accepted. A label is rejected only after it has been ended (`U/drv/serve.rs:480-495`). bigbud uses a fresh UUID per action.
- **Typed targets:** without `target`, the legacy flat `pid`/`window_id` are accepted unchanged. A `target` mixed with legacy fields is refused (`U/core/action_target.rs:30-57`). bigbud never sends `target`.
- **Unknown arguments:** these are now refused with `invalid_arguments` (`U/core/tool.rs:208-245,1971-1976`). Every argument bigbud sends is in the 0.38 schemas (`scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json`) for all 17 tools:
  - `start_session {session, capture_scope:"auto"}`: `capture_scope` is deprecated but accepted.
  - `get_window_state {pid, window_id}`: both are required, and both are present (`ComputerUse.desktop.observation.ts:5-9`).
  - `hotkey.keys` has `minItems: 2`, which holds because it is only used when the chord has more than one key (`ComputerUse.desktop.actions.ts:245-256`).
  - `scroll.amount` has a maximum of 50 and is clamped by the driver. That was the same in 0.9.1. bigbud's 1–100 normalization is pre-existing and stays.
  - M4 adds a fixture conformance test so this cannot drift silently.

### 8.6 Result shapes [V]

- **Images and text:** images and text still arrive as MCP `content[]` blocks. `get_window_state` returns the image first, then text with the summary and tree (`U/mac/tools/get_window_state.rs:508-529`), so `firstImage`/`firstText` still work. Refusals are `isError` with text (`scripts/fixtures/cua-driver/0.38.0/contract-fixtures/tool-refusal.json`).
- **New `ActionResult`** (`U/libs/cua-driver/rust/crates/cua-driver-contract/src/outputs.rs:589-716`):
  - `effect ∈ {confirmed, partial, unverifiable, suspected_noop, refused}`.
  - `route ∈ {accessibility, synthetic_events, global_input, system_api, dom, trusted_input}`.
  - `escalation {target ∈ {pixel, foreground, page, session}, reason ∈ {route_unavailable, delivery_failed, effect_unconfirmed, suspected_noop, permission_required}}`.
  - Optional `error` (only with `refused`), `summary`, `hint` and `next_call`. There is **no** `verified` and **no** `path`.
- **What bigbud reads today:** `.results.ts:36-67` keeps `effect` only for the three old literals, and drops `escalation` and the delivery path. A `refused` effect without `isError` would be reported to the model as "Sent …". **This is fixed in M4.**
- **`z_index`:** `list_windows.z_index` may be `null` when the platform cannot observe stacking ("callers must not infer an order from array position"; `live-schema.darwin.json` `list_windows.outputSchema`, from `mac/tools/list_windows.rs`). `.target.ts:79-90` would then pick an arbitrary window when more than one is a candidate. **Fixed in M4.**
- **`check_permissions`:** same fields as before (`U/mac/tools/check_permissions.rs:245-252,490-498`). In embedded mode `screen_recording_capturable` is `null` (`U/emb:394-399`), so bigbud shows two permission rows instead of three (`cuaDriver.permissions.ts:44-51` filters non-booleans). There is no functional break.
- **`health_report`:** same `overall` and `checks[]` contract (`U/core/health_report.rs:44-67,285-305`). New macOS check `windowserver_connection`, which fails only after an observed 1002 error or when running unbundled and not embedded (`U/mac/tools/health_report.rs:24-34,85-116`).

### 8.7 macOS permissions and host identity [V]

- **Embedded mode** (exactly `CUA_DRIVER_EMBEDDED=1`) has three effects:
  - It skips the responsibility-disclaim re-exec (`U/drv/responsibility.rs:25-27`).
  - It opts out of the first-launch permissions gate, so tool calls are not held as `permissions_pending` (`U/mac/permissions/gate.rs:240-257`; `U/drv/main.rs:599,618-632`).
  - It never prompts. TCC attribution goes to the host app (`U/emb:88-107,318`).
- **`bundle_identity`:** now resolves the daemon's **direct parent** application and fails if it differs from `CUA_DRIVER_HOST_BUNDLE_ID` (`U/mac/tools/health_report.rs:135-158,186-232`).
  - In dev the parent is the patched Electron `ai.bigbud.desktop.dev`, spawned directly from the Electron main process (`backendRuntimeEnv.ts` → `cuaDriver.daemon.ts:68-76`).
  - A failure only degrades status, because `bundle_identity` is in bigbud's permission-only set (`cuaDriver.health.ts:10-16,50-59`).
- **TCC caching:** TCC answers are cached per process, so the daemon must be restarted after grants (`U/emb:411-413`). The existing `cuaDriverLifecycle.refresh` already does this (`cuaDriver.lifecycle.ts:32-51`).
- **What is unchanged:** Accessibility and Screen Recording on the host. No new TCC class is needed for the 17 tools. [I: confirm in the §14.3 checklist that no new prompt appears.]

### 8.8 Telemetry and update checks [V]

Neither is off by default upstream.

- Telemetry defaults to enabled unless `DO_NOT_TRACK`, `CUA_DRIVER_RS_TELEMETRY_ENABLED`, `CUA_TELEMETRY_ENABLED`, `CUA_TELEMETRY` or a config turns it off (`U/drv/telemetry.rs:44-45,216-243`).
- Update checks default to enabled for non-prerelease versions unless `CUA_DRIVER_RS_UPDATE_CHECK=false` or a config flag is set (`U/drv/version_check.rs:54,543-557`).
- bigbud already sets both env names on every child (`childEnvironment.ts:35-36`), and both names are still honoured. No change is needed.
- State is shared, not isolated: `~/.cua-driver/` (telemetry markers already exist there from June) and `~/Library/Caches/cua-driver/cua-driver.pid` (`U/drv/serve.rs:358-364`). This is accepted for the lean scope (§13 R5).

### 8.9 Platform comparison

|                                              | macOS (first target)                                                                                         | Windows                                                                                                      | Linux                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Artifact                                     | universal `-binary.tar.gz`                                                                                   | arch `-binary.zip`, exe at root                                                                              | arch `-binary.tar.gz`, binary at root                                                                                                     |
| Endpoint                                     | Unix socket in a private 0700 run dir. Embedded mode refuses a pre-existing path (`U/drv/serve.rs:609-622`). | Named pipe `\\.\pipe\bigbud-cua-<uuid>` with a current-user ACL (`serve.rs:1646-1657`). No stale-file issue. | Same as macOS (Unix socket)                                                                                                               |
| Identity and permissions                     | Host TCC via embedded mode (§8.7)                                                                            | No TCC. `cua-driver-uia.exe` is unused.                                                                      | No TCC. The GNOME Wayland helper (`wayland-helper/`) is a Shell extension installed by the upstream installer, not by bigbud.             |
| Health names outside bigbud's permission set | `windowserver_connection` (new)                                                                              | none new                                                                                                     | `wayland_backend` (new; `U/libs/cua-driver/rust/crates/platform-linux/src/health_report.rs:21-36`), which can mark status repair-required |
| Qualification in this plan                   | dev and packaged, manual                                                                                     | table entry and unit tests only                                                                              | table entry and unit tests only                                                                                                           |

## 9. Does 0.38 require any part of the supervised system?

| Candidate                                           | Required?                           | Evidence                                                                                                                                                                      | Minimal piece instead                                            |
| --------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Authorization, permission mode, capability manifest | No                                  | Standard is the default and allows all 17 without grants (§8.5). Bounded mode is the only one that requires a manifest (`U/core/authorization.rs:1314-1318`).                 | None. Never set mode or bypass env (already stripped).           |
| Persistent caller sessions                          | No                                  | `session` is admitted on every schema. Per-action labels are valid (§8.5).                                                                                                    | None.                                                            |
| Typed targets, capture IDs, observation references  | No                                  | Flat fields still work without `target` (`U/core/action_target.rs:30-44`).                                                                                                    | None.                                                            |
| Stop, pause latch, retirement                       | No                                  | `stop --socket` and the graceful shutdown still work (§8.3).                                                                                                                  | None. The existing reset-after-uncertain-action stays.           |
| Host identity and TCC ancestry                      | No                                  | The embedded direct-parent rule is already satisfied (§8.7).                                                                                                                  | None for dev. Packaged inspection happens in M6.                 |
| App restrictions and egress filtering               | No                                  | 0.38 policy is per tool. Restrictions are a product feature.                                                                                                                  | None.                                                            |
| Embedded socket ownership                           | **Yes, a host fix, not supervised** | `prepare_embedded_socket_path` refuses an existing path (`U/drv/serve.rs:609-622`). bigbud respawns on the same path after an unexpected exit (`cuaDriver.daemon.ts:87-112`). | M3.2: unlink the stale socket the host owns before respawn.      |
| Policy proof on install                             | **Yes, an adapter fix**             | Denied tools are hidden (§8.4).                                                                                                                                               | M3.1: call the probe tool without requiring it to be advertised. |
| Outcome mapping and `z_index`                       | **Yes, adapter fixes**              | §8.6                                                                                                                                                                          | M4.                                                              |

## 10. Handling the parked supervised work

**Recommendation: keep it dormant in place on `feature/computer-use`.** Do not split it to a branch as part of this upgrade. Reasons:

1. Live and dormant code are interleaved through import edges, so a split means editing live files:
   - `selection.ts` imports `tuple.ts`.
   - `orchestrationComputerUseTool.selected.ts` imports `.v2.ts`.
   - `computerUseToolRequest.ts` imports the contracts `computerUseDesktopV2.ts` and `@bigbud/shared/computer-use/v2.request`.
   - `OrchestrationEngine.toolDispatcher.ts:13,138-143` wires `computerUseV2`.
   - `main.bootstrap.ts` calls `computer-use/computerUse.bootstrap.ts`.
   - `apps/desktop/tsdown.config.ts:24` builds the safety preload.
   - `ComputerUseAccessSettingsSection.tsx:19,206` renders `ComputerUseSupervisedSettings`.
   - `scripts/dev-runner.ts:28` imports `dev-runner.computerUse.ts`.
2. After M1 the supervised gate is closed by construction (`profile` is the constant `legacy`).
3. Any branch split or commit needs fresh user approval. It can be done safely after the lean upgrade lands (decision U2).

**Files both efforts touch** (the lean edits must stay minimal and leave dormant code untouched):

- `packages/shared/src/computer-use/selection.ts` and its test
- `packages/shared/src/cua-driver/release.ts`, `release.v0_38_0.ts`, `release.test.ts`
- `packages/shared/src/computer-use/tuple.test.ts` (pin assertion only)
- `apps/desktop/src/backend/backendRuntimeEnv.ts` and its test
- `apps/desktop/src/computer-use/guardProcess.logic.test.ts` (wording only)
- `apps/server/src/computer-use/Layers/ComputerUse.desktop.{results,target}.ts`
- `apps/server/src/orchestration-tools/orchestrationComputerUseTool.selected.test.ts` and `computerUseToolRequest.test.ts` (pin wording only)

**Lean-owned fixture (keep it in any later split of the parked work):** `scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json` and its provenance `README.md`. The lean conformance test `apps/server/src/computer-use/Layers/ComputerUse.desktop.contract038.test.ts` reads it, and `scripts/verify-cua-driver-contract.ts` never overwrites an existing fixture `README.md` (`verify-cua-driver-contract.paths.ts` `cuaDriverContractReadmeTarget`).

**Dormant-only, untouched by this plan:**

- `crates/bigbud-computer-use/**`
- `crates/bigbud-protocol/src/computer_use/**`, plus the `build.rs` and `lib.rs` edits
- `protocol/computer-use/**`
- `Cargo.toml` and `Cargo.lock` edits
- `packages/shared/src/computer-use/{protocol.*,policy.*,v2.*,tuple.ts,surface.ts,schemaSubset.test.helpers.ts}`
- `packages/contracts/src/orchestration/computerUseDesktopV2.ts` and `core/settings.computerUsePolicy.ts`
- `apps/server/src/computer-use/computerUseEpisode*`
- `ThreadComputerUseTools.v2*` and `orchestrationComputerUseTool.v2.ts`
- `apps/desktop/src/computer-use/**` and `apps/desktop/resources/computer-use-safety/**`
- the web `ComputerUse{Supervised*,SafetyStatusRow,AppRestrictionsRow,DeliveryPreferenceRow,DiagnosticsRow}*`
- `scripts/dev-runner.computerUse*`

**Already live under 0.9.1 and worth keeping** (the lean path depends on several of these):

- IPC sender authorization: `window/ipcAuthorization.ts`, every handler, and `rendererWindows.ts`. Note the tracker's open caveat: it has not been verified in a real Electron run. The §14.3 checklist exercises it incidentally.
- Dev runtime and settings isolation (`main.config.ts:48-55`, `backendManager.ts` `cuaDriverBaseDir`).
- The Cursor/ACP process-leak fix (`git/Layers/CursorTextGeneration*`, `provider/acp/*`).
- The behaviour-identical desktop adapter split (`ComputerUse.desktop.*`, `@bigbud/shared/computer-use/{keys,scroll}`).
- The selected-contract consumer module (legacy path verbatim).
- The release-table split.
- The explicit `.ts` import fix for plain-Node scripts (`scripts/node-entrypoints.test.ts`).
- The exact-millisecond limits fix (`ComputerUseAccessSettingsSection.limits.logic.ts`).

## 11. Rollback

- **Design rule:** every M3 and M4 change behaves correctly with both 0.9.1 and 0.38.0 result and CLI shapes. Rollback never needs a code revert.
- **Dev:**
  1. Set `CUA_DRIVER_VERSION` back to `"0.9.1"` (one line, `release.ts:16`) and restart `bun dev:desktop`.
  2. M3.3 makes runtime selection skip a pointer whose recorded version differs from the pin and use `previous.json`. If the retained previous generation is 0.9.1 (seeded in §14.3 step 1), it starts with no download.
  3. Otherwise, Settings → Install fetches 0.9.1.
  4. Re-flipping to 0.38.0 uses the retained 0.38 generation the same way.
- **Packaged:** the pin, binary and policy are baked into each build (bundled-first, `cuaDriver.ts:162-167`). Rollback means reinstalling or rebuilding the previous app version. The 0.9.1 release entry and its `.app` candidate (`cuaDriver.ts:38-49`) are kept so a 0.9.1 rebuild still works.
- **Never during rollback:** delete `~/.bigbud/dev/runtime` by hand, touch the installed app's runtime, or reuse a 0.38 hash for 0.9.1 (or the reverse).

## 12. Assumptions and preconditions

| ID  | Assumption                                                                                             | Evidence or verification                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Downloading and statically verifying the 0.38 artifacts is approved for this upgrade (user statement). | It covers `curl`/`gh release download`, `shasum`, `tar -t`, `unzip -l`, `file`, `lipo -info`, `otool -L` and `codesign -dv`. It does not cover executing the binary.                 |
| A2  | No other session is editing `apps/desktop/src/backend/**` or the server computer-use layers.           | Run 5 of the tracker listed `apps/desktop/src/backend/**` as owned by the Cursor-leak thread. M0 re-checks this, and the user confirms (U3).                                         |
| A3  | The published `-binary` archives match the workflow layout in §8.2.                                    | Verified in M2 by listing archive contents before any table edit.                                                                                                                    |
| A4  | The 0.38 bare binary needs no co-located dynamic library.                                              | M2: `otool -L` (macOS) shows only system libraries. For Linux and Windows, `objdump -p` or `unzip -l` metadata is recorded; if that is not possible on macOS, record "not verified". |
| A5  | Upstream nightlies are excluded.                                                                       | §7                                                                                                                                                                                   |

## 13. Milestones

Each milestone leaves the app working, has its own focused checks and stops at its exit criteria. No commits are made without fresh approval.

### M0: Baseline and coordination (no code)

1. Record `git rev-parse HEAD`, `git status --porcelain | shasum -a 256`, and `git diff --stat` for every file listed in M1–M4. Confirm A2 with the user (U3). If any target file changed since this plan (HEAD `c015538b`), re-read it before editing.
2. Re-run §7 (`gh api repos/trycua/cua/releases?per_page=30`). If a newer non-nightly `cua-driver-rs` tag exists, stop and ask.

**Exit:** the baseline is recorded and file ownership is confirmed.

### M1: Decouple the Driver version from the contract profile (pin stays 0.9.1)

**Files and changes:**

- `packages/shared/src/computer-use/selection.ts`
  - Replace lines 37-45 with `export const selectedComputerUseContractProfile: ComputerUseContractProfile = "legacy";`.
  - Add a doc comment saying that `legacy` now means "TypeScript-managed embedded daemon plus the v1 public tool contract, valid for Driver 0.9.1 and 0.38.0", and that only an explicit, approved supervised cutover may change it. A Driver bump never changes it.
  - Delete `contractProfileForDriver`, `ComputerUseSelectionError` and `LEGACY_COMPUTER_USE_DRIVER_VERSION`, and the now-unused `proposedComputerUseDriver` import. Keep `resolveSupervisedExecutionGate` and `manifestMatchesVerifiedArtifact` unchanged.
  - Update the header comment (lines 9-25) so it no longer says the profile is derived from the pin.
- `packages/shared/src/cua-driver/release.ts:10-14`: correct the comment. Flipping the pin selects the release table only.
- `apps/desktop/src/backend/backendRuntimeEnv.ts:10-15`: correct the comment. Keep the `profile` parameter and its guard.
- Tests:
  - `packages/shared/src/computer-use/selection.test.ts`: replace the mapping test (60-64) with "profile is `legacy` independent of the pin". Add a case: default profile plus `development:true` plus `BIGBUD_COMPUTER_USE_SUPERVISED_DEV=1` gives `{open:false, reason:"legacy-profile"}`.
  - `apps/desktop/src/backend/backendRuntimeEnv.test.ts:21-24`: assert the profile is `legacy` without comparing the pin.
  - Update pin wording only in `guardProcess.logic.test.ts:18`, `orchestrationComputerUseTool.selected.test.ts:50` and `computerUseToolRequest.test.ts:22`.
  - Update the comment in `apps/web/src/components/settings/ComputerUseSupervisedSettings.tsx:11`.

**Checks:**

- `bun run --cwd packages/shared vitest run src/computer-use/selection.test.ts src/computer-use/tuple.test.ts src/cua-driver/release.test.ts`
- `bun run --cwd apps/desktop vitest run src/backend/backendRuntimeEnv.test.ts src/computer-use/guardProcess.logic.test.ts`
- `bun run --cwd apps/server vitest run src/orchestration-tools/orchestrationComputerUseTool.selected.test.ts src/orchestration-tools/computerUseToolRequest.test.ts`
- `bun run --cwd scripts vitest run node-entrypoints.test.ts dev-runner.computerUse.test.ts` (`scripts/package.json` depends on `vitest` and has a `typecheck` script: `bun run --cwd scripts typecheck`)
- Typecheck shared, desktop, server, web, and scripts if it has a typecheck. Run fmt, oxlint and length checks on the changed paths (§14.1).

**Exit:** behaviour is identical under 0.9.1, and tests prove that the profile and gate no longer follow the pin.

### M2: Verify the 0.38.0 artifacts and fill the release table (pin stays 0.9.1)

1. In a fresh empty directory outside the repo (for example `mktemp -d /tmp/cua-038-artifacts.XXXX`), download `SHA256SUMS`, `checksums.txt`, `release-manifest.json` and the five archives in §8.1 with `gh release download cua-driver-rs-v0.38.0 -R trycua/cua -p <name>`.
2. For each asset:
   - Check `shasum -a 256` against the `SHA256SUMS` line **and** the release API `digest` **and** the §8.1 value. Stop on any mismatch.
   - List the contents without extracting into the repo: `tar -tzf` or `unzip -l`.
   - Confirm the `binaryPath` file exists at the archive root.
3. Optional, needs approval A7: `gh attestation verify <asset> --bundle <asset>.sigstore.json --repo trycua/cua`. Record a failure, but treat it as non-blocking only if the user agrees.
4. Extract into the temp directory only. On the darwin binary, run `file`, `lipo -info` (expect `x86_64 arm64`), `otool -L` (expect only `/usr/lib` and `/System` entries), `codesign -dv --verbose=4` (expect Team `YCK386LBJ7`) and `codesign -d --entitlements - --xml` (expect no `com.apple.application-identifier`). Record its SHA-256; it is expected to equal `92067848…1a1f9f` [I]. **Do not execute anything.**
5. `packages/shared/src/cua-driver/release.v0_38_0.ts`:
   - Replace the `null` table with the six target entries from §8.1 (five distinct archives; darwin arm64 and x64 share one object, as in `release.v0_9_1.ts:13`). Each entry carries `archiveName`, `sha256`, `binaryName` and `binaryPath`, with `appPath: null`.
   - Keep `CUA_DRIVER_0_38_0_SOURCE` and `CUA_DRIVER_0_38_0_DARWIN_ARM64_EVIDENCE`, and update the doc comment.
   - Keep the explicit `.ts` relative imports (`scripts/node-entrypoints.test.ts`).
6. `packages/shared/src/cua-driver/manifest.ts:26`: change the error text to `"... does not match the pinned ${CUA_DRIVER_VERSION} contract."`. Update `manifest.test.ts:25` to match.
7. `packages/shared/src/cua-driver/release.test.ts:68-80`: replace the "refuses every 0.38 target" test with exact-entry assertions for all six targets and a URL test (`cuaDriverReleaseUrl` builds `.../cua-driver-rs-v0.38.0/<archive>` once the pin is 0.38 — test via `resolveCuaDriverReleaseArtifactFor("0.38.0", …)`). Keep the 0.9.1 assertions.
8. Write the verification record (hashes, layouts, `otool`/`codesign` output summaries, date) into §17 of this plan.

**Checks:**

- `bun run --cwd packages/shared vitest run src/cua-driver/release.test.ts src/cua-driver/manifest.test.ts src/computer-use/selection.test.ts src/computer-use/tuple.test.ts`
- `bun run --cwd scripts vitest run node-entrypoints.test.ts`
- shared typecheck, plus fmt, oxlint and length on the changed paths.

**Exit:** the 0.38 entries resolve and the pin is still 0.9.1. `selection.test.ts` still shows the gate closed. Its synthetic hashes never match.

### M3: Version-agnostic desktop fixes

1. **Activation probe** (`apps/desktop/src/backend/cuaDriver.mcpClient.ts`, `cuaDriver.activation.ts`):
   - Add `readonly allowUnadvertisedTool?: boolean` to `CuaDriverMcpOptions`. In `validateAvailableTool` (250-258), still require all 17 tools, but skip the "did not advertise `<tool>`" check when the flag is set. Thread the flag through both the persistent and the one-shot paths.
   - `validateCuaDriverActivation` (100-112) passes `allowUnadvertisedTool: true` for `kill_app` only, and keeps the `Permission denied:` prefix rule. Any other error, or a success, fails activation as it does today.
   - Tests:
     - `cuaDriver.mcpClient.test.ts`: a tools list without `kill_app` fails without the flag and sends `tools/call` with it. Add an `isError` result with `Permission denied: user policy: …` text and check that it rejects with that text.
     - `cuaDriver.activation.test.ts`: the probe is called with the flag. Both the 0.9.1-style and 0.38-style denial texts pass. `Unknown tool: kill_app` and a success both fail.
2. **Stale embedded socket on respawn** (`cuaDriver.daemon.ts`):
   - On non-Windows platforms, immediately before the restart `spawnDaemon(state)` (inside the timer at 99-110), `lstat(state.endpoint)`. If it is a socket, unlink it. If the path exists but is not a socket, do not spawn, set `lastError`, and leave the daemon in the degraded/restarting state.
   - Rationale: the endpoint is always inside bigbud's private 0700 run directory (53-62), so bigbud owns it, which is the "owning host must prove and remove its stale socket" rule (`U/drv/serve.rs:609-622`). Initial starts already use a fresh directory. Stop already removes the directory (322-324).
   - Keep it Unix-only. Windows pipes have no file. The 0.9.1 behaviour is unchanged because 0.9.1 removed stale sockets itself.
   - Tests in `cuaDriver.daemon.test.ts`, using a real socket file in a temp directory: a stale socket is removed before respawn, and a non-socket file blocks the respawn.
3. **Version-aware runtime selection, which is what makes rollback quick** (`apps/desktop/src/backend/cuaDriver.ts` is 398 lines, so it must be split):
   - Move `resolveBundledBinaryPath`, `resolveBundledPolicyPath`, `ensureCanonicalPolicy`, `readActivatedRuntime`, `resolveSystemBinaryPath` and `resolveComputerUseRuntime` (33-192) into a new `cuaDriver.runtime.ts`.
   - Point the importers at it directly, with no re-export barrel: `cuaDriver.ts` (`resolveComputerUseRuntimeEnv`, status, doctor), `cuaDriver.daemon.ts:12` and `main.bootstrap.ts:22-29,325`. Move `resolveComputerUseRuntime` out of the existing mocks into a mock of the new module, in `cuaDriver.daemon.test.ts:54-55` and `main.bootstrap.test.ts:57`. Re-check `cuaDriver.doctor.test.ts`, which mocks `./cuaDriver`.
   - `unwrapToolResult` (`cuaDriver.mcpClient.ts:260-275`) already turns an `isError` result into an `Error` carrying its first text block. That is why M3.1 needs only the advertise skip. [V]
   - `readActivatedRuntime` derives the pointer's version from `pointer.runtimeVersion`, or else from `<versionPath>/install-manifest.json` `runtimeVersion` (written at `cuaDriver.install.ts:175-183`). It returns `null` when the version is **known and differs** from `CUA_DRIVER_VERSION`, and keeps today's behaviour when the version is unknown.
   - `cuaDriver.install.ts:206-212` also writes `runtimeVersion: CUA_DRIVER_VERSION` into `active.json`. The bundled, legacy `bin/` and system paths are unchanged; the `--version` status check still flags them.
   - Tests in a new `cuaDriver.runtime.test.ts` (mock `electron` the way `cuaDriver.doctor.test.ts` does):
     - active 0.38 and previous 0.9.1 under pin 0.9.1 selects previous
     - the reverse case
     - an unknown version is accepted
     - both mismatched falls through
     - the policy digest is still enforced
   - Extend `cuaDriver.install.test.ts` for the new pointer field.

**Checks:**

- `bun run --cwd apps/desktop vitest run src/backend/cuaDriver.mcpClient.test.ts src/backend/cuaDriver.activation.test.ts src/backend/cuaDriver.daemon.test.ts src/backend/cuaDriver.runtime.test.ts src/backend/cuaDriver.install.test.ts src/backend/cuaDriver.doctor.test.ts src/backend/cuaDriver.lifecycle.test.ts src/backend/cuaDriver.permissions.test.ts src/backend/cuaDriver.paths.test.ts src/backend/backendRuntimeEnv.test.ts src/main.bootstrap.test.ts`
- desktop typecheck, plus fmt, oxlint and length on the changed paths.

**Exit:** all desktop Cua tests pass under pin 0.9.1, and no file is over 400 lines.

### M4: Version-agnostic server fixes; consumers verified unchanged

1. **Outcome mapping** (`apps/server/src/computer-use/Layers/ComputerUse.desktop.results.ts`). **No contract change:** `ComputerUseActionOutcome` stays as it is (`packages/contracts/src/orchestration/computerUse.ts:245-256`), so rollback and persisted events stay compatible.
   - `actionOutcome` (36-67): keep the 0.9.1 parsing.
     - Map 0.38 `effect:"partial"` to `"unverifiable"`, which is the conservative choice: "capture state before continuing".
     - Map `escalation {target, reason}` to `{recommended}` with `pixel→"px"`, `foreground→"foreground"` and `page→"page"`. Drop `session`. Keep `reason` as given.
     - Never derive `path` from `route`.
   - `callDesktopTool` (98-118): if `structuredContent.effect === "refused"`, fail with `ComputerUseError` whose message is `Desktop tool '<name>' was refused: <error.code>` plus the hint or summary. The model is then never told "Sent …".
   - New test file `ComputerUse.desktop.results.test.ts` covering both vocabularies, refused, partial, escalation mapping and the unchanged 0.9.1 cases. Split into `ComputerUse.desktop.outcome.ts` if `.results.ts` would go over 400 lines.
2. **`z_index` null** (`ComputerUse.desktop.target.ts:62-91`): when more than one candidate remains and the top candidate has no `zIndex`, return `null`. The caller then fails with "No active desktop window could be resolved." Tests go in a new `ComputerUse.desktop.target.test.ts`, covering the macOS case with all `z_index` set (unchanged) and the null-stacking refusal.
3. **Fixture conformance guard:** new `ComputerUse.desktop.contract038.test.ts`. It runs every legacy desktop action through `executeDesktopComputerUse` with a recording fake `CuaDriverShape`. For each recorded call it asserts that every argument key is a property of the tool's `inputSchema` in `scripts/fixtures/cua-driver/0.38.0/live-schema.darwin.json` (read through `new URL(…, import.meta.url)`), and that every required property is present. It does not check numeric ranges (§8.5 scroll).
4. **Consumers** (Codex, Copilot, Pi, OpenCode/Claude/Cursor MCP bridge, HTTP route, capability tracks): **no code changes.** The public contract and result schema are unchanged, and the web renders `computer_use` activities generically (`apps/web/src/lib/toolPresentation.ts`). The regression tests in §14.2 prove this.
5. Do **not** regenerate `apps/server/vitest.unit-files/*.txt`. New test files run in the serial integration project.

**Checks:** the server commands in §14.2, server typecheck, plus fmt, oxlint and length on the changed paths.

**Exit:** the server tests pass under pin 0.9.1, and the conformance test passes against the 0.38 fixture.

### M5: Flip the pin, dev install and manual dev test

1. `packages/shared/src/cua-driver/release.ts:16`: set `CUA_DRIVER_VERSION: CuaDriverKnownVersion = "0.38.0"`.
2. Update the pin-asserting tests:
   - `release.test.ts` (the selected artifact and URL now resolve to 0.38)
   - `tuple.test.ts:40-43` (`driverVersion: "0.38.0"`)
   - `manifest.test.ts:10-14` (use `CUA_DRIVER_VERSION`, not a literal)
   - `selection.test.ts:55-58` (pin 0.38.0, profile still `legacy`)
3. Re-run every focused check from M1 to M4 (§14).
4. Run the §14.3 dev checklist (needs approval A2).

**Exit:** definition of done items 1 to 6 are met.

### M6: Packaged build and packaged test (gated: U1, A4)

1. **Code:** none expected. `stagePackagedCuaDriverRuntime` follows the pin. With `appPath: null` it stages only `server/cua-driver/bin/cua-driver` and `policy/bigbud.yaml`, and `resolveBundledBinaryPath` falls through to the `bin/` candidate (`cuaDriver.runtime.ts`, formerly `cuaDriver.ts:38-50`).
2. **Build** (approval A4). Recommended isolated identity (U1):
   `node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version 0.1.613-beta.1 --keep-stage`
   - A `-beta.N` version selects identity `ai.bigbud.desktop.beta`, base directory `~/.bigbud/channels/beta` and userData `bigbud-beta` (`packages/shared/src/desktopReleaseIdentity.ts:31-55`, `releaseChannel.ts:20`). That is fully separate from the installed stable app.
   - Add `--signed` only with signing approval.
3. **Static checks of the staged and built app:**
   - `Contents/Resources/server/cua-driver/bin/cua-driver` has the M2 SHA-256 (unsigned build) or a valid bigbud signature (signed build).
   - There is no `CuaDriver.app`.
   - The `policy/bigbud.yaml` digest is `5209…e12b`.
   - For signed builds: `codesign -dv --entitlements - --xml` on that binary, and record which entitlements survived re-signing (§13 R7).
   - Notarization succeeds when signed.
4. **Run:** quit the installed app first, because of the Electron single-instance lock. Launch the built `bigbud Beta.app` from the output directory with `open` (LaunchServices, so the app is the responsible process). Grant Accessibility and Screen Recording to "bigbud Beta" (approval A4). Run §14.4.
5. Windows and Linux packaged builds are a later, separately approved step. Their checklist adds the `wayland_backend` health semantics (§8.9).
6. Known M6 work from the prep research ([m6-prep](2026-10-27-cua-driver-lean-upgrade-m6-prep.md)): (a) the default beta socket path is 105 bytes (over the 103 limit): shorten with a hyphen-less UUID and a short socket filename, or use a short beta bigbud home (R6); (b) signed builds re-sign the Cua binary and drop both `device.screen-capture` and `automation.apple-events`: add a Cua-only entitlement hook and verify team and entitlements before notarization (R7); (c) after clicking a non-front window, check `health_report` `windowserver_connection` and `bundle_identity` (R7).

**Exit:** definition of done item 7.

## 14. Testing and validation

### 14.1 Command rules (`CLAUDE.md`)

- Never run `bun test`, root `bun lint`, `bun run test`, `bun typecheck` or `bun fmt` without explicit paths. Workspace-wide checks need fresh approval.
- Per changed path: `bun run fmt <paths>`, `bun run fmt:check <paths>`, `bun run oxlint --report-unused-disable-directives <ts-paths>`.
- Length: `wc -l <paths> | awk '$2!="total" && $1>400 {print; bad=1} END{exit bad}'`.
- Typecheck: `bun run --cwd <packages/shared|apps/desktop|apps/server|apps/web> typecheck`, only for affected packages.
- No Rust is touched, so no cargo commands are run.
- For this plan document itself: `bun run fmt:check docs/plans/2026-10-27-cua-driver-lean-upgrade-plan.md`.

### 14.2 Focused regression set

```sh
bun run --cwd packages/shared vitest run src/cua-driver/release.test.ts src/cua-driver/manifest.test.ts src/cua-driver/policy.test.ts src/cua-driver/invocation.test.ts src/cua-driver/childEnvironment.test.ts src/computer-use/selection.test.ts src/computer-use/tuple.test.ts
bun run --cwd apps/desktop vitest run <the M3 list>
bun run --cwd apps/server vitest run src/computer-use/Layers/ComputerUse.desktop.test.ts src/computer-use/Layers/ComputerUse.desktop.results.test.ts src/computer-use/Layers/ComputerUse.desktop.target.test.ts src/computer-use/Layers/ComputerUse.desktop.contract038.test.ts src/computer-use/Layers/ComputerUse.test.ts src/computer-use/Layers/ComputerUse.browser.test.ts src/computer-use/Layers/CuaDriver.test.ts src/computer-use/Layers/CuaDriver.reset.test.ts src/computer-use/Layers/CuaDriver.framing.test.ts src/computer-use/computerUseSafety.test.ts
bun run --cwd apps/server vitest run src/orchestration-tools/ThreadComputerUseTools.test.ts src/orchestration-tools/ThreadComputerUseTools.activity.test.ts src/orchestration-tools/ThreadComputerUseTools.lifecycle.test.ts src/orchestration-tools/ThreadComputerUseTools.limits.test.ts src/orchestration-tools/orchestrationComputerUseTool.shared.test.ts src/orchestration-tools/orchestrationComputerUseTool.selected.test.ts src/orchestration-tools/computerUseToolRequest.test.ts src/orchestration-tools/codexThreadDynamicTools.test.ts src/orchestration-tools/copilotThreadOrchestrationTools.test.ts src/orchestration-tools/PiOrchestrationBridge.test.ts src/orchestration-tools/orchestrationMcpBridge.test.ts src/orchestration-tools/orchestrationMcpBridge.allowedTools.test.ts src/capabilities/CapabilityCatalog.test.ts
bun run --cwd apps/web vitest run src/components/computer-use/computerUseEnable.test.ts src/components/computer-use/ComputerUseStartupRepair.logic.test.ts
```

Run only the lines relevant to the milestone. Before each Vitest run, confirm that every listed file exists; the tracker records an unscoped run that started when a list was empty.

### 14.3 Manual dev checklist (macOS arm64; approval A2)

1. **Seed a rollback slot before M5:** with pin 0.9.1 and M1–M4 in place, run `bun dev:desktop` → Settings → Computer use → Install. Expect `~/.bigbud/dev/runtime/cua-driver/versions/0.9.1-darwin-arm64-*` and status ready. Run two quick actions (list_windows, capture). This proves the version-agnostic fixes on 0.9.1.
2. Flip to 0.38.0 (M5) and restart. Expect status `incompatible` or `missing`: the active pointer is 0.9.1 and the pin is 0.38. Expect no daemon start with the wrong version.
3. Install. Expect `versions/0.38.0-darwin-arm64-*`, with `active.json` `runtimeVersion` 0.38.0 and `previous.json` pointing at 0.9.1. Expect the activation probe to pass, Doctor to be `ok` or permission-only degraded, and `check_permissions` `source.attribution:"host"` with host `ai.bigbud.desktop.dev`. Confirm `~/.bigbud/runtime/cua-driver` is unchanged (`ls -la`, and compare the `active.json` hash). Record which app received the TCC grants and the `check_permissions` `source.responsible_ppid`; do not cite the host-bundle label alone as proof of attribution. Snapshot `~/.cua-driver` and `~/Library/Caches/cua-driver/` (`ls -laR`) before this step for the step 8 comparison.
4. From a chat with full access, through at least Codex plus one MCP-bridge provider (Claude or OpenCode): list_apps, list_windows, capture (screenshot attachment appears), get_page_info, get_accessibility_tree, focus_app on a running app, launch_app (TextEdit), click, type, key (single key), key chord (hotkey), scroll, drag, wait plus captureAfter, check_permissions, doctor. For each, record the summary text: there should be no "Sent …" for a refusal, and the model should see "could not be verified" for unverifiable or partial results. Check that 0.38's compact `get_window_state` output is still useful for targeting (element tokens and bounds present).
5. **Crash and respawn:** `kill -9` the dev daemon PID (the `cua-driver serve` child of the dev Electron). Expect a respawn within the backoff (allow one retry after `kill -9`), status ready again, and a subsequent action working. This validates M3.2.
6. **Uncertain action reset:** trigger a long `type` (or a drag) and cancel the turn mid-action, then run another action. Expect the reset path (`stop --socket`), a respawn and ready again; 0.38 `stop` may exit 1 if the socket is not released within 2 s, which bigbud tolerates (`allowNonZeroExit` in `CuaDriver.reset.ts`).
7. **Rollback drill:** flip the pin to 0.9.1 and restart. Expect it to be ready immediately from `previous.json` with no download. Flip back to 0.38.0 the same way.
8. **Teardown:** quit the dev app. Expect no `cua-driver` processes left (`pgrep -fl cua-driver` shows only the installed app's, if it is running) and the dev `run/` directory removed. Snapshot `~/.cua-driver` and `~/Library/Caches/cua-driver/` again and diff against step 3: with the private state home and `--pid-file`, bigbud's own runs must not have changed them (what stays shared by design is listed under R5).

### 14.4 Packaged checklist (macOS arm64 beta identity; approval A4)

Run the §13 M6 static checks, then steps 3, 4 (one provider is enough), 5 and 8 of §14.3 against "bigbud Beta". Also confirm that `~/.bigbud/userdata`, `~/.bigbud/runtime/cua-driver` and `~/Library/Application Support/bigbud` are unchanged.

## 15. Risks, approvals and decision gates

| ID  | Risk                                                                                                                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Profile decoupling misses a consumer, so v2 is selected somewhere.                                                                                                                                                    | All consumers take a default from the one constant (§3 grep set). M1 tests assert the constant and the closed gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| R2  | The `-binary` archive layout or linkage differs from the workflow.                                                                                                                                                    | M2 lists contents and runs `otool -L` before any table edit, and stops on a difference.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R3  | 0.38 daemon startup is slower than the 10 s readiness / 12 s backend budget (`cuaDriver.daemon.ts:20`, `backendRuntimeEnv.ts:8`).                                                                                     | Observe in §14.3 step 3. If it exceeds the budget, record it and raise it with the user rather than silently increasing timeouts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R4  | A new `windowserver_connection` (macOS) or `wayland_backend` (Linux) failure marks the runtime repair-required.                                                                                                       | macOS embedded mode passes unless a 1002 error is observed. Linux is unqualified (§8.9). Do not widen the permission-only set without evidence.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| R5  | Shared `~/.cua-driver` and `~/Library/Caches/cua-driver/*.pid` between the dev 0.38 and installed 0.9.1 daemons.                                                                                                      | Addressed in the M3 addendum: every bigbud-launched Driver child gets `BIGBUD_CUA_STATE_HOME` → `CUA_DRIVER_RS_HOME` + `CUA_DRIVER_TELEMETRY_HOME` (both versions honour them), and 0.38 daemons get `--pid-file` inside the private run dir (0.9.1 ignores the flag; its argv is unchanged). Only the carrier `BIGBUD_CUA_STATE_HOME` reaches the backend env; Driver children derive the overrides. `CUA_DRIVER_TELEMETRY_HOME` moves telemetry's own `config.json` and markers (0.38 `telemetry.rs:2253-2254`, 0.9.1 `telemetry.rs:1731-1732`). Still shared by design, because the real `HOME` stays (needed for `~/Applications` discovery): the Driver config `~/.cua-driver/config.json` is still **read** by `load_driver_config`, PiP and cursor motion defaults on both versions (0.38 `platform-macos/src/tools/mod.rs:725-735,915`, `pip-preview/src/lib.rs:21-25`, `cursor-overlay/src/motion_defaults.rs:78-80`; 0.9.1 `tools/mod.rs:216-219,388`), never written (`set_config` is not allowed); the cursor-theme directory; and `run_script`'s HOME read (`script_tool.rs:85-91`, a denied tool). |
| R6  | Dev socket path length: `/Users/<user>/.bigbud/dev/runtime/cua-driver/run/<uuid>/cua.sock` is 89 characters plus the username. macOS `sun_path` holds at most 103.                                                    | Fine for usernames of 14 characters or fewer. This user's dev path is 95 bytes and the stable packaged path 91; the default beta packaged path (`~/.bigbud/channels/beta/...`) is 105 and will not bind. M6 options: a short UUID without hyphens plus a short socket filename, or a short beta bigbud home. Not changed now.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R7  | Signed packaged build: electron-builder re-signs the bare binary with `entitlements.mac.plist` (`resources.ts:276-289`), which lacks `com.apple.security.automation.apple-events` (present upstream, `U/wf:767-815`). | M6 step 3 records the surviving entitlements. Signed electron-builder builds recursively re-sign the Cua binary and drop BOTH upstream `com.apple.security.device.screen-capture` and `com.apple.security.automation.apple-events`, so M6 needs a Cua-only entitlement hook plus team verification. After clicking a non-front window, check `health_report` `windowserver_connection` and `bundle_identity`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| R8  | The parked supervised files keep drifting, or another thread edits a lean target file.                                                                                                                                | M0 baseline. The lean edits are minimal and listed (§10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| R9  | The 0.38 `next_call` and `hint` text suggests tools the agent cannot call (for example `run_steps`).                                                                                                                  | Harmless. The policy denies them, and bigbud exposes only `computer_use`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Approvals needed** (each is separate; none is implied by another):

- **A1:** artifact download and static verification. The user has already approved this.
- **A2:** running `bun dev:desktop`, Settings → Install (this downloads and **executes** the driver validation daemon and daemon, both 0.9.1 for the seed and 0.38), live desktop input in the checklist, and TCC grants to the dev app.
- **A3:** the optional 0.9.1 seed in §14.3 step 1. It is part of A2 if accepted.
- **A4:** the packaged build. Signing and notarization if `--signed` (credentials and Apple network). Running the packaged beta app and granting it TCC.
- **A5:** every commit or push, and any branch split of the parked work.
- **A6:** any workspace-wide check. None is planned.
- **A7:** optional sigstore verification.

## 16. Deferred follow-ups (explicitly out of the lean scope)

- `--parent-liveness-stdio`, so the daemon exits if Electron dies (`U/drv/cli.rs:774-780`).
- Full driver `HOME` isolation: rejected for now, because `list_apps`/`launch_app` discover `~/Applications` through the real `HOME` on both versions (status doc, M3 addendum). `--pid-file` and the state-home overrides landed in M3.
- `DO_NOT_TRACK=1` as a second telemetry off switch.
- Scroll amount clamped to 50 with chunking.
- Forcing `check_permissions` `prompt:false` on Windows and Linux.
- Adding `wayland_backend` semantics after Linux evidence.
- Typed targets and persistent sessions, which belong to the supervised plan.

## 17. Acceptance criteria and verification record

- Definition of done items 1–7 (§4) are met, with the §14 commands recorded as passed or failed with reasons.
- The M2 verification record (hashes, layouts, static inspection) is filled in below by the implementer:
  - Metadata (`SHA256SUMS`, `checksums.txt`, `release-manifest.json`) downloaded to a fresh temp dir on 2026-10-27; `SHA256SUMS` hashes to `a2c338d608ded32fe3e41918cc571a2769a38fc5a1316bab7d14a9b615590645` (matches §8.1). All five archive digests agree across `SHA256SUMS`, `checksums.txt`, `release-manifest.json` and the release API `digest`, and are the values in `release.v0_38_0.ts`.
  - Deviation: no binary archive was downloaded (not approved for this step), so the archive layout (binary at the archive root, `binaryPath: ["cua-driver"]` / `["cua-driver.exe"]`) is taken from the release workflow (`cd-rust-cua-driver.yml` mac L958-986, win L492-499, linux L296-316), not from `tar -t`; `otool -L` and `codesign -dv` were not run. The installer fails safely if the binary is not at that path. To be completed before M5 with the binary download approval (A2).

## 18. Open questions (user decisions)

- **U1, packaged test identity:** build the packaged test as a `-beta.N` version, which is isolated from the installed stable app and needs its own TCC grants (recommended). The alternative is to build the stable identity and quit or share state with the installed app. M6 only.
- **U2, parked supervised work:** keep it dormant in place on `feature/computer-use` (recommended), or split it to its own branch after the lean upgrade lands. A split needs explicit commit approval.
- **U3, file ownership:** confirm that no other session is still editing `apps/desktop/src/backend/**` and `apps/server/src/computer-use/**`, so M1, M3 and M4 can edit them.

## 19. Plan validity

Revalidate this plan if any of the following changes:

- HEAD or the target files in §10 change.
- A new `cua-driver-rs` non-nightly tag appears.
- Any §8.1 hash, or the `SHA256SUMS` hash `a2c338…0645`, changes.
- The dev bundle identity (`electron-launcher.mjs`) changes.
- `childEnvironment.ts`, `invocation.ts` or `policy.ts` change.
- electron-builder signing configuration changes (M6).
- The supervised gate design changes.

Upstream facts are pinned to commit `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19`. Repository facts reflect the dirty worktree at HEAD `c015538b2ad999a1a76fb62186b8d8a3c540d9f8` on 2026-10-27.

## 20. Handoff notes

- **Order:** M0 → M1 → M2 → M3 → M4, all with the pin at 0.9.1 and each independently safe. Then M5 (flip plus dev test), then M6 when U1 and A4 are settled.
- **Settled decisions** (do not reopen without new evidence):
  - The legacy public contract stays and the supervised gate stays closed.
  - `-binary` archives with `appPath: null` on every platform.
  - Every adaptation must work with both 0.9.1 and 0.38.0.
  - No `ComputerUseActionOutcome` contract change.
  - No new tools in the allow list and no policy byte change.
  - No unknown-argument additions such as `target` or `delivery_mode`.
  - No Rust changes.
  - Never touch the installed app or its runtime.
- **Remaining blockers to execution, not to plan readiness:** U3 (needed before M1) and A2 (needed before M5 step 4). For M6: U1 and A4.
- **Independent review:** this planning environment has no subagent tool, so `@agent::plan-reviewer` could not be invoked. Two self-review passes were applied (requirements coverage and execution readiness). An independent read-only review before M1 is recommended.
