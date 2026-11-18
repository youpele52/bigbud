# Remote backend release handoff: shipped bytes, sources and licence evidence

**Date:** 18 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M5 WP-6B;
"Step6 release closure" in the
[remote agent plan](../plans/2026-11-13-remote-agent-manual-install-plan.md).
**Inputs:** [graph producer report](../reports/2026-11-17-remote-backend-graph-m1.md),
[provider provisioning report](../reports/2026-11-18-provider-provisioning-recipes.md),
[D4 cutover prep](../reports/2026-11-17-d4-musl-only-cutover-prep.md), the 14 November release
verification notes ("P7 packaging inputs and notice provenance"), `NOTICES.json` of the arm64
graph built on 17 November, and `cargo metadata` for the Rust crates.

This is an inventory for the person who signs and publishes the release. It records what each
artifact carries, where the bytes come from, what licence is declared and what licence text is
actually shipped. **It is not a legal review and draws no legal conclusions.** Plan decision 13
leaves redistribution terms, signing keys and publication to the user; those items are listed
under [User decisions required](#user-decisions-required).

Evidence levels used below:

- **file present**: a licence or notice file ships inside the artifact next to the bytes.
- **declared only**: package metadata names a licence, but no licence text ships with it.
- **missing**: neither a licence file nor a licence declaration.

## Project attribution

| Item                 | Fact                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project              | bigbud, a fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code), source at `github.com/youpele52/bigbud`                                                    |
| Root licence         | `LICENSE`, MIT, text begins `Copyright (c) 2026 T3 Tools Inc.`. It has no separate bigbud copyright line.                                                             |
| Rust crates          | `Cargo.toml` `[workspace.package] license = "MIT"`; every crate uses `license.workspace = true`. No crate directory has its own licence file.                         |
| npm packages         | `apps/server` 0.1.613 (`@bigbud/server`). The graph externals manifest `scripts/remote-backend-graph/package.json` is `UNLICENSED` (a private install manifest only). |
| In the backend graph | `LICENSE` (the root file) at the archive root, recorded in `NOTICES.json` as `kind: "project"`, `license: "MIT"`.                                                     |
| In other artifacts   | Remote agent, mobile gateway and mobile assets: unsigned `<artifact>.THIRD_PARTY_NOTICES` sidecars (see byte groups 2 and 3). `remote-agent.sh` has no header.        |

## Release artifacts at a glance

| Artifact                                                                    | Built by                                              | Published by                                | Signed                                                      |
| --------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| `bigbud-backend-graph-<v>-<target>.tar.gz` (+ manifest, provenance, sha256) | `.github/workflows/release-remote-backend-graph.yml`  | `release.yml` (GitHub release)              | Ed25519 manifest, `BIGBUD_REMOTE_AGENT_SIGNING_KEY`         |
| `bigbud-remote-agent-<v>-<target>` (gnu and musl, x64 and arm64)            | `.github/workflows/release-remote-agent-build.yml`    | `release.yml`                               | Ed25519 manifests (`remote-agent-manifest*.json`), same key |
| `mobile-gateway-<v>-<target>`, `mobile-assets-<v>.tar.gz`                   | `bun run package:mobile-components` (manual)          | Not in any workflow                         | Ed25519 metadata, key chosen at packaging time              |
| `remote-agent.sh`                                                           | Checked in at `apps/marketing/public/remote-agent.sh` | `release.yml` asset and the bigbud.app site | No (verified by SHA-256 against the release)                |

## Byte group 1: backend graph (glibc Linux, x86_64 and aarch64)

Figures are from the 17 November arm64 graph (8,048 files, 354,175,499 bytes, 168 notice
entries). Each graph carries `LICENSE`, `runtime/LICENSE`, `NOTICES.json` (one entry per
component with declared licence and the SHA-256 of every notice file) and, from this change,
`THIRD_PARTY_NOTICES` (the text of every one of those files, see
[Gaps closed mechanically](#gaps-closed-mechanically)).

| Component                                                                                              | Version                                                            | Source of the bytes                                                                                                                                                                                                    | Declared licence                                                                                            | Evidence in the graph                                                                                                                                                                                                                                   | Action for the user                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server bundle `server/*.mjs`, `NodeSqliteWorker.mjs`, `server/remote-client-relay/`                    | 0.1.613 (`buildInputs.sourceRevision` records the commit)          | This repository, `apps/server` built with `tsdown` (both configs); source maps are not shipped                                                                                                                         | MIT (project)                                                                                               | file present (`LICENSE`)                                                                                                                                                                                                                                | Build releases from a clean tree; the release job already refuses a dirty one.        |
| Private Node runtime `runtime/node`                                                                    | 24.13.1                                                            | Official `nodejs.org` `node-v24.13.1-linux-{x64,arm64}.tar.xz`, pinned by SHA-256 in `NODE_RUNTIME_PINS` (`30215f90…1089` x64, `c827d3d3…34c1` arm64)                                                                  | Not set in `NOTICES.json` (`license: null`); the Node LICENSE file covers Node and its bundled dependencies | file present: `runtime/LICENSE` from the same tarball (145,496 bytes, sha256 `9ef8d3fa…27a3`), listing 43 bundled projects (V8, OpenSSL, ICU, libuv, undici, zlib, …)                                                                                   | None required. Note: SQLite, which `node:sqlite` provides, is not named in that file. |
| Effect                                                                                                 | 4.0.0-beta.43, **patched** by `patches/effect@4.0.0-beta.43.patch` | npm, inlined into the bundle                                                                                                                                                                                           | MIT                                                                                                         | file present (`notices/bundled/effect@4.0.0-beta.43/LICENSE`)                                                                                                                                                                                           | Be aware the shipped Effect code is modified.                                         |
| Claude agent SDK `@anthropic-ai/claude-agent-sdk`                                                      | 0.3.310                                                            | npm, inlined into the bundle (JS only; the Claude CLI is user-installed)                                                                                                                                               | `SEE LICENSE IN README.md`                                                                                  | file present: `LICENSE.md`, text "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."                                                                    | **Decision 1** below.                                                                 |
| Muse SDK `@muse-code/sdk`                                                                              | 1.4.14                                                             | npm, inlined                                                                                                                                                                                                           | MIT                                                                                                         | file present                                                                                                                                                                                                                                            | None.                                                                                 |
| OpenCode clients `@opencode/client`, `@opencode-ai/sdk`                                                | 2.1.4, 1.17.13                                                     | npm, inlined                                                                                                                                                                                                           | MIT                                                                                                         | file present (vendored upstream `LICENSE`, see [vendored licences](#vendored-upstream-licences))                                                                                                                                                        | None (decision 2 resolved).                                                           |
| `@xterm/headless`, `@xterm/addon-serialize`                                                            | 6.1.0-beta.304, 0.15.0-beta.301                                    | npm, inlined                                                                                                                                                                                                           | MIT                                                                                                         | file present (vendored upstream `LICENSE`)                                                                                                                                                                                                              | None (decision 2 resolved).                                                           |
| Other inlined packages (39 `bundled` entries in total, e.g. `ws`, `yaml`, `msgpackr`, `@pierre/diffs`) | per `NOTICES.json`                                                 | npm, inlined; found through the bundle's `//#region` markers                                                                                                                                                           | per entry                                                                                                   | file present for all                                                                                                                                                                                                                                    | None.                                                                                 |
| Copilot SDK `@github/copilot-sdk`                                                                      | 1.0.28                                                             | npm, external (`scripts/remote-backend-graph/package-lock.json`, sha512 integrity)                                                                                                                                     | MIT                                                                                                         | file present (vendored): upstream `LICENSE` from the public `github/copilot-sdk` repository at `v1.0.28` and the GitHub Copilot CLI licence                                                                                                             | None (decisions 1 Copilot part and 2 resolved).                                       |
| Copilot linux runtime `@github/copilot-sdk-{linux-x64,linux-arm64}`                                    | 1.0.28                                                             | npm, external. Carries `prebuilds/linux-*/runtime.node` (122,749,312 bytes on arm64), `copilot-runtime`, `ripgrep/bin/linux-*/rg` and `tgrep/bin/linux-*/tgrep`. `repository` points at `github/copilot-agent-runtime` | MIT                                                                                                         | file present (vendored): GitHub Copilot CLI licence for the package; ripgrep 15.0.0 `COPYING`, `LICENSE-MIT`, `UNLICENSE`; PCRE2 10.46 `LICENCE.md` (linked into `rg`); microsoft/tgrep `LICENSE`. Rust crates linked into `rg`/`tgrep` are not covered | None (decisions 1 Copilot part and 2 resolved).                                       |
| Pi closure `@earendil-works/pi-*` (agent-core, ai, codemode, coding-agent, mcp, telemetry, tui)        | 1.4.0                                                              | npm, external                                                                                                                                                                                                          | MIT                                                                                                         | file present: vendored upstream `LICENSE` (repository root at `v1.4.0`) for the six packages; `pi-mcp` ships its own `LICENSES/` file. Native pi-tui addons and WASM (`photon_rs_bg.wasm`, `quickjs.wasm`) have no separate notices                     | None (decision 2 resolved).                                                           |
| koffi and `@koromix/koffi-linux-{x64,arm64}`                                                           | 3.2.1                                                              | npm, external; install script skipped (reviewed)                                                                                                                                                                       | MIT                                                                                                         | `koffi`: file present (`LICENSE.txt`); platform addon package: file present (vendored upstream `LICENSE.txt`)                                                                                                                                           | None (decision 2 resolved).                                                           |
| Other external packages (127 `package` entries in total)                                               | per `NOTICES.json`                                                 | npm, external                                                                                                                                                                                                          | per entry                                                                                                   | file present (the three `@aws-sdk/*` and `standardwebhooks` through vendored upstream licences) except `data-uri-to-buffer` 4.0.1 and `proxy-agent-negotiate` 1.1.0 (MIT): declared only, no licence file upstream                                      | None; the two remain recorded as "no licence file upstream".                          |

The 19 entries that shipped no licence or notice file in the 17 November arm64 graph, and their
evidence level now:

| Kind        | Packages                                                                                                                         | Evidence now                                |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| bundled (4) | `@opencode/client@2.1.4`, `@opencode-ai/sdk@1.17.13`, `@xterm/addon-serialize@0.15.0-beta.301`, `@xterm/headless@6.1.0-beta.304` | file present (vendored)                     |
| Copilot (2) | `@github/copilot-sdk@1.0.28`, `@github/copilot-sdk-linux-arm64@1.0.28`                                                           | file present (vendored)                     |
| Pi (6)      | `@earendil-works/pi-{agent-core,ai,codemode,coding-agent,telemetry,tui}@1.4.0`                                                   | file present (vendored)                     |
| koffi (1)   | `@koromix/koffi-linux-arm64@3.2.1`                                                                                               | file present (vendored)                     |
| other (4)   | `@aws-sdk/credential-provider-http`, `@aws-sdk/credential-provider-login`, `@aws-sdk/nested-clients`, `standardwebhooks@1.3.0`   | file present (vendored)                     |
| other (2)   | `data-uri-to-buffer@4.0.1`, `proxy-agent-negotiate@1.1.0`                                                                        | declared only; **no licence file upstream** |

The x86_64 graph substitutes the `linux-x64` platform packages (also vendored); its exact list is
in its own `provenance.json` (`notices.withoutNoticeFiles`, and `notices.vendoredNoticeFiles` for
the entries that rely on vendored files), which every graph build records.

### Vendored upstream licences

Decision 2 (option a, real upstream files only, no text generated from metadata) is implemented in
`scripts/remote-backend-graph/licenses/`: one directory per `<name>@<version>` holding the files
byte for byte, and `manifest.json` recording, per file, the source URL, repository, ref, commit,
path, SHA-256 and retrieval date (18 November 2026). The graph stage verifies every hash before use
and refuses to build on a mismatch, copies the files to `notices/vendored/<name>@<version>/`, adds
them to the entry's `files` in `NOTICES.json` with an `upstream` record of their source, and
`THIRD_PARTY_NOTICES` prints each text with a "Vendored from …" line. A manifest entry applies only
to the exact name and version; after a version bump the package falls back to "no licence file"
until its licence is re-vendored. The directory is excluded from `oxfmt` and from line-ending
normalisation (`.gitattributes`), because one file (tgrep's) has CRLF line endings.

| Package                                  | Upstream file and source                                                                                                                  | SHA-256         |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `@opencode/client@2.1.4`                 | `LICENSE`, `anomalyco/opencode` tag `v2.1.4` (`68bc26b7…`), repository root (the package directory has none)                              | `625f0f61…cb6b` |
| `@opencode-ai/sdk@1.17.13`               | `LICENSE`, `anomalyco/opencode` tag `v1.17.13` (`10c894bd…`). The package has no `repository` field; its `homepage` names this repository | `625f0f61…cb6b` |
| `@xterm/headless@6.1.0-beta.304`         | `LICENSE`, `xtermjs/xterm.js` at the npm `gitHead` `5f141a31…`                                                                            | `b569f629…0ccd` |
| `@xterm/addon-serialize@0.15.0-beta.301` | `LICENSE`, `xtermjs/xterm.js` at the npm `gitHead` `c58ea363…`                                                                            | `b569f629…0ccd` |
| `@earendil-works/pi-*@1.4.0` (6)         | `LICENSE`, `earendil-works/pi` tag `v1.4.0` (`4a080252…`), repository root                                                                | `0457f5bc…3c48` |
| `@koromix/koffi-linux-{arm64,x64}@3.2.1` | `LICENSE.txt`, `Koromix/koffi` (no tags; last commit before the 3.2.1 publish, `59865a5a…`; the file is unchanged since 2023)             | `54abb741…2e0e` |
| `@aws-sdk/credential-provider-http`      | `LICENSE` (Apache-2.0), `aws/aws-sdk-js-v3` commit "Publish v3.1166.0" (`dee2abd8…`), where the package is 3.972.86; repository root      | `edea9145…6c3d` |
| `@aws-sdk/credential-provider-login`     | Same file, commit "Publish v3.1167.0" (`5b4a724f…`), where the package is 3.972.92                                                        | `edea9145…6c3d` |
| `@aws-sdk/nested-clients`                | Same file, commit `dee2abd8…`, where the package is 3.998.3                                                                               | `edea9145…6c3d` |
| `standardwebhooks@1.3.0`                 | `LICENSE`, `standard-webhooks/standard-webhooks` at the npm `gitHead` `daee8284…`, repository root                                        | `c71d239d…0ab4` |
| `@github/copilot-sdk@1.0.28`             | `LICENSE`, public `github/copilot-sdk` tag `v1.0.28` (`fa108e71…`). The declared repository `github/copilot-agent-runtime` is not public  | `2510b446…34f7` |
| Copilot SDK and both runtime packages    | `GitHub-Copilot-CLI-LICENSE.md` = `package/LICENSE.md` of the npm tarball `@github/copilot@1.0.105` (decision 1)                          | `b9680937…1628` |
| `@github/copilot-sdk-linux-{arm64,x64}`  | `rg`: `COPYING`, `LICENSE-MIT`, `UNLICENSE` from `BurntSushi/ripgrep` tag `15.0.0` (`3a612f88…`; the x64 binary reports that revision)    | per manifest    |
|                                          | `rg` links PCRE2 10.46: `LICENCE.md` from `PCRE2Project/pcre2` tag `pcre2-10.46` (`b2bd4254…`)                                            | `9cf7ac69…885a` |
|                                          | `tgrep`: `LICENSE` (MIT) from `microsoft/tgrep` tag `v1.2.5` (`0ef484c5…`). No version is embedded; identified by crate names and strings | `5baa259f…5029` |
| `data-uri-to-buffer@4.0.1`               | None: no licence file in `TooTallNate/node-data-uri-to-buffer` at the `gitHead` `85cd8c85…` (its README has an MIT section, not vendored) | n/a             |
| `proxy-agent-negotiate@1.1.0`            | None: no licence file at tag `proxy-agent-negotiate@1.1.0` (`b7e5f7cc…`), root or `packages/negotiate`                                    | n/a             |

tgrep's licence is the same at every tag (it has not changed since the repository's first commit),
so the version uncertainty does not affect the text. Rust crates linked into `rg` and `tgrep`
(memchr, regex, clap, blake3, …) are not separately covered.

Not in the graph: `dist/client`, `dist/mobile-web`, source maps, node-pty, Playwright, the
Darwin `workspace-agent` and `desktop-supervisor` binaries, the Claude CLI and every other
user-installed provider CLI (plan decisions 4 and 6).

### Bytes fetched on the host, not shipped by bigbud

Provisioning (decision 6) fetches the **Copilot CLI 1.0.105** onto the host from the vendor's
release, pinned by sha512 for eight OS/arch/libc tuples in
`apps/server/src/provider/Layers/Copilot/Runtime.release.ts`. bigbud does not host those bytes,
but it does select, verify and place them. The npm package `@github/copilot@1.0.105` carries
`LICENSE.md` (sha256 `b9680937…1628`), titled "GitHub Copilot CLI License". Its section 2,
"Redistribution Rights and Conditions", lists conditions including unmodified form, distribution
only as part of an application or service with material functionality beyond the Software, not
standalone, including a copy of the licence, and independent licensing of the application. By decision 1 that
file now ships in every graph for the Copilot SDK and its runtime package (vendored, see above).

## Byte group 2: Rust remote agent

| Item                       | Fact                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Crate                      | `crates/bigbud-remote-agent` 0.1.0 (release asset named with the app version), MIT via workspace                                                                                                                                                                                                                                               |
| Targets                    | `x86_64`/`aarch64` `-unknown-linux-gnu` (transition release only, D4) and `-unknown-linux-musl` (static)                                                                                                                                                                                                                                       |
| Toolchain                  | Rust 1.95.0 (`rust-toolchain.toml`); `cargo build --locked --release`; stripped                                                                                                                                                                                                                                                                |
| Linked code outside crates | Rust standard library (MIT OR Apache-2.0). musl targets statically link musl libc from Rust's self-contained target. gnu targets link the host glibc dynamically (not shipped).                                                                                                                                                                |
| Dependency closure         | `cargo metadata --locked --filter-platform <target>`: **71 crates**, **30 linked** into the binary and **41 build-time only** (build scripts, `prost-build`, `protoc-bin-vendored`, proc macros). Same set for all four Linux targets.                                                                                                         |
| Linked crates' licences    | MIT OR Apache-2.0 (most), MIT (`bytes`, `generic-array`, `mio`, `zmij` and the three workspace crates), Apache-2.0 (`prost`), ISC (`inotify`, `inotify-sys`), CC0-1.0 (`notify`), Unlicense OR MIT (`memchr`, `same-file`, `walkdir`)                                                                                                          |
| Evidence                   | Every linked crate ships licence files in its crates.io source (the three workspace crates use the root `LICENSE`). The 9 crates without licence files are all build-time `protoc-bin-vendored*` 3.2.0 crates (declared MIT, declared only), which supply `protoc` to the `bigbud-protocol` build script; their bytes do not enter the binary. |
| Shipped notices            | `bigbud-remote-agent-<v>-<target>.THIRD_PARTY_NOTICES` (linked crates' licence files plus the project `LICENSE`) and `.licenses.json` (inventory), release assets beside each binary; see decision 7. Unsigned; the binary and its signed manifests are unchanged.                                                                             |

Run `bun run licenses:rust --target <triple> --output <file.json> --notices-output <file>` to
produce the per-crate inventory and a `THIRD_PARTY_NOTICES` text for the linked crates (see
below). The aggregated text for the remote agent is about 225 KB (224,674 bytes for
`x86_64-unknown-linux-musl` on 18 November, 30 linked crates, every one with a licence file,
byte-identical on two runs). `release-remote-agent-build.yml` now runs this for each target and
`release.yml` refuses to publish unless both sidecars exist for all four targets.

## Byte group 3: mobile gateway and mobile assets

| Item                           | Version                                                  | Source                                                                                                                                                                        | Licence                                                                                      | Evidence                                                                                                                                                                                                                                                                                                  | Action                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bigbud-mobile-gateway` binary | 0.1.0 crate, versioned by `compatibility.gatewayVersion` | `crates/bigbud-mobile-gateway`, packaged by `scripts/package-mobile-components.ts`                                                                                            | MIT (workspace)                                                                              | `mobile-gateway-<v>-<target>.THIRD_PARTY_NOTICES` beside the binary (packager `--gateway-notices`)                                                                                                                                                                                                        | None (decision 7 resolved).                                                                                                                             |
| Gateway dependency closure     | `cargo metadata` for `aarch64-unknown-linux-gnu`         | crates.io (hyper 1.12.0, tokio 1.54.1, tokio-tungstenite 0.29.0, …)                                                                                                           | 50 crates, 43 linked; MIT, MIT OR Apache-2.0, BSD-2-Clause OR Apache-2.0 OR MIT (`zerocopy`) | file present in the crate sources for all 50; shipped in the gateway sidecar (374,648 bytes for `aarch64-unknown-linux-musl`)                                                                                                                                                                             | Generate with `bun run licenses:rust --package bigbud-mobile-gateway …`.                                                                                |
| `mobile-assets-<v>.tar.gz`     | `compatibility.mobileAssetVersion`                       | `apps/mobile-web` Vite build (React 19, TanStack, Effect, `@base-ui/react`, `@hugeicons/*`, `lucide-react`, `react-markdown`, `@pierre/diffs`, …) plus `public/` brand images | per package                                                                                  | `mobile-assets-<v>.tar.gz.THIRD_PARTY_NOTICES` beside the archive, from `bun run licenses:mobile-web`: the production npm dependency closure of `apps/mobile-web` (481 packages on 18 November; 3 without a licence file: `@hugeicons/core-free-icons@4.3.0`, `kubernetes-types@1.30.0`, `lru_map@0.4.1`) | The closure is a superset of what Vite bundles (it includes, for example, the `shadcn` CLI's tree, which `apps/mobile-web` lists under `dependencies`). |

The mobile artifacts are not published by any workflow today. `bun run package:mobile-components`
now requires `--gateway-notices` and `--assets-notices` and writes them unchanged as
`<artifact file>.THIRD_PARTY_NOTICES` next to the artifacts; `manifest.json`, the signed
metadata and the archive contents are unchanged.

## Byte group 4: install script

| Item          | Fact                                                                                                                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File          | `apps/marketing/public/remote-agent.sh`, POSIX `sh`, authored in this repository (MIT, no licence header)                                                            |
| Shipped as    | GitHub release asset `remote-agent.sh` and `https://bigbud.app/remote-agent.sh`                                                                                      |
| Current state | On 17 November the site served its HTML fallback, not the script (MISMATCH), and the v0.3.3 release has no `remote-agent.sh` (404). The script exists only on `dev`. |
| Verifier      | `bun run verify:published-remote-agent-script [--release v<x>]`                                                                                                      |

## Gaps closed mechanically

1. **Aggregated `THIRD_PARTY_NOTICES` in every graph.**
   `scripts/build-remote-backend-graph.notices.ts` gained `renderThirdPartyNotices`, and the
   stage writes `THIRD_PARTY_NOTICES` at the archive root right after collecting the
   `NOTICES.json` entries. For each entry, in `NOTICES.json` order, it prints the name, version,
   kind, declared licence and location, then the full text of each notice file (binary files are
   named with their size), or says that no licence or notice file ships. It re-hashes each file
   and refuses to build if one changed after it was inventoried. It interprets nothing.
   - The Node LICENSE was already shipped at `runtime/LICENSE` and listed in `NOTICES.json`.
   - The file is a normal signed member; the manifest stays at revision 1, `NOTICES.json` and
     its schema are unchanged, and both verifiers are unchanged. `isBackendGraphPath` and the
     Rust graph path check accept the name.
   - Determinism: `stage_is_deterministic` builds the graph twice from the same inputs and now
     also asserts byte-identical `THIRD_PARTY_NOTICES`, alongside the existing identical
     manifest and archive checks.
   - Real data: rendering from the 17 November arm64 graph's `NOTICES.json` and files gives a
     740,630-byte file (168 entries, 19 "no licence or notice file" sections), byte-identical
     on two renders and with every recorded hash matching. That is the size the next graph gains
     (uncompressed). A full graph rebuild was not run for this change: the current working
     tree's loader policy (another lane's uncommitted `policy.data.ts` edit) refuses both the
     17 November dist and today's dist at unreviewed loader sites, which is unrelated to notices.
2. **Rust dependency licence inventory.** `scripts/rust-dependency-licenses.ts` (CLI) and
   `.logic.ts` read `cargo metadata --locked --filter-platform <target>` (no new tools or
   dependencies), walk the closure from one workspace crate (default `bigbud-remote-agent`),
   ignore dev-only edges, classify each crate as `linked` or `build-time`, record its declared
   licence, `license_file` and the hashes of the licence files in its source, and write a JSON
   inventory (with the `Cargo.lock` SHA-256 and no machine paths) plus an optional
   `THIRD_PARTY_NOTICES` text of the linked crates. Root command: `bun run licenses:rust`
   (`just licenses-rust`).

3. **Vendored upstream licences in the graph** (decisions 1 and 2), see
   [Vendored upstream licences](#vendored-upstream-licences). Code:
   `scripts/build-remote-backend-graph.vendored.ts`; data: `scripts/remote-backend-graph/licenses/`.
   `NOTICES.json` keeps schema version 1 and gains an optional per-entry `upstream` record;
   `provenance.json` `notices` gains `vendoredNoticeFiles`. Manifest revision and verifiers are
   unchanged.
4. **Remote agent notices as release assets** (decision 7), see byte group 2.
5. **Mobile notices beside the mobile artifacts** (decision 7): `bun run licenses:mobile-web`
   (`scripts/mobile-web-licenses.ts`, `.logic.ts`) and the packager's notice sidecars, see byte
   group 3.

Real graph, 18 November: an aarch64 graph produced from a `git archive HEAD` snapshot plus this
change, signed with a fixture key, under the checked-in loader policy (signing refuses any
unreviewed loader site; 27 reviewed sites, 831 reachable modules): 8,083 files, 355,523,683 bytes,
168 notice entries, 17 of them with vendored files, 2 without any licence file
(`data-uri-to-buffer`, `proxy-agent-negotiate`). `THIRD_PARTY_NOTICES` is 825,221 bytes and
contains the GitHub Copilot CLI licence (for the SDK and the runtime package) and every vendored
text.

Not closed: licence text for `data-uri-to-buffer` and `proxy-agent-negotiate` (none upstream), the
Rust crates linked into the Copilot runtime's `rg` and `tgrep`, separate notices for pi-tui's
native addons and WASM, and a bundler-exact (rather than dependency-closure) mobile inventory.

## User decisions required

Facts and options only. Decisions 1 (Copilot part), 2 and 7 were resolved by the user on
18 November 2026 and are implemented as described; the rest remain open.

### 1. Redistribution terms for the Claude agent SDK and the Copilot CLI/runtime

**Copilot: resolved, option (a).** The SDK and its native linux runtime stay in the graph, and the
GitHub Copilot CLI licence (`@github/copilot@1.0.105` `LICENSE.md`, sha256 `b9680937…1628`) ships
for `@github/copilot-sdk` and `@github/copilot-sdk-linux-*`, with the real licences of the bundled
`rg` (ripgrep 15.0.0, plus PCRE2 10.46) and `tgrep` (microsoft/tgrep, MIT). **Claude agent SDK:
resolved, option (a)** (user decision, 18 November 2026): keep shipping it inlined, as the desktop
app already does, with its `LICENSE.md` in `notices/bundled/`. The user read Anthropic's terms on 18 November 2026 and confirmed they cover this.

- **Claude agent SDK 0.3.310** is inlined into every graph. Its package declares
  `SEE LICENSE IN README.md`; its `LICENSE.md` refers to Anthropic's Legal Agreements URL. The
  graph ships that file under `notices/bundled/`.
  Options: (a) confirm the terms allow this redistribution and ship as is; (b) obtain written
  permission; (c) exclude the Claude provider from the graph and have it load the SDK from a
  user installation, which is a code change.
- **Copilot**: the graph ships `@github/copilot-sdk` 1.0.28 and its linux runtime package
  (declared MIT, no licence file, about 123 MB native runtime plus `rg` and `tgrep`).
  Provisioning places the Copilot CLI 1.0.105 on the host from the vendor's release; that
  package's `LICENSE.md` has conditional redistribution terms (section 2, quoted in byte
  group 1). Options: (a) confirm the conditions are met and add the CLI licence text to the
  release notices; (b) ask GitHub which terms apply to the SDK runtime package; (c) stop shipping
  the runtime package in the graph and fetch it on the host like the CLI.

### 2. Packages with no licence file

**Resolved, option (a) with real upstream files only** (no text generated from metadata): 17 of
the 19 arm64 entries (and the x64 platform equivalents) now ship a vendored upstream licence;
`data-uri-to-buffer` and `proxy-agent-negotiate` have none upstream and stay recorded as such.

19 graph entries ship no licence text (table in byte group 1). Options per package: (a) copy the
upstream licence text from the version-matched source repository into the graph's notices (a
small, reviewable addition to the notices step, keyed by name and version, with the text's
source URL and hash); (b) ask the maintainer to publish one; (c) accept the declared licence
field as the only record. `NOTICES.json` and `THIRD_PARTY_NOTICES` already record these as
"none shipped" so the state is visible in each release.

### 3. Release signing key

**Resolved, option (a), 18 November 2026.** One Ed25519 key signs the remote agent manifests
and the backend graph manifests. The user generated it (`openssl genpkey -algorithm ED25519`,
PKCS8 PEM) and stored it as the repository secrets `BIGBUD_REMOTE_AGENT_SIGNING_KEY` and
`BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID` (`release-2026`) on `youpele52/bigbud`. The only copy outside
GitHub is in the user's password manager. Note that `gh` in this checkout defaulted to the
upstream `pingdotgg/t3code`; pass `--repo youpele52/bigbud` or run
`gh repo set-default youpele52/bigbud`.

- Clients pin the release key. `packages/shared/src/releaseTrust.ts` holds
  `{ "release-2026": SPKI PEM }`. Each release still publishes its trust store in
  `remote-agent-install-source*.json`, but when that file comes from the default GitHub release
  location the server keeps only entries whose key id is pinned and whose Ed25519 key bytes match,
  and refuses a manifest signed by any other key ("update bigbud"). Backend graph trust derived
  from the install source is pinned the same way. Explicit local overrides
  (`BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH`/`_URL`, the development graph directory and
  trusted-keys inputs, `backend setup --trusted-keys`) keep operator-chosen trust; downloaded
  content cannot select them.
- The release verifier (`scripts/verify-remote-agent-release-assets.ts`) and the release-signed
  graph job (`scripts/verify-release-signing-key-pin.ts`) fail when the signing key is not pinned.
- Rotation: add the new key id and public key to the pinned set and ship an app release first;
  then set both secrets to the new key and release; drop the old key from the pinned set once no
  supported client needs it. Clients older than the pinning release must update. Legacy binding
  (`remoteAgentLegacyBinding.ts`) takes its historical trust store from in-process composition
  only and is not pinned.
- Graphs built without the release key are refused by the release job
  (`*.fixture-public-key.pem` check). The mobile packager takes any key at packaging time.

### 4. Publication

No backend graph or remote release with these assets has been published. Pending choices: when to cut the first release that includes graph
assets; whether to publish the mobile components and from which workflow. (Remote agent notices
and Rust inventories are now release assets, decision 7.)

### 5. D4 musl-only cutover timing

**Resolved, default kept (user decision D3 (a)).** The first release that ships the backend graph
still publishes both gnu and musl remote agents; the following release drops the gnu triples
(older desktop apps asking for a gnu agent then get a 404). The workflow diffs are prepared in
the [D4 report](../reports/2026-11-17-d4-musl-only-cutover-prep.md) and applied for that second
release. A musl-only remote agent links musl libc statically, which then becomes part of the
shipped bytes.

### 6. Redeploy bigbud.app with `remote-agent.sh`

The site does not serve the script yet. Cloudflare Pages deploys bigbud.app from the
`marketing` branch (root `apps/marketing`, `astro build`, output `dist`), not from `main`, and
that branch does not contain `apps/marketing/public/remote-agent.sh` yet. Release order:

1. Merge `dev` into `main` (draft PR first so CI runs).
2. Squash-merge `main` into `marketing` and push it; Cloudflare redeploys the site.
3. Run `bun run verify:published-remote-agent-script` until it reports a match, and again with
   `--release v<x>` after the release is published. Clients must not show the `curl … | sh`
   command before this passes.

### 7. Notices beside the non-graph artifacts

**Resolved, option (a) as sidecars:** remote agent notices and inventories are release assets
generated in `release-remote-agent-build.yml`; the mobile packager writes gateway and asset notice
sidecars. No signed format changed.

The remote agent, mobile gateway and mobile asset archive ship with no licence or notice text.
Options: (a) publish `bun run licenses:rust … --notices-output` output and the project `LICENSE`
as extra release assets (workflow change); (b) embed the notice text in the binary (code
change); (c) link to a notices page. The mobile asset archive needs an inventory first.

## Checks run for this change

18 November (licence decisions): focused Vitest for `build-remote-backend-graph.vendored.test.ts`,
`.notices.test.ts`, `.stage.test.ts`, `build-remote-backend-graph.test.ts`,
`rust-dependency-licenses.test.ts`, `mobile-web-licenses.test.ts`,
`package-mobile-components.test.ts`, `package-mobile-components.notices.test.ts` and
`apps/server/scripts/releaseAssetWorkflows{,.notices}.test.ts`; explicit-path `oxfmt` and
`oxlint`; `bun run --cwd scripts typecheck`; the real aarch64 graph above; and the agent, gateway
and mobile notices generated twice each with byte-identical output.

Earlier (aggregated notices):

Focused Vitest for
`build-remote-backend-graph.notices.test.ts`, `build-remote-backend-graph.stage.test.ts`,
`build-remote-backend-graph.test.ts` and `rust-dependency-licenses.test.ts`; explicit-path
`oxfmt` and `oxlint`; `bun run --cwd scripts typecheck`; and the Rust inventory CLI run against
the real workspace for `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-gnu` and the mobile
gateway.
