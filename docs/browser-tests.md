# Browser Tests

## Status

Browser tests are no longer part of the CI/CD pipeline.

The GitHub Actions `CI` workflow does not:

1. Install the browser test runtime
2. Cache Playwright browsers
3. Run `bun run --cwd apps/web test:browser`

Browser tests remain available for local development only.

## Overview

Browser tests use [Vitest Browser Mode](https://vitest.dev/guide/browser/) with Playwright (Chromium) and `vitest-browser-react`. They are still useful for interactive UI checks that require a real DOM, user events, focus behavior, layout, or animation timing.

Config: `apps/web/vitest.browser.config.ts`
Local command: `bun run --cwd apps/web test:browser`
Local runtime install: `bun run --cwd apps/web test:browser:install`

## CI/CD policy

Browser tests were removed from the CI workflow in `.github/workflows/ci.yml`.

This means:

1. Pull requests are not blocked on browser test execution.
2. Pushes to `main` do not run browser tests before the rest of the pipeline.
3. Desktop release builds no longer wait on browser test steps in the `quality` job.

If browser coverage is needed for a change, run it manually before merging.

## File naming convention

| Pattern                  | Picked up by CI? | Use for                                       |
| ------------------------ | ---------------- | --------------------------------------------- |
| `*.browser.tsx`          | No               | Active local browser tests                    |
| `*.deferred-browser.tsx` | No               | Deferred browser tests kept in the repository |

The include glob in `vitest.browser.config.ts` is:

```ts
include: ["src/components/**/*.browser.tsx"];
```

Only files ending in `.browser.tsx` are included when the local browser test command is run. Files renamed to `.deferred-browser.tsx` remain excluded.

## Deferred tests

The following tests are intentionally left out of the active browser test run and remain in the repo for later re-enablement.

### `ProviderModelPicker.deferred-browser.tsx`

**File:** `apps/web/src/components/chat/provider/ProviderModelPicker.deferred-browser.tsx`

**Status:** Deferred

**Failing test:** `ProviderModelPicker > dispatches the canonical slug when a model is selected`

**What it tests:** Clicks `Claude Sonnet 4.6` in a locked-provider menu and asserts that `onProviderModelChange("claudeAgent", "claude-sonnet-4-6")` is called.

**Suspected cause:** The test relies on sub-menu open/close timing and `MenuRadioGroup.onValueChange` firing synchronously after a click in headless Chromium. The exact race condition has not been fully isolated.

**To re-enable:**

1. Reproduce the failure reliably with repeated headless runs.
2. Fix the timing or event-ordering issue.
3. Rename the file back to `ProviderModelPicker.browser.tsx` once stable.

## Adding new browser tests

1. Create a file matching `src/components/**/*.browser.tsx`.
2. Import helpers from `vitest/browser` (`page`) and `vitest-browser-react` (`render`).
3. Always clean up rendered trees in `afterEach` or a `finally` block.
4. Keep assertions inside `vi.waitFor(...)` when they depend on async DOM updates.
5. Run locally with `bun run --cwd apps/web test:browser`.
