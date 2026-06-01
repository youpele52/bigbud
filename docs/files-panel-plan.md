# Files Panel Plan

## Goal

Add a dedicated files/folders workspace surface to bigbud chat threads.

Phase 1 ships a right-side `Files` panel for local workspaces only. The panel must support lazy tree loading and drag/drop into the composer, but dragged items must be added as path references only.

## Scope

Phase 1 includes:

1. A `Files` toggle in the thread header beside the existing terminal, browser, and diff controls.
2. A dedicated right-side `Files` panel mounted through the same panel coordination model as browser and diff.
3. Lazy loading of files and folders from the active thread workspace.
4. Dragging files or folders from the file tree into the composer.
5. Composer rendering for dropped files/folders using the existing attachment/path rendering language already used by bigbud.
6. Sent-message/timeline rendering for those file/folder references using the same existing rendering style.
7. Local-workspace support only.

Phase 1 does not include:

1. Remote workspace support.
2. Eager file reads when dragging into the composer.
3. Eager folder expansion into child files.
4. Inline file-content editing.
5. Full file-system mutation workflows from the tree.

## Product Requirements

1. Users can open a `Files` panel from the thread header without leaving the current chat flow.
2. The file tree loads lazily and remains responsive on large repositories.
3. Dragging a file into the composer adds a file path reference only.
4. Dragging a folder into the composer adds a folder path reference only.
5. Dropped items render exactly like existing path-backed composer/message attachments rather than introducing a second rendering style.
6. The agent may read file contents later, but only through explicit tool/runtime behavior after the message is sent.
7. Folder drops must not silently inject all folder contents into the prompt.

## Recommended Architecture

Use the file tree as a workspace surface, not as a markdown extension.

Why this is the right first step:

1. bigbud already has a right-side panel pattern for browser and diff.
2. bigbud already renders file/path-style attachments in the composer and timeline.
3. Path-only drag/drop keeps phase 1 predictable, cheap, and compatible with later agent-driven reads.
4. Lazy tree loading scales better than trying to hydrate the whole workspace into message content.

## Phase 1 Design

### 1. Panel Model

Add `Files` as another right-side panel option.

Expected behavior:

1. The thread header exposes a `Files` toggle.
2. The route-level panel coordinator understands `"files"` alongside `"browser"` and `"diff"`.
3. The `Files` panel can be opened and closed without disturbing the main chat view.
4. The panel follows the active thread workspace root.

### 2. File Tree

The tree should load directories lazily.

Expected behavior:

1. Only the visible root level is loaded initially.
2. Child directories load on expansion.
3. Tree state tracks expanded directories, selected rows, and loading state.
4. Large repositories must not require an eager full scan just to open the panel.

### 3. Drag and Drop Contract

This is the hard phase 1 contract.

Rules:

1. Dragging from the tree adds only path references to the composer.
2. Preferred payload is full path; use relative path only if full path is not available or not appropriate for the existing attachment model.
3. No file contents are read during drag, drop, preview, or render.
4. No folder contents are expanded during drag, drop, preview, or render.
5. Content reading happens later, explicitly, by the agent or by a separate user action.

### 4. Composer Integration

The tree is only a source of references. The composer remains the source of rendering truth.

Expected behavior:

1. Dropped files reuse the existing composer attachment/path rendering.
2. Dropped folders reuse the same visual language, with the minimum extension needed if folder-specific rendering is not already present.
3. Explorer drops must not create a second attachment system.
4. Users should be able to remove dropped file/folder references from the composer exactly like existing attachments.

### 5. Timeline and Message Rendering

Sent messages should continue to use existing rendering patterns.

Expected behavior:

1. File/folder references dropped from the tree appear in sent messages using the same existing path-backed attachment presentation already used by bigbud.
2. Markdown remains markdown.
3. File tree drops should not be reinterpreted as inline markdown content.

## Data Contract

Phase 1 should treat tree drops as reference attachments.

Suggested contract:

1. File reference:
   `kind: "file"`
   `path: string`
2. Folder reference:
   `kind: "folder"`
   `path: string`

Additional metadata such as display name can be derived at render time or stored if the existing attachment pipeline already expects it.

Important: the contract should align with the existing composer/message attachment model rather than introducing a new one just for the file tree.

## Likely Implementation Areas

1. `apps/web/src/components/chat/common/ChatHeader.tsx`
2. `apps/web/src/routes/_chat.$threadId.tsx`
3. `apps/web/src/stores/browser/browserPanel.coordinator.ts`
4. New `apps/web/src/components/files/` panel components
5. Composer drag/drop handling in the existing chat composer flow
6. Existing composer/timeline attachment rendering components
7. Server RPC for local workspace directory listing if current web-side primitives are insufficient

## Risks

1. The file tree invents a second attachment representation instead of reusing the existing one.
2. Drag/drop accidentally reads file contents and makes prompts much larger than the user intended.
3. Large repositories feel slow if lazy loading is not enforced strictly.
4. Folder drops become ambiguous if later runtime behavior expands them inconsistently.
5. Local-only assumptions leak into future remote support in ways that are hard to unwind.

## Phase 2

**Phase 2 is intentionally not fully specified yet. It still needs more product and runtime context before implementation should begin.**

**Do not treat this section as implementation-ready. It is direction only.**

Possible phase 2 areas:

1. Read-only file preview inside the `Files` panel.
2. Explicit user actions to read a file into context before sending.
3. Agent-aware workflows that can resolve attached path references into actual reads during turn execution.
4. Structural file operations such as create, rename, move, and delete from the tree.
5. Inline file-content editing from a dedicated preview/editor surface.

Why phase 2 needs more context:

1. It changes the boundary between workspace navigation and content editing.
2. It introduces save semantics, dirty state, and refresh behavior.
3. It affects approval and agent-read expectations.
4. It may require a stronger model for folder references, file previews, and explicit read actions.

Until that context is defined, phase 2 should remain a follow-up design problem rather than being collapsed into phase 1.

## Acceptance Criteria

1. A user can open a `Files` panel from the thread header.
2. The tree loads lazily from the active local workspace.
3. Dragging a file into the composer adds a file path reference only.
4. Dragging a folder into the composer adds a folder path reference only.
5. Composer rendering matches the existing attachment/path rendering style.
6. Sent-message rendering matches the existing attachment/path rendering style.
7. No file or folder contents are read implicitly during drag/drop or rendering.
