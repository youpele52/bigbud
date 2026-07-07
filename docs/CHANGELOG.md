# Changelog

Every bigbud release, in one place. New features, thoughtful improvements, and hard-won bug fixes — all documented here so you can follow the product as it grows. Jump to the latest release below, or browse the full history.

## v0.1.652 (8 July, 2026)

### Plans

- Replaced the old plan sidebar with a floating **Plan** card that stays closer to the active conversation while still showing current steps and proposed plans.
- Added plan-card actions for copying a proposed plan, downloading it as Markdown, or saving it straight into the current workspace.
- Mapped OpenCode native `todo.updated` events into bigbud's shared plan-update flow so task progress stays in sync for OpenCode and KiloCode sessions too.

### Desktop

- Added a macOS-only **Window Material** preference under **Settings → General** with **Automatic**, **Solid**, and **Translucent** options, plus native desktop wiring and matching translucent app chrome so the change applies immediately.
- Fixed packaged macOS app icon handling so installed builds resolve the bundled icon correctly and stop overriding the Dock icon at runtime, keeping the running and closed app icons consistent.

### Usage

- Localized **Usage** chart tooltip dates and month labels so activity reads naturally in your own locale instead of falling back to raw timestamp-style formatting.
- Updated the Usage overview cards to reuse provider and model icon patterns already used elsewhere in the app, including a safe fallback icon when a provider is unknown.
- Renamed the Usage breakdown view toggles from **Bars** and **Pie** to **Ranking** and **Share** for clearer at-a-glance comparison.

## v0.1.651 (7 July, 2026)

### Orchestra

- Added **Orchestra** from the composer and quick-actions menus: set a score name, choose multiple players with their own provider/model and cue, then press **Play** to launch each part as its own child thread.
- Orchestra can run players **together** or **in sequence**. Sequential runs use handoff between child threads so each next player receives a clean summary from the previous one instead of a raw transcript dump.
- Orchestra runs now create a fresh parent score thread automatically, so you no longer need to start a normal chat first. Child thread titles are prefixed with the score name so related runs are easy to spot in the sidebar.
- Orchestra keeps the setup dialog aligned with the actual launch state, so once child threads are created the run moves forward cleanly instead of inviting duplicate retries.

### Usage

- Added a local **Usage** dashboard under **Scheduled** in the sidebar, with 24h, 7d, 30d, and All ranges for reviewing token usage stored on this device.
- Usage now shows total tokens, top provider, top model, streak, time-series token activity, token mix, and provider/model breakdowns with bar and pie chart views.
- Added plain-language token explanations for cached, input, output, and reasoning tokens, plus a note that provider token counts are directional rather than billing-accurate.

### Thread Reader

- Added **thread elevator summaries** across contracts, projections, title generation, and the sidebar so longer threads can surface a compact, readable summary where a title alone is not enough context.

### Handoff

- Added server-side **handoff jobs** and RPC plumbing so handoff document generation can run as a tracked background workflow instead of blocking the active chat surface.
- Switched chat handoff flows to background branch jobs, keeping the dialog responsive while branch setup and handoff generation continue behind the scenes.

### Terminal

- Added contextual terminal labels and provider icons so terminal tabs now read like the active project or directory instead of generic terminal slots.
- Added **bold drag-and-drop support** for file and folder paths into the terminal, and made dropped paths shell-aware across local and remote sessions so Windows shells, PowerShell, WSL, MSYS, and SSH-backed terminals receive the right format instead of a one-size-fits-all string.
- Added terminal rename overrides and storage-aware refresh handling so terminal labels stay useful even after the underlying workspace, note, or kanban storage root changes.

### Quick Actions

- Generalized the Git actions control into a broader **Quick actions** menu, making room for non-Git actions like Orchestra while preserving the existing Git workflows.

### Remote Access

- Split remote access checks into foreground and background flows so the app can keep the UI responsive while remote execution status continues to resolve in the background.

### Provider Orchestration

- Hardened provider orchestration bridges and OpenCode runtime handling, including safer MCP bridge session behavior, thread-tool response handling, and runtime SDK resolution.

### Agent & Skill Discovery

- Tightened discovery watch-path fallback logic so missing optional provider folders no longer cause broad parent directories to be watched unnecessarily.

### Startup

- Reduced first-turn startup blocking in server bootstrap so new sessions can begin sooner while the rest of the thread plumbing finishes wiring up.

### Desktop

- Unified the macOS open and closed desktop app icons so packaged and running states now stay visually consistent.
- Cut duplicate desktop runtime payloads from the build pipeline to shrink the app package and keep the runtime artifacts leaner.
- Fixed desktop packaging so bundled native skills are included in generated artifacts.

### Maintenance

- Removed stale remote-access and planning documents that no longer matched the current codebase.
- Split web composer, notes, terminal, and RPC client logic into smaller modules to keep the codebase easier to navigate and maintain.
- Split backend contracts and server helpers into focused modules to reduce file size and keep the server-side architecture easier to reason about.

## v0.1.650 (2 July, 2026)

### Computer Use (Desktop & Browser Automation)

- Computer Use permission dialogs, settings descriptions, and toast notifications now use **platform-aware copy** — the text automatically reflects macOS, Windows, or Linux instead of always saying "macOS". The macOS-specific "System Settings" permission-manager row is hidden on non-mac platforms.

### Thread Reader

- Redesigned the **transcript outline** — click any segment in the dot strip to jump directly to that turn, or double-click to open a full menu of all user turns for quick navigation. Hovering over a segment now shows a label preview tooltip, and each segment's width adapts based on proximity to the cursor and whether it represents the current turn, making it easier to target the right spot.

### Chat Mentions

- Agent and skill mentions in **user message bubbles** are now openable directly from the timeline when a source file can be resolved.
- Mention source resolution is now **ambiguity-safe** — if multiple possible source files match the same mention, bigbud avoids opening the wrong file.

### Orchestration Thread Tools

- Hardened Codex and OpenCode thread-tool wiring with a **dynamic fallback path** for orchestration calls, so rename, archive, status, and computer/browser actions stay bound to the correct thread context even when MCP namespace discovery is unavailable at startup.
- Thread-tools authorization now better separates **caller-thread authentication** from **target-thread status lookup** for `get_status`, while keeping mutation operations strictly scoped.
- Updated generated OpenCode and Pi orchestration bridge sources to emit **runtime-safe JavaScript syntax** in executed bridge files.

### Agent & Skill Discovery

- Discovery now **auto-refreshes live** across all supported provider roots (Codex, Claude, Copilot, Cursor, OpenCode, Pi, Devin, KiloCode, bigbud), so adding, editing, or removing agent/skill files is picked up without restarting the app.
- Added a **periodic fallback discovery rescan** to keep catalogs current even if an underlying filesystem watch event is missed.

### Markdown File Viewer

- Markdown preview in the Files panel now **formats YAML frontmatter** for readable in-app display — `---` delimiters render as horizontal rules, YAML keys are boldened, and indentation (non-breaking spaces) preserves the nested structure so metadata is visible without looking like headings.

### Mobile Remote Companion

- Added a **setup guide link** next to the "Enable mobile remote control" switch in **Settings → Mobile Remote** that opens the documentation at bigbud.app/docs for step-by-step pairing instructions.

## v0.1.649 (2 July, 2026)

### Computer Use (Desktop & Browser Automation)

- Added **Computer Use** — AI agents can now reach beyond the chat and work with your applications, browser, and desktop to navigate pages, fill forms, write emails, book appointments, check your calendar, open apps, take screenshots, click, type, scroll, and carry out other tasks — on macOS, Windows, and Linux.
- **Desktop automation is permission-gated** — requires explicit opt-in from **Settings → AI → Computer Use**, macOS Accessibility and Screen Recording permissions, and `full-access` runtime mode for mutating actions. Read-only actions (capture, list windows, list apps, diagnostics) work in any mode.
- **Designed with safety and security as a foundation** — Dangerous key combos and sensitive text patterns (passwords, API keys, credit card numbers, SSNs) are blocked before reaching the driver. Configurable check-in and action timeout limits are exposed under **Settings → AI → Computer Use**, and desktop/browser targets containing sensitive fields are blocked automatically. The managed runtime installer verifies pinned release checksums on every install.
- **Optimistic background setup** — Enabling Computer Use through the permission dialog or settings toggle now triggers the runtime install asynchronously with toast feedback instead of showing a blocking spinner, while macOS permission prompts continue in parallel.
- **Cross-provider support** — All runtime providers (Codex, Claude, Copilot, OpenCode, Pi, etc.) receive computer-use capability instructions in their context, with the tool surfaced through per-provider bridges.

### Orchestration Thread Tools

- Added a **thread-aware MCP bridge** — agents from any provider can rename threads, archive threads, check thread status, and execute computer/browser actions through a unified internal HTTP API (`/api/internal/thread-tools`) with token-based auth.
- **Per-provider tool bridges** — Copilot receives native SDK `Tool` objects; Codex and Claude use a dynamically generated MCP stdio server; OpenCode uses a local command bridge; Pi uses a coding agent extension. All bridges are set up at session start and torn down on disconnect.
- The server prepends computer-use capability instructions into every provider input turn, telling the agent which surfaces are available and how to use them based on current settings and runtime mode.
- Copilot orchestration tool handlers are now verified to bind to the correct thread when multiple Copilot sessions run concurrently.

### Inline Video Preview

- **Video files now play inline** in the Files panel — `.mp4`, `.webm`, `.mov`, and `.avi` files open with native `<video>` controls instead of launching the external browser.
- **HTTP Range request support** — the file-serving endpoint now handles `Range` headers (including suffix ranges) for partial content delivery (`206 Partial Content`), enabling smooth streaming for video and large files.

### Attachment Previews

- Chat messages now render **image attachments as clickable zoomable previews** and **video attachments as inline players**, served through a new `/attachments/<id>` HTTP route.
- Computer-use screenshots captured during a session are displayed inline in the timeline work entries, persisted as file attachments and served by attachment ID.

### Right Panel

- Pressing `Cmd+W` / `Ctrl+W` now closes the **active right-panel tab** (browser, diff, files, git, kanban, notes, terminal) instead of triggering a system-level close event. Respects terminal focus context.

### Files Panel

- Added **Copy relative path** to file and folder right-click menus in the Files panel, so you can grab a workspace-friendly path without trimming the absolute one by hand.
- Reordered the shared file actions to a more predictable sequence — **Select All**, **Open externally**, **Copy relative path**, then **Copy path** where each action applies.

### File Viewer

- Right-clicking an open file now shows the same file actions directly inside the viewer and on the file name breadcrumb, making it easier to open the file elsewhere or copy its path without going back to the tree.

### Working Indicators

- Refined the "working" state across desktop and mobile with a shimmer treatment on the action verb, so long-running agent turns feel more alive and easier to notice at a glance.

### Annotations

- Simplified the annotation composer to a single neutral **comment** intent — removed the Ask / Context / Fix toggle so every annotation surface (file viewer, terminal, browser element, PDF region) shares the same "Comment on selection" flow.
- Annotation panels now **anchor below the selection** when there's room, flip above if the viewport is tight, and fall back to the previous placement — keeping the composer near the content you're annotating.
- Browser annotation technical details (raw CSS selectors, region coordinates) are now hidden behind a compact chevron-toggle instead of a heavy disclosure block, keeping the default view clean.

### Thread Reader

- Added **native reader-position tracking** — the thread view now tracks the scroll anchor between user turns, keeps a `readerPosition` state, and provides `scrollToMessage` / `scrollToUserTurnAnchor` helpers for programmatic navigation.
- Added a **ThreadReaderOutline** — a dot strip overlaid beside the scrollbar gutter that maps every user turn, with a sidebar-matched jump menu for clicking directly to any turn in the conversation.
- Sending a message now anchors the new user turn with a peek of the previous turn, and user messages get a reduced-motion-aware entrance animation.
- Replaced the Popover-based jump menu with a clipped scroll container capped at 50dvh, matching sidebar thread row typography and keeping the scrollbar inside the rounded menu bounds.

### OpenCode

- Fixed OpenCode orchestration tools so they no longer write helper files into your project folders during a session; the runtime now keeps those temporary tool registrations out of the workspace.
- OpenCode orchestration bridges are now **scoped per thread** — each session registers a uniquely named MCP server and only that thread's rename, archive, status, and computer-use tools are enabled, preventing cross-thread leakage when multiple OpenCode sessions run concurrently.
- Session teardown now disconnects the thread-scoped orchestration MCP bridge cleanly.

### Mobile Remote Companion

- Pairing links now **validate the backend origin** — the mobile companion normalizes the `backend` query parameter and shows a clear error when it is missing or malformed, instead of failing silently mid-exchange.
- **Mobile app URL** settings now include a **bigbud / Local** toggle so you can switch between the hosted companion and your local dev server without hand-editing the URL.
- Fixed default mobile companion URL resolution — the production origin (`https://mobile.bigbud.app`) stays separate from local dev overrides, and tailnet backends still default to the hosted companion when appropriate.

### Desktop

- Fixed **Tailscale Serve** status detection to recognize proxy targets with trailing slashes and reject serve configs pointing at a different backend port.
- Fixed **Copilot CLI** invocation inside the Electron desktop app — the node wrapper now launches via the app executable with `ELECTRON_RUN_AS_NODE` on macOS, Linux, and Windows.
- File access and Computer Use permission dialogs now wait until server config has loaded before appearing, avoiding premature startup prompts.

## v0.1.648 (26 June, 2026)

### Mobile Remote Companion

- Added a standalone **mobile web companion** (`apps/mobile-web`) for steering bigbud from your phone — browse chats and projects, open threads, watch live turns, send prompts, interrupt runs, approve or reject pending actions, inspect diffs, and archive threads without the full desktop shell.
- Pair your phone from **Settings → Mobile Remote**: enable scoped mobile sessions, create a pairing link, and authorize the device in the hosted companion. Sessions are short-lived, scope-limited (`read-only`, `approve-only`, or `thread-control`), and can be revoked immediately from desktop.
- The hosted companion and desktop backend stay intentionally separate — configure the **Mobile app URL** (for example `https://mobile.bigbud.app`) and a reachable **Backend URL** so the phone can pair over the same network or, with **Tailscale Serve**, from another Wi-Fi on your tailnet.
- Added **live message streaming** in the mobile thread view — user and assistant text updates in real time as domain events arrive, with incremental cache updates and streaming markdown rendering so you can follow a turn without leaving the chat.
- Added **project and git context** below the mobile composer on git-backed projects — folder icon with project name on the left and the current branch on the right, aligned with the desktop chat footer.

### Kanban

- Added a **Kanban** right-panel tab after Notes with Backlog, Todo, Ongoing, and Done columns for lightweight task tracking alongside your chats.
- Boards can be **global** or **project-scoped**, with markdown-backed cards and JSON sidecars so they persist across restarts and stay in sync with the filesystem.
- Drag cards between columns or within a column to reorder, drag them into the composer to write, flesh out, or even carry out the task with the agent, manage them from a context menu, and collapse columns when you want a denser view.

<iframe src="https://www.youtube-nocookie.com/embed/R0WvKJjY62Q" title="bigbud: Using bigbud's Kanban board"></iframe>

### Files Panel

- The Files panel now opens images and HTML files in the **Browser** by default, and right-clicking either shows **Open in file viewer**, **Open in browser**, **Open externally**, and **Copy path**.
- Supported files and external directories can now open inside bigbud even when they live outside the current project or worktree; the panel temporarily roots itself to that path and shows the full absolute path in the header.
- Fixed stale file trees and previews after workspace changes by broadening directory refreshes, keeping subscriptions stable during reloads, and waiting briefly before reloading changed previews so saved content is on disk first.

### Thread References

- Added drag-and-drop thread references — drag a thread from the sidebar into the composer to attach it as context. The server resolves the referenced thread at send time, inlines its full transcript inside an `<attached_threads>` block, and strips thread references from the provider attachment list.
- Thread references are deduplicated by thread ID, shown with a dedicated `MessageSquare` chip in the composer and message timeline, and the timeline chips are now clickable so you can jump straight to the referenced thread.
- Referenced threads are not just passive context: you can ask the agent to inspect them and act on them, including renaming the referenced thread when needed.
- Excluded thread-reference metadata from title and branch-name generation, and added a server-side `exportThreadContext` RPC behind the sidebar **Copy path** action without exposing an editable file to the agent.

<iframe src="https://www.youtube-nocookie.com/embed/Y6cBo1jKA24" title="bigbud: Thread-aware agents — drag & drop threads into AI context"></iframe>

### Notes

- Note filenames are now stable — new notes use a creation-time datetime stem (for example `2026-06-23-14-30-00.md`) instead of the H1 title, so editing a note no longer renames the file or changes its `noteId`. Existing notes keep their current filenames, and display titles still come from content.
- Fixed note and file path references dragged into the composer so the AI now receives the actual file contents as a proper attachment instead of just the raw path text.
- Improved note readability and visual consistency: preview headings now match the markdown file viewer hierarchy, and edit mode now uses the same background treatment as the raw markdown viewer.

<iframe src="https://www.youtube-nocookie.com/embed/DPceRqM3Sis" title="bigbud: Writing notes like a Pro"></iframe>

### Terminal

- Added **Annotate selection** to the terminal text-selection menu alongside **Add to chat**, using the same Ask / Context / Fix composer flow already available in the file viewer, diff panel, and browser.
- Fixed terminal refitting on panel resize so wrapped lines reflow correctly after sidebar and layout changes.

### Observability

- Provider event logs in `~/.bigbud/{userdata,dev}/logs/provider/` are now development-only, so production builds no longer accumulate verbose native and canonical trace logs on disk.
- On startup, provider log files older than 7 days are automatically pruned from both runtime profiles.

### Right Panel

- Fixed desktop drag-region issues that made right-panel menus, popovers, and draggable tab wrappers partially unclickable over the Git, Terminal, and Files headers.

### Desktop

- Local and development desktop builds now use a distinct inverted bigbud icon so you can tell dev and packaged installs apart at a glance.

## v0.1.646 (20 June, 2026)

### Teach Skill

- Introduced the curated native **teach** skill (by [mattpocockuk](https://x.com/mattpocockuk)) — type `/skills teach` followed by a topic (like "photography" or "budgeting") to start a guided, multi-session learning journey that saves your progress and picks up where you left off.
- Each subject you learn gets its own project folder under `<default-chat-folder>/bigbud-learn/`, keeping missions, lessons, and reference materials organised so you can switch between topics without losing your place.
- Added a **Learning projects** section in Settings that shows all active projects and their locations, with a button to open the learning folder in your file manager.

### Automations

- Added **Automations** — schedule recurring AI work on any thread using cron expressions, accessible from the sidebar action row or the dedicated `/automations` list page, with a floating composer for creating new schedules.
- Each automation has its own detail page for editing the schedule, prompt, and target thread, with pause, resume, delete, and **Run now** controls that surface success and error toasts.
- Scheduled and manual runs execute through the same orchestration flow as chat turns, appear in the target thread's timeline, and maintain an inspectable run history on the detail page.
- The background scheduler tracks runs atomically, reconciles stale work on startup, and completes runs from provider terminal events — navigating to an automation page closes the right panel and restores your chat thread when you leave.

### Browser and PDF Preview

- Added support for opening workspace PDF files in the Browser's native PDF viewer, so opening a `.pdf` from the Files panel or an internal file link now uses the browser's built-in PDF rendering instead of treating it like a text file.
- Desktop PDF preview now uses the browser's native PDF viewer directly for better compatibility across supported platforms.
- Multiple PDF files can now be opened in the Browser at once, up to the existing five-tab limit, without closing the current document.
- Added PDF region annotations in the Browser, with tightly cropped captures that keep the selected area as the primary focus while still allowing broader document context when it helps.

### Git Panel

- Clicking a changed file path in the Git panel **Changes** list or diff header now opens that file in the Files panel viewer, matching the behavior already available from the Diff tab.
- Right-click a changed file in the Changes list to copy its full path or just the filename — useful when you need to paste a file path into a terminal or a search.
- Right-click a commit in the History view to copy its SHA, subject, tags, author, or body — no more reaching for the terminal to grab a commit identifier.
- Made commit details, patch content, and file paths selectable across the Git panel for easier copying of text.
- Added keyboard navigation (Enter and Space) and visible focus rings to Git panel items for a more accessible keyboard-driven workflow.

### Diff Panel

- Added right-click code annotation in the Diff panel — select lines in a diff view, choose **Annotate selection** from the context menu, and drop a code annotation chip straight into the composer, matching the annotation flow already available in the Files panel.

### Sidebar

- Consolidated **New chat**, **Search**, and **Automations** into a single action palette at the top of the sidebar, replacing scattered shortcuts with one coherent column.
- Hovering a sidebar action hides the icon and label and shows only the keyboard shortcut centered in the row for easier reading in the compact layout.
- Re-enabled the sidebar hover-and-scroll scrollbar overlay for long thread lists, and restored the compose button next to the Chats section header alongside the sort menu.
- Thread status is now communicated through the provider icon alone — breathing animation while working, green on success, amber during compaction, red on errors, muted grey when idle — replacing the old "Completed" text pill.
- Fixed Pi agent threads losing the blue breathing animation mid-loop — the client no longer treats in-progress Pi session updates as stale once an assistant message has landed, so the provider icon stays animated until the agent actually finishes.

### Files Panel

- Fixed the Files panel tree so it refreshes when folders are created, deleted, renamed, or converted between files and directories, removing the need for a manual reload after nested workspace changes.

### File Viewer

- Added a **Raw | Preview** toggle for markdown files in the Files panel viewer, placed near the close button so you can switch between source and rendered markdown without leaving the panel.
- Preview mode still supports code annotations — select text, right-click, and add an annotation chip to the composer the same way you can in raw view.

### Notifications and Thread State

- Fixed completion toasts so they fire only after the thread has fully settled, preventing premature "done" notifications while the assistant message is still being written.
- Fixed approval dialogs getting stuck open when the provider returns a non-stale error (like a missing session) — failures now dismiss the dialog and re-enable the buttons instead of leaving you with a permanently disabled prompt.
- Added a 15-second timeout on approval response calls so buttons never stay disabled indefinitely if the connection hangs.

### Reliability

- Fixed Pi multi-turn agent loops being marked complete mid-loop — intermediate turns no longer emit a premature completion event, so long-running agent sessions stay in the "running" state until the agent actually finishes.
- Hardened directory watching so the Files panel stays in sync with the underlying workspace even when the operating system reports a change indirectly, such as a new folder created inside another open folder.

### Settings

- Stopped file-access settings from re-triggering macOS privacy prompts — saving your folder preference no longer probes protected directories and reopens the system permission dialog.

### Providers

- Raised the minimum supported Codex CLI version from `0.37.0` to `0.100.0` to match modern `codex app-server` capabilities used for live model discovery and session runtime.

### Relative Time

- Removed the redundant "ago" suffix from relative time labels across the app (Git commit timestamps, provider "last checked" footers, and similar), yielding tighter labels like `2m` and `1h` that match the convention used by GitHub and most modern tooling.

### Annotations

- Softened annotation composer focus styles to match the chat composer's subtle border-only treatment, and made the working-indicator pill background transparent so the spinner sits cleanly over the conversation.

### Marketing

- Updated changelog page SEO title and description copy on the marketing site.

## v0.1.645 (15 June, 2026)

### Introducing bigbud Curated Native Skills

- bigbud now ships with a curated library of **native skills** baked right into the app under `.bigbud/skills/`, auto-discovered the moment you launch bigbud, with no setup, no configuration, and no extra install required. Kicking off the library: `handoff`, a skill for compacting the current conversation into a clean handoff document for a fresh agent (by [mattpocockuk](https://x.com/mattpocockuk)), and `git-commit`, a skill for writing well-formatted, review-friendly commit messages.
- These bundled skills are surfaced through the `/skills` slash command and the agent/skill picker, tagged with a dedicated `bigbud` discovery label that keeps them clearly separate from the runtime providers like Codex, Claude, and OpenCode that power your AI sessions.
- This is just the start: `.bigbud/skills/` is now the canonical home for skills that feel native to bigbud, and more curated skills are on the way.

### Git Menu

- Replaced the toolbar's quick-action buttons and GitHub PR dropdown with a single Git icon that adapts to repository state, showing all available actions — Init, Commit, Push, Pull, Fetch, Discard changes, View changes, and View history — in one compact menu.
- Leaving the commit message blank in the commit dialog now auto-generates the message using the bigbud curated native `git-commit` skill, so the result follows bigbud's commit conventions — past-tense verbs, a clear subject line, and a descriptive body.
- Auto-generated commit messages work across all providers — Codex, Claude, and Copilot included — so the bundled `git-commit` skill generates messages no matter which provider powers your session.
- Added git fetch and discard-changes actions with a confirmation dialog before discarding, so you can sync remote changes and clean up working-tree changes without leaving the app.
- View history and View changes now open the Git panel to the requested view instead of blindly toggling it, and re-selecting the same view when it is already open closes it — giving you predictable navigation.

### Provider Switching

- Switching providers mid-thread now opens a choice dialog instead of silently branching, so you decide how the new provider thread starts.
- Choose **Start with handoff summary** to run the curated bigbud `handoff` skill on the current thread, then branch into the new provider with only that summary as context. The summary lands as a clear assistant message, giving the new provider the distilled state without dragging the entire conversation history along.
- Choose **Continue with conversation context** to keep today's behavior: copy the existing conversation into the new branch unchanged.
- The handoff option is the default, because switching providers is exactly the kind of moment where a clean, compact handoff saves tokens and keeps the new session focused.

### Context Window Recovery

- The context-window warning banner and the composer context-meter popover now surface actionable **Use handoff** and **Compact** buttons when you cross the configured warning threshold, so you do not have to remember the slash commands yourself.
- **Use handoff** inserts and sends `/skills handoff` in one step, kicking off the curated handoff skill to compact your conversation.
- **Compact** inserts and sends `/compact` in one step, triggering the provider's own context compaction.
- Buttons only appear when the action is actually available for the current provider and project, so the UI stays honest and never promises something it cannot do.

### Settings

- Added a "Changelog" button in Settings → About that opens the bigbud changelog directly in the in-app browser, so you can see what's changed without leaving the app.

### Notebook Preview

- Fixed notebook preview cell widths so code and markdown cells size independently — code cells share a consistent width based on the widest cell, and markdown cells wrap cleanly at the viewport width. This fixes text bleeding on smaller windows.

### Right Panel

- Reduced the right panel tab width so more tabs stay visible without overflowing the tab strip, especially on smaller screens.

### Maintainability

- Replaced array-index React keys with stable content-derived identifiers in the notebook preview cells, removing a React key warning and making cell rendering more robust during re-renders.
- Aligned git status error handling with the broader Effect codebase conventions, cleaning up a TypeScript advisory for tighter type-checking across the git layer.

### File Annotation

- The annotation composer in the file preview now appears right next to the selected lines — 8px above or below — instead of sticking to the bottom of the file, keeping your selected code visible while you write a note.
- Updated the file annotation panel to match the browser annotation panel's visual style, with the title and submit button label changing based on the selected intent ("Add to chat", "Add as context", or "Add task") and a 420px base width.
- Set a 452px minimum width for the file preview so the annotation card always has room to render at its full size.

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
- Stabilized long-thread chat scrolling while responses are still streaming by keeping the active turn, recent completed turns, and expanded work rows mounted before virtualizing older history, which prevents older rows from disappearing as the timeline boundary moves.

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

## v0.1.621 (11 May, 2026)

### Reliability

- Fixed a broken OpenCode turn path where the app could emit `turn.started` and then appear to hang because the current OpenCode `promptAsync` flow returned without producing follow-up session events.
- Switched OpenCode turn execution to a background `prompt` flow and mapped the final response back into canonical runtime events so completions, token usage, and upstream provider failures are surfaced predictably again.
- Made the PDF extraction test self-contained by generating a valid PDF fixture instead of depending on a user-specific local file path.

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

- Added focused tests for OpenCode event mapping, document text extraction, browser panel coordination, thread fork seed preparation, and provider command reactor handlers.

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

- Recent work in this window included repeated validation with `bun fmt`, `bun lint`, `bun typecheck`, and targeted Vitest coverage where behavior or provider/runtime handling changed.
