# Remote backend graph producer (M1 WP-1A/1B)

**Date:** 17 November 2026
**Plan:** [Remote completion plan](../plans/2026-11-17-remote-completion-plan.md), M1
**Status:** Implemented and produced locally with a dev fixture key. Nothing is published or
committed. CI (WP-1C job) and WP-1D are not part of this change.

## Produced graph (aarch64-unknown-linux-gnu)

Built from a fresh `tsdown` server bundle of the dev working tree (HEAD `12b1d38`, with other
lanes' uncommitted changes, so provenance records `+dirty`), Node 24.13.1 and the pinned
externals lock.

| Item                         | Value                                                                    |
| ---------------------------- | ------------------------------------------------------------------------ |
| Members                      | 8,048 files (limit 16,384), 354,175,499 bytes (limit 2 GiB)              |
| Archive                      | 126,832,091 bytes, sha256 `a51f10ae…aaa13`                               |
| Manifest                     | sha256 `a1f0ba5b…22ba2`, key id `dev-fixture-20261117` (fixture key)     |
| buildDigest                  | `113a12c6…4fed7` (covers loader-policy sha `da3f08fb…` at time of build) |
| Node binary                  | sha256 `5ce42ffa…dae675`, same bytes as the earlier CONTROL runtime      |
| Reachable / static modules   | 820 / 37; 27 reviewed loader sites; 32 lazy absent-external edges        |
| Native addons                | Copilot SDK `runtime.node`, koffi `linux_arm64`, pi-tui X11 helper       |
| Rebuild from the same inputs | Byte-identical archive and manifest (fresh `npm ci` each time)           |

Verification: the producer's built-in `verifyBackendGraph` + revalidation passed; a separate
run extracted the archive into a fresh directory and the TS verifier accepted it (about 3 s) and
refused the x86_64 target. The Rust verifier was not run (it needs a setup receipt and service
config; `crates/**` is another lane), but the serialized receipt was checked against its rules:
1.1 MB, all paths in its character set, modes 600/700, strictly sorted. In a local
`node:24.13.1-bookworm` arm64 container with no network, the graph's own Node ran
`server/bin.mjs --help`, loaded `@github/copilot-sdk` and koffi, started the Copilot runtime
binary, and printed the Pi CLI version.

## Findings that need a decision

- **Notice gaps.** 19 packages ship no license or notice file, including all
  `@earendil-works/pi-*` 1.4.0 packages, `@github/copilot-sdk` and its `linux-arm64` runtime
  (a 123 MB native binary declared MIT), `@koromix/koffi-linux-arm64`, and the inlined
  `@opencode/client`, `@opencode-ai/sdk` and `@xterm/headless`. The inlined Claude agent SDK is
  `SEE LICENSE IN README.md`. `NOTICES.json` lists all 168 packages; this is not a legal review.
- **Skipped install scripts.** `koffi`, `protobufjs` and `@google/genai` declare install scripts;
  they are skipped and must stay on the reviewed list. A new script-bearing dependency fails.
- **Pi TypeScript extensions.** Pi's bundled jiti refers to `../dist/babel.cjs`, which does not
  exist in the package layout. The edge is lazy (allowed as absent), but transpiling user `.ts`
  extensions under Pi will likely fail on remote hosts.
- **pi-tui X11 helper** needs `libxcb.so.1` at load time; its loader catches the failure.
- **Not in the graph:** `dist/client`, `dist/mobile-web`, source maps, and the Darwin
  `workspace-agent`/`organization-supervisor` binaries. Remote features that need a Linux
  workspace agent or organization supervisor remain unavailable until those are supplied.
- **Hash churn.** A reviewed bundle region is pinned by its text hash. Commit `287fef2` (Copilot
  runtime fix) changed two reviewed regions during this work; both were re-reviewed (no new
  loaders). Expect `--list-loader-sites` updates when those source files change.
- **Relay build.** The normal `bun run --cwd apps/server build` does not build
  `remote-client-relay/`; the documented command runs both tsdown configs.
