# CUA Driver 0.9.1 Computer-Use Integration Plan

## Status

Proposed implementation plan.

This document replaces the earlier kanban draft for upgrading bigbud from `cua-driver-rs` 0.6.8 to 0.9.1. It incorporates:

- the exact `cua-driver-rs-v0.9.1` source at commit `683e8b7420d10f37cd935c4b50e335d3fa3855a8`;
- bigbud's current desktop, server, orchestration, contract, browser, and settings implementations;
- the original Hermes Agent CUA integration at commit `f2e3754` and the fixes subsequently added on Hermes main;
- bigbud's reliability, performance, safety, and maintainability requirements.

The prior plan was directionally good, but it was not implementation-ready. The main corrections are:

1. `cua-driver mcp` is a proxy, not the desktop authority. A long-running `cua-driver serve` daemon is mandatory.
2. On macOS, the Electron GUI process—not the Node server child—must own embedded daemon startup so TCC attribution is correct.
3. CUA 0.9.1 uses newline-delimited JSON-RPC over MCP stdio. bigbud's current `Content-Length` framing and `2025-03-26` protocol assumption are incompatible.
4. The current CUA permission parser expects a response shape that 0.9.1 does not return.
5. Several desktop tool mappings are already known to be incompatible with 0.9.1 and should not remain open-ended discovery work.
6. CUA calls need a public `session`, and serialization must cover the complete logical desktop operation—not each individual MCP request.
7. A successful JSON-RPC/MCP exchange is not proof that input changed the UI. `isError`, `verified`, `effect`, `path`, and `escalation` must be retained.
8. `capture_mode: "som"` is deprecated and ignored in 0.9.1.
9. bigbud should not add a telemetry preference in this upgrade. Because bigbud manages the runtime, CUA telemetry and CUA self-update checks will be disabled unconditionally in V1.
10. Foreground delivery will not be retried automatically in the initial upgrade. The driver recommendation will be surfaced truthfully; explicit one-action approval can be added only after the base lifecycle and outcome work is stable.

## Executive decision

Upgrade the packaged and managed native desktop runtime from `cua-driver-rs` 0.6.8 to exactly 0.9.1 while preserving bigbud's existing browser implementations.

The target process model is:

```text
Electron main process
  ├─ resolves and validates the active CUA runtime
  ├─ owns one embedded cua-driver serve daemon
  ├─ owns daemon restart, readiness, shutdown, and runtime activation
  └─ starts the bigbud server with the validated binary and private endpoint

bigbud server process
  ├─ owns one long-lived cua-driver mcp stdio proxy
  ├─ connects that proxy to Electron's private daemon endpoint
  ├─ serializes complete logical desktop operations
  ├─ starts and ends one public CUA session per logical operation
  ├─ enforces bigbud policy before every action
  └─ records truthful transport, effect, screenshot, and terminal activity state
```

This split reuses the current server-side provider-neutral computer-use path while moving only the OS-sensitive daemon responsibility to Electron, where it belongs.

## Fixed product and engineering decisions

These decisions are part of this plan and are not left for implementation-time interpretation.

### Runtime version

- Pin exactly `cua-driver-rs` 0.9.1.
- Do not opportunistically adopt 0.10.0 permission modes, session-policy manifests, protected consent, or `revoke` in this change.
- Keep a follow-up decision record for 0.10.x after the 0.9.1 integration is stable.

### Browser boundary

- Keep `ComputerUse.browser.ts`, `BrowserManager`, and visible Electron browser control as bigbud's browser implementation.
- Do not expose CUA's legacy `page` mutations, typed browser tools, browser profile attachment, downloads, uploads, or browser preparation in this upgrade.
- Do not set `CUA_DRIVER_ENABLE_LEGACY_PAGE_MUTATIONS=1`.

### macOS mode

- Use CUA embedded mode.
- Electron main directly spawns `cua-driver serve --embedded --socket <private-endpoint>`.
- Set `CUA_DRIVER_EMBEDDED=1` and `CUA_DRIVER_HOST_BUNDLE_ID=<bigbud bundle id>` on the daemon and proxy.
- The server must never independently launch an embedded daemon.
- Do not rely on `open -a CuaDriver` discovering an app bundle inside Electron resources or the managed runtime directory.

### Windows and Linux mode

- Electron main also owns `serve` on Windows and Linux.
- This ensures the daemon runs in the same interactive user desktop session as bigbud instead of Session 0, SSH-only context, or a service context.
- Do not install or depend on CUA's Windows Scheduled Task autostart in V1.
- CUA 0.9.1's Windows cross-integrity pipe ACL is not assumed to be same-user isolation. Windows automation remains disabled until Phase 0 proves intended-user/SID restriction or bigbud adds an authenticated local broker.
- Linux support remains preview quality and must distinguish X11 from each supported or unsupported Wayland route.

### Telemetry and update traffic

- Set `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` for every CUA child process.
- Set `CUA_DRIVER_RS_UPDATE_CHECK=false` for every CUA child process.
- Do not add `computerUseDriverTelemetryEnabled` or a telemetry switch in V1.
- bigbud owns CUA runtime updates through its packaged and managed installer paths; the driver must not independently check for or install updates.
- Reconsider telemetry only as a separate product/privacy proposal with accurate wording about content-free pseudonymous installation telemetry.

### CUA public session scope

- Use one public CUA session per logical bigbud desktop operation.
- Generate an opaque session ID such as `bigbud-<random UUID>`; do not use the thread ID as a permanent session ID.
- Call `start_session({ session, capture_scope: "auto" })` after acquiring the global desktop-operation lease.
- Include `session` on every session-aware call.
- Call `end_session({ session })` in finalization on success and failure.
- Keep `capture_scope: "auto"`; do not start directly in desktop scope.
- Do not call `escalate_session` in the base 0.9.1 upgrade.

Per-operation sessions are intentionally conservative. bigbud's public action contract is currently coordinate-based and does not expose cross-call element tokens, so it does not need a long-lived session across multiple model tool calls. If bigbud later adds element-token actions, turn-scoped sessions can be designed with explicit turn identity and cleanup.

### Input delivery escalation

- Initial actions use the driver's default/background delivery.
- Preserve and surface a driver recommendation for `foreground`, `px`, or `page`.
- Do not automatically follow any recommendation in the initial upgrade.
- Do not use `bring_to_front` as the generic escalation mechanism.
- A later phase may support one approved retry with `delivery_mode: "foreground"` after fresh target resolution and a typed one-action user confirmation.
- `px` and `page` remain unsupported recommendations until separately designed.

### Policy authority

- `computerUseSafety.ts` and `ThreadComputerUseTools.ts` remain the application policy authority.
- CUA's 0.9.1 policy file may be used as a static defense-in-depth allowlist for the dedicated bigbud daemon, but it is not the approval system.
- bigbud must validate that the policy file exists before launch because 0.9.1 warns and disables policy enforcement for a missing configured path.
- Do not claim that 0.9.1 provides the protected per-session permission modes introduced in 0.10.0.

## Goals

1. Upgrade all packaged and managed desktop targets to the exact verified 0.9.1 artifacts.
2. Establish one reliable daemon owner and one private local endpoint per running bigbud desktop instance.
3. Replace incompatible MCP framing with the actual 0.9.1 newline-delimited protocol.
4. Keep all providers on bigbud's existing provider-neutral computer-use bridge.
5. Prevent cross-thread or cross-action interleaving on the shared physical desktop.
6. Make timeout, cancellation, daemon failure, and backend restart behavior bounded and predictable.
7. Preserve driver verification/effect outcomes without turning them into permission grants.
8. Ensure every started action receives exactly one truthful terminal activity.
9. Correct platform-specific health and permission reporting.
10. Preserve the existing browser implementation and browser UX.
11. Disable third-party telemetry and self-update traffic by default and in practice.
12. Keep every new or heavily edited non-test TypeScript file at or below 400 lines.

## Non-goals

1. Replacing Playwright or the visible Electron webview with CUA browser tools.
2. Adding unattended desktop-scope automation.
3. Adding automatic foreground retries in the first release.
4. Adding a generic CUA policy editor or exposing Rego/YAML authoring in the UI.
5. Adding CUA recording, trajectory replay, kill-app, update, FFmpeg installation, or browser-profile features.
6. Adding 0.10.x protected permission modes under a 0.9.1 runtime pin.
7. Allowing mobile, browser-hosted, or remote clients to bypass the existing server desktop-mode gate.
8. Treating per-session CUA state as an isolated virtual desktop. All sessions still share the physical screen, pointer, and keyboard.
9. Automatically retrying a mutating input after any timeout, transport error, daemon restart, or ambiguous effect.

## Existing bigbud components to reuse

### Provider-neutral dispatch

Reuse:

- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/orchestration-tools/ThreadOrchestrationToolDispatcher.ts`
- `apps/server/src/orchestration-tools/threadOrchestrationBridge.shared.ts`
- `apps/server/src/orchestration-tools/orchestrationMcpBridge.ts`
- provider-specific bridge adapters for Claude, Codex, Copilot, OpenCode, KiloCode, Pi, Cursor, and Devin

Reason:

All providers already converge on the same bigbud `computer_use` contract. CUA-specific behavior belongs below that shared boundary, not in each provider adapter.

### Safety and runtime authorization

Reuse without duplicating rules:

- `apps/server/src/computer-use/computerUseSafety.ts`
- full-access mutation gate in `apps/server/src/orchestration-tools/ThreadComputerUseTools.ts`
- desktop-mode gate
- desktop enablement setting
- elapsed-time user check-in gate
- target safety revalidation

The adapter may add protocol validation and capability checks, but it must not reimplement password, key-combination, protected-app, or sensitive-target rules.

### Activity and screenshot persistence

Reuse:

- `ThreadComputerUseTools.ts` activity dispatch
- `apps/server/src/attachments/attachmentStore.ts`
- attachment URL conventions
- existing work-log screenshot extraction and timeline rendering

Change the finalization model so failures, timeouts, cancellations, and screenshot persistence failures still produce a terminal activity.

### Desktop runtime installation and resolution

Reuse:

- packaged → managed → explicitly allowed system resolution precedence
- checksum-before-extract behavior
- temporary download/extraction paths
- atomic file replacement concepts
- existing Windows process-tree termination helpers
- existing desktop runtime/permission React Query surface

Replace the unversioned managed target with versioned slots and an atomic active manifest.

### Server/browser split

Reuse:

- `ComputerUse.ts` surface routing
- `ComputerUse.browser.ts`
- `BrowserManager`
- visible browser leasing and renderer command routing

This upgrade should not broaden CUA into the browser path.

## Upstream 0.9.1 contract that bigbud must implement

### Process model

```text
cua-driver serve
  owns desktop state and platform authority
  listens on a Unix socket or Windows named pipe

cua-driver mcp
  speaks newline-delimited JSON-RPC over stdio
  obtains tools from the daemon
  forwards tools/call to the daemon
  fails closed if the daemon is unavailable
```

Default upstream endpoints exist, but bigbud must use an explicit endpoint rather than the shared defaults:

- macOS/Linux: a Unix socket under a per-launch directory in the bigbud runtime tree, protected with restrictive directory permissions;
- Windows: a unique named pipe containing a per-launch random suffix.

The transport has no application bearer-token authentication. The Unix socket can be constrained through its private parent directory, but the pinned Windows daemon creates a cross-integrity pipe ACL that may permit access beyond the current user. A random Windows pipe name is only a secret capability, not same-user authorization.

Therefore:

- never bind or proxy the daemon endpoint onto bigbud's mobile, Tailscale, or web transport;
- never expose the endpoint through renderer IPC or persisted settings;
- apply restrictive filesystem permissions to the Unix parent directory;
- never log the endpoint or random suffix;
- never enable `CUA_DRIVER_RS_MCP_HTTP_PORT`;
- before enabling Windows automation, Phase 0 must prove the shipped pipe is restricted to the intended bigbud user/SID, or bigbud must add an authenticated local ACL-enforcing broker;
- if neither Windows isolation option is available, keep Windows desktop automation unavailable in V1 rather than treating the random pipe name as an adequate security boundary.

### MCP protocol

The server client must implement:

- newline-delimited JSON-RPC 2.0;
- `initialize` with protocol version `2025-06-18`;
- `tools/list` after initialization;
- `tools/call`;
- request ID correlation;
- fragmented and multiple-line buffering;
- a bounded maximum line/message size;
- JSON-RPC error handling;
- MCP result `isError` handling;
- child exit and malformed output handling.

Do not send or expect LSP-style `Content-Length` frames.

### Manifest

Use `cua-driver manifest` to validate:

- `schema_version === "1"`;
- `binary_version === "0.9.1"` for packaged/managed runtimes;
- `binary_path` resolves to the selected executable;
- `mcp_invocation.command` and `mcp_invocation.args` are present.

Use `mcp_invocation` to derive the proxy executable and base arguments. Append bigbud's tested embedded/private-endpoint arguments. Do not treat the manifest subcommand list as exhaustive and do not expect it to describe daemon ownership.

### Public sessions

Use:

- `start_session`;
- `get_session_state` for diagnostics/tests where useful;
- `end_session`.

Do not rely solely on the internal proxy-owned session. The public session scopes capture configuration, agent cursor state, recording ownership, and in-memory overrides.

### Action outcomes

For input actions, normalize these fields from `structuredContent`:

```ts
interface ComputerUseActionOutcome {
  verified?: boolean;
  effect?: "confirmed" | "unverifiable" | "suspected_noop";
  path?: ComputerUseDeliveryPath;
  escalation?: {
    recommended: "px" | "foreground" | "page";
    reason: string;
  };
}
```

Define `ComputerUseDeliveryPath` from the complete Phase 0 outcome-fixture vocabulary, not from an abbreviated handwritten list. The initial 0.9.1 fixture allowlist must include at least:

```text
ax
ax_fg
atspi
cgevent
cgevent_fg
cgevent_hid
hid
key_events
key_events_fg
msaa
pixel
uia
uia_expand_collapse
x11_pixel
x11_xtest_fg
SendInput
SetCursorPos
post_message
```

Include conditionally emitted desktop-scope values such as `wayland_desktop` and `xtest_desktop` only if bigbud later enables that mode. Preserve exact upstream casing. All fields remain optional for forward/backward compatibility. A captured known 0.9.1 path must survive as a typed value; an unrecognized future literal must be retained only in bounded diagnostic JSON.

### Window and desktop scopes

Window scope:

- capture through `get_window_state(pid, window_id)`;
- window-local coordinates;
- background delivery preferred;
- foreground delivery explicit.

Desktop scope:

- capture through `get_desktop_state`;
- screen-absolute coordinates;
- foreground-only input;
- no element-index background action semantics.

V1 uses window scope through `capture_scope: "auto"` and does not escalate to desktop scope.

### Platform health and permissions

Use `health_report` as the cross-platform readiness contract.

Supplement with platform-specific `check_permissions` parsing:

- macOS: `accessibility`, `screen_recording`, `screen_recording_capturable`, and `source.attribution`;
- Linux: X11/Wayland/AT-SPI/session-bus fields;
- Windows: health and interactive-session checks rather than macOS-style TCC assumptions.

Do not continue expecting `structuredContent.permissions: Array<{name, granted}>`.

## Hermes patterns to adapt

### Adopt

1. Manifest-first MCP invocation with a bounded compatibility fallback during development.
2. A single CUA child-environment builder used by manifest, version validation, daemon, proxy, status, doctor, permission, install validation, and reset paths.
3. `structuredContent` as the source of truth, with text parsing only for explicitly supported legacy compatibility.
4. A typed action result that distinguishes transport success from verified effect.
5. Capability discovery through `tools/list` before advertising runtime readiness.
6. One bounded reconnect for non-mutating setup/inspection paths.
7. Per-session approval keys that distinguish background from foreground delivery if foreground support is added later.
8. Structured window parsing that ignores unusable null PID/window entries instead of failing all discovery.
9. Provider-aware screenshot routing where a provider cannot carry image tool results.

### Do not copy

1. Do not leave installer/version subprocesses outside the environment sanitizer.
2. Do not implement a timeout that only times out `proc.wait()` while a blocking stdout read remains unbounded.
3. Do not drop action outcome metadata when adding a post-action screenshot.
4. Do not expose action arguments that the backend ignores.
5. Do not mix a fail-closed routing policy with fail-open integration behavior.
6. Do not treat direct CLI fallback as permission to replay mutations. Restrict fallback to health, manifest, and capture/inspection unless equivalence and idempotency are proven.

## Target module design

### Shared release and process policy

Add explicit subpath exports; do not add a barrel index.

```text
packages/shared/src/cua-driver/release.ts
packages/shared/src/cua-driver/policy.ts
packages/shared/src/cua-driver/childEnvironment.ts
packages/shared/package.json
```

Responsibilities:

- immutable 0.9.1 artifact metadata;
- platform/architecture normalization;
- expected archive, checksum, binary, and app-bundle paths;
- one versioned Bigbud CUA policy source string plus policy version/digest;
- CUA child-process environment construction;
- no Electron or Effect dependencies.

### Electron runtime and daemon ownership

```text
apps/desktop/src/backend/cuaDriver.ts
apps/desktop/src/backend/cuaDriver.install.ts
apps/desktop/src/backend/cuaDriver.paths.ts
apps/desktop/src/backend/cuaDriver.process.ts
apps/desktop/src/backend/cuaDriver.runtime.ts       new
apps/desktop/src/backend/cuaDriver.daemon.ts        new
apps/desktop/src/backend/cuaDriver.health.ts        new
apps/desktop/src/backend/cuaDriver.permissions.ts
apps/desktop/src/backend/backendManager.ts
```

Keep each module below 400 lines. `backendManager.ts` is already near the limit, so add only narrow calls there.

Refactor the existing `cuaDriver.process.ts` first and reuse it as the injectable Electron-side CUA process boundary. Extend it with sanitized-environment spawn, abort-aware completion, bounded line/stdout/stderr capture, platform-safe process-tree termination, and test-injected child dependencies. `CuaDriverDaemonManager` orchestrates this boundary; it must not create a parallel spawn/timeout/termination implementation.

### Server MCP proxy and logical operation ownership

```text
apps/server/src/computer-use/Services/CuaDriver.ts
apps/server/src/computer-use/Layers/CuaDriver.ts
apps/server/src/computer-use/Layers/CuaDriver.protocol.ts   new
apps/server/src/computer-use/Layers/CuaDriver.transport.ts  new
apps/server/src/computer-use/Layers/CuaDriver.session.ts    new
apps/server/src/computer-use/Layers/CuaDriver.outcome.ts    new
```

`CuaDriver.ts` remains layer/service wiring. Protocol parsing, process transport, session orchestration, and result parsing stay separate.

### Desktop action adaptation

`ComputerUse.desktop.ts` is already approximately 400 lines and must be split before adding 0.9.1 behavior.

```text
apps/server/src/computer-use/Layers/ComputerUse.desktop.ts
apps/server/src/computer-use/Layers/ComputerUse.desktop.actions.ts   new
apps/server/src/computer-use/Layers/ComputerUse.desktop.targets.ts   new
apps/server/src/computer-use/Layers/ComputerUse.desktop.results.ts   new
```

### Contracts and activity finalization

```text
packages/contracts/src/orchestration/computerUse.ts
packages/contracts/src/server/ipc.desktopComputerUse.ts
apps/server/src/orchestration-tools/ThreadComputerUseTools.ts
```

Keep the public result backward compatible by making new fields optional.

## Child-process environment policy

Build a minimal allowlist, then add explicit CUA values. Do not clone `process.env` and remove only known provider keys.

Preserve only values required by the OS/runtime:

| Category                                | Examples                                                                                                                            |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Executable/runtime                      | `PATH`, `PATHEXT`, `SystemRoot`, `WINDIR`, `COMSPEC`                                                                                |
| User/temp                               | `HOME`, `USERPROFILE`, `LOCALAPPDATA`, `APPDATA`, `TMPDIR`, `TMP`, `TEMP`                                                           |
| Locale                                  | `LANG`, `LC_ALL`, other required `LC_*` values                                                                                      |
| Linux desktop                           | `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`, `DBUS_SESSION_BUS_ADDRESS`, `XDG_RUNTIME_DIR`, `XDG_CURRENT_DESKTOP`, `DESKTOP_SESSION` |
| macOS launch context                    | required inherited launch-service/session values verified by the compatibility harness                                              |
| Proxy/network, only if product-approved | `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`                                                                                             |

Explicitly set:

```text
CUA_DRIVER_RS_TELEMETRY_ENABLED=false
CUA_DRIVER_RS_UPDATE_CHECK=false
CUA_DRIVER_EMBEDDED=1
CUA_DRIVER_HOST_BUNDLE_ID=<bundle id>
CUA_DRIVER_POLICY_FILE=<verified static policy path>
CUA_DRIVER_RS_SESSION_IDLE_TTL_SECS=<bounded value>
CUA_DRIVER_RS_RECORDING_IDLE_TTL_SECS=<bounded value>
```

Explicitly do not pass provider/API credentials, GitHub tokens, MCP secrets, or bigbud auth tokens unless a demonstrated CUA requirement exists.

Tests must assert the exact environment for every spawn route, including install validation and recovery commands.

## Static CUA defense-in-depth policy

Create one version-controlled policy source in `packages/shared/src/cua-driver/policy.ts`. Export deterministic YAML text, a policy schema/version identifier, and a digest. The compatibility harness, packaged artifact staging, and managed installer must consume that same source—never an ad-hoc test-only copy.

Policy artifact lifecycle:

1. packaged builds write it to `process.resourcesPath/server/cua-driver/policy/bigbud.yaml`;
2. managed installs write it inside the inactive runtime slot at `policy/bigbud.yaml`;
3. `cuaDriver.paths.ts` resolves the active policy path together with the active binary;
4. `install-manifest.json`, `active.json`, and `previous.json` record the policy version and digest;
5. activation and rollback switch the binary and policy atomically as one runtime unit;
6. daemon startup verifies file existence, digest, parseability, and a known denied-tool check before readiness;
7. `CUA_DRIVER_POLICY_FILE` always points to the validated active policy path.

The policy allows only the tools bigbud deliberately uses.

Initial allowlist:

- `list_apps`
- `list_windows`
- `get_window_state`
- `get_accessibility_tree` only if the captured 0.9.1 schema supports bigbud's intended usage
- `get_screen_size` if required by tests
- `get_cursor_position` if required by tests
- `check_permissions`
- `health_report`
- `start_session`
- `get_session_state`
- `end_session`
- `launch_app`
- `bring_to_front` only for the explicit `focus_app` product action
- `click`
- `double_click` only if bigbud adds a distinct action later
- `right_click` only through the existing `button` field
- `drag`
- `scroll`
- `type_text`
- `press_key`
- `hotkey`

Explicit deny/non-allow examples:

- `kill_app`
- `start_recording`
- `stop_recording`
- `replay_trajectory`
- `install_ffmpeg`
- `check_for_update`
- all browser tools
- legacy `page`
- `get_desktop_state`
- `escalate_session`
- raw desktop-scope actions

The compatibility harness must validate that the policy loads successfully and blocks a known denied tool. A missing or invalid policy is a startup failure, not a warning bigbud ignores.

## Detailed implementation phases

## Phase 0 — capture the real 0.9.1 contract

### Purpose

Create a checked-in compatibility artifact so production code is implemented against the exact pinned binary rather than docs, latest-main behavior, or invented schemas.

### Add

```text
scripts/verify-cua-driver-contract.ts
scripts/fixtures/cua-driver/0.9.1/manifest.json
scripts/fixtures/cua-driver/0.9.1/tools-list.json
scripts/fixtures/cua-driver/0.9.1/health-report.<platform>.json
scripts/fixtures/cua-driver/0.9.1/check-permissions.<platform>.json
scripts/fixtures/cua-driver/0.9.1/action-outcomes.json
scripts/fixtures/cua-driver/0.9.1/README.md
```

### Work

1. Download every published artifact and verify the release checksum before execution.
2. Record `--version` and `manifest` output.
3. Start `serve` on an isolated private endpoint with telemetry and update checks disabled.
4. Start `mcp` against that endpoint.
5. Verify newline-delimited `initialize` with protocol `2025-06-18`.
6. Save `tools/list`; validate every required tool and input field.
7. Call `health_report`, `check_permissions`, `start_session`, `get_session_state`, and `end_session`.
8. Capture successful and `isError: true` result envelopes.
9. Capture `effect`, `verified`, `path`, and `escalation` examples.
10. Verify the static policy file blocks a denied tool.
11. Verify `CUA_DRIVER_RS_TELEMETRY_ENABLED=false` suppresses telemetry.
12. Verify `CUA_DRIVER_RS_UPDATE_CHECK=false` suppresses GitHub release checks.
13. On macOS, treat `check_permissions.source.attribution === "host"` only as an embedded-mode diagnostic. In a packaged bigbud integration test, prove Electron main directly spawned the daemon and validate the OS responsibility/TCC attribution chain to the bigbud app through parent-process evidence plus real host-grant behavior. Do not accept `source.attribution` alone as ownership proof.
14. On Windows, prove the daemon runs in the interactive user session and verify the named-pipe ACL/security boundary described above. If it is not restricted to the intended user/SID, keep Windows automation disabled until an authenticated local broker exists.
15. On Linux, record X11 success and structured Wayland failure/support by compositor.

### Gate

Do not begin production lifecycle code until the fixture confirms:

- exact proxy framing;
- exact daemon/proxy arguments;
- required tools and schemas;
- platform health/permission shapes;
- packaged macOS responsibility-chain proof from Electron main, not merely `source.attribution`;
- Windows named-pipe user/SID isolation or a documented V1 disable decision;
- policy loading;
- telemetry/update-check suppression.

## Phase 1 — centralize 0.9.1 release metadata

### Files

- add `packages/shared/src/cua-driver/release.ts`;
- add `packages/shared/src/cua-driver/policy.ts`;
- export `@bigbud/shared/cua-driver/release` and `@bigbud/shared/cua-driver/policy` from `packages/shared/package.json`;
- update `apps/desktop/src/backend/cuaDriver.install.ts`;
- update `scripts/lib/desktop-artifact/cuaDriver.ts`;
- update `apps/desktop/src/backend/cuaDriver.ts`.

### Work

1. Move repository, release tag, version, archive names, checksums, extraction roots, binary paths, and macOS app paths into one pure module.
2. Pin the known 0.9.1 release artifacts:

| Target          | Archive                                          | SHA-256                                                            |
| --------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| macOS universal | `cua-driver-rs-0.9.1-darwin-universal.tar.gz`    | `5dad46515b14dab9d97bd8365a02f42edc09fb7a5b431254af9fef0a1306bfac` |
| Linux x64       | `cua-driver-rs-0.9.1-linux-x86_64-binary.tar.gz` | `bec567cb6c93c486a5501fb0b67ba087d7938b17538d96d9f856768604a19fbc` |
| Linux ARM64     | `cua-driver-rs-0.9.1-linux-arm64-binary.tar.gz`  | `daa02eeb6789f953875c315e4c54d99ea6c51d4ba3228109db347fdbebe89dae` |
| Windows x64     | `cua-driver-rs-0.9.1-windows-x86_64-binary.zip`  | `465224fb8b46ce32db6732c55a36aff9907cfae47a7a3a0173b45f95821df6e1` |
| Windows ARM64   | `cua-driver-rs-0.9.1-windows-arm64-binary.zip`   | `c64787437b4718f24613b99a3c124570f44f23abdc6fc856a868e8d6baed453f` |

3. Test that the macOS archive extraction selects the executable inside `CuaDriver.app` without relying on LaunchServices registration.
4. Define the static Bigbud CUA policy text/version/digest in the shared policy module.
5. Make artifact staging write that policy beside the packaged runtime and make the managed installer write it into every inactive runtime slot.
6. Remove all duplicate version/checksum/policy constants.
7. Make unsupported targets fail with a typed, actionable message.

### Tests

- all target mappings;
- all checksums;
- expected binary, app, and policy paths;
- installer and artifact staging consume the same release/policy sources;
- deterministic policy digest and packaged/managed policy content;
- no stale 0.6.8 or duplicate policy constant remains.

## Phase 2 — introduce versioned managed runtime slots and validation

### Files

- update `cuaDriver.paths.ts`;
- update `cuaDriver.install.ts`;
- add `cuaDriver.runtime.ts`;
- update `cuaDriver.ts` runtime status;
- update `ipc.desktopComputerUse.ts`.

### Managed layout

```text
<BIGBUD_HOME>/runtime/cua-driver/
  downloads/
  versions/
    0.9.1-<platform>-<arch>/
      bin/cua-driver[.exe]
      CuaDriver.app/                 macOS archive content when present
      policy/bigbud.yaml
      install-manifest.json          includes runtime and policy versions/digests
  active.json
  previous.json
  run/
    <launch-id>/
      endpoint metadata
      pid file where supported
```

### Work

1. Download and extract into a new inactive version directory.
2. Verify checksum before extraction.
3. Verify executable permissions.
4. Write the shared policy source into the inactive slot and verify its expected digest.
5. Run `--version` and `manifest` using the sanitized child environment.
6. Require compatible version and manifest schema.
7. Launch an isolated test daemon/proxy with the slot's policy, prove one known denied tool is blocked, and run `health_report` before activation.
8. Write `active.json` atomically only after all runtime and policy checks pass.
9. Keep the previous valid slot and pointer.
10. On failed validation, leave the active pointer unchanged and report the failure.
11. On startup, recover an interrupted install by deleting only unreferenced staging directories.
12. In packaged production, prefer bundled 0.9.1.
13. Permit a system driver only when the explicit environment flag is set and the same manifest/tool compatibility checks pass. Otherwise mark it incompatible and block automation.

### Runtime status contract

Extend desktop runtime status to distinguish:

- `missing`;
- `installed-unvalidated`;
- `incompatible`;
- `starting`;
- `ready`;
- `degraded`;
- `unavailable`.

Include:

- source;
- selected version;
- expected version;
- manifest schema;
- daemon state;
- health summary;
- platform readiness summary;
- last error code/message;
- whether backend restart is required.

Do not expose sensitive endpoint details in the renderer contract.

## Phase 3 — add an Electron-owned daemon manager

### Files

- refactor `apps/desktop/src/backend/cuaDriver.process.ts` and add focused tests;
- add `apps/desktop/src/backend/cuaDriver.daemon.ts`;
- add `apps/desktop/src/backend/cuaDriver.health.ts`;
- add `packages/shared/src/cua-driver/childEnvironment.ts`;
- update `apps/desktop/src/main.ts` with narrow lifecycle calls;
- update `apps/desktop/src/backend/backendManager.ts` with narrow environment integration;
- update `apps/desktop/src/backend/cuaDriver.ts`.

### Shared Electron process boundary

Extend `cuaDriver.process.ts` rather than creating duplicate child-process helpers. It must own:

- sanitized-environment application;
- `shell: false` command/process spawning;
- abort-aware command completion;
- bounded stdout, stderr, and line buffering;
- readiness hooks for long-lived children;
- expected-exit classification support;
- POSIX graceful/forced termination;
- Windows process-tree termination using the existing bigbud pattern;
- injectable spawn/clock dependencies for deterministic tests.

Use this boundary for manifest/version validation, isolated install smoke, daemon, status/stop, health, permissions, and policy validation. The server's long-lived MCP stdio protocol remains server-owned, but it must consume the same shared environment policy.

### Service responsibilities

`CuaDriverDaemonManager` owns:

- selected runtime identity;
- private endpoint generation;
- child environment;
- `serve` child handle;
- readiness polling;
- bounded restart/backoff;
- expected versus unexpected exit classification;
- health state;
- graceful shutdown and forced process-tree termination;
- runtime generation number.

### Startup order

1. Resolve and validate runtime.
2. Create a per-launch private endpoint.
3. Start `serve` from Electron main.
4. Wait for `status` and `health_report` readiness with a bounded deadline.
5. Start the bigbud backend with:

```text
BIGBUD_CUA_DRIVER_PATH=<validated binary>
BIGBUD_CUA_ENDPOINT=<private endpoint>
BIGBUD_CUA_EMBEDDED=1
BIGBUD_CUA_RUNTIME_GENERATION=<monotonic generation>
```

6. The server lazily starts its proxy on the first desktop operation or eagerly validates it during desktop startup, depending on measured startup cost.

### Restart behavior

- Unexpected daemon exit: bounded exponential restart owned by Electron.
- Server/backend exit: daemon may remain alive while Electron restarts the backend.
- Desktop app quit: stop backend first, then stop daemon, then force-kill if necessary.
- Runtime activation: stop backend, stop daemon, switch active runtime, start daemon, restart backend.
- Telemetry/update policy change does not exist in V1, avoiding live environment churn.

### Timeout/reset behavior

If the server times out or cancels an in-flight mutating operation:

1. mark the proxy unusable;
2. terminate the proxy;
3. invoke the official `stop` command against the private endpoint;
4. keep the global desktop lease held;
5. wait for Electron's daemon manager to restart and for health to become ready;
6. release the lease only after the old daemon is gone and the replacement is healthy;
7. never replay the action.

The compatibility harness must prove this reset path actually stops outstanding daemon work. If it cannot, desktop automation must enter `unavailable` until the user restarts bigbud.

## Phase 4 — replace the server MCP client

### Files

- refactor `apps/server/src/computer-use/Services/CuaDriver.ts`;
- split `apps/server/src/computer-use/Layers/CuaDriver.ts`;
- add protocol/transport/session/outcome modules.

### Service shape

Replace the raw per-call-only service with a composite operation boundary, conceptually:

```ts
interface CuaDriverShape {
  readonly withDesktopSession: <A, E>(
    operation: (session: CuaDriverOperation) => Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | CuaDriverError>;
  readonly getHealth: () => Effect.Effect<CuaDriverHealth, CuaDriverError>;
  readonly resetAfterUncertainAction: (reason: string) => Effect.Effect<void, CuaDriverError>;
  readonly dispose: Effect.Effect<void, never>;
}

interface CuaDriverOperation {
  readonly sessionId: string;
  readonly callTool: (
    name: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<CuaDriverCallResult, CuaDriverError>;
}
```

The actual generic shape should follow surrounding Effect idioms and avoid duplicating SDK/protocol types unnecessarily.

### Transport requirements

1. Spawn the manifest-derived MCP proxy with embedded/private-endpoint arguments.
2. Use `shell: false` where possible; avoid `cmd.exe` wrappers.
3. Parse newline-delimited JSON-RPC.
4. Support concurrent request IDs internally, even though logical desktop operations are globally serialized.
5. Bound a single message and total buffered data.
6. Track stderr in a bounded ring buffer for diagnostics.
7. Use typed transport states: `disconnected`, `starting`, `ready`, `failed`, `disposing`.
8. Handle child exit, malformed JSON, unexpected IDs, JSON-RPC errors, and MCP `isError` separately.
9. Run `tools/list` and validate required capability/tool presence before marking ready.
10. Reject calls unavailable in the discovered tool set.
11. Do not retry a mutating `tools/call` automatically.
12. Allow one reconnect for non-mutating startup/health discovery only.

### Session/lease requirements

The global queue covers this complete sequence:

```text
acquire host-wide desktop operation lease
  -> ensure proxy ready
  -> start_session(capture_scope="auto")
  -> target discovery
  -> safety revalidation
  -> requested action
  -> optional capture-after
  -> end_session
release lease
```

No other thread may interleave between target discovery and action/capture.

### Cancellation

- Every pending request accepts an abort signal or Effect interruption bridge.
- On interruption, remove listeners and reject once.
- An interrupted mutating request marks the proxy and daemon state uncertain.
- Reset the daemon before accepting a later action.
- A cancellation/timeout must not leave a Promise that later mutates shared state or emits an unobserved success.

## Phase 5 — correct desktop action mappings and split the adapter

### Files

Split `ComputerUse.desktop.ts` before adding behavior.

### Target selection

Replace “largest window ID” selection with a strict normalizer using documented fields:

1. prefer explicit PID/window ID supplied by a supported action;
2. otherwise use active/frontmost indicators from `list_windows`;
3. use `z_index` and on-screen/visibility facts as deterministic tie-breakers;
4. reject ambiguous or unusable entries;
5. retain null-PID/window entries only for diagnostics, never as actionable targets;
6. immediately run `guardComputerUseTarget` against the resolved target.

### Mapping table

| bigbud action              | 0.9.1 tool                                       | Required mapping                                                                                            |
| -------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `capture`                  | `get_window_state`                               | PID/window ID; no `capture_mode`; screenshot included unless explicitly disabled.                           |
| `get_page_info` on desktop | `get_window_state`                               | Return normalized target/tree/diagnostic state; keep naming for contract compatibility.                     |
| `list_windows`             | `list_windows`                                   | Preserve structured data and normalize known target fields.                                                 |
| `list_apps`                | `list_apps`                                      | Preserve structured data.                                                                                   |
| `check_permissions`        | `check_permissions`                              | Use platform parser and `prompt: false` for routine status.                                                 |
| `doctor`                   | `health_report` plus CLI diagnostics when needed | Do not report ready on nonzero/failed health.                                                               |
| `launch_app`               | `launch_app`                                     | Preserve background semantics only if confirmed by fixture.                                                 |
| `focus_app` with PID       | `bring_to_front`                                 | Explicit product action only; not the generic input escalation path.                                        |
| `focus_app` with name      | `launch_app` or resolved `bring_to_front`        | Fixture-driven; do not silently launch when user intended focus if an existing app can be resolved.         |
| `get_accessibility_tree`   | fixture-confirmed 0.9.1 shape                    | Remove unsupported PID/window/depth fields; prefer `get_window_state` if that is the scoped state contract. |
| `click`                    | `click`                                          | PID/window, local coordinates, button, session.                                                             |
| `drag`                     | `drag`                                           | `from_x`, `from_y`, `to_x`, `to_y`; no path array.                                                          |
| `scroll`                   | `scroll`                                         | Convert delta to deterministic direction/amount/by; reject both deltas zero; define dominant-axis behavior. |
| `type`                     | `type_text`                                      | PID/window, text, session.                                                                                  |
| `key` without modifiers    | `press_key`                                      | One normalized key.                                                                                         |
| `key` with modifiers       | `hotkey`                                         | Parse and normalize chord; preserve safety check before mapping.                                            |
| `wait`                     | bigbud `Effect.sleep`                            | No CUA call required; optional capture remains in the same logical operation if desktop-targeted.           |

### Scroll conversion

Define and test a stable product mapping rather than passing unsupported deltas:

- if only `deltaY` is nonzero: positive → down, negative → up;
- if only `deltaX` is nonzero: positive → right, negative → left;
- if both are nonzero: choose the axis with greater absolute magnitude and record the dropped secondary delta in diagnostics;
- amount is the bounded absolute magnitude converted to the driver-supported unit confirmed by Phase 0;
- zero/zero is a validation error, not a successful no-op.

### Result preservation

For every mutation:

1. retain the original action result;
2. parse `isError`, `verified`, `effect`, `path`, and `escalation`;
3. perform `captureAfter` separately;
4. merge screenshot/tree/target data without overwriting action outcome;
5. preserve bounded raw action and capture structured content under distinct diagnostic keys;
6. never replace an unverifiable/suspected-noop outcome with a successful capture summary.

## Phase 6 — extend contracts with truthful typed outcomes

### File

`packages/contracts/src/orchestration/computerUse.ts`

### Add

```ts
ComputerUseActionEffect;
ComputerUseDeliveryPath;
ComputerUseEscalationRecommendation;
ComputerUseActionOutcome;
ComputerUseExecutionStatus;
```

Recommended result extension:

```ts
ComputerUseResult = {
  // existing fields
  executionStatus?: "succeeded" | "failed" | "timed_out" | "cancelled";
  actionOutcome?: {
    verified?: boolean;
    effect?: "confirmed" | "unverifiable" | "suspected_noop";
    path?: <allow-listed literal>;
    escalation?: {
      recommended: "px" | "foreground" | "page";
      reason: string;
    };
  };
}
```

Rules:

- optional for browser and non-action results;
- optional for unknown/legacy driver responses;
- no raw unknown enum values in typed fields;
- escalation is informational, never authorization;
- `executionStatus: "succeeded"` means the operation completed at the application/transport level, not necessarily that the UI effect was confirmed;
- confirmation is represented only by `actionOutcome.effect === "confirmed"` or the exact captured equivalent.

### Summary language

- confirmed: `Completed and verified …`
- unverifiable: `Input was sent, but the result could not be verified. Capture state before continuing.`
- suspected no-op: `The action may not have taken effect. Do not assume it succeeded.`
- absent outcome: `Input was sent. The driver did not provide a verification outcome.`
- failed: surface the sanitized driver/application failure and do not claim execution.

Provider bridges should need no provider-specific change beyond consuming the extended common result.

## Phase 7 — make activity finalization total and cancellation-safe

### File

`apps/server/src/orchestration-tools/ThreadComputerUseTools.ts`

### Work

1. Generate one operation/activity correlation ID before `tool.started`.
2. Keep pre-start policy denials as ordinary tool errors without a started activity.
3. After `tool.started`, wrap execution, timeout, screenshot persistence, and cleanup in `Effect.onExit`/`ensuring`-style finalization.
4. Append exactly one `tool.completed` terminal activity for:
   - success;
   - driver/MCP error;
   - timeout;
   - cancellation/interruption;
   - daemon reset failure;
   - screenshot persistence failure;
   - session cleanup failure.
5. Include typed `executionStatus` and sanitized error metadata in the terminal payload.
6. Keep the driver action outcome even if screenshot persistence fails.
7. If screenshot persistence fails after a successful action, mark attachment persistence degraded without changing the action's verified effect.
8. Make terminal append idempotent by operation ID so reconnect/recovery cannot create duplicates.
9. Preserve the current full-access, desktop enablement, desktop mode, check-in, action safety, and target safety gates.
10. Ensure target safety is run inside the global desktop lease immediately before mutation, not only before the lease is acquired.

### Timeout semantics

Replace `Effect.timeoutOption` around an opaque Promise with a cancellation path connected to the MCP request and daemon reset policy.

Required invariant:

> After bigbud reports timeout or cancellation, the previous CUA daemon cannot later continue an unobserved mutation while a new action begins.

If this cannot be proven on a platform, mark the runtime unavailable and require a desktop restart.

## Phase 8 — replace diagnostics and permission handling

### Files

- remove or repurpose `apps/desktop/src/backend/cuaDriver.mcpClient.ts`;
- update `cuaDriver.permissions.ts`;
- add `cuaDriver.health.ts`;
- update `cuaDriver.ts` runtime APIs;
- update desktop IPC contracts and handlers;
- update `ComputerUseAccessSettingsSection.tsx`.

### Architecture

Electron diagnostics use the already running daemon through bounded one-shot official commands or a small daemon-aware client. They do not launch another daemon and do not maintain a second long-lived automation proxy.

Prefer:

- `status` for process reachability;
- `health_report` for cross-platform readiness;
- `check_permissions` for platform-specific facts;
- `doctor`/`diagnose` only for user-requested detailed troubleshooting.

### macOS UI

Show separately:

- Accessibility granted;
- Screen Recording granted;
- content capturable;
- attribution/owner when available;
- daemon restart required after grant changes;
- existing System Settings deep links.

The routine status path must use `prompt: false`. Permission-request UI should guide the user through bigbud's host permissions and then restart/recheck the embedded daemon; it must not assume a copied standalone `CuaDriver.app` receives the grant.

### Windows UI

Show:

- daemon running in an interactive user session;
- UI Automation readiness;
- pixel/SendInput or UIAccess degradation when reported;
- actionable repair guidance.

### Linux UI

Show:

- X11 or Wayland session type;
- display/session bus readiness;
- AT-SPI readiness;
- compositor support/degradation;
- structured fail-closed reason for unsupported routes.

### Enable flow

`enableComputerUseInBackground` currently saves `computerUseEnabled: true` before setup finishes. Keep the user's enablement intent, but render runtime availability separately and truthfully:

- enabled + ready;
- enabled + installing;
- enabled + permissions required;
- enabled + degraded;
- enabled + unavailable/setup failed.

Do not claim that the toggle means the runtime is usable, and do not silently reset the user's preference after a transient setup error.

## Phase 9 — optional foreground-delivery approval

This phase is not required to ship the base 0.9.1 upgrade. Implement it only after Phases 0–8 are stable.

### Do not add a permanent foreground toggle

A permanent setting grants too much durable authority and does not reuse bigbud's existing approval/check-in concepts well.

Add a typed one-action confirmation flow instead:

```ts
{
  actionFingerprint,
  threadId,
  targetFingerprint,
  requestedDeliveryMode: "foreground",
  reason,
  expiresAt
}
```

### Rules

1. Offer confirmation only when the validated driver outcome recommends `foreground`.
2. Bind approval to the original action fingerprint, target fingerprint, thread, and short TTL.
3. Background permission never authorizes foreground delivery.
4. Reacquire the host-wide desktop lease.
5. Re-resolve the frontmost/explicit target.
6. Re-run all bigbud safety gates.
7. Retry the original action exactly once with `delivery_mode: "foreground"`.
8. Preserve original and retry outcomes as linked activity records.
9. Never use persistent `bring_to_front` as the normal retry implementation.
10. Reject `px` and `page` recommendations until separately implemented.
11. Never loop through escalation recommendations.

If bigbud's general provider approval infrastructure can represent this action fingerprint safely, reuse it. Otherwise add a computer-use-specific pending confirmation instead of inferring consent from free-form chat text.

## Phase 10 — packaged release, activation, and rollback

### Packaging

1. Consume only the centralized release and policy sources.
2. Stage the exact 0.9.1 executable for every supported target.
3. Write the shared policy to `server/cua-driver/policy/bigbud.yaml` and include its version/digest in packaged runtime metadata.
4. Preserve executable permissions.
5. Verify nested macOS signing/notarization for the staged binary inside the bigbud app.
6. Do not depend on LaunchServices registration of the nested `CuaDriver.app`.
7. Verify Windows x64/ARM64 payloads and optional UIAccess worker layout if the selected artifact includes it.
8. Verify Linux x64/ARM64 payload paths.

### Activation

Managed runtime install/repair performs:

```text
stage inactive slot
  -> checksum
  -> extract
  -> write and verify versioned policy/digest
  -> executable/manifest validation
  -> isolated daemon/proxy policy and health smoke
  -> stop backend
  -> stop active daemon
  -> atomically switch active pointer
  -> start new daemon
  -> start backend with new generation
  -> invalidate/refetch UI queries
```

### Rollback

If the new daemon/backend fails readiness after activation:

1. stop the failed backend and daemon;
2. restore `previous.json` as active, including its paired policy version/digest;
3. restart the previous daemon/backend with the restored policy path;
4. mark the attempted slot failed with a bounded diagnostic reason;
5. retain logs but no user action text, screenshots, or secrets;
6. show a repair/update failure in settings.

Do not delete the previous valid slot until a later successful version has completed its preview/stability window.

## File-by-file implementation worklist

### `packages/shared`

- add CUA release metadata subpath;
- add versioned CUA policy source/digest subpath;
- add sanitized CUA child environment subpath;
- update package exports;
- add target/environment unit tests.

### `packages/contracts`

- add typed action outcome and execution status;
- extend desktop runtime health/status IPC contracts;
- add platform-specific permission/health summaries without exposing raw sensitive process details;
- keep all new fields optional where compatibility requires it.

### `apps/desktop`

- versioned runtime slot and paired policy paths;
- staged install and active-pointer activation;
- manifest/version/tool/policy compatibility validation;
- refactored shared `cuaDriver.process.ts` boundary;
- Electron-owned daemon manager;
- private endpoint generation;
- process-tree-safe shutdown and restart;
- daemon-aware health/permission operations;
- backend restart coordination after activation;
- remove the one-shot independent MCP lifecycle;
- update UI IPC handlers.

### `apps/server`

- newline-delimited MCP protocol transport;
- required tool/capability discovery;
- MCP `isError` classification;
- public session lifecycle;
- host-wide logical operation lease;
- cancellation/reset semantics;
- outcome parsing;
- split desktop action target/mapping/result modules;
- terminal activity finalizer;
- provider-neutral result propagation.

### `apps/web`

- render runtime state independently from enablement intent;
- correct permission/health diagnostics by platform;
- show verified, unverifiable, suspected-noop, timeout, cancellation, and failed outcomes truthfully in existing work-log UI where appropriate;
- do not add a telemetry switch;
- add one-action foreground confirmation only in optional Phase 9.

### `scripts`

- compatibility harness and fixtures;
- shared release metadata consumption;
- artifact validation;
- release smoke helpers.

## Automated test plan

### Contract tests

1. New outcome fields decode when present and remain compatible when absent.
2. Every delivery path captured in the 0.9.1 fixtures survives as a typed value with exact casing.
3. Synthetic unknown effect/path/escalation values are excluded from typed fields but retained in bounded diagnostics.
4. Runtime status distinguishes binary availability from daemon readiness.
5. Platform health/permission summaries encode/decode correctly.

### Release metadata tests

1. macOS universal selection.
2. Linux x64 and ARM64 selection.
3. Windows x64 and ARM64 selection.
4. Archive/checksum/binary/policy path assertions.
5. Shared policy content, version, and digest assertions.
6. Unsupported target rejection.
7. Both installer and artifact staging import the shared release and policy data.

### Installer tests

1. checksum mismatch;
2. corrupt archive;
3. interrupted extraction;
4. manifest schema mismatch;
5. binary version mismatch;
6. missing required tools;
7. policy digest mismatch or parse failure;
8. known denied tool unexpectedly allowed;
9. isolated health smoke failure;
10. active pointer remains unchanged after failure;
11. successful activation preserves previous slot and paired policy;
12. rollback restores the prior runtime and policy atomically;
13. concurrent install/repair is serialized.

### Child environment tests

Assert exact spawn environments for:

- manifest;
- version validation;
- isolated install smoke;
- daemon;
- MCP proxy;
- status/stop;
- health report;
- doctor/diagnose;
- permissions;
- policy validation.

Assertions include:

- inherited telemetry opt-in is overridden to false;
- inherited update checks are overridden to false;
- provider/API credentials are absent;
- required display/session variables remain;
- embedded/socket/policy values are present.

### Daemon manager tests

Use injected child-process dependencies and fake clocks:

1. initial startup/readiness;
2. startup timeout;
3. private endpoint generation;
4. stale endpoint cleanup;
5. expected stop;
6. unexpected exit and bounded restart;
7. restart backoff cap;
8. Windows process-tree cleanup;
9. app quit ordering;
10. backend restart while daemon remains healthy;
11. runtime activation generation change;
12. hard reset after uncertain mutating action.

### MCP protocol tests

1. newline-delimited write format;
2. fragmented JSON line;
3. multiple responses in one chunk;
4. oversized line/buffer;
5. malformed JSON;
6. unknown response ID;
7. JSON-RPC error;
8. MCP `isError: true`;
9. child exit;
10. request timeout;
11. abort/interruption;
12. listener cleanup;
13. no late resolution after abort;
14. proxy recreation after non-mutating setup failure;
15. no automatic mutation replay;
16. `tools/list` required capability gate.

### Session/lease tests

1. one operation starts and ends one public session;
2. session ID is added to every tool call;
3. `capture_scope: "auto"` is used;
4. target discovery, action, and capture cannot interleave with another thread;
5. cleanup runs after success;
6. cleanup runs after action error;
7. timeout triggers uncertain-state reset;
8. cancellation triggers reset;
9. dispose cleans active proxy/session;
10. no session state leaks to a later operation.

### Desktop mapping tests

1. frontmost selection uses documented signals rather than window ID magnitude;
2. null PID/window entries do not poison discovery;
3. no `capture_mode` is sent;
4. drag uses `from_x/from_y/to_x/to_y`;
5. scroll direction/amount mapping;
6. zero scroll rejects;
7. dominant-axis behavior is deterministic;
8. single key uses `press_key`;
9. chords use `hotkey`;
10. key normalization still passes through the existing safety guard;
11. mutation outcome remains present with `captureAfter`;
12. capture diagnostics do not overwrite action diagnostics;
13. malformed structured content is bounded and non-authoritative.

### Activity finalization tests

1. success creates one started and one terminal activity;
2. driver error creates one terminal failed activity;
3. timeout creates one terminal timed-out activity;
4. cancellation creates one terminal cancelled activity;
5. screenshot write failure retains the action outcome;
6. session cleanup failure is recorded;
7. terminal append is idempotent by operation ID;
8. no perpetual started entry remains.

Split the existing `ThreadComputerUseTools.test.ts` before adding substantial coverage so no test file exceeds the repository limits.

### UI tests

1. enablement intent and runtime readiness render separately;
2. missing, installing, permission-required, degraded, and unavailable states;
3. macOS permission facts and restart guidance;
4. Windows interactive-session degradation;
5. Linux X11/Wayland diagnostics;
6. verified versus unverifiable/suspected-noop wording;
7. no telemetry setting is shown;
8. optional foreground confirmation is single-action and expires.

### Provider bridge regression tests

Assert every supported provider still receives the common computer-use result and screenshot:

- Claude Agent SDK MCP bridge;
- Codex MCP/dynamic tools;
- Copilot native tools;
- OpenCode/KiloCode MCP bridge;
- Pi extension;
- Cursor/Devin ACP MCP bridge.

No provider should parse raw CUA `structuredContent` independently.

## Real-platform release matrix

| Platform                 | Required proof                                                                                                                                                                                                                                                                               |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS packaged universal | Embedded daemon spawned directly by Electron main; packaged responsibility/TCC attribution-chain proof beyond `source.attribution`; Accessibility and Screen Recording UX; binary signing/notarization; daemon reset after permission change; backend restart; no LaunchServices dependency. |
| macOS managed upgrade    | Upgrade from 0.6.8; validate inactive 0.9.1 slot; activate; restart daemon/backend; rollback on forced health failure.                                                                                                                                                                       |
| Windows x64              | Interactive-session daemon; intended-user/SID named-pipe isolation proof or an authenticated local broker; UIA capture/action; pixel/foreground degradation reporting; process-tree reset; managed install/repair.                                                                           |
| Windows ARM64            | Same lifecycle and pipe-isolation/broker proof on ARM64 hardware or release-qualified environment; artifact architecture verification.                                                                                                                                                       |
| Linux x64 X11            | Display/session-bus/AT-SPI startup; capture/input; structured health; daemon restart.                                                                                                                                                                                                        |
| Linux ARM64 X11          | Artifact and runtime smoke on ARM64 hardware or qualified environment.                                                                                                                                                                                                                       |
| Linux Wayland            | Test each supported compositor lane separately; unsupported route must return a structured refusal and never fall back to unsafe input delivery.                                                                                                                                             |

For every platform:

- packaged and managed runtime path;
- `manifest`/version validation;
- daemon start/status/health;
- paired policy digest and denied-tool proof;
- MCP initialization/tools list;
- session start/action/end;
- timeout/reset behavior;
- no mutation replay;
- telemetry disabled;
- update check disabled;
- truthful activity and outcome persistence.

## Rollout plan

1. Land the compatibility harness and shared metadata without activating 0.9.1 in production.
2. Land versioned managed slots and runtime validation.
3. Land Electron daemon ownership behind an internal build flag.
4. Land the server proxy/session rewrite and action mappings.
5. Land outcome/activity finalization and diagnostics UI.
6. Run automated and platform smoke matrices.
7. Ship to an internal desktop channel.
8. Observe only bigbud's existing privacy-respecting operational diagnostics:
   - daemon startup duration;
   - readiness failures;
   - proxy restarts;
   - protocol errors;
   - action effect category counts without action text or target content;
   - timeout/reset counts;
   - rollback events.
9. Do not collect screenshots, typed text, window titles, accessibility trees, raw tool arguments, or user content in telemetry.
10. Promote to preview only after the internal channel completes a sustained stability period with no unexplained daemon ownership, TCC, or duplicate-input incidents.
11. Promote to stable only after all supported target artifacts pass the release matrix.

## Suggested pull-request sequence

### PR 1 — contract harness and release metadata

- compatibility script/fixtures;
- shared 0.9.1 artifact metadata;
- shared versioned policy source/digest;
- remove duplicated constants;
- compatibility fixtures exercise the production policy source;
- no runtime behavior switch yet.

### PR 2 — versioned runtime installer

- versioned runtime-and-policy slots;
- manifest/tool/policy validation;
- atomic runtime-and-policy activation and rollback;
- extended desktop runtime status.

### PR 3 — Electron daemon manager

- refactored `cuaDriver.process.ts` process boundary;
- private endpoint and Windows isolation gate;
- embedded daemon lifecycle;
- sanitized child environment;
- backend environment handoff;
- health/status tests.

### PR 4 — server MCP/session rewrite

- newline-delimited protocol;
- tools list/capability gate;
- MCP `isError`;
- public sessions;
- global logical-operation lease;
- cancellation/reset semantics.

### PR 5 — desktop adapter and result contracts

- split `ComputerUse.desktop.ts`;
- fix action mappings;
- target selection;
- typed outcomes;
- preserve outcome across capture-after.

### PR 6 — activity finalization and diagnostics UI

- total terminal activity finalizer;
- health/permission parsing;
- settings/runtime state UX;
- provider bridge regressions.

### PR 7 — optional foreground confirmation

- only after preview stability;
- one-action approval;
- one retry;
- fresh target and safety checks.

Each PR must be independently testable and must not leave production default paths half-switched between old and new process models.

## Acceptance criteria

The upgrade is complete only when all of the following are true:

1. Packaged and managed runtimes use exactly `cua-driver-rs` 0.9.1 with verified checksums.
2. Runtime artifact metadata and the static policy each have one shared source of truth.
3. Every active runtime is atomically paired with a validated policy version/digest.
4. Electron main is the only daemon lifecycle owner.
5. The server owns one long-lived proxy connected to Electron's explicit endpoint.
6. macOS ownership is proven through a packaged Electron responsibility/TCC attribution-chain test, not `source.attribution` alone.
7. Windows daemon execution is verified in the interactive user session and the named-pipe boundary is restricted to the intended user/SID or protected by an authenticated local broker; otherwise Windows automation remains disabled.
8. Linux X11 and Wayland behavior is reported accurately and fails closed where unsupported.
9. MCP traffic uses newline-delimited JSON-RPC and protocol version `2025-06-18`.
10. `tools/list` confirms required tools before readiness.
11. MCP `isError: true` is never reported as success.
12. Every delivery path captured in the 0.9.1 fixtures survives as a typed value with exact casing.
13. Every logical desktop operation owns one public CUA session and one host-wide lease.
14. No other action can interleave between target discovery, mutation, and capture.
15. Timeout/cancellation prevents later invisible mutation and never replays the action.
16. Every started action has exactly one terminal activity.
17. `captureAfter` never discards the original action outcome.
18. No mutation is called verified without a validated confirmed effect.
19. Unknown or absent outcomes are reported honestly.
20. The current bigbud safety, full-access, enablement, desktop-mode, and check-in gates remain active.
21. Foreground delivery cannot occur automatically in the base upgrade.
22. CUA telemetry is disabled for every CUA child process.
23. CUA update checks are disabled for every CUA child process.
24. The UI does not expose a telemetry switch.
25. Health and permissions use platform-correct structured data.
26. Runtime enablement intent and runtime usability are displayed separately.
27. bigbud's Playwright and visible webview browser implementations remain unchanged in ownership and behavior.
28. No new or heavily edited non-test TypeScript file exceeds 400 lines.
29. No new or heavily edited test file exceeds 400 lines, and none exceeds 500 lines.
30. Focused tests run through Vitest with `bun run`, never `bun test`.
31. `bun fmt`, `bun lint`, and `bun typecheck` pass before merge.

## Risks and mitigations

| Risk                                                                             | Mitigation                                                                                                                                                                                                                       |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Electron-spawned embedded daemon does not receive expected macOS TCC attribution | Phase 0 packaged responsibility-chain and real host-grant proof is a hard gate; `source.attribution` alone is insufficient; do not fall back to server-owned embedded mode.                                                      |
| A copied `CuaDriver.app` is not discoverable by LaunchServices                   | Embedded mode does not rely on `open -a CuaDriver`; use the validated executable directly.                                                                                                                                       |
| Daemon endpoint is accessible to another local process                           | Unix: per-launch socket under a restrictive directory. Windows: prove intended-user/SID ACL or add an authenticated local broker; otherwise disable Windows automation. Never expose/log the endpoint and never enable HTTP MCP. |
| Current `Content-Length` client silently fails against 0.9.1                     | Replace transport completely and pin line-framing fixtures before switching runtime.                                                                                                                                             |
| MCP result has `isError: true` inside JSON-RPC success                           | Parse and fail on MCP `isError` separately; dedicated tests.                                                                                                                                                                     |
| Two threads target the same physical desktop concurrently                        | Host-wide composite operation lease covering discovery through capture/finalization.                                                                                                                                             |
| Timed-out input continues in the daemon                                          | Kill proxy, stop/reset daemon, hold lease until replacement health; mark unavailable if reset cannot be proven.                                                                                                                  |
| Daemon crash causes duplicate input                                              | Never replay mutations; reconnect only for a later independently requested action.                                                                                                                                               |
| Post-action capture overwrites effect evidence                                   | Separate action and observation results; merge without replacing `actionOutcome`.                                                                                                                                                |
| Permission status is falsely unavailable                                         | Replace fabricated permission array parser with `health_report` and platform-specific shapes.                                                                                                                                    |
| System runtime has incompatible version/schema                                   | Explicit manifest/version/tool gate; block incompatible runtime.                                                                                                                                                                 |
| Managed activation breaks the running backend                                    | Coordinated backend/daemon stop, atomic runtime-and-policy pointer switch, generation update, restart, and paired rollback.                                                                                                      |
| CUA emits network traffic despite product expectations                           | Explicitly set both telemetry and update-check variables on every child; integration test network suppression.                                                                                                                   |
| CUA policy file is missing and enforcement silently disables                     | Verify file existence and deny-test before daemon readiness; missing/invalid policy is fatal.                                                                                                                                    |
| Linux Wayland sends input to the wrong target                                    | Preserve upstream structured refusal and fail closed; never invent fallback delivery.                                                                                                                                            |
| Optional foreground support steals focus unexpectedly                            | Defer from base release; later require one-action confirmation, fresh target, one retry, and focus-restoration smoke proof.                                                                                                      |
| File-size debt grows during the integration                                      | Split CUA transport/session/outcome and desktop adapter modules before adding logic.                                                                                                                                             |

## Final assessment of the previous plan

There was substantial room to improve the previous plan. Its strongest ideas—centralized artifact metadata, truthful effect outcomes, no mutation replay, preserving bigbud's safety gates, browser separation, and platform smoke testing—are retained here.

The material improvements are the resolved ownership model, exact 0.9.1 protocol/session contract, corrected action and permission mappings, host-wide operation lease, cancellation-to-daemon-reset invariant, versioned activation/rollback design, unconditional telemetry/update-check suppression, and removal of automatic foreground escalation from the initial release.

With these changes, the plan is actionable. The only permitted discovery gate is Phase 0 verification of the exact packaged artifacts and platform behavior; subsequent phases have explicit ownership, module, contract, test, rollout, and rollback requirements.
