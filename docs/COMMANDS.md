# Commands

The central reference for all development commands: Bun commands defined in the root and workspace `package.json` files and their just equivalents. Run the commands below from the repository root.

**Setup:** Install Bun and just, then run `just` or `just --list` to discover commands. The root [justfile](../justfile) implements the aliases below. Bun remains usable directly.

Bun scripts remain the source of truth for workflow implementation. The just recipes call those existing commands without duplicating their logic. No Make aliases are included.

## Naming and discovery

- Root script aliases replace colons with hyphens: `bun run dev:desktop` → `just dev-desktop`.
- Workspace aliases prefix the workspace name: `bun run --cwd apps/desktop build` → `just desktop-build`.
- Root orchestration and workspace commands are not interchangeable. For example, `build-desktop` invokes the root build workflow; `desktop-build` only invokes the desktop package build.
- `just --list` lists recipes; bare `just` shows the same command list without starting a workflow.
- Bun scripts use the explicit `bun run` spelling, especially `bun run test`. Never substitute the Bun-native test runner.

## Common commands

| Purpose                      | Bun                      | just                  |
| ---------------------------- | ------------------------ | --------------------- |
| Install dependencies         | `bun install`            | `just install`        |
| Start development stack      | `bun run dev`            | `just dev`            |
| Start desktop development    | `bun run dev:desktop`    | `just dev-desktop`    |
| Start server development     | `bun run dev:server`     | `just dev-server`     |
| Start web development        | `bun run dev:web`        | `just dev-web`        |
| Start mobile web development | `bun run dev:mobile-web` | `just dev-mobile-web` |
| Build desktop                | `bun run build:desktop`  | `just build-desktop`  |
| Check formatting             | `bun run fmt:check`      | `just fmt-check`      |
| Lint                         | `bun run lint`           | `just lint`           |
| Check types                  | `bun run typecheck`      | `just typecheck`      |
| Run all tests through Vitest | `bun run test`           | `just test`           |

## Scope and safety

- Aliases must preserve existing behavior, exit codes, and scope. They do not bypass agent approval requirements in [AGENTS.md](../AGENTS.md).
- Repository-wide formatting, lint, type checks, tests, and length scans require approval before an agent runs them. Package-wide checks also require approval; use focused checks for changed files where supported.
- Root `lint` runs both oxlint and an unscoped file-length scan. Passing paths to that script does not make the entire workflow focused.
- `clean` removes dependency directories, build outputs, and Turbo caches; it is not a read-only check.
- `prepare`, `prebuild`, and `prepack` are lifecycle helpers, included for completeness. The Effect `prepare` scripts patch the language service; marketing `prebuild` fetches and writes download statistics.
- Browser installation commands download browsers and may install system dependencies.
- Root `start` currently targets Turbo filter `t3`; this inventory records its existing wiring, not a successful runtime verification.

## Root: development and startup

| Bun                                | just                            |
| ---------------------------------- | ------------------------------- |
| `bun run dev`                      | `just dev`                      |
| `bun run dev:server`               | `just dev-server`               |
| `bun run dev:web`                  | `just dev-web`                  |
| `bun run dev:mobile-web`           | `just dev-mobile-web`           |
| `bun run dev:marketing`            | `just dev-marketing`            |
| `bun run dev:desktop`              | `just dev-desktop`              |
| `bun run start`                    | `just start`                    |
| `bun run start:desktop`            | `just start-desktop`            |
| `bun run start:marketing`          | `just start-marketing`          |
| `bun run start:mock-update-server` | `just start-mock-update-server` |

## Root: builds

| Bun                                | just                            |
| ---------------------------------- | ------------------------------- |
| `bun run build`                    | `just build`                    |
| `bun run build:marketing`          | `just build-marketing`          |
| `bun run build:mobile-web`         | `just build-mobile-web`         |
| `bun run build:mobile-web:desktop` | `just build-mobile-web-desktop` |
| `bun run build:desktop`            | `just build-desktop`            |
| `bun run build:contracts`          | `just build-contracts`          |
| `bun run build:workspace-agent`    | `just build-workspace-agent`    |
| `bun run build:desktop-supervisor` | `just build-desktop-supervisor` |

## Root: checks, tests, and cleanup

| Bun                              | just                          |
| -------------------------------- | ----------------------------- |
| `bun run typecheck`              | `just typecheck`              |
| `bun run lint`                   | `just lint`                   |
| `bun run check:test-file-length` | `just check-test-file-length` |
| `bun run test`                   | `just test`                   |
| `bun run test:desktop-smoke`     | `just test-desktop-smoke`     |
| `bun run fmt`                    | `just fmt`                    |
| `bun run fmt:check`              | `just fmt-check`              |
| `bun run clean`                  | `just clean`                  |

## Root: packaging and release

| Bun                                          | just                                      |
| -------------------------------------------- | ----------------------------------------- |
| `bun run smoke:desktop-supervisor`           | `just smoke-desktop-supervisor`           |
| `bun run verify:packaged-desktop-supervisor` | `just verify-packaged-desktop-supervisor` |
| `bun run dist:desktop:artifact`              | `just dist-desktop-artifact`              |
| `bun run dist:desktop:dmg`                   | `just dist-desktop-dmg`                   |
| `bun run dist:desktop:dmg:arm64`             | `just dist-desktop-dmg-arm64`             |
| `bun run dist:desktop:dmg:x64`               | `just dist-desktop-dmg-x64`               |
| `bun run dist:desktop:linux`                 | `just dist-desktop-linux`                 |
| `bun run dist:desktop:linux:dir`             | `just dist-desktop-linux-dir`             |
| `bun run dist:desktop:linux:deb`             | `just dist-desktop-linux-deb`             |
| `bun run verify:desktop:linux-artifact`      | `just verify-desktop-linux-artifact`      |
| `bun run dist:desktop:win`                   | `just dist-desktop-win`                   |
| `bun run release:smoke`                      | `just release-smoke`                      |

## Workspace: apps/desktop

Source: [apps/desktop/package.json](../apps/desktop/package.json).

| Bun                                            | just                             |
| ---------------------------------------------- | -------------------------------- |
| `bun run --cwd apps/desktop dev`               | `just desktop-dev`               |
| `bun run --cwd apps/desktop dev:server-bundle` | `just desktop-dev-server-bundle` |
| `bun run --cwd apps/desktop dev:bundle`        | `just desktop-dev-bundle`        |
| `bun run --cwd apps/desktop dev:electron`      | `just desktop-dev-electron`      |
| `bun run --cwd apps/desktop build`             | `just desktop-build`             |
| `bun run --cwd apps/desktop start`             | `just desktop-start`             |
| `bun run --cwd apps/desktop typecheck`         | `just desktop-typecheck`         |
| `bun run --cwd apps/desktop test`              | `just desktop-test`              |
| `bun run --cwd apps/desktop smoke-test`        | `just desktop-smoke-test`        |

## Workspace: apps/marketing

Source: [apps/marketing/package.json](../apps/marketing/package.json).

| Bun                                      | just                       |
| ---------------------------------------- | -------------------------- |
| `bun run --cwd apps/marketing dev`       | `just marketing-dev`       |
| `bun run --cwd apps/marketing prebuild`  | `just marketing-prebuild`  |
| `bun run --cwd apps/marketing build`     | `just marketing-build`     |
| `bun run --cwd apps/marketing preview`   | `just marketing-preview`   |
| `bun run --cwd apps/marketing typecheck` | `just marketing-typecheck` |

## Workspace: apps/mobile-web

Source: [apps/mobile-web/package.json](../apps/mobile-web/package.json).

| Bun                                           | just                            |
| --------------------------------------------- | ------------------------------- |
| `bun run --cwd apps/mobile-web dev`           | `just mobile-web-dev`           |
| `bun run --cwd apps/mobile-web build`         | `just mobile-web-build`         |
| `bun run --cwd apps/mobile-web build:desktop` | `just mobile-web-build-desktop` |
| `bun run --cwd apps/mobile-web preview`       | `just mobile-web-preview`       |
| `bun run --cwd apps/mobile-web typecheck`     | `just mobile-web-typecheck`     |
| `bun run --cwd apps/mobile-web test`          | `just mobile-web-test`          |
| `bun run --cwd apps/mobile-web test:browser`  | `just mobile-web-test-browser`  |

## Workspace: apps/server

Source: [apps/server/package.json](../apps/server/package.json).

| Bun                                                                   | just                                                    |
| --------------------------------------------------------------------- | ------------------------------------------------------- |
| `bun run --cwd apps/server dev`                                       | `just server-dev`                                       |
| `bun run --cwd apps/server build`                                     | `just server-build`                                     |
| `bun run --cwd apps/server thread-tools:manifest`                     | `just server-thread-tools-manifest`                     |
| `bun run --cwd apps/server thread-tools:manifest:check`               | `just server-thread-tools-manifest-check`               |
| `bun run --cwd apps/server thread-tools:native-qualification:check`   | `just server-thread-tools-native-qualification-check`   |
| `bun run --cwd apps/server thread-tools:native-qualification:prepare` | `just server-thread-tools-native-qualification-prepare` |
| `bun run --cwd apps/server start`                                     | `just server-start`                                     |
| `bun run --cwd apps/server prepare`                                   | `just server-prepare`                                   |
| `bun run --cwd apps/server prepack`                                   | `just server-prepack`                                   |
| `bun run --cwd apps/server typecheck`                                 | `just server-typecheck`                                 |
| `bun run --cwd apps/server test`                                      | `just server-test`                                      |
| `bun run --cwd apps/server test:groups`                               | `just server-test-groups`                               |
| `bun run --cwd apps/server test:browser:install`                      | `just server-test-browser-install`                      |
| `bun run --cwd apps/server benchmark:startup-catalog`                 | `just server-benchmark-startup-catalog`                 |
| `bun run --cwd apps/server benchmark:mobile-recovery-memory`          | `just server-benchmark-mobile-recovery-memory`          |

## Workspace: apps/web

Source: [apps/web/package.json](../apps/web/package.json).

| Bun                                           | just                            |
| --------------------------------------------- | ------------------------------- |
| `bun run --cwd apps/web dev`                  | `just web-dev`                  |
| `bun run --cwd apps/web build`                | `just web-build`                |
| `bun run --cwd apps/web prepare`              | `just web-prepare`              |
| `bun run --cwd apps/web preview`              | `just web-preview`              |
| `bun run --cwd apps/web typecheck`            | `just web-typecheck`            |
| `bun run --cwd apps/web test`                 | `just web-test`                 |
| `bun run --cwd apps/web test:browser`         | `just web-test-browser`         |
| `bun run --cwd apps/web test:browser:install` | `just web-test-browser-install` |

## Workspace: packages/contracts

Source: [packages/contracts/package.json](../packages/contracts/package.json).

| Bun                                          | just                       |
| -------------------------------------------- | -------------------------- |
| `bun run --cwd packages/contracts dev`       | `just contracts-dev`       |
| `bun run --cwd packages/contracts build`     | `just contracts-build`     |
| `bun run --cwd packages/contracts prepare`   | `just contracts-prepare`   |
| `bun run --cwd packages/contracts typecheck` | `just contracts-typecheck` |
| `bun run --cwd packages/contracts test`      | `just contracts-test`      |

## Workspace: packages/effect-acp

Source: [packages/effect-acp/package.json](../packages/effect-acp/package.json).

| Bun                                           | just                        |
| --------------------------------------------- | --------------------------- |
| `bun run --cwd packages/effect-acp prepare`   | `just effect-acp-prepare`   |
| `bun run --cwd packages/effect-acp typecheck` | `just effect-acp-typecheck` |

## Workspace: packages/shared

Source: [packages/shared/package.json](../packages/shared/package.json).

| Bun                                       | just                    |
| ----------------------------------------- | ----------------------- |
| `bun run --cwd packages/shared prepare`   | `just shared-prepare`   |
| `bun run --cwd packages/shared typecheck` | `just shared-typecheck` |
| `bun run --cwd packages/shared test`      | `just shared-test`      |

## Workspace: scripts

Source: [scripts/package.json](../scripts/package.json).

| Bun                               | just                     |
| --------------------------------- | ------------------------ |
| `bun run --cwd scripts prepare`   | `just scripts-prepare`   |
| `bun run --cwd scripts typecheck` | `just scripts-typecheck` |
| `bun run --cwd scripts test`      | `just scripts-test`      |

## Installation and focused operations

These are additional invocation patterns, not extra named package scripts. Recipes forward arguments as separate shell arguments, preserving spaces and special characters. `server-test-file` requires at least one argument to avoid accidentally running all server tests.

| Purpose                               | Bun                                                             | just                                              |
| ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------- |
| Install dependencies                  | `bun install`                                                   | `just install`                                    |
| Install without changing the lockfile | `bun install --frozen-lockfile`                                 | `just install-frozen`                             |
| Run one server test file              | `bun run --cwd apps/server vitest run src/path/file.test.ts`    | `just server-test-file src/path/file.test.ts`     |
| Run one web browser test file         | `bun run --cwd apps/web test:browser src/path/file.browser.tsx` | `just web-test-browser src/path/file.browser.tsx` |
| Check formatting for one file         | `bun run fmt:check apps/web/src/example.ts`                     | `just fmt-check apps/web/src/example.ts`          |
| Format one file                       | `bun run fmt apps/web/src/example.ts`                           | `just fmt apps/web/src/example.ts`                |

Test paths above are placeholders. Web browser tests require the configured Playwright browser to be installed. Never pass an empty intended file list to the formatter: it can expand the scope to the whole repository.

## Maintaining this reference

When adding, removing, or renaming a command, save its Bun and just invocations here and update the corresponding recipe in the root `justfile`. Keep common commands in [README.md](../README.md) and [AGENTS.md](../AGENTS.md) short and link here for the full inventory.

This reference inventories named package scripts and common invocation patterns, not every arbitrary `bun <file>` command that could execute a source file. Rust-specific commands and guidance remain in [crates/AGENTS.md](../crates/AGENTS.md).
