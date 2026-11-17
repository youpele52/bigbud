# Provider provisioning recipes and service PATH discovery (WP-5A, WP-5B)

Date: 2026-11-18. Plan: [remote completion plan, M4](../plans/2026-11-17-remote-completion-plan.md).

## What landed

- `apps/server/src/provider-provisioning/recipe.ts`: recipe types (components `bundled`,
  `graphExternal`, `vendorExecutable`; OS/arch/libc tuples; integrity; discovery; auth-readiness
  reference; manual fallback) and pure helpers (`validateRecipe`, `recipeSupportsTuple`,
  `recipePrerequisites`, `formatManualFallback`).
- `recipes/{codex,claudeAgent,cliProxy,copilot,cursor,devin,muse,opencodeV2,pi}.ts` and
  `recipes/index.ts` with `resolveProviderRecipe(kind)`. The registry is typed as a mapped type
  over `SELECTABLE_PROVIDER_KINDS`, so a new selectable kind fails typecheck and the
  `recipes_cover_selectable_kinds` test until it has a recipe.
- `servicePath.ts`, `servicePath.shell.ts`, `servicePath.dirs.ts`: `discoverServicePath()` and
  `resolveProviderExecutable()`.
- `packages/shared/src/shell.ts`: `buildEnvironmentCaptureCommand` and `extractEnvironmentValue`
  are now exported so the capture command and marker parsing are reused, not duplicated.

Nothing installs anything yet; the provisioning action is WP-5C.

## Providers

Decision 6: bigbud provisions only Copilot and the Pi closure. The other seven reuse
user-installed tools. bigbud never runs vendor installer scripts.

| Provider (kind)          | Provisioned by | What bigbud ships                                                         | User-installed part                            | Manual install text                                                   | Auth step (readiness check)                                                                     | Known prerequisites                                                                                    |
| ------------------------ | -------------- | ------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Codex (`codex`)          | user           | Protocol adapter (inlined)                                                | `codex` CLI                                    | `npm install -g @openai/codex`                                        | `codex login` (`checkCodexProviderStatus`)                                                      | None recorded                                                                                          |
| Claude (`claudeAgent`)   | user           | Claude agent SDK (inlined)                                                | `claude` CLI                                   | `npm install -g @anthropic-ai/claude-code`                            | `claude auth login` (`checkClaudeProviderStatus`)                                               | None recorded                                                                                          |
| CLIProxyAPI (`cliProxy`) | user           | Claude harness and SDK (inlined)                                          | `cliproxyapi` service and `claude` CLI         | `brew install cliproxyapi`, Claude command above, or a GitHub release | Upstream accounts in the proxy config (`checkCliProxyProvider`)                                 | Running proxy service; bigbud never starts or updates it                                               |
| Copilot (`copilot`)      | bigbud         | `@github/copilot-sdk` in the graph; pinned CLI 1.0.105 (sha512, 8 tuples) | none (an explicit `binaryPath` is preserved)   | Fallback: `npm install -g @github/copilot`                            | `gh auth login` (`checkCopilotProviderStatus`)                                                  | Native SDK runtime addon (in the graph)                                                                |
| Cursor (`cursor`)        | user           | ACP client (inlined)                                                      | `agent` CLI                                    | See vendor docs (Cursor CLI), cursor.com/docs/cli/acp                 | `agent login` (`checkCursorProviderStatus`)                                                     | None recorded                                                                                          |
| Devin (`devin`)          | user           | ACP client (inlined)                                                      | `devin` CLI                                    | See vendor docs (Cognition Devin CLI); no URL recorded                | `devin login` (`checkDevinProviderStatus`)                                                      | None recorded                                                                                          |
| Muse Code (`muse`)       | user           | Muse SDK (inlined)                                                        | `muse` CLI                                     | See vendor docs, dev.meta.ai/docs/muse-code                           | Run `muse`, browser sign-in (`checkMuseProviderStatus`)                                         | Supported Muse platform                                                                                |
| OpenCode (`opencodeV2`)  | user           | OpenCode v2 client (inlined)                                              | `opencode` CLI and its shared service          | See vendor docs, opencode.ai/v2/docs/cli                              | Model provider configured in OpenCode (`discoverV2SharedService`; lease auth is not model auth) | Healthy shared service; bigbud only borrows it                                                         |
| Pi (`pi`)                | bigbud         | `@earendil-works/pi-coding-agent` 1.4.0 closure in the graph              | none (a non-default `binaryPath` is preserved) | Fallback: `npm install -g @earendil-works/pi-coding-agent`            | Model provider configured in Pi (`checkPiProviderStatus`)                                       | Optional `libxcb.so.1` for the pi-tui X11 helper; TypeScript extensions may fail (no jiti `babel.cjs`) |

The graph components declare the backend tier tuples (glibc Linux x64 and arm64, decision 3).
Only the arm64 graph has been built so far (see the M1 graph report).

## Service PATH discovery

The Rust supervisor starts the backend service with a cleared environment: `HOME`, `LANG` and
`PATH=<private node dir>:/usr/local/bin:/usr/bin:/bin`, with no `SHELL`. User CLIs are therefore
not on PATH. `discoverServicePath()` builds a PATH for spawning providers, in this order:

1. **Explicit settings always win.** A configured binary path containing a path separator is
   returned as-is by `resolveProviderExecutable`, without checking it and without replacing it.
   Configured extra PATH directories come before everything discovered.
2. **Login shell PATH.** Runs `$SHELL -lc` (shell from `SHELL`, then the account's passwd shell,
   then the platform default) with stdin closed, in a new session (no controlling TTY),
   `TERM=dumb`, a 3 s timeout and a 64 KiB stdout cap. On timeout or overflow the whole
   process group is killed and no other shell is tried. Version-manager variables (`NVM_DIR`,
   `PYENV_ROOT`, …) are captured in the same run.
3. **Version-manager directories**, only those that exist: nvm (default alias first, aliases
   followed up to 4 hops, then newest), fnm `aliases/default/bin`, volta, asdf and mise shims,
   pyenv, cargo, `~/.local/bin`, Homebrew and Linuxbrew. This covers non-interactive shells
   that skip `~/.bashrc`, where nvm and fnm usually start.
4. The inherited process PATH.

Discovery never changes `process.env`; callers pass the returned `path` to the provider process.

## Tests and checks

- `recipes/index.test.ts`: `recipes_cover_selectable_kinds` (one case per
  `SELECTABLE_PROVIDER_KINDS` entry), recipe shape validation, decision 6, that each auth
  reference names a real export, Copilot pins, tuple support, and that broken recipes are
  rejected.
- `servicePath.test.ts`: `nvm_shim_found_without_tty` (temporary HOME with an nvm layout, and a
  fake shell that exits if stdin is a TTY or `/dev/tty` opens), `explicit_path_preserved`,
  source ordering, timeout with process-group kill, the output cap, and a missing shell.
- Mutation check: each targeted mutation made at least one test fail.
