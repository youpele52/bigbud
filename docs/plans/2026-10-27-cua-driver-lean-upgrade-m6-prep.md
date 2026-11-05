# Cua Driver 0.38: M6 packaging preparation

**Date:** 2026-10-27. **Scope:** read-only research for the [lean upgrade plan](2026-10-27-cua-driver-lean-upgrade-plan.md), not the parked supervised design. Local checkout: `feature/computer-use`, HEAD `c015538b2ad999a1a76fb62186b8d8a3c540d9f8`; concurrent M1–M4 edits were present. References describe files as inspected, including the new `cuaDriver.runtime.ts` split.

**V** = verified source behavior; **I** = inference / requires runtime confirmation. Upstream links are pinned to `85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19` (0.38), or `683e8b7420d10f37cd935c4b50e335d3fa3855a8` (0.9.1). No binaries were downloaded or executed; no app was started, installed state changed, or project file edited except this document.

**Main corrections:** default dev socket is **95 bytes**, not 96; default **beta socket is 105 bytes and will not fit macOS**. Separate beta app identity does **not** isolate upstream Driver state. Signed packaging really does replace upstream entitlements, despite Cua not appearing in `mac.binaries`.

## 1. macOS bare-binary packaging, signing, TCC and notarization

### Verified

- `scripts/build-desktop-artifact.ts:16-65` accepts platform, architecture, version and signing flags. `scripts/lib/desktop-artifact/build.ts:103-115,182-188,194-210` selects the release identity, creates a fresh stage, stages Cua and generates builder configuration.
- `scripts/lib/desktop-artifact/cuaDriver.ts:21-24,49-105` selects the pinned platform artifact (universal maps to arm64), downloads and verifies the **archive** SHA-256, extracts it, copies the executable to `server/cua-driver/bin/<binaryName>`, writes `policy/bigbud.yaml`, and copies `CuaDriver.app` **only if `appPath` is non-null**. It does not stage the SDK libraries or other sidecars.
- `scripts/lib/desktop-artifact/resources.ts:220-241` copies the server tree outside ASAR into `Contents/Resources/server`. Runtime selection prefers the old nested app executable, then `bin/cua-driver`; policy validation uses the adjacent canonical policy (`apps/desktop/src/backend/cuaDriver.runtime.ts:20-63,175-180`, formerly `cuaDriver.ts`). Keeping the old candidate preserves 0.9.1 rollback builds.
- **Yes, signed electron-builder builds re-sign the bare Mach-O with bigbud's inherited entitlements.** Configuration supplies the same plist for root and children (`resources.ts:278-289`). This does not depend on listing Cua in `mac.binaries`: installed `@electron/osx-sign` 1.3.1 recursively discovers binary files under Contents (`node_modules/.bun/@electron+osx-sign@1.3.1/node_modules/@electron/osx-sign/dist/cjs/util.js:150-179`), force-signs children and passes replacement entitlements (`.../dist/cjs/sign.js:173-195,267`). Installed builder 25.1.8 chooses `entitlementsInherit` for non-root files (`node_modules/.bun/app-builder-lib@25.1.8+9de7f21bf22fa85d/node_modules/app-builder-lib/out/macPackager.js:295-339`). `mac.binaries` is an additional-binary list, not the exclusive sign list.
- Upstream's bare executable has exactly **`com.apple.security.device.screen-capture` and `com.apple.security.automation.apple-events`** ([plist, lines 4–9][entitlements]); its workflow asserts both, and explicitly excludes `com.apple.application-identifier` / `keychain-access-groups` ([workflow, lines 767–813][bare-sign]). bigbud's plist contains neither upstream key (`apps/desktop/resources/entitlements.mac.plist:5-24`): both would be lost. The upstream **app**, unlike the bare binary, also carries restricted application/keychain entitlements and a provisioning profile ([workflow, lines 857–955][app-sign]). Do not transplant these Cua-team identities into bigbud.
- Embedded TCC follows the **OS responsibility chain**, not executable path or the `--host-bundle-id` string. Directly spawn `serve --embedded` from Electron; do not `open` the driver itself. Host requests Accessibility and Screen Recording. The label is advisory, not an identity override ([embedding, lines 88–107][embedding-launch]). The standalone app owns `com.trycua.driver`; embedded mode, even with an app-bundled executable, uses the host identity ([embedding, lines 310–321][embedding-tcc]). Thus switching the embedded executable from `.app` to bare binary is not inherently a new TCC identity. Restart the daemon after grants ([embedding, lines 390–413][embedding-grants]). Local direct spawn: `apps/desktop/src/backend/cuaDriver.daemon.ts:69-76`; dev host: `cuaDriver.hostIdentity.ts:1-4`.
- Unsigned builds explicitly disable signing (`resources.ts:290-295`), so copying does not deliberately replace the upstream binary signature. Signed builds use the existing custom `afterSign` notarization pipeline (`resources.ts:288-289`); it verifies the outer app deeply but explicitly checks team IDs for only two other sidecars (`apps/desktop/scripts/notarize.cjs:61-83`). The bare binary's upstream signature is not a substitute for notarizing bigbud's final signed bundle.

### Implications and exact M6 work

- **I:** TCC inheritance is supported by upstream source, not proven on this rebuilt app. Confirm `source.attribution: host`, matching host ID, actual screenshot and input. Entitlements do not themselves grant TCC. Loss of Apple Events is a signed-build regression risk; this research did not establish that the selected 17 tools require Apple Events, nor that `device.screen-capture` is a required entitlement on every supported macOS version.
- With verified `appPath: null`, **no staging or bundled-resolution rewrite is needed**. Keep archive verification and policy bytes unchanged; assert no nested app in output and check executable mode/linkage. Binary-hash equality is appropriate before re-signing, not after it.
- For predictable signed builds, recommend preserving the two unrestricted upstream entitlements **on Cua only**, with a dedicated `entitlements.cua-driver.mac.plist` and a small custom `mac.sign` hook that delegates to `@electron/osx-sign`, wrapping the supplied `optionsForFile` only for `Contents/Resources/server/cua-driver/bin/cua-driver`. Preserve all other supplied signing options. Builder supports this hook (`.../out/macPackager.js:271-274,344-354`). Do not re-sign after the outer bundle has been sealed. This is an approval-gated recommendation, not a change made here; alternatively explicitly accept the reduced entitlement set after signed runtime qualification. Adding the keys to the shared inherited plist is simpler but unnecessarily expands every helper's entitlement set.
- Add Cua to explicit signature/team verification in `apps/desktop/scripts/notarize.cjs`; test configuration/hook behavior in `scripts/lib/desktop-artifact/resources.test.ts` / `notarize.test.ts`. Verify hardened runtime, final entitlements, bigbud Team ID, deep outer signature, successful notarization and staple. Removing Cua's provisioned app avoids its restricted-entitlement/profile compatibility problem; it does not guarantee notarization success.

## 2. Windows and Linux compared with macOS

| Concern                   | macOS                                                                  | Windows                                                                      | Linux                                                                                |
| ------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Change from 0.9.1         | Wrapped directory + nested app → root-level universal `-binary.tar.gz` | Already root-level `-binary.zip`; same convention                            | Already root-level arch `-binary.tar.gz`; same convention                            |
| Executable staged         | `bin/cua-driver`, universal arm64+x64                                  | `bin/cua-driver.exe`, arm64 or x86_64                                        | `bin/cua-driver`, arm64 or x86_64                                                    |
| Archive extras not staged | Theme CLI, SDK dylib, Node addon, header                               | Theme CLI, UIA executable, SDK DLL, Node addon, header                       | Theme CLI, SDK `.so`, Node addon, header, `wayland-helper/`                          |
| Extraction/mode           | `tar`; executable bit must survive copy                                | PowerShell `Expand-Archive`; no Unix executable-bit requirement              | `tar`; executable bit must survive copy                                              |
| OS access/signing         | Host TCC; Developer ID/hardened runtime/notarization                   | Desktop session/integrity restrictions, not TCC; Windows signing is separate | Desktop session, X11/AT-SPI/Wayland/portal capability, not TCC or macOS entitlements |
| Endpoint                  | Unix socket, private 0700 directory                                    | `\\.\pipe\bigbud-cua-<uuid>`; not a filesystem path                          | Unix socket, private 0700 directory                                                  |

**V evidence:** old tables `packages/shared/src/cua-driver/release.v0_9_1.ts:4-43`; new archive construction [macOS lines 958–986][mac-package], [Windows lines 492–499][win-package], [Linux lines 296–316][linux-package]; common extraction/copy `scripts/lib/desktop-artifact/cuaDriver.ts:67-105`; names `apps/desktop/src/backend/cuaDriver.paths.ts:5-6`; endpoints `cuaDriver.daemon.ts:54-62`. Staging has no explicit `chmod`; managed installation does explicitly chmod 0755 (`cuaDriver.install.ts:25-35`). **I:** verify stage and final executable modes; add Unix-only chmod in staging if copy/extraction does not preserve them. Windows/Linux dynamic-link independence remains M2 evidence, not verified here.

**V Linux health nuance:** `wayland_backend` is not automatically a failure whenever Wayland exists. It is **skipped** if no `WAYLAND_DISPLAY` or experimental Wayland is not opted in ([Linux health lines 259–275][linux-health]); opt-in failures include compositor connection, missing input/activation or incomplete manager capabilities (same file, lines 276–410). A failing check is outside bigbud's permission-only set, so it can become repair-required (`apps/desktop/src/backend/cuaDriver.health.ts:10-16,43-59`). Current child env does not inherit arbitrary Cua opt-in variables (`packages/shared/src/cua-driver/childEnvironment.ts:1-39`). **Recommendation:** keep the classification; diagnose the backend, do not label missing compositor support as a damaged binary or blindly broaden the permission-only set. Bundling the helper alone does not install/enable a GNOME extension; that is outside this lean upgrade.

## 3. Shared Driver state and minimal dev isolation

### Verified overrides are partial, not a universal home switch

- Default PID path remains `~/Library/Caches/cua-driver/cua-driver.pid` on macOS; Linux uses `~/.cache`, Windows `%LOCALAPPDATA%` ([0.38 serve lines 357–374][pid-default]; [0.9.1 lines 282–296][old-pid]). `serve --pid-file` exists ([CLI lines 49–56][cli-pid]). Private `--socket` alone does **not** relocate the PID file.
- `CUA_DRIVER_TELEMETRY_HOME` relocates telemetry/config lookup and suppresses legacy telemetry migration ([telemetry lines 2240–2254,2355–2357][telemetry-home]). It also exists in 0.9.1 ([old telemetry lines 42–46,1718–1732][old-telemetry]).
- `CUA_DRIVER_RS_HOME` relocates Computer History, skills and some other product state, **not everything** ([history lines 424–440][history-home]; [skills lines 148–170][skills-home]). `CUA_DRIVER_HOME` in this source is used for installed-package/history identity lookup on non-macOS, not a global config root ([history lines 358–388][history-package]).
- Normal PiP/runtime config still directly uses `HOME` / `USERPROFILE` + product namespace + `config.json` ([PiP lines 16–59][pip-config]); update config does too ([update lines 540–569][update-config]). Naming an executable `cua-driver-local` changes several namespaces, but is a separate source-install identity, not a supported all-state override ([bundle lines 18–59][bundle]). Do not rename the pinned executable as a workaround.

### Concurrent 0.9.1 / 0.38 behavior

- **V:** no PID-file singleton lock: both implementations write the PID unconditionally after binding and delete it unconditionally on shutdown ([0.38 serve lines 969–976,1405–1408][pid-write]; [0.9.1 lines 754–761,1014–1017][old-pid-write]). Last starter wins; either stopper deletes the other daemon's PID record. **Activation validation is another daemon** and also passes no `--pid-file` (`apps/desktop/src/backend/cuaDriver.activation.ts:44-61`). Killing it during install can remove the installed daemon's PID metadata, even if the installed app is otherwise untouched.
- **V:** actual liveness/shutdown is socket-directed, not PID-directed ([serve lines 2246–2257,2305–2319,2350–2377][serve-control]); this is not evidence that one embedded instance will automatically kill the other. PID status can nevertheless describe the wrong process. Never use the shared PID file to choose the dev process for the crash drill.
- **V:** telemetry uses common lock filenames and JSON `telemetry_enabled` preferences in both versions ([0.38 telemetry lines 32–48,216–240,2334–2349][telemetry-locks]; [0.9.1 telemetry lines 30–46,129–165,1811–1827][old-telemetry-locks]). Current bigbud forces telemetry/update off (`childEnvironment.ts:35-36`), so their normal workers short-circuit. **I:** no material telemetry contention is expected on this path; this is not proof that the complete runtime config formats are mutually compatible. JSON key-level config writes use read/merge/write without an interprocess transaction ([PiP lines 42–59][pip-config]); do not mutate shared config with different versions.
- **V, conditional dev blocker:** 0.38 also reads persisted Computer History admission, not just a new CLI flag. If shared `admission.json` says true, bare embedded startup attempts installed-product verification and can fail before binding ([main lines 601–606][startup]; [history lines 30–39,73–97][history-admission]). No assertion is made that this user's file exists; it was not read.

### Recommendation before M5 (approval needed)

**Smallest comprehensive macOS isolation:** use the already-defined `resolveManagedPaths(baseDir).homeDir` (`apps/desktop/src/backend/cuaDriver.paths.ts:9-16`) as **child-only `HOME`**, created 0700. Keep the real Electron/app home unchanged. Route the same overrides through activation, daemon, desktop diagnostic/MCP children and backend MCP/reset children. It naturally isolates config, telemetry, cache/PID and default history for both versions. No upstream binary patch or global shell HOME change is needed. For future Windows qualification, isolate `USERPROFILE`, `LOCALAPPDATA` and `APPDATA` as well; changing HOME alone does not isolate its PID path.

**Where code is needed:** shared explicit environment-builder helper/options in `packages/shared/src/cua-driver/childEnvironment.ts` (do not duplicate environment logic), supplied by desktop `cuaDriver.runtime.ts`, `.activation.ts`, `.daemon.ts`, `.mcpClient.ts` and forwarded across `backendRuntimeEnv` into server `apps/server/src/computer-use/Layers/CuaDriver.ts` / reset environment. The current builder strips unknown inherited variables; setting `CUA_DRIVER_RS_HOME` in the launch shell alone will not work. Add focused tests proving common paths and that the real home is not inherited for Driver children. Qualify `launch_app`/config behavior after the change.

**Narrower alternative:** explicitly private `--pid-file` per daemon/validation endpoint plus `CUA_DRIVER_TELEMETRY_HOME` and `CUA_DRIVER_RS_HOME` overrides isolates those named resources while preserving ordinary HOME. It **still reads the shared ordinary config** and must not be described as full isolation. If HOME isolation remains deferred by lean scope, obtain explicit acceptance of this residual risk and amend the plan's “never read or write installed state” expectation. Merely quitting stable avoids simultaneous clobber but not shared-state reads/writes and must itself be user-approved.

## 4. Socket length: dev fits; default beta does not

**V:** `resolvePrivateEndpoint` is in `apps/desktop/src/backend/cuaDriver.daemon.ts:54-62`; `.daemon.endpoint.ts:14-31` only removes stale sockets. The path is `<resolveManagedPaths(baseDir).rootDir>/run/<36-character UUID>/cua.sock`. Root construction: `.paths.ts:9-10`; development versus packaged base: `apps/desktop/src/main.config.ts:25-30,48-55`; state suffix: `packages/shared/src/backendOwnership.paths.ts:16-17`.

Computed from the literal source construction for username `youpele` (ASCII, so characters = UTF-8 bytes):

| Run identity    | Exact shape (UUID placeholder is 36 bytes)                                                                  |   Bytes |
| --------------- | ----------------------------------------------------------------------------------------------------------- | ------: |
| Dev             | `/Users/youpele/.bigbud/dev/runtime/cua-driver/run/00000000-0000-4000-8000-000000000000/cua.sock`           |  **95** |
| Stable packaged | `/Users/youpele/.bigbud/runtime/cua-driver/run/00000000-0000-4000-8000-000000000000/cua.sock`               |  **91** |
| Beta packaged   | `/Users/youpele/.bigbud/channels/beta/runtime/cua-driver/run/00000000-0000-4000-8000-000000000000/cua.sock` | **105** |

The plan's 96-byte dev count is off by one. Local macOS SDK confirms `sun_path[104]` (`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/sys/un.h:76-79`): reserve the terminating NUL, so use **103 bytes maximum**, not 103 Unicode characters. Upstream directly calls `UnixListener::bind` without shortening ([serve lines 959–965][socket-bind]). Dev has eight bytes of headroom; a longer `BIGBUD_HOME` can remove it. Validation uses a much shorter `/tmp/bigbud-cua-validation-<suffix>/cua.sock` and can pass even though the real daemon fails (`cuaDriver.activation.ts:20-35`).

**URGENT for M6, not a default M5 blocker:** shorten the run component before testing default beta. A minimal code fix is full-entropy UUID with hyphens removed (32 bytes), plus short `s` filename: dev 84 / stable 80 / beta 94 bytes; retain 0700 parent permissions and stale-socket ownership handling. Add a UTF-8 byte-length guard and focused dev/stable/beta/long-home tests. A no-code test-only alternative is a dedicated short `BIGBUD_HOME=/Users/youpele/.bigbud-beta` (96-byte socket); launch via LaunchServices with an app-scoped environment, never globally override the installed app's environment. This work is separate from Driver HOME isolation.

## 5. Startup budget and how to measure M5

**V:** current budgets are 10 s for daemon readiness including `health_report`, 12 s for backend startup, and 10 s for activation liveness (`apps/desktop/src/backend/cuaDriver.daemon.ts:21,147-166`; `backendRuntimeEnv.ts:8,28-41`; `cuaDriver.activation.ts:20,69-98`). Status polls themselves spawn another executable, capped at 1 s each. Activation's subsequent health/policy calls are outside its 10 s liveness loop.

**V upstream sequence:** authorization, history admission/config reads, PiP initialization, cursor config, SDK runtime/desktop initialization happen before binding ([main lines 590–695][startup]); macOS registration initializes cursor overlay when a graphical session exists and installs cursor-shape tracking ([platform macOS lines 140–160][mac-init]). SDK Linux preparation also discovers Xauthority/session bus and activates accessibility services ([SDK runtime lines 674–683][sdk-init]); it then recovers orphaned MPX devices before bind ([serve lines 949–965][socket-bind]). These are plausible OS/config/cold-start latency sources, **not measured >10 s failures**.

**Not an expected first-run network wait on bigbud's path:** telemetry's registration worker exits before spawn when disabled ([telemetry lines 1430–1445][telemetry-worker]); update checking honors false before config access ([update lines 543–546][update-config]). Embedded mode opts out of the startup permission gate ([gate lines 240–257,384–386][gate]); the standalone multi-minute grant wait is not part of this path. No mandatory binary download/setup on every embedded `serve` startup was found in this inspected sequence. Gatekeeper/code-sign checks, OS probes and health-report latency remain runtime unknowns.

**M5 measurement without new tooling:** run the actual Electron-owned daemon, not a timed terminal-owned replacement (which changes TCC ancestry). Record wall-clock Install/start, appearance of the dev `serve` PID (`ps -o pid,ppid,lstart,etime,command -p <pid>`), first successful explicit-private-socket status, and Settings/Doctor ready time. Existing desktop stdout/stderr and timeout messages distinguish “never bound” from “health not ready”; a bounded shell polling loop with standard `date`/`ps` is enough. If executing diagnostic status manually, use exactly the app's private endpoint and isolated child environment. Record first cold install, warm restart and post-TCC-grant restart separately; include whether activation succeeded but persistent startup failed. Observe elapsed time including health, and ask before raising budgets. Existing logs do not expose an exact spawn→ready histogram; do not claim subsecond precision without temporary approved instrumentation.

## 6. Packaged test identity and build command

**V:** `desktopReleaseIdentityForChannel` supports stable, beta, preview and nightly (`packages/shared/src/desktopReleaseIdentity.ts:17-66`). `-beta.N` is parsed from the build version (`releaseChannel.ts:19-42`), not selected by a separate builder channel flag. Beta means bundle ID **`ai.bigbud.desktop.beta`**, app **`bigbud Beta`**, updater channel **`beta`**, bigbud base **`~/.bigbud/channels/beta`**, Electron userData **`~/Library/Application Support/bigbud-beta`**. Config uses the version-derived identity and no stable legacy-profile fallback (`main.config.ts:22-37`; `main.appIdentity.ts:30-53`; `main.ts:107-114`). The userData override occurs before normal startup; the single-instance lock does not imply beta must share stable's profile (`main.runtime.ts:19-28`). Still avoid concurrent desktop-input tests against stable.

Exact proposed command (not run):

```sh
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 --build-version 0.1.613-beta.1 --keep-stage --output-dir /tmp/bigbud-cua-038-beta
```

Add **`--signed` only with separate signing/notarization approval**. DMG builds also emit ZIP (`scripts/lib/desktop-artifact/resources.ts:257-263`). Builder is always invoked with `--publish never` (`build.ts:314-330`); it does not install over `/Applications/bigbud.app`. The default build does not skip compilation; approve the build's normal build/sidecar work separately from any validation suite. Use the corrected short endpoint before launching the beta app, or the short-home alternative in §4. This number is a test identity from the plan, not a claim that it is the next release version.

**I / manual acceptance:** open the built beta app from its output location via LaunchServices; do not run its inner Mach-O from Terminal. Beta needs its own Accessibility/Screen Recording grants; stable's or dev's grants are not expected to transfer. Unsigned test identity can also have less stable TCC behavior across rebuilds, so qualify a final signed build separately. Do not reset stable TCC. Restart the beta daemon after grants. Beta isolates bigbud data, **not** Cua's shared HOME/PID/config unless §3 is addressed.

## Recommended M6 changes

- [ ] Keep `appPath: null`, verified `-binary` artifacts, canonical policy and the existing bare-binary fallback; preserve 0.9.1 rollback candidates.
- [ ] **Before default beta launch:** shorten Unix endpoint and add UTF-8 length coverage, or approve the short dedicated beta bigbud home.
- [ ] Resolve shared Driver-state isolation before claiming beta/dev cannot affect installed state (§3); include validation daemons, diagnostics and server proxies.
- [ ] Decide signed entitlement behavior explicitly; recommended Cua-only plist/custom signing hook rather than losing both upstream keys or widening all helpers.
- [ ] Add explicit Cua signature/team/entitlement verification before notarization; add focused builder/hook tests. Record unsigned source hash versus signed output verification separately.
- [ ] Inspect stage/final binary permissions, macOS system-only linkage, policy digest, absence of nested Cua app and final notarization/staple. Add Unix chmod only if needed.
- [ ] Run the approved beta packaged checklist after M5 dev succeeds. Keep Windows/Linux packaging/static evidence separate from unperformed runtime qualification.

## Risks for M5 dev test

- **Conditional startup breaker:** persisted upstream History admission can force installed-product checks on the bare binary; child HOME isolation prevents this inheritance. Not verified present on this user account.
- **Shared-state safety gap:** ordinary dev and activation daemons clobber the stable driver's PID metadata despite separate sockets. Existing telemetry switches do not solve this; get approval for minimal isolation or explicit acceptance before execution.
- Default dev socket fits (95 bytes); custom longer/Unicode home may not. Activation can mask a later socket-path failure.
- First startup/health may overrun 10–12 s, but source does not prove that it will. Measure cold/warm/grant-restart paths rather than increasing budgets pre-emptively.
- Host TCC must be granted to `ai.bigbud.desktop.dev` and the child restarted. This task did not test actual permissions, IPC, artifacts or desktop actions.
- Signed entitlement loss is primarily an M6 issue: dev managed installation does not invoke electron-builder re-signing.

## Approvals needed

- **Before M5:** approval to execute/install both versions, run the dev app, perform desktop input and grant dev TCC (lean plan A2/A3). Explicit decision to add the small state-isolation change despite the plan's deferral, or accept the documented shared-state exception. No automatic stable-app quit/kill.
- **Before M6:** approve beta identity/version and build (including artifact downloads and normal build dependencies), endpoint fix/short-home decision, entitlement strategy, and running/granting beta TCC. Signing/notarization additionally uses credentials and Apple's network; not implied by unsigned build approval.
- Fresh approval for any commit or push, any workspace-wide checks, or later Windows/Linux runtime qualification. None was performed for this research.

[entitlements]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/scripts/CuaDriver.entitlements#L4-L9
[bare-sign]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/.github/workflows/cd-rust-cua-driver.yml#L767-L813
[app-sign]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/.github/workflows/cd-rust-cua-driver.yml#L857-L955
[embedding-launch]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md#L88-L107
[embedding-tcc]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md#L310-L321
[embedding-grants]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md#L390-L413
[mac-package]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/.github/workflows/cd-rust-cua-driver.yml#L958-L986
[win-package]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/.github/workflows/cd-rust-cua-driver.yml#L492-L499
[linux-package]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/.github/workflows/cd-rust-cua-driver.yml#L296-L316
[linux-health]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/platform-linux/src/health_report.rs#L259-L410
[pid-default]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L357-L374
[old-pid]: https://github.com/trycua/cua/blob/683e8b7420d10f37cd935c4b50e335d3fa3855a8/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L282-L296
[cli-pid]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/cli.rs#L49-L56
[telemetry-home]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/telemetry.rs#L2240-L2381
[old-telemetry]: https://github.com/trycua/cua/blob/683e8b7420d10f37cd935c4b50e335d3fa3855a8/libs/cua-driver/rust/crates/cua-driver/src/telemetry.rs#L1718-L1732
[history-home]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/history_runtime.rs#L424-L440
[skills-home]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/skills.rs#L148-L170
[history-package]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/history_runtime.rs#L358-L388
[pip-config]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/pip-preview/src/lib.rs#L16-L59
[update-config]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/version_check.rs#L540-L569
[bundle]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/bundle.rs#L18-L59
[pid-write]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L969-L1408
[old-pid-write]: https://github.com/trycua/cua/blob/683e8b7420d10f37cd935c4b50e335d3fa3855a8/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L754-L1017
[serve-control]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L2246-L2377
[telemetry-locks]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/telemetry.rs#L2334-L2349
[old-telemetry-locks]: https://github.com/trycua/cua/blob/683e8b7420d10f37cd935c4b50e335d3fa3855a8/libs/cua-driver/rust/crates/cua-driver/src/telemetry.rs#L1811-L1827
[startup]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/main.rs#L590-L695
[history-admission]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/history_runtime.rs#L30-L97
[socket-bind]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/serve.rs#L949-L965
[mac-init]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/platform-macos/src/lib.rs#L140-L160
[sdk-init]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver-sdk/src/runtime.rs#L674-L683
[telemetry-worker]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/cua-driver/src/telemetry.rs#L1430-L1445
[gate]: https://github.com/trycua/cua/blob/85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19/libs/cua-driver/rust/crates/platform-macos/src/permissions/gate.rs#L240-L386
