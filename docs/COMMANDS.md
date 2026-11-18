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

| Bun                                  | just                              |
| ------------------------------------ | --------------------------------- |
| `bun run build`                      | `just build`                      |
| `bun run build:marketing`            | `just build-marketing`            |
| `bun run build:mobile-web`           | `just build-mobile-web`           |
| `bun run build:mobile-web:desktop`   | `just build-mobile-web-desktop`   |
| `bun run package:mobile-components`  | `just package-mobile-components`  |
| `bun run build:remote-backend-graph` | `just build-remote-backend-graph` |
| `bun run remote-backend-graph`       | `just remote-backend-graph`       |
| `bun run provider-conformance`       | `just provider-conformance`       |
| `bun run licenses:rust`              | `just licenses-rust`              |
| `bun run build:desktop`              | `just build-desktop`              |
| `bun run build:contracts`            | `just build-contracts`            |
| `bun run build:workspace-agent`      | `just build-workspace-agent`      |
| `bun run build:desktop-supervisor`   | `just build-desktop-supervisor`   |

### Optional mobile artifact producer

`bun run package:mobile-components --help` lists the required inputs. This build-time producer takes an already-built gateway executable and static mobile asset directory, then creates separate signed gateway and asset artifacts plus `manifest.json` in a fresh output directory. It does not build binaries, download tools, install components, publish a release, or enable mobile access on a host. Use the existing artifact/CAS lifecycle for eventual installation; each host still needs separate mobile consent.

The producer requires Python 3 at build time through the existing deterministic tar/gzip helper. End users do not need Python to run the gateway. Signing currently requires a POSIX build host that can verify the key file's owner and permission bits. The private key must be an owner-only Ed25519 PEM file, outside the asset directory and output. Key material is read from that file only. Do not pass a private key in argv or environment variables.

```sh
bun run package:mobile-components \
  --gateway-binary /build/bigbud-mobile-gateway \
  --target aarch64-unknown-linux-musl \
  --assets-directory /build/mobile-dist \
  --agent-version 1.0.0 --backend-version 1.0.0 \
  --gateway-version 1.0.0 --asset-version 1.0.0 \
  --minimum-mobile-rpc 1 --maximum-mobile-rpc 1 \
  --artifact-base-url https://github.com/example/releases/download/v1.0.0/ \
  --key-id release-key --key-file /private-signing/mobile-ed25519.pem \
  --output-directory /build/fresh-mobile-artifacts
```

All version and RPC compatibility fields are signed. Gateway headers are checked for the selected architecture without executing the binary; native execution testing remains a release gate. Asset input must contain `index.html` and only supported static files. Hidden files, source maps, credential filenames and PEM key material, links, special files, oversized inputs, nested output and input changes fail closed. The producer and runtime share static path/case policies and limits of 128 MiB content, 160 MiB total expanded tar bytes, 16,384 entries and 32 directory levels. Existing output is never overwritten. Failed output is marked `UNPUBLISHED.txt`; never publish partial staging files. This producer supplies no default signing key and does not establish production release trust or lifecycle readiness.

### Backend executable graph producer

`bun run build:remote-backend-graph --help` lists the inputs for signing an assembled private
backend file tree. Supply `--root`, `--version`, `--build-digest`, `--target`, relative `--node`
and `--entry` paths, `--key-file`, `--key-id`, and a fresh `--output` manifest path. Supported
targets are `aarch64-unknown-linux-gnu` and `x86_64-unknown-linux-gnu`. The Node executable must
be named `node`; the entry directory must also contain `NodeSqliteWorker.mjs` and
`remote-client-relay/remoteBackendClientRelay.mjs`.

The complete tree requires canonical owned private directories and regular single-link files.
The explicit owner-only Ed25519 key file and output must be outside that tree; the existing
output parent must be private. The producer hashes all members, signs the existing graph
contract, and uses the runtime verifier to revalidate it before writing the manifest without
overwriting an existing file. It executes no input and installs or publishes nothing.

Before signing, the producer validates the static closure against the checked-in loader policy
(`scripts/build-remote-backend-graph.policy.data.ts`). Only the tsdown
`createRequire(import.meta.url)` shim is trusted, and each literal `__require(...)` must resolve
to a graph member. Non-literal loaders and generated code are allowed only in reviewed members,
matched by bundle `//#region` marker or graph path plus a SHA-256 of that region or file.
Listed absent externals (node-pty, Playwright, Bun-only adapters, optional accelerators) are
allowed only when no eager edge reaches them from a statically reachable module. Every `.node`
file must be listed for the target and match its ELF machine, and any other ELF member must match
too. Static inventory and a successful signature check do not qualify providers, shared
libraries, native execution or release-key authorization.

### Provider conformance harness (M4)

`bun run provider-conformance --self-test` runs every row against an in-process mock backend and
mock provider; it checks the harness only and its report says "No acceptance". Live runs drive a
remote backend through its authenticated client socket, on the host
(`~/runtime/backend/runtime/node apps/server/scripts/providerConformance/driver.ts --authority
<id>`) or from the laptop over the SSH relay (`--transport relay --ssh <target> --relay-node
<abs> --relay-entry <abs> --tuple <label>`). `--dry-run` lists what would run; `--providers`,
`--rows`, `--model provider=slug`, `--expect-needs-auth` and `--provision-copilot` (the only
installing action, Copilot only) narrow or extend a run; `--restore <workDir>` replays cleanup.
It writes a redacted, dated JSON and markdown matrix to `~/bigbud-conformance-results/`. See
[the harness report](reports/2026-11-18-provider-conformance-harness.md) for the per-tuple checklist.

### Remote backend graph (dev)

`bun run remote-backend-graph` assembles, signs and archives a complete backend graph from a
server build. It downloads the sha256-pinned Node 24.13.1 Linux runtime (or takes
`--node-archive`), installs `scripts/remote-backend-graph/package-lock.json` with
`npm ci --ignore-scripts --omit=dev --os=linux --cpu=<arch> --libc=glibc`, prunes
other-platform payloads, source maps and type declarations, copies everything into a private
`graph/` (directories 0700, files 0600/0700), writes `NOTICES.json`, signs with the producer
above, then writes a deterministic `.tar.gz`, `manifest.json` and `provenance.json` (whose
`buildDigest` covers the loader-policy hash) and verifies a test extraction. It needs network
access, npm and Python 3. Use a dev or fixture key; release keys and CI publication are not part
of this command.

```sh
(cd apps/server && bunx tsdown && bunx tsdown -c tsdown.clientRelay.config.ts)
bun run remote-backend-graph --target aarch64-unknown-linux-gnu --dist apps/server/dist \
  --output /tmp/bigbud-graph-$(date +%s) --key-file ~/dev-keys/graph-ed25519.pem \
  --key-id dev-graph --version 0.1.613-dev
```

tsdown runs on rolldown `1.1.5`, pinned by the root `overrides` in `package.json`. With an
unchanged source tree and lockfile, the server build is byte-identical between runs and
checkouts, so the archive sha256 and `buildDigest` are reproducible too. Both server tsdown
configs set `minify: false` and `optimization.inlineConst: false`. These keep the
`//#region` markers that the loader policy uses to attribute reviewed code.

The output directory must not exist. After a dependency or bundle change, add
`--list-loader-sites` (no key needed) to print each unreviewed loader site with its member and
hash, plus any other refusal, and leave an unsigned graph for inspection.

CI runs the same steps for `x86_64-unknown-linux-gnu` and `aarch64-unknown-linux-gnu` in
`.github/workflows/release-remote-backend-graph.yml`, then smoke-tests `server/bin.mjs --help`
offline in a Debian container (arm64 through QEMU). Tagged releases call it from `release.yml`,
sign with the `BIGBUD_REMOTE_AGENT_SIGNING_KEY` secrets and publish
`bigbud-backend-graph-<version>-<target>.tar.gz` (plus `.tar.gz.sha256`, `.manifest.json` and
`.provenance.json`). Manual dispatches and pull requests that touch the producer sign with a
throwaway key generated in the job (key id `ci-fixture-<run>-<attempt>`) and upload its public
key beside the artifacts; those graphs are for inspection only.

```sh
gh workflow run release-remote-backend-graph.yml --ref dev
```

Each graph also carries `THIRD_PARTY_NOTICES`, the text of every licence and notice file that
`NOTICES.json` lists, generated in the same step.

### Rust dependency licences

`bun run licenses:rust` writes a licence inventory for one workspace crate's dependency closure
(default `bigbud-remote-agent`) from `cargo metadata --locked --filter-platform <target>`. Each
crate is marked `linked` or `build-time` with its declared licence and the hashes of the licence
files in its source. `--notices-output` also writes a `THIRD_PARTY_NOTICES` text for the linked
crates. Outputs must not exist. Add `--offline` when the crate sources are already fetched. See
[the release handoff](validation/remote-backend-release-handoff.md).

```sh
bun run licenses:rust --target x86_64-unknown-linux-musl --output /tmp/agent-licenses.json \
  --notices-output /tmp/agent-THIRD_PARTY_NOTICES
bun run licenses:rust --package bigbud-mobile-gateway --target aarch64-unknown-linux-gnu \
  --output /tmp/gateway-licenses.json
```

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

| Bun                                            | just                                        |
| ---------------------------------------------- | ------------------------------------------- |
| `bun run smoke:desktop-supervisor`             | `just smoke-desktop-supervisor`             |
| `bun run verify:packaged-desktop-supervisor`   | `just verify-packaged-desktop-supervisor`   |
| `bun run dist:desktop:artifact`                | `just dist-desktop-artifact`                |
| `bun run dist:desktop:dmg`                     | `just dist-desktop-dmg`                     |
| `bun run dist:desktop:dmg:arm64`               | `just dist-desktop-dmg-arm64`               |
| `bun run dist:desktop:dmg:x64`                 | `just dist-desktop-dmg-x64`                 |
| `bun run dist:desktop:linux`                   | `just dist-desktop-linux`                   |
| `bun run dist:desktop:linux:dir`               | `just dist-desktop-linux-dir`               |
| `bun run dist:desktop:linux:deb`               | `just dist-desktop-linux-deb`               |
| `bun run verify:desktop:linux-artifact`        | `just verify-desktop-linux-artifact`        |
| `bun run verify:published-remote-agent-script` | `just verify-published-remote-agent-script` |
| `bun run dist:desktop:win`                     | `just dist-desktop-win`                     |
| `bun run release:smoke`                        | `just release-smoke`                        |

`verify:published-remote-agent-script` compares `https://bigbud.app/remote-agent.sh` with
`apps/marketing/public/remote-agent.sh` by SHA-256; `--release v<x.y.z>` also checks that
release's `remote-agent.sh` asset. Requests are bounded (15 s deadline, 256 KiB, at most 5
redirects, HTTPS only to `bigbud.app`/`www.bigbud.app`, or GitHub's release download hosts for the
asset); a redirect to `raw.githubusercontent.com` is reported as a D3 violation. Exit codes: 0
match, 1 mismatch or disallowed redirect, 2 unreachable.

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

| Bun                                                            | just                                             |
| -------------------------------------------------------------- | ------------------------------------------------ |
| `bun run --cwd apps/mobile-web dev`                            | `just mobile-web-dev`                            |
| `bun run --cwd apps/mobile-web build`                          | `just mobile-web-build`                          |
| `bun run --cwd apps/mobile-web build:desktop`                  | `just mobile-web-build-desktop`                  |
| `bun run --cwd apps/mobile-web preview`                        | `just mobile-web-preview`                        |
| `bun run --cwd apps/mobile-web typecheck`                      | `just mobile-web-typecheck`                      |
| `bun run --cwd apps/mobile-web typecheck:desktop-reference`    | `just mobile-web-typecheck-desktop-reference`    |
| `bun run --cwd apps/mobile-web test`                           | `just mobile-web-test`                           |
| `bun run --cwd apps/mobile-web test:browser`                   | `just mobile-web-test-browser`                   |
| `bun run --cwd apps/mobile-web test:browser:isolation`         | `just mobile-web-test-browser-isolation`         |
| `bun run --cwd apps/mobile-web test:browser:rejection-resume`  | `just mobile-web-test-browser-rejection-resume`  |
| `bun run --cwd apps/mobile-web test:browser:visual-viewport`   | `just mobile-web-test-browser-visual-viewport`   |
| `bun run --cwd apps/mobile-web test:browser:host-access:linux` | `just mobile-web-test-browser-host-access-linux` |

The host-access browser harness runs only inside the existing disposable Linux Electron fixture.
It requires its audited public source at `/parity/src`, installed fixture dependencies, a writable
`/parity/results` directory, and `MOBILE_PARITY_ALIASES_PATH` pointing to the public package-alias
JSON. It starts no host browser or account session and installs no tools. The recorded five-case
checks use synthetic HTTPS hosts and do not qualify a real VPS or phone.
Set `MOBILE_HOST_ACCESS_SURFACES=controls` to check host menus, blocked-host actions and settings.
Optional comma-separated `MOBILE_HOST_CONTROL_CASES` (`blocked,settings,cross-host`) and
`MOBILE_HOST_CONTROL_SIZES` (`360-portrait,390-portrait,430-portrait,landscape,keyboard`) narrow
those checks. Keyboard mode simulates a scale-one visual viewport; it does not exercise a phone keyboard.
Set `MOBILE_HOST_ACCESS_SURFACES=resume` for normal/StrictMode host-isolated recovery scenarios.
These use controlled online/visibility events, intercepted sockets and an elapsed-time clock jump;
they do not qualify physical suspension or real gateway/server execution.
For the original five host-access scenarios, optional `MOBILE_HOST_ACCESS_CASES` selects exact
case names recorded by the harness, separated by commas; empty or unknown names fail.

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

## Workspace: packages/ui

Source: [packages/ui/package.json](../packages/ui/package.json). Shared presentation only; tests use Vitest.

| Bun                                   | just                |
| ------------------------------------- | ------------------- |
| `bun run --cwd packages/ui typecheck` | `just ui-typecheck` |
| `bun run --cwd packages/ui test`      | `just ui-test`      |

Focused presentation regression: `bun run --cwd packages/ui vitest run src/alert.test.tsx`.

### Remote agent operation recovery

`bigbud remote-agent install <target> [--replace] [--yes] [--json]` returns an operation ID.
If an initial or follow reply is lost, retain the reported ID and use
`bigbud remote-agent follow <operation-id> [--json]` with the same `--dev` / `--base-dir`
options. Follow is read-only and never starts another install. IDs are retained by the running
backend for a bounded period; unknown/expired after restart is not proof that no remote change
occurred. Inspect `bigbud remote-agent status <target>` before starting a new operation.

## Remote Linux account backend services

Run these commands as the actual unprivileged Linux account. Setup requires a complete signed
executable graph and separately supplied, owner-private JSON metadata. The trust file maps signing
key IDs to pinned Ed25519 public PEM keys; downloaded metadata cannot supply its own trust.

```sh
bigbud backend setup \
  --graph-root /home/account/runtime/backend \
  --graph-manifest /home/account/install/graph.json \
  --rust-manifest /home/account/install/remote-agent.json \
  --trusted-keys /home/account/install/trusted-public-keys.json \
  --backend-home /home/account/backend-data \
  --request-id 11111111-1111-4111-8111-111111111111 \
  --confirm-fresh-setup

bigbud backend status --authority 00000000000000000000000000000000
bigbud backend enable --authority 00000000000000000000000000000000 --confirm-startup
bigbud backend disable-boot --authority 00000000000000000000000000000000
bigbud backend start --authority 00000000000000000000000000000000
bigbud backend stop --authority 00000000000000000000000000000000
```

Replace the example paths, request UUID and authority. Keep executable files separate from backend
data and account service state. Setup stages the units and admits the signed Rust runtime; backend
startup remains disabled. `--restart never` opts out of the default failure restart policy.
Enable verifies completed setup and finite preflight before requesting startup. Status reports unit
state without claiming backend readiness. Disable-boot prevents automatic startup while current work
continues. Start launches the staged backend for this session without enabling boot startup or
changing lingering; the backend then starts its Rust unit. Stop ends both units, including Rust
terminals, and keeps configuration, data and boot policy. A partial setup must be preserved for inspection; repeating its request does not repair or
overwrite it. These are installed CLI subcommands, with no separate Bun script or just recipe.

## Remote account mobile pairing

Run this on the Linux remote account with a compatible installed backend CLI. Replace the example
identifier and hostname with that host's authority and configured private HTTPS gateway origin:

```sh
bigbud mobile pair \
  --authority 00000000000000000000000000000000 \
  --origin https://host.your-tailnet.ts.net \
  --scope read-only
```

All three flags are required. Scopes are `read-only`, `approve-only` and `thread-control`.
The command uses the account's authenticated backend client socket and displays the authority,
scope, expiry and one-time pairing link. The backend requires current mobile consent and a ready
gateway with that exact configured origin. Installation and mobile enablement remain separate.
The installation-control socket cannot issue pairing links.

## Remote account mobile consent and activation

Run these on the Linux remote account, against its running backend. They use the same
authenticated backend client socket as `mobile pair`. Every command except `inputs set` accepts
`--json`; a refusal or an unreachable socket exits with status 1.

```sh
# One-time, owner-private proof inputs (read by the backend at its next start).
bigbud mobile inputs set \
  --authority 00000000000000000000000000000000 \
  --trusted-keys /home/account/install/trusted-public-keys.json \
  --gateway /home/account/install/mobile-gateway.json \
  --gateway-file /home/account/install/bigbud-mobile-gateway \
  --assets /home/account/install/mobile-assets.json \
  --assets-file /home/account/install/mobile-assets.tar.gz

bigbud mobile status --authority 00000000000000000000000000000000
bigbud mobile enable --authority 00000000000000000000000000000000 --confirm-consent
bigbud mobile activate --authority 00000000000000000000000000000000 \
  --origin https://host.your-tailnet.ts.net --port 49322
bigbud mobile stop --authority 00000000000000000000000000000000
```

`enable` is the only way to grant durable mobile consent and refuses to run without
`--confirm-consent`; turning mobile access off in settings revokes it. `activate` reports an
acknowledgement, not readiness; check `status`. `inputs set` never replaces an existing inputs
file. See [docs/REMOTE_MOBILE_INPUTS.md](REMOTE_MOBILE_INPUTS.md) for the file format and the consent
revision rules. These are installed CLI subcommands, with no separate Bun script or just recipe.

## Focused optional-component CAS proof

The isolated Linux CAS fixture requires an explicitly selected, already cached Node/Bun image.
Set `BIGBUD_TEST_MOBILE_CAS_IMAGE` to its existing image ID before this focused run:

```sh
env -u BIGBUD_TEST_AGENT_FIXTURES BIGBUD_TEST_LINUX_DOCKER=1 \
  BIGBUD_TEST_MOBILE_CAS_IMAGE="$BIGBUD_TEST_MOBILE_CAS_IMAGE" \
  bun run --cwd apps/server vitest run --configLoader runner --project integration \
  src/remote-agent/remoteAgentInstall.mobile.linux.test.ts
```

The fixture uses `--pull=never`, disables network and rejects fixture-state mounts. It tests the
existing CAS protocol using disposable public inputs; it does not install a compiler or activate
a host service. Without explicit fixture enablement/image availability these cases are skipped,
which does not count as Linux qualification.
