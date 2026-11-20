# System-wide search for Mod+F: research and recommendation

**Date:** 19 November, 2026
**Status:** Research only. No code changed.

## Summary

The request is for Mod+F to become "Spotlight, but better". It would search three areas:

- the whole local computer;
- connected VPS and VM backends;
- all of bigbud's own data.

Results would rank the current thread first, then the current project, then everything else.

**Recommendation: build a hybrid, in this order.**

1. **Workspace-wide search first (this is the product).** Cover bigbud data plus every project folder, local and remote. One Rust engine in `bigbud-remote-agent` should do this, built on ripgrep's library crates. It runs locally and on each remote, and streams tiered results into one ranked palette. The same engine can then back agent `grep`, `glob` and `find` tools across projects. This fits what bigbud says it is, which is "everything you're working on, in one place". It also fixes real gaps today: no cross-project file search, a naive remote content scan, and `rg` taken from PATH.
2. **"This computer" as an opt-in tier that uses the OS index**, not one we build:
   - Spotlight (`mdfind`/`NSMetadataQuery`) on macOS;
   - Windows Search (`SystemIndex`) on Windows;
   - `plocate`/`locate` on Linux when present.
     The OS already pays for indexing, battery use and permissions. Results appear in a bottom "This computer" section, matching file names only by default.
3. **Do not build our own whole-disk index or whole-disk content index.** On macOS, crawling the home folder triggers privacy (TCC) prompts or needs Full Disk Access. On Windows, the fast path (MFT and USN journal) needs administrator rights or a service. On Linux, whole-disk change tracking needs root (fanotify) or many inotify watches. It would also mean bigbud owns a second copy of every file name on the machine, which is a privacy liability. Most of the value (find a file and open it) is already available from the OS index at almost no cost to us.
4. **Remote: no persistent whole-host index by default.** Use bounded live scans of the agent account's project roots, using the same Rust engine. Add an optional per-host file-name index under `~/.bigbud` only after measurement shows that live scans are too slow.

Ranking tiers: current thread > current project or folder > other bigbud data (threads, messages, projects, terminals) > other projects' files > this computer > remote hosts that are not the current workspace. Results stream per tier and can be cancelled.

## 1. Product fit

### What bigbud says it is

- README: "An AI workspace for everyone. It keeps your research, writing, coding, files, and git workflows in one place". Features include remote projects over SSH, an embedded browser, terminals, Computer Use ("control … your macOS machine") and "System control — Tell agents to execute commands and perform tasks on your PC/Mac".
- Marketing copy (`apps/marketing/src/components/page-specific`): "Everything you're working on, in one place." "Look things up without breaking focus." "let your agent step into your apps and across your desktop".
- `CONTEXT.md` separates a **Project** (a folder of work) from a **Remote workspace** (a remote environment that holds projects).
- CHANGELOG direction: search across saved chats, terminal output from global search, remote file search, a warning when a remote root is the home folder or filesystem root ("broad area bigbud would watch, search, and make available to agents"), and cross-project agent actions (v0.3.4).

### Verdict

- **In scope:** searching _everything bigbud knows about_. That means every thread, message, project, terminal, note and kanban card, and the files in every project on every connected backend. bigbud does not have this today, it matches the positioning, and it compounds with agents.
- **Borderline but defensible:** a "This computer" tier. bigbud already reaches outside the workspace (Computer Use, system control, opening files from chat), and users attach arbitrary files to chats. Finding "that PDF in Downloads" and attaching or opening it is a real workflow. Building a better Spotlight than Spotlight is not the product. Delegating to the OS index gives most of the value at low cost.
- **Scope creep:** a bigbud-owned index of the whole disk or of file contents, app launching, calculator and similar launcher features. That is Raycast, Alfred or Spotlight territory, and those products win on OS integration.

### How adjacent products scope search

| Product                     | Scope                                                                                                                                                                                        |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VS Code / Cursor            | Quick Open (Cmd+P) covers files in the open workspace folders, ranked by recently opened files then fuzzy score. Search (Cmd+Shift+F) runs ripgrep over the workspace. Never the whole disk. |
| Zed                         | File finder and project search over worktrees in the project, including remote (SSH) projects through the remote server. A good model for "local + remote, same engine".                     |
| JetBrains Search Everywhere | Classes, files, symbols, actions and settings in the project and its libraries, in tabbed categories with mixed ranking. Project-scoped.                                                     |
| Warp                        | Command palette, history, workflows and Drive objects. Not files across the machine.                                                                                                         |
| Raycast / Alfred            | Whole machine, but file search is delegated to Spotlight's index (Raycast's File Search and Alfred both use the macOS metadata index). They do not crawl the disk themselves.                |
| Spotlight / Windows Search  | The OS-owned index. Covers the whole user scope, with content and metadata.                                                                                                                  |
| Arc / Dia                   | Tabs, history and bookmarks only.                                                                                                                                                            |
| ChatGPT / Claude desktop    | Searches only their own conversations. File access goes through explicit connectors or app integrations, not a disk index.                                                                   |

The pattern: developer tools search the workspace with their own engine. Launchers that search the machine delegate to the OS index. Nobody in bigbud's category ships its own whole-disk index. (These product descriptions come from public product behaviour as known to the author, not from fresh citations. Re-check them before quoting them externally.)

### Value to agents

This may be the strongest argument for the workspace-wide engine:

- bigbud already exposes `grep`, `glob`, `list` and `read` to agents for remote workspaces (`apps/server/src/remote-workspace-bridge/remoteWorkspaceTools.ts`).
- It has cross-project thread tools (v0.3.4).

A shared engine (ignore-aware walker, regex searcher, limits, symlink safety) could back:

- palette search;
- remote agent `grep`/`glob`, replacing a dependency on `rg` existing on the host;
- a new **project-scoped cross-project search tool**, gated like the cross-project thread tools.

**Agents must not get the "This computer" tier**, or must get it only through explicit per-call approval (see section 4).

## 2. Current state (verified)

- Palette: `apps/web/src/components/layout/SearchPalette.content.tsx` fans out to separate queries for the current file, saved messages, thread titles, projects (local and remote catalog), terminal scrollback, and the **current workspace root only** for file contents. Debounce is 200 ms. The palette shows 5 results per section with "see more".
- Saved messages: `ProjectionCatalogQuery.search.ts` uses an FTS5 trigram `MATCH` with `ORDER BY m.rowid DESC` (newest first, no relevance or tier). Queries must be 3 to 160 code points; page size defaults to 10 (maximum 30). The client splits the results into current thread and others.
- Local content search: `WorkspaceFileSystem.ts` spawns `rg --json --hidden --smart-case` with ignore globs, a 10 s timeout and a 512 KiB buffer (`WorkspaceFileSystem.search.ts`). Remote direct SSH also needs `rg` on the host ("Remote content search requires ripgrep on the SSH host").
- Mod+P file names: `WorkspaceEntries.ts` keeps an in-memory index per workspace, capped at 25,000 entries, with a 15 s TTL and at most 4 cached keys.
- Rust agent: `crates/bigbud-remote-agent/src/workspace/search.rs` does a breadth-first walk with a hard-coded ignore list (`.git`, `node_modules`, `target`, `.bigbud`) and no `.gitignore` support. It caps at 50,000 entries (`SearchLimitExceeded`) and 1,000 results, and content search reads whole files up to 5 MiB. The agent has few dependencies (no `ignore` or `grep` crates yet). `bigbud-workspace-watch` uses `notify` 8.2 (CC0-1.0).
- Desktop entitlements (`apps/desktop/resources/entitlements.mac.plist`) do **not** include the App Sandbox. The app runs with hardened runtime and is not sandboxed. `mdfind` and Spotlight APIs work, subject to TCC.

## 3. Technical options for "this computer"

### OS indexes (recommended path)

**macOS: Spotlight**

- Access: `mdfind` CLI, `NSMetadataQuery`, or the `MDQuery` C API. From Rust, use `objc2-core-services` / `core-foundation` bindings or shell out to `mdfind -0 -name`.
- Speed and freshness: queries usually return in tens of milliseconds. The OS keeps the index fresh with FSEvents. Cost to bigbud is near zero.
- Permissions: bigbud is not sandboxed. TCC still governs reading protected locations (Desktop, Documents, Downloads, iCloud Drive, third-party cloud storage, Mail and similar) ([Eclectic Light, 2025](https://eclecticlight.co/2025/11/08/explainer-permissions-privacy-and-tcc/), [protected folders in Tahoe](https://eclecticlight.co/2026/04/15/privacy-which-folders-are-protected-in-tahoe/?nb=1)). Spotlight leaves some protected stores (Mail) out of results even with Full Disk Access ([Michael Tsai, 2019](https://mjtsai.com/blog/2019/08/29/spotlight-excludes-mail-folder-on-macos-10-15)). Opening a result may trigger a per-folder prompt. **To verify:** exactly how `mdfind` filters results for a non-sandboxed caller without Full Disk Access is not documented. Test it before committing.
- Security note: Spotlight metadata has been a TCC bypass vector ([Microsoft, "Sploitlight", 2025](https://www.microsoft.com/en-us/security/blog/2025/07/28/sploitlight-analyzing-a-spotlight-based-macos-tcc-vulnerability)). Treat results as sensitive.
- Failure modes: indexing can be disabled or in progress, volumes can be excluded, and results can be missing on external or network drives.

**Windows: Windows Search**

- Access: query `SystemIndex` through OLE DB (`Provider=Search.CollatorDSO`) with `ISearchQueryHelper` to generate the SQL, using the `windows` crate.
- Coverage: results are security-trimmed to the user and support content and properties. By default only libraries, the user profile and the Start menu are indexed, not whole drives.
- Failure modes: the WSearch service is often disabled on managed or "debloated" machines, so fall back to "unavailable". The index scope is user-controlled.

**Linux: locate and desktop indexers**

- `plocate`: the default `locate` on Debian 12 and Ubuntu 22.04 and later. It is a trigram posting-list index ([Gentoo description](https://packages.gentoo.org/packages/sys-apps/plocate)) and checks per result that the user can access the path. In one informal test, a warm query took about 17 ms and the database was 152 MB on a large system ([r/commandline](https://redlib.hbubli.cc/r/commandline/comments/jk64bw/locate_using_sqlite3_full_text_search)).
  - Freshness: `updatedb` runs daily as root, so results can be up to a day stale.
  - Licence: plocate is GPL-2.0. Invoke the CLI; never link its code.
- `tracker` / `localsearch` (GNOME) and `baloo` (KDE): available only in those desktop sessions, through D-Bus or CLI. They are optional adapters for later.
- Fallback when none of these exists: show the tier as unavailable, or offer an opt-in home-folder name index (below).

### Building our own index (not recommended for the whole disk)

**File names**

Everything-style indexes: Everything reads the NTFS MFT and follows the USN journal. That "requires administrative privileges for low level read access to NTFS volumes", or the Everything Service ([voidtools FAQ](https://mail.voidtools.com/faq), [service docs](https://www.voidtools.com/support/everything/everything_service)). Without it, indexing "is much slower". For bigbud that would mean shipping a privileged Windows service, which is a large security and support surface.

Change tracking per OS:

- **macOS FSEvents** works without root and can catch up after a restart from a stored event ID. But crawling `~` triggers TCC prompts for each protected folder, or requires asking for Full Disk Access. That is a high-friction ask for a coding app and an enterprise red flag.
- **Linux inotify** needs one watch per directory. The default `max_user_watches` is now 1% of RAM, clamped to 8,192–1,048,576, with about 1 KB of unswappable kernel memory per watch ([kernel patch](https://lore.kernel.org/lkml/20201026204418.23197-1-longman@redhat.com/)). A home folder can exhaust it, and so can VS Code plus bigbud's watcher. fanotify with filesystem-wide marks needs `CAP_SYS_ADMIN`.

Size and cost: an own file-name index of about 1–2 million paths takes roughly 50–200 MB on disk in an FST or trigram format, and minutes of cold crawl (I/O-bound) on macOS. These are rough estimates; measure before relying on them.

Licences:

- usable: `ignore` (Unlicense OR MIT, checked locally), `fst` (MIT/Unlicense), `notify` (CC0-1.0);
- avoid linking: `fsearch` and `plocate` (GPL).

**Content**

- `tantivy` (MIT): Lucene-like full-text search, good for prose. Index size is often 20–50% of the text. Indexing is CPU-heavy and has a battery cost.
- Trigram code search: zoekt (Apache-2.0) and Russ Cox's codesearch (BSD) support regex queries in milliseconds. Indexes are several times larger than the corpus for zoekt-style positional indexes and smaller for codesearch-style. Rebuilding on change is costly.
- SQLite FTS5 trigram: already used for messages. Indexes are roughly 3x the text, and queries need at least 3 characters (already documented in the 2026-09-23 plan). In the informal plocate test above, SQLite was about 10x larger than plocate for paths.

Whole-disk content indexing duplicates Spotlight and Windows Search, and creates the biggest privacy liability. **Do not build it.**

**Live scanning (recommended for projects)**

ripgrep's library crates (`ignore`, `grep-searcher`, `grep-regex`; MIT/Unlicense) provide:

- parallel walking that respects `.gitignore`;
- binary detection and memory-mapped search;
- early stop at a result limit.

Typical repositories take well under 1 s warm. Huge monorepos can take seconds when the cache is cold. There is no persistent cost and no staleness, and the walker drops in for `search.rs` and the PATH `rg`. Combine it with a small in-memory file-name list per project, kept fresh by the existing `bigbud-workspace-watch`, so Mod+P and name matches are instant.

### Comparison

| Option                          | Cold build            | Query         | Freshness         | Cost                   | Permissions               | Burden |
| ------------------------------- | --------------------- | ------------- | ----------------- | ---------------------- | ------------------------- | ------ |
| Spotlight / Windows Search      | none (OS)             | ~10–100 ms    | OS (seconds)      | ~0 for bigbud          | TCC / user ACL            | low    |
| plocate                         | none (root cron)      | ~ms           | up to ~1 day      | ~0                     | per-result access checks  | low    |
| Own whole-disk name index       | minutes               | ms            | watcher dependent | 50–200 MB, watcher RAM | FDA / admin / root issues | high   |
| Own content index (tantivy/FTS) | tens of minutes–hours | ms            | lagging           | GBs, CPU, battery      | same                      | v.high |
| Live ripgrep-crate scan         | none                  | 50 ms–seconds | exact             | CPU only during query  | user's own files          | low    |

Latency and size figures marked "~" are estimates unless a source is cited. The phased plan includes benchmarks to replace them.

## 4. Remote VPS and VM backends

- **Default: live scan of registered project roots only**, run inside the agent with the Rust engine. Bandwidth use is small, because only ranked hits (path, line and a short excerpt) cross SSH, never file lists.
- Resource limits per query:
  - 2 threads at most on small hosts;
  - a deadline (for example 3 s), then return partial results and a truncation flag;
  - cancel when a newer query arrives;
  - lowered I/O and CPU priority (`nice`/`ionice` equivalents).

  The measured backend sits at about 230 MiB idle and 1.2% CPU, and turns already reach 69–97% CPU with 1–8 sessions (`docs/reports/2026-11-18-remote-backend-measurements.md`). Search must not compete with active turns: lower its priority and limit concurrency.

- **Optional per-host name index:** an FST or SQLite table under `~/.bigbud/agent/index`, owned by the user with mode 0700. It covers project roots, plus `~` only if the user opts in. Build it lazily, keep it fresh with the existing watcher, and bound it by size (for example 200k entries or about 30 MB). Add it only if remote Mod+P or Mod+F on large trees measures as slow.
- **Never use sudo and never index outside the agent account.** Do not read `/etc`, other users' homes or `/root`. If the host has `plocate`, its results are already access-checked for the user, but they are system-wide paths. Treat them as part of the "This computer (remote)" opt-in only.
- Disconnected hosts appear as a greyed "not connected" row in the tier, never as a silent empty result. The existing access gate (`useRemoteExecutionAccessGate`) applies.

## 5. Safety and privacy

**Default exclusions** for all non-project tiers, enforced in the engine rather than only the UI:

- `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.config/gcloud`, `~/.kube`, `~/.docker/config.json`, `~/.netrc`, `~/.npmrc`, `~/.pypirc`, `~/.git-credentials`;
- keychains (`~/Library/Keychains`), password-manager data (1Password, Bitwarden, KeePass `*.kdbx`);
- browser profiles (Chrome, Firefox, Safari, Arc), mail (`~/Library/Mail`, Thunderbird), Messages;
- `~/Library/Application Support/*/Cookies`;
- `.env*`, `*.pem`, `*.key`, `id_*`, `*.p12`, `*.pfx`, `credentials*`, `secrets*`, and bigbud's own state directory.

For project tiers, keep current behaviour: show `.env` files (developers expect it) but never send their contents to providers automatically.

**Index storage**

- bigbud data stays in the existing SQLite database.
- Any new index files go in the app data folder with owner-only permissions (0700 directories, as in commit 198ee98632).
- Excluded from backups and sync where possible.
- Encryption at rest adds little when the database already holds the messages, so rely on OS disk encryption and say so plainly.

**Never sent to AI providers.** Palette results are UI-only. A result reaches a model only when the user explicitly attaches or opens it into a chat.

**Prompt injection and agents**

- Agents may use the **workspace** engine (project roots they already have access to).
- Agents must **not** get "This computer" search by default. If it is ever exposed, it should be an approval-gated tool (like the cross-project consent in v0.3.4) that returns paths only, never contents.
- File names and snippets returned to agents are untrusted data, so label them that way in tool results.

**User controls**

- Settings toggles:
  - "Search this computer", **off by default**, with a per-OS explainer of which index is used;
  - "Search connected servers", **on** for registered project roots and **off** for the whole host home;
  - include and exclude lists.
- "Rebuild index" and "Delete index" for any bigbud-owned index.
- Pause while on battery or during heavy load.

**Managed devices.** Many enterprises disable Windows Search or Spotlight on parts of the system, or forbid apps from holding indexes. Using the OS index honours those policies automatically, which is another reason not to build our own. Document the feature for admins and support a policy key that turns it off.

## 6. Opening results

**Supported in bigbud today** (`apps/web/src/lib/workspaceFilePreview.ts`, `FilesPanel.preview.tsx`, `FilePreview.logic.ts`, `filesPanel.open.ts`):

- Files panel:
  - text and code with syntax highlighting (any code extension per `isCodeRelatedFilePath`, plus dotenv, ini, Dockerfile, Makefile and others), with editing (v0.3.x);
  - Markdown (`.md`, `.mdx`) rendered, with annotations;
  - Jupyter `.ipynb`;
  - images: avif, bmp, gif, ico, jpeg, jpg, png, svg, webp;
  - video: avi, mov, mp4, webm, with HTTP Range streaming.
- Browser panel: PDF, HTML and images through `buildWorkspaceFilePreviewUrl`.
- Limit: text preview is capped at 5 MiB (server and agent `MAX_TEXT_PREVIEW_BYTES`).

**Not supported:** Office documents, audio, archives, fonts, other binaries. These should open with the system default app.

**System default app**

- Desktop has no `shell.openPath` or `shell.showItemInFolder` use today (only `shell.openExternal`).
- The server already has `Open.openPath`, which spawns `open`, `explorer` or `xdg-open` (`apps/server/src/utils/open.ts`).
- Desktop should add an IPC that calls Electron's `shell.openPath(path)` (resolves with an error string when it fails) and `shell.showItemInFolder(path)` for "Reveal in Finder/Explorer". Fall back to the server `openPath` in web mode on the same machine.

**Results outside any project.** Preview routing is keyed to `cwd` plus `relativePath` inside a workspace root. "This computer" results need a read-only "loose file" preview target that:

- is validated against the exclusion list;
- does not allow editing by default;
- carries no implicit agent access.

**Remote files**

- Supported types preview over the agent within the existing limits (5 MiB text, streamed video).
- For "open with system app", download to a private cache (`<appData>/remote-open-cache/<host>/<hash>/name`, mode 0700) with a size cap. Ask before downloading anything over 100 MB.
- Show "this is a copy; edits won't sync", and evict the cache by age and size.

## 7. UX and ranking

**Tiers, fixed order.** Score within a tier, not across tiers:

1. Current thread (messages; current file when a preview is focused).
2. Current project or folder: files, file contents, and threads in that project.
3. Other bigbud data: thread titles, messages, projects, terminals, notes and cards.
4. Other projects' files (local, then connected remotes).
5. This computer (OS index).
6. Remote host beyond project roots (if opted in).

**Within a tier:**

- exact or prefix matches on the name above fuzzy subsequence matches;
- path-segment matches boosted;
- frecency from bigbud's own open and attach history (as VS Code and Raycast do);
- recency as a tie-breaker.

Saved messages currently sort newest-first only. Add FTS5 `bm25()` plus a bonus for the current project.

**Streaming and cancellation**

- Each tier resolves independently and appends in place, without reordering rows already shown, to avoid the list jumping under the cursor.
- A query generation ID cancels server work (abort `rg` / the agent request) as the user types.
- Keep the 200 ms debounce for remote and OS tiers. Local bigbud tiers can run sooner.

**Short queries**

- 1–2 characters: thread titles, projects and recent files only (fuzzy).
- 3 or more: message FTS and content search.
- OS tier at 2 or more characters.

**Fuzzy vs exact.** Names are fuzzy (a nucleo-style matcher; `nucleo` is MPL-2.0, so check whether that licence is acceptable, or keep the existing TypeScript and Rust rankers). Contents use literal smart-case matching. A regex toggle should come later.

**Section caps.** Keep 5 rows per section with "see more". Show a "Searching this computer…" row and a clear "unavailable: Spotlight disabled" row when that applies.

## 8. Phased plan

| Phase | Scope                                                                                                                                                                                                                                                       | Effort    | Main risks                                       |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ------------------------------------------------ |
| 0     | Benchmarks: palette p50/p95 per tier on a large local repo and on the 2 vCPU VPS; `mdfind` behaviour with and without TCC grants; Windows Search availability.                                                                                              | 2–3 days  | none                                             |
| 1     | Ranking only: a unified tier model in the palette, current project first, BM25 for messages, streaming sections, cancellation.                                                                                                                              | ~1 week   | result jumping; test churn                       |
| 2     | Rust search engine in `bigbud-remote-agent` (`ignore` + `grep-searcher` + `grep-regex`): replaces `search.rs` and PATH `rg` locally and remotely. Streaming protocol messages, deadlines, priority, cancellation. Backs the remote agent `grep`/`glob` too. | 2–3 weeks | protocol versioning with deployed agents         |
| 3     | Workspace-wide: search all local projects plus connected remote project roots in parallel; a per-project name list kept fresh by the watcher.                                                                                                               | 1–2 weeks | fan-out load on many projects; remote slowness   |
| 4     | Opening: desktop `shell.openPath` / `showItemInFolder` IPC, loose-file read-only preview, remote download cache.                                                                                                                                            | ~1 week   | path-validation bugs (security review)           |
| 5     | "This computer" (opt-in): a macOS Spotlight adapter first, then Windows Search, then Linux plocate/locate. Exclusion list, settings toggles, policy key.                                                                                                    | 2–4 weeks | TCC semantics; disabled indexers; Windows OLE DB |
| 6     | Optional: agent cross-project search tool (gated); a remote per-host name index if Phase 0/3 data shows a need.                                                                                                                                             | as needed | prompt injection; disk use on VPS                |

**What to measure:**

- time to first result and to completion per tier;
- remote CPU and RSS while searching during an active turn;
- cancellation latency;
- bytes over SSH per query;
- result click-through by tier (to test whether the ordering is right);
- for any index: build time, size, and freshness lag.

**Where not to build:**

- own whole-disk name or content indexing;
- a Windows privileged service;
- Full Disk Access requests;
- remote indexing outside the agent account;
- launcher features (apps, calculator, system settings).

## 9. Open decisions for the user

1. Accept the hybrid (workspace-wide plus an optional OS-index tier), or require a bigbud-owned whole-computer index despite the permission and privacy costs?
2. Should "Search this computer" be off by default? (Recommended: off, with a first-use explainer.)
3. Should "This computer" match file contents (using the OS index's content search), or file names only at first?
4. Remote scope: project roots only (recommended), or the agent account's whole home as an opt-in?
5. May agents ever use "This computer" search? (Recommended: no, or approval-gated and returning paths only.)
6. Is a loose-file preview for files outside projects acceptable, read-only and with no agent access?
7. Priority order of Phases 1–3 (ranking now vs engine first), and which OS adapter ships first (recommended: macOS).
8. Licence policy for MPL-2.0 crates (for example `nucleo`), if a new fuzzy matcher is wanted.
