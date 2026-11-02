# Optional GitHub Copilot runtime

## Status and authoritative scope

**Implemented — Code green and Implementation/Plan green verified by focused checks and authorized self-review. Bridge remains the default artifact mode.**

Latest instructions supersede the earlier upgrade-prompt proposal: working existing Copilot installations must never produce an install/onboarding prompt or require unnecessary downloads. Pi is not optionalized. cua-driver remains bundled and functionally unchanged. No commits, pushes, broad checks, or unrelated cleanup are authorized.

## Verified evidence

- `Adapter.types.cli.ts` uses explicit `RuntimeConnection.forStdio` for configured executables and a standalone platform-native CLI in Electron. The SDK-native runtime is separate and unnecessary for explicit stdio.
- Installed SDK `1.0.26` declares compatible CLI `1.0.103`; `client.js` dynamically imports its FFI host only for in-process transport. Explicit CLI connections check an absolute executable path before spawning.
- `/Applications/bigbud.app/Contents/Resources/server/_modules/@github` contains approximately 174 MiB standalone CLI plus 143 MiB SDK-native runtime, and 1.4 MiB lightweight SDK. Filesystem allocation is not archive download size.
- `scripts/lib/desktop-artifact/build.runtime.ts` includes both `@github/copilot` and `@github/copilot-sdk`. `serverRuntimeDependencies.ts` installs their optional platform runtimes. Other optional dependencies, notably Pi, must not be globally disabled.
- Official npm metadata for all eight `@github/copilot-<platform>-<arch>@1.0.103` packages provides immutable URLs, SHA-512 SRI, four files, and unpacked sizes. Pin these in source; never trust runtime-time checksum discovery or follow `latest`.
- CLI license permits unmodified redistribution in applications providing additional functionality, retaining its license/notices. Preserve the whole platform package. This is an implementation finding, not legal advice.
- Existing progress is `SidebarUpdatePill.tsx`, mounted by `Sidebar.footer.tsx`. Reuse its rendering and position, not a separate toast.
- Custom binary settings already exist in `ProviderCard.tsx`. Health probes and native title generation also call `makeCopilotClientOptions`: resolution must be shared.
- `@bigbud/shared/DevPortCoordinator` provides atomic cross-process coordination with PID liveness, not age-based lock stealing. Reuse this established algorithm.

## Approved rollout policy: existing bundled installations

New code cannot execute inside an already-installed old app before its updater replaces that app's bundle. A post-upgrade search cannot recover deleted bytes. Manual drag-and-drop upgrades have no guaranteed pre-update hook either.

**Approved: bridge release, then explicitly selected slim releases.** Bridge artifacts retain the standalone package and silently preserve it into managed storage on startup and before update handoff. The SDK-native package is unnecessary for stdio and is removed even from bridge artifacts. Preserve notices, publish atomically, and remember completion/intentional uninstall. Externally configured executables retain external ownership; never copy/delete arbitrary user paths.

The user explicitly accepted that users skipping or manually upgrading past the bridge may need to install Copilot again. Do not force a bridge detour or silently download a runtime. Working configured, managed, bundled/SDK legacy, and PATH installations suppress onboarding. Only explicit install/update/retry actions download bytes. A failed bridge copy preserves the bundle and prevents updater handoff; startup can continue using the bundle.

### Deliberate artifact activation

- Default: `BIGBUD_COPILOT_RUNTIME_MODE=bridge` (also the default when unset). Retains the matching standalone CLI package/launcher; removes SDK-native packages at every nested scope. Bridge preservation runs before backend startup and before update cleanup/handoff.
- Subsequent slim release: explicitly set `BIGBUD_COPILOT_RUNTIME_MODE=slim` on the existing artifact command, e.g. `BIGBUD_COPILOT_RUNTIME_MODE=slim bun run dist:desktop:artifact --platform mac --arch arm64 --target dmg`. This is documentation, not authorization to run a release build or publish.
- Mode and required targets are frozen into `Resources/server/copilot-runtime.json`. Both staging and `afterPack` enforce that manifest, independent of runtime environment changes. Bridge mode fails if a migration source or its license/notices is absent; slim mode fails if either heavy Copilot family or the standalone launcher is reintroduced.
- Cross-host/universal bridge staging installs the exact target packages in a separate temporary npm project. `--force` is never applied to the full runtime dependency tree. Pi optional dependencies and cua-driver staging/signing remain unchanged.

## A. Runtime foundations — implement now

1. Pin standalone CLI `1.0.103`, matching SDK `1.0.26`, with official SHA-512 and unpacked sizes for darwin/win32/Linux glibc/musl on x64/arm64. Never advertise unpacked bytes as download bytes.
2. Use macOS `~/Library/Application Support/bigbud/runtimes/copilot`, Windows `%APPDATA%/bigbud/runtimes/copilot`, Linux `${XDG_DATA_HOME:-~/.local/share}/bigbud/runtimes/copilot`. Version directories include platform/arch; no writes to signed bundle.
3. Bounded streaming HTTPS download, timeout/cancel, transferred bytes, total only when known, pinned checksum before extraction. Strict fixed-member extraction, private staging, atomic version publication and current pointer. Retain previous versions on failure/update.
4. Serialize transactions with the existing cross-process coordinator. Recover only recognized owned staging directories under the lock. Never steal live locks based on age.
5. Resolve explicit configured executable before managed installation. Retain legacy bundle/SDK fallback during the bridge. Resolve PATH commands to absolute paths; the SDK calls `existsSync` before spawn. Missing runtime becomes setup-needed state before slim packaging is enabled.
6. Focused metadata, resolution, lifecycle/security tests. Generalize the existing progress renderer without moving it or changing app-update behavior.

## B. Provider runtime API and ownership

1. Add direct-subpath Effect contracts `server/copilotRuntime.ts` and RPC definitions; register in `server/rpc.ts` and `WS_METHODS`. Expose via NativeApi/wsNativeApi following thread-tools setup patterns.
2. Server owns jobs independent of renderer lifetime. Status includes stable operation ID, phase (`downloading`, `verifying`, `installing`, `installed`, `cancelled`, `error`), transferred/total bytes, version, installed size/location/source/ownership, and retryability. Status/reconnect never restarts downloads.
3. One Copilot mutation at a time. App updater and Copilot use distinct operation IDs/query keys. Cancel only during download. Retry preserves current/rollback versions.
4. Managed runtime leases cover probes, sessions, and native title generation. Acquire under the same lock as resolution, release only after subprocess stop. Cross-process leases use PID + unique token, fail closed on unknown liveness, and must not rely solely on in-memory session counts. Side-by-side updates never mutate leased versions.
5. Uninstall only recognized managed versions after checking all live relevant leases under the transaction lock. Refuse symlinked/tampered paths. Never remove arbitrary configured/external executables. Clearing custom configuration is separate. Preserve auth/chats/settings and persist onboarding acknowledgement on intentional uninstall.

## C. Setup UX and shared progress

1. New `CopilotRuntimeSettings.tsx` in the existing GitHub Copilot card: install, update to approved pinned version (not arbitrary latest), managed-only uninstall, cancel download, retry, version, installed size/location/source/ownership, custom-path clear action.
2. Shared progress renderer for app updates and Copilot at the existing sidebar-footer position. Preserve updater dismissal/restart behavior. Stack concurrent jobs keyed by ID; never overwrite desktop updater state. Show actual archive bytes/total, indeterminate when HTTP omits total.
3. Persist server-authoritative one-time acknowledgement independent of app version, after discovery completes. Any working configured/managed/legacy/PATH installation suppresses all prompts. Disabled provider or authentication failure is not proof of missing executable.
4. Missing-only prompt title: **Do you use GitHub Copilot?** Body: **Install the GitHub Copilot runtime to use Copilot in bigbud. You can also install it later in Settings → Providers → GitHub Copilot.** Actions: **Install Copilot**, **Set up later**, **Use existing installation**. Persist all dismissals, escape/close, successful discovery, and intentional uninstall.
5. Selecting unavailable Copilot offers setup/settings before sending; no failed turn or implicit provider switch. Recheck authoritative availability before send to cover another window uninstalling.
6. UI tests: all existing sources suppress prompt; dismissal survives app updates/uninstall; chat setup entry; external-path safety; cancel/retry/reconnect; simultaneous jobs; app-update regression.

## D. Migration and slim packaging — approved

1. Bridge migration runs before discovery and in existing `prepareForUpdateInstall` before bundle replacement. Idempotent, retains working old runtime on failure, publishes only complete copies, no interference with other providers. Trust only known app-bundle source, not arbitrary writable paths.
2. Slim artifact drops standalone `@github/copilot` from staged dependencies; retains lightweight SDK. Explicitly prune only native `@github/copilot-sdk-<platform>-<arch>` and `@github/copilot-<platform>-<arch>` in every nested staged modules directory. Never globally disable optional dependencies.
3. Packaging assertion rejects heavy Copilot packages/binaries; tests retain SDK, Pi, node-pty, and cua-driver. Packaged SDK import/stdio must work without native dependencies. Missing Copilot must not break server startup/other providers.
4. Verify a focused staged fixture or approved platform artifact and compare actual sizes. Dependency-map tests alone do not prove installed savings.

## Validation and completion

Every authored source/test module is at most 400 lines. Use explicit paths for oxfmt/oxlint and focused length counts. Focused Vitest via `bun run --cwd <package> ...`, never `bun test`. Configured package typechecks only for actually affected packages. Full-suite/workspace checks require separate approval.

Lifecycle evidence: platform matrix; integrity mismatch; truncated/oversize/redirect/network/timeout failure; cancel; unsafe names/links/duplicates/overflow; interrupted staging recovery; concurrent installers; atomic pointer/rollback; live leases block uninstall; external paths never deleted; uninstall/reinstall preserve auth/history/dismissal.

Code green requires every applicable focused check pass. Implementation/Plan green requires every original requirement supported, including actual slim artifact and migration. Foundations alone do not satisfy installed-size reduction or the complete optional-runtime UX.

## Initial implementation checkpoint (2026-11-01; superseded by the completion checkpoint below)

Implemented: pinned release metadata with exact compressed lengths (official registry Content-Range); application-data paths; bounded streaming download, timeout/cancel and SHA-512 verification; four-member-only streaming extraction; owned staging recovery; cross-process coordinated side-by-side installation and atomic current pointer; managed-before-legacy resolution with explicit-path priority; reusable updater progress rendering in its original sidebar location.

Focused tests cover archive path/link/device/extension/duplicate/size/truncation corruption, downloads and cleanup, concurrent installers in independent Node processes, interrupted staging recovery, retained rollback/auth/settings/chats, storage symlink rejection, platform metadata, configured/managed/legacy precedence, SDK compatibility, and concurrent progress rendering. An isolated SDK copy containing neither native package nor koffi successfully imports, starts an external stdio fixture, and completes its ping.

The actual official darwin-arm64 1.0.103 archive was downloaded to temporary storage, verified against pinned SHA-512, and extracted by the production installer. Observed compressed length: **120,249,222 bytes**; package-file total: **181,811,714 bytes**. Package name/version matched metadata; temporary storage was removed. Other platforms have metadata/unit coverage, not real-archive installation validation.

At this initial checkpoint only foundations were implemented. The subsequent user instruction explicitly required continuing B/C, then approved D's bridge/skipped-upgrade exception. The checkpoint below supersedes that earlier incomplete state; the rollout decision is no longer a blocker.

## Completion checkpoint

- A/B: shared application-data paths, transaction/publication helpers, durable server-owned jobs, explicit cancellation/retry, interrupted-owner recovery, cross-process client leases, and managed-only uninstall are wired. Probes, sessions, and title generation hold leases until confirmed stop; uncertain stop retains ownership. Uninstall preserves auth/settings/chats/external executables and remembers intentional removal. Long download locks do not block new client leases; updates retain immutable previous versions.
- Onboarding acknowledgement and bridge preservation are separate markers. Discovering an existing executable after a failed bridge copy must not mark that copy complete or allow update handoff to skip preservation. Only a successful preservation or intentional managed uninstall suppresses future bridge copies; focused service regressions reproduced the unsafe behavior before the correction and pass afterward.
- Discovery: valid configured paths/environment override first, then compatible managed runtime, then retained bundle/PATH/SDK compatibility sources. A vanished configured bundle path can use the preserved managed copy. Official npm Windows shims are unwrapped without shell interpretation; arbitrary shell shims are not interpreted. Native executable aliases are preserved, while npm JavaScript loaders resolve to a Node-spawnable path. Existing source diagnostics lead to Settings, not an install prompt.
- C: the existing provider card manages install/update/uninstall, custom-path clearing, version/source/size/location, cancel/retry and errors. Shared download presentation occupies the same footer position in chat and Settings; app updates and Copilot have separate identities/state. Missing-only onboarding remembers acknowledgement independently of app version and suppresses existing installations. Failed acknowledgement does not trap the UI and is retried when status reconnects. Selection/send guards run before composer reset/thread/turn mutations.
- D: default bridge packaging prunes only the SDK-native family and wrong-target payloads, retains the complete standalone migration source, and silently preserves it before backend startup and before update fencing/cleanup. Failed preservation never deletes the bundle or fences CUA/backend starts. Explicit slim packaging removes both heavy families, obsolete `.bin` copies/shims, and the standalone launcher; lightweight SDK, Pi and cua-driver remain. Staging and final `afterPack` share the same persisted manifest guard. No release was built, signed, notarized, or published.

### Measured real-payload validation

The installed `/Applications/bigbud.app` GitHub modules were cloned into disposable staging, transformed by the production packaging policy, and validated. The original app was never modified.

| Scope                                 | Copilot payload bytes | Bytes removed from original payload |
| ------------------------------------- | --------------------: | ----------------------------------: |
| Original installed app GitHub payload |           333,717,951 |                                   0 |
| Default bridge profile                |           184,248,263 |                         149,469,688 |
| Explicit slim profile                 |             1,359,536 |                         332,358,415 |

These are measured Copilot-module payload sizes, **not** complete rebuilt installer/app sizes or archive download estimates. Bridge copies the standalone runtime into application data, so total disk use can temporarily rise until the slim app replaces the bridge bundle. Side-by-side updates deliberately retain rollback versions until managed uninstall.

The production bridge helper preserved the actual bundled CLI 1.0.103, verified copied file hashes, and executed its `--version`. A second isolated slim tree contained only the actual lightweight SDK 1.0.26 plus JSON-RPC/Zod dependencies: it successfully started the preserved CLI via external stdio and returned `getStatus().version === "1.0.103"`, without either native SDK package or koffi. Test home/data directories were temporary; no login or conversation was requested; temporary trees were removed.

### Validation scope and follow-up

Use focused Oxfmt/Oxlint paths and explicit source/test length assertions for the task files only. Configured affected-package typechecks are `bun run --cwd apps/server typecheck`, `bun run --cwd apps/web typecheck`, `bun run --cwd apps/desktop typecheck`, `bun run --cwd packages/contracts typecheck`, `bun run --cwd packages/shared typecheck`, and `bun run --cwd scripts typecheck`.

Focused tests cover the Copilot runtime family and adapter regressions; native title generation; updater preparation/CUA cleanup ordering; bridge preservation; both staging profiles and final artifact guards; RPC/schema forwarding; shared progress/settings/sidebar placement; onboarding dismissal/existing-source suppression; and missing-runtime chat-send safety. Browser checks use the configured Chromium runner, not a simulated DOM.

No workspace-wide checks or full release build were run. Real runtime execution was verified on darwin-arm64; other supported targets have metadata, contract, unit and package-type coverage, not native execution validation. Nested agents cannot be spawned at this session's configured depth limit, so self-review is used as explicitly authorized; parent-arranged independent review remains recommended before release.

### Final verification (2026-11-01)

- Explicit scope: 81 task paths; Oxfmt passed, Oxlint reported zero warnings/errors on 78 source/test files, and all source/test files are at most 400 lines (maximum 396). Unrelated work was excluded.
- All six configured affected-package typechecks listed above passed. Server/scripts informational Effect diagnostics are non-failing.
- **265 focused tests passed:** server 114, desktop 40, shared 7, scripts 17, contracts 3, web unit 66, Chromium browser 18. The web runner's existing `--localstorage-file` warning is non-failing.
- `git diff --check` passed. No commit, push, release build, signing, notarization, or publishing was performed.

Exact focused test commands:

```sh
bun run --cwd apps/server vitest run src/provider/Layers/Copilot/Runtime. src/provider/Layers/Copilot/Adapter.types.cli.test.ts src/provider/Layers/Copilot/Adapter.lifecycle.contract.test.ts src/provider/Layers/Copilot/Adapter.session.test.ts src/provider/Layers/Copilot/Provider.models.test.ts src/provider/Layers/Copilot/Provider.initialSnapshot.test.ts src/git/Layers/ProviderNativeThreadTitleGeneration.test.ts
bun run --cwd apps/desktop test src/main.bootstrap.test.ts src/updater/autoUpdater.install.test.ts src/backend/afterPack.shared.test.ts
bun run --cwd packages/shared vitest run src/copilotRuntime.bridge.test.ts
bun run --cwd scripts vitest run lib/desktop-artifact/copilotRuntime.test.ts lib/desktop-artifact/resources.test.ts
bun run --cwd packages/contracts vitest run src/server/copilotRuntime.test.ts
bun run --cwd apps/web test src/components/common/DownloadProgress.test.tsx src/components/layout/desktopUpdate.logic.test.ts src/components/sidebar/Sidebar.footer.test.tsx src/components/chat/view/ChatView.sendTurn.copilot.test.ts src/rpc/wsNativeApi.copilotRuntime.test.ts src/rpc/wsNativeApi.server.test.ts src/components/settings/SettingsSidebarNav.downloads.test.tsx
bun run --cwd apps/web test:browser src/components/sidebar/SidebarCopilotRuntime.browser.tsx src/components/chat/provider/ProviderModelPicker.availability.browser.tsx src/components/chat/provider/ProviderModelPicker.setup.browser.tsx
```

### Final requirements self-review

| Status      | Requirements                                                                                                            | Implementation and evidence                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ✅ Complete | A1–A4: pinned eight-target metadata, private storage, bounded verified download/extraction, atomic publication/recovery | Metadata/archive/download/install tests; independent-process installation tests; actual verified darwin-arm64 archive and preserved binary validation    |
| ✅ Complete | A5–A6: configured/managed/legacy/PATH resolution, missing state, tests and shared progress                              | Resolver/path/npm-shim/SDK tests; real slim SDK stdio handshake; updater and shared progress regressions                                                 |
| ✅ Complete | B1–B3: transport/schema, durable server jobs, independent identity, single mutation, cancel/retry                       | Contract/RPC/service tests; status reconnect does not restart downloads; footer concurrent progress checks                                               |
| ✅ Complete | B4–B5: cross-process leases, managed-only uninstall, external/auth/history safety                                       | Lifecycle/client tests; probes/sessions/title generation use leased clients; failed stops retain leases; explicit uninstall prevents bridge resurrection |
| ✅ Complete | C1: provider-card lifecycle/custom-path controls and metadata                                                           | Existing provider card integration, focused web typecheck, shared RPC/lifecycle coverage                                                                 |
| ✅ Complete | C2: shared chat/Settings progress position and preserved app-updater behavior                                           | Sidebar/Settings placement, DownloadProgress and desktop updater tests; independent state/IDs                                                            |
| ✅ Complete | C3–C4: missing-only once-only prompt, exact copy/actions, dismissal/discovery/uninstall persistence                     | Server lifecycle tests for every existing source; Chromium install/later/existing/close/Escape/reconnect cases; no prompt on executable diagnostics      |
| ✅ Complete | C5–C6: guarded selection/send and focused UX regressions                                                                | Chromium provider picker tests; send returns before composer/thread/turn mutations; fresh status checks                                                  |
| ✅ Complete | D1: bridge startup/pre-update preservation, idempotency/failure safety                                                  | Shared bridge and desktop ordering/failure tests; discovery cannot forge completion; real bundled CLI preservation and version execution                 |
| ✅ Complete | D2–D4: deliberate slim mode, nested packages/.bin guards, SDK/Pi/cua-driver retention, measured savings                 | Default bridge/explicit slim tests; shared staging/afterPack guards; real payload staging measurements and native SDK stdio handshake                    |
| ✅ Complete | Approved rollout exception and exclusions                                                                               | Skipped/manual-upgrade exception documented; no forced bridge detour or implicit download; Pi/cua-driver remain bundled; no remote release changes       |
| ✅ Complete | Scoped validation, source/test length limit, preserve unrelated work, no publication                                    | Explicit-path format/lint/length checks, six package typechecks and 265 focused tests passed; no staging/commit/push                                     |

No unresolved in-scope review issue remains. Full signed/installed artifact validation and native execution on other platforms remain release follow-up, not claimed completed checks.
