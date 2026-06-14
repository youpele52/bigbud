---
name: git-commit
description: Create well-formatted git commits with review and clear messages in the bigbud project. Use when the user asks to commit changes, write a commit message, review changes before committing, or asks about commit conventions.
---

# Git Commit

Use this skill when the user wants to commit changes in the bigbud project. This skill covers reviewing changes, choosing a commit strategy, staging files, and writing descriptive commit messages. It does **not** handle pushing.

## Quick start

1. Run `git status` and review all uncommitted changes.
2. Run `git diff` for unstaged changes and `git diff --staged` for staged changes.
3. Ask the user: "Should I commit these as one commit or split them into multiple logical commits?"
4. Stage files with `git add` according to the agreed strategy.
5. Write a commit message using the format below.
6. Run `git commit`.
7. After committing, **ask before pushing** — never push automatically.

## Commit message format

```
[Past-tense verb]: [Brief description]

[Detailed explanation of what changed and why]
```

- First line: 50–300 characters, ideally under 72 for readability.
- Use past-tense verbs at the start of the subject (e.g., `Added`, `Updated`, `Refactored`, `Fixed`, `Removed`, `Deleted`).
- Reference issue/ticket numbers when applicable (e.g., `Fixes #123`).

### Verb examples

- **Added**: New features, files, or functionality.
- **Updated**: Modifications to existing files or dependencies.
- **Refactored**: Code restructuring or cleanup for readability, performance, or maintainability.
- **Fixed**: Bug fixes or corrected behavior.
- **Removed / Deleted**: Removed code, files, or features that are no longer needed.

## Rules

- Always review changes with `git status` and `git diff` before staging.
- Never stage or commit secrets, credentials, or sensitive data.
- Split commits logically when the user agrees; avoid mixing unrelated changes.
- Never push to a remote automatically. If the user asks to push, ask for explicit confirmation first.
- Never force-push to `main`, `master`, or any default branch without explicit confirmation.
