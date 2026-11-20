# Remote agent install, replace and remove: stable links and UI

Status: **ready to implement**. All questions are resolved (20 November 2026). Nothing has been
implemented yet. The marketing site deploys only after the user says go for v0.4.0-beta.6
(Milestone 9).

## Decisions

| #   | Topic                    | Decision                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Marketing deploy         | Land the changes on `dev` and `main` normally. Deploy with a **full squash-merge of `main` into `marketing` and a push**, only when the user says go for v0.4.0-beta.6. No cherry-picks.                                                                                                                                                                                           |
| 1b  | 404 page                 | Add a real `src/pages/404.astro` that returns HTTP 404. It shows the bigbud logo with a gentle "breathing" animation, and the animation is off under `prefers-reduced-motion`.                                                                                                                                                                                                     |
| 2   | `latest` with no script  | `latest` resolves to the newest **stable** release that contains `remote-agent.sh`. If none does (v0.3.3 today), it returns a plain-text 404 that says so and points to `/download/beta/remote-agent`.                                                                                                                                                                             |
| 3   | Channels                 | **No cross-channel fallback.** `latest` and `stable` mean the newest stable release only. `beta`, `preview` and `nightly` each mean the newest release of that channel only. Every case requires the `remote-agent.sh` asset. A channel with no qualifying release returns a plain-text 404.                                                                                       |
| 4   | Version in the script    | The release job stamps a `DEFAULT_VERSION` line into the release copy. `BIGBUD_AGENT_VERSION` stays optional, and if both are set they must match. The in-app command keeps passing the env var.                                                                                                                                                                                   |
| 5   | GitHub API               | Optional Pages secret `GITHUB_TOKEN` (fine-grained, public read-only). Responses are cached for 5 minutes at the edge, and the last good answer is served if the API fails.                                                                                                                                                                                                        |
| 6   | URL shape                | `/download/<ref>/remote-agent`, where `ref` is `latest`, `stable`, `beta`, `preview`, `nightly`, or a tag with or without the leading `v`. Redirects are 302 and pinned to `github.com/youpele52/bigbud/releases/download/<tag>/remote-agent.sh`. **The static `/remote-agent.sh` is removed and must 404.** Older apps' copied command then fails cleanly instead of piping HTML. |
| 7   | Clean replacement        | Save with the remote agent method runs the existing install pipeline with `replace: true`, then `connectRemoteAgent({ fresh, replace: true })`. Builds used by live work stay until that work ends, and the UI says so. No parallel install path.                                                                                                                                  |
| 8   | Save without asking      | Save installs or replaces **without a confirmation dialog**. It skips the step when the identical verified build is already active. The consent and location text (`~/.bigbud/agent`, SSH user permissions, no inbound port, cleanup rule) stays visible as inline text in the Edit dialog while the remote agent method is selected.                                              |
| 9   | Settings host list       | Shows every saved remote host, both agent and Direct SSH, deduplicated by target. Connected hosts are listed first. Disconnected hosts are listed last and greyed out. It never connects just to show status.                                                                                                                                                                      |
| 10  | Remove                   | Deletes only `~/.bigbud/agent`. If live work uses any build, it refuses and lists the blockers. Otherwise it deletes the directory, **disconnects all of that host's connections** and makes the user reconnect over SSH or the remote agent. Reconnecting with the remote agent downloads and installs it fresh.                                                                  |
| 11  | Workspaces after Remove  | The confirmation lists the affected workspaces with "Switch these workspaces to Direct SSH", checked by default.                                                                                                                                                                                                                                                                   |
| 12  | Install on Direct SSH    | "Install, then switch workspaces to the agent" is offered **only for hosts that have already connected successfully over SSH**.                                                                                                                                                                                                                                                    |
| 13  | Copy                     | The new status copy is accepted, and "Finish install" becomes the single label for adopting a staged build.                                                                                                                                                                                                                                                                        |
| 14  | Translucent toasts (new) | Toasts follow the window material and use the floating-surface tint. Severity colour and edge stay, and text stays readable. Solid mode is unchanged. Reduce transparency makes toasts solid.                                                                                                                                                                                      |

## What exists today (research summary)

- **Marketing site:** `apps/marketing` is a static Astro 7 site with no adapter, `functions/`,
  `_redirects`, `_headers` or 404 page.
  - Cloudflare Pages builds it from the `marketing` branch (root `apps/marketing`, `astro build`,
    `dist`) through the Git integration. No workflow deploys it.
  - With no 404 page, Pages serves **the homepage with HTTP 200 for every unknown path**. That is
    why `curl -fsSL https://bigbud.app/remote-agent.sh | sh` fails with "redirection unexpected".
  - `_redirects` does not apply to paths a Pages Function serves. It cannot pick the latest beta
    and cannot return 404, so one Function handles `/download/*`.
- **Releases:** the stable Latest is v0.3.3, which has no `remote-agent.sh`. Only the
  v0.4.0-beta.2 to beta.5 prereleases ship it. There are no preview or nightly releases yet.
  `release.yml:364` copies `apps/marketing/public/remote-agent.sh` into the release assets.
- **Trust:** the script checks the binary's SHA-256 against the unsigned install-source JSON,
  which only guards against corruption. Authenticity is checked in the app:
  `remoteAgentInstallManager.install` → `resolveArtifact({ verifySignature: true })` uses the
  pinned Ed25519 trust store, and inbox bytes are adopted only when they match the signed
  artifact (`remoteAgentInstall.inbox.ts`).
- **Install and replace:** both go through one pipeline (`remoteAgentInstallManager.ts`, the
  `withInstallLock` per target). Replace (`remoteAgentInstall.replace.ts`) retires the
  predecessor only when owner evidence proves it unused, through `--shutdown-supervisor`, which
  the agent refuses while it is busy.
- **No remove capability exists anywhere.** The agent's footprint on a host is
  `~/.bigbud/agent/{bin,state,staging,inbox,control-v1}`. The remote backend runtime owns
  `~/.bigbud/{backend-services,backend-graphs,backend-runtimes,backend-setup,graph,workspace-modes}`
  and systemd user units (`crates/bigbud-remote-agent/src/backend_service`), and Remove leaves all
  of these alone.
- **Settings card:** `RemoteAgentManagementSection.tsx` lists only agent-transport projects.
- **Status bugs:**
  - The orange "ready" is `remoteAgentUpdate.status.ts` falling back to `update?.outcome` for
    `reason`.
  - Equal current and pending versions mean a different build of the same version (for example
    musl replacing gnu), and the UI does not show what differs.
- **Label mismatch:** "Finish install/update" exists only as the install dialog's confirm label
  when its manual panel is open. The Settings button says "Install / stage update".
- **Connection state** (`apps/web/src/stores/remoteAccess/remoteAccess.store.ts`):
  `disconnectedExecutionTargetIds`, `verifiedExecutionTargetIds`, `executionTargetChecks` and
  `remoteConnections`. Disconnecting uses the existing `WsServerDisconnectExecutionTargetRpc`
  (`rpc.remoteAgent.ts`).
- **Toasts:** `apps/web/src/components/ui/toast.tsx:145` uses `bg-popover` plus
  `statusSurfaceAccent` (`packages/ui/src/statusSurface.ts`).
  - `index.windowMaterial.css` sets `--popover` to the floating tint (92%). That is almost opaque
    next to the surface tint (72% light, 64% dark).
  - Severity fills (`bg-success/4` and similar) live in `packages/ui/src/statusSurface.ts`.

### References to the old static URL (all change in Milestone 2 or 3)

- Code:
  - `apps/marketing/public/remote-agent.sh` (moved)
  - `.github/workflows/release.yml:310,364`
  - `scripts/verify-published-remote-agent-script.ts` and `.test.ts`
  - `apps/server/src/remote-agent/remoteAgentManualInstall.ts` and `.test.ts`
  - `apps/server/src/remote-agent/remoteAgentDownload.linux.fixtures.ts:6`
  - `apps/server/src/remote-agent/remoteAgentInbox.claim.linux.test.ts:15`
  - `apps/server/src/remote-agent/remoteAgentInstall.inbox.ts:12` (comment)
  - `apps/web/src/components/sidebar/SidebarRemoteAgentInstallDialog.browser.tsx`
  - `apps/web/src/components/sidebar/SidebarRemoteAgentInstallDialog.manual.browser.tsx`
  - `apps/web/src/components/settings/RemoteAgentManagementSection.browser.tsx`
- Living docs: `docs/COMMANDS.md` (the `verify:published-remote-agent-script` section) and
  `docs/validation/remote-backend-release-handoff.md` section 6.
- Dated plans and reports (`docs/plans/2026-11-13-…`, `2026-11-17-…`,
  `docs/reports/2026-11-17-…`, `2026-11-18-…`) are historical records and stay unchanged.
- `docs/COMMANDS.md` currently has another agent's uncommitted edits on
  `ci/macos-build-speed`. Make the edits after that work lands, or coordinate with it.

## Milestones

Each milestone ends with its focused checks. Use explicit paths with oxfmt and oxlint, and guard
the file list so it is never empty (no `mapfile`). Check the 400-line limit on every changed code
file. Never run `bun test`. Full-suite or repository-wide checks need approval first. Each commit
needs fresh approval.

### M1: marketing 404 page

Files:

- New `apps/marketing/src/pages/404.astro`, with styles in `apps/marketing/src/pages/404.css`
  following the `docs.css` and `changelog.css` pattern.
  - Use the existing logo asset (`public/icon.png` or `public/brand/*`, whichever the header
    uses), a short "Page not found" message, and links to `/`, `/download` and `/docs`.
  - Breathing animation: a CSS keyframe on scale and opacity, roughly 1 → 1.04 and 0.85 → 1, over
    about 4 s, ease-in-out, infinite.
  - Under `@media (prefers-reduced-motion: reduce)`, set `animation: none`.
  - Use the marketing layout so fonts and theme match. Set `noindex`.

Behaviour: Astro builds `dist/404.html`, and Cloudflare Pages then serves it with **status 404**
for unknown paths, which also ends single-page-app fallback mode. Check that `/`, `/download`,
`/docs`, `/changelog`, `/install.sh`, `/install.ps1`, `/llms.txt` and `/sitemap.xml` are
unaffected.

Checks:

- `bun run --cwd apps/marketing typecheck`
- `bun run --cwd apps/marketing build`, then confirm `dist/404.html` exists
- `bunx oxfmt --check` on the two files
- Visual check with `bun run --cwd apps/marketing preview`, including with reduced motion turned
  on

### M2: download Function and removal of the static script

Files:

1. New `apps/marketing/functions/_lib/remoteAgentRelease.ts`, a pure resolver with no Workers
   globals.
   - `parseDownloadRef(ref)` accepts `latest|stable|beta|preview|nightly` or
     `^v?\d+\.\d+\.\d+(?:-(beta|preview|nightly)\.\d+)?$`, normalised to a `v`-prefixed tag.
     Anything else is rejected.
   - `selectRelease(channel, releases)`:
     - skips drafts
     - stable needs `prerelease === false` and a tag with no suffix
     - a channel needs `prerelease === true` and `resolveReleaseChannel(tag) === channel`
     - the release must contain an asset named exactly `remote-agent.sh`
     - picks the newest by semver (not by API order)
     - **never falls back across channels**
   - `remoteAgentDownloadLocation(tag)` returns
     `https://github.com/youpele52/bigbud/releases/download/${tag}/remote-agent.sh`. The
     owner/repo is a constant. The tag is re-validated with the same pattern, including tags
     that come from the API.
   - Import `resolveReleaseChannel` from `apps/marketing/src/lib/releases.ts`. Do not duplicate
     the regex. If the Functions bundler cannot import from `src/`, move the channel helpers to
     `src/lib/releaseChannel.ts` and import them from both places.
2. New `apps/marketing/functions/download/[ref]/remote-agent.ts`, the `onRequestGet` handler.
   - Explicit tag: 302 straight away, with no API call. A missing tag ends up as GitHub's 404,
     which `curl -f` handles.
   - Channel:
     1. Look up the Cache API (key `https://bigbud.app/__cache/remote-agent/<channel>`,
        `max-age=300`).
     2. On a miss, call `GET https://api.github.com/repos/youpele52/bigbud/releases?per_page=50`
        with `Authorization: Bearer ${env.GITHUB_TOKEN}` when set, `User-Agent: bigbud-download`,
        `Accept: application/vnd.github+json`, and a 5 s timeout.
     3. Store the resolved tag in a fresh entry and in a long-lived "last good" entry with a
        7-day TTL.
     4. On an API error, serve the last good entry. If there is none, return 503.
   - Errors return `text/plain; charset=utf-8` with a single-line message, `Cache-Control:
no-store` and `X-Content-Type-Options: nosniff`. Unknown ref, and a channel or stable with
     no release that has the asset, return 404. The 404 for stable explains that no stable
     release ships the script yet and points to `/download/beta/remote-agent`.
   - Redirects carry `Cache-Control: public, max-age=300`. Pinned-tag redirects get a longer
     `max-age` because they never change.
3. New `apps/marketing/public/_routes.json` with
   `{"version":1,"include":["/download/*"],"exclude":[]}`, so only `/download/*` invokes the
   Function. Confirm that `/download` (the Astro page) is still served statically. If the
   pattern also catches `/download/`, narrow the include to `/download/*/remote-agent`.
4. Resolver tests:
   - Add `"test": "vitest run"` and `vitest` (catalog) to `apps/marketing/package.json`, plus
     `apps/marketing/functions/_lib/remoteAgentRelease.test.ts`.
   - Cover: each channel picks only its own channel, stable ignores prereleases, a release
     missing the asset is skipped, semver ordering beats API ordering, refs are validated
     (`../`, `%2f`, `vX`, an over-long ref, a newline), and `Location` is always on the pinned
     host and path.
   - Add a small handler test with a mocked `fetch` and cache: stale fallback, 503, and token
     header present or absent.
5. Typecheck: make sure `astro check` either includes `functions/` with Workers types (add
   `@cloudflare/workers-types` as a stable dev dependency) or uses a separate
   `functions/tsconfig.json` and an extra `typecheck:functions` script. Choose whichever keeps
   `bun run --cwd apps/marketing typecheck` covering the Function.
6. **Remove the static script from the site:** move `apps/marketing/public/remote-agent.sh` to
   `scripts/release-assets/remote-agent.sh` (`git mv`, keeping history). Update every reference
   to that path:
   - `.github/workflows/release.yml:364` copy source
   - `apps/server/src/remote-agent/remoteAgentDownload.linux.fixtures.ts:6` and
     `remoteAgentInbox.claim.linux.test.ts:15` (`new URL(...)` path)
   - `scripts/verify-published-remote-agent-script.ts:21,146,157` and its test
   - any CI invariant test that asserts the copy path (search `apps/server/scripts/*Workflow*`)
7. Docs:
   - `docs/COMMANDS.md`: a new "Download links" table, and the updated verifier section.
   - `apps/marketing/public/llms.txt`: mention `/download/<ref>/remote-agent`.
   - `docs/validation/remote-backend-release-handoff.md` section 6: new URLs, the static path
     removed, and the deploy happening by squash-merge at beta.6.

Checks:

- `bun run --cwd apps/marketing test`, `typecheck` and `build`
- `bun run --cwd scripts vitest run verify-published-remote-agent-script.test.ts` and
  `bun run --cwd scripts typecheck`
- `bun run --cwd apps/server vitest run src/remote-agent/remoteAgentInbox.claim.linux.test.ts`
  (it runs on Linux; on macOS confirm it is skipped, and in that case CI covers it)
- explicit oxfmt and oxlint
- Local check of the Function: `bunx wrangler pages dev apps/marketing/dist` if wrangler is
  available. Otherwise rely on the handler test and a Cloudflare preview deployment, which the
  Git integration builds for the PR branch.

### M3: script stamping and the published-script verifier

Files:

1. `scripts/release-assets/remote-agent.sh`:
   - Add one line, `DEFAULT_VERSION="" # stamped by release.yml`.
   - `VERSION="${BIGBUD_AGENT_VERSION:-$DEFAULT_VERSION}"`. If both are non-empty and differ,
     fail with exit 2.
   - The message when no version is set reads: "Use https://bigbud.app/download/<channel>/remote-agent
     or copy the pinned command from bigbud."
   - Header usage comment: `curl -fsSL https://bigbud.app/download/latest/remote-agent | sh`.
   - Next-step text: "Finish install".
2. `.github/workflows/release.yml` (next to line 364):
   - After copying, stamp with `sed` on the line anchored at `^DEFAULT_VERSION=""`, using the
     release version without the `v`.
   - Then assert that exactly one line differs from the source (`diff | grep -c '^>'` is 1) and
     that `sh -n` passes.
   - Update the matching invariant test under `apps/server/scripts/` if one asserts this step.
3. `scripts/verify-published-remote-agent-script.ts` (split into `.ts` plus `.download.ts` if it
   would exceed 400 lines):
   - Drop the comparison against the published site copy.
   - Check that `https://bigbud.app/remote-agent.sh` returns **404** (not 200 HTML).
   - New `--download <ref>`: follow redirects, require every hop to be on `SITE_HOSTS` or
     `RELEASE_HOSTS`, and require the body to equal the repository script after normalising the
     stamped line, with the stamp equal to the resolved tag.
   - Keep `--release v<x>`, also with normalisation.
   - Update the test file to match.

Checks:

- scripts Vitest for the verifier test
- `bun run --cwd scripts typecheck`
- `sh -n scripts/release-assets/remote-agent.sh`
- a local stamping dry run (copy, `sed`, `diff`)
- the server Linux script tests from M2, which run the script, including a new case: stamped
  version used, mismatched env refused

**Needs a live Linux VM:** run the stamped script from a beta.6 release candidate (or the
locally stamped file) through `sh`, and confirm both musl and gnu triple selection.

### M4: server manual command uses the new link (request D, server part)

Files:

- `apps/server/src/remote-agent/remoteAgentManualInstall.ts`:
  - Replace `REMOTE_AGENT_SCRIPT_URL` with `REMOTE_AGENT_DOWNLOAD_BASE = "https://bigbud.app/download"`.
  - `scriptUrl` becomes `${base}/v${version}/remote-agent`.
  - Command: `curl -fsSL <scriptUrl> | BIGBUD_AGENT_VERSION=<v> sh`.
  - When the repository is not the default, `scriptUrl` and the command use the GitHub release
    URL directly, with the existing `BIGBUD_RELEASE_REPOSITORY=` prefix.
  - `releaseScriptUrl` is unchanged.
- `apps/server/src/remote-agent/remoteAgentManualInstall.test.ts`: the new expectations.
- `apps/server/src/remote-agent/remoteAgentInstall.inbox.ts:12`: comment only.
- `packages/contracts/src/server/server.remoteAgentInstall.ts`: doc comments on `scriptUrl` and
  `releaseScriptUrl` only. The schema shape does not change.

Checks:

- `bun run --cwd apps/server vitest run src/remote-agent/remoteAgentManualInstall.test.ts`
- `bun run --cwd apps/server typecheck`
- `bun run --cwd packages/contracts typecheck`
- explicit oxfmt and oxlint

### M5: remove capability (server, contracts, CLI)

Files:

1. Contracts (schema only), in `packages/contracts/src/server/server.remoteAgentInstall.ts`:
   - `ServerRemoveRemoteAgentInput { executionTargetId, switchWorkspacesToDirectSsh?: boolean }`
   - `ServerRemoveRemoteAgentResult`: a union of
     - `{ outcome: "removed", disconnected: number, switchedWorkspaceIds: ProjectId[] }`
     - `{ outcome: "blocked", blockers: Array<{ kind: "terminal"|"process"|"watcher"|"stage"|"admission"|"backend-runtime", label: string }> }`
     - `{ outcome: "failed", message }`
   - `packages/contracts/src/constants/websocket.constant.ts`: add
     `serverRemoveRemoteAgent: "server.removeRemoteAgent"`.
   - `packages/contracts/src/server/rpc.remoteAgent.ts`: add `WsServerRemoveRemoteAgentRpc`, and
     register it wherever the RPC group is assembled (follow `WsServerGetRemoteAgentManualInstallRpc`).
2. Server:
   - New `apps/server/src/remote-agent/remoteAgentInstall.remove.ts`, plus
     `remoteAgentInstall.remove.blockers.ts` to stay under 400 lines.
   - Exposed as `remove(executionTargetId)` on `makeRemoteAgentInstallManager`
     (`remoteAgentInstallManager.ts` is at 349 lines, so add only the delegating method there).
   - It runs inside `withInstallLock`, so install, replace and remove on one host never overlap.
   - Order of steps: 1. **Blockers:** read the registry (`control.registry.read()`) and owner evidence
     (`remoteAgentOwners().referencedBuildIds(target)`). Also consult the PTY and process
     inventories (`remoteAgentPtyInventory.ts`, `remoteAgentReadOnlyInventory.ts`). Block on:
     any referenced build, launches in progress, stage or admission reservations, and a
     remote backend runtime that uses the agent (`backend_service` status through the
     existing remote-backend status path). If anything blocks, return `blocked` with labels. 2. **Idle shutdown:** run `--shutdown-supervisor` through the current build. If it refuses
     (work started meanwhile), return `blocked`. Never kill anything. 3. **Delete:** under the inbox `.claim.lock` (shared with the script), write a removal
     tombstone to `state`. Then delete the managed directories under `~/.bigbud/agent` with
     the guards from `remoteAgentInstall.retirement.deletion.ts` (canonical path under
     `$HOME/.bigbud/agent`, owner check, no symlinks followed), and finally the `agent`
     directory itself. - User-managed external binaries (`runtime.origin !== "managed"`) outside that tree are
     never touched. - `~/.bigbud/backend-*`, `graph` and `workspace-modes` are never touched. 4. **Disconnect:** run the existing disconnect for every connection to that target (the
     same server effect behind `WsServerDisconnectExecutionTargetRpc`). Drop pool entries
     (`remoteAgentConnectionPool*`). Clear owner bindings, admission request ids and the
     update-coordinator state (`remoteAgentUpdate.state.ts`) for the target. 5. **Workspaces:** when `switchWorkspacesToDirectSsh` is true (the default), dispatch the
     existing project update so each workspace on that host uses `remoteTransport:
"direct-ssh"`. Find the command used by the edit dialog's save path, and reuse it rather
     than writing projects directly.
   - Crash safety: if the tombstone is still there at the next install or cleanup, finish the
     deletion first. A fresh install after removal uploads new bytes, because the inbox and
     managed bytes are gone and `probePlacedArtifact` returns `absent`.
   - WebSocket handler in `apps/server/src/ws/wsRpcHandlers.gitTerminal.ts`, next to
     `serverInstallRemoteAgent`. The effect goes in a new
     `apps/server/src/ws/wsRemoteAgentRemove.ts`.
3. CLI: `bigbud remote-agent remove <target> [--switch-to-direct-ssh|--keep-transport] [--yes]
[--json]`, in the existing `apps/server/src/cli/cli.remoteAgent*.ts` (a new
   `cli.remoteAgent.remove.ts`). Document it in `docs/COMMANDS.md` next to `install`.
4. Web RPC client: add `removeRemoteAgent` to `apps/web/src/rpc/wsNativeApi*` (follow
   `installRemoteAgent`) and to the native API type.
5. Tests:
   - `remoteAgentInstall.remove.test.ts`: blocked by references, by an active stage, and by the
     backend runtime; supervisor refusal; success clears local state; an interrupted removal
     resumes; symlink and foreign-owner refusal; external binary untouched.
   - `remoteAgentInstall.remove.linux.test.ts`: real filesystem with a fixture HOME, following
     `remoteAgentInstall.retirement.deletion.linux.test.ts`.
   - CLI test following `cli.remoteAgent.replace.test.ts`.

Checks:

- `bun run --cwd apps/server vitest run` on the new remove tests, the CLI test, and the existing
  `remoteAgentInstall.retirement*` and `remoteAgentInstallManager*` tests
- typecheck for `apps/server`, `packages/contracts` and `apps/web`
- explicit oxfmt and oxlint
- the 400-line limit

**Needs a live Linux VM:**

1. Remove while a terminal is open: it is blocked and lists the terminal.
2. Close the terminal and remove: `~/.bigbud/agent` is gone, `~/.bigbud/backend-*` is intact,
   and the app shows the host as disconnected.
3. Reconnect with the remote agent: a fresh upload and install happens.

### M6: Settings → Remote agents card for every host (request C)

Files:

- Split `apps/web/src/components/settings/RemoteAgentManagementSection.tsx` into:
  - `RemoteAgentManagementSection.tsx` (layout)
  - `RemoteAgentManagementSection.logic.ts`, with the pure host model:
    - deduplicate saved projects by `resolveWorkspaceExecutionTargetId`, both transports
    - connected means not in `disconnectedExecutionTargetIds`, and present in
      `verifiedExecutionTargetIds` or `remoteConnections`
    - sort connected first, then by host name
    - `hasConnectedOverSsh`: the target is in `verifiedExecutionTargetIds` or has a successful
      `executionTargetChecks` entry. Saved workspaces were verified when saved, but that flag is
      in memory only, so a host verified in an earlier app session reads as "connect first".
  - `RemoteAgentManagementSection.host.tsx`, one host row.
- Host row:
  - Disconnected rows use `opacity-60`, keep their actions disabled, and show "Connect to manage"
    as the only hint. No SSH is opened.
  - Status (read-only): agent version from the store's `remoteConnections`, or "Not installed",
    or "Not checked".
  - Actions:
    - **Install agent** when no agent is present. On a Direct SSH host, this is shown only when
      `hasConnectedOverSsh`. Afterwards it offers "Use the remote agent for workspaces on this
      host", which switches through the existing edit and save path.
    - **Update** (stages, with copy that says it is used on the next Connect new session) and
      **Replace now**, when an agent is present.
    - **Remove agent**: opens a confirmation listing the affected workspaces, with the checkbox
      "Switch these workspaces to Direct SSH" checked. If the result is `blocked`, show the
      blockers in amber. If it is `removed`, show a green notice: "Removed. Reconnect over SSH
      or the remote agent."
    - **Copy remote command**, kept as it is.
  - Replace the long description paragraph with one helper line under each action.
- `apps/web/src/components/settings/RemoteAgentManagementSection.browser.tsx`: update the
  fixtures to the new URL. Add cases for a Direct SSH host, ordering with greyed-out disconnected
  rows, Remove blocked and removed, and install-then-switch hidden when not verified.
- `RemoteAgentManagementSection.logic.test.ts`: test the model and the sorting.

Checks:

- `bun run --cwd apps/web vitest run src/components/settings/RemoteAgentManagementSection.logic.test.ts`
- `bun run --cwd apps/web test:browser src/components/settings/RemoteAgentManagementSection.browser.tsx`
- `bun run --cwd apps/web typecheck`
- explicit oxfmt and oxlint
- the 400-line limit

### M7: Edit dialog installs on Save, and clearer status (request B)

Files:

1. `apps/web/src/components/sidebar/Sidebar.remoteWorkspaceAddActions.ts`:
   - When verification returns `install-required` or `upgrade-required` (or when a pending or
     newer build exists, from `getRemoteAgentUpdateStatus`), run the install with
     `replace: true` and then `connectRemoteAgent({ intent: "fresh", replace: true })`
     **without** opening `SidebarRemoteAgentInstallDialog`.
   - Skip both steps when the active build's digest equals the app's signed artifact.
   - Show progress in the dialog: blue "Downloading verified agent…", then "Connecting…". Show
     `cleanupMessage` in green when done. Failures show red with the manual-command panel
     expanded.
   - Move the install-then-connect sequence into a new
     `Sidebar.remoteWorkspaceAgentInstall.ts` (shared with the Settings card's Install action) so
     it is not duplicated.
2. `apps/web/src/components/sidebar/SidebarRemoteAgentInstallDialog.tsx`: keep it only for
   Settings → Install (an explicit action) and the manual "Finish install" flow, or remove it if
   M6 inlines the same flow. Prefer keeping one shared component.
3. `apps/web/src/components/sidebar/SidebarRemoteWorkspaceDialog.tsx` (215 lines) and
   `SidebarRemoteWorkspaceDialog.options.tsx`: while the remote agent method is selected, show
   inline muted `text-xs` text:
   > The agent is installed in ~/.bigbud/agent on the host and runs with your SSH user's
   > permissions. It opens no network port. Saving installs or updates it; older versions are
   > removed once nothing uses them.
4. Server, `apps/server/src/remote-agent/remoteAgentUpdate.status.ts`:
   - Remove the `update?.outcome` fallback from `reason`.
   - Add `pendingTargetTriple` and `pendingBuildDigestShort` (and the same fields for the
     current build) so equal versions can be told apart. This adds optional fields to the
     contract `ServerRemoteAgentUpdateStatus` in `packages/contracts/src/server/server.ts`.
   - Map the new fields in `apps/server/src/ws/wsRemoteAgentAdmission.ts`.
5. Copy: `apps/web/src/components/sidebar/SidebarRemoteAgentStatus.tsx` (280 lines). Move
   `remoteAgentUpdateStatusMessage` and the labels into a new `SidebarRemoteAgentStatus.copy.ts`.
   - "Current connection" becomes "Running now".
   - "Pending update" becomes "Downloaded update". When the version matches the running one, it
     reads "0.4.0-beta.5 (musl build)".
   - "Healthy fallback" / "None verified" becomes "Backup version" / "None".
   - `ready-for-next-reconnect` becomes: "Update {v} is downloaded and verified. It starts the
     next time you choose Connect new session. Open terminals keep running on the current
     version."
   - The footer becomes: "Connect new session uses the newest verified agent. Running terminals
     stay on their version."
   - Colours: blue for working, green for done, amber for warnings, red for failures. The amber
     reason line is no longer shown for outcomes.
6. Tests:
   - `SidebarRemoteAgentStatus.browser.tsx`, `SidebarRemoteWorkspaceDialog.browser.tsx` and
     `SidebarRemoteWorkspaceDialog.upgrade.browser.tsx`: no modal on Save, the identical build is
     skipped, progress and cleanup copy.
   - `SidebarRemoteAgentInstallDialog.browser.tsx`: new URL fixtures.
   - Server: `remoteAgentUpdate.status` test (no outcome in `reason`, triple and digest fields).
   - `apps/web/src/rpc/wsNativeApi.remoteAgent.test.ts`.

Checks:

- focused web Vitest and browser tests for the files above
- `bun run --cwd apps/server vitest run` on the update-status test
- typecheck for `apps/web`, `apps/server` and `packages/contracts`
- explicit oxfmt and oxlint
- the 400-line limit

**Needs a live Linux VM:**

1. Edit a Direct SSH workspace, choose the remote agent and Save. The agent installs with no
   modal, connects, and older builds are removed.
2. Save again: the identical build is skipped.
3. With a terminal open on the old build, Save after a new release: the new build becomes
   active, and the old one is reported as removed when the terminal closes.

### M8: manual panel copy and the single "Finish install" label (request D, web part)

Files:

- `apps/web/src/components/sidebar/SidebarRemoteAgentManualInstall.tsx`. Panel text:

  > Run this on the remote host. It downloads bigbud remote agent {version}, checks its SHA-256
  > against the release, and stores it in {inbox}. Nothing runs until you return here and choose
  > Finish install. bigbud then checks the release signature and activates it.

  Fallback line:

  > If the host cannot reach bigbud.app, run the same script from GitHub: {releaseScriptUrl}

- The confirm label in `SidebarRemoteAgentInstallDialog.tsx`, the Settings card button (M6), and
  the next-step text in `scripts/release-assets/remote-agent.sh` (M3) all say **"Finish
  install"**.
- `apps/server/src/remote-agent/remoteAgentFailure.classify.ts:104`: check the wording of the
  inbox-mismatch message ("run the copied command again").
- Tests: `SidebarRemoteAgentInstallDialog.manual.browser.tsx` and
  `RemoteAgentManagementSection.browser.tsx`.

Checks: the focused browser tests, `bun run --cwd apps/web typecheck`, and explicit oxfmt and
oxlint.

### M9: translucent toasts (web only)

Files:

1. `apps/web/src/index.windowMaterial.css`:
   - Add `--app-shell-toast-tint`. It defaults to the solid fill (100%) outside translucent mode.
   - Under `html[data-desktop-shell="macos"][data-window-material="translucent"]`, set it to the
     floating tint value, and lower it if 92% looks opaque. Tune it against the 72% light and 64%
     dark surface tints until toasts look like the other floating surfaces, with text contrast
     at or above WCAG AA (4.5:1).
   - Add a `--toast-background: color-mix(in srgb, var(--popover-solid) var(--app-shell-toast-tint), transparent)`
     token.
   - In the existing `prefers-reduced-transparency: reduce` block, set the toast tint to 100%.
   - If the floating tint itself should change for every floating surface, change it there
     instead of adding a toast-only token. Decide this while implementing by comparing menus and
     toasts side by side. Either way, one token controls it.
2. `apps/web/src/components/ui/toast.tsx:145`:
   - Replace `bg-popover` with `bg-(--toast-background)`, or keep `bg-popover` if the shared
     floating tint is adjusted.
   - Add `backdrop-blur-md` only in translucent mode
     (`[html[data-window-material=translucent]_&]:backdrop-blur-md`) for readability.
   - Keep `statusSurfaceAccent(toast.type)` (the severity edge) unchanged.
3. `packages/ui/src/statusSurface.ts`: leave it unchanged unless the severity fills disappear on
   the translucent fill. If they do, raise only those alpha values, for example `/4` to `/8`, in
   one place.
4. Tests: extend `apps/web/src/components/ui/toast.consistency.browser.tsx` (or
   `statusSurface.browser.tsx`).
   - In translucent mode, the computed toast background alpha is below 1.
   - With reduced transparency, or in solid mode, it equals 1.
   - The severity border class is still present.

Checks:

- `bun run --cwd apps/web test:browser src/components/ui/toast.consistency.browser.tsx`
- `bun run --cwd apps/web typecheck`
- explicit oxfmt, plus oxlint on `toast.tsx`
- Manual: desktop dev on macOS, translucent and solid modes, light and dark themes, with System
  Settings → Reduce transparency turned on

### M10: deploy and live verification (only on the user's go-ahead for v0.4.0-beta.6)

1. Commit each milestone on `dev` after approval, then merge `dev` into `main` as part of the
   v0.4.0-beta.6 release flow.
2. When the user says go: **squash-merge `main` into `marketing` and push** (this needs separate
   approval). Cloudflare redeploys. Set the Pages secret `GITHUB_TOKEN` beforehand if the user
   wants it.
3. Live checks:
   - `curl -sI https://bigbud.app/remote-agent.sh` returns 404.
   - `curl -sI https://bigbud.app/nope` returns 404 with the breathing-logo page.
   - `curl -sI https://bigbud.app/download/beta/remote-agent` returns a 302 to
     `…/v0.4.0-beta.6/remote-agent.sh`.
   - `/download/latest/remote-agent` returns a plain-text 404 until 0.4.0 stable exists.
   - `/download/v0.4.0-beta.6/remote-agent` and `/download/0.4.0-beta.6/remote-agent` both
     return 302.
   - `/download/nightly/remote-agent` returns a plain-text 404.
   - `bun run verify:published-remote-agent-script --download beta --release v0.4.0-beta.6`
4. **Linux VM, end to end:**
   1. `curl -fsSL https://bigbud.app/download/beta/remote-agent | sh` stages into the inbox.
   2. Finish install in the app.
   3. Connect new session.
   4. Remove the agent (blocked case, then success).
   5. Reconnect with the remote agent: a fresh install happens.
   6. Repeat on an aarch64 or musl host if one is available.

## Parts that need a live Linux VM

- M3: the stamped script runs, and the musl or gnu triple is selected.
- M5: removal blockers, removal on a real filesystem, the forced disconnect, and the fresh
  reinstall afterwards.
- M7: Save installs without a modal, the identical build is skipped, and old builds are retired
  while live work keeps its build.
- M10: the full channel-link to Finish install to Remove to reinstall loop against the deployed
  site.

Everything else is covered by focused unit, browser and Function tests and a local
`astro build` and preview.
