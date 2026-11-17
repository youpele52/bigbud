# D4 musl-only cutover prep and published-script check (2026-11-17)

WP-0B from [the remote completion plan](../plans/2026-11-17-remote-completion-plan.md). Nothing in
this report has been applied to the release workflows. It is held until D4 timing.

## Timing

Default from plan decision 12: **the release after the backend graph first ships.** The release
that first ships the backend graph still publishes both libc families. The release after it drops
the gnu remote-agent triples. Apply the diffs below on a branch cut for that release.

## Published-script check (live run)

Command: `bun run verify:published-remote-agent-script --release v0.3.3`, run 2026-11-17 21:54
UTC from macOS with only a generic `bigbud-release-verifier` user agent.

| Source                                                                              | Result          | Detail                                                                                                                                        |
| ----------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://bigbud.app/remote-agent.sh`                                                | **MISMATCH**    | HTTP 200 `text/html`, 34,635 bytes, sha256 `bb29c9ad…b487`. This is the site's HTML fallback page, so the script has not been deployed there. |
| `github.com/youpele52/bigbud/releases/download/v0.3.3/remote-agent.sh`              | **UNREACHABLE** | HTTP 404. v0.3.3 was published before `release.yml` staged `remote-agent.sh`.                                                                 |
| Repository `apps/marketing/public/remote-agent.sh` (dev, uncommitted lanes present) | n/a             | sha256 `0e6dc5d46fc9db588162a035d2b50c0288158bf85e4ba6b11d5021dc6ca8fe35`                                                                     |

Overall exit code: 1 (mismatch). No redirect occurred, and none went to `raw.githubusercontent.com`.

Cause: `remote-agent.sh` exists only on `dev` (added in `4d18c2173e`). It is not on `origin/main`
and is not in any release tag, so the site has not deployed it yet. Before any client shows the
`curl -fsSL https://bigbud.app/remote-agent.sh | …` command, deploy the marketing site from a
commit that contains the script. Then rerun the verifier until it prints `Result: match.`, and
run it again with `--release v<x>` once that release is published.

## Proposed diff 1: `.github/workflows/release-remote-agent-build.yml`

```diff
       matrix:
         include:
-          # glibc builds ship for one transition release (D4); musl builds are static.
-          - label: Linux x86_64
-            target: x86_64-unknown-linux-gnu
-            strip: strip
-          - label: Linux arm64
-            target: aarch64-unknown-linux-gnu
-            strip: aarch64-linux-gnu-strip
+          # D4: static musl builds only; they run on glibc and musl hosts alike.
           - label: Linux x86_64 static
             target: x86_64-unknown-linux-musl
             strip: strip
@@
           BIGBUD_AGENT_BUILD_DIGEST: ${{ github.sha }}
-          CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: aarch64-linux-gnu-gcc
           # Rust's musl targets link their self-contained C runtime; gcc only drives the linker.
           CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: aarch64-linux-gnu-gcc
```

Keep `gcc-aarch64-linux-gnu` and `aarch64-linux-gnu-strip`. The aarch64 musl build still uses them
as its linker driver and strip tool. The `images=(ubuntu:22.04)` default in the compatibility check
then applies only to gnu targets, so it can be removed or left in place.

## Proposed diff 2: `.github/workflows/release.yml` (about lines 241–279 and 296–310)

```diff
       - name: Build signed remote agent manifests
@@
-          # Legacy names stay glibc-only: older clients reject manifests with unknown triples.
-          node scripts/build-remote-agent-release-manifest.ts "${common[@]}" \
-            --output release-assets/remote-agent-manifest.json \
-            --install-source-output release-assets/remote-agent-install-source.json \
-            "$(asset x86_64-unknown-linux-gnu)" "$(asset aarch64-unknown-linux-gnu)"
-          # Musl-aware clients read v2 and prefer the static builds.
+          # D4: musl-only. Legacy glibc-only files are no longer published.
           node scripts/build-remote-agent-release-manifest.ts "${common[@]}" \
             --output release-assets/remote-agent-manifest.v2.json \
             --install-source-output release-assets/remote-agent-install-source.v2.json \
-            "$(asset x86_64-unknown-linux-musl)" "$(asset aarch64-unknown-linux-musl)" \
-            "$(asset x86_64-unknown-linux-gnu)" "$(asset aarch64-unknown-linux-gnu)"
+            "$(asset x86_64-unknown-linux-musl)" "$(asset aarch64-unknown-linux-musl)"
@@
       - name: Verify packaged remote agent assets
@@
-          node scripts/verify-remote-agent-release-assets.ts \
-            --manifest release-assets/remote-agent-manifest.json \
-            --install-source release-assets/remote-agent-install-source.json \
-            "$(asset x86_64-unknown-linux-gnu)" "$(asset aarch64-unknown-linux-gnu)"
           node scripts/verify-remote-agent-release-assets.ts \
             --manifest release-assets/remote-agent-manifest.v2.json \
             --install-source release-assets/remote-agent-install-source.v2.json \
-            "$(asset x86_64-unknown-linux-musl)" "$(asset aarch64-unknown-linux-musl)" \
-            "$(asset x86_64-unknown-linux-gnu)" "$(asset aarch64-unknown-linux-gnu)"
+            "$(asset x86_64-unknown-linux-musl)" "$(asset aarch64-unknown-linux-musl)"
@@
       - name: Publish release
@@
             release-assets/bigbud-remote-agent-*
-            release-assets/remote-agent-install-source.json
-            release-assets/remote-agent-manifest.json
             release-assets/remote-agent-install-source.v2.json
             release-assets/remote-agent-manifest.v2.json
```

Decision this needs: with no gnu assets, the legacy `remote-agent-manifest.json` and
`remote-agent-install-source.json` cannot be built. They list glibc triples only, and pre-v2
clients reject musl triples. Dropping them means a desktop older than the v2-aware client gets a
404 when it tries to install an agent from the D4 release, and must update first. The other option
is to republish the previous release's legacy files, but that pins those clients to an older
agent. The diff above takes the first option.

`build-remote-agent-release-manifest.ts` already accepts a single libc family: two assets for one
family passes its "x86_64 and aarch64 for each libc family" check. Its comment about the D4
transition should be updated in the same change.

## Other gnu remote-agent references to update at cutover

These are remote-agent references only. The backend graph is a separate artifact and stays gnu by
design (D3: gnu graph with a musl launcher). Do not change these graph references:
`scripts/build-remote-backend-graph*`, `apps/server/src/cli/cli.backend.inputs.ts`, the
`docs/COMMANDS.md` graph producer targets, and `assertSetupRuntimeTarget` in
`apps/server/src/remote-backend/localSupervisorService.setup.runtime.ts`. After D4, that function
accepts only the musl launcher, which `remoteAgentTargetCandidates` already allows.

| Location                                                                                                    | Today                                                                               | At cutover                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/shared/src/remoteAgentArtifact.ts` `REMOTE_AGENT_TARGET_TRIPLES`                                  | Lists both gnu triples.                                                             | **Keep them.** They are needed to parse historic and pinned manifests and to clean up installed glibc builds. Update the doc comment only.                                                                   |
| same file, `remoteAgentTargetCandidates`                                                                    | `[musl, gnu]` for glibc and unknown hosts.                                          | Optional: keep as is. A musl-only manifest selects musl, and gnu stays a fallback for pinned older releases. Return `[musl]` only if pinned pre-D4 releases are dropped too.                                 |
| same file, `resolveRemoteAgentTargetTriple`                                                                 | Returns the gnu triple as the host baseline.                                        | Keep it. The value is used only as an architecture key for the candidate list.                                                                                                                               |
| `apps/server/src/remote-agent/remoteAgentInstallManager.ts:202`                                             | Comment says "glibc remains for transition manifests".                              | Update the comment.                                                                                                                                                                                          |
| `apps/server/src/remote-agent/remoteAgentInstallSource.ts:19-23`                                            | Falls back to the legacy file on a 404 for v2. Comment describes the D4 transition. | Keep the fallback for pinned pre-v2 releases and update the comment.                                                                                                                                         |
| `apps/server/src/remote-agent/remoteAgentInstall.operation.ts:154`                                          | Same-version musl to glibc fallback.                                                | Keep it. This path becomes unused for D4+ releases.                                                                                                                                                          |
| `apps/server/src/remote-agent/remoteAgentFailure.classify.ts` (`glibc-too-old`)                             | Classifies GLIBC version errors.                                                    | Keep it. It still applies to pinned pre-D4 glibc builds.                                                                                                                                                     |
| `apps/marketing/public/remote-agent.sh:153-172`                                                             | Tries v2 then legacy install source, and candidates `musl` then `gnu`.              | Optional: keep both for pinned older versions. Changing the script changes its hash, so redeploy the site and rerun `verify:published-remote-agent-script`.                                                  |
| `scripts/build-remote-agent-release-manifest.ts:134-141`                                                    | Comment describes the D4 transition.                                                | Update the comment.                                                                                                                                                                                          |
| Tests in `apps/server/src/remote-agent/*.test.ts` and `scripts/build-remote-agent-release-manifest.test.ts` | Many use `x86_64-unknown-linux-gnu` as a fixture triple.                            | No change required. They test parsing and selection, which still accepts gnu. Add one case for a musl-only manifest on a glibc host if none exists (`remoteAgentArtifact.musl.test.ts` covers it partially). |

Not a remote-agent reference: `scripts/lib/workspace-agent-target.ts` uses `x86_64-unknown-linux-gnu`
for the desktop-bundled workspace agent. That is a different binary and is out of D4 scope.

## Verification at cutover

1. Run the release workflow on a prerelease tag. Check that it uploads exactly two
   `bigbud-remote-agent-*-musl` assets and only the v2 manifest and install source.
2. Run `bun run verify:published-remote-agent-script --release v<that tag>`. It must report a match
   for both the site and the release asset.
3. Do a fresh install on a glibc host (Ubuntu 22.04) and a musl host (Alpine 3.20) from the D4
   release. Then pin a pre-D4 version on the glibc host to confirm the legacy fallback still works.
