# Claude Agent SDK fixture and smoke-test procedure

The checked-in Claude fixtures model SDK `0.3.219` wire shapes without retaining user prompts, tool inputs, filesystem paths, account data, credentials, or real session/task identifiers.

## Run decoder fixtures

```sh
bun run --cwd apps/server vitest run \
  src/provider/Layers/Claude/Adapter.sdk.test.ts \
  src/provider/Layers/Claude/Adapter.sdk.fixtures.test.ts
```

## Run the opt-in real-SDK smoke test

The smoke test is skipped by default. It creates a temporary workspace containing one read-only file, disables tools, uses plan permission mode, caps the turn and budget, and removes the workspace afterward.

```sh
BIGBUD_CLAUDE_SDK_SMOKE=1 \
  bun run --cwd apps/server vitest run \
  src/provider/Layers/Claude/Adapter.sdk.smoke.test.ts
```

The local Claude runtime must already be installed and authenticated. A normal CI or `bun run test` invocation must not depend on personal credentials.

## Refresh fixtures intentionally

1. Confirm both `apps/server/package.json` and `scripts/package.json` name the reviewed SDK version.
2. Capture only the message families consumed by the adapter in a disposable workspace.
3. Replace all prompts, summaries, descriptions, paths, account fields, session IDs, task IDs, tool IDs, and UUIDs with deterministic synthetic values.
4. Preserve field presence, nesting, status strings, and optional-field behavior.
5. Set the fixture bundle `sdkVersion` to the exact reviewed version.
6. Run decoder fixtures, focused Claude tests, `bun fmt`, `bun lint`, and `bun typecheck` before accepting the refresh.
7. Never overwrite a fixture from a different SDK version without updating the filename and adding the corresponding decoder coverage.
