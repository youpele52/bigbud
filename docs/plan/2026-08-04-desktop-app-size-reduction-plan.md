# Desktop App Size Reduction

**Date:** 4 August, 2026
**Status:** Proposed
**Owner:** bigbud desktop and server team

## Summary

Reduce the installed size of the packaged bigbud desktop app in two separately shippable phases. Phase 1 makes the GitHub Copilot runtime an optional, managed component instead of a base-install dependency. Phase 2 measures and safely removes remaining packaging overhead while keeping Computer Use (CUA) and Pi bundled in the base app.

The expected result is a materially smaller first install without changing the available provider set after a user explicitly installs Copilot. CUA and Pi continue to work immediately after installation.

## Related Work

- Bigbud thread: [Investigate BigBud App Bloat](bigbud-thread://326e92b9-b6d2-4c94-b9e3-383a6a311dc2) - measured the installed macOS app and identified the bundled Copilot runtime as the largest removable base-install component.
- Kanban card: [Desktop app size reduction](bigbud-kanban://kanban/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/1785868107876-f2c31985.md) - tracks implementation of this two-phase plan.
- Repository issue or PR: None identified. Create an issue ID before implementation if release work must be tracked outside this plan.

## Problem

The installed arm64 macOS app measured approximately 892 MiB allocated. Its external server runtime was approximately 594 MiB, including roughly 299 MiB for the Copilot package, native runtime, and SDK. CUA and Pi are required base capabilities, so excluding them is not an acceptable size reduction.

The packaged server currently always installs `@github/copilot` and `@github/copilot-sdk`: `apps/server/package.json:26-42` declares both dependencies; `scripts/lib/desktop-artifact/build.runtime.ts:18-27` classifies both as required external runtime packages; and `scripts/lib/desktop-artifact/build.ts:215-237` runs `npm install --production` for that complete set. The build intentionally retains package optional dependencies so the platform-native Copilot executable is present (`build.ts:224-230`).

Removing those dependencies from packaging is not independently safe. The Copilot provider and native title generator import `@github/copilot-sdk` at module load (`apps/server/src/provider/Layers/Copilot/Provider.ts:1-14` and `apps/server/src/git/Layers/ProviderNativeThreadTitleGeneration.ts:1-18`), while Electron-specific resolution assumes the SDK can locate a bundled native package from the standard module tree (`apps/server/src/provider/Layers/Copilot/Adapter.types.cli.ts:50-89`). A base build without those modules would therefore fail before a user could choose to install Copilot.

CUA already provides the reliability precedent for an optional runtime: download with a pinned release URL and SHA-256 verification, extract to a generation directory, validate before activation, retain an active/previous pointer for recovery, clean interrupted generations, and coalesce concurrent installs (`apps/desktop/src/backend/cuaDriver.install.ts:151-240`). Phase 1 must achieve the equivalent guarantees for Copilot without assuming that CUA's artifact format or executable-only installation model applies unchanged.

## Goals

- Exclude the Copilot SDK, CLI package, and platform-native optional package from the base desktop server runtime.
- Let a packaged desktop user install, retry, and use the pinned Copilot runtime without manually locating its binary.
- Preserve explicit user-configured Copilot binary paths and non-desktop/server behavior.
- Keep Copilot unavailable-but-explainable when it is enabled before its managed runtime is installed; do not crash the server or silently fall back to an unverified executable.
- Keep CUA and Pi bundled and operational in every base desktop build.
- Produce a repeatable installed-artifact size report before and after each phase.
- Make Phase 2 reductions only after their platform-specific behavior, signing, and runtime requirements are demonstrated.

## Non-Goals

- Do not make CUA or Pi optional.
- Do not introduce any new mutation of files inside an installed signed app bundle. Existing runtime mutation of the server module path is a Phase 2 decision gate, not an integrity guarantee this plan can claim before it is fixed.
- Do not replace the Copilot SDK with a different provider protocol or change Copilot authentication, model discovery, session, approval, or turn semantics.
- Do not infer usage, models, or availability when a managed runtime is missing.
- Do not remove Electron files, locales, source artifacts, CUA copies, or native architecture slices by ad-hoc shell deletion.
- Do not promise a specific final byte target until the same signed release configuration has been measured.

## Current State

- The desktop build stages server output under `apps/server` and ships it outside `app.asar` through electron-builder `extraResources` because the backend is launched as a child process and needs normal ESM/native-module resolution (`scripts/lib/desktop-artifact/build.ts:136-150`, `scripts/lib/desktop-artifact/resources.ts:219-240`).
- The server bundle deliberately externalizes `node-pty`, Copilot, and Pi packages (`apps/server/tsdown.config.ts:3-27`). `pickExternalDependencies` must remain synchronized with that list (`scripts/lib/desktop-artifact/build.runtime.ts:18-40`).
- Because electron-builder strips `node_modules` in `extraResources`, packaging renames it to `_modules` and desktop startup recreates a `node_modules` link or junction (`scripts/lib/desktop-artifact/build.ts:244-252`; `apps/desktop/src/env/pathResolver.ts:233-309`). A managed Copilot runtime must not rely on mutating this signed application bundle.
- This existing startup behavior mutates `Resources/server/node_modules` in packaged applications. It can invalidate strict macOS code-signature assessment and must be fixed before this plan can claim signed-resource immutability.
- The Copilot provider already reports disabled and failed health-check states in its provider snapshot (`apps/server/src/provider/Layers/Copilot/Provider.ts:134-228`). The settings UI already has a provider card and binary-path field, but no managed-Copilot install action (`apps/web/src/components/chat/provider/providerDescriptors.tsx:132-145`; `apps/web/src/components/settings/ProviderCard.tsx:145-179`).
- CUA release metadata maps both macOS architectures to one universal archive (`packages/shared/src/cua-driver/release.ts:16-28`). Packaging copies both its raw binary and, when present, `CuaDriver.app` (`scripts/lib/desktop-artifact/cuaDriver.ts:85-105`). At runtime macOS resolves the app-bundle executable before the raw binary (`apps/desktop/src/backend/cuaDriver.ts:33-60`).
- The desktop build prunes source maps from bundled desktop/server output and desktop dependencies, but not from the external server dependency tree after `npm install --production` (`scripts/lib/desktop-artifact/build.ts:149-150`, `223-242`; `scripts/lib/desktop-artifact/build.runtime.ts:194-223`).

## Phases

### Phase 1: Optional Managed Copilot Runtime

**Goal:** Remove Copilot from the base desktop artifact while retaining a safe, explicit first-use installation path.

**Dependencies:** Product owner approves the artifact source, version-pinning/update policy, integrity metadata, managed-runtime storage location, and user-facing wording before implementation. Do not start packaging removal until the server can start without the Copilot packages present.

1. Define Copilot runtime metadata and installation ownership using the CUA managed-runtime conventions as the reference, not a copy:
   - Add a narrow shared contract for the pinned Copilot package set or platform archive, its version, platform/architecture selection, SHA-256 checksums, and expected installed layout.
   - Decide whether release CI publishes a verified bigbud-owned archive or whether installation uses the package registry. If a registry is selected, pin every resolved package and integrity hash in a generated, reviewed manifest; never install a floating semver range at runtime.
   - Add desktop managed paths with immutable generation directories plus `active` and `previous` pointers. Keep downloads, temporary extraction, and support diagnostics under the existing bigbud managed base directory, never under `process.resourcesPath`.

2. Add a desktop-side installer and status API following the existing CUA lifecycle:
   - Download to a temporary path, verify bytes before extraction, validate the SDK, native package, and executable layout, then atomically activate the complete generation.
   - Allow one install at a time, preserve the last known-good generation through failed installs, clean only unreferenced interrupted generations, and return actionable install-status errors.
   - Add IPC contract, preload bridge, main-process channel, and web-native API wiring using the established Computer Use install path: `packages/contracts/src/server/ipc.desktopComputerUse.ts`, `apps/desktop/src/main.ts:312-349`, `apps/desktop/src/preload.ts:70`, and `apps/desktop/src/window/ipcHandlers.computerUse.ts`.
   - Use Copilot-specific names and contracts rather than widening Computer Use types.

3. Make the server safe when the managed runtime is absent:
   - Create one Copilot runtime resolver/loader that chooses, in order: an explicit user-configured binary path; an activated, validated desktop-managed generation; then normal non-desktop discovery where that behavior already applies.
   - Move runtime SDK loading behind that boundary. Replace every runtime `@github/copilot-sdk` import reachable during base server startup, including the provider health path and provider-native title generation, with lazy loading that returns a typed unavailable result when no validated runtime is present. Keep type-only imports where TypeScript can erase them.
   - Make provider composition and health checks report Copilot as not installed with an install-oriented message when the managed component is missing. Preserve existing disabled, unauthenticated, configured-binary, and runtime-execution error states.
   - Ensure a user cannot start a Copilot session or native title-generation request until the resolver has produced a validated runtime. Existing threads, retries, and error events must fail predictably rather than throwing module-resolution errors or silently routing to another provider.

4. Add the smallest user-visible setup flow in the existing Providers settings surface:
   - When packaged desktop Copilot is enabled but its managed runtime is absent, show an accessible `Install Copilot` action, progress/disabled state, retry action after failure, and the returned error message.
   - Refresh the provider snapshot after installation. Do not automatically enable Copilot, authenticate it, overwrite `binaryPath`, or begin a session; the user remains in control of those actions.
   - Keep the current binary-path field for an explicitly configured external Copilot CLI. Clearly distinguish an external path from the managed component so selection and precedence are predictable.

5. Change desktop packaging only after the preceding runtime boundary is tested:
   - Remove Copilot packages from `SERVER_RUNTIME_EXTERNAL_PACKAGES` and from the staged server manifest for base desktop artifacts, while retaining Pi and `node-pty`.
   - Update `apps/server/tsdown.config.ts` and its synchronization tests only if the runtime-loader design allows the SDK code to be absent at bundle time; otherwise retain a deliberately small loader dependency and document its measured size.
   - Remove Copilot-specific `asarUnpack` rules only after the base artifact no longer contains matching files.
   - Generate and retain a build report that proves the base artifact contains neither the Copilot SDK nor any `@github/copilot-<platform>-<arch>` package.

**Likely files:** `packages/shared/src/copilot-runtime/*`, `packages/contracts/src/server/ipc.desktopCopilot.ts`, desktop main/preload/window IPC modules parallel to the Computer Use path, `apps/desktop/src/backend/copilotRuntime.*`, `apps/server/src/provider/Layers/Copilot/*`, `apps/server/src/git/Layers/ProviderNativeThreadTitleGeneration.ts`, `apps/server/src/server.ts`, `scripts/lib/desktop-artifact/build.runtime.ts`, `scripts/lib/desktop-artifact/build.ts`, `scripts/lib/desktop-artifact/resources.ts`, `apps/web/src/components/settings/ProviderCard.tsx`, and `apps/web/src/components/settings/ProvidersSettingsSection.*`.

**Exit criteria:** A signed or signing-equivalent packaged desktop artifact starts with no Copilot packages in its base server runtime; CUA and Pi work unchanged; an enabled Copilot provider clearly reports that its managed runtime is absent; installation is checksum-verified, atomic, recoverable, and single-flight; and a successful install enables normal Copilot health checks and sessions without restarting the app unless the selected SDK artifact specifically requires it.

### Phase 2: Measurement-Gated Base Artifact Reductions

**Goal:** Reduce remaining base-install size without changing CUA or Pi availability, sacrificing macOS signing/notarization integrity, or regressing startup and native runtime behavior.

**Dependencies:** Complete Phase 1 and collect comparable reports from the same platform, architecture, Electron version, signing mode, and release target. Each sub-change must pass its own decision gate and ship independently; do not combine uncertain savings into one unreviewable packaging change.

1. Repair signed-resource module resolution before claiming packaged-artifact integrity:
   - Replace the runtime-created `_modules` to `node_modules` link/junction/copy with a packaging-time layout that remains resolvable by Electron's Node ESM loader after signing, or another resolver design that does not write inside `process.resourcesPath`.
   - Test all platform strategies, including the Windows no-symlink fallback, before removing `ensureBackendModulesPath`; a change that works only on macOS is not sufficient.
   - Verify a signed macOS app before first launch and after backend startup with strict `codesign` assessment and `spctl`, alongside native dependency and backend smoke tests. Do not represent signing as fixed if the link still appears after startup.

2. Add repeatable artifact-size observability before modifying further payloads:
   - Extend the desktop artifact workflow to emit machine-readable and human-readable reports for apparent and allocated size, top-level resources, top files, file count, source maps, declarations, locale packs, code-signature metadata, and Mach-O architecture slices.
   - Archive reports in CI next to the build artifact and compare them against a committed or release-baseline threshold. Fail only on agreed regressions; initially report deltas rather than inventing a hard budget.
   - Test report parsing against the protected fixture in `docs/plan/_test-data--do-not-delete.md` if it contains the needed synthetic shape, or add a dedicated test fixture without modifying protected data.

3. Safely prune external server dependency artifacts:
   - Start with `.map` files in the staged server `node_modules` tree after production install and platform-native pruning, reusing `pruneSourceMaps` rather than duplicating filesystem traversal.
   - Measure and then consider declarations, documentation, examples, tests, and package source files only through an explicit allowlist/denylist backed by package-level runtime smoke tests. Never blanket-delete JavaScript, JSON, native files, licenses, package manifests, or files resolved dynamically by Copilot, Pi, or `node-pty`.
   - Preserve debug support artifacts outside the installed app where release/support policy requires them.

4. Publish and consume architecture-specific macOS CUA releases:
   - Require verified arm64 and x64 CUA artifacts, each with an app-bundle strategy compatible with macOS TCC attribution, before changing `packages/shared/src/cua-driver/release.ts`.
   - Update metadata, staging, and tests to select the target architecture rather than treating both as the universal archive.
   - Validate startup, desktop permission discovery/repair, daemon lifecycle, signed-app behavior, and managed CUA repair on both Apple Silicon and Intel macOS. Retain universal artifacts until all supported release jobs and consumers have migrated.

5. Determine whether the raw macOS CUA binary is redundant:
   - Test a package containing only `CuaDriver.app` with bundled runtime discovery, first launch, permission checks, daemon launch, diagnostics, repair, and fresh-install/update behavior.
   - Remove `cua-driver/bin/cua-driver` for macOS only if all tests prove that the app-bundle executable covers every packaged path. Keep the binary on Linux/Windows and retain it on macOS if any repair or TCC path needs it.
   - Do not change the existing resolver fallback until the packaging change is accepted; then make fallback behavior explicit and test missing-app/missing-binary diagnostics.

6. Evaluate Electron locale reduction last:
   - Establish the supported desktop UI locale policy with product owners.
   - Configure electron-builder to package only supported locale resources, then validate Chromium/Electron startup, renderer behavior, spellchecking, accessibility, and locale-sensitive UI on each supported platform.
   - Reject the change if it causes unsupported-language crashes or materially degrades the product experience; locale policy is not a substitute for Phase 1 runtime removal.

**Exit criteria:** Every accepted sub-change has before/after reports, targeted tests, a signed artifact smoke test, and a documented rollback. CUA and Pi remain bundled. No base artifact mutates its signed resource tree after installation, and no removed file is required by runtime dynamic resolution.

## Risks And Decision Gates

- **Copilot artifact provenance:** Package-registry installation, bigbud-hosted archives, and GitHub-hosted assets have different trust, availability, license, update, and offline semantics. Approve one source and its checksum/signature policy before implementing Phase 1. Roll back by retaining the previous active generation and marking the new generation unavailable; never activate partially installed content.
- **Server startup linkage:** Static SDK imports can fail before provider availability is evaluated. Gate packaging removal on a desktop server-start test with the SDK and native Copilot package absent.
- **Configured binaries:** A configured `binaryPath` must remain higher priority than managed installation so existing users are not silently redirected. Decide whether the UI should offer managed installation while a configured path is unhealthy.
- **Provider sessions and title generation:** Never install, upgrade, or switch a Copilot runtime during an active Copilot session. Serialize installation; reject it or defer it while sessions are active. Failed/missing runtime requests must produce normal provider errors without duplicating turns, title jobs, or approval requests.
- **Managed state and updates:** Activation must be atomic, preserve one previous valid generation, and remove only unreferenced generations. After app restart, resolve only validated active/previous generations. Report uncertain or corrupt state as unavailable and offer repair/reinstall.
- **macOS signing and TCC:** The existing runtime-created server module link is a known integrity defect, not a behavior to preserve. Do not add further signed-bundle mutations. Gate the Phase 2 resolver repair, CUA copy removal, and architecture changes on `codesign`, `spctl`, notarized-artifact, TCC, and daemon validation on real packaged applications.
- **Pruning false positives:** Package contents can be loaded by `require.resolve`, dynamic import, child process, source-map support, or native loaders. Begin with source maps and use package-specific smoke tests; retain a rollback switch or prior artifact while validating release builds.
- **Locale coverage:** Product must approve supported languages before locale pruning. Do not use locale removal merely to reach a size number.

## Testing And Validation

### Phase 1

- Unit-test Copilot runtime metadata selection, checksum verification, expected-layout validation, path precedence, atomic activation, cleanup, active/previous fallback, and concurrent-install coalescing. Mirror `apps/desktop/src/backend/cuaDriver.install.test.ts:19-48` rather than testing network access in unit tests.
- Test main/preload/IPC contracts and the web native API for install success, progress, failure, retry, unavailable bridge, and snapshot refresh.
- Test the server with no Copilot SDK/native package: non-Copilot providers load, provider status reports Copilot unavailable, and a Copilot session/title request fails as a typed provider error rather than a module-resolution crash.
- Test configured external Copilot binaries, managed runtimes, disabled provider state, unauthenticated state, missing managed runtime, corrupt active pointer, failed upgrade with previous-generation recovery, and install attempts during an active Copilot session.
- Re-run existing Copilot runtime-resolution and provider behavior coverage, including `apps/server/src/provider/Layers/Copilot/Adapter.types.cli.test.ts`, adapter session tests, registry tests, and native-title tests.
- Build macOS arm64, macOS x64, Linux x64, and Windows x64 artifacts as supported by release CI. Inspect the packaged base server tree to prove Copilot packages are absent, run backend startup smoke tests, and manually install/authenticate/use Copilot on each supported packaged platform.

### Phase 2

- Unit-test report generation and external-tree source-map pruning, including absent directories, symlinks, errors, and preservation of non-map runtime files.
- Run targeted Pi, CUA, `node-pty`, backend-startup, package-layout, and Linux artifact-verification tests after every pruning change.
- For CUA architecture/copy changes, run `packages/shared/src/cua-driver/release.test.ts`, desktop CUA install/lifecycle/health/permission/host-identity suites, plus manual packaged-app tests on arm64 and x64 macOS.
- For locale changes, run manual platform startup and language checks across the approved locale set before accepting a size report as valid.
- Before marking either phase complete, run:

```sh
bun fmt
bun lint
bun typecheck
bun run test
```

Never use `bun test`.

## Acceptance Criteria

- The plan is delivered in the requested two phases: Phase 1 is Optional Copilot only; Phase 2 contains all other size reductions and is measurement-gated.
- Phase 1 removes Copilot's SDK/native runtime from a base packaged artifact without preventing the backend, CUA, Pi, or non-Copilot providers from starting.
- A packaged user can explicitly install Copilot with pinned provenance, integrity verification, atomic activation, retryable errors, and retained prior runtime recovery.
- Configured external Copilot binaries retain predictable precedence and existing Copilot behavior after successful resolution.
- Phase 2 does not remove CUA or Pi from base packaging and accepts no optimization without before/after reports and platform-specific validation.
- No completed phase claims signed-bundle integrity while the existing runtime-created server module link remains. After the Phase 2 resolver repair, packaged builds must preserve signed-bundle integrity and pass the repository validation commands.

## Open Questions

- Which artifact distribution approach is approved for managed Copilot: a bigbud-published platform archive, a registry installation using a fully pinned integrity manifest, or another signed source?
- Which platforms and architectures must support first-use managed Copilot at launch, and which can remain external-binary-only until later?
- What offline policy is required: must the installer be downloadable only when online, or should an enterprise/offline installer option exist?
- Should a configured external Copilot `binaryPath` suppress the managed-install CTA entirely, or show it only when the configured binary is unavailable?
- Is app restart acceptable after a Copilot install/update if SDK module loading cannot be isolated safely inside the already-running backend process?
- Which desktop locales are product-supported, and are they sufficient to justify an Electron locale policy?
- Are architecture-specific macOS CUA releases and TCC attribution artifacts available from the upstream CUA release process, or must bigbud own that release work?
