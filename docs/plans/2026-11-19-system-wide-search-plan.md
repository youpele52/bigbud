# System-wide search for Mod+F ("Spotlight, but better")

**Date:** 19 November, 2026
**Status:** Ready for implementation. Revisited on 19 November 2026 against every commit from `724ec1abd5` to `d56720b52e` (terminal paste staging, create-only writes, shared path/byte helpers, Settings › Terminal split). User decisions are recorded in §Decisions; remaining open questions are adopted as "Assumed (recommended) — user may revise".
**Owner:** bigbud core (server, web, desktop, Rust agent)

## Summary

Mod+F becomes one search over everything the user works with. Results are ranked in fixed tiers: the current thread, the current project, other bigbud data, other projects' files, this computer, and remote areas outside projects. Results stream in as each source answers, and every keystroke cancels the work started for the previous query.

A single Rust search engine, built on ripgrep's library crates, runs inside `bigbud-remote-agent`. It serves both local search (through the local agent the server already starts) and remote search (through each managed agent). It replaces the agent's naive `workspace/search.rs` walker and the server's use of `rg` from `PATH`. "This computer" results come from the operating system's own index. On macOS that is Spotlight, queried through the `MDQuery` API inside the local agent. Windows Search and Linux `plocate` adapters follow later. bigbud never builds its own whole-disk index.

Supported file types open inside bigbud. Anything else opens in the system default app, with path checks in the desktop shell.

## Related Work

- Research report: [System-wide search research](../reports/2026-11-19-system-wide-search-research.md). This plan is built on its phases and risks.
- [Saved conversation search plan](2026-09-23-saved-conversation-search-plan.md): the FTS5 trigram index, its 3–160 code point limits, and the unavailable/stale states.
- [Remote workspace search and recovery plan](2026-10-28-remote-workspace-search-and-recovery-plan.md): agent filename-search semantics, the symlink-skip fix, and the 30-second remote recovery policy.
- [Rust remote agent boundary decision](../decisions/2026-08-22-rust-remote-workspace-agent-boundary.md).
- bigbud note or Kanban card: none identified. The request came in conversation. See open question Q12.

## Revisit after the terminal work (724ec1abd5..d56720b52e)

What changed since the draft, and what it means for this plan:

| Change since the draft                                                                                                                                                                                                                                                                                                                                 | Effect on this plan                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Paste staging took `Frame` oneof numbers **66–73** (`paste_staging.proto`, `v1.proto`).                                                                                                                                                                                                                                                                | Search frames start at **74**. Free range is now 74–99 (35–41 are also unused but sit inside the historical block; do not use them).                                                                                                                                                             |
| Paste staging and `create_only = 8` (`WriteFileRequest`, `workspace.proto`) shipped **without a `PROTOCOL_MINOR` bump**; both are gated only by new capabilities (`terminal.paste-staging`, `workspace.write-create-only`). Remote install and identity checks compare the minor exactly (`remoteAgentIdentity.ts`), and the local `--check` does too. | **Easier.** Search follows the same precedent: no minor bump, capability-only gating. `PROTOCOL_MINOR` stays 8. Old remote agents are detected by the missing capability, not by version.                                                                                                        |
| Capabilities are filtered per session in `session/hello.rs` (`terminal.paste-staging` only when `has_paste_staging()`); the supervisor appends connection-scoped `terminal.pty-detach`.                                                                                                                                                                | `os-index.search` uses the same filter with a session flag (`enable_os_index()` → `has_os_index()`), set only by `--ephemeral --os-index`. `workspace.search-stream` is unconditional. Neither name collides with `workspace.search`, `workspace.write-create-only` or `terminal.paste-staging`. |
| Paste staging added a separate proto file (`paste_staging.proto`), a `build.rs` rerun line, Rust frame tests (`frame/paste_staging.tests.rs`), a single TS codec file (`remoteAgentProtocol.codec.pasteStaging.ts`) plus a constants/types file (`remoteAgentProtocol.pasteStaging.ts` exporting the capability name), and golden frames.              | Search mirrors this exactly: `search.proto`, `remoteAgentProtocol.search.ts` (types + `REMOTE_AGENT_SEARCH_STREAM_CAPABILITY`), `remoteAgentProtocol.codec.search.ts`, `frame/search.tests.rs`.                                                                                                  |
| `supervisor/core.rs` is now 387 lines; `main.rs` is 290.                                                                                                                                                                                                                                                                                               | **Harder.** The supervisor search branch must live in a new `supervisor/search.rs`; `core.rs` only gains a one-line dispatch. The stdio branch in `main.rs` calls a library helper (`search::stdio`), keeping `main.rs` composition-only.                                                        |
| `LocalWorkspaceWatchAgent` is created **inside** the `WorkspaceWatch` layer (`localWorkspaceWatchLayer.ts`) and is not a service.                                                                                                                                                                                                                      | **Harder.** Phase 2 promotes it to a `LocalWorkspaceAgent` service so search and watch share one process. Local watching already requires the binary, so requiring it for search adds no new failure mode.                                                                                       |
| New `@bigbud/shared/path` (`isAbsolutePath`, `isWindowsAbsolutePath`) and `@bigbud/shared/bytes` (`formatBytes`).                                                                                                                                                                                                                                      | Reused: `isAbsolutePath` in loose-file and open-path validation on web and server; `formatBytes` for result sizes and the remote download confirm. No new path or byte helpers.                                                                                                                  |
| Server config reports `homeDir` (`server.ts`, `wsRpcContext.ts`); web uses it with `cwd: homeDir` to open files outside projects (Terminal agent hooks).                                                                                                                                                                                               | T5 rows display `~/…` with `homeDir`. The loose-file preview keeps its own validated kind; it does not copy the `cwd: homeDir` shortcut.                                                                                                                                                         |
| `projects.writeFile` gained `createOnly`.                                                                                                                                                                                                                                                                                                              | Not needed by search.                                                                                                                                                                                                                                                                            |
| Migration `180_TerminalActivity`.                                                                                                                                                                                                                                                                                                                      | No migration is needed by this plan. If one becomes necessary, it is `181`.                                                                                                                                                                                                                      |
| Settings › Terminal was split into grouped sections; settings search items live in `SETTINGS_SEARCH_ITEMS`. File Access is on Settings › **AI**.                                                                                                                                                                                                       | The new Search section sits on Settings › AI next to File Access, and adds "Search this computer" and "Search connected remote backends" to `SETTINGS_SEARCH_ITEMS`.                                                                                                                             |
| SearchPalette icon changes (Hugeicons `Comment03Icon`) predate the plan. Desktop and server open-path code are unchanged.                                                                                                                                                                                                                              | No effect.                                                                                                                                                                                                                                                                                       |

No change makes the plan unsound.

## Decisions

User decisions (authoritative):

- One Rust engine in `bigbud-remote-agent` on ripgrep's library crates (`ignore`, `grep-searcher`, `grep-regex`; approved).
- Hybrid: bigbud data and all project files first; "this computer" only through the OS index (macOS `MDQuery` first; Windows Search and Linux `plocate` later as adapters). Raycast and Alfred are not queried. No bigbud-owned whole-disk index.
- Full Disk Access stays in Settings › File Access.
- Remote: bounded live scans as the agent user, no `sudo`, nothing outside that account.
- Ranking tiers T1–T6 as in Design §1. Streaming with cancellation on every keystroke.
- Supported formats open in bigbud; others in the system default app. **Executables are revealed, never launched** (no confirm-to-launch override).
- Settings toggles "Search this computer" and "Search connected remote backends".
- User decisions of 20 November 2026 (Mod+F and Mod+P):
  - **Both toggles are on by default.** File Access stays the gate: with File Access at "No access" (its default) "this computer" stays off, enforced on the server as before. Q1 below is revised accordingly.
  - **Search never connects just to search.** Every remote tier in both palettes uses only links that are already up (`RemoteAgentConnectionPool.liveConnection`); it never dials, reconnects, installs or starts a remote agent and never spawns `ssh`. A disconnected remote shows "not connected". This supersedes Q5 for `search.query`: SSH-only hosts show "use the bigbud agent" instead of running `rg` on the host (`projects.searchFileContents` keeps Q5 for its other callers).
  - **Performance guards.** Slow tiers (other projects, this computer, remotes) start 150 ms after typing stops in both palettes (`useSlowTierQuery`); fast tiers (Mod+F's T1–T3 and current-project files, Mod+P's local list) stay immediate. One live `search.query` per palette; a new keystroke, a next page, closing or unmounting cancels the previous one. Per-root budgets, priorities and the OS-index slots are unchanged.
  - **Pagination by scroll.** Each tier shows a first page. Its "See more" row is the sentinel: scrolling it into view (after user input: wheel, touch or keys) loads the next page; it stays a button for keyboard and pointer. Client-side rows are revealed first; then `search.query` is asked again for that one tier with `page: n` (≤ 4), which asks every source for `n + 1` first pages (agent roots: limits × `(n + 1)`; OS index: 50 × `(n + 1)` up to 200, `MAX_OS_INDEX_RESULTS`). Ranking is deterministic, so earlier rows come back first and are dropped by stable ID; rows only append. Saved messages keep their keyset cursor and now page on scroll too. Mod+P's local list grows its `projects.searchEntries` limit (80 → 160 → 200).
  - "Search this computer" and File Access link to each other in Settings › AI (`/settings/ai#search-this-computer`, `#file-access-permission-level`; scroll, focus and a brief highlight).

Assumed (recommended) — user may revise:

- Q1 (revised 20 November 2026): "Search this computer" is on by default, gated by File Access (off while File Access is "No access"); the one-time hint now also shows while File Access blocks it.
- Q2: File Access level gates T5 (`none` → off; `common-folders` → Desktop, Documents, Downloads, Music, Pictures; `unrestricted` → non-`Library` home children plus iCloud Drive and CloudStorage), enforced on the server.
- Q3: T6 = registered remote workspace folders that are not projects.
- Q4: names only first; contents later behind a second toggle.
- Q5: keep `rg` on SSH-only hosts, with a "use the bigbud agent" hint. Superseded for `search.query` (Mod+F/Mod+P) by "search never connects": SSH-only hosts get the hint only.
- Q6: tier → relevance → recency, within the newest 200 candidates.
- Q7: read-only previews outside projects; no agent access.
- Q8: remote open: free ≤ 100 MiB, confirm ≤ 2 GiB, refuse above; cache 1 GiB / 7 days.
- Q9: crates approved (ripgrep crates; `objc2-core-services` with `MDQuery`, macOS only).
- Q10: phase order ranking → Rust engine → all-project search → opening files → Spotlight; Windows and Linux later.
- Q11: preview-route tightening is a separate follow-up; not changed here.
- Q12: no note or card link.

## Problem

- Mod+F searches file contents only in the **current** workspace root (`apps/web/src/components/layout/SearchPalette.content.tsx:118-126`). It does not search other projects, the computer, or other connected backends.
- Local content search spawns `rg` from `PATH`, with a slow Node fallback when `rg` is missing (`apps/server/src/workspace/Layers/WorkspaceFileSystem.ts:172-230`). Direct-SSH remotes fail outright without `rg` on the host (`WorkspaceFileSystem.ts:198-205`).
- The agent's content search is a breadth-first walk with no `.gitignore` support, a hard-coded ignore list (`crates/bigbud-remote-agent/src/workspace/search.rs:14`), and case-sensitive matching (`search.rs:162`). It differs from `rg --smart-case`. It still **aborts on any symlink** (`search.rs:187`), although filename search was fixed to skip symlinks. A plain walk of this repository without ignore rules took 38 s (see the findings below).
- In supervisor mode, agent searches run while holding the shared session mutex (`crates/bigbud-remote-agent/src/supervisor/core.rs:349-352`), so a long search blocks every connection to that agent. In stdio mode the frame loop is single-threaded (`crates/bigbud-remote-agent/src/main.rs:45-104`), so a `CancelRequest` cannot even be read until the search finishes.
- Saved-message search sorts by `ORDER BY m.rowid DESC` (`apps/server/src/orchestration/Layers/ProjectionCatalogQuery.search.ts:88`). That forces SQLite to sort every match in a temporary B-tree (measured below). It has no relevance score and no current-thread or current-project boost.

## Goals

1. One Rust engine (`ignore` + `grep-searcher` + `grep-regex`) in `bigbud-remote-agent`, used for local and remote project search. Local search goes through the local agent the server already runs. The server stops calling `rg`.
2. Mod+F searches bigbud data and all project files first. It searches "this computer" only through the OS index (Spotlight first). Remote backends get quick, bounded live scans of their project folders only.
3. Fixed ranking tiers: current thread → current project → other bigbud data → other projects' files → this computer → remote areas outside projects. Rows already shown never reorder.
4. Results stream, and each keystroke cancels the previous query's work end to end: web, server, agent, and Spotlight.
5. Supported formats open inside bigbud. Unsupported formats open in the system default app, and "Reveal in Finder/Explorer" is available.
6. New Settings toggles: "Search this computer" and "Search connected remote backends". Full Disk Access stays in the existing Settings › File Access section.
7. Hard privacy rules: default exclusions are enforced in the engine. OS-search results are never sent to AI providers. Agents cannot use "this computer" search.

## Non-Goals

- A bigbud-owned whole-disk name or content index, a privileged Windows service, or a new Full Disk Access prompt flow. The existing File Access section covers this.
- Querying Raycast or Alfred. They have no third-party index API and use Spotlight themselves.
- Remote search outside the agent account, use of `sudo`, or remote "this computer" search (for example remote `plocate`).
- Launcher features such as apps, a calculator, or system settings.
- Exposing workspace-wide or "this computer" search as an agent tool. Agent-facing search is a separate, later decision.
- ~~Changing Mod+P (`WorkspaceEntries`).~~ Superseded by the user on 20 November 2026: Mod+P
  becomes a file-name search across all sources (Phase 8).
- Exposing search on the mobile gateway surface (`apps/server/src/ws/ws.mobile.ts`).
- Notes and Kanban cards as search sources. They can be added later as tier-3 sources.

## Current State

| Area                    | Behaviour today                                                                                                                                                                                                                                                                                                                                                                                                            | Evidence                                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Palette                 | Separate React Query requests for the current file, saved messages, thread titles, projects (local and remote catalog), terminal scrollback, and current-root file contents. 200 ms debounce, 5 rows per section, 40 content matches.                                                                                                                                                                                      | `SearchPalette.content.tsx:56-58,118-140`, `SearchPalette.results.tsx`                                                                                                      |
| Message search          | FTS5 trigram (`tokenize='trigram'`), 3–160 code points, rowid keyset cursor, `ORDER BY m.rowid DESC`.                                                                                                                                                                                                                                                                                                                      | `Migrations/120_ProjectionMessageSearch.ts:8`, `ProjectionCatalogQuery.search.ts:84-88,140`                                                                                 |
| Local content search    | `runToolCommand("rg", --json --hidden --smart-case …)`, 10 s timeout, 512 KiB buffer, Node fallback.                                                                                                                                                                                                                                                                                                                       | `WorkspaceFileSystem.ts:172-246`, `WorkspaceFileSystem.search.ts`                                                                                                           |
| Remote content search   | Managed agent: `ContentSearchRequest` (single response). Direct SSH: `rg` on the host.                                                                                                                                                                                                                                                                                                                                     | `workspace-runtime/Layers/WorkspaceRuntime.remote.ts:297-330`                                                                                                               |
| Agent protocol          | One `Frame` oneof in `v1.proto`. Workspace messages in `workspace.proto`. `AgentHello.capabilities` lists `workspace.search` 1.0 and others. `PROTOCOL_MINOR` is 8 in Rust and TypeScript (unchanged by paste staging and create-only). Oneof 66–73 are paste staging; free: 74–99. `CancelRequest` covers process operations only.                                                                                        | `protocol/remote-agent/*.proto`, `session/hello.rs:29-56`, `bigbud-protocol/src/lib.rs:11`, `operation_handlers.rs:27-58`                                                   |
| Agent limits            | 1 MiB maximum frame, 64 workspace roots per session, **no workspace close message**, 256 accepted-operation identities kept for 24 h. Current search handlers insert into and then remove from that table. A full table evicts the oldest identity.                                                                                                                                                                        | `bigbud-protocol/src/lib.rs:12`, `session/core.rs:89-93`, `workspace_handlers.rs:140-150`                                                                                   |
| Local agent             | `LocalWorkspaceWatchAgent` starts `bigbud-remote-agent --ephemeral` lazily, over stdio, on macOS, Windows and Linux (all six desktop targets). It requires `workspace.files` and `workspace.watch`. Its binary must report exactly the server's protocol major **and minor** in `--check`, so the local agent and server always ship together.                                                                             | `localWorkspaceWatchAgent.ts:62-140`, `localWorkspaceWatchAgent.binary.ts:73-97`, `scripts/lib/workspace-agent-target.ts`                                                   |
| Opening files in bigbud | Browser panel: `.pdf`, `.htm`/`.html`, images. Files panel: images (avif, bmp, gif, ico, jpeg, jpg, png, svg, webp), video (avi, mov, mp4, webm), `.ipynb`, and everything else as text or code (Markdown rendered). Any path inside a workspace counts as "openable", so binaries currently go to the text preview. Code-related paths that cannot open in bigbud go to the preferred editor, otherwise `shell.openPath`. | `lib/workspaceFilePreview.ts:11-60`, `stores/files/filesPanel.open.ts:150-280`, `FilesPanel.preview.tsx:33-49`, `models/editor/fileOpen.models.ts:117-123`                  |
| System open             | `shell.openPath` already exists as a WS RPC that calls the server's `Open.openPath`. That spawns `open`, `xdg-open` or `explorer` (with `shell: true` on Windows) and does **no path validation**. In the remote-backend profile it fails by design. The desktop shell only uses `shell.openExternal`.                                                                                                                     | `apps/server/src/utils/open.ts:228-290`, `ws/wsRpcHandlers.workspace.ts:156-159`, `remote-backend/unavailable.host.ts:23`, `apps/desktop/src/window/ipcHandlers.ts:228-240` |
| Preview HTTP route      | `/api/workspace-file-preview` accepts any `cwd`, normalises it, and resolves the relative path inside it. There is no check against registered projects.                                                                                                                                                                                                                                                                   | `apps/server/src/ws/http.workspace.ts:131-170`                                                                                                                              |
| File Access settings    | `fileAccessPermissionLevel` (`none`, `common-folders`, `unrestricted`; default `none`) is a **client** setting used only by the UI. Includes a link to the Full Disk Access pane in System Settings.                                                                                                                                                                                                                       | `packages/contracts/src/core/settings.ts:149-153`, `FileAccessSettingsSection.tsx:16-80`                                                                                    |
| Server settings         | A `ServerSettings` struct exists for server-enforced options.                                                                                                                                                                                                                                                                                                                                                              | `packages/contracts/src/core/settings.ts:255`                                                                                                                               |
| Streaming RPC           | Effect RPC `stream: true` is used elsewhere. Interrupting the subscription interrupts the server fiber.                                                                                                                                                                                                                                                                                                                    | `packages/contracts/src/server/rpc.workspace.ts:78-86`, `rpc.terminalStream.ts:12-16`                                                                                       |

## Research Findings

All experiments ran on 19 November 2026 on this Mac (macOS 27.2.1, Apple Silicon), from a sandboxed shell, in a scratch folder that was deleted afterwards. Only counts and timings were recorded, never file names. The figures come from one machine and one run and are indicative only. Phase 0 repeats them in the packaged app.

### a. Spotlight from a non-sandboxed process

**`mdfind` CLI**

- Options are limited to `-0`, `-live`, `-count`, `-onlyin`, `-name`, `-literal` and `-interpret`. There is **no result limit, no sort, and no attribute output**.
- When stdout is a pipe, `mdfind` block-buffers. The first result arrived after 0.55–0.82 s through a pipe, against 0.04–0.20 s through a pty. A subprocess design would need a pty or would see the whole result set late.
- Total time for broad queries: `-name readme` matched 4,286 items in 2.2 s, and `-name a` matched 122,328 in 14.7 s.
- `-onlyin ~` with a very common query took 4.4–7.5 s to produce 50 results.
- Cancelling meant killing the process. The kill was immediate (under 1 ms) and the process was reaped.

**`MDQuery` C API (CoreServices), measured with a small C probe and a Rust probe**

| Query (`kMDItemFSName == "*q*"cd`) | No max count                     | `MDQuerySetMaxCount(50)` |
| ---------------------------------- | -------------------------------- | ------------------------ |
| `readme`                           | 4,415 results in 0.60 s          | 50 in 0.055 s            |
| `package`                          | 6,773 results in 0.59 s          | 50 in 0.053 s            |
| `a`                                | 479,831 results, cut off at 30 s | 50 in 0.09–0.15 s        |
| `invoice` (rare)                   | 10 results in 0.37 s             | 10 in 0.35 s             |
| `zzqqxx` (no match)                | 0 results in 0.35 s              | 0 in 0.36 s              |

- Content queries (`kMDItemTextContent == "q*"cdw`) took 0.03–0.24 s with a maximum of 50. Name **or** content took 0.43–0.71 s.
- A Rust `objc2-core-services` 0.3.2 probe (feature `MDQuery`; licence Zlib/Apache-2.0/MIT) ran a synchronous query in 55–375 ms. The whole probe binary was 0.39 MB stripped and linked only CoreServices and CoreFoundation. `objc2-core-foundation` 0.3.2 is already in `Cargo.lock` through `sysinfo`.
- **Scope matters more than speed.**
  - With the scope set to `$HOME`, 196–199 of the top 200 results for common queries were under `~/Library` (app caches, the pnpm store, Application Support).
  - Scoping instead to the 24 non-`Library` children of `$HOME`, plus `~/Library/Mobile Documents` (iCloud Drive) and `~/Library/CloudStorage`, gave 0 `Library` noise. It returned 200 results in 0.12–0.52 s.
- A home-wide name query returned 148 file names that look sensitive: browser `Cookies` and `Login Data`, `.env` files, `.pem` keys and similar. Exclusions must be enforced in the engine, not only in the UI.
- **Protected folders.**
  - From this process, which cannot list `~/Desktop`, `~/Documents`, `~/Downloads`, `~/Library/Mail`, `~/Library/Messages`, `~/Library/Safari` or iCloud Drive, Spotlight returned **zero** results inside any of them.
  - In this run, Spotlight's results were limited to what the calling process can read.
  - This shell's restriction may come from Claude Code's own sandbox rather than TCC. Phase 0 must repeat this from the packaged bigbud app twice, once without and once with Full Disk Access granted.
  - When Electron's server starts the local agent, the agent is a descendant of the bigbud app. macOS normally attributes privacy (TCC) checks to the responsible app bundle, which needs the same verification.

**Decision: `MDQuery` in the Rust local agent, not `mdfind`.**

- It has a native maximum count, and results arrive in progress batches without the pipe-buffering problem.
- `MDQueryStop` provides cancellation.
- It returns attributes such as `kMDItemPath`, `kMDItemLastUsedDate`, `kMDItemFSSize` and `kMDItemContentType` for ranking.
- It accepts multiple search scopes.
- The cost is one small, macOS-only binding crate.

The probe ran synchronous mode. The engine will run asynchronous mode on a dedicated thread with its own `CFRunLoop`, plus a short run-loop timer that polls a cancel flag and calls `MDQueryStop` and `CFRunLoopStop`. Query strings must still be escaped: backslash-escape `\`, `"`, `*` and `?`, and reject control characters. A `mdfind`-through-a-pty fallback was rejected as fragile.

### b. Local agent availability and protocol versioning

- `LocalWorkspaceWatchAgent` runs on all six desktop targets (macOS, Windows and Linux on arm64 and x64). It is started lazily and restarts with backoff.
- It talks the same framed v1 protocol as remote agents through `RemoteAgentWorkspaceClient`. A search RPC is therefore a protocol addition, not a new process.
- **Local compatibility is automatic.** `--check` requires the exact server protocol minor (`localWorkspaceWatchAgent.binary.ts:89`), and the agent is packaged with the server, so local server and agent change in lockstep.
- **Remote compatibility uses the existing capability pattern.** The agent advertises `(name, major, minor)` in `AgentHello`. The server checks `supportsCapability(name)` against major 1 (`remoteAgentConnection.ts:90-94`).
  - A new capability name (`workspace.search-stream` 1.0) gates the new frames. An old agent never receives them.
  - If a new frame were sent anyway, prost decodes the unknown oneof as `None`. The old agent answers with a `ProtocolError` and does not crash.
  - New agents keep serving the legacy `FilenameSearchRequest` and `ContentSearchRequest` (now backed by the new engine), so older servers keep working.
- Two structural problems must be fixed as part of the protocol work:
  1. Searches run on the frame thread, and in supervisor mode they hold the session mutex. Search must run on a worker, with a reader that stays responsive to `CancelRequest`.
  2. Search must not use the 256-entry, 24-hour accepted-operation table. A search per keystroke would evict real process identities. Search gets its own small in-flight registry.
  - There is also no workspace-close message and a 64-root limit, so workspace-wide search should carry its roots in the request (validated like `WorkspaceOpenRequest`) instead of opening a handle per project.

### c. ripgrep library crates

| Crate (resolved)       | Licence                                                                 | Notes                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ignore` 0.4.34        | Unlicense OR MIT                                                        | Parallel walker, gitignore rules, overrides; no `unsafe`                                                                                                                                               |
| `grep-searcher` 0.1.17 | Unlicense OR MIT                                                        | Line-oriented searcher, binary detection, optional mmap; 2 `unsafe` sites                                                                                                                              |
| `grep-regex` 0.1.14    | Unlicense OR MIT                                                        | Literal and regex matcher with smart case                                                                                                                                                              |
| `grep-matcher` 0.1.9   | Unlicense OR MIT                                                        | Matcher trait                                                                                                                                                                                          |
| New transitive crates  | MIT/Apache-2.0, plus `encoding_rs` (Apache-2.0 OR MIT) AND BSD-3-Clause | `globset`, `bstr`, `encoding_rs`, `encoding_rs_io`, `memmap2`, `crossbeam-*`. Already in the agent: `memchr`, `walkdir`, `same-file`, `log`; `regex-automata` and `aho-corasick` are in the workspace. |

- **Binary size (scratch crate, release build, `strip -x`).** A baseline of `walkdir` + `memchr` was 0.43 MB. The same program with `ignore`, `grep-searcher`, `grep-regex` and `grep-matcher` was 2.64 MB, so the libraries add about **2.2 MB**. Today's stripped release agent is 2.66 MB, so expect roughly 4.6–4.9 MB. `encoding_rs` cannot be turned off and accounts for part of that. The BSD-3-Clause part of its licence needs a notice in the third-party licences file.
- **Speed (this repository, 14,421 files after gitignore, warm cache).**
  - Parallel literal smart-case search over all files finished in 134–169 ms. The first hit arrived after 43–65 ms.
  - With 2 threads: 227 ms.
  - `rg` 15.2 CLI: 164 ms.
  - The naive walk without ignore rules (comparable to today's Node fallback) took **38 s**.
- **Cancellation.** Setting the cancel flag 30 ms and 80 ms into a search stopped it after 33.6 ms and 84 ms total, about 4 ms of latency. The flag was checked per file (returning `WalkState::Quit`) and per match (the sink returns `false`). A single large file is the worst case, which the per-file size cap (5 MiB) bounds.
- **Thread model.** `WalkParallel::run` calls its factory closure once on each worker thread. That is the hook for per-thread priority: QoS `UTILITY` on macOS, `setpriority` and `ioprio_set` on Linux, `THREAD_MODE_BACKGROUND_BEGIN` on Windows. Thread count is set with `.threads(n)`.
- **Streaming over the framed protocol.** Workers send hits into a bounded channel. One emitter thread batches them (at most 64 hits or about 128 KiB, far below the 1 MiB frame cap) and writes frames through the session's existing shared writer, as the watch events already do (`main.rs:52-54`). Batches carry monotonic sequence numbers, and exactly one terminal frame follows.

### d. Windows Search and Linux `plocate` (desk research, not measured)

- **Windows Search.**
  - Query `SystemIndex` through OLE DB (`Provider=Search.CollatorDSO`), with `ISearchQueryHelper` generating the SQL. The `windows` crate (feature `Win32_System_Search`) is already in the lockfile at 0.62.2.
  - Results are security-trimmed to the user, and `SELECT TOP n` gives a native limit.
  - Default scope is the user profile and libraries. The `WSearch` service is often disabled on managed or debloated machines, and the adapter must then report "unavailable".
  - OLE DB from Rust involves a fair amount of COM code. A spike is needed before committing.
- **Linux `plocate`.**
  - It is the default `locate` on Debian 12 and Ubuntu 22.04 and later. Run `plocate -i -l <n> -0 -- <pattern>` as a subprocess, never by linking (the licence is GPL-2.0).
  - It checks per result that the user can access the path.
  - The database is refreshed by a daily `updatedb`, so results can be up to a day old, and the UI should say so.
  - Fallbacks: `locate`, GNOME `localsearch`/`tracker3` and KDE `baloo` can follow later as adapters. Otherwise the tier shows "unavailable".
- **Recommendation:** ship macOS first. Windows and Linux follow as separate adapters behind the same `OsIndexSearch` interface.

### e. Message FTS ranking and short queries

Synthetic benchmark: SQLite 3.51 with the production FTS5 trigram schema shape, 200,000 messages of 20–200 words each.

| Query (matches)          | Current `ORDER BY m.rowid DESC` | `ORDER BY bm25()` | `ORDER BY search.rowid DESC` | Recent 200 by FTS rowid, then tier boost + bm25 |
| ------------------------ | ------------------------------- | ----------------- | ---------------------------- | ----------------------------------------------- |
| common term (173,503)    | 100 ms                          | 212 ms            | **0.5 ms**                   | 52 ms                                           |
| common trigram (174,242) | 52 ms                           | 128 ms            | **0.1 ms**                   | 3.5 ms                                          |
| rare (3,271)             | 2.7 ms                          | 4.4 ms            | 0.1 ms                       | 0.5 ms                                          |

- `EXPLAIN QUERY PLAN` shows the current query uses `USE TEMP B-TREE FOR ORDER BY`. Ordering by the FTS table's own rowid scans in reverse and stops at the limit, so the B-tree goes away.
- **Recommended cheap ranking:**
  1. Fix the order to `search.rowid DESC`. This changes no behaviour, because both rowids are the same value.
  2. Add a current-thread query: indexed `thread_id` lookup plus `instr()` over that thread's messages only. It also works for 1–2 character queries.
  3. Add a current-project query: FTS `MATCH` plus a `project_id` filter.
  4. Rerank the global page within a bounded recent window (for example 200 FTS-ordered candidates) by tier, then `bm25()`, then recency.
  - Full-corpus `bm25()` ordering is rejected because it costs 2x the current query on common terms.
  - Phase 0 confirms the plans on a real database through the server's SQLite build (`NodeSqliteClient` and `BunSqliteReadWorker`).
- **Short queries:**
  - 1–2 characters: client-side thread titles and projects, current-thread messages (`instr`), and current-project file names.
  - 3 or more characters: message FTS and content search.
  - "This computer" and all-project file names start at 2 characters.

### f. File-open matrix and the system-open bridge

The exact lists of what opens where are in the Current State table. Three conclusions:

1. Routing must stop treating "inside a workspace" as "previewable". It should send known binary or unsupported types (Office, audio, archives, fonts, executables, disk images and so on) to the system-open path.
2. The desktop shell should gain `shell.openPath` and `shell.showItemInFolder` IPC with its own path validation. Electron's API calls into the OS without a shell. The server's `Open.openPath` (Windows `shell: true`, no validation) stays as the fallback for web mode on the same machine only.
3. Remote unsupported files are downloaded over the agent to an owner-only cache, then opened. Supported remote files keep using the existing preview over the agent (5 MiB text cap, ranged video).

## Design

### 1. Tier model and result identity

Fixed tier order. Scores only compare rows within the same tier.

| Tier | Contents                                                                                                                            | Sources                                       | Minimum query length                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------- |
| T1   | Current thread: messages, the current file preview, the current thread's terminals                                                  | Server message query; existing client sources | 1                                               |
| T2   | Current project: file names and contents, thread titles and messages in the project                                                 | Agent engine (local or remote); server FTS    | Names 1, contents 3, messages 3                 |
| T3   | Other bigbud data: thread titles, messages, projects, terminals                                                                     | Existing sources with FTS ranking             | Titles and projects 1, messages and terminals 3 |
| T4   | Other projects' files: local first, then connected remotes                                                                          | Agent engine fan-out                          | Names 2, contents 3                             |
| T5   | This computer                                                                                                                       | OS index through the local agent              | 2                                               |
| T6   | Remote areas outside projects: registered remote workspace roots that are not themselves project folders. Never host-wide (see Q3). | Remote agent engine                           | Names 2, contents 3                             |

- Every row has a stable ID: `tier:source:target:path[:line]`. React keys and cmdk values use it, so streamed rows append without reordering existing ones.
- Within a tier the order is:
  1. exact basename match;
  2. prefix match;
  3. path-segment or word-boundary match;
  4. subsequence (fuzzy) match;
  5. ties broken by bigbud's open and attach recency where available, then modification time.
- Name matching reuses the existing semantics in the agent's `search.rank.rs`, which match `WorkspaceEntriesSearch.ts`. A shared JSON fixture file checks that both implementations stay equivalent.
- No new fuzzy-matcher crate. `nucleo` (MPL-2.0) is not needed.

### 2. Rust engine (`bigbud-remote-agent/src/search/`)

The new capability folder has a lean `mod.rs`. Each file stays at or under 400 lines.

- `search/request.rs`: validated request (roots, query, mode, limits, deadline, priority, thread budget).
- `search/walk.rs`: `ignore::WalkBuilder` setup.
  - Respects `.gitignore`, `.ignore` and the global excludes file.
  - Includes hidden files, matching today's `rg --hidden`.
  - Always skips `.git`, `node_modules`, `target`, `.bigbud`, `.next`, `.turbo`, `.convex`, `dist`, `build`, `out` and `.cache`, through overrides. That is the union of today's agent and server lists.
  - Never follows symlinks or junctions, and skips names that are not valid UTF-8.
- `search/names.rs`: filename scoring through the existing `rank` module, moved under `search/`. Keeps a bounded top-K heap per root.
- `search/content.rs`:
  - `grep-searcher` with literal smart-case matching (`grep-regex` with `fixed_strings`).
  - Binary detection with `quit(0)` (stop at the first NUL byte).
  - Skips files over 5 MiB.
  - At most 5 matches per file; excerpts at most 512 characters.
- `search/run.rs`: owns the worker pool for one operation.
  - Cancel flag (`Arc<AtomicBool>`), deadline, and per-root and global result caps.
  - Bounded `sync_channel` to the emitter. A slow writer blocks the walkers, so memory stays bounded and the deadline still applies.
  - The terminal stop reason is one of `complete`, `limit`, `deadline`, `cancelled` or `error`.
- `search/priority.rs` (split per platform with `cfg`): lowers the priority of each walker thread from inside the `WalkParallel::run` factory.
- `search/registry.rs`: in-flight operations per session.
  - At most 2 concurrent interactive searches. A third request is rejected with `SEARCH_BUSY`.
  - The registry is keyed by `operation_id`, which lets `CancelRequest` work.
  - It is separate from `accepted_operations`. Search is idempotent and is never journalled or replayed. After a reconnect the server simply re-issues the query.
- `os_index/` (local only): `mod.rs`, `spotlight.rs` (macOS, `MDQuery`), and later `windows_search.rs` and `plocate.rs`, plus `exclusions.rs`.
- Existing `workspace/search.rs` and `workspace/search.rank.rs` become thin adapters over `search/` for the legacy frames. This fixes the legacy content search's symlink abort and case sensitivity. Their tests move with them.
- **Thread budgets:**
  - Local interactive: `min(max(2, cores / 2), 6)`.
  - Remote: 2 threads, with lower CPU and I/O priority.
  - Deadlines: 2 s local and 3 s remote, set by the server per request and clamped by the agent to at most 10 s.

### 3. Protocol (new `protocol/remote-agent/search.proto`; `PROTOCOL_MINOR` stays 8)

Field names below are illustrative; final names are chosen in Phase 2. New `Frame` oneof numbers: `WorkspaceSearchRequest` 74, `WorkspaceSearchBatch` 75, `WorkspaceSearchCompleted` 76, `OsIndexSearchRequest` 77, `OsIndexSearchBatch` 78, `OsIndexSearchCompleted` 79. Gating is capability-only, following paste staging and create-only.

- `WorkspaceSearchRequest`: `request_id`, `operation_id`, `repeated SearchRoot roots` (`root_id` as an opaque server label, absolute `root`, optional `relative_path`), `query`, `mode` (`NAMES` / `CONTENT` / `BOTH`), `max_results`, `max_results_per_root`, `deadline_ms`, `max_threads`, `priority`.
  - Each root is validated like `WorkspaceOpenRequest`: absolute, canonical, a directory, no NUL bytes. At most 128 roots per request.
  - The agent opens transient roots for the operation, so the 64-handle limit does not apply and no close message is needed.
- `WorkspaceSearchBatch`: `request_id`, `operation_id`, `sequence`, `repeated SearchNameHit` (`root_id`, `path`, `is_directory`, `size_bytes`, `modified_unix_ms`, `score`), `repeated SearchContentHit` (`root_id`, `path`, `line`, `column`, `excerpt`).
- `WorkspaceSearchCompleted`: `request_id`, `operation_id`, `stop_reason`, `truncated`, `files_scanned`, `per_root_errors` (root ID and code, for example `ROOT_MISSING`, `PERMISSION_DENIED`), `error_code`, `error_message`.
- `OsIndexSearchRequest`, `OsIndexSearchBatch` and `OsIndexSearchCompleted`: the same shape, with `source` (`spotlight` / `windows-search` / `plocate`), `availability` (`ready` / `disabled` / `indexing` / `unavailable`), and hits carrying the absolute `path`, `kind`, `size_bytes`, `modified_unix_ms` and `last_used_unix_ms`.
- Cancellation reuses `CancelRequest` and `CancelResponse`. `handle_cancel_request` checks the search registry before the process table.
- Capabilities:
  - `workspace.search-stream` 1.0: advertised by all new agents.
  - `os-index.search` 1.0: advertised **only** when the session has OS-index enabled, which only `--ephemeral --os-index` does. The server passes `--os-index` only as the desktop-embedded backend (never in the remote-backend profile, whose local agent runs on the VPS). The request handler refuses OS-index requests in any other mode as well, so remote agents can never search outside project roots (defence in depth for decision 4).
- **Frame-loop change.** In stdio (`main.rs`) and supervisor (`supervisor/core.rs`) modes, search requests are _prepared_ under the session lock: validate the request and register a cancel flag. They are then _executed_ on a worker thread that writes through the shared writer, following the `prepare_pty_control` and `prepare_pty_create` patterns. The reader loop stays free for `CancelRequest`. The supervisor branch lives in `supervisor/search.rs` (core.rs is at 387 lines).
- `bigbud-protocol/build.rs` rerun inputs, `frame/search.tests.rs`, the TypeScript files `remoteAgentProtocol.search.ts` and `remoteAgentProtocol.codec.search.ts` (split encode/decode only if it passes 400 lines), and `v1.golden.frames` are all updated together.

### 4. Server fan-out, ranking and merge (`apps/server/src/search/`)

- `Services/SystemSearch.ts` and `Layers/SystemSearchLive.ts` expose one streaming RPC, `search.query`, defined in `packages/contracts/src/server/rpc.search.ts` with schemas in `packages/contracts/src/search/*.ts`.
  - Input: `queryId`, `query`, current thread, project and file context, and the enabled tiers.
  - The stream emits `SearchTierUpdate` events (`queryId`, `tier`, `sourceId`, `items`, `state`: `searching` / `partial` / `done` / `unavailable`, `reason`, `truncated`).
- Source modules:
  - `SystemSearch.workspaceFiles.ts`: T2, T4 and T6. Builds root lists from the project catalog (local and remote), groups them by execution target, and sends one agent request per target.
    - Local requests go to `LocalWorkspaceWatchAgent.getConnection()`. Remote requests go to the existing connection pool, gated by `useRemoteExecutionAccessGate` semantics on the client and connection state on the server.
    - The current project is requested first and separately, with a higher per-root cap.
    - Remotes that are not connected yield `unavailable: not-connected`. The server never dials just to search.
    - Remote search is skipped when the setting is off.
  - `SystemSearch.osIndex.ts`: T5. Runs only when all of the following hold:
    1. the server runs as the desktop-embedded backend (the remote-backend profile supplies an unavailable layer, like `RemoteOpenLive`);
    2. the server setting `search.thisComputer` is on;
    3. the caller is the main WebSocket surface (not mobile, not thread tools, not MCP).
  - Message, thread and terminal sources stay on their existing RPCs in Phase 1. The client assembles tiers from those results and the `search.query` stream. Moving them into the stream later is optional.
- **Cancellation.** The client unsubscribes, which interrupts the Effect fiber. A finaliser sends `CancelRequest` for each in-flight agent operation, and late batches for an interrupted `queryId` are dropped.
- **Per-query caps.**
  - Rows sent to the client: 200 in total.
  - T4: 20 rows per project.
  - T5: 50 rows. The agent requests 200 from Spotlight and filters them down to 50 after applying the exclusions.
- **Old remote agents.** Without `workspace.search-stream` (checked with `connection.supportsCapability(REMOTE_AGENT_SEARCH_STREAM_CAPABILITY)`, as paste staging does), the server uses the legacy `FilenameSearchRequest` (names only), marks the source `partial` with reason `agent-update-available`, and skips content search on that target.
- **Direct-SSH remotes (no managed agent).** Behaviour depends on Q5. The recommendation keeps `rg` on the host for those remotes as a legacy path until they move to a managed agent.
- **Logging.** Only counts, durations, stop reasons and target kinds are logged. Never queries, paths or excerpts. This follows `crates/AGENTS.md` and avoids putting personal data in logs.

### 5. Web palette (`apps/web/src/components/layout/`)

`SearchPalette.content.tsx` is already 390 lines, so tier logic moves out before any feature is added:

- `SearchPalette.tiers.logic.ts`: tier ordering, stable IDs, in-tier ranking, and merging streamed updates without reordering.
- `SearchPalette.stream.ts`: a hook around the `search.query` subscription with a `queryId` generation guard.
- `SearchPalette.tierSections.tsx`: renders section headings, "Searching…", "Unavailable: Spotlight is turned off", "Remote not connected" and "Agent update available" states.
- `SearchPalette.open.logic.ts`: the open routing in §7.

Behaviour:

- Local client-side sources (titles, projects) update with no debounce. Server and agent sources keep the 200 ms debounce.
- Each tier shows 5 rows, with "Show more".
- Keyboard focus stays on the selected row while new rows arrive below it.
- Screen readers get a polite live-region summary per tier.
- Status colours follow the UI conventions: blue for working, amber for partial or unavailable, red only for real failures.

### 6. Settings

New `ServerSettings.search` fields, enforced on the server:

- `thisComputer: boolean`. Default per Q1; the recommendation is `false`.
- `connectedRemoteBackends: boolean`. Default `true`; it only ever covers project folders.

The UI is a new "Search" section on Settings › AI directly after "File Access" (both rows are added to `SETTINGS_SEARCH_ITEMS`), with these rows:

- "Search this computer". The description names the OS index used ("Uses Spotlight on this Mac"). When the File Access level is `none`, the row is disabled with a link to File Access.
- "Search connected remote backends".
- An "Index status" line, for example "Spotlight indexing is on" or "Windows Search service is disabled".

The File Access level limits the Spotlight scope:

- `common-folders` → Desktop, Documents, Downloads, Music and Pictures.
- `unrestricted` → the non-`Library` children of home, plus iCloud Drive (`~/Library/Mobile Documents`) and `~/Library/CloudStorage`.

Assumed (Q2): `fileAccessPermissionLevel` is mirrored into `ServerSettings` once on upgrade and the server enforces it; the client value only drives the UI.

Full Disk Access stays where it is, behind the existing "Open System Settings" link in File Access.

### 7. Opening results

| Result                                       | Supported type (current lists)                         | Unsupported type                                                         |
| -------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------ |
| Project file (local or remote)               | Existing Files or Browser panel routing                | Local: desktop `openPath`. Remote: download to cache, then `openPath`.   |
| This computer (local)                        | Read-only "loose file" preview (below)                 | Desktop `openPath`                                                       |
| Any local result, secondary action           | "Reveal in Finder/Explorer" through `showItemInFolder` | Same                                                                     |
| Web client not on the host (browser, mobile) | Preview only                                           | Hidden. Opening an app on the host machine would surprise a remote user. |

- **Unsupported types.** `workspaceFilePreview.ts` gains `isKnownBinaryFilePath()`, an explicit list of binary extensions plus a server-side NUL sniff that already happens in preview loads. Those files go to system open instead of the text preview, which removes today's "binary as text" behaviour.
- **Desktop IPC** (new file `apps/desktop/src/window/shellPathHandlers.ts`, registered beside `OPEN_EXTERNAL_CHANNEL`, main-window role only):
  - `OPEN_PATH_CHANNEL` and `SHOW_ITEM_IN_FOLDER_CHANNEL`.
  - Validation: a string; absolute (`isAbsolutePath` from `@bigbud/shared/path`); no NUL bytes; normalised; `lstat` shows an existing regular file or directory (symlinks resolved with `realpath`, then checked again); not on the exclusion list.
  - Executables and launchable bundles (`.app`, `.command`, `.tool`, `.pkg`, `.dmg`, `.exe`, `.bat`, `.cmd`, `.ps1`, `.msi`, `.lnk`, `.desktop`, `.sh` and other files with an executable bit) are **revealed, never launched**. There is no confirm-to-launch override (user decision).
  - Uses `shell.openPath` (which returns an error string) and `shell.showItemInFolder`.
  - The preload exposes `desktopBridge.openPath` and `desktopBridge.showItemInFolder`. `NativeApi.shell.openPath` prefers the bridge, then falls back to the server RPC.
  - The server's `Open.openPath` gets the same validation, extracted to `apps/server/src/utils/openPath.validate.ts`. The shared exclusion data lives in one JSON file (below).
- **Loose-file preview.** A preview target `{ kind: "loose", absolutePath }`:
  - The server resolves it to the parent folder as `cwd` plus the basename.
  - It applies the exclusion list and the 5 MiB text cap.
  - It is read-only: no edit, no annotations, no "add to chat" unless the user drags it in explicitly.
  - It does not register a project or workspace, and it grants no agent access.
- **Remote download cache.**
  - Location: `<userData>/remote-open-cache/<targetId>/<sha256(path)>/<basename>`, directories mode 0700 (the pattern from commit 198ee98632).
  - Files are streamed through the agent's `ReadFileRequest` in chunks, and the size is checked before download (Q8 sets the caps).
  - The UI shows "This is a copy; edits won't sync". Sizes in the confirm dialog use `formatBytes` from `@bigbud/shared/bytes`.
  - Eviction after 7 days or when the cache passes 1 GiB, oldest first.
  - Cache files are never attached to chats automatically.

### 8. Safety and privacy

- **Default exclusions** (one data file, `packages/shared/src/search/osIndexExclusions.json`, read by TypeScript and embedded in Rust with `include_str!`).
  - They apply to T5 results, loose-file previews, and system-open of non-project paths.
  - Path components: `.ssh`, `.gnupg`, `.aws`, `.azure`, `.kube`, `.docker`, `.config/gcloud`, `.password-store`, `Library/Keychains`, `Library/Mail`, `Library/Messages`, `Library/Cookies`, `Library/Safari`, browser profile folders (Chrome, Chromium, Brave, Edge, Arc, Vivaldi, Firefox, Thunderbird), the 1Password, Bitwarden and KeePassXC data folders, `AppData/Roaming/Microsoft/Credentials`, `AppData/Local/Microsoft/Vault`, and bigbud's own state and data folders.
  - File names and globs: `.env*`, `*.pem`, `*.key`, `id_*` (private keys), `*.p12`, `*.pfx`, `*.kdbx`, `*.keychain*`, `credentials*`, `secrets*`, `.netrc`, `.npmrc`, `.pypirc`, `.git-credentials`, `Cookies`, `Login Data`, `Web Data`, `logins.json`, `key3.db`, `key4.db`.
  - Excluded results are dropped in the agent before they cross the protocol.
  - Project tiers keep today's behaviour: `.env` files in projects are shown.
- **Never sent to AI providers.**
  - The `search.query` RPC and its results are UI-only.
  - They are not reachable from thread tools (`ws/http.threadTools*`), MCP bridges, provider adapters or automations.
  - A result reaches a model only when the user explicitly attaches it or opens it into a chat. A server test asserts that no provider-facing tool registry contains a search tool.
- **Agents never use "this computer".**
  - The capability is only advertised to the local desktop server, and the request handler refuses it in any other agent mode.
  - On the server, the OS-index source only runs for the main desktop WS surface.
- **Untrusted data.** File names and excerpts are rendered as text (never HTML), truncated, and bidirectional-override characters are made visible.
- **No persistence.** Queries and results are not stored (no index, no history) beyond in-memory React Query caches, which are cleared when the palette closes. bigbud's own open history (for recency) only covers files the user opened.
- **Spotlight specifics.** Results are treated as sensitive (Sploitlight). bigbud never asks for Full Disk Access because of search; File Access remains the only place that explains it.
- **Remote.** Searches run as the agent's user, inside registered roots only, with no `sudo` and with lowered priority. Remote "this computer" does not exist.
- **Managed devices.** A policy key (`BIGBUD_SEARCH_THIS_COMPUTER=0`, read by the server) forces T5 off. This is documented for administrators.

### 9. Performance budgets and measurement

| Budget (warm cache)                                    | Target                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| Client-side tiers (titles, projects) after a keystroke | ≤ 16 ms render, no debounce                                                                                                         |
| Message search (T1 + T3) at 200k messages              | p95 ≤ 20 ms server time                                                                                                             |
| Current project names (≤ 50k files)                    | first row p50 ≤ 100 ms, p95 ≤ 300 ms                                                                                                |
| Current project contents                               | first hit p50 ≤ 150 ms; complete or partial by the 2 s deadline                                                                     |
| All local projects (T4)                                | partial results by 2 s; never runs past the deadline                                                                                |
| Spotlight (T5)                                         | first batch p50 ≤ 150 ms; done ≤ 700 ms                                                                                             |
| Remote (per target)                                    | 3 s deadline; ≤ 256 KiB over SSH per query; no measurable effect on active turns (CPU share capped by 2 threads and lower priority) |
| Cancel → agent work stopped                            | ≤ 50 ms (measured about 4 ms in the probe)                                                                                          |
| Agent binary growth                                    | ≤ 2.5 MB stripped per target                                                                                                        |
| Agent RSS during a search                              | ≤ +64 MiB                                                                                                                           |

How these are measured:

- Rust: an `#[ignore]` benchmark integration test (`crates/bigbud-remote-agent/tests/search_bench.rs`) over generated trees (10k, 50k and 200k files) and this repository. It prints first-hit, completion and cancel latency, and it is run manually. No new benchmarking dependency.
- Server: Effect spans on each source carry `search.tier`, `search.durationMs`, `search.stopReason` and `search.resultCount`.
- Web: `performance.mark` for keystroke → first row per tier, checked in a browser test with fake sources.
- Remote: the existing remote measurement procedure (`docs/reports/2026-11-18-remote-backend-measurements.md`), run on the 2 vCPU VPS while a turn is active.
- Binary size: the stripped release size of each target is compared before and after in the release-asset verification.

### 10. Compatibility and migration

- Local: lockstep through `--check`, so there are no compatibility branches.
- Remote agents without `workspace.search-stream`: names only, through the legacy frame, with the "update available" state. The existing managed upgrade flow delivers new agents. The plan never bypasses signature checks or forces an upgrade (see the 2026-10-28 plan).
- New agents with old servers: the legacy frames keep working, now backed by the engine.
- Removing `rg`: after Phase 2 the local path never spawns `rg`. `WorkspaceFileSystem.search.ts` parsing and the Node fallback are deleted once local search goes through the agent. Q5 decides direct SSH.
- Settings: the new `ServerSettings.search` fields decode with defaults, so no migration is needed.

### 11. Conventions

- Every new or materially edited source or test file stays at or under 400 lines. Files are split with dot-notation (`SystemSearch.workspaceFiles.ts`, `SearchPalette.tiers.logic.ts`) and Rust capability folders. `SearchPalette.content.tsx` (390 lines) and `WorkspaceFileSystem.test.ts` (389 lines) must be split before they are edited.
- Contracts use subpath imports only (`@bigbud/contracts/search/...`). No barrel additions, and no Effect barrel imports.
- `Effect.fn("name")` is used for named server functions. Layers are named `SystemSearchLive`.
- Rust: typed errors, no `unwrap`, a `// SAFETY:` comment for each `unsafe` block in the MDQuery binding, `cfg`-gated platform modules, and a regression test for each bug fixed (symlink abort, case sensitivity, session-lock blocking).
- New crates need engineering-team approval before they are added (`crates/AGENTS.md`). See Q9.

## Phases

Each phase can ship on its own and leaves the palette working.

### Phase 0: Baselines and verification (no user-visible change)

- **Measure:** palette per-tier latency today; the message query plan and timing on a real (copied, local) database through the server's SQLite build; agent search on this repository and on 50k and 200k-file generated trees, locally and on the 2 vCPU VPS.
- **Verify Spotlight from the packaged bigbud app.** Run it with Full Disk Access off and on, and record whether results inside Desktop, Documents, Downloads and iCloud Drive appear. Confirm that a local agent started by the server inherits the app's TCC attribution.
- **Spikes:** Windows `SystemIndex` through the `windows` crate (one query, timing, behaviour when the service is disabled), and `plocate` on Ubuntu 24.04.
- **Exit:** a findings addendum in this plan, with the budgets in §9 confirmed or adjusted.

### Phase 1: Ranking and tiers in the palette (server message query + web)

- **Server:**
  - Change the message search to `ORDER BY search.rowid DESC`.
  - Add the current-thread query (`thread_id` index + `instr`, any length up to 160) and a current-project-scoped page.
  - Rerank the global page within the recent 200-candidate window: tier, then `bm25`, then recency.
  - Keep the cursor contract. The global keyset stays rowid-based, and reranking only reorders inside a page.
- **Web:**
  - Split `SearchPalette.content.tsx`.
  - Add `SearchPalette.tiers.logic.ts` and tier sections in the fixed order.
  - Stable IDs and append-only updates.
  - Short-query rules.
  - Debounced remote sources; immediate client-side sources.
- **Exit:**
  - Tier order is correct for the current thread and the current project.
  - Existing saved-message browser tests still pass.
  - Message p95 meets the budget on the benchmark corpus.

### Phase 2: Rust engine and streaming protocol (agent + server, current project only)

- **Dependencies:** approved (Q9).
- **Agent:** add the `search/` capability, the legacy-frame adapters, and the worker execution with the search registry and `CancelRequest` support in stdio and supervisor modes. Add the protocol messages (frames 74–76), the `workspace.search-stream` capability (no minor bump), the TypeScript codec and golden frames.
- **Server:**
  - Promote the agent owned by `localWorkspaceWatchLayer.ts` to a shared `LocalWorkspaceAgent` service used by watch and search.
  - Local content search goes to the local agent.
  - Remote managed agents use streaming when `workspace.search-stream` is present, otherwise the legacy frames.
  - Remove the local `rg` spawn and the Node fallback.
- **Exit:**
  - Local and remote current-project search return the same results for the same tree (shared fixtures).
  - No `rg` process is ever spawned locally (asserted in a test).
  - Cancel latency is ≤ 50 ms.
  - A search in progress no longer blocks other supervisor connections (regression test).

### Phase 3: Workspace-wide search (T2, T4, T6)

- Add the `search.query` streaming RPC and `SystemSearch` with the workspace-files source.
- Group roots per target and send one agent request each, with deadlines, caps and per-root errors.
- Add the remote setting toggle and the not-connected and update-available states.
- Web: the stream hook and tier sections.
- **Exit:**
  - With 30 local projects and 2 remotes, T2 arrives first and T4 and T6 stream without reordering.
  - Disconnecting a remote shows "not connected" without delaying the other tiers.
  - Typing quickly leaves no orphaned agent operations (registry empty within 100 ms of the last cancel).

### Phase 4: Opening results

- Add the binary-type routing, desktop `openPath` and `showItemInFolder` IPC with validation, the server `openPath` validation, and the loose-file read-only preview.
- Add the remote download cache with size caps and eviction.
- **Exit:** every row in the §7 matrix has a test.
  - Executables are revealed, not launched.
  - Excluded paths are refused in both the desktop and the server.
  - A remote `.docx` opens in the default app from a mode-0700 cache.

### Phase 5: "This computer" on macOS

- Add the `os_index/spotlight.rs` asynchronous `MDQuery` worker (run-loop thread, cancel timer, multi-scope, maximum 200, attribute fetch) and the exclusions.
- Add the `os-index.search` capability (local only, `--ephemeral --os-index`), the server `SystemSearch.osIndex.ts` (desktop-only layer and remote-backend unavailable layer), and the settings section with File Access scope mapping.
- Add the unavailable states: indexing off (`mdutil` status queried through `MDQuery` failure or `kMDQueryDidFinish` with an error), turned off in settings, File Access set to `none`.
- **Exit:**
  - Name queries meet the T5 budget.
  - Excluded paths never reach the server (Rust test with a fake index).
  - The tier is absent in remote-backend and mobile surfaces.
  - The packaged-app check passes with Full Disk Access on and off.

### Phase 6: Windows Search adapter

Depends on the Phase 0 spike: OLE DB `SystemIndex` with `SELECT TOP 200`, scoped to the user profile; "unavailable" when WSearch is not running.

**Exit:** a Windows CI or manual run meets the T5 budget, and the disabled service shows "unavailable".

### Phase 7: Linux `plocate` adapter

Run `plocate` (then `locate`) as a subprocess, bounded by `-l`, with a timeout and kill on cancel. The UI shows "results may be up to a day old".

**Exit:** an Ubuntu manual run passes, and a missing `plocate` shows "unavailable".

### Phase 8: Mod+P file-name search across all sources

User decision (20 November 2026): Mod+F stays the general search; Mod+P is "find a file by name",
like VS Code's quick open, extended beyond the current project to the whole computer and connected
VMs/VPSes, regardless of platform.

- Tiers, in order: (1) current project, (2) other projects (local and remote), (3) this computer
  through the OS index (Spotlight, Windows Search, `plocate`; Phases 5–7), (4) connected remote
  backends (project folders and registered remote workspace folders, as the agent user).
- Matching: fuzzy for project and remote files (VS Code style, reusing the engine's names mode and
  `search/rank.rs`; the existing `WorkspaceEntries` scoring is replaced or aligned through shared
  fixtures so local and remote rank identically); name-contains for the OS index tier.
- The same settings, defaults and enforcement as Mod+F: "Search this computer" and "Search
  connected remote backends" (both off by default), File Access level → scope, sensitive-path
  exclusions enforced in the agent, OS-index tier shows "unavailable" (disabled indexer, missing
  `plocate`) instead of failing.
- The legacy remote `FilenameSearchRequest` walker moves to the engine's names mode behind
  `workspace.search-stream`; older agents keep the legacy request with an update notice.
- Opening uses the Phase 4 routing (in-app viewer, otherwise system default, Reveal; executables
  revealed only).
- Exit: Mod+P returns current-project hits first with no added latency (local in-memory list stays
  the first source), streams the other tiers, cancels superseded queries, and passes the shared
  fuzzy-ranking fixtures locally and remotely.

## Risks And Decision Gates

- **Dependency approval (gate for Phase 2).** About 2.2 MB of binary growth, `encoding_rs` with its BSD-3-Clause part, and `unsafe` code in transitive crates (`memmap2`, `bstr`, `crossbeam`). Mitigation: keep `grep-searcher` mmap off (use read-based search), list the licences, measure the size per target.
- **TCC attribution (gate for Phase 5).** If the agent started by the server is not attributed to bigbud.app, Spotlight results or file opens could differ from what the user expects. Phase 0 must verify this. The fallback is to run Spotlight queries from the Electron main process, through a small native module. That is rejected for now because of its cost.
- **Session concurrency regressions.** Moving search off the frame thread touches stdio and supervisor loops that carry PTY and process reliability guarantees. Mitigation: use the existing prepare and execute pattern, add regression tests for the PTY and process suites, and keep shutdown joining search workers (cancel, then join with a bounded wait).
- **Load on remotes during turns.** 2 threads, lower priority, a 3 s deadline, and at most 2 concurrent operations per session. Phase 3 measures this on the VPS during an active turn before release.
- **Result jumping.** Append-only updates and stable IDs. A browser test asserts the selected row stays put.
- **Path-validation bugs in open.** Shared validation module, a fuzz-style unit test (traversal, NUL, symlink swap, Windows prefixes and `\\?\`, UNC paths, junctions), and the reveal-never-launch rule for executables.
- **Existing preview route accepts any `cwd`.** This plan does not widen it, and loose-file previews go through a separate validated kind. Hardening the generic route is noted as follow-up (Q11), not done silently.
- **Spotlight disabled or still indexing.** Explicit "unavailable" or "indexing" rows, never silent empties.
- **Message reranking changes the order users see.** Only within a page, after tiering. Covered by tests and Q6.

## Testing And Validation

- **Rust** (`cargo test --locked -p bigbud-remote-agent`, crate-scoped Clippy, `cargo fmt` on changed files):
  - walker rules: gitignore, overrides, hidden files, symlink and junction skipping, non-UTF-8 names;
  - smart case;
  - binary skip;
  - size cap;
  - per-file and global limits;
  - deadline;
  - cancel latency;
  - registry busy and cancel;
  - legacy-frame adapters (including the symlink and case regressions);
  - root validation;
  - batch size versus the 1 MiB frame cap;
  - sequence monotonicity and exactly one terminal frame;
  - capability gating (`os-index.search` refused in non-local modes);
  - MDQuery query escaping and exclusion filtering through a fake index trait;
  - a macOS-gated live Spotlight smoke test (marked `#[ignore]`).
  - Integration tests in `tests/`: a real agent process over stdio, a search with a cancel in flight, and a PTY or process request served while a search runs.
- **Protocol:** golden frames updated. TypeScript codec round-trip tests (`remoteAgentProtocol.search.test.ts`). A test where an old agent hello lacks the capability, so the server uses the legacy path.
- **Server** (focused Vitest through `bun run --cwd apps/server vitest run <file>`):
  - message query ordering, tiers, the current-thread `instr` path and short queries (against a real SQLite database);
  - `SystemSearch` fan-out with fake agents: ordering, deadlines, per-root errors, not-connected, cancellation finalisers sending `CancelRequest`, late batches dropped;
  - OS-index gating: settings, policy environment variable, remote-backend layer, mobile surface;
  - `openPath` validation;
  - loose-file preview exclusions;
  - an assertion that no provider tool registry exposes search.
- **Web:**
  - Unit tests for tier merge, stable IDs, short-query rules and open routing.
  - Browser tests (`bun run --cwd apps/web test:browser <file>`): streaming append without reordering, keyboard selection stability, unavailable and partial states, the settings rows (including disabled when File Access is `none`), and accessibility labels.
- **Desktop:** IPC handler tests for validation, the executable reveal rule and role authorisation.
- **Manual:** packaged macOS app with Full Disk Access on and off; a remote VPS search during an active turn; old-agent fallback against a deployed agent that lacks `workspace.search-stream`.
- **Checks:** only focused formatting, lint, type and length checks on the changed files and packages. Repository-wide checks need approval first (AGENTS.md).

## Acceptance Criteria

- Mod+F shows results in the fixed tier order T1–T6, streams them without reordering visible rows, and cancels superseded work end to end within the budgets in §9.
- Local and remote project search use only the Rust engine. The server never spawns `rg` for local search.
- Old remote agents keep working (names only, with an update hint). New agents serve old servers.
- "This computer" works on macOS through Spotlight when turned on. It respects the File Access scope and the exclusions, is absent for remote backends, mobile and agents, and never sends results to providers.
- Supported formats open in bigbud. Unsupported ones open in the default app, or are revealed if they are executables. Remote unsupported files open from a private cache with size limits.
- All new and edited files are at or under 400 lines, and focused checks pass.

## Implementation progress

- **Phase 1: complete.** Server: `search.rowid DESC` keyset, in-page rerank (tier → `bm25` → recency), current-thread substring query (1–160 code points, ASCII case folding; longer non-ASCII queries are folded into T1 from the global FTS page), current-project FTS page (first page only). Web: palette split into sources, tier logic and tier sections in fixed T1–T3 order with stable IDs, append-only merges, immediate thread titles, content search from 3 characters.
- **Phase 2: complete (server routing switched).** Agent side: `search/` engine, frames 74–76, `workspace.search-stream`, worker execution with the search registry in stdio and supervisor modes, legacy content search backed by the engine, TypeScript codec (shared table codec extracted from paste staging), golden frames, and `streamRemoteAgentWorkspaceSearch`. Server side:
  - `LocalWorkspaceAgent` service (`workspace-runtime/Services/LocalWorkspaceAgent.ts`, `Layers/LocalWorkspaceAgent.ts` with `LocalWorkspaceAgentLive`) owns the one local agent process. `makeWorkspaceRuntimeLayer` provides it to both the watch layer (`localWorkspaceWatchLayer.ts`) and the new search layer (`localWorkspaceSearchLayer.ts`), so search never starts a second process; a composition test asserts a single agent.
  - Local `projects.searchFileContents` goes through `searchAgentWorkspaceContents` (`remote-agent/agentWorkspaceContentSearch.ts`): content mode, interactive priority, 2 s deadline, `limit + 1` hits requested so truncation keeps its old meaning. A transport loss is retried once on the restarted agent; `SEARCH_BUSY` is retried with backoff within the deadline (the web palette does not cancel superseded queries yet). If the agent is unavailable or lacks `workspace.search-stream`, the search fails with that reason; there is no fallback.
  - The local `rg` spawn and the Node fallback are deleted. `WorkspaceFileSystem.searchFileContents` now rejects local targets and keeps `rg` only for direct-SSH hosts (Q5), with the `use-managed-agent` notice.
  - Managed remote agents use the streaming engine (background priority, 3 s deadline, cancel on interrupt) when they advertise `workspace.search-stream`; older agents use the legacy `ContentSearchRequest` with the `agent-update-available` notice (`WorkspaceRuntime.remote.search.ts`).
  - `ProjectSearchFileContentsResult` gained an optional `notice` (`agent-update-available` / `use-managed-agent`). Showing it in the palette belongs to the Phase 3 update-available and not-connected states.
  - Tests: routing (agent vs legacy vs `rg`), shared agent, busy/deadline/error mapping, cancel on interrupt, a real-agent search with the old result shape, a `PATH` shim proving no local `rg` is spawned, and `tests/search_supervisor.rs` (a running search blocks neither another supervisor connection nor a write on its own connection; mutation-checked against searching under the session lock and on the frame thread).
- Behaviour changes from the engine, as designed in §2: at most 5 matches per file, excerpts capped at 512 characters, and a 2 s local deadline that returns partial results marked truncated (the old `rg` path waited up to 10 s).
- Phase 2 exit criteria still open: the shared local/remote fixture comparison and the ≤ 50 ms cancel-latency measurement need a live remote and are listed under Pending live verification.
- Deviation: the legacy `FilenameSearchRequest` keeps its own walker, because it backs Mod+P on remote targets and Mod+P is a non-goal. The new engine's names mode reuses the same `rank` module (moved to `search/rank.rs`).
- **Phase 3: complete (uncommitted).** `search.query` (`packages/contracts/src/server/rpc.search.ts`, schemas in `packages/contracts/src/search/systemSearch.ts`) is a finite stream of `SystemSearchTierUpdate` rows per tier and source; it is registered on the main WebSocket surface only (`ws/wsRpcHandlers.search.ts`), never on the mobile gateway, thread tools or MCP.
  - Server (`apps/server/src/search/`): `SystemSearch` service and `SystemSearchLive`; `SystemSearch.rootsQuery.ts` reads live project folders (most recently updated first) and thread worktrees from SQLite; `SystemSearch.roots.ts` plans T2 (the current thread's worktree, else the current project), T4 (every other project, local first, duplicates once) and T6 (remote worktree folders that are neither a project folder nor inside one; never host-wide). `SystemSearch.workspaceFiles.ts` sends T2 alone first (80 rows) and one request per target for T4/T6 (20 rows per project; local 2 s interactive, remote 3 s background), with `SEARCH_BUSY` backoff shared with content search (`retryWhileAgentSearchBusy`). `SystemSearch.emitter.ts` deduplicates rows by stable ID, caps a query at 200 rows and drops everything after abort.
  - Remotes are used only when already connected (`RemoteAgentConnectionPool.liveConnection`, `SearchAgentConnections`); otherwise `not-connected` at once. Old agents get names only through the legacy `FilenameSearchRequest` (first 8 folders, stable handles) with `agent-update-available`; SSH-only hosts get `use-managed-agent` (T2 keeps `rg` on the host for contents, Q5). Unsubscribing interrupts the fiber; the finaliser aborts every agent request, which sends `CancelRequest`.
  - Settings: `ServerSettings.search` (`core/settings.search.ts`): `thisComputer` (off), `connectedRemoteBackends` (on, per §6), `fileAccessLevel` mirror (`none`), `hasSeenThisComputerHint`. Settings › AI has a new "Search" section after File Access, and both rows are in `SETTINGS_SEARCH_ITEMS`.
  - Web: `SearchPalette.stream.ts` + `SearchPalette.systemSearch.logic.ts` (one query at a time; a new query, closing or unmounting aborts the previous one; the transport's `requestStream` accepts an `AbortSignal`), fixed tier order T1–T6 with append-only rows and sources in fixed order (local first), `SearchPalette.systemSections.tsx` for T4–T6 and notices (`SearchPalette.notices.logic.ts`: amber for partial/unavailable, red only for failures). The palette's old `projects.searchFileContents` request is replaced by the stream (T2 now shows names and contents). File names and excerpts render as text with bidi controls made visible (`revealBidiControls` in `@bigbud/shared/String`).
- **Phase 4 palette wiring: complete except the remote download cache.** `SearchPalette.open.logic.ts` / `SearchPalette.open.tsx`: types bigbud can show keep the existing `openPathFromChat` routing (with line and column); unsupported local types go to `openWithSystemDefault` (desktop bridge; executables and bundles are revealed, never launched); local rows get a "Reveal" action (`revealInFileManager`) only in the desktop app; browsers get `unavailable-in-browser` notices. Q7: "this computer" rows never load into bigbud panels (no editing, no agent-visible browser panel); they always go through the desktop shell. Q8 remote download-to-cache is not built: remote unsupported types show "cannot open yet".
- **Phase 5 wiring: complete (uncommitted).** Frames 77–79 (`OsIndexSearchRequest` with a scope level the agent resolves under its own home, `OsIndexSearchBatch`, `OsIndexSearchCompleted`) in `search.proto`, Rust and TypeScript golden frames, TS codec tables. `os-index.search` is advertised only after `enable_os_index()`, which only `--ephemeral --os-index` calls; the generic frame handler (supervisor and every other mode) refuses with `UNSUPPORTED`. OS-index searches have their own two-slot registry and worker set, and `CancelRequest` reaches them. The server starts the local agent with `--os-index` only when `mode === "desktop"` and `BIGBUD_SEARCH_THIS_COMPUTER` is not `0`; `SystemSearch.osIndex.ts` enforces mode, policy, `search.thisComputer` and the File Access mirror (`none` → off, `common-folders`/`unrestricted` → agent scope level), re-checks exclusions, and shows rows as `~/…` folders. `exclusions.json` moved to `packages/shared/src/search/osIndexExclusions.json` (`include_str!` updated); `@bigbud/shared/search/osIndexExclusions` mirrors the matcher and `inspectSystemOpenPath` now refuses excluded paths (requested or real path) as `inaccessible`. `search::MAX_SEARCH_QUERY_CHARS` is exported and reused. File Access writes the server mirror (settings section and permission dialog) and a one-time startup step copies an earlier client choice. The palette shows a one-time "Search files across this Mac" hint.
- Deviations: (1) exclusions in `inspectSystemOpenPath` reuse the `inaccessible` refusal instead of a new `excluded` reason, because the committed server open-path code maps every refusal exhaustively; a distinct reason is a small follow-up. (2) The read-only loose-file preview (`{ kind: "loose" }`) is not built; Q7 is met by never opening "this computer" files in bigbud. (3) No "Index status" line in Settings: Spotlight off and still-indexing cannot be told apart yet; `UNAVAILABLE` shows "index unavailable" in the palette. (4) T6 uses registered thread worktrees on remotes, the only remote folders bigbud records that are not projects.
- Phase 8 reuse: `search.query` takes explicit tiers and its rows carry `kind` (`name`/`content`), so Mod+P can request names-only tiers (a `mode` field can be added without breaking clients); the engine's names mode, the roots planner, the emitter and the `search` settings toggles are shared.
- **Phase 5: Spotlight core complete in `bigbud-remote-agent/src/os_index/`; not wired.** Capability, frames 77–79, `--os-index`, session handlers, server and web wait for Phase 2 routing. API for the wiring step:
  - `resolve_scopes(home: &Path, level: OsIndexScopeLevel) -> Result<Vec<PathBuf>, OsIndexError>`. `CommonFolders`: Desktop, Documents, Downloads, Music, Pictures. `Unrestricted`: visible (non-dot) real home folders except `Library`, plus `Library/Mobile Documents` and `Library/CloudStorage`. Symlinks, missing folders and excluded folders are skipped.
  - `OsIndexRequest::new(query: &str, scopes: Vec<PathBuf>, max_results: usize, deadline: Duration) -> Result<OsIndexRequest, OsIndexError>`. Query 1–512 characters after trimming, no control characters. Scopes: 1–64 existing canonical absolute UTF-8 folders, none excluded. `max_results` 0 means 50, capped at 200. Deadline capped at `MAX_SEARCH_DEADLINE` (10 s).
  - `search_names(request: &OsIndexRequest, cancel: &AtomicBool) -> Result<OsIndexOutcome, OsIndexError>`. Blocks a dedicated worker thread. It pumps that thread's run loop in 10 ms slices and checks cancel and the deadline between slices. It always asks Spotlight for 200 rows (`OS_INDEX_FETCH_LIMIT`), then filters them. `OS_INDEX_SOURCE` is `Some("spotlight")` on macOS and `None` elsewhere. Other platforms return `OsIndexError::Unsupported` and link no Objective-C crates.
  - `OsIndexOutcome { hits: Vec<OsIndexHit>, stop: StopReason, truncated, excluded: u64, out_of_scope: u64 }`. `StopReason` is reused from `search`. `OsIndexHit { path (absolute), is_directory, content_type (UTI or empty), size_bytes, modified_unix_ms, last_used_unix_ms, score }`; 0 means unknown. Rows are ordered by `search::rank` score (scope folder name plus path below it), then last used, then modified, then path.
  - `OsIndexError::code()`: `EMPTY_SEARCH_QUERY`, `TOO_MANY_ROOTS`, `INVALID_ARGUMENT`, `UNSUPPORTED` or `UNAVAILABLE`. Messages never contain the query or paths.
  - Predicate: `kMDItemFSName == "*<literal>*"cd`, with `\`, `"`, `*` and `?` backslash-escaped. Exclusions (§8 list) live in `os_index/exclusions.json`, embedded with `include_str!`. Folder patterns apply to the whole path. Name patterns apply to every component below the scope, so a matching folder hides its subtree. Matching is ASCII case-insensitive, and a damaged list fails closed.
  - Wiring follow-ups: move `exclusions.json` to `packages/shared/src/search/osIndexExclusions.json` and change the `include_str!` path. Export `search::MAX_SEARCH_QUERY_CHARS` and reuse it instead of `MAX_OS_INDEX_QUERY_CHARS`. "Disabled" and "indexing" availability cannot be told apart from an empty result yet; only `UNAVAILABLE` (the query did not start) is detected. Rows are returned once at the end (at most 200, well under the frame cap), not streamed.
- **Phase 8: complete (uncommitted).** Mod+P is "find a file by name" across every source, in fixed order: (1) current project, (2) other projects (local, then remote), (3) this computer (OS index), (4) remote folders outside projects.
  - Web: `CommandPalette.fileSearch.tsx` composes the tiers. A local current project still answers from its in-memory list (`CommandPalette.workspaceFiles.tsx`, `projects.searchEntries`), rendered without waiting for anything else; a remote current project goes through `search.query` (`currentProject` tier) so it never dials. Every other tier is one `search.query` in the new `fileNames` mode (`useSystemSearchStream`, now with `mode`, `currentProject` and `loadMore`), debounced 150 ms, rendered with the shared `SearchPaletteSystemSections` (Mod+P headings), notices and the one-time hint. All rows open through the Phase 4 routing (`openSearchResult`: in-app viewer, else system default; executables revealed only) with the "Reveal" action. Pagination by scroll: `useScrollIntoViewLoad` (`SearchPalette.scrollLoad.ts`) on every palette "See more" row, both palettes.
  - Contracts: `SystemSearchQueryInput.mode` (`all` | `fileNames`) and `page` (≤ `SYSTEM_SEARCH_MAX_PAGE` = 4), `SystemSearchOsIndexSource`, `ProjectSearchEntriesResult.notice` (`agent-update-available`), and `search.thisComputer` defaulting to `true`.
  - Server: `fileNames` asks the engine for names only at every length, and the emitter drops folders before they count against the row cap; `page` scales every source's limits and the row cap. SSH-only hosts are reported (`use-managed-agent`), never searched. Remote `projects.searchEntries` (composer path suggestions) uses the engine's names mode (`agentWorkspaceNameSearch.ts`, `WorkspaceRuntime.remote.searchEntries.ts`) when the agent has `workspace.search-stream`, otherwise the legacy `FilenameSearchRequest` walker with `agent-update-available`; `search.query` already did the same for remote tiers.
  - Ranking parity: the fuzzy ranker moved to `@bigbud/shared/search/nameRank` (used by `WorkspaceEntries`); ties now break in code point order (Rust's byte order) instead of `localeCompare`, and the Rust `normalize_query` trims exactly what JavaScript's `trim` does. `packages/shared/src/search/nameRank.fixtures.json` is run by `nameRank.test.ts` and `search/rank.tests.rs` (`include_str!`); both pass and both were mutation-checked.
  - OS index wiring for Phases 6–7: `session/os_index_search.rs` takes home from `os_index::home_folder()` (`USERPROFILE` on Windows); the server's T5 `sourceId` is the platform's index (`spotlight`, `windows-search`, `locate`) and the agent's reported `source` wins; Settings, the hint and notices use per-source wording ("this Mac"/"this PC"/"this computer"; Spotlight/Windows Search/locate) via `apps/web/src/lib/osIndexWording.ts`, with the Linux "may be up to a day old" note under T5 rows and in Settings; `--os-index` is passed for the desktop backend on macOS, Windows and Linux alike (test).
  - Tests: shared fixtures (TS + Rust); `SystemSearch.neverDials.test.ts` (Mod+F and Mod+P: a disconnected agent remote shows "not connected", an SSH-only host "use the bigbud agent", the pool is only asked `liveConnection`, `ssh` is never spawned; mutation-checked by making the lookup dial); `fileNames` mode, page scaling, files-only cap, OS-index paging and per-platform sources; remote entry routing (engine, legacy + notice, cancel); `CommandPalette.fileSearch.browser.tsx` (local tier first and never held back behind a running slow query, 150 ms debounce for slow tiers only, fixed tier order whatever order sources answer, superseded and closed queries cancelled, toggles and File Access, remote current project through `search.query`, next page only after a user scroll, a merely visible row never pages but still works as a button); all mutation-checked. Settings cross-links (`settingsAnchor.browser.tsx`), wording per source (`osIndexWording.test.ts`), paging logic (`SearchPalette.systemSearch.logic.test.ts`).
  - Deviations: (1) The agent's legacy `FilenameSearchRequest` handler keeps its own walker, so old servers see unchanged behaviour; new servers only use it for agents without `workspace.search-stream`. (2) Superseded on 2026-11-20: Mod+F now splits fast and slow tiers like Mod+P (T1–T3 and the current project's files immediate, T4–T6 after the shared 150 ms debounce), so it runs one immediate current-project `search.query` beside one debounced slow-tier query. (3) Pages re-send earlier rows (dropped by ID on the client) rather than resuming the walk; the agent engine has no resume cursor. (4) The slow-tier debounce starts from the palette's empty query, as it opens.
- **Phases 6 and 7: agent adapters complete in `bigbud-remote-agent/src/os_index/` (uncommitted); live runs on Windows and Linux pending.** The public API is unchanged (`resolve_scopes`, `OsIndexRequest`, `search_names`, `OsIndexOutcome`, `OsIndexError::code()`), so the existing frames 77–79 and session handlers serve both. Every adapter returns raw rows to the shared `finish_hits` (scope containment, exclusions, de-duplication, `search::rank` ordering, cap), so no row leaves the module unchecked. `OS_INDEX_SOURCE` is `spotlight`, `windows-search` or `locate`. Cancel and deadline polling is shared (`stop.rs`, 10 ms).
  - Scopes (`scope_layout.rs`, `ScopeLayout::{MACOS, WINDOWS, LINUX}`): macOS is unchanged. Windows uses the profile's visible folders except `AppData` at `unrestricted`; `common-folders` also looks for Desktop/Documents/Downloads/Music/Pictures under `OneDrive*` profile folders (Known Folder Move). Linux uses home's visible folders at `unrestricted` (no `Library` rule); `common-folders` adds folders named in `~/.config/user-dirs.dirs`, accepting only `"$HOME/<relative>"` values (no absolute paths, variables, escapes or `..`; file capped at 64 KiB). Scopes and results are compared in `plain_canonical` form: on Windows the verbatim `\\?\` prefix is dropped only when lossless (`winpath.rs`), because Windows Search reports plain drive paths. New `home_folder()` reads `USERPROFILE` on Windows and `HOME` elsewhere.
  - Windows (`windows_search.rs`, `.oledb.rs`, `.rows.rs`, `windows_sql.rs`): `SELECT TOP 200 System.ItemPathDisplay, System.Size, System.DateModified, System.FileAttributes FROM SystemIndex WHERE (SCOPE='file:C:/…' OR …) AND System.FileName LIKE '%<literal>%'`. The provider has no bound parameters, so the literal doubles `'` and brackets `%`, `_` and `[`; scopes must be plain drive folders. ISearchQueryHelper is not used (it parses AQS, a second injection surface). A worker thread owns an MTA COM apartment and every COM object (released before `CoUninitialize`), opens `Search.CollatorDSO` from a connection string (no UI), sets an optional `DBPROP_COMMANDTIMEOUT` equal to the deadline, and reads rows into client-owned buffers through one accessor. The caller polls cancel/deadline and returns at once; an abandoned worker stops between row batches, and at most two workers exist (otherwise `UNAVAILABLE`). Activating `CSearchManager` and opening `SystemIndex` fail when the WSearch service is stopped or disabled → `UNAVAILABLE`; SQL errors → `QueryRejected` (`UNAVAILABLE`). Result paths take the scope's spelling (ASCII case-insensitive) before the shared check. `is_directory` comes from `FILE_ATTRIBUTE_DIRECTORY`; content type and last used are left unknown. The `windows` crate is reused at the locked 0.62.2 with binding features only (`Cargo.lock` gains one dependency edge, no new packages).
  - Linux (`locate.rs`, `locate_args.rs`, `locate_process.rs`, `locate_rows.rs`): `plocate -i -b -0 -l 20000 -- '*<literal>*'` started directly (never a shell, never `sudo`; GPL-2.0, so never linked), with `\ * ? [ ]` backslash-escaped so the glob can only match a literal, case-insensitive substring of the file name. If `plocate` is not installed, `locate` is used only when `locate --version` names `plocate`, `mlocate` or GNU findutils (same options and glob rules); otherwise `UNAVAILABLE`. NUL-separated output is streamed; rows outside the scopes are dropped while streaming (the index is disk-wide), excluded rows are passed on unread so they are counted, and the rest are `lstat`ed for type, size and modification time, which also drops rows deleted since `updatedb`. The child is killed and reaped on cancel, deadline, or once 200 returnable rows arrived; stderr is only drained and reduced to "something was written". Exit 0 is success, a silent exit 1 with no rows is "no match", anything else (database missing or unreadable, unknown option, crash) is `UNAVAILABLE`.
  - Index staleness: the `plocate` database is refreshed by a daily `updatedb` timer, so files created today can be missing for up to a day (deleted files are filtered). The palette and Settings copy should say "results may be up to a day old" on Linux.
  - Wiring follow-ups outside `os_index` (done with Phase 8, see below): (1) `session/os_index_search.rs` resolves home from `HOME`, which is normally unset on Windows; it should call `os_index::home_folder()`. (2) The server's `OS_INDEX_SOURCE_ID` is the constant `"spotlight"`, and Settings, the hint and the unavailable notice say "Spotlight"/"this Mac"; they need per-platform copy (Windows Search, `plocate`) and the Linux staleness note. (3) Whether the server enables `--os-index` on Windows and Linux desktop builds has to be confirmed in the running app.
  - Tests: pure SQL and glob escaping with injection attempts (mutation-checked: removing any escape fails a test), `SCOPE` literals, verbatim-prefix and scope-spelling rules, `user-dirs.dirs` parsing, Windows and Linux layouts, NUL record parsing across chunks, exit classification and fallback compatibility. Fake `plocate`/`locate` programs (any Unix) cover one-argument query passing, scope/exclusion/stale-row filtering, kill on limit, deadline and cancel, unavailable on error, crash or missing programs, and the `mlocate` fallback. `locate.live.tests.rs` (Linux only, skipped with a reason when `plocate` is missing; optional `BIGBUD_LIVE_LOCATE_MARKER` escaping check after `updatedb`) and `windows_search.tests.rs` (Windows only) are compiled for their targets but have not run.

## Pending live verification

Items that cannot be verified from a sandboxed shell and must be checked by hand before release:

- Spotlight from the packaged bigbud app with Full Disk Access off and on (Desktop, Documents, Downloads, iCloud Drive), and TCC attribution of the server-started agent.
- Remote VPS scans during an active turn (CPU share, bytes over SSH, 3 s deadline).
- Real performance numbers for every §9 budget on large trees and a real message database.
- Old-agent fallback against a deployed agent without `workspace.search-stream`.
- Phase 2 exit: the same results locally and on a remote for one shared fixture tree, and cancel latency ≤ 50 ms end to end.
- Packaged agent binary size growth per target.
- Phase 3 exit: 30 local projects and 2 remotes (T2 first, T4/T6 streaming without reordering), a disconnected remote shown as "not connected" without delaying other tiers, and the agent search registry empty within 100 ms of the last keystroke.
- Phase 5 exit: Spotlight name queries within the T5 budget from the packaged app, File Access `common-folders` and `unrestricted` scopes, and the one-time hint and Settings rows in the running app.
- Palette opening in the desktop app: a `.docx` opening in its default app, an `.app`/`.exe` revealed instead of launched, "Reveal in Finder", and "this computer" rows opening in the system app.
- Phase 6 exit (Windows machine): `windows_search.tests.rs`; a name query within the T5 budget; WSearch stopped or disabled shows "unavailable"; `[`, `%`, `_` and `'` in names match literally (the `[[]` escape is documented for `%` only); `DBPROP_COMMANDTIMEOUT` is honoured or the abandoned worker still ends; OneDrive Known Folder Move scopes; `HOME`/`USERPROFILE` resolution once the session uses `home_folder()`; the packaged agent builds and runs on x86_64 and aarch64 Windows.
- Phase 7 exit (Ubuntu/Debian machine): `locate.live.tests.rs` with `plocate` installed, including the `BIGBUD_LIVE_LOCATE_MARKER` escaping check (`[x]`, `*`, `?` literal; `-i -b` with escaped globs on the installed `plocate` version); missing `plocate` and an unreadable database show "unavailable"; the `mlocate` fallback on a distribution that still ships it; timing within the T5 budget on a large database.

- Phase 8 exit in the desktop app: Mod+P current-project rows appear as fast as before; other projects, this computer and connected remotes stream below in order; typing quickly leaves no orphaned agent operations; a disconnected remote shows "not connected" and no SSH process starts; scrolling to a tier's end loads its next page; the same tree ranks identically locally and on a remote (shared fixtures pass in CI, but not yet checked against a live remote).
- Default-on "Search this computer": first launch with File Access "No access" shows the hint and no T5 notice spam; turning File Access on starts T5 without a restart; Windows and Linux wording and the locate staleness note in the running app.

## Open Questions (resolved as assumptions)

Each item below is adopted as "Assumed (recommended) — user may revise" (see §Decisions). The original wording is kept for reference.

1. **Default for "Search this computer".** Recommendation: **off by default**, with a one-time hint in the palette ("Turn on search across this Mac"). Revised by the user on 20 November 2026: **on by default**, gated by File Access.
2. **How the File Access level gates "this computer".** Recommendation: `none` disables the tier; `common-folders` restricts Spotlight to Desktop, Documents, Downloads, Music and Pictures; `unrestricted` covers the non-`Library` home folders plus iCloud Drive and CloudStorage. Follow-up choice: should `fileAccessPermissionLevel` move from client to server settings, so the server enforces it? Recommendation: yes, mirrored once on upgrade.
3. **Meaning of tier 6, "remote areas outside projects".** Decision 4 limits remote search to project folders. Recommendation: T6 = registered remote workspace roots that are not themselves project folders, as the agent's user, bounded. Never the remote home or host. If you meant something else, T6 is dropped.
4. **"This computer": file names only, or contents too?** Recommendation: **names only at first.** Content matching (Spotlight `kMDItemTextContent`, measured at 30–240 ms) would come later behind a second toggle, because it surfaces private document text in the palette.
5. **Direct-SSH remotes (no managed agent).** Removing `PATH` `rg` locally is decided. For direct SSH, should bigbud (a) keep `rg`-on-host as a legacy path until those remotes move to a managed agent, or (b) require the managed agent for content search? Recommendation: **(a)**, with a "Use the bigbud agent for faster search" hint.
6. **Relevance versus recency for other saved messages (T3).** Recommendation: tier, then bm25, then recency, within a bounded recent window. A message from a year ago that matches better can rank above yesterday's only within that window.
7. **Loose-file previews outside projects.** Recommendation: read-only, no annotations, no agent access, no automatic attach. Acceptable?
8. **Remote download cache limits for opening unsupported remote files.** Recommendation: open without asking up to 100 MiB, confirm from 100 MiB to 2 GiB, refuse above 2 GiB. Cache capped at 1 GiB and 7 days.
9. **Dependency approval** (required by `crates/AGENTS.md`): `ignore`, `grep-searcher`, `grep-regex` and `grep-matcher` (Unlicense/MIT; about +2.2 MB stripped; brings in `encoding_rs` with a BSD-3-Clause part), plus macOS-only `objc2-core-services` 0.3.2 with feature `MDQuery` (Zlib/Apache-2.0/MIT; about 0.4 MB). Approve?
10. **Phase order.** Recommendation: 1 → 2 → 3 → 4 → 5, then 6 and 7. Phase 1 is a quick win that needs no new dependencies. Phase 5 depends on Phase 0's packaged-app TCC check. Alternatively, Phase 5 could move ahead of Phase 4 if "this computer" is the headline feature.
11. **Hardening the generic preview route.** `/api/workspace-file-preview` accepts any `cwd` today. Recommendation: keep it out of this plan's scope and track it as a separate security follow-up (restrict to registered projects plus validated loose files). Should it be added here instead?
12. **Related work.** Should this plan be linked to a bigbud note or Kanban card? None exists yet.
