# bigbud resource-monitor tab

**Status:** Implemented and verified; repository-wide checks passed. Platform limitations remain below.
**Approved scope:** Both monitor surfaces; core bigbud by default, with a separate “Including agents/tools” total. No commit or push authorized.

## Agreed experience

- Preserve the existing System view and left-sidebar monitor navigation.
- Add System / bigbud scope controls to the detailed page and right panel, reusing the markdown Raw / Preview `ToggleGroup` (`variant="toolbar"`, `size="xs"`). Each surface has its own selected scope; links open the corresponding detailed scope.
- The bigbud view shows core CPU/memory history, process count, disk I/O, the inclusive total, and component breakdown (Desktop, Backend, Native services, Agents/tools).
- Core totals exclude agent/tool descendants. Memory is summed resident memory, explicitly estimated; CPU is normalized to host logical CPU capacity. Process I/O is labelled I/O on Windows, where native counters include non-disk I/O.
- Reuse the current cards, formatting, connection/retry states, shared store and single native sampler. No per-app network/GPU utilization, persistent history, alerts or process control in this version.

## Implementation boundary

1. Extend the additive monitor protocol to v1.3 with app-resource demand, a bounded trusted process-root registry and app summaries. Update Rust, TypeScript codecs, capability negotiation and compatibility tests together.
2. Electron supplies actual owned process handles: Electron's process inventory, the desktop backend handle and the monitor child. Renderer IPC accepts only app-resource demand, never arbitrary ownership roots. Registry identities distinguish child restarts; Rust pins roots to observed PID + start time and rejects PID reuse.
3. Rust discovers descendants from parent links and computes totals before pagination. Explicit roots take priority; descendants not registered as core are agents/tools. Unregistered native backend descendants are conservatively included only in agents/tools until their lifecycle owners can register their roles. This avoids treating arbitrary commands as core overhead. Detached/reparented processes without a current owned ancestor are outside the measured set, even if previously observed; describe totals as observed owned processes rather than promising complete detached-process attribution.
4. Share the existing retained sysinfo state. Refresh app resources every five seconds on demand, using lightweight ancestry discovery and targeted resource refreshes when the full host process table is not requested. Bound roots, descendants and retained rate baselines; report incomplete measurements rather than false zeroes.
5. Feed bounded summaries/history to both surfaces. Demand is the union of visible consumers; hiding the app view stops app collection. Reset app histories on registry changes, epochs, gaps, or stale/unavailable samples. Warm new process CPU/I/O baselines separately.

## Acceptance and validation

- Tests cover core/inclusive separation, root deduplication, PID reuse, process exit/restart, ancestor cycles, partial inventories, first samples, zero/unsupported metrics and rate counter resets.
- Codec tests cover additive fields and collection limits; bridge tests prove ownership roots are supplied by the trusted desktop owner and old binaries fail explicitly for app-resource requests.
- UI/store tests cover the reused toggle, both scopes, independent surface selection, scope-aware links, demand union/release and unavailable data.
- Run focused desktop/web and native tests, then `bun fmt`, `bun lint`, `bun typecheck`, `bun run test`, `cargo fmt --all --check`, `cargo clippy --locked --workspace --all-targets -- -D warnings`, and `cargo test --locked --workspace`. Never use `bun test`.
- Inspect browser rendering/interactions where available, and exercise live native Subscribe / Snapshot / Shutdown on this Mac. macOS evidence does not certify Windows/Linux packaged runtime or overhead budgets.
- Preserve unrelated working-tree changes. Every materially edited authored source/test file remains at most 400 lines.

## Progress

- [x] Requirements and visual concept approved, including existing compact toolbar toggle.
- [x] Existing UI, store, bridge, native sampler and process ownership explored.
- [x] Protocol and native accounting.
- [x] Desktop process registry and codec.
- [x] Shared app-resource UI and both surface controls.
- [x] Focused regression tests, formatter, lint, typechecking, and native workspace checks.
- [x] Full JavaScript suite verification.
- [x] Validation record and remaining platform limitations.

## Validation record

- Two `format-lint-test-fixer` agents independently revalidated the assigned checks: formatting/lint/typechecking passed; 54 renderer, 36 desktop monitor, 6 browser, and 193 Rust workspace tests passed. Neither agent needed code fixes. The separate full JavaScript suite also passed.
- Focused renderer tests: 16 files, 54 tests passed. Coverage includes initial legacy-binary rejection, preserving System lease renewal, scope selection, demand union, unavailable totals, and history continuity.
- Chromium monitor tests: 5 files, 6 tests passed, including both compact and detailed app layouts, chart visibility, toolbar interactions, independent selections, and scope-aware navigation. Dark screenshots inspected at 340 px and 896 px; this uses representative data, not a running Electron window.
- Native workspace tests, strict Clippy, and formatting check passed. Native tests include PID reuse, newer-parent rejection, ancestry depth/cycles, root deduplication, baseline resets, absent roots, pre-pagination aggregation, and v1/v1.3 golden compatibility.
- A real monitor child streamed ready core/inclusive CPU and resident-memory metrics through the TypeScript bridge on this Mac; the test also unsubscribes and shuts down the child.
- Focused desktop monitor tests: 8 files, 36 tests passed using `--configLoader runner`.
- `bun fmt`, `bun lint`, and `bun typecheck` passed. Lint retains existing unrelated warnings; no new monitor warnings remain.
- The first `bun run test` failed in unrelated `apps/mobile-web/dev.concurrent.test.ts` and cancelled dependent work. The initial serial rerun stalled before test startup in the config bundler and was stopped. `--configLoader runner` unblocked the desktop monitor and shared tests. The final `bun run test --concurrency=1 --continue=dependencies-successful -- --configLoader runner` passed all 9 Turbo tasks: 7,226 tests passed and 88 skipped across 1,494 passing test files (31 skipped files). The previously failing mobile-web suite passed on this run. No test-tool configuration was modified.
- Authored monitor source/test files remain below 400 lines. Protocol schemas were split by metrics, app summaries, and process inventory; current generated monitor outputs are also below 400 lines without editing generated Rust.

## Remaining limits

- Development runtime follow-up: the user's Electron process started before the new bridge bundle, consistent with an old desktop bridge silently ignoring app demand while the renderer hot-reloads the new tab. A full desktop dev restart is required, not a renderer refresh; post-restart confirmation remains pending. Added a 15-second missing-app-sample diagnostic that preserves System monitoring, survives lease renewals, clears on fresh app data or leaving the app scope, and marks affected cards unavailable rather than warming. The new regression tests failed before the fix; focused renderer tests now pass 57 tests, all web unit tests pass 2,288 tests, desktop monitor tests pass 36, and Chromium monitor tests pass 6. Formatting, lint, and typechecking passed. The repository-wide full-suite result above predates this diagnostic follow-up.
- Windows/Linux packaged runtime and collector overhead budgets have not been certified; no dependency or platform-specific unsafe code was added.
- Rust process start times have second-level precision. Electron root identity retains the full creation timestamp and child roots use handle identity; same-second PID reuse inside ancestry remains an OS-observation limitation.
- App ancestry accounting is capped at 20,000 host records, 64 ancestors, 128 registered roots, and 512 owned process measurements. Exceeded inventory/measurement limits or missing roots mark totals incomplete/unavailable. The existing sysinfo host process table is shared, not independently capped by the app aggregation layer.
- CPU/I/O require a second sample after registry changes. Values depend on sysinfo's OS counter access; sysinfo does not expose every per-counter permission failure separately. Resident memory can double-count shared pages.
- Native services currently includes explicitly registered monitor/native roots, not every backend subprocess. Detached processes and remote hosts are outside this local-host view; network/GPU attribution stays deferred.
