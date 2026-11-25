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

On macOS, prefix `bun run dev` / `just dev` or `bun run dev:desktop` / `just dev-desktop` with `BIGBUD_SSH_OWNER=1` to build the owner and run the normal app with a separate development profile and one disposable SSH target. See the [manual test runbook](/Users/youpele/DevWorld/bigbud/protocol/ssh-owner/MANUAL-TEST.md#macos-normal-app-dev-opt-in). This flag is off by default and cannot activate in packaged releases.

For the stock OpenSSH backend replacement proof, run `BIGBUD_SSH_OWNER=1 BIGBUD_SSH_OWNER_RETAIN=1 bun run dev` (or `just dev` with the same environment). This is non-root macOS Bun development only, with the generated loopback target and no custom SSH config. The launcher keeps the fixture alive across one unexpected backend exit; stopping the launcher retires it. The default, desktop, Linux, Windows, and packaged launch paths do not enable retention.

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
| `bun run licenses:mobile-web`        | `just licenses-mobile-web`        |
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
  --gateway-notices /build/gateway-THIRD_PARTY_NOTICES \
  --assets-notices /build/mobile-assets-THIRD_PARTY_NOTICES \
  --output-directory /build/fresh-mobile-artifacts
```

`--gateway-notices` and `--assets-notices` are plain-text notice files (generate them with
`bun run licenses:rust --package bigbud-mobile-gateway --target <triple> --notices-output …` and
`bun run licenses:mobile-web --notices-output …`). They are copied unchanged beside the artifacts
as `<artifact file>.THIRD_PARTY_NOTICES`; they are not signed and `manifest.json` does not list
them.

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
`NOTICES.json` lists, generated in the same step. For packages that publish no licence file, the
upstream licence files vendored in `scripts/remote-backend-graph/licenses/` (source URL, ref,
SHA-256 and retrieval date in its `manifest.json`) are hash-checked and shipped under
`notices/vendored/<name>@<version>/`. Vendored files must keep their exact upstream bytes; the
directory is excluded from `oxfmt` and from line-ending normalisation.

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

Release builds publish `bigbud-remote-agent-<version>-<target>.THIRD_PARTY_NOTICES` and
`.licenses.json` beside each remote agent binary, generated by this command in
`release-remote-agent-build.yml`; the signed manifests list only the binaries.

### Mobile web licences

`bun run licenses:mobile-web --output <inventory.json> [--notices-output <file>]` writes the
licence inventory and `THIRD_PARTY_NOTICES` text for the production npm dependency closure of
`apps/mobile-web` (`dependencies` and installed peers, followed through the installed workspace;
dev and optional dependencies are not followed), plus the project `LICENSE`. Run `bun install`
first. The closure is a superset of what Vite bundles. Outputs must not exist.

## Root: checks, tests, and cleanup

**Typecheck exit code and Effect diagnostics.** Each workspace `prepare` script patches the installed TypeScript so `@effect/language-service` diagnostics run during `tsc --noEmit`. Suggestions print as `message TS…` and warning-category diagnostics print as `warning TS…`; only error-category diagnostics should fail the gate. `apps/server` sets `ignoreEffectSuggestionsInTscExitCode` and `ignoreEffectWarningsInTscExitCode`, so the exit code reflects only error-category diagnostics: native type errors and Effect rules configured as `error` (for example `importFromBarrel`) still fail the gate, while `message TS…` and `warning TS…` output is advisory. When error diagnostics are present the exit code is `1` or `2` depending on whether that run wrote `tsconfig.tsbuildinfo`; both mean failure. A non-zero exit with no `error TS…` line is a crash rather than a type failure; a full rebuild after deleting `tsconfig.tsbuildinfo` needs `NODE_OPTIONS=--max-old-space-size=8192`. TypeScript replays the plugin diagnostics recorded in `tsconfig.tsbuildinfo`, so a changed `diagnosticSeverity` does not take effect on a warm incremental run; delete `tsconfig.tsbuildinfo` and rebuild before trusting the result. The other plugin-configured packages (`apps/web`, `apps/mobile-web`, `packages/contracts`, `scripts`) still use the plugin default where warnings affect the exit code; set the same option there if they begin to emit warnings.

| Bun                                 | just                             |
| ----------------------------------- | -------------------------------- |
| `bun run typecheck`                 | `just typecheck`                 |
| `bun run lint`                      | `just lint`                      |
| `bun run check:test-file-length`    | `just check-test-file-length`    |
| `bun run test`                      | `just test`                      |
| `bun run test:packages`             | `just test-packages`             |
| `bun run test:server`               | `just test-server`               |
| `bun run test:desktop-smoke`        | `just test-desktop-smoke`        |
| `bun run ci:verify-shard-coverage`  | `just ci-verify-shard-coverage`  |
| `bun run ci:wait-for-verdict`       | `just ci-wait-for-verdict`       |
| `bun run ci:verify-release-publish` | `just ci-verify-release-publish` |
| `bun run fmt`                       | `just fmt`                       |
| `bun run fmt:check`                 | `just fmt-check`                 |
| `bun run clean`                     | `just clean`                     |

`test:packages` runs every package's tests except `@bigbud/server`; `test:server` runs only the
server's. Together they cover `bun run test`, and both keep Turbo's `^build` and strict env mode.
`test:server` ends in `--`, so Vitest arguments pass straight through, for example
`bun run test:server --project=integration --shard=1/8` (one CI shard).

The `ci:*` scripts are meant for CI and for local debugging of its reports.
`bun run ci:verify-shard-coverage --expected <list.json> --unit <unit.json> --shards-dir <dir> --shard-count <N> --package-dir apps/server`
checks that every server test file listed by `test:list-files` ran exactly once across the `unit`
report and the `integration-<i>.json` shard reports (Vitest JSON reporter output; the directory is
read non-recursively). It prints per-report totals, writes them to `$GITHUB_STEP_SUMMARY` when set,
and exits 1 on a missing, duplicated, unexpected or failing file, or a missing shard report.

`bun run ci:wait-for-verdict --repo <owner/name> --sha <40-hex commit>` is the release gate. It
waits until a `ci.yml` run for exactly that commit (`push` or `workflow_dispatch` from the same
repository; `pull_request` and fork runs never count) has a successful `CI passed` job in its latest
attempt. Defaults: `--workflow ci.yml --job "CI passed" --timeout-minutes 70
--missing-grace-minutes 10 --poll-seconds 30`. It reads `GITHUB_TOKEN` (then `GH_TOKEN`) and exits
1 on a failed verdict, on no run after the grace period, or at the deadline. API errors are retried
and never count as a pass. The release `ci_gate` job runs the same file directly with
`node scripts/wait-for-ci-verdict.ts …`, because that job installs no dependencies. To check a
commit locally: `GH_TOKEN="$(gh auth token)" bun run ci:wait-for-verdict --repo youpele52/bigbud --sha "$(git rev-parse HEAD)"`.

`bun run ci:verify-release-publish resolve --github-output <file>` expands the newline-separated
globs in `RELEASE_FILE_PATTERNS` into one deduplicated file list (it fails on an unmatched pattern or
two files with the same asset name). `bun run ci:verify-release-publish verify --repo <owner/name>
--tag <tag> --prerelease <true|false> --make-latest <true|false|legacy> [--attempts 3]` finds the
release (drafts included), re-uploads missing, incomplete or wrong-size assets with
`gh release upload --clobber`, publishes a draft left behind by a failed upload, and exits 1 unless
every asset is uploaded and the release is published with the right channel. `verify` changes the
release, so it is meant for the release job (`node scripts/verify-release-publish.ts …`), not for
local experiments.

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
| `bun run verify:desktop:mac-architecture`      | `just verify-desktop-mac-architecture`      |
| `bun run verify:published-remote-agent-script` | `just verify-published-remote-agent-script` |
| `bun run dist:desktop:win`                     | `just dist-desktop-win`                     |
| `bun run release:smoke`                        | `just release-smoke`                        |

`verify:desktop:mac-architecture <release-root> <arm64|x64>` fails unless every Mach-O file in
each packaged `.app` under the release root contains that architecture (universal files that
include it pass) and lists the offenders. CI and the release workflow run it after every macOS
build; it guards the macOS x64 app, which is cross-built on Apple Silicon.

`verify:published-remote-agent-script` checks that the retired `https://bigbud.app/remote-agent.sh`
returns 404. `--download <ref>` follows `https://bigbud.app/download/<ref>/remote-agent` and
`--release v<x.y.z>` fetches that release's `remote-agent.sh` asset; each must equal
`scripts/release-assets/remote-agent.sh` by SHA-256 once the stamped `DEFAULT_VERSION` line is
normalised, and the stamp must name the release the link resolved to. Requests are bounded (15 s
deadline, 256 KiB, at most 5 redirects, HTTPS only to `bigbud.app`/`www.bigbud.app`, or GitHub's
release download hosts); a redirect to `raw.githubusercontent.com` is reported as a D3 violation.
Exit codes: 0 as expected, 1 mismatch or disallowed redirect, 2 unreachable.

### Download links

The marketing site's Pages advanced-mode worker (`apps/marketing/worker/index.ts`, bundled into
`dist/_worker.js` by `bun run --cwd apps/marketing build`) redirects to a release's
`remote-agent.sh` asset on GitHub. The release job stamps the version
into that asset, so `curl -fsSL <link> | sh` needs no environment variable.

| Link                                                | Resolves to                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| `https://bigbud.app/download/latest/remote-agent`   | Newest stable release that ships the script, else a plain-text 404 |
| `https://bigbud.app/download/stable/remote-agent`   | Same as `latest`                                                   |
| `https://bigbud.app/download/beta/remote-agent`     | Newest beta release only                                           |
| `https://bigbud.app/download/preview/remote-agent`  | Newest preview release only                                        |
| `https://bigbud.app/download/nightly/remote-agent`  | Newest nightly release only                                        |
| `https://bigbud.app/download/v<x.y.z>/remote-agent` | That tag (the leading `v` is optional), without an API call        |

Channels never fall back to another channel. The static `https://bigbud.app/remote-agent.sh` is
removed and returns 404.

Channel links ask the GitHub releases API first (an optional `GITHUB_TOKEN` secret raises its rate
limit). When it fails or is rate limited, the worker reads the public, token-free
`https://github.com/youpele52/bigbud/releases.atom` feed and checks the channel's newest tags (up
to three) for a `remote-agent.sh` asset before redirecting. The feed only lists recent releases,
so it never answers "no release": an empty result serves the last good release (cached 7 days)
or a 503.

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
| `bun run --cwd apps/marketing test`      | `just marketing-test`      |

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
| `bun run --cwd apps/server test:list-files`                           | `just server-test-list-files`                           |
| `bun run --cwd apps/server test:browser:install`                      | `just server-test-browser-install`                      |
| `bun run --cwd apps/server benchmark:startup-catalog`                 | `just server-benchmark-startup-catalog`                 |
| `bun run --cwd apps/server benchmark:mobile-recovery-memory`          | `just server-benchmark-mobile-recovery-memory`          |
| `bun run --cwd apps/server benchmark:terminal-host`                   | `just server-benchmark-terminal-host`                   |
| `bun run --cwd apps/server soak:terminal-host`                        | `just server-soak-terminal-host`                        |

### Terminal host qualification (Q1)

The local terminal host keeps terminals running across thread switches, backend restarts and
(in keep mode) app quits. It is **opt-in** until its qualification passes: start the app or
server with `BIGBUD_TERMINAL_HOST=1` (for example `BIGBUD_TERMINAL_HOST=1 bun run dev:desktop`).
`BIGBUD_TERMINAL_HOST=0` is the kill switch. The host is the `bigbud-remote-agent` binary;
build it first with `bun run build:workspace-agent` (debug) or
`cargo build --release --locked -p bigbud-remote-agent` (release). Set
`BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY` to choose a specific binary.

**Soak.** `bun run --cwd apps/server soak:terminal-host -- [options]` runs terminals against the
real binary and writes a JSON report (default `/tmp/bigbud-terminal-soak-<time>.json`); it exits
non-zero when a Q1 (b) criterion fails. Options: `--minutes` (default 5; the Q1 run is 1440),
`--terminals` (12), `--tui` (4 agent-like floods), `--sample-seconds` (15),
`--restore-seconds` (3), `--warmup-minutes` (60; short runs use a fifth of the duration),
`--flood-sleep` (0.05 s between TUI redraws), `--seed`, `--out`, and `--release` (use
`target/release/bigbud-remote-agent`). The report has host RSS, open file descriptors and
workspace roots per sample (the host writes a `terminal host stats:` line to its
`supervisor.log` when `BIGBUD_DEBUG_TERMINAL_HOST_STATS_MS` is set, which the soak does), restore
latency (subscribe to first screen item) p50/p95, cell-identical fidelity of restored prompt
screens against a reference xterm.js, unexpected closes and `modelInvalid` notices. Every soak
terminal is reported visible, so any idle or pressure close counts as unexpected.

```sh
cargo build --release --locked -p bigbud-remote-agent
bun run --cwd apps/server soak:terminal-host -- --minutes 1440 --release --out ~/soak-macos.json
```

**Release bench.** `bun run --cwd apps/server benchmark:terminal-host -- [--runs 3] [--out f]
[--skip-rss]` builds and runs the crate's ignored release benches with a clean `TMPDIR`: the R1
screen ingest rate (target ≥ 50 MiB/s) and snapshot serialisation, and the R5/R7 host RSS at 24
PTYs with two snapshots in flight (target ≤ 256 MiB; macOS runs use `MallocMaxMagazines=1` like
the shipped host). Close other apps first; the report records the load average.

**End-to-end tests** (real binary, opt-in):

```sh
BIGBUD_TERMINAL_HOST_IT=1 bun run --cwd apps/server vitest run \
  src/terminal-host/localTerminalHost.e2e.restore.it.test.ts \
  src/terminal-host/localTerminalHost.e2e.lifecycle.it.test.ts \
  src/terminal-host/localTerminalHost.e2e.quit.it.test.ts
```

They use the debug host's test clocks, which release builds ignore and which reach the host
through the `BIGBUD_DEBUG_TERMINAL_*` environment: `BIGBUD_DEBUG_TERMINAL_IDLE_MS` (idle
timeout; the warning comes at half of it), `BIGBUD_DEBUG_TERMINAL_HOST_SELF_EXIT_MS` (orphaned
empty host exit) and `BIGBUD_DEBUG_TERMINAL_PRESSURE` (`normal`, `low` or `critical`).

**Cross-engine fidelity.** `bun run --cwd apps/server vitest run
src/terminal/Layers/TerminalScreenFidelity.goldens.test.ts` restores every R1 screen golden in
`@xterm/headless`. To add randomized streams, export them from the crate and point the test at
them:

```sh
BIGBUD_SCREEN_EXPORT_RANDOM=/tmp/screen-random BIGBUD_SCREEN_EXPORT_COUNT=1000 \
  cargo test -p bigbud-remote-agent --locked terminal_screen::tests::goldens::export_random_stream_goldens
BIGBUD_SCREEN_GOLDENS_RANDOM_DIR=/tmp/screen-random bun run --cwd apps/server vitest run \
  src/terminal/Layers/TerminalScreenFidelity.goldens.test.ts
```

The manual checklist is
[docs/reports/2026-11-22-terminal-host-qualification-checklist.md](reports/2026-11-22-terminal-host-qualification-checklist.md).

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

`bigbud remote-agent install <target> [--replace | --keep-previous] [--yes] [--json]` returns an
operation ID. **Older agent builds are retired by default** once the new build is active.
Retirement is deferred while live work still uses an older build, never interrupts live terminals,
and a retirement failure never affects activation. When neither flag is given and the terminal is
interactive (no `--json`), the CLI first reads `status`; if an approved host already runs an older
agent version it asks `An older agent build (<version>) is installed on <target>. Replace it after
the new one is active? [Y/n]` (empty, `y` or `yes` replaces; `n`/`no` keeps). The `--yes`
host-consent prompt is never preceded by this question for an unapproved host, and unreadable
status skips it. Without a TTY, with `--json`, or when status is unreadable, older builds are
replaced and a one-line hint naming `--keep-previous` is printed to stderr. `--replace` replaces
and `--keep-previous` keeps, both without asking; passing both is a usage error (exit 4). If the
operation stops because the host is at its two-build capacity because live work still uses the
older build, the reply explains that no slot could be freed and to retry after that work ends (and,
with `--keep-previous`, to let future installs replace older builds).

The app follows the same default: the settings **Replace** action, and **Connect new session**
after a staged install or update, retire older builds once the new build is active and show the
deferral notice when live work keeps one. The `remote_agent_install` agent tool replaces by default;
`replace: false` keeps older builds. Retirement selects builds by exact build ID, so installing the
musl agent over a same-version glibc build retires the glibc build too.

If an initial or follow reply is lost, retain the reported ID and use
`bigbud remote-agent follow <operation-id> [--json]` with the same `--dev` / `--base-dir`
options. Follow is read-only and never starts another install. IDs are retained by the running
backend for a bounded period; unknown/expired after restart is not proof that no remote change
occurred. Inspect `bigbud remote-agent status <target>` before starting a new operation.

### Removing the remote agent

`bigbud remote-agent remove <target> [--switch-to-direct-ssh | --keep-transport] [--yes] [--json]`
deletes only `~/.bigbud/agent` on the host, then disconnects it in bigbud. It refuses, and lists
the blockers, while live work uses any agent build (a chat that is working, open terminals,
processes, file watchers, staging, a connection being set up) or while a remote backend service
depends on the agent. A registry fence stops other bigbud apps from starting work on the host
during removal, and the tree is renamed away under the install locks before it is deleted.
`~/.bigbud/backend-*`, `graph`, `workspace-modes` and user-managed binaries outside the tree are
never touched, and nothing is ever killed. Workspaces on that host move to Direct SSH by default;
`--keep-transport` leaves them on the agent, and passing both flags is a usage error (exit 4).
Interactive runs ask for confirmation; without a TTY or with `--json`, pass `--yes` (otherwise
exit 2). Exit codes: 0 removed, 3 blocked, 4 failed, 6 backend unavailable. Settings → Remote
agents → **Remove agent** runs the same removal. Connecting with the remote agent afterwards
uploads and installs it fresh.

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
bigbud backend stop --authority 00000000000000000000000000000000 --for-upgrade
bigbud backend stop --authority 00000000000000000000000000000000 --for-upgrade --i-have-saved-my-work
```

`--for-upgrade` runs the W3.2 drain before the unit stops. The CLI sends one bounded request to the
running backend's owner-only drain socket. Without `--i-have-saved-my-work`, an attached UI must
confirm the pane drain; the CLI otherwise exits with `consent-required` and nothing is drained.
The explicit flag is the recorded non-interactive consent. A foreign token, unknown artifact,
concurrent drain, cancel or failure exits non-zero with a typed reason and writes no marker. The
deployed unit uses this path from `ExecStop` before graph replacement. The live backend drain
handler and installer/updater hook are still pending, so the current command can return
`unavailable` rather than faking success.

Replace the example paths, request UUID and authority. Keep executable files separate from backend
data and account service state. Setup stages the units and admits the signed Rust runtime; backend
startup remains disabled. `--restart never` opts out of the default failure restart policy.
With `--restart never`, a runtime update whose new runtime crashes on start is not relaunched by
systemd, so the launcher's automatic rollback to the previous runtime waits for the next manual
`backend start`, which counts as another launch attempt toward the rollback. Keep the default when hosts
receive unattended runtime updates.
Enable verifies completed setup and finite preflight before requesting startup. Status reports unit
state without claiming backend readiness. Disable-boot prevents automatic startup while current work
continues. Start launches the staged backend for this session without enabling boot startup or
changing lingering; the backend then starts its Rust unit. Stop ends both units, including Rust
terminals, and keeps configuration, data and boot policy. A partial setup must be preserved for inspection; repeating its request does not repair or
overwrite it. These are installed CLI subcommands, with no separate Bun script or just recipe.

## Offline database commands

`bigbud canonical-thread-cleanup`, `bigbud canonical-event-compaction` and
`bigbud legacy-orphan-recovery` open `state.sqlite` directly. Both their dry-run and `--apply`
forms hold `<stateDir>/backend.lock` before the database or migrations open, so a live backend
is refused with exit 1 instead of racing it. Stop the desktop app/backend, or use a different
`BIGBUD_HOME`. `--apply` on cleanup and orphan recovery still requires `--server-stopped`.
Commands that delegate to a running backend (`backend`, `mobile`, `peer`, `remote-agent`,
`command-line`, and the root server) take no CLI-side copy of the lock, except
`backend stop --for-upgrade`, which acquires it because it performs the offline W3.2 drain.

### Owner retirement recovery (operator only)

If the SSH owner refuses with `ownerRetirementUnverified`, stop bigbud and re-verify the exact
journal record before doing anything else:

```sh
bigbud-ssh-owner --retirement-recover \
  --lock <stateDir>/backend.lock \
  --record owner.retirement.master.<slot>
```

The command re-reads the record and clears it only when the recorded process is provably absent
or provably belongs to a different process (PID reuse). A live exact instance, an unreadable
record and an unknown name all refuse. It never signals or adopts a process. Use the full record
name printed by the journal (one per master/connector instance); do not delete files by hand.

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
