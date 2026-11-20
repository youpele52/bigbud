# Copilot vendor package cache permissions (2026-11-17)

## Finding

A Linux ARM64 validation run with Copilot disabled left a 221 MB
`~/.cache/copilot/pkg/linux-arm64/1.0.105` tree with world-writable (0777) directories.

Cause chain (confirmed by code reading and by reproducing the vendor behavior on macOS):

1. The sidebar mounts `useCopilotRuntime`, which polls `server.copilotRuntime { action: "status" }`
   at startup and every 15 s, whether or not Copilot is enabled.
2. The handler did not check `providers.copilot.enabled`. Discovery resolved the bundled
   `@github/copilot-<target>` binary and ran `<binary> --version` to read its version.
3. That binary is a self-extracting Node SEA. On a release build, `--version` with no newer cached
   package extracts the embedded `copilot.tgz` into
   `$COPILOT_PKG_CACHE_HOME|$COPILOT_CACHE_HOME|$XDG_CACHE_HOME/copilot` + `/pkg/<target>/<version>`
   before printing. The extractor uses `mkdir({ recursive: true })` and node-tar with default
   modes, so the permissions follow the process umask. Under umask 000 the tree is 0777: on macOS
   this produced 83 world-writable directories.

The world-writable modes come from the vendor's extractor, not from bigbud code.

## Mitigation in bigbud

- Status is passive while the provider is disabled. It runs no executable, writes no state, does
  not create the runtime root, and shows no setup prompt.
- Discovery reads the version from the adjacent `@github/copilot*` `package.json` instead of
  executing the CLI. Even with the provider enabled, status no longer extracts the bundled CLI.
- Session and metadata launches of bigbud-owned CLIs (`bundled-native`, `managed`) set
  `COPILOT_PKG_CACHE_HOME=<copilot runtime root>/.vendor-cache`. bigbud creates that directory as
  0700 before launch, so other local users cannot reach the extracted tree.
- Directories and files that bigbud creates for the runtime are chmod'd to exactly 0700/0600,
  whatever the umask.

## Residual risk

- The vendor still extracts with umask-dependent modes. Inside the private parent, other users
  cannot reach it, but the tree itself may still be 0777.
- External installs (a configured path, `copilot` on `PATH`) and users who set
  `COPILOT_PKG_CACHE_HOME`/`COPILOT_CACHE_HOME` keep the vendor default location and modes. When
  Copilot is enabled, status may still run `--version` on an external binary that has no npm
  manifest, which extracts into the user's own cache, as the vendor CLI would on first use.
- Caches extracted to `~/.cache/copilot/pkg` before this change are not removed or tightened.
- The private cache roughly doubles disk use once, about 200 MB, if the user already had the
  vendor's default cache. bigbud's managed uninstall does not remove `.vendor-cache`.
- Windows is unchanged: it uses per-user `%LOCALAPPDATA%` and ACLs, and there is no POSIX mode
  issue.

Report upstream: the extractor should create `pkg/` trees with explicit 0700/0755 modes,
independent of umask.
