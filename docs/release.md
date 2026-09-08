# Release Checklist

This document covers channel-isolated desktop releases and their platform signing guarantees.

## What the workflow does

- Trigger: push tag matching `v*.*.*`.
- Runs quality gates first: lint, typecheck, test.
- Builds five artifacts in parallel:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Linux `x64` .deb
  - Windows `x64` NSIS installer
- Publishes one GitHub Release with all produced files.
  - Versions with an approved channel suffix after `X.Y.Z` (for example `1.2.3-beta.1`, `1.2.3-preview.1`, or `1.2.3-nightly.20260726`) are published as GitHub prereleases.
  - Stable releases have no suffix; unsupported prerelease channel names fail preflight.
  - Only plain `X.Y.Z` releases are marked as the repository's latest release.
- Includes only the active channel's Electron auto-update metadata and the corresponding `*.blockmap` assets.
- Artifact names use `bigbud-${version}-${arch}.${ext}`. Stable artifacts are untagged; prerelease artifacts retain their version suffix.
- Every public macOS build is Developer ID signed, notarized, and stapled. Missing credentials fail the build.
- Windows artifacts are intentionally unsigned. Linux does not use OS code signing.
- Builds and publishes signed remote-agent binaries for Linux `x86_64` and `aarch64` alongside the desktop assets.
- Builds the platform-native `bigbud-remote-agent` on every desktop runner and stages it at `resources/server/workspace-agent/bin/bigbud-remote-agent[.exe]` for local workspace watching and verified managed-resource cleanup.
- Smoke-checks each packaged workspace watcher on its native runner, publishes the four target-specific binaries as release artifacts, and requires the complete set before `@bigbud/server` can be published.
- Publishes `remote-agent-manifest.json`, `remote-agent-install-source.json`, and one `.sha256` file per remote-agent binary. The install source contains the signed manifest and its public trust key; artifact URLs point to binaries in the same GitHub Release.

Remote-agent release signing uses the Ed25519 key supplied through the required
`BIGBUD_REMOTE_AGENT_SIGNING_KEY` and `BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID`
secrets. The workflow publishes the corresponding public key in the remote-agent
install source under that key ID, which lets the installer verify manifest
signatures and supports key rotation.

## Release environment and secret reference

Use [.env.release.example](../.env.release.example) as the canonical name and
format reference. Put every populated value in GitHub **repository Actions
secrets**; do not commit a populated environment file or store the private key
in GitHub Variables. The tag-release workflow needs all seven values below:

| Secret                               | Purpose and required format                                                                                                                                                                                                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK`                           | Base64-encoded `.p12` export containing the Apple Developer ID Application certificate and its private key. It signs the macOS app and bundled workspace watcher.                                                                                                                                              |
| `CSC_KEY_PASSWORD`                   | Password used when that `.p12` file was exported. It decrypts `CSC_LINK` during the macOS build.                                                                                                                                                                                                               |
| `APPLE_ID`                           | Apple Developer account email used solely for notarization.                                                                                                                                                                                                                                                    |
| `APPLE_APP_SPECIFIC_PASSWORD`        | App-specific password created for `APPLE_ID`; never use the Apple ID's primary password.                                                                                                                                                                                                                       |
| `APPLE_TEAM_ID`                      | Ten-character Apple Developer Team ID associated with the certificate and notarization account.                                                                                                                                                                                                                |
| `BIGBUD_REMOTE_AGENT_SIGNING_KEY`    | Complete multi-line PEM-encoded Ed25519 private key. It signs the Linux remote-agent manifest and must remain a GitHub Actions secret. Generate it with `openssl genpkey -algorithm ED25519 -out bigbud-remote-agent-signing-key.pem` if a new key is needed.                                                  |
| `BIGBUD_REMOTE_AGENT_SIGNING_KEY_ID` | Public label for the remote-agent signing key, for example `release-2026`. It must begin with a letter or digit and use only letters, digits, `.`, `_`, or `-` (64 characters maximum). Reuse it across stable and prerelease channels while using the same private key; change it only when rotating the key. |

`BIGBUD_DESKTOP_UPDATE_GITHUB_TOKEN` and `GH_TOKEN` are optional **runtime**
variables for private-release lookup in a running desktop app. They are not
release-workflow secrets. GitHub Actions provides the release job's
`GITHUB_TOKEN` automatically through its `contents: write` permission.

At runtime, the packaged server resolves the install source for its own version at
`https://github.com/youpele52/bigbud/releases/download/v<version>/remote-agent-install-source.json`.
Remote installation is only called after the user approves the first-use prompt.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Update UX:
  - Background checks run on startup delay + interval.
  - No automatic download or install.
  - The desktop UI shows a rocket update button when an update is available; click once to download, click again after download to restart/install.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository slug source:
  - `BIGBUD_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`), if set.
  - legacy alias: `T3CODE_DESKTOP_UPDATE_REPOSITORY`
  - otherwise `GITHUB_REPOSITORY` from GitHub Actions.
- Optional GitHub API authentication:
  - set `BIGBUD_DESKTOP_UPDATE_GITHUB_TOKEN` (or `GH_TOKEN`) in the desktop app runtime environment.
  - legacy alias: `T3CODE_DESKTOP_UPDATE_GITHUB_TOKEN`
  - Stable uses electron-updater's private GitHub provider when a token is present.
  - Prerelease channels use the token only to locate the newest matching release, then download that public release's channel-specific metadata and assets directly.
- Required release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - active-channel metadata (`latest*.yml`, `beta*.yml`, `preview*.yml`, or `nightly*.yml`)
  - `*.blockmap` files (used for differential downloads)
- Update channels are isolated by installed app identity:
  - Stable reads `latest` metadata and rejects all prereleases.
  - Beta reads `beta` metadata and accepts only Beta versions.
  - Preview reads `preview` metadata and accepts only Preview versions.
  - Nightly reads `nightly` metadata and accepts only Nightly versions.
- Prerelease update checks first locate the newest matching GitHub Release and require its platform manifest. This avoids electron-updater's Beta-to-Stable behavior and its private-provider custom-channel limitation.
- Before an update is exposed or downloaded, the desktop validates the offered version against its installed channel as a second fail-closed boundary.
- macOS uses `<channel>-mac.yml`. The workflow temporarily names the Intel manifest `<channel>-mac-x64.yml`, merges it with arm64, and publishes one multi-architecture active-channel manifest.

## Side-by-side identity and data isolation

| Channel | Bundle/app ID               | Product          | Electron userData | bigbud base directory        | Updater   |
| ------- | --------------------------- | ---------------- | ----------------- | ---------------------------- | --------- |
| Stable  | `ai.bigbud.desktop`         | `bigbud`         | `bigbud`          | `~/.bigbud`                  | `latest`  |
| Beta    | `ai.bigbud.desktop.beta`    | `bigbud Beta`    | `bigbud-beta`     | `~/.bigbud/channels/beta`    | `beta`    |
| Preview | `ai.bigbud.desktop.preview` | `bigbud Preview` | `bigbud-preview`  | `~/.bigbud/channels/preview` | `preview` |
| Nightly | `ai.bigbud.desktop.nightly` | `bigbud Nightly` | `bigbud-nightly`  | `~/.bigbud/channels/nightly` | `nightly` |

The channel-specific bundle IDs, product names, package names, executables, desktop entries, and Windows app IDs allow all four channels to install and run simultaneously. Stable alone may reuse the legacy `T3 Code (Alpha)` Electron profile. `BIGBUD_HOME` (or legacy `T3CODE_HOME`) remains an exact base-directory override. Projects remain ordinary shared filesystem paths and are not copied into channel data.

macOS privacy permissions are associated with the signed bundle identity. Grant Accessibility and Screen Recording separately for each installed channel that uses computer control.

## Desktop bootstrap installers

- Keep GitHub Releases as the source of truth for desktop binaries.
- User-facing install commands:
  - macOS/Linux: `curl -fsSL https://raw.githubusercontent.com/youpele52/bigbud/main/apps/marketing/public/install.sh | sh`
  - Windows: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/youpele52/bigbud/main/apps/marketing/public/install.ps1 | iex"`
- Installer behavior:
  - prefer GitHub `releases/latest` when a stable release exists
  - fall back to the general `releases` feed when only prereleases exist
  - select the right asset by OS/arch:
    - macOS `arm64` or `x64` DMG
    - Linux `x64` AppImage
    - Windows `x64` NSIS installer
- The bootstrap script sources live in `apps/marketing/public/` and are fetched directly from the repository by the user-facing install commands.
- For the current public repo setup, no GitHub auth token is required for the bootstrap installers.
- The bootstrap script itself resolves the correct GitHub Release asset. If no desktop release exists yet, the script fails with a GitHub Releases error.

## CI vs release builds

- Pushes to `main` run `.github/workflows/ci.yml`.
- The `quality` job currently runs format check, lint, tests, and the desktop pipeline build.
- Browser tests are not part of CI.
- The typecheck step runs in the preflight job before any artifacts are built.
- After `quality` passes, `desktop_release_build` builds unsigned, credential-free desktop release-style artifacts on:
  - macOS `arm64`
  - macOS `x64`
  - Linux `x64` AppImage + `.deb`
  - Windows `x64`
- `release_asset_assembly` then merges the macOS updater manifests, stages `install.sh` and `install.ps1`, verifies the assembled payload, and uploads the final release-style bundle as a GitHub Actions artifact.
- Those `main`-push artifacts are uploaded as GitHub Actions workflow artifacts for validation, not published as a public GitHub Release. Use these CI artifacts for unsigned smoke testing; never create an unsigned public dry-run release.
- Public curl-installable assets are only published by `.github/workflows/release.yml` on version tags like `v1.2.3`.
- CI never imports Apple certificates and receives no production signing or notarization credentials.

## CUA driver 0.9.1 upgrade note

- Desktop builds package `cua-driver-rs` 0.9.1; managed Runtime repair/install uses the same pinned release metadata and verified checksums.
- Implementation and repository validation are complete: formatting, linting, typechecking, and all nine test tasks pass.
- The runtime is a pre-release dependency. Promote it through an internal/preview desktop build before a stable desktop release.
- bigbud owns the embedded daemon and its private endpoint. CUA telemetry and driver self-update checks are always disabled for bigbud-owned CUA processes.
- As general release certification—not unfinished CUA implementation—run packaged and managed smoke checks on the targets supported by that release. Verify daemon restart/cleanup, permissions, capture/input, and fail-closed unsupported Wayland routes.
- Monitor only bigbud's existing privacy-respecting lifecycle diagnostics; never collect action text, screenshots, or user content for rollout analysis.

## 1) Unsigned validation

Use `.github/workflows/ci.yml` release-style artifacts to validate packaging without credentials. CI covers channel metadata and manifest naming but does not sign, notarize, staple, or publish. Public macOS releases must never use this unsigned path.

## Env var naming

- Prefer `BIGBUD_DESKTOP_UPDATE_*` names in new scripts, docs, and runtime configuration.
- `T3CODE_DESKTOP_UPDATE_*` names remain supported as compatibility aliases where noted in code.

## 2) Apple signing and notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. Generate an [app-specific password](https://support.apple.com/en-us/102654) for your Apple ID.
7. Add Apple ID values:
   - `APPLE_ID`: your Apple Developer account email
   - `APPLE_APP_SPECIFIC_PASSWORD`: the app-specific password
   - `APPLE_TEAM_ID`: your Developer Team ID
8. Re-run a tag release and confirm macOS artifacts are signed/notarized.

Notes:

- Notarization is performed by an explicit `afterSign` hook (`apps/desktop/scripts/notarize.cjs`) using `@electron/notarize`.
- Stable, Beta, Preview, and Nightly use this same Developer ID certificate while retaining distinct bundle IDs.
- Signed packaging sets `forceCodeSigning`, explicitly signs the embedded Rust workspace watcher, verifies both the sidecar and full app, notarizes, staples, validates the ticket, and requires Gatekeeper acceptance before the DMG/ZIP is created.
- All five secrets are validated before certificate import. Any missing credential, signature failure, notarization failure, or staple failure aborts the release.
- Future migration: the hook can be updated to use an App Store Connect API key (`--key` / `--key-id` / `--issuer`) instead of an app-specific password if desired.

## 3) Windows distribution

Windows NSIS installers are intentionally unsigned for now. The release workflow contains no Azure signing credentials or configuration. Channel-specific app IDs and product/package identities keep Stable, Beta, Preview, and Nightly installs separate.

## Linux release guarantees

The Linux build is hardened to avoid the class of AppImage breakages caused by floating `electron-builder` versions and missing Electron runtime files.

- `electron-builder` is pinned in `apps/desktop/package.json` (not resolved via `bunx`).
- Linux release builds run on `ubuntu-22.04` (the oldest still-supported LTS) for broader AppImage compatibility.
- After every Linux build, the script verifies that required Electron runtime files (`snapshot_blob.bin`, `v8_context_snapshot.bin`, `icudtl.dat`) are present in both unpacked `dir` and final AppImage outputs.
- The AppImage undergoes a headless smoke test (`--appimage-extract-and-run --no-sandbox --version`) before release assets are collected.
- An `afterExtract` hook copies missing runtime files from the Electron distribution if electron-builder omits them.
- A `.deb` package is also built as a fallback for users whose system cannot run AppImages. It uses a separate build output so its metadata cannot replace the AppImage updater manifest.

### Local Linux debugging

Build an unpacked Linux app for inspection:

```bash
bun run dist:desktop:linux:dir
```

This produces `release/linux-unpacked/` where you can inspect the file layout directly without dealing with AppImage extraction.

Build only the `.deb` fallback:

```bash
bun run dist:desktop:linux:deb
```

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Bump app version as needed.
3. Create release tag: `vX.Y.Z`.
4. Push tag.
5. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - release job uploads expected files
6. Smoke test downloaded artifacts.
   - Confirm the packaged workspace-agent binary exists and is executable.
   - Run its `--check` identity probe.
   - Complete a framed protocol handshake and verify the `workspace.watch` capability.
   - Start the app, subscribe to a local workspace, and confirm external edits refresh the active preview.
   - Quit the app and confirm the ephemeral workspace-agent process exits.
7. Before publishing `@bigbud/server`, download all four `server-workspace-agent-*` release artifacts into `release-assets/`. The server publish command stages them into `dist/workspace-agent/<platform>-<arch>/`, verifies their executable target headers, and refuses to publish an incomplete set.

## 5) Troubleshooting

- macOS signing preflight fails:
  - Check all five Apple secrets are populated and non-empty. Public releases do not fall back to unsigned macOS artifacts.
- Build fails with signing error:
  - Re-check the Developer ID certificate, Apple team ID, Apple ID, and app-specific password.
  - Use the unsigned CI artifact path to isolate packaging failures; do not remove release credentials to publish an unsigned build.
- Local workspace watcher reports that its agent is unavailable:
  - Packaged builds: verify `resources/server/workspace-agent/bin/bigbud-remote-agent[.exe]` exists, passes `--check`, advertises the mode-specific authority profile, and removes a verified temporary resource through `--resource-cleanup`.
  - Published standalone server: verify `dist/workspace-agent/<platform>-<arch>/bigbud-remote-agent[.exe]` exists. Publishing should have failed before release if any supported target was absent.
  - Source checkout: run `cargo build --locked --package bigbud-remote-agent` or set `BIGBUD_LOCAL_WORKSPACE_AGENT_BINARY` to an executable native binary.
  - Do not point the override at a binary for another operating system or architecture; startup verifies OS, architecture, protocol, and the `workspace.watch` capability.
