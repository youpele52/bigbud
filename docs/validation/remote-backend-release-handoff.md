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
| In other artifacts   | The remote agent binary, mobile gateway binary, mobile asset archive and `remote-agent.sh` ship no licence file or header.                                            |

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

| Component                                                                                              | Version                                                            | Source of the bytes                                                                                                                                                                                                    | Declared licence                                                                                            | Evidence in the graph                                                                                                                                                                                                                                      | Action for the user                                                                   |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Server bundle `server/*.mjs`, `NodeSqliteWorker.mjs`, `server/remote-client-relay/`                    | 0.1.613 (`buildInputs.sourceRevision` records the commit)          | This repository, `apps/server` built with `tsdown` (both configs); source maps are not shipped                                                                                                                         | MIT (project)                                                                                               | file present (`LICENSE`)                                                                                                                                                                                                                                   | Build releases from a clean tree; the release job already refuses a dirty one.        |
| Private Node runtime `runtime/node`                                                                    | 24.13.1                                                            | Official `nodejs.org` `node-v24.13.1-linux-{x64,arm64}.tar.xz`, pinned by SHA-256 in `NODE_RUNTIME_PINS` (`30215f90…1089` x64, `c827d3d3…34c1` arm64)                                                                  | Not set in `NOTICES.json` (`license: null`); the Node LICENSE file covers Node and its bundled dependencies | file present: `runtime/LICENSE` from the same tarball (145,496 bytes, sha256 `9ef8d3fa…27a3`), listing 43 bundled projects (V8, OpenSSL, ICU, libuv, undici, zlib, …)                                                                                      | None required. Note: SQLite, which `node:sqlite` provides, is not named in that file. |
| Effect                                                                                                 | 4.0.0-beta.43, **patched** by `patches/effect@4.0.0-beta.43.patch` | npm, inlined into the bundle                                                                                                                                                                                           | MIT                                                                                                         | file present (`notices/bundled/effect@4.0.0-beta.43/LICENSE`)                                                                                                                                                                                              | Be aware the shipped Effect code is modified.                                         |
| Claude agent SDK `@anthropic-ai/claude-agent-sdk`                                                      | 0.3.310                                                            | npm, inlined into the bundle (JS only; the Claude CLI is user-installed)                                                                                                                                               | `SEE LICENSE IN README.md`                                                                                  | file present: `LICENSE.md`, text "© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined here: https://code.claude.com/docs/en/legal-and-compliance."                                                                       | **Decision 1** below.                                                                 |
| Muse SDK `@muse-code/sdk`                                                                              | 1.4.14                                                             | npm, inlined                                                                                                                                                                                                           | MIT                                                                                                         | file present                                                                                                                                                                                                                                               | None.                                                                                 |
| OpenCode clients `@opencode/client`, `@opencode-ai/sdk`                                                | 2.1.4, 1.17.13                                                     | npm, inlined                                                                                                                                                                                                           | MIT                                                                                                         | declared only                                                                                                                                                                                                                                              | **Decision 2** (no licence file).                                                     |
| `@xterm/headless`, `@xterm/addon-serialize`                                                            | 6.1.0-beta.304, 0.15.0-beta.301                                    | npm, inlined                                                                                                                                                                                                           | MIT                                                                                                         | declared only                                                                                                                                                                                                                                              | **Decision 2**.                                                                       |
| Other inlined packages (39 `bundled` entries in total, e.g. `ws`, `yaml`, `msgpackr`, `@pierre/diffs`) | per `NOTICES.json`                                                 | npm, inlined; found through the bundle's `//#region` markers                                                                                                                                                           | per entry                                                                                                   | file present for all except the four above                                                                                                                                                                                                                 | None.                                                                                 |
| Copilot SDK `@github/copilot-sdk`                                                                      | 1.0.28                                                             | npm, external (`scripts/remote-backend-graph/package-lock.json`, sha512 integrity)                                                                                                                                     | MIT                                                                                                         | declared only                                                                                                                                                                                                                                              | **Decision 1** and **2**.                                                             |
| Copilot linux runtime `@github/copilot-sdk-{linux-x64,linux-arm64}`                                    | 1.0.28                                                             | npm, external. Carries `prebuilds/linux-*/runtime.node` (122,749,312 bytes on arm64), `copilot-runtime`, `ripgrep/bin/linux-*/rg` and `tgrep/bin/linux-*/tgrep`. `repository` points at `github/copilot-agent-runtime` | MIT                                                                                                         | declared only; no licence or notice for the package, `rg` or `tgrep`                                                                                                                                                                                       | **Decision 1** and **2**.                                                             |
| Pi closure `@earendil-works/pi-*` (agent-core, ai, codemode, coding-agent, mcp, telemetry, tui)        | 1.4.0                                                              | npm, external                                                                                                                                                                                                          | MIT                                                                                                         | declared only, except `pi-mcp`, which ships `LICENSES/modelcontextprotocol-typescript-sdk.txt` for one transitive dependency. Native pi-tui addons and WASM (`photon_rs_bg.wasm`, `quickjs.wasm`) have no separate notices                                 | **Decision 2**.                                                                       |
| koffi and `@koromix/koffi-linux-{x64,arm64}`                                                           | 3.2.1                                                              | npm, external; install script skipped (reviewed)                                                                                                                                                                       | MIT                                                                                                         | `koffi`: file present (`LICENSE.txt`); platform addon package: declared only                                                                                                                                                                               | **Decision 2**.                                                                       |
| Other external packages (127 `package` entries in total)                                               | per `NOTICES.json`                                                 | npm, external                                                                                                                                                                                                          | per entry                                                                                                   | file present except `@aws-sdk/credential-provider-http` 3.972.86, `@aws-sdk/credential-provider-login` 3.972.92, `@aws-sdk/nested-clients` 3.998.3 (Apache-2.0), `data-uri-to-buffer` 4.0.1, `proxy-agent-negotiate` 1.1.0, `standardwebhooks` 1.3.0 (MIT) | **Decision 2**.                                                                       |

The 19 entries with no licence or notice file, from the 17 November arm64 graph:

| Kind        | Packages                                                                                                                         |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| bundled (4) | `@opencode/client@2.1.4`, `@opencode-ai/sdk@1.17.13`, `@xterm/addon-serialize@0.15.0-beta.301`, `@xterm/headless@6.1.0-beta.304` |
| Copilot (2) | `@github/copilot-sdk@1.0.28`, `@github/copilot-sdk-linux-arm64@1.0.28`                                                           |
| Pi (6)      | `@earendil-works/pi-{agent-core,ai,codemode,coding-agent,telemetry,tui}@1.4.0`                                                   |
| koffi (1)   | `@koromix/koffi-linux-arm64@3.2.1`                                                                                               |
| other (6)   | the three `@aws-sdk/*` packages, `data-uri-to-buffer@4.0.1`, `proxy-agent-negotiate@1.1.0`, `standardwebhooks@1.3.0`             |

The x86_64 graph substitutes the `linux-x64` platform packages; its exact list is in its own
`provenance.json` (`notices.withoutNoticeFiles`), which every graph build records.

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
standalone, including a copy of the licence, and independent licensing of the application. The
graph's Copilot SDK runtime package (`@github/copilot-sdk-linux-*`) ships no such file.

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
| Shipped notices            | None. The release asset is a bare executable plus `.sha256`.                                                                                                                                                                                                                                                                                   |

Run `bun run licenses:rust --target <triple> --output <file.json> --notices-output <file>` to
produce the per-crate inventory and a `THIRD_PARTY_NOTICES` text for the linked crates (see
below). The aggregated text for the remote agent is about 225 KB.

**Action:** decide whether to publish that notices text with each release (Decision 7).

## Byte group 3: mobile gateway and mobile assets

| Item                           | Version                                                  | Source                                                                                                                                                                        | Licence                                                                                      | Evidence                                                                                                         | Action                                                                                |
| ------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `bigbud-mobile-gateway` binary | 0.1.0 crate, versioned by `compatibility.gatewayVersion` | `crates/bigbud-mobile-gateway`, packaged by `scripts/package-mobile-components.ts`                                                                                            | MIT (workspace)                                                                              | No notice ships with the binary                                                                                  | Decision 7.                                                                           |
| Gateway dependency closure     | `cargo metadata` for `aarch64-unknown-linux-gnu`         | crates.io (hyper 1.12.0, tokio 1.54.1, tokio-tungstenite 0.29.0, …)                                                                                                           | 50 crates, 43 linked; MIT, MIT OR Apache-2.0, BSD-2-Clause OR Apache-2.0 OR MIT (`zerocopy`) | file present in the crate sources for all 50                                                                     | Generate with `bun run licenses:rust --package bigbud-mobile-gateway …`.              |
| `mobile-assets-<v>.tar.gz`     | `compatibility.mobileAssetVersion`                       | `apps/mobile-web` Vite build (React 19, TanStack, Effect, `@base-ui/react`, `@hugeicons/*`, `lucide-react`, `react-markdown`, `@pierre/diffs`, …) plus `public/` brand images | per package                                                                                  | **No inventory exists.** Vite output has no region markers, so the graph's bundled-notice method does not apply. | Decision 7; producing an inventory needs a bundler-level dependency list (follow-up). |

The mobile artifacts are not published by any workflow today.

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

Not closed (needs a design or a decision): notices beside the remote agent and mobile release
assets, a mobile asset dependency inventory, and missing licence files for the 19 packages.

## User decisions required

Facts and options only. None of these is resolved by this document.

### 1. Redistribution terms for the Claude agent SDK and the Copilot CLI/runtime

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

19 graph entries ship no licence text (table in byte group 1). Options per package: (a) copy the
upstream licence text from the version-matched source repository into the graph's notices (a
small, reviewable addition to the notices step, keyed by name and version, with the text's
source URL and hash); (b) ask the maintainer to publish one; (c) accept the declared licence
field as the only record. `NOTICES.json` and `THIRD_PARTY_NOTICES` already record these as
"none shipped" so the state is visible in each release.

### 3. Release signing key

- Format the tooling expects: Ed25519 private key in PKCS8 PEM (`openssl genpkey -algorithm
ed25519`), with a key id; the matching public key must be in the client trust stores.
- Today both the remote agent manifests and the backend graph manifests are signed with the same
  secrets, `BIGBUD_REMOTE_AGENT_SIGNING_KEY` and `BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID`
  (`release.yml` passes them to `release-remote-backend-graph.yml` with `release_signing: true`).
  The mobile packager takes any key at packaging time.
- Options: (a) one key for all (current wiring; one secret to rotate, one compromise affects
  all); (b) a separate graph key (needs a new secret, a second trust-store entry and a workflow
  change).
- Also decide where the private key lives, who can run the release workflow, and the rotation
  plan. Graphs built without the release key are refused by the release job
  (`*.fixture-public-key.pem` check).

### 4. Publication

No backend graph or remote release with these assets has been published. Pending choices: when to cut the first release that includes graph
assets; whether to attach `THIRD_PARTY_NOTICES` and the Rust inventories as release assets
(Decision 7); whether to publish the mobile components and from which workflow.

### 5. D4 musl-only cutover timing

Default (decision 12): the first release that ships the backend graph still publishes both gnu
and musl remote agents; the following release drops the gnu triples. The workflow diffs are
prepared in the [D4 report](../reports/2026-11-17-d4-musl-only-cutover-prep.md) and not applied.
Options: keep the default, or move the cutover earlier or later. A musl-only remote agent links
musl libc statically, which then becomes part of the shipped bytes.

### 6. Redeploy bigbud.app with `remote-agent.sh`

The site does not serve the script yet. Deploy the marketing site from a commit that contains
`apps/marketing/public/remote-agent.sh`, then run
`bun run verify:published-remote-agent-script` until it reports a match, and again with
`--release v<x>` after the release is published. Clients must not show the `curl … | sh`
command before this passes.

### 7. Notices beside the non-graph artifacts

The remote agent, mobile gateway and mobile asset archive ship with no licence or notice text.
Options: (a) publish `bun run licenses:rust … --notices-output` output and the project `LICENSE`
as extra release assets (workflow change); (b) embed the notice text in the binary (code
change); (c) link to a notices page. The mobile asset archive needs an inventory first.

## Checks run for this change

Focused Vitest for
`build-remote-backend-graph.notices.test.ts`, `build-remote-backend-graph.stage.test.ts`,
`build-remote-backend-graph.test.ts` and `rust-dependency-licenses.test.ts`; explicit-path
`oxfmt` and `oxlint`; `bun run --cwd scripts typecheck`; and the Rust inventory CLI run against
the real workspace for `x86_64-unknown-linux-musl`, `aarch64-unknown-linux-gnu` and the mobile
gateway.
