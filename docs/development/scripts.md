# Development commands

Commands below are run from the repository root unless noted otherwise. The root scripts and workspace responsibilities are defined in [`package.json`](../../package.json); project-specific development guidance is in [`AGENTS.md`](../../AGENTS.md).

## Start development

```sh
bun install
bun dev              # contracts, server, web, and mobile web
bun dev:server       # server only
bun dev:web          # web only
bun dev:mobile-web   # mobile web only
bun dev:desktop      # desktop development
```

The runner defaults `BIGBUD_HOME` to `~/.bigbud`. A backend takes an exclusive lock on its state directory, so concurrent backends need separate homes, for example:

```sh
BIGBUD_HOME=~/.bigbud-branch-a bun dev
```

The development runner coordinates available server, web, and mobile-web ports. Defaults are `3773` (server), `5733` (web), and `5740` (mobile web); occupied ports may result in a different selected port. Use `BIGBUD_DEV_INSTANCE` to derive a consistent port offset for an instance, or `BIGBUD_PORT_OFFSET` to specify a numeric offset. `T3CODE_DEV_INSTANCE` and `T3CODE_PORT_OFFSET` are compatibility aliases.

For the exact port coordination and mobile companion discovery behavior, see [`scripts/dev-runner.lib.ts`](../../scripts/dev-runner.lib.ts) and the [mobile web development options](../../apps/mobile-web/dev.options.ts).

## Build and validate

```sh
bun run build:contracts
bun run build
bun fmt:check
bun lint
bun typecheck
bun run test
```

`bun run test` runs the workspace test suite. For the repository's focused-check policy and Rust commands, follow [`AGENTS.md`](../../AGENTS.md) and [`crates/AGENTS.md`](../../crates/AGENTS.md).

## Desktop artifacts

```sh
bun run dist:desktop:dmg        # macOS DMG
bun run dist:desktop:dmg:arm64  # Apple Silicon macOS DMG
bun run dist:desktop:dmg:x64    # Intel macOS DMG
bun run dist:desktop:linux      # Linux AppImage
bun run dist:desktop:win        # Windows NSIS installer
```

For other platform/target combinations, use `bun run dist:desktop:artifact -- --platform <mac|linux|win> --target <target> --arch <arch>`. Signing, notarization, CI artifacts, and public release behavior are documented in the [release guide](./release.md).
