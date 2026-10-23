# SSH Config Host Picker For Remote Projects

**Date:** 22 October, 2026
**Status:** Implemented (uncommitted; see Implementation Record)
**Owner:** Claude Code (main thread)

## Summary

The "Add SSH remote project" dialog gets a source switch at the top: **Enter manually** (the current
form, unchanged) or **From SSH config** (pick a host alias read from the backend machine's OpenSSH
client config). Both modes always show **Connection method** and **Provider runtime**. Direct SSH
becomes the first and preselected connection method for new projects. Stored project targets keep
their current format; config mode stores `host=<alias>`, which existing code already passes straight
to `ssh`.

A visual HTML explainer of both modes and the flow was reviewed with the user during planning.
It has since been removed from the repository; later references to "the explainer" mean that
review.

## Related Work

- Research thread "Cross-platform remote project configs" (`9f19df94-5b84-4b9a-bc99-bd8a2b29f09a`):
  OpenSSH config is the shared, cross-platform source; editors (VS Code, Zed, Cursor) build on it.
- Bigbud note / Kanban card: none identified; the work was agreed in conversation.

## Problem

Users who already keep their machines in `~/.ssh/config` must retype the host in bigbud. Typing an
alias already works: `parseSshExecutionTarget` keeps `host` verbatim
(`apps/server/src/ssh/sshExecutionTarget.ts:43-64`) and `buildSshTransportArgs` adds `-p`/`-i`
only when set (`apps/server/src/ssh/sshCommand.ts:49-55`). But there is no way to discover aliases,
and nothing tells the user that this works. Also, new projects currently default to the bigbud
remote agent (`apps/web/src/components/sidebar/Sidebar.projects.logic.ts:46`), and the user wants
Direct SSH to be the default.

## Settled Decisions (from the conversation)

1. Keep the existing manual workflow and add an SSH-config workflow; the user picks one with a
   switch at the top of the dialog.
2. Connection method and Provider runtime always appear, in both modes, in the same position.
3. Direct SSH is listed **first** and **preselected** for new projects.
4. Config mode stores only the alias (no copied HostName/User/Port), so later config edits apply.
5. Listing hosts only reads files. It never runs `ssh` or `ssh -G` (because `Match exec` can run
   local commands).
6. Discovery runs on the backend machine (where `ssh` runs) and the UI names that machine.
7. Custom `-F` config files, Windows authentication fixes, and Windows remote hosts are out of scope
   (later phases from the research).
8. The add dialog opens in the mode used last (stored in `localStorage`); the first time, it opens in
   "Enter manually". This matches the explainer.
9. _(Planner decision, pending user confirmation.)_ The default project title stays `<dir> (<alias>)`, the existing rule in
   `Sidebar.projectAddActions.remote.submit.ts:27-30`. The explainer placeholder said "Defaults to
   the alias"; the explainer was edited after the user reviewed it, to match this.
10. Connection fields are kept **per mode**. Config mode starts with no overrides, so username, port
    or key typed in manual mode never leak into an alias target.

## Goals

- In add mode, the dialog opens in the last-used mode ("Enter manually" the first time), with Direct
  SSH preselected.
- "From SSH config" lists the concrete `Host` aliases from the user and system configs, following
  `Include`, with each alias's source file and line, plus a search box and a refresh button.
- Picking an alias and a path, then submitting, runs the existing verify → (agent install) → create
  flow with `ssh:host=<alias>&auth=ssh-key&transport=<choice>`.
- Missing or unreadable config files produce a clear per-file message and a way back to manual
  entry. The dialog never dead-ends.
- Existing projects, target IDs, and the verify, install, unlock, and edit flows behave exactly as
  before.

## Non-Goals

- `-F` custom config support and adding `configFile` to targets.
- Running `ssh -G`, evaluating `Match`, or resolving effective settings.
- Windows ssh-executable resolution, askpass, ssh-agent service, and password-session changes.
- Changing the server-side default transport used when a stored target has no `transport` param
  (`apps/server/src/remote-agent/remoteAgentDefault.ts:45`), or how the web app parses missing
  transport (`Sidebar.projects.logic.ts:69`, which defaults to `agent`). Existing projects keep
  their behaviour.
- Importing editor-specific (Zed/VS Code) connection or project histories.

## Current State

- **Dialog:** `apps/web/src/components/sidebar/SidebarRemoteProjectDialog.tsx` (315 lines) renders
  display name, host, username, port, path, connection method (agent first, :198-210), provider
  runtime, authentication, and key path. It is rendered by `Sidebar.tsx:138`.
- **Draft and target encoding:** `Sidebar.projects.logic.ts`.
  - `RemoteProjectDraft` is at :12-22.
  - The default draft is at :37-48 (`remoteTransport: "agent"`).
  - `createRemoteProjectExecutionTargetId` is at :116-138.
  - The edit draft comes from `createRemoteProjectDraft` at :94-114.
- **State hook:** `Sidebar.projectAddActions.remote.ts` (396 lines, at the 400-line limit).
  - `updateRemoteProjectDraft` (:120-151) does `{ ...current, [field]: value }`, using a field-union
    type that is duplicated in the dialog props (`SidebarRemoteProjectDialog.tsx:45-56`).
  - Verification uses `createRemoteProjectExecutionTargetId(draft)` and
    `getRemoteProjectConnectionLabel(draft)`. Both read `draft.host`.
- **Validation:** `createRemoteProjectFieldErrors` (`Sidebar.projectAddActions.helpers.ts:25-42`)
  requires `host` and `workspaceRoot`.
- **Agent status in edit:** `remoteProjectAgentTarget` (`SidebarRemoteAgentStatus.tsx:24-31`) reads
  `draft.host`.
- **Default title:** `Sidebar.projectAddActions.remote.submit.ts:27-30` uses `<dir> (<label>)`.
  With an alias, the label is the alias.
- **RPC pattern to copy:** the split remote-restart contract.
  - `packages/contracts/src/server/server.remoteRestart.ts` holds the schemas, and its subpath export
    is in `packages/contracts/package.json:71`.
  - `rpc.remoteAgent.ts` makes the `Rpc` objects, and `rpc.ts` (:113, :197) registers them.
  - The method name goes in `WS_METHODS` (`constants/websocket.constant.ts:86`).
  - The client type goes in `ipc.nativeApi.ts:196-198`.
  - The server handler is in `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts:80-91`.
  - The web client is wired in `apps/web/src/rpc/wsRpcClient.ts:198`, `wsRpcClient.types.ts:249`,
    `wsNativeApi.ts:254` and `wsNativeApi.test.helpers.ts:144`.
- **Files near the 400-line limit that must not grow past it:** `server.ts` (398), `rpc.core.ts`
  (395), `wsNativeApi.test.helpers.ts` (391), `wsRpcClient.types.ts` (384),
  `wsRpcHandlers.gitTerminal.ts` (372), `wsNativeApi.ts` (366). New schemas therefore go in new
  files.
- **The setter type is duplicated in four places:** the hook (`Sidebar.projectAddActions.remote.ts`
  ~:123), the hook output type (`Sidebar.projectAddActions.remote.types.ts:45-56`), the sidebar state
  type (`Sidebar.types.ts:184-196`, which is what `Sidebar.tsx:152` passes on), and the dialog props
  (`SidebarRemoteProjectDialog.tsx:43-54`).
- **Version skew:** an unknown RPC tag makes the server fail the whole connection.
  `apps/web/src/rpc/protocol.optionalRpc.ts:15-18` (`OPTIONAL_WS_RPC_TAGS`) plus a guarded request
  (the pattern in `wsRpcClient.diagnostics.ts`) turn that into a per-request failure.
- **Existing tests that construct or compare full drafts:**
  - `Sidebar.projects.logic.remote.test.ts:26-36` (`toEqual`)
  - `Sidebar.projectAddActions.remote.edit.test.ts:50-59`
  - `SidebarRemoteAgentInstallDialog.browser.tsx:19-29`

  These tests must be updated for the new draft fields.

- **Browser harness:** the API mock in `SidebarRemoteProjectDialog.browser.support.tsx:153-158` has no
  `listSshConfigHosts`. Callers must guard with `typeof api?.server.listSshConfigHosts ===
"function"`, as `SidebarRemoteAgentStatus.tsx:59` already does.
- **UI primitives available:** `ui/toggle-group.tsx` (used like
  `MobileRemoteControlSettingsSection.urlSelection.tsx:36-48`), `ui/command.tsx` (inline
  Autocomplete), and `ui/collapsible.tsx`.
- **Concurrency note:** another agent has uncommitted work in `apps/server/src/codex`,
  `orchestration`, `provider`, and `apps/web/src/components/chat`. None of the files in this plan
  overlap with it. Do not run repo-wide `bun fmt`; format only the touched files.

## Phases

### Phase 1: Server discovery and contract

1. **Contract.** Create `packages/contracts/src/server/server.sshConfig.ts` with:
   - `ServerListSshConfigHostsInput` (an empty struct).
   - `ServerSshConfigHost`, with fields `alias`, `sourcePath`, `line`, and optional `hostName`,
     `user` and `port`. These are literal values from the alias's own `Host` block, used for display
     only.
   - `ServerSshConfigSource`, with fields `path`, `kind` (`user` | `system` | `include`), `status`
     (`loaded` | `missing` | `error` | `skipped`) and optional `message`.
   - `ServerListSshConfigHostsResult`, with fields `machineName`, `hosts` and `sources`.
   - The tagged error `ServerListSshConfigHostsError`.

   Then:
   - Add the subpath export `./server/server.sshConfig` to `package.json`.
   - Add `rpc.sshConfig.ts` with `WsServerListSshConfigHostsRpc`, and register it in `rpc.ts`
     (imports and the group list).
   - Add `serverListSshConfigHosts: "server.listSshConfigHosts"` to `WS_METHODS`.
   - Add `listSshConfigHosts` to `NativeApi.server` in `ipc.nativeApi.ts`.

2. **Parser.** Create `apps/server/src/ssh/sshConfigParse.ts`. It is pure, with no filesystem access.
   - Tokenize lines: case-insensitive keywords, `key value` or `key=value`, double-quoted arguments,
     `#` comments, and tolerance for CRLF and a BOM.
   - Return `Host` aliases (excluding patterns containing `*`, `?`, `!`, or the literal `*`) with
     line numbers.
   - Track the literal `HostName`, `User` and `Port` inside each `Host` block.
   - Return the `Include` arguments together with their line numbers.
   - Skip the contents of a `Match` block: set no aliases and take no hints from it, but still follow
     its `Include` lines, as OpenSSH does.
3. **Sources and discovery.**
   - `apps/server/src/ssh/sshConfigSources.ts` builds the default paths:
     - the user config: `path.join(os.homedir(), ".ssh", "config")`
     - the system config: `/etc/ssh/ssh_config`, or
       `path.join(process.env.ProgramData ?? "C:\\ProgramData", "ssh", "ssh_config")` on win32
     - include base directories: `~/.ssh` for the user config, `/etc/ssh` or `%ProgramData%\ssh` for
       the system config
   - `apps/server/src/ssh/sshConfigDiscovery.ts` reads the files with async `fs` only:
     - It expands `~` and resolves relative includes against the base directory of the root that
       started them.
     - It expands `*`/`?` wildcards in any path segment with a bounded directory walk, sorted the
       way glob sorts.
     - It marks includes containing `%` tokens or `${` env references as `skipped`, with a message.
     - Limits: include depth ≤ 16, ≤ 64 files, ≤ 256 KiB per file (over the limit means `error`),
       ≤ 1000 aliases. Cycles are detected with `realpath`.
     - Results are de-duplicated by alias, and the first occurrence wins (matching OpenSSH's
       first-match semantics).
     - Source paths are shown with `~` for paths under the home directory.
4. **Handler.** Add `apps/server/src/ws/wsSshConfigHosts.ts`, exporting
   `listSshConfigHostsEffect = Effect.fn("listSshConfigHostsEffect")(...)`. It wraps discovery in
   `Effect.tryPromise` and maps unexpected failures to `ServerListSshConfigHostsError`. Register it in
   `wsRpcHandlers.gitTerminal.ts` next to `serverVerifyExecutionTarget`, using `observeRpcEffect`
   with `"rpc.aggregate": "server"`.
5. **Web RPC wiring.** Add `listSshConfigHosts` in `wsRpcClient.ts`, `wsRpcClient.types.ts`,
   `wsNativeApi.ts`, and the `vi.fn()` mock in `wsNativeApi.test.helpers.ts`. Add
   `WS_METHODS.serverListSshConfigHosts` to `OPTIONAL_WS_RPC_TAGS`, and send it through a guarded
   request in `wsRpcClient.sshConfig.ts` (the same pattern as `wsRpcClient.diagnostics.ts`), so that
   an older server fails only that request.
6. `machineName` comes from `os.hostname()`, falling back to "this computer".

**Done:** steps 1-6.

**Exit criteria:** parser and discovery unit tests pass; the contract decodes and encodes; typecheck
passes. No user-visible change yet.

### Phase 2: Dialog

1. **Draft model** (`Sidebar.projects.logic.ts`):
   - Add `connectionSource: "manual" | "ssh-config"` and `inactiveConnection: RemoteProjectConnectionFields`
     to `RemoteProjectDraft`. `RemoteProjectConnectionFields` is
     `{ host, username, port, authMode, sshKeyPath }`.
   - `createDefaultRemoteProjectDraft(connectionSource = "manual")` sets an empty
     `inactiveConnection` and **`remoteTransport: "direct-ssh"`**.
   - `createRemoteProjectDraft` (edit) uses `connectionSource: "manual"` and sets
     `inactiveConnection` to a copy of the stored connection, so both modes start from the stored
     values.
   - Export the type `RemoteProjectDraftField = keyof RemoteProjectDraft`.
   - Add the pure function `applyRemoteProjectDraftChange(draft, field, value)`. For
     `connectionSource` it swaps the five active connection fields with `inactiveConnection` when the
     source actually changes; otherwise it assigns the field.

   `draft.host` therefore always holds the active mode's host. Validation, target encoding, labels,
   agent status, and edit/reconfigure stay unchanged.

   Each mode keeps its own connection fields. In config mode, the overrides (username, port, auth,
   key) live under "Advanced", which opens automatically when any of them is set or password auth is
   chosen, so an override is never hidden.

2. **Hook and types:**
   - Export `UpdateRemoteProjectDraft = <K extends RemoteProjectDraftField>(field: K, value:
RemoteProjectDraft[K]) => void` from the logic file.
   - Use it in all four places: the hook, `remote.types.ts`, `Sidebar.types.ts`, and the dialog props.
   - The hook's setter calls `applyRemoteProjectDraftChange`.
   - `openRemoteProjectDialog` uses
     `createDefaultRemoteProjectDraft(readLastRemoteProjectConnectionSource())`, read from
     `Sidebar.projects.connectionSourcePreference.ts` (`getLocalStorageItem`/`setLocalStorageItem`
     with a `Schema.Literals` codec).
   - Add a non-invalidating `adoptRemoteProjectConnectionSource(source)` for edit-mode inference
     only. It applies the same swap without bumping `verificationRequestIdRef` or clearing messages,
     which is safe because in edit mode the swap leaves the target ID unchanged.
   - The file must stay ≤ 400 lines; the type change frees enough space.
3. **Host list hook** (`SidebarRemoteProjectDialog.sshConfigHosts.ts`):
   - `useSshConfigHosts({ enabled })` calls `readNativeApi()?.server.listSshConfigHosts({})` when
     enabled, exposes `{ status, result, error, refresh }`, and ignores stale responses with a
     request counter.
   - It is enabled while the dialog is open and either `connectionSource === "ssh-config"` or the
     dialog is in edit mode. Add mode loads lazily, only after the user switches to config.
4. **Dialog split.** Keep every file ≤ 400 lines.
   - `SidebarRemoteProjectDialog.tsx`: the shell, with the header, the source `ToggleGroup` (Enter
     manually / From SSH config), the mode-specific fields, path, display name, the shared options,
     the verification/agent/error panels, and the footer.
   - `SidebarRemoteProjectDialog.options.tsx`: the shared option button. It contains:
     - `RemoteProjectConnectionOptions`: Connection method with **Direct SSH first**, then the bigbud
       remote agent, followed by Provider runtime. Both modes render it.
     - `RemoteProjectAuthenticationFields`: the auth buttons and key path. Manual mode renders it
       inline; config mode renders it inside Advanced.
   - `SidebarRemoteProjectDialog.manualFields.tsx`: host/IP, username, and port, exactly as they are
     today.
   - `SidebarRemoteProjectDialog.sshConfigFields.tsx`:
     - A searchable host list built from `Command`/`CommandInput`/`CommandList`/`CommandItem`/
       `CommandEmpty`, filtered by alias and hostName.
     - Each row shows the alias, the `sourcePath:line`, and a muted hint (hostName · user · port).
     - Footer: "Read from SSH config on <machineName>" and a Refresh button.
     - States: loading; empty (no hosts, with a "Enter manually" button); per-source errors or
       skipped includes in amber `text-xs`; RPC failure or an unsupported server (red) with Retry
       and "Enter manually".
     - Selecting a row sets `host` to the alias.
     - The current value is always visible as "Selected: <alias>". If it isn't in the discovered
       list (for example, it was removed from the config), an amber note says "Not found in SSH
       config; bigbud will still pass it to ssh".
     - `fieldErrors.host` is shown under the list as "Pick an SSH config host." (a config-mode
       variant of the helper message).
     - A collapsible "Advanced" panel holds the username, port, and authentication overrides.
   - Field order in both modes: the source switch, Display name, the mode fields, the remote path,
     the shared options, then Authentication (manual mode) or Advanced (config mode). Manual mode
     keeps today's order.
   - Switching the source also calls `rememberRemoteProjectConnectionSource`.
5. **Edit-mode inference** (in the shell). The first time hosts load while the dialog is open in edit
   mode, call `adoptRemoteProjectConnectionSource("ssh-config")` only if all of these hold:
   - the draft still equals the draft captured when the dialog opened (nothing has been edited)
   - nothing is verifying or submitting, and there is no error or verification message
   - `draft.host` equals a discovered alias
   - username, port and key path are empty and auth is `ssh-key`

   If any condition fails when hosts load, inference is skipped for that open.

   A ref holds the "decided" flag and the captured draft. It resets whenever `open` becomes true or
   the edited project changes (the dialog stays mounted).

   The visible effect: an alias project opens in manual mode and switches to config mode once the
   hosts load, usually within one frame.

6. Copy updates:
   - The manual host placeholder stays as it is.
   - The config path field keeps the existing placeholder.
   - The display-name default is unchanged: `<dir> (<alias>)`. The HTML mockup said "defaults to the
     alias"; keeping the existing title rule avoids a behaviour change.

**Exit criteria:** browser tests below pass; both modes are visually aligned with the explainer.

## Risks And Decision Gates

- **Stored behaviour:** config mode produces the same target format as typing the alias manually.
  The `inactiveConnection` and `connectionSource` fields are never persisted:
  `createRemoteProjectExecutionTargetId` ignores them. Rollback means reverting the UI. No data
  migration is involved.
- **Default transport change:** new projects lose agent-backed reconnect durability unless the user
  picks the agent. The user explicitly chose this. Existing projects keep the transport stored in
  their target, and the edit flow is unchanged.
- **Parser divergence from OpenSSH:** the picker lists aliases only; OpenSSH still resolves the
  connection, so a parser miss affects only the list, never the connection. Unsupported includes are
  reported as `skipped`, not silently dropped.
- **Backend vs viewing machine:** discovery reads the backend's home directory. The UI names the
  machine, which avoids confusion in browser-to-remote-server setups.
- **Performance:** file reads are async and bounded, and run only when config mode is shown or edit
  mode opens. Nothing is cached server-side, so Refresh always rereads.
- **Concurrent agent:** shared files touched by this plan (`rpc.ts`, `WS_METHODS`,
  `ipc.nativeApi.ts`, the web rpc files, `wsRpcHandlers.gitTerminal.ts`) are not in the other agent's
  dirty set as of `cef863ccfa`. Re-check `git status` before editing each one and abort that edit if
  it became dirty.

## Testing And Validation

- **Contract:** add `packages/contracts/src/server/server.sshConfig.test.ts`, a round-trip encode
  and decode of `ServerListSshConfigHostsResult`.
- **Parser unit tests** (`apps/server/src/ssh/sshConfigParse.test.ts`): `key=value`, quoted
  aliases, multiple aliases on one line, wildcard and negated patterns excluded, `Match` blocks, case
  insensitivity, CRLF and BOM, comments, hints scoped to their block.
- **Discovery unit tests** (`apps/server/src/ssh/sshConfigDiscovery.test.ts`, using a temp directory
  as the injected home and system roots): a relative and a globbed `Include`, an include cycle,
  depth/file/size limits, a missing system file reported as `missing`, a `%`-token include reported
  as `skipped`, first occurrence winning, and `~` display paths.
- **Web logic** (`Sidebar.projects.logic.test.ts`, new or extended):
  - The default draft is Direct SSH and manual.
  - `applyRemoteProjectDraftChange` swaps hosts in both directions and is a no-op when the source is
    unchanged.
  - The execution target ID for a config-mode draft equals `ssh:host=<alias>&auth=ssh-key&transport=direct-ssh`.
  - The edit draft keeps the stored transport.
- **Browser** (`SidebarRemoteProjectDialog.sshConfig.browser.tsx`, new, reusing the existing support
  harness):
  - Add mode shows Direct SSH first and pressed.
  - Switching to config lists mocked hosts, and selecting one and submitting calls
    `verifyExecutionTarget` with the alias target.
  - Connection method and Provider runtime are visible in both modes.
  - The empty state offers "Enter manually".
  - Switching back to manual restores the typed host.
  - Edit-mode inference opens config mode for a pure alias project.
- **Edit-mode race:** a browser test opens edit mode for an alias project, clicks Save before the
  hosts resolve, then resolves them. Verification must complete and the mode must stay manual.
- **Mode leak:** a logic test types a user in manual mode, switches to config, picks an alias, and
  checks the target is `ssh:host=<alias>&auth=ssh-key&transport=direct-ssh`.
- **Web forwarding:** extend the `wsNativeApi.remoteAgent.test.ts` pattern so `listSshConfigHosts`
  forwards to the RPC client.
- **Regression:** the existing `SidebarRemoteProjectDialog.browser.tsx` and `.upgrade.browser.tsx`
  must pass without changes in behaviour. Three tests are updated only to add the new draft fields:
  - `Sidebar.projects.logic.remote.test.ts`
  - `Sidebar.projectAddActions.remote.edit.test.ts`
  - `SidebarRemoteAgentInstallDialog.browser.tsx`
- **Commands:**
  - Format the touched files with `bunx oxfmt <files>`. Do not run repo-wide `bun fmt`, because of
    the other agent's work; run `bun fmt:check` and report unrelated failures.
  - `bun lint` and `bun typecheck`. Failures in the other agent's files are reported, not fixed.
  - `bun run --cwd apps/server vitest run src/ssh/sshConfigParse.test.ts src/ssh/sshConfigDiscovery.test.ts`
  - `bun run --cwd packages/contracts vitest run src/server/server.sshConfig.test.ts`
  - `bun run --cwd apps/web vitest run src/components/sidebar` for the unit tests.
  - `bun run --cwd apps/web test:browser src/components/sidebar/SidebarRemoteProjectDialog` and
    `.../SidebarRemoteAgentInstallDialog`. Run `test:browser:install` first if Playwright is
    missing.
  - Attempt `bun run test`. Record failures in the other agent's areas as unrelated.
- **Manual:** on macOS, add a project via an alias from `~/.ssh/config` with Direct SSH; confirm the
  terminal works. Windows and Linux manual checks are recorded as pending if no machine is
  available.

## Acceptance Criteria

- The dialog shows the Enter manually / From SSH config switch. Manual mode works exactly as before,
  except that Direct SSH is first and preselected.
- Config mode lists aliases from user and system configs plus includes, with source and line,
  search, refresh, and the machine name; it handles empty and error states.
- Connection method and Provider runtime render in both modes.
- Creating a project from an alias stores `ssh:host=<alias>&auth=ssh-key&transport=<choice>` and
  goes through the unchanged verify and install flow.
- Discovery never spawns a process.
- All new and touched code files are ≤ 400 lines; lint, typecheck, and the targeted tests pass
  (repo-wide failures caused by the other agent's work are reported separately).

## Open Questions

None blocking. Windows/Linux manual verification depends on machine availability. Decisions 8 and 9
answer the reviewer's two questions using what the explainer showed the user; flag them in the
handoff summary so the user can override them.

**Plan validity:** written against `main` at `cef863ccfa`. Re-validate the line references if
`Sidebar.projects.logic.ts`, `Sidebar.projectAddActions.remote.ts`, `SidebarRemoteProjectDialog.tsx`,
or the contracts RPC registry change before implementation.

## Implementation Record

Implemented on `main` (based on `cef863ccfa`), uncommitted. Two plan-reviewer rounds were run: round
1 returned Draft with 11 issues, all addressed; round 2 returned Ready for implementation with six
small corrections, all applied.

- **Deviation:** the browser harness mock in `SidebarRemoteProjectDialog.browser.support.tsx`
  gained `remoteConnections: {}`. `SidebarRemoteAgentStatus.tsx:53` (added 2026-09-21) reads it,
  while the mock dated from 2026-09-08. Without the fix, every edit-mode browser test for an agent
  project timed out, both on HEAD and with this change.
- **Validation:**
  - `bun typecheck`: 9/9 tasks pass.
  - `bun lint`: 0 errors, and no warnings in touched files.
  - `bun fmt:check`: clean.
  - Server tests: `src/ssh` plus `wsRpcHandlers.gitTerminal.test.ts`, 8 files / 30 tests.
  - Contracts test: `server.sshConfig.test.ts`, 2 tests.
  - Web unit tests: `src/components/sidebar` plus `src/rpc`, 65 files / 302 tests.
  - Browser tests: the `SidebarRemoteProjectDialog*` files and
    `SidebarRemoteAgentInstallDialog.browser.tsx`, 4 files / 22 tests.
- **Manual check:** discovery ran read-only against the developer Mac's real config: 17 hosts, the
  user config, an OrbStack `Include` and the system config all loaded, in 13 ms. Windows and Linux
  manual checks are pending.

### Follow-up: picker and refresh polish (user request)

- The SSH host list is now a dropdown that mirrors the model picker (`SshConfigHostPicker` in
  `SidebarRemoteProjectDialog.sshConfigPicker.tsx`): a trigger showing the selected host, and a
  searchable `MenuRadioGroup` grouped by config file, with a checkmark on the selected host.
- The search field and scroll body were extracted from `ModelList` into
  `components/ui/SearchableMenuList.tsx`; `ModelList` and the SSH host picker both use it.
- The text Refresh button became the app's refresh icon with a tooltip. The pattern was duplicated
  in Providers settings and Usage limits, so it is now `components/ui/RefreshIconButton.tsx`, used
  by all three.
- **Validation:**
  - Browser: the dialog and model picker suites pass (7 files / 35 tests), and so do the Usage limits
    files (4/4).
  - `ProvidersSettingsSection.nativeTrust.browser.tsx` fails to import. This is pre-existing: its
    `useSettings` mock lacks `updateServerSettings`, which `ProviderCard.claudeSubagentCaps.tsx`
    (added 5 days earlier) imports.
  - Web unit tests (usage, settings, chat/provider, sidebar): 61 files / 374 tests pass.
  - `bun typecheck` passes, and lint shows 0 errors.

## Phase 3: Remote Folder Browser And Leaner Add Dialog (user request)

### Decisions

- `HostName` is **not** required in the SSH config. It is optional in OpenSSH, which falls back to
  the alias. The picker keeps listing hosts that have no `HostName`.
- **Display name** is removed from the **add** dialog in both modes. The title still defaults to
  `<folder> (<host>)`, and the sidebar's Rename covers custom names. The **edit** dialog keeps the
  field, prefilled with the current name, so saving never renames a project by accident.
- **Remote project path** stays required, but gains **Browse**: a folder browser that starts at the
  remote home folder (or the typed path). There is no silent default. Choosing home or `/` as the
  project shows an amber warning, because bigbud would watch and search the whole folder over SSH and
  the agent would get all of it as its workspace.

### Confirmed constraint: folder listing before the agent is installed

- `projects.listDirectory` cannot be used. For agent-transport targets it routes to the remote
  agent: `remoteAgentServerLayer.ts:369-373` passes `isRemoteAgentExecutionTarget` as `useRemote`,
  and `WorkspaceRuntime.ts:27-32` → `WorkspaceRuntime.remote.ts:282-312` calls
  `client.listDirectory`. That fails until the agent is installed.
- Its Direct SSH branch (`WorkspaceEntries.ts:303-310` →
  `WorkspaceEntries.remote.ts:listRemoteWorkspaceDirectoryFromSsh`) uses `find -printf`, which is
  GNU-only and fails on macOS remotes.
- `runSshCommand` (`sshProcess.ts`) ignores the target's transport and runs the same readiness and
  password-session checks as verification. A dedicated SSH-only listing therefore works for both
  connection methods before installation, and reports the same lock messages that the web
  `getPassphraseProtectedSshKeyPath`/`getPasswordProtectedSshTargetLabel` helpers recognise.

### Steps

1. **Contract:** `server.remoteFolders.ts` and `rpc.remoteFolders.ts` define
   `server.listRemoteFolders`.
   - Input: `{ executionTargetId, path? }`.
   - Result: `{ path, homePath, folders: [{ name, isGitRepo }], truncated }`.
   - Register it in `rpc.ts`, `WS_METHODS` and `NativeApi`, and add it to `OPTIONAL_WS_RPC_TAGS` with
     a guarded client request.
2. **Server:** `apps/server/src/ssh/sshRemoteFolders.ts` runs one POSIX `sh` script through
   `runSshCommand`.
   - It changes into the path (handling `~` and `~/…`), then prints `$HOME`, `pwd` and the
     non-hidden folders with a git marker, NUL-separated.
   - Limits: at most 1000 folders, a 10 s timeout and a 1 MiB buffer. Nothing is written remotely.
   - A failed `cd` becomes "Folder not found or not accessible".
   - The handler is `wsRemoteFolders.ts`, registered next to `serverListSshConfigHosts`.
3. **Unlock reuse** (`Sidebar.projectAddActions.remote.ts`):
   - Add `requestRemoteProjectUnlock(errorMessage, continuation?) => boolean`. It recognises lock
     errors, opens the existing unlock dialog, and stores an optional continuation.
   - After unlocking, a stored continuation runs instead of verify+submit.
   - Verification's catch block uses the same function, which removes the duplicated branches.
   - Closing the unlock dialog clears the continuation.
4. **Web browser:**
   - `SidebarRemoteProjectDialog.folderBrowser.ts` is the hook: load/navigate, stale-response
     guard, and auth errors routed to `requestRemoteProjectUnlock` with a retry continuation.
   - `SidebarRemoteProjectDialog.folderBrowser.tsx` is the inline panel: breadcrumbs, Up, a filter,
     folders with git repos marked, and "Use this folder".
   - The panel closes and resets whenever the connection target changes.
5. **Dialog:**
   - Display name is shown only in edit mode.
   - The path field gets a Browse button and the panel.
   - The home-or-root warning is added.
   - The path error message becomes "Choose a folder or enter the remote project path."
   - Wire `onRequestUnlock` through `Sidebar.tsx`, the sidebar types, and the browser harness.

### Tests

- **Server unit:** parse the listing output (sorting, git marker, truncation, a failed `cd`) with
  `runSshCommand` mocked.
- **Contract:** round-trip the result.
- **Web logic:** the home/root warning predicate.
- **Browser:**
  - Browse lists the home folders.
  - Navigating into a folder and choosing it fills the path.
  - A locked key opens the unlock dialog, and after unlocking the browser retries.
  - The add dialog has no Display name; the edit dialog still does.
  - The home warning appears.
- **Regression:** the existing dialog, install and edit tests.

### Phase 3 Implementation Record

- **Implemented as planned:**
  - `server.listRemoteFolders` (`sshRemoteFolders.ts`, `wsRemoteFolders.ts`, the contract, and an
    optional-RPC guard in `wsRpcClient.remoteSetup.ts`, renamed from `wsRpcClient.sshConfig.ts`).
  - Folder browser (`SidebarRemoteProjectDialog.folderBrowser.ts`, `.folderBrowserPanel.tsx`,
    `.pathField.tsx`).
  - Display name shown in edit mode only, plus the home-or-root warning.
- **Script robustness:** the listing script prints a start marker before its NUL-separated output,
  because remote commands run through a login shell (`sh -lc`) and `.profile` banners would
  otherwise corrupt the output. A buffer that was cut off drops its partial last record.
- **Unlock refactor:** the unlock state and handlers moved to
  `Sidebar.projectAddActions.remote.unlock.ts`, which brought the main hook from 407 to 286 lines.
  `requestRemoteProjectUnlock(errorMessage, continuation?)` is shared by verification and folder
  browsing. A stored continuation runs after unlocking instead of verify-and-save, and it is cleared
  when the prompt is dismissed, the draft changes, or the dialog resets.
- **Harness:** the browser harness now renders the unlock dialog and can mock `listRemoteFolders`
  and `unlockSshKey`.
- **Validation:**
  - Server: `src/ssh` plus `wsRpcHandlers.gitTerminal.test.ts`, 9 files / 38 tests. This includes
    running the real script through the local `sh` against temporary folders (home default, `~/`
    path, a folder name with spaces, hidden folders skipped, a git marker, exit 3 for a missing
    folder).
  - Contracts: 2 tests.
  - Web unit: `src/components/sidebar` plus `src/rpc`, 67 files / 305 tests.
  - Browser: the `SidebarRemoteProjectDialog*` files and the install dialog, 5 files / 27 tests.
    The new ones cover: no Display name in add mode, browse-navigate-choose-save, the home warning,
    unlock then retry browsing, and unlock then verify-and-save.
  - `bun typecheck` passes, and lint shows 0 errors.
- **Not verified live:** browsing against a real remote host, and against a macOS remote.

### Follow-up: Display name restored (user request)

- The optional **Display name** is back in the add dialog in both modes, exactly as before. Left
  blank, the title still defaults to `<folder> (<host>)`. This reverses the Phase 3 decision to show
  it only in edit mode.

### Follow-up: source order and dialog copy (user request)

- **From SSH config** now comes first in the source switch and is the first-time default. The
  remembered choice still applies after that, and the empty state offers "Enter manually".
- The dialog description now reads "Open a project on another machine over SSH. bigbud checks the
  connection before adding it." In edit mode it ends "…before saving your changes."
