# Terminal GPU default — user-authorized D1 override

**Status:** Implemented; parent independent review and final integration pending. **Date:** 2026-10-10.

## Authoritative scope

The user explicitly requested Auto GPU enabled by default. The parent clarified existing preferences and received **“Yes, preserve Off”**. This replaces only the earlier D1 prerequisite that packaged/native validation must pass before enabling Auto; it is not evidence that validation passed.

- Omitted settings, new installs and explicit settings resets use `auto`.
- Saved `off` and `on` stay unchanged. No broad settings rewrite or storage migration.
- Auto genuinely attempts the lazy public WebGL addon when the view is visible and application policy allows, just like On. It is not a cosmetic default behind a DOM-only gate.
- Both modes retain same-xterm DOM fallback, trusted application hardware/software/crash policy, no hidden GPU contexts, eight visible contexts, five-second cooldown, and per-view/window three-loss/incident circuit breakers. Deliberate retry still cannot override application policy.
- Settings label Auto without “gated” and explain policy-respecting fallback.
- No dependencies, Rust/native-owner changes, private xterm APIs, or packaged-validation proof claims.

## Validation requirements

Contract regressions cover omitted/default/reset values and unchanged explicit modes. Settings regressions cover the default description and the row reset action. Controller and browser regressions cover actual Auto attachment, context loss/activation failure on the same emulator, policy rejection/re-read, Off no-load, hidden views, budgets and latches for both Auto and On. Run formatting, lint, typechecking, contracts tests and focused web unit/browser tests; parent performs independent review and final integration after the parallel portable-fixture work.

### Focused implementation evidence

- Scoped `bun fmt` on the eleven owned files: passed, without formatting concurrent portable-fixture work.
- `bun lint`: passed (29 existing warnings, zero errors).
- `bun typecheck`: passed (nine workspace tasks). An initial test import failed because the existing core-settings subpath requires `.ts`; corrected to match controller imports and reran successfully.
- `bun run --cwd packages/contracts vitest run`: 27 files, 181 tests passed.
- `bun run --cwd apps/web vitest run src/components/terminal/TerminalRendererController.test.ts src/components/settings/TerminalRenderingSettings.test.tsx src/hooks/useSettings.test.ts`: three files, 26 tests passed.
- `bun run --cwd apps/web test:browser src/components/terminal/TerminalViewport.rendering.browser.tsx src/components/terminal/TerminalViewport.renderingPolicy.browser.tsx`: two files, eight tests passed, including real public Auto WebGL attachment/context loss and failure fallback.
- `bun run --cwd apps/desktop vitest run src/main.terminalRendering.test.ts src/main.linuxRuntime.test.ts`: two unchanged policy suites, 14 tests passed.

Logs are `terminal-auto-default-{lint,typecheck,contracts,web,browser,desktop}.log` under the approved OpenCode temporary directory. No Rust or native source changed in this slice; no Cargo run or duplicate full-root test run was performed. These focused results are not parent independent acceptance or packaged GPU validation.

## Unchanged outstanding gates

Packaged Electron and native GPU hardware/driver/performance validation remain **unproven**. Headless Chromium WebGL tests may use software rendering and cannot establish those results. Native-owner rollout, exact cold recovery, Windows parity and the existing security/platform gates remain unchanged and closed. This override does not make the complete terminal reliability plan ready or completed.
