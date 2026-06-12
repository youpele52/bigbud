# Changelog

This document tracks notable project changes in a format that is useful for developers, users, AI assistants, and public release sharing.

Entries below are grouped by release tag and date.

## v0.1.643 (12 June, 2026)

### New AI Providers

- Added two new AI coding assistant providers: **Devin**, powered by Devin's CLI in ACP mode, and **KiloCode**, powered by the KiloCode CLI and sharing the OpenCode SDK infrastructure — both joining Codex, Claude, Copilot, and OpenCode.
- Both handle authentication through their own CLI credentials outside the app, so no separate login flow is needed inside bigbud.
- Devin offers an ACP-based session runtime with configurable model selection; KiloCode supports Claude Sonnet, Haiku, and Opus models with reasoning support, plus any custom models from its providers system.
- Fixed a bug where warning or error states on a provider would silently switch you to Codex — now the app shows them explicitly. Refactored the OpenCode event pipeline to be provider-aware throughout, preventing sessions from switching provider after the first message and enabling reliable multi-provider operation.

### Notebook Preview in Files Panel

- Added support for viewing Jupyter notebook (.ipynb) files directly in the Files panel, so you can browse notebook content — including code, markdown, and output cells — without opening a separate editor.
- Code cells are syntax-highlighted in the same style as regular code files, and markdown cells reuse the app's existing markdown renderer for consistent styling and file-link handling.
- All notebook outputs — plain text, HTML, images, SVG graphics, stream output, and error tracebacks — are rendered inline, so you can read the full notebook in one view without switching tools.
- Notebook cells support the same annotation flow as regular code files: right-click to select a range, add a note, and send it to the AI with the notebook path and line references.

### Right Panel Tab Reordering

- Added drag-and-drop reordering for right panel tabs, so you can rearrange Browser, Files, Git, Terminal, Diff, and Notes tabs into whatever order suits your workflow.

### Context Window Warning Threshold

- Added a configurable threshold setting under Settings → Notifications that lets you adjust when the context window warning appears (default 120k, range 60k–1M tokens), replacing the previously hardcoded 120k limit.
- The context window meter and warning banner both update reactively when you change the threshold, so you get immediate feedback on how your setting affects the display.

### Sidebar Thread Status Icons

- Replaced the sidebar activity dot with a monochrome provider icon that communicates thread state at a glance: blue while the AI is working, amber during compaction, red on errors, and muted grey when idle.

### Git Panel Enhancements

- Added a vertical resize handle between the commit details header and the diff viewer in the Git history panel, letting you adjust how much space the commit message and file changes each get — defaults to a 1/3–2/3 split.
- Fixed the changes view's diff viewer so it scrolls vertically and horizontally when content overflows, matching the scrolling behavior that already worked in the history view.

### Composer

- Added a search bar to the + button → "Call agent" and "Use skill" picker dropdowns, so you can type to find the agent or skill you want — matching the existing search experience from the /agents and /skills slash commands.

### Validation

- Validated with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused automated test coverage for Devin provider session lifecycle, adapter registration, model selection, and ACP startup flows; KiloCode provider adapter startup, session methods, and layer wiring; notebook preview rendering, markdown cell reuse, output cell rendering, and annotation support; right-panel tab drag-and-drop reordering; configurable context window warning threshold rendering and settings UI; sidebar thread status icon colors and dot suppression; Git panel resize interaction and changes-view diff scrolling; and composer + button agent/skill picker search bar.

## v0.1.642 (9 June, 2026)

### Git Panel and Repo History

- Added a dedicated Git tab in the right panel with separate `Changes` and `History` views, so you can inspect your repository state without leaving the app.
- Git history now shows the author, relative time, pushed state, and older commits as you scroll, making the timeline easier to scan without hitting a hard cutoff.
- Updated the Git changes view to handle real working-tree review better: `mod+g` now toggles the panel like other tools, large change lists reveal more files as you scroll, changed files can be dragged into the composer, and added or deleted file diffs render more reliably.

### Notes Panel and File Annotations

- Added a Notes panel in the right panel where you can create, edit, and manage plain-text notes stored on your filesystem, organised by project or as global notes, with auto-save (300ms debounce) and polling-based refresh so changes from the AI or other tools are picked up automatically.
- Notes support an edit/preview mode, letting you write or review content before saving, and each note includes its absolute path so the AI can read and modify the file directly when you reference it in a message.
- Added the ability to annotate any file in the preview viewer with a two-step flow: right-click to select a range, then choose an intent (Ask, Context, or Fix) and write your comment — this works for both code files and notes, replacing the previous browser-only annotation model.
- Fixed annotations in preview mode so selection mismatches between rendered text and raw markdown no longer silently fail — they fall back to annotating the first line instead.
- Renamed the annotation attachment taxonomy so browser and file annotations are clearly separated in the codebase, reducing the chance of annotation conflicts in the composer.
- Extracted a shared `BaseMarkdown` component from the chat markdown renderer with configurable line-break preservation, so the notes preview and chat messages each get the right rendering behaviour without duplicating the highlight, copy, and link-handling logic.

### Workspace Search Across Both Palettes

- Added workspace file name and path search to the command palette, so you can quickly jump to files from the active workspace without leaving the keyboard flow.
- Added workspace file content search to the search palette, including line and column metadata, so `mod+f` can now locate matching text inside project files instead of only searching chat content.
- Updated both palettes to reuse the existing file-open flow and added see-more pagination, keeping results relevant while letting previewable files open directly inside bigbud's Files panel.

### Shortcut Reorganization and Open Project

- Reorganized the default keybindings to make room for new commands: `mod+shift+n` now toggles the Notes panel, `mod+alt+n` creates a new local chat, `mod+o` opens a folder as a project, and `mod+shift+o` opens the favourite editor — the new thread shortcut is now `mod+n` only, streamlined to a single chord.
- Added an `Open Project` command bound to `mod+o` that opens your system folder picker and creates a new project from any directory, making it easy to start working in a different codebase without going through the project manager.
- Added `notes.toggle` and `project.open` to the keybinding registry and models, and wired both into the global shortcut handler with proper terminal-focus gating, so they are reliable and consistently documented.
- Updated the right-panel launcher and tab strip to show the Notes shortcut label alongside the other tool shortcuts.

### Composer Slash Commands and Discovery Search

- Slash commands no longer need to be typed at the very start of a prompt. Commands like `/model`, `/agents`, `/skills`, and provider-specific slash actions now work from anywhere within the active line while still ignoring slashes inside URLs and paths.
- Added a search bar to the `/agents`, `/skills`, and `/model` discovery menus, making large agent, skill, and model lists easier to browse.
- Grouped discovery results under clear `Agents`, `Skills`, and `Models` headings and fixed the search row so clicking anywhere inside it focuses the input.

### Browser Tabs and Navigation History

- Added support for up to five browser tabs in the right panel, so you can keep several pages open and switch between them without losing your place.
- Updated browser tabs to show the current page title when available, with a hostname fallback and hover label for long names, making it easier to recognize each page at a glance.
- Increased saved browser address history from 10 to 20 entries, giving the address bar more useful recent-page suggestions.

### Context Window Warning Threshold

- Added a visual warning indicator to the composer context window meter when token usage reaches 120k — the progress ring and percentage text switch to a warning color (amber) so you can see at a glance when you are approaching the limit.
- Hovering the meter now shows a danger-style alert inside the tooltip explaining that some models may start deteriorating past 120k tokens, with a suggestion to use the handoff skill or the `/compact` command.

### Browser Annotation Safety and Fallbacks

- Hardened browser annotation handling so malformed runtime payloads no longer crash the app when comments, page metadata, element metadata, or viewport fields are missing or incomplete.
- Updated composer annotation previews and prompt-building logic to use safe fallbacks when browser annotations do not include selectors or other expected fields.

### Right Panel Shortcuts and Launcher

- Added a dedicated `mod+t` shortcut for opening the right-panel new-tab launcher, so you can jump straight into Browser, Files, Terminal, Diff, or Git without reaching for the mouse.
- Updated the right-panel launcher and tab menu ordering so Git sits alongside the other repo tools in a more predictable spot.

### Maintainability

- Enforced a hard 400-line limit for non-test TypeScript source files and a 500-line cap for test files, and split several oversized test files across the codebase to comply — keeping the codebase easier to navigate and reducing merge conflicts from large file changes.
- Removed leftover `.plans` documentation files and added placeholder test-data fixtures to keep the test infrastructure self-contained.

### Validation

- Validated this release window with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused automated test coverage for workspace palette search, slash-command detection, discovery search behavior, malformed browser annotation regression cases, Git panel history and diff behavior, right-panel shortcut toggles, Notes panel CRUD and annotation flows, keybinding reorganizations, Open Project dialog and error handling, and context window warning threshold rendering.

## v0.1.641 (4 June, 2026)

### Files Panel Live Directory Watching for Local Workspaces

- Replaced Files panel polling with scoped live directory watching so the root and currently expanded folders refresh automatically when workspace files or folders change, backed by debounced `fs.watch` events on the server and a new WebSocket subscription across the contracts layer, server RPC handlers, and web client.
- The new live watcher now supports both project roots and default chat folders like `~/Documents`, so omitting `relativePath` correctly watches the normalized workspace root instead of falling through the strict relative-path resolver.
- Updated the Files panel rendering to keep cached directory entries visible during live refreshes, eliminating flicker while watched root and expanded folders update in the background.
- Extended the same live directory-watching pattern to the file preview viewer, so open files now refresh automatically when their parent directory changes without flickering during background reloads.

### Right Panel Refactoring and Shared Host

- Consolidated the right panel into a shared host component that owns the tab strip, so all tools (Browser, Files, Terminal, Diff) open as tabs in one consistent panel instead of separate floating sheets.
- Decoupled the right panel tab coordination from the diff panel by extracting tab selection state into a generic hook and removing the diff panel's direct dependency on route-level tab state.
- Redesigned the right panel tab strip with improved visual hierarchy — the active tab uses a stronger foreground and background tint, inactive tabs are visually flattened, and the close button now sits inside the tab hover state instead of at the panel edge.
- Removed all legacy route-mounted diff panel code (`DiffPanelSheet`, `DeferredDiffPanel`), the `useMediaQuery` responsive variant that selected between them, and the `hasOpenedDiff` flag that tracked first-open state. The diff panel now renders exclusively inside the shared right-panel host tab.

### Terminal Output Batching and Scroll Stability

- Server-side PTY output is now batched before sending to the client, coalescing rapid sequential writes into a single message to reduce CPU churn and network overhead during heavy streaming.
- Client-side terminal writes are batched at the composable level so rapid output events (common during AI streaming) are applied in a single render pass instead of dozens of individual ones, eliminating intermediate flicker and scrolling jank.
- Terminal drawer resize events are deduplicated on the client to avoid redundant layout recalculations, and a retry mechanism handles edge cases on very small viewports where the resize might not take effect immediately.

### Prompt Queue Thread Affinity

- Fixed a bug where prompts queued while a thread was still running would follow the user when they navigated to a different thread — the queue state is now keyed by `threadId`, and any pending `requestAnimationFrame` callback is cancelled on thread switch or unmount. This means a queue prompt stays attached to its original thread, never auto-sends in the wrong conversation, and remains waiting in the composer when you navigate back.

### Panel and Drawer Transition Smoothing

- Left sidebar, right panel, and terminal drawer now animate with a smoother motion curve for all open and close transitions.

### Route Helper File Renaming

- Renamed `__root.bootstrap.tsx`, `__root.logic.tsx`, and `__root.recovery.ts` to `-__root.bootstrap.tsx`, `-__root.logic.tsx`, and `-__root.recovery.ts` following TanStack Router's ignore convention (files prefixed with `-` are excluded from route detection). This eliminates the startup warnings about non-route helper files not exporting a Route.

### Validation

- Validated this release window with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused automated test coverage for the workspace directory watcher (root-level watching, path escape rejection), scoped project-directory WebSocket subscriptions, server and client RPC routing, Files panel directory refresh hook, route regression (diff=1 does not mount standalone diff UI), and prompt queue formatting and thread affinity behavior.

## v0.1.640 (3 June, 2026)

### Right Panel Toggle, State Persistence, and Shortcut

- Replaced the right-panel dropdown launcher with a single toggle button that opens and closes the panel via `alt+mod+b`, with the shortcut label shown in the tooltip.
- Right panel now remembers its active tab when closed — reopening restores the exact same view (Browser, Files, Terminal, or Diff) instead of resetting to the launcher.
- Added an empty-state launcher grid with four cards (Browser, Files, Terminal, Diff) that shows when the panel is empty or first opened, each card displaying its icon, description, and keyboard shortcut label.
- Added Diff as an openable tab in the `+` panel tab menu alongside Browser, Files, and Terminal.
- Fixed the `alt+mod+b` shortcut not firing on macOS, where the Option modifier changes `KeyboardEvent.key` for letter keys, by adding a code-based fallback in the keybinding matcher.

## v0.1.639 (2 June, 2026)

### Browse and Preview Files Without Leaving the App

- Added a file browser panel so you can explore your project's folders and files right inside the app — just open it from the toolbar, click through directories, and drag any file directly into your message to share it with the AI.
- When you click a file in the browser, its contents now appear in a preview pane with color-coded syntax highlighting, so you can quickly scan code without opening a separate editor.
- Double-click any file to open it — code files (TypeScript, Rust, Python, Markdown, etc.) go straight to your preferred code editor, while PDFs, images, and documents open with your system's default app.
- Dragging a file from the browser into your message now tells the AI where that file lives in your project, so it can read and work with the right file without you having to explain the path manually.

### Annotations Beyond the Browser

- Annotations are no longer limited to browser screenshots — you can now annotate code files too. Select a piece of code in the preview pane and add a note explaining what you want changed, and the AI will see both the code and your instruction when you send the message.
- This works alongside the existing browser annotations, giving you one consistent way to point the AI at exactly what you mean, whether it's a visual element on a page or a line of code.

### Visual Feedback for Ongoing Work

- Added a subtle animated indicator that shows up when long-running operations are in progress, so you always know the app is busy working on something — no more wondering if your action went through.

### Packaging and Distribution

- Updated the project homepage across the board to `bigbud.app`.
- Fixed Linux `.deb` package metadata so it installs cleanly on Debian-based distributions.
- Improved the Linux packaging pipeline to handle edge cases in Electron's build process more gracefully.

### Plan Sidebar and Chat Improvements

- The plan sidebar now shows active tasks in a more compact layout, so you can see what the AI is implementing at a glance without scrolling.
- Tuned the chat view so new content scrolling into view feels smoother and more natural as responses stream in.

### Right Panel Launcher and Tabs

- Consolidated the right-panel entry points into a single launcher so browser, files, terminal, and side chat are opened from one place instead of separate header buttons.
- Added a tab strip for the right panel so browser, files, and terminal can stay available as distinct views while you switch between them from the same workspace area.

### Right Panel Tab Polish

- Aligned the right-panel divider and tab strip with the main chat line so the header rhythm stays consistent across the layout.
- Moved the close action into the tab hover state and removed the extra close button from the panel body to keep the tab controls cleaner.

### Chat File Paths Open In App

- Clicking a supported file path in chat now opens that file in bigbud's own file viewer instead of immediately jumping out to your editor, so reading referenced code stays inside the app when possible.
- Right-clicking a supported chat file path now gives you both `Open in file viewer` and `Open externally`, while unsupported files still fall back to your usual external app or editor.
- When a chat file path includes a line reference like `:16` or `:16:23`, the in-app viewer now opens the file and scrolls to the referenced line as a best-effort target, while external open remains available when you want exact editor positioning.

### Validation

- Stabilized long-thread chat scrolling while responses are still streaming by keeping the active turn, recent completed turns, and expanded work rows mounted before virtualizing older history, which prevents older rows from disappearing as the timeline boundary moves.
- Validated this release window with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused automated test coverage for the files panel, drag-and-drop file handling, right-panel coordination, file preview, annotation logic, editor routing, and chat file-path preview targeting.

### Browser Reload Actions

- Changed the desktop View menu reload shortcuts so they target the embedded browser panel instead of reloading the whole app window.
- Added a cache-bypass reload path for the browser panel, and made background browser tabs activate first before they reload so the command still works when the panel is hidden.

### Editor Detection and Windsurf Support

- Added app-aware editor detection so bigbud can discover installed code editors (VS Code, Cursor, Windsurf, Zed, etc.) on your system instead of relying on a single configured editor path.
- Added Windsurf to the editor picker with the real Windsurf app icon for easy identification.
- When you open a file via double-click or chat path, the app now routes to the best available editor automatically.

### Terminal Panel Independence

- Split terminal panel sessions from the drawer terminal so the right-panel terminal now maintains its own session independent of the bottom drawer terminal, letting you run separate commands in each without interference.

## v0.1.638 (31 May, 2026)

### Prompt Queue

- Added a prompt queue system that queues up to 5 follow-up prompts while the AI is still processing, with per-item remove, auto-flush when the turn completes, and a "Send now" button to interrupt the current turn.
- Integrated the prompt queue into a consolidated composer header (approvals, plan follow-up, prompt queue) to keep the composer UX consistent and maintainable.

### Linux Desktop Reliability

- Hardened the Linux desktop runtime to better survive GPU crashes and degraded Electron startup conditions without going silent.
- Fixed AppImage startup edge cases (including restart deadlocks) and tightened packaging verification to reduce broken releases.
- Improved Linux distribution coverage by locking builds to `ubuntu-22.04` and adding a `.deb` fallback.

### Search Palette Overhaul

- Expanded search to match against all messages within a thread (not just titles), added cross-thread message search across every thread grouped by "In this thread" vs "Messages in other threads", with debounced input (200ms) and auto-scroll to the matching message on selection.
- Extracted search matching logic into a testable module with focused unit coverage and removed the `mod+shift+f` search toggle from chat keybindings (search is now accessed exclusively through the command palette).

### Document and URL Attachment Extraction

- Added shared attachment extraction for PDF, DOCX, PPTX, and XLSX files with OCR fallbacks for images and scanned PDFs, and added a `server.readDocumentUrl` RPC backed by a remote URL reader with arXiv/IACR normalization — so uploaded documents and links are readable regardless of format.
- Added a "Read document or URL" dialog in the composer with multi-file staging and per-file removal; provider prompt assembly now appends OCR text as supplemental context while keeping original images intact.

### Pi Provider Windows Shell Safety

- Added `shell: true` on Windows for local Pi RPC process spawns to resolve CVE-2024-27980 EINVAL errors, with a `killPiChild` helper using `taskkill /T /F` to avoid orphaned process trees, and expanded tests from 1 to 7 covering shell behavior and stop semantics.
- Centralized the Windows shell logic into `Cli.ts` with reusable `shouldUseWindowsPiShell()` and `quoteWindowsPiShellCommand()` helpers, replaced duplicated inline `shell: process.platform === "win32"` checks, and added path-with-spaces quoting to prevent truncation when `.cmd` paths contain spaces.
- Extracted `describePiExit()` and `isPiRpcResponse()` into companion modules (`RpcProcess.errors.ts`, `RpcProcess.message.ts`) to keep `RpcProcess.ts` under the 400-line limit, and added regression tests for quoted space-in-path `.cmd` and shell-free `.exe` paths on Windows.
- Integrated upstream relay worker fixes from the codex relay-managed-tunnels-auth-infra branch, including secret binding preservation, HTTP trace export, and simplified observability configuration.

### Sidebar and Layout Polish

- Refined sidebar accordion layout and spacing for a more consistent, less cramped appearance.
- Tuned shared Input and Textarea focus styling to remove the overly shiny halo.
- Reduced resize-time “white bar” flashes by explicitly setting renderer root backgrounds and syncing the Electron `BrowserWindow` background color with the active light/dark theme.

### Validation

- Validated this window with `bun fmt`, `bun lint`, and `bun typecheck`.
- Added focused Vitest coverage for document extraction (OCR, office, URL), Pi RPC process shell and path-quoting regression tests, and sidebar/layout UI behavior.

## v0.1.637 (29 May, 2026)

### Linux Desktop Reliability

- Overhauled the desktop runtime to survive GPU crashes, missing Electron files, and rough startup conditions without going silent. The app tracks GPU process failures and automatically disables hardware acceleration on the next launch so you are not stuck in a crash loop.
- Fixed a launch deadlock where AppImage backend restarts could re-enter the outer AppImage runtime instead of the in-image executable, and added an after-extract hook that copies critical Electron binaries into the packaged app when electron-builder drops them.
- Locked Linux builds to `ubuntu-22.04` for broader AppImage compatibility, added a `.deb` package as a fallback, and wired up a verification pipeline that checks runtime files and smoke-tests the packaged backend before release.

### Desktop Crash Safety

- Added uncaught exception and rejection handlers so the main process logs what went wrong and shows a dialog instead of disappearing. Pipe errors from a dying backend child (ECONNRESET, EPIPE) are now swallowed gracefully instead of taking down the whole app.

### Provider Model Discovery

- Switched Claude and Codex from hardcoded model lists to live discovery from `claude query` and `codex app-server` at startup, so new models appear without waiting for a client update. Bumped the Codex default from `gpt-5.3-codex` to `gpt-5.5`.
- Replaced PIs inline provider name map with a shared normaliser that resolves aliases like `open-ai` → OpenAI and `google_gemini` → Google consistently across all providers.

### CI and Build Tooling

- Pinned `electron-builder` resolution to the local package before falling back to bunx for reproducible CI builds. Re-enabled the typecheck step in the release workflow.
- Skipped AppImage smoke tests in headless CI environments and fixed an `afterExtract.cjs` type check that broke on electron-builder versions that pass platform as a string.

### Validation

- Validated this release window with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused Vitest coverage for Linux runtime startup, provider model discovery, and shell environment hydration.

## v0.1.636 (26 May, 2026)

### Composer Redesign

- Replaced the standalone attach paperclip button with a compact `+` menu that bundles file uploads, agent calls, and skill usage into one clean entry point, so you can add files, summon an agent, or browse skills from the same spot without hunting for separate buttons.
- The `+` menu lets you add an agent or skill anywhere in the middle of what you are typing, not just at the very start of a message like the old `/` commands required.
- Simplified the composer footer to always stay compact — Build, Access, and Plan mode controls are now tucked behind a `...` overflow menu instead of taking up space when they are not needed.
- Increased the slash-command menu height so large skill lists are easier to browse without scrolling.

### Skill and Agent Discovery

- Fixed the composer skill menu so `/skill` and `/skills` now show the same results instead of different counts, and added live skill and agent totals (e.g. "Browse discovered skills (78 total)") to slash-command descriptions so you know what is available before opening the menu.
- Fixed skill discovery for Cursor's dedicated `.cursor/skills-cursor/` folder and OpenCode's JSON-format agent config files, so those skills and agents appear reliably in the picker.
- Added diagnostic logging to catch silent discovery failures, making it easier to troubleshoot when expected skills do not show up.

### Streaming and Scrolling

- Fixed a bug where a focused message could keep flashing and scrolling into view during active AI streaming, making it hard to keep reading new content while a specific message was highlighted.

### Git Branch Toolbar

- Replaced the standalone "New project" button in the branch toolbar with a full project dropdown menu that shows the current project name, recent threads for quick navigation, a full project switcher, and an "Add new project" option — so you can switch projects or jump to a recent thread without leaving the toolbar.
- Tightened the branch selector chevron icon sizing for a more consistent toolbar look.

### Validation

- Validated this release with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused integration test coverage for multi-provider skill discovery, Cursor and OpenCode agent parsing, and JSON nested config scenarios.

## v0.1.635 (22 May, 2026)

### Thread Branching

- Added the ability to fork a thread from any user or assistant message, so you can branch a conversation at a specific point instead of only copying the full history.
- Renamed all thread forking terminology to branching across the UI for consistent language, including sidebar actions, context menus, toasts, and tooltips.
- Extracted a shared `MessageBranchButton` component and added focused test coverage for branch button display and edge cases.

### Terminal Stability

- Fixed a terminal flickering bug that caused the xterm instance to remount on every composer keystroke, and added autofocus guards so the terminal no longer steals focus while you are typing in the composer.

### Marketing and Social

- Refreshed the Open Graph image and Twitter card preview with a dedicated social preview graphic, and updated the download page screenshot to a light-theme workspace view.

### Remote SSH

- Improved remote SSH authentication handling by shortening password-auth control socket paths to fit within macOS socket limits, added a regression test for long SSH execution target IDs, and clarified in the remote project dialog that leaving the key path blank uses agent or default identities.

## v0.1.634 (19 May, 2026)

### Desktop Signing and Distribution

- Added full macOS code signing and notarization to the CI release workflow via certificate-based import and an explicit `@electron/notarize` hook, disabled the app-sandbox entitlement, and fixed entitlements path resolution so packaged `.dmg` builds are properly signed, notarized, and launch without sandbox restrictions.
- Added beta download links with a dynamic release-source selector on the marketing site and made the home page download button platform-aware so visitors receive the correct artifact for their OS.

### Browser Panel

- Fixed a double-click link navigation bug in the browser panel so rapid clicks reliably navigate to the intended URL instead of dropping the second navigation request.

### File Access Permission System

- Added a first-launch file access permission dialog and a dedicated Settings section that let macOS users choose between unrestricted access or scoped common-folder access, with per-folder status indicators, reset controls, and a direct link to macOS System Settings.
- Added persistable client settings (`fileAccessPermissionLevel`, `hasSeenFileAccessPrompt`) and a DesktopBridge IPC channel for requesting and reporting folder-level access from the Electron main process.

### Developer Tooling

- Removed the deprecated `--parallel` flag from the dev-runner's `MODE_ARGS` for `dev` and `dev:desktop` modes, since `persistent: true` in `turbo.json` already handles concurrent task execution and `--parallel` has been deprecated upstream.

### Validation

- Validated this release window with `bun fmt`, `bun lint`, and `bun typecheck`, plus focused checks on the macOS signing and notarization workflow, dev-runner unit tests, and file access permission dialog behaviour.

## v0.1.628 (18 May, 2026)

### Remote Projects and Reconnects

- Added first-class remote project support, so you can connect bigbud to a project over SSH and work with it without having to keep the whole AI runtime on the remote machine.
- Added remote-project support across Pi, Codex, OpenCode, Claude, and Copilot, with clearer handling when a provider or runtime combination is not supported.
- Added a more complete remote project setup flow, including provider runtime selection when creating a remote project.
- Added safer reconnect behavior for remote projects so, after restart, saved remote workspaces stay disconnected until SSH access is verified again instead of appearing ready and failing later.
- Added verification checks across the main remote actions, including opening projects, activating threads, starting turns, opening terminals, and creating draft threads, so remote work resumes only after access is confirmed.
- Added password-based SSH reconnect alongside SSH key unlock, using the same temporary in-app unlock flow without saving secrets.

### Realtime Speech to Text

- Switched voice transcription to the current OpenAI Realtime transcription session flow instead of the older transcription path.
- Simplified speech-to-text model selection to the supported realtime model, `gpt-realtime-whisper`, and reset older saved STT values so they do not leak into the new flow.
- Improved failure feedback so microphone or transcription problems now surface as clearer composer toasts without repeating the same alert over and over.

### Provider Reliability and App Startup

- Fixed a GitHub Copilot prompt bug where clarification requests could get stuck waiting for input instead of resuming the active turn.
- Completed the remaining Copilot remote-workspace wiring so Copilot can follow the same local-runtime remote-project model as the other supported providers.
- Replaced the old startup shell loading treatment with a dedicated splash screen and short fade-out transition so launch feels cleaner and less visually noisy.
- Fixed a provider settings model row key collision that caused duplicate React key warnings when a provider like Pi or OpenCode exposed the same model slug from multiple sub-providers.
- Stabilized Pi RPC lifecycle and chat streaming to reduce session drops and improve turn reliability.

### Branding

- Updated the product identity from Alpha to Beta across the entire application surface, matching the current maturity of the runtime.

### UI Polish

- Changed the command palette shortcut from `mod+k` to `mod+p` and centered its dialog layout for better discoverability and focus.
- Reduced sidebar icon sizes and switched to diagonal pin icons for a cleaner, more compact sidebar appearance.

### Skill and Agent Discovery

- Expanded discovered-skill support so the app now respects friendly skill titles from `SKILL.md` while preserving canonical skill names for invocation, which makes Pi, OpenCode, and other shared skill directories render much more cleanly in the UI.
- Added Cursor skill discovery using the documented `.cursor/skills` roots alongside the existing shared and provider-specific skill locations, and kept recursive `SKILL.md` scanning so nested skill directories continue to work.
- Improved `/skills` browsing so partial command input like `/sk` now enters the skill discovery flow earlier instead of staying in the generic slash-command list.
- Refined the `/skills` and `@agent` suggestion menus to show name, provider, and a short inline description more clearly, with a top-positioned tooltip for the full details on hover.

### Validation

- Added focused server, unit, and browser coverage for remote project routing, SSH reconnect and verification flows, Copilot prompt recovery, and the new realtime voice transcription handshake and error handling paths.
- Revalidated recent work in this window with `bun fmt`, `bun lint`, targeted Vitest and browser runs, and `bun typecheck`.

### Maintainability

- Refactored multiple oversized TypeScript modules across the server to stay at or under 400 lines per file, including the WebSocket RPC router, GitManager pull-request and stacked-action flows, GitStatus detail readers, thread-turn start decider, UI store, OpenCode event mapping and version checks, shell WebSocket dispatch, and dev-runner orchestration projector.

## v0.1.625 (14 May, 2026)

### Conversation Flow and Context

- Added inline replies for both your messages and AI messages, with a compact quoted preview in the composer and in chat so follow-up questions can point to a specific earlier message.
- Carried reply context all the way through the app, including reconnects and restarts, so the AI can still understand what you replied to instead of losing that reference mid-conversation.
- Fixed live-update gaps that could make new messages or deleted threads appear only after a reload.
- Corrected timeline ordering so visible thinking or work steps appear before the final answer when they land at nearly the same time.
- Improved first-message thread titles by seeding better fallback titles and retrying weak AI-generated titles instead of leaving chats with vague placeholders.

### Thinking and Response Visibility

- Improved streamed thinking visibility across supported AI services so reasoning updates appear more consistently instead of leaking into the wrong part of the conversation.
- Made the `Stream thinking` setting apply end to end, so hidden thinking stays hidden and visible thinking gets its own cleaner layout when enabled.

### Sidebar and Organization

- Added a new pinned section in the sidebar so you can keep up to five important chats easy to reach without changing where those chats belong.
- Split sidebar search into its own section, kept pinned chats out of numbered quick-jump ordering, and preserved the pinned section's open or closed state across reloads.

### Approvals and Session Reliability

- Reworked approval prompts so they stay tied to the chat they came from instead of pulling you into another thread automatically.
- Added clearer approval context, including the source chat, project, and folder, plus an explicit action to open that thread when you want to inspect it.
- Tightened approval availability so session-level approval controls are shown only when the connected AI service actually supports them.
- Hardened OpenCode session handling so prompts recover more gracefully from broken transport state and stream results more reliably.

### Validation

- Added focused unit, integration, and browser coverage for replies, thinking visibility, title generation, sidebar pinning, approvals, and OpenCode session recovery.
- Revalidated this work with `bun fmt`, `bun lint`, `bun run test`, and `bun typecheck`.

## v0.1.624 (13 May, 2026)

### Runtime and Thread UX Reliability

- Preserved thread session state more aggressively when a provider turn starts, keeping sessions marked `running` with the active turn id even when provider session updates lag behind the send operation.
- Avoided creating empty assistant messages when providers complete without yielding any assistant text.
- Switched assistant streaming to the default delivery setting, added immediate UI flushing for streaming assistant message events, and extracted orchestration-event coalescing helpers into a shared route helper module.
- Added deterministic fork-title suffixing like `(A)`, `(B)`, and `(AA)` for branched threads, updated the sidebar fork icon, and added focused coverage for fork title generation.
- Added a close action to the diff panel and tightened a few scroll/terminal action state updates to reduce redundant UI churn.

### Chat Shell Commands

- Added bang-prefixed shell mode in the chat composer so quick commands like `!ls` can run directly from the chatbox without opening the in-app terminal.
- Introduced a dedicated `thread.shell.run` orchestration command and server-side shell dispatch path that resolves cwd from the thread worktree, project folder, or `defaultChatCwd` fallback for chat-only threads.
- Moved chatbox shell execution onto the hidden PTY path so interactive shell startup state, aliases, and per-thread working-directory changes behave much closer to the in-app terminal.
- Added streamed shell output with automatic promotion from normal chat results into a bounded live-tail view for long-running commands like `docker compose up`, preventing unbounded message growth while still surfacing current logs in chat.

### Provider and Model Routing

- Added native Cursor-backed git text generation routing instead of falling Cursor requests back to Codex.
- Normalized Cursor model options against capability metadata and exposed Cursor-specific model options throughout the app's provider selection helpers, which also covers desktop builds because the desktop shell embeds the shared web UI.

### Settings Navigation

- Split Settings into dedicated routed sections for `Notifications`, `Providers`, `AI`, `Keybindings`, `Archive`, and `About` instead of keeping most controls under a single general page.
- Moved AI-specific controls, including assistant streaming and text-generation model settings, into a new AI section alongside speech-to-text configuration.

### Provider Structure

- Reorganized server-side provider layers and services into per-provider directories so the filesystem layout now matches runtime ownership for Claude, Codex, Copilot, Cursor, OpenCode, and Pi.
- Folded Pi provider cleanup into the same refactor by splitting session-control logic into its own module and adding focused Pi adapter tests for methods and stream handling.

## v0.1.623 (11 May, 2026)

### Sidebar Threads

- Fixed the project sidebar's `See more (N)` thread count so it now reflects the full hidden thread set instead of a stale locally previewed subset.
- Removed duplicate per-project preview/counting logic and aligned project thread expansion with the shared sidebar rendering state, which keeps the count correct after deleting hidden project threads.
- Confirmed recent chats were already counting hidden threads from the full rendered recents list, so no matching recents fix was needed.

### Deletion Reliability

- Routed `project.delete` through the same staged server-side deletion workflow as thread deletion, so live child threads are stopped and deleted before the project is finalized.
- Moved thread and project cleanup guarantees behind the server lifecycle, including provider shutdown, terminal teardown, and browser cleanup before final deletion events are emitted.
- Delayed orphaned worktree removal until the client observes the final `thread.deleted` result instead of deleting files optimistically after the initial request.
- Corrected thread deletion lifecycle timestamps so `thread.delete.finalize` and `thread.delete.abort` now record the actual cleanup completion time rather than the original request time.

## v0.1.622 (11 May, 2026)

### Marketing

- Removed the marketing download page's client-side release cache so it always fetches the latest published GitHub release metadata on load.
- Fixed a stale-version issue where the download UI could keep showing and linking an older release like `v0.1.620` after a newer release such as `v0.1.621` had already been published.

### Validation

- Validated this release metadata fix with `bun fmt`, `bun lint`, and `bun typecheck`.

## v0.1.621 (11 May, 2026)

### Reliability

- Fixed a broken OpenCode turn path where the app could emit `turn.started` and then appear to hang because the current OpenCode `promptAsync` flow returned without producing follow-up session events.
- Switched OpenCode turn execution to a background `prompt` flow and mapped the final response back into canonical runtime events so completions, token usage, and upstream provider failures are surfaced predictably again.
- Made the PDF extraction test self-contained by generating a valid PDF fixture instead of depending on a user-specific local file path.

### Validation

- Recent work in this window included validation with `bun fmt`, `bun lint`, `bun run test`, and `bun typecheck`, plus focused provider verification for the OpenCode fix.

## v0.1.620 (11 May, 2026)

### UI and Marketing

- Refined the marketing site structure and presentation, including the new changelog page, updated homepage/download layouts, and shared layout cleanup.
- Added a few app-facing polish changes, including route-aware page titles and minor branding cleanup.

## v0.1.619 (5 May, 2026)

### Thread Forking

- Added thread forking capability so users can branch conversations from any point in a thread's history.
- Implemented seed message preparation that filters streaming messages, caps at 200 messages, and maps to the server's thread creation format.
- Added fork action to thread row menu with UI integration in the sidebar.

### Session Reasons

- Added `reason` column to `projection_thread_sessions` table for storing session descriptions or context.
- Updated projection pipeline, snapshot queries, and persistence layers to support session reasons.

### Document Text Extraction

- Added text extraction from PDF and DOCX files as first-class attachments.
- PDF extraction uses the system's `pdftotext` binary (Poppler) for robust CID-keyed font handling.
- DOCX extraction uses the `docx` library for parsing Word documents.
- Normalizes extracted text (whitespace, line breaks) and truncates to 32,000 characters.

### Browser Panel Coordination

- Added browser/diff panel coordinator to ensure only one right panel is open at a time.
- Closes diff panel when opening browser panel and vice versa.
- Integrated panel state coordination with the browser panel store.

### Provider Updates

- Refined OpenCode provider session handling and event mapping for better answer flow compatibility.
- Improved Pi adapter session helpers and method handling.

### Validation

- Added focused tests for OpenCode event mapping, document text extraction, browser panel coordination, thread fork seed preparation, and provider command reactor handlers.
- Validated with `bun fmt`, `bun lint`, `bun run test`, and `bun typecheck`.

## v0.1.618 (2 May, 2026)

### Embedded Browser Link Handling and Annotation Controls

- Routed chat-rendered links and shared in-app `openExternal` actions through the embedded browser panel instead of sending them straight to the system browser.
- Added an explicit address-bar action for opening the current embedded page in the user's default external browser.
- Synced the browser panel's local address/navigation state with store-driven URL changes so clicking links reliably navigates the embedded browser to the requested page.
- Forced embedded-browser popup and new-tab attempts into the current tab where possible, while tightening the iframe fallback so it does not spawn separate popup windows.
- Replaced browser toolbar native tooltips with the app's shared tooltip component so browser controls match the rest of the UI.
- Improved browser annotation mode so it behaves like a real toggle, supports cancel via repeated click and `Escape`, and keeps its active-state styling in sync with the current annotation session.
- Fixed browser annotation capture so screenshots exclude the floating annotation panel while preserving the selected-element highlight, keeping the image aligned with the captured element metadata.

### Browser Annotations in Composer and Chat

- Refactored browser annotations into first-class composer draft attachments instead of dumping their full metadata directly into the prompt editor as soon as they are created.
- Preserved normal screenshot image attachments for annotations while storing the selected element metadata separately so the composer stays compact and easier to edit.
- Appended the full annotation metadata back into the outgoing user message only at send time so providers still receive the complete page, viewport, and selected-element context.
- Added annotation draft persistence and normalization so browser annotations survive reloads alongside the rest of the composer draft state.
- Added a grouped annotation attachment pill in the composer, with structured annotation cards in its details view and an inline remove action that clears the linked annotation screenshots as well.
- Updated sent user messages so annotation metadata is rendered as a compact attachment-style disclosure in chat instead of a raw block of visible prompt text.
- Matched annotation pills in both composer and chat to the existing neutral document/file attachment styling while keeping the annotation icon blue for recognition.

### Validation

- Added focused unit and browser-mode tests for embedded-browser link routing, browser toolbar actions, and annotation mode lifecycle and capture helper behavior.
- Added focused tests for composer annotation attachment styling and removal, sent-message annotation rendering, annotation prompt formatting, persisted composer annotation state, and browser-annotation parsing behavior.
- Revalidated the repo with `bun fmt`, `bun lint`, `bun run test`, and `bun typecheck`.

## v0.1.615 to v0.1.617 (27 April, 2026 to 1 May, 2026)

### Browser Workspace and Navigation

- Added an embedded browser panel inside the chat workspace, with back, forward, reload, close, and address controls, plus a keyboard shortcut for quickly opening and closing the panel.
- Added browser-side page actions so provider-driven browser work can plug into the app more naturally.
- Added browser annotations so selected page elements and screenshots can be sent into the composer as working context.
- Added browser history with global deduplication, page title tracking, favicon tracking, and suggestion dropdown behavior so revisiting recent pages is faster and less noisy.

### Speech to Text

- Added Speech-to-Text voice dictation powered by OpenAI's Realtime Transcription API.
- Implemented microphone capture with an `AudioWorkletNode`, streaming audio directly from the client to OpenAI instead of routing it through the bigbud server.
- Added settings for API key and transcription model selection, plus composer UI states for recording, listening, and voice-only input.
- Added desktop permission handling and entitlement changes needed for microphone access on Electron builds.

### Provider and Runtime Reliability

- Adapted upstream reliability fixes into bigbud's current architecture instead of copying upstream modules directly.
- Hardened Claude and OpenCode structured question/answer flows so newer SDK answer-key behavior continues to map correctly into bigbud UI state.
- Improved Codex runtime compatibility with newer event names, child-conversation routing, turn policy handling, and transcript event mapping.
- Refined provider session lifecycle handling so stale sessions are cleaned up more predictably when switching providers.
- Reworked provider registration into a more data-driven shape to make the registry easier to maintain while preserving bigbud's provider model.
- Normalized persisted composer model selections so upstream-style option arrays and Cursor option data are preserved correctly across reloads and migrations.
- Guarded WebSocket lifecycle updates against stale transport callbacks after reconnects, reducing incorrect disconnected/error regressions.

### Sidebar, Search, and Thread Navigation

- Moved the `Search` action into the sidebar above `Chats`, matched its section typography and spacing, and aligned the visible icon sizing with the surrounding sidebar controls.
- Removed the misplaced search action from the chat header.
- Fixed recent-thread jump behavior so only the first visible recent chats consume numbered jump slots before project threads.
- Corrected `See more` handling so hidden recent chats no longer steal thread-jump positions.
- Improved mobile sidebar behavior by closing or keeping focus in the right places after thread, project, and archive actions.

### Model Picker and Composer UX

- Added recently used models per provider so each model picker can surface the most relevant recent choices first.
- Added search by sub-provider group name in the model picker so typing vendor labels like `Anthropic` or `Gemini` finds matching models quickly.
- Reduced duplicate entries and tightened recent-model normalization so provider pickers behave more consistently.
- Polished compact toolbar controls and related chat header actions.

### Desktop Update and Unsigned Build Workflow

- Improved runtime code-signature detection for macOS and Windows builds.
- Fixed auto-update behavior for unsigned builds and added timeout recovery for silent install failures.
- Added clearer UI feedback when a downloaded desktop update must be installed manually.
- Added manual install guidance in Settings for unsigned builds, including platform-specific commands and copy support.
- Disabled macOS code signing fully for unsigned builds so packaging no longer fails during `preAutoEntitlements` fallback behavior.

### Desktop Clipboard and Permissions

- Fixed copy-to-clipboard in the desktop app by routing clipboard writes through DesktopBridge IPC instead of relying on renderer clipboard permissions.
- Preserved normal browser clipboard behavior for the web app while avoiding Electron sandbox permission fallout.

### Visual and Theme Refinements

- Swapped brand-heavy blue accents for more neutral primary theme tokens while keeping informational blue for status-oriented UI.
- Updated activity indicators so agent-working states still read clearly after the theme token shift.

### Git, PR, and Terminal Improvements

- Hid merged or closed PRs from branch status when viewing the default branch to reduce stale PR context.
- Prevented non-approval user-input activities from creating pending approval projection rows.
- Relaxed terminal dimension validation so compact terminal layouts are accepted while still enforcing sane limits.

### Provider SDK and Dependency Updates

- Updated major provider SDK dependencies, including Claude, Copilot, OpenCode, and Pi, to stay aligned with current provider behavior.
- Adjusted Copilot approval mapping for newer SDK request and decision shapes.
- Updated bundled Pi support again, moving `@mariozechner/pi-coding-agent` from `0.70.2` to `0.71.1` after confirming the current Pi RPC integration path remained compatible.

### Documentation and Planning

- Added the browser integration planning document under `docs/browser-integration-plan.md` to capture the intended Chromium/browser workflow direction.
- Added this `docs/CHANGELOG.md` so the recent cross-branch development work has a documented narrative instead of being discoverable only through commit history.

### Validation

- Recent work in this window included repeated validation with `bun fmt`, `bun lint`, `bun typecheck`, and targeted Vitest coverage where behavior or provider/runtime handling changed.
