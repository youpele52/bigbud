# Changelog

This document tracks notable project changes in a format that is useful for developers, users, AI assistants, and public release sharing.

Entries below are grouped by release tag and date.

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

### Provider and Runtime Reliability [t3code]

- Adapted upstream reliability fixes into bigbud's current architecture instead of copying `t3code` modules directly.
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

### Git, PR, and Terminal Improvements [t3code]

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
