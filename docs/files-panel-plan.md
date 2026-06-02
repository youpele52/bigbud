# Files Panel Plan

## Status

Phase 1 is complete.

Completed in phase 1:

1. Right-side `Files` panel toggle in the thread header.
2. Lazy local-workspace tree loading.
3. File/folder drag and drop into the composer as path references only.
4. Composer and timeline reuse of the existing file/path attachment rendering style.
5. Double-click open behavior for local files, including code/markdown files opening in the configured editor and non-code files opening through the OS default application.
6. Files panel pointer hover and right-click path copy behavior.

Phase 2 is the dedicated read-only code review surface.

## Goal

Add a read-only in-app code viewer for local workspaces that lets users inspect source files, annotate lines or symbols, and send those annotations to the composer as structured context for the agent.

This phase is explicitly not a lightweight editor.

## Product Direction

The code viewer is a review surface, not an editing surface.

Hard rules:

1. The viewed file is always read-only.
2. Users cannot type into the file, save it, or create dirty state.
3. Users can select a line, line range, or symbol and attach an annotation/comment to that selection.
4. Users can ask the agent to edit the selected code, but the actual edit still happens through the agent workflow, not inside the viewer.
5. Opening a file for preview must not implicitly inject the whole file into the prompt.

## Scope

Phase 2 includes:

1. A dedicated read-only code viewer surface for local workspaces.
2. Opening code-related files from the Files tree and chat into that viewer.
3. Bounded file-content reads for preview.
4. Syntax-highlighted rendering for code and config/document formats.
5. Line and line-range annotation.
6. Composer integration for file/code annotations.
7. Timeline rendering for sent file/code annotations.
8. Reuse of a slimmer shared annotation model and preview UI that can support browser annotations and code annotations without forcing both into one bloated shape.

Phase 2 does not include:

1. In-view file editing.
2. Save semantics or dirty-state handling.
3. Bulk “read entire folder/repo into context” workflows.
4. Remote workspace support.
5. Full IDE capabilities such as rename, refactor, go-to-definition, or code actions.

## Supported Preview Types

Phase 2 should support a broad initial set of text/code formats:

1. `ts`, `tsx`, `cts`, `mts`
2. `js`, `jsx`, `cjs`, `mjs`
3. `json`, `jsonc`
4. `rs`, `py`, `go`, `java`, `kt`, `kts`, `rb`, `php`, `lua`
5. `c`, `h`, `cpp`, `hpp`, `cc`, `hh`
6. `cs`, `swift`
7. `html`, `css`, `scss`, `sass`, `less`, `xml`, `svg`
8. `md`, `mdx`, `txt`, `rst`
9. `yml`, `yaml`, `toml`, `ini`, `conf`, `env`
10. `sh`, `bash`, `zsh`, `fish`, `ps1`
11. `sql`, `graphql`, `proto`
12. `dockerfile`, `makefile`, `gitignore`, `editorconfig`

Rules:

1. Treat unsupported text files as plain text if they are reasonably sized.
2. Reject binary files from in-app preview and keep the existing OS-open behavior.
3. Enforce preview size limits so large files do not freeze the UI.

## UX Model

### 1. Viewer Surface

The Files tree remains the navigation surface. The code viewer is the review surface.

Expected behavior:

1. Opening a code-related file routes to a read-only in-app viewer instead of launching the external editor.
2. The viewer lives in the existing right-side panel ecosystem.
3. The viewer can be opened from:
   - the Files panel
   - chat file/path references
   - future timeline annotation links
4. The viewer shows filename, path, language, and repo-relative location.
5. The viewer can be closed without disturbing the current chat draft.

### 2. Read-only Interaction

Expected behavior:

1. Users can scroll, search within file, and copy text.
2. Users can select lines or ranges.
3. Users cannot modify the file contents.
4. There is no save button, no dirty indicator, and no mutation path in the viewer.

### 3. Annotation Workflow

Expected behavior:

1. Selecting code exposes annotation actions such as:
   - `Comment`
   - `Add context`
   - `Request change`
2. Submitting an annotation adds structured context to the composer.
3. The annotation stores the selected excerpt and range metadata.
4. Users can remove annotations before sending.
5. Clicking an annotation preview can reopen the file and jump back to the annotated range.

## Recommended Architecture

Use a dedicated read-only code viewer plus structured annotations.

Why this is the right boundary:

1. It preserves the “chat first” workflow of bigbud.
2. It avoids creating edit/save semantics inside the file viewer.
3. It reuses the browser-annotation pattern already present in the composer flow.
4. It keeps the agent responsible for real code edits.

## Data Model

Phase 2 should stop thinking of annotations as browser-only.

Introduce a shared base annotation model plus use-case-specific extensions.

### Shared Base

Required shared fields:

1. `id`
2. `kind`
3. `intent`
4. `comment`
5. `createdAt`

### Browser Annotation Extension

Keep browser-specific fields separate from the base:

1. `imageId`
2. `page`
3. `element`
4. `viewport`

### Code Annotation Extension

Add a file/code-specific extension:

1. `filePath`
2. `displayPath`
3. `language`
4. `selectionKind`
5. `startLine`
6. `endLine`
7. `startColumn` optional
8. `endColumn` optional
9. `selectedText`
10. `symbolName` optional

Important:

1. Do not force browser and code annotations into one oversized shared payload.
2. Do create one shared base type and one shared preview shell so future annotation kinds remain composable.

## Viewer Implementation Plan

### 1. Panel Model

Add a dedicated code viewer panel mode or a viewer sub-surface within the Files panel.

Requirements:

1. The panel must work with the existing right-side panel coordinator.
2. It must follow the active thread workspace.
3. It must preserve tree navigation state when switching between tree and viewer.

### 2. File Read Contract

Add explicit server-side file preview reads.

Requirements:

1. Local-workspace only.
2. Text/code preview only.
3. Size-bounded.
4. Binary files rejected cleanly.
5. Paths must stay within the active workspace root.

### 3. Rendering Engine

Use a real code viewer, not markdown rendering.

Recommendation:

1. Use Monaco in read-only mode.
2. Enable syntax highlighting, line numbers, selection, and decorations.
3. Disable editing commands and save semantics.

Why:

1. Line/range selection is a first-class requirement.
2. Future symbol-aware annotations fit this model.
3. It is the closest fit to the referenced Codex/Orca-style interaction pattern without turning bigbud into a full IDE.

### 4. Annotation Capture

The current browser annotation system should be generalized, not copied.

Requirements:

1. Extract a slimmer shared annotation preview component.
2. Extract a shared base annotation type.
3. Keep browser-specific capture logic browser-specific.
4. Add a code-annotation capture path that writes to the same composer draft annotation collection model.

### 5. Prompt Serialization

Annotations should become prompt context only when the user sends the message.

Code annotation prompt payload should include:

1. file path
2. language
3. selected range
4. selected excerpt
5. user instruction
6. intent

Rules:

1. Do not append full file contents by default.
2. Do not append non-selected neighboring code unless a future explicit affordance adds that behavior.
3. Keep the serialized format deterministic and compact.

### 6. Composer and Timeline Rendering

Expected behavior:

1. Composer shows code annotations as structured previews, parallel to browser annotations.
2. Timeline shows sent code annotations as compact expandable attachments.
3. Timeline entries can reopen the viewer to the annotated location.

## Milestones

### Milestone 2A: Foundation

1. Extract shared annotation base types.
2. Extract shared annotation preview shell.
3. Keep existing browser annotations working on top of the slimmer foundation.

### Milestone 2B: Read-only Viewer

1. Add file preview RPC.
2. Add right-side code viewer panel.
3. Open supported code/text files in-app instead of externally.
4. Preserve external-open behavior for unsupported or binary files.

### Milestone 2C: Code Annotation MVP

1. Add line/range selection.
2. Add `Comment`, `Add context`, and `Request change` actions.
3. Store code annotations in composer draft state.
4. Show composer previews and allow removal.

### Milestone 2D: Send + Replay

1. Serialize code annotations into send-time prompt context.
2. Render sent code annotations in the timeline.
3. Jump from preview/timeline back into the file viewer location.

### Milestone 2E: Symbol-aware Review

1. Add file outline or symbol navigation.
2. Support symbol-based annotation in addition to line ranges.
3. Re-anchor annotations more reliably when the file changes.

## Risks

1. Accidentally letting the viewer drift into a writable editor.
2. Pulling full file contents into prompts implicitly and making turns much larger than intended.
3. Building a browser-annotation-shaped schema that becomes awkward for code review.
4. Large file preview performance issues if size limits and lazy rendering are not enforced.
5. Ambiguous re-anchoring if a file changes after an annotation is created.

## Acceptance Criteria

Phase 2 is complete when:

1. A user can open supported code/text files in a read-only in-app viewer.
2. The viewer exposes no editing or saving workflow.
3. A user can annotate a line or range and send that annotation to the composer.
4. Composer previews reuse a shared annotation shell rather than a browser-only UI path.
5. Sending a message includes structured annotation context without injecting the whole file.
6. Sent messages render code annotations in the timeline.
7. Unsupported or binary files continue to fall back to external open behavior.
