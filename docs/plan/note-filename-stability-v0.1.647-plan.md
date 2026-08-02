# Note Filename Stability Plan for v0.1.647

Related release note: [v0.1.647 note](/Users/youpele/.bigbud/userdata/notes/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/v0.1.647.md)

## Status

Proposed.

## Summary

The note filename stem is currently derived from the H1 (or first line of content), which causes the file path — and therefore the `noteId` — to change every time the H1 is edited. This breaks any references that point to the old `noteId`. The fix decouples the file stem from the H1 by using a stable datetime-based filename, while keeping the display name driven by the H1 as before.

## Problem Statement

Current behavior:

1. When a note is created, `deriveNoteTitle()` extracts the first non-empty line, strips `#`, and uses that as the filename stem via `sanitizeFilename()`.
2. `noteId` is the relative file path, so any H1 change renames the file and produces a new `noteId`.
3. The agent or other parts of the app that reference a note by its `noteId` lose context when the H1 is edited.
4. The display name already comes from the H1 (or first sentence) — the user never sees the filename stem in the UI, so there is no benefit to tying them together.

Operational result:

1. Renaming a note's H1 can orphan references mid-conversation.
2. The filename stem serves no purpose that the H1-derived display name doesn't already serve.
3. Unnecessary file I/O (rename, collision checking) on every H1 edit.

## Goals

1. Make the note file path stable and independent of the H1.
2. Preserve the existing display name behavior (shown from H1 or first sentence).
3. Eliminate unnecessary file renames when the H1 changes.
4. Keep the UUID directory structure unchanged — only the file stem changes.

## Non-Goals

This change should not:

1. Change how the display name is shown to the user.
2. Change the UUID-based directory layout.
3. Introduce a new note identity system beyond the existing `noteId` (relative path).
4. Require migration or re-indexing of existing notes.

## Product Decisions

### 1. Decouple filename stem from H1

The file stem should be a stable value that does not change when the user edits the H1.

The proposed approach uses a datetime-based filename:

```
~/.bigbud/userdata/notes/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/2026-06-22-14-30-00.md
```

Instead of:

```
~/.bigbud/userdata/notes/1c4f7525-6e2b-4c23-b079-4052a36d0f4c/v0.1.647.md
```

The datetime reflects the creation time and never changes.

### 2. Display name stays driven by content

The display name shown in the app continues to come from `deriveNoteTitle()`:

1. First `<h1>` in the note content, if present.
2. Otherwise, the first non-empty line.
3. Otherwise, "Untitled note".

The file stem no longer needs to match the display name.

### 3. Existing notes are not migrated

Only newly created notes use the datetime stem. Existing notes keep their current filenames — they already have stable paths since their H1 hasn't changed. Over time, as users create new notes, the convention shifts naturally.

### 4. Note file renames are removed from update flow

When the H1 changes, `update()` no longer renames the file on disk. The `noteId` stays the same. This eliminates the collision check, the rename syscall, and the risk of breaking references.

## Implementation Direction

### 1. Change filename generation in `create()`

In `ProjectionNotes.ts`, replace:

```typescript
const title = input.title ?? deriveNoteTitle(input.content);
const safeTitle = sanitizeFilename(title);
const noteRelPath = path.relative(config.stateDir, path.join(targetDir, `${safeTitle}.md`));
```

With:

```typescript
const timestamp = formatTimestamp(new Date()); // e.g. "2026-06-22-14-30-00"
const noteRelPath = path.relative(config.stateDir, path.join(targetDir, `${timestamp}.md`));
```

The `title` field from input can still be stored/used for display but no longer influences the file path.

### 2. Remove rename logic from `update()`

In the `update()` method of `ProjectionNotes.ts`, remove the `title !== currentTitle` block (lines 240-260) that renames the file on disk.

The `input.title` can still be persisted or used to update the display name (if there's a separate title field), but it should not trigger a file rename.

### 3. Frontend adjustments

The frontend does not need significant changes:

1. Note creation passes the same content — the backend generates the datetime stem.
2. The display name is already derived from H1 on the frontend side.
3. Rename/auto-save continue to work — they just no longer trigger a backend file rename.

### 4. Edge cases

1. Two notes created in the same second in the same project: append a counter suffix (e.g. `-1`, `-2`).
2. Backwards compatibility: existing note paths remain valid; only new notes use the new convention.
3. Agent context: the agent references notes by `noteId` (file path). Since the path no longer changes on H1 edit, the agent's references stay valid.

## Rollout Expectations

After this change:

1. New notes have stable file paths that never change when the H1 is edited.
2. Existing notes keep their current paths and are unaffected.
3. The display name continues to show the H1 or first sentence as expected.
4. Agent context references remain valid even when the user edits the note title.
5. File rename and collision-checking I/O is eliminated from the update path.

## Recommendation

Implement the fix as described: use a datetime-based filename stem for new notes, remove the H1-based rename from the update path, and keep the existing display name logic. This is the simplest way to decouple note identity from note content without changing the user-facing behavior.
