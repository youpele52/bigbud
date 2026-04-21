# Constants Refactoring Initiative

**Status**: Completed  
**Priority**: High  
**Estimated Effort**: 9-12 hours  
**Last Updated**: April 6, 2026

## Executive Summary

This document outlines a comprehensive refactoring initiative to extract and centralize all repeated constants throughout the bigbud application into a well-organized constants folder structure in `packages/contracts/src/constants/`.

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Why This Matters](#why-this-matters)
3. [Architecture Decision](#architecture-decision)
4. [Constants Inventory](#constants-inventory)
5. [Implementation Plan](#implementation-plan)
6. [Migration Guide](#migration-guide)
7. [Success Criteria](#success-criteria)
8. [FAQ](#faq)

---

## Problem Statement

### Current State

The bigbud codebase suffers from significant constant duplication:

- **996+ occurrences** of provider string literals (`"codex"`, `"claudeAgent"`, `"copilot"`, `"opencode"`) across **106 files**
- **294 occurrences** of WebSocket method names across **10 files**
- Dozens of default values, configuration constants, and magic strings scattered throughout the codebase
- Inconsistent patterns: some constants defined inline, others in domain files, creating confusion

### Real-World Example

Looking at `apps/web/src/components/settings/useSettingsRestore.ts`:

```typescript
const PROVIDER_KEYS = ["codex", "claudeAgent", "copilot", "opencode"] as const;
```

This same array is defined in multiple places:

- `packages/contracts/src/orchestration.ts` (as Schema.Literals)
- `apps/server/src/serverSettings.ts` (as PROVIDER_ORDER)
- `apps/web/src/modelSelection.ts` (in object keys)
- And many more...

### Impact

1. **Maintenance Burden**: Adding a new provider requires updates in dozens of files
2. **Type Safety Risks**: String literals are prone to typos (e.g., `"claudAgent"` vs `"claudeAgent"`)
3. **Poor Discoverability**: Developers must search the entire codebase to find constant definitions
4. **Inconsistent Behavior**: Different files might have different orderings or subsets of providers
5. **Documentation Gap**: Magic strings lack context about their purpose and valid values

---

## Why This Matters

### Benefits for Developers

1. **Single Source of Truth**: All constants defined in one centralized, discoverable location
2. **Improved Maintainability**: Changes propagate automatically throughout the codebase
3. **Better IntelliSense**: IDEs can provide better autocomplete and documentation
4. **Reduced Cognitive Load**: Developers don't need to remember magic strings
5. **Easier Onboarding**: New team members can quickly understand configuration options

### Benefits for the Codebase

1. **Type Safety**: Centralized constants work better with TypeScript's type system
2. **Reduced Bugs**: Eliminates typos and inconsistencies from repeated literals
3. **Better Testing**: Constants can be easily mocked or overridden in tests
4. **Improved Refactoring**: Renaming a constant updates all usages automatically
5. **Code Quality**: Follows DRY (Don't Repeat Yourself) principles

### Business Impact

1. **Faster Feature Development**: Adding new providers or modes becomes trivial
2. **Reduced Bug Risk**: Fewer places for inconsistencies to creep in
3. **Lower Maintenance Cost**: Changes require fewer file modifications
4. **Better Code Reviews**: Reviewers can focus on logic, not magic strings

---

## Architecture Decision

### Location: `packages/contracts/src/constants/`

We've chosen to centralize all constants in the `packages/contracts` package for the following reasons:

#### Why `packages/contracts`?

1. **Already the Source of Truth**: This package defines shared types, schemas, and domain models used by both `apps/web` and `apps/server`
2. **Existing Import Pattern**: Both apps heavily import from `@bigbud/contracts`, so no new import patterns needed
3. **Type Co-location**: Constants can live alongside their related schemas for better type safety
4. **Single Dependency**: Avoids circular dependencies between apps and shared packages
5. **Architectural Consistency**: Follows the existing pattern where domain knowledge lives in contracts

#### Why Not Other Locations?

**❌ Separate constants folders per workspace** (`apps/web/src/constants`, `apps/server/src/constants`)

- Would require duplication of shared constants
- Creates sync issues between web and server
- Violates DRY principles

**❌ `packages/shared/src/constants`**

- `packages/shared` is for runtime utilities, not domain knowledge
- Would create confusion about where to find domain constants
- Breaks the existing architectural pattern

**✅ `packages/contracts/src/constants`**

- Centralized, single source of truth
- Co-located with related types and schemas
- Follows existing architectural patterns
- Easy to discover and import

### Folder Structure

```
packages/contracts/src/constants/
├── index.ts                      # Barrel export
├── provider.constant.ts          # Provider kinds, names, order
├── model.constant.ts             # Model defaults, aliases, effort options
├── websocket.constant.ts         # WS method names
├── runtime.constant.ts           # Runtime modes, interaction modes
├── terminal.constant.ts          # Terminal defaults
├── storage.constant.ts           # Storage keys, versions
├── settings.constant.ts          # Settings defaults
├── branding.constant.ts          # App branding
├── git.constant.ts               # Git-related constants
└── providerRuntime.constant.ts   # Provider runtime states
```

---

## Constants Inventory

### 1. Provider Constants (`provider.constant.ts`)

**Priority**: 🔴 Critical (996+ usages across 106 files)

**Current Locations**:

- `packages/contracts/src/orchestration.ts` - ProviderKind Schema
- `apps/server/src/serverSettings.ts` - PROVIDER_ORDER
- `packages/contracts/src/model.ts` - PROVIDER_DISPLAY_NAMES
- `apps/server/src/provider/Layers/*.types.ts` - Individual provider constants

**Constants to Extract**:

````typescript
/**
 * All available provider kinds in the bigbud application.
 *
 * Providers represent different AI coding assistant backends that can be used
 * for code generation, chat, and other AI-powered features.
 *
 * Order matters for fallback logic in some contexts.
 */
export const PROVIDER_KINDS = ["codex", "claudeAgent", "copilot", "opencode"] as const;

/**
 * Provider fallback order used when the selected provider is disabled.
 *
 * When a user's selected provider is unavailable, the system will attempt
 * to use the next available provider in this order.
 */
export const PROVIDER_ORDER = ["codex", "claudeAgent", "copilot", "opencode"] as const;

/**
 * Human-readable display names for each provider.
 *
 * Used in UI components, settings panels, and user-facing messages.
 */
export const PROVIDER_DISPLAY_NAMES = {
  codex: "Codex",
  claudeAgent: "Claude",
  copilot: "Copilot",
  opencode: "OpenCode",
} as const;

/**
 * Default provider used when no preference is set.
 */
export const DEFAULT_PROVIDER_KIND = "copilot" as const;

/**
 * Individual provider constants for type-safe comparisons.
 *
 * Use these instead of string literals when checking provider types.
 *
 * @example
 * ```typescript
 * if (provider === CODEX_PROVIDER) {
 *   // Codex-specific logic
 * }
 * ```
 */
````

**Impact**: Updating 106 files, eliminating 996+ string literal duplications

---

### 2. Model Constants (`model.constant.ts`)

**Priority**: 🟠 High (~50 files affected)

**Current Location**: `packages/contracts/src/model.ts`

**Constants to Extract**:

```typescript
/**
 * Reasoning effort levels available for Codex and Copilot models.
 *
 * Higher effort levels use more compute for better quality responses
 * but may take longer to generate.
 *
 * - `xhigh`: Maximum reasoning effort
 * - `high`: High reasoning effort
 * - `medium`: Balanced effort (recommended for most use cases)
 * - `low`: Fast responses with minimal reasoning
 */
export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;

/**
 * Code effort levels available for Claude models.
 *
 * - `ultrathink`: Maximum thinking time for complex problems
 * - `max`: Extended thinking for difficult tasks
 * - `high`: Thorough analysis
 * - `medium`: Balanced effort (recommended)
 * - `low`: Quick responses
 */
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;

/**
 * Default model for each provider.
 *
 * These are used when:
 * - Creating a new thread without a model preference
 * - A provider is enabled but no model is selected
 * - Resetting to defaults
 */
export const DEFAULT_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
  copilot: "gpt-5",
  opencode: "claude-sonnet-4-6",
} as const;

/**
 * Default models for git text generation (commit messages, PR descriptions, etc.).
 *
 * These are typically smaller/faster models since git operations don't require
 * the full reasoning capabilities of the main models.
 */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  copilot: "gpt-5-mini",
  opencode: "claude-haiku-4-5",
} as const;

/**
 * The default model used application-wide.
 *
 * This is the fallback when no provider-specific default is available.
 */
export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

/**
 * Model slug aliases for user convenience.
 *
 * Allows users to type shorter versions of model names.
 * For example, "5.4" maps to "gpt-5.4" for Codex.
 */
export const MODEL_SLUG_ALIASES_BY_PROVIDER = {
  codex: {
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  copilot: {
    "gpt-5.4": "gpt-5",
    "gpt-5.4-mini": "gpt-5-mini",
    "gpt-5.3": "gpt-5",
    "gpt-5.3-codex": "gpt-5",
    "gpt-5.3-codex-spark": "gpt-5-mini",
  },
  opencode: {},
} as const;
```

---

### 3. WebSocket Constants (`websocket.constant.ts`)

**Priority**: 🟠 High (294 usages across 10 files)

**Current Locations**:

- `packages/contracts/src/rpc.ts` - WS_METHODS
- `packages/contracts/src/orchestration.ts` - ORCHESTRATION_WS_METHODS

**Constants to Extract**:

```typescript
/**
 * WebSocket RPC method names for the bigbud server.
 *
 * These method names are used for client-server communication over WebSocket.
 * Each method corresponds to a specific RPC endpoint.
 *
 * @see packages/contracts/src/rpc.ts for RPC schema definitions
 */
export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Git methods
  gitPull: "git.pull",
  gitStatus: "git.status",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",

  // Streaming subscriptions
  subscribeOrchestrationDomainEvents: "subscribeOrchestrationDomainEvents",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
} as const;

/**
 * Orchestration-specific WebSocket method names.
 *
 * These methods handle orchestration commands and queries for thread management,
 * turn execution, and event replay.
 */
export const ORCHESTRATION_WS_METHODS = {
  getSnapshot: "orchestration.getSnapshot",
  dispatchCommand: "orchestration.dispatchCommand",
  getTurnDiff: "orchestration.getTurnDiff",
  getFullThreadDiff: "orchestration.getFullThreadDiff",
  replayEvents: "orchestration.replayEvents",
} as const;
```

---

### 4. Runtime Mode Constants (`runtime.constant.ts`)

**Priority**: 🟡 Medium (~30 files affected)

**Current Locations**:

- `packages/contracts/src/orchestration.ts`
- `apps/web/src/types.ts`

**Constants to Extract**:

```typescript
/**
 * Runtime modes control how the provider executes commands and file operations.
 *
 * - `approval-required`: User must approve all file changes and command executions
 * - `full-access`: Provider can execute commands and modify files without approval
 */
export const RUNTIME_MODES = ["approval-required", "full-access"] as const;

/**
 * Default runtime mode for new threads.
 *
 * Set to `full-access` for a smoother development experience.
 * Users can change this in settings or per-thread.
 */
export const DEFAULT_RUNTIME_MODE = "full-access" as const;

/**
 * Provider interaction modes control how the assistant responds to user requests.
 *
 * - `default`: Normal conversation and code generation
 * - `plan`: Assistant creates a plan before implementing (planning mode)
 */
export const PROVIDER_INTERACTION_MODES = ["default", "plan"] as const;

/**
 * Default interaction mode for new threads.
 */
export const DEFAULT_PROVIDER_INTERACTION_MODE = "default" as const;

/**
 * Approval policies for provider actions.
 *
 * - `untrusted`: Always require approval
 * - `on-failure`: Require approval only after a failure
 * - `on-request`: Require approval when provider requests it
 * - `never`: Never require approval (dangerous)
 */
export const PROVIDER_APPROVAL_POLICIES = [
  "untrusted",
  "on-failure",
  "on-request",
  "never",
] as const;

/**
 * Sandbox modes control filesystem access levels.
 *
 * - `read-only`: Provider can only read files
 * - `workspace-write`: Provider can write within workspace
 * - `danger-full-access`: Provider has full filesystem access (use with caution)
 */
export const PROVIDER_SANDBOX_MODES = [
  "read-only",
  "workspace-write",
  "danger-full-access",
] as const;
```

---

### 5. Terminal Constants (`terminal.constant.ts`)

**Priority**: 🟡 Medium (~20 files affected)

**Current Locations**:

- `apps/server/src/terminal/Layers/Manager.types.ts`
- `apps/web/src/types.ts`

**Constants to Extract**:

```typescript
/**
 * Maximum number of lines to retain in terminal history.
 *
 * Prevents memory issues with long-running terminals while keeping
 * enough history for useful scrollback.
 */
export const DEFAULT_HISTORY_LINE_LIMIT = 5_000;

/**
 * Debounce delay (ms) before persisting terminal history to disk.
 *
 * Balances between data safety and disk I/O performance.
 */
export const DEFAULT_PERSIST_DEBOUNCE_MS = 40;

/**
 * Interval (ms) for polling subprocess status.
 *
 * Used to detect when background processes complete.
 */
export const DEFAULT_SUBPROCESS_POLL_INTERVAL_MS = 1_000;

/**
 * Grace period (ms) before forcefully killing a terminal process.
 *
 * Allows processes to clean up gracefully before SIGKILL.
 */
export const DEFAULT_PROCESS_KILL_GRACE_MS = 1_000;

/**
 * Maximum number of inactive terminal sessions to keep in memory.
 *
 * Prevents memory leaks from accumulating inactive sessions.
 */
export const DEFAULT_MAX_RETAINED_INACTIVE_SESSIONS = 128;

/**
 * Default terminal width in columns.
 */
export const DEFAULT_OPEN_COLS = 120;

/**
 * Default terminal height in rows.
 */
export const DEFAULT_OPEN_ROWS = 30;

/**
 * Default height (px) for thread-embedded terminals in the UI.
 */
export const DEFAULT_THREAD_TERMINAL_HEIGHT = 280;

/**
 * Default terminal ID for the primary terminal in a thread.
 */
export const DEFAULT_THREAD_TERMINAL_ID = "default";

/**
 * Maximum number of terminals allowed per terminal group.
 *
 * Prevents UI clutter and resource exhaustion.
 */
export const MAX_TERMINALS_PER_GROUP = 4;
```

---

### 6. Storage Constants (`storage.constant.ts`)

**Priority**: 🟢 Low (~5 files affected)

**Current Location**: `apps/web/src/composerDraftStore.types.ts`

**Constants to Extract**:

```typescript
/**
 * LocalStorage key for persisting composer drafts.
 *
 * Includes version suffix to allow for future migration strategies.
 */
export const COMPOSER_DRAFT_STORAGE_KEY = "t3code:composer-drafts:v1";

/**
 * Current version of the composer draft storage schema.
 *
 * Increment this when making breaking changes to the storage format.
 * Migration logic should handle upgrading from older versions.
 */
export const COMPOSER_DRAFT_STORAGE_VERSION = 3;
```

---

### 7. Settings Constants (`settings.constant.ts`)

**Priority**: 🟡 Medium (~15 files affected)

**Current Location**: `packages/contracts/src/settings.ts`

**Constants to Extract**:

```typescript
/**
 * Available timestamp display formats.
 *
 * - `locale`: Use browser's locale format
 * - `12-hour`: 12-hour format with AM/PM
 * - `24-hour`: 24-hour military time format
 */
export const TIMESTAMP_FORMATS = ["locale", "12-hour", "24-hour"] as const;

/**
 * Default timestamp format.
 */
export const DEFAULT_TIMESTAMP_FORMAT = "locale" as const;

/**
 * Sidebar project sort order options.
 *
 * - `updated_at`: Most recently updated first
 * - `created_at`: Most recently created first
 * - `manual`: User-defined order
 */
export const SIDEBAR_PROJECT_SORT_ORDERS = ["updated_at", "created_at", "manual"] as const;

/**
 * Default sidebar project sort order.
 */
export const DEFAULT_SIDEBAR_PROJECT_SORT_ORDER = "updated_at" as const;

/**
 * Sidebar thread sort order options.
 *
 * - `updated_at`: Most recently updated first
 * - `created_at`: Most recently created first
 */
export const SIDEBAR_THREAD_SORT_ORDERS = ["updated_at", "created_at"] as const;

/**
 * Default sidebar thread sort order.
 */
export const DEFAULT_SIDEBAR_THREAD_SORT_ORDER = "updated_at" as const;

/**
 * Thread environment modes.
 *
 * - `local`: Thread runs in the main workspace
 * - `worktree`: Thread runs in an isolated git worktree
 */
export const THREAD_ENV_MODES = ["local", "worktree"] as const;

/**
 * Default binary paths for each provider.
 *
 * These are the command names used to invoke provider CLIs.
 * Users can override these in settings if their binaries are named differently.
 */
export const DEFAULT_BINARY_PATHS = {
  codex: "codex",
  claudeAgent: "claude",
  copilot: "copilot",
  opencode: "opencode",
} as const;
```

---

### 8. Branding Constants (`branding.constant.ts`)

**Priority**: 🟢 Low (~5 files affected)

**Current Location**: `apps/web/src/branding.ts`

**Constants to Extract**:

```typescript
/**
 * Base application name without stage label.
 */
export const APP_BASE_NAME = "bigbud";

/**
 * Stage label indicating the current release phase.
 *
 * - "Dev" in development mode
 * - "Alpha" in production builds
 */
export const APP_STAGE_LABEL = import.meta.env.DEV ? "Dev" : "Alpha";

/**
 * Full application display name including stage label.
 *
 * Used in window titles, about dialogs, and branding.
 */
export const APP_DISPLAY_NAME = `${APP_BASE_NAME} (${APP_STAGE_LABEL})`;

/**
 * Application version from build environment.
 *
 * Falls back to "0.0.0" in development.
 */
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
```

---

### 9. Git Constants (`git.constant.ts`)

**Priority**: 🟡 Medium (~10 files affected)

**Current Location**: `packages/contracts/src/git.ts`

**Constants to Extract**:

```typescript
/**
 * Git stacked action types.
 *
 * These represent atomic or combined git operations that can be performed
 * as a single user action.
 *
 * - `commit`: Create a commit
 * - `push`: Push to remote
 * - `create_pr`: Create a pull request
 * - `commit_push`: Commit and push
 * - `commit_push_pr`: Commit, push, and create PR
 */
export const GIT_STACKED_ACTIONS = [
  "commit",
  "push",
  "create_pr",
  "commit_push",
  "commit_push_pr",
] as const;

/**
 * Phases of a git stacked action.
 *
 * Used for progress tracking and error reporting.
 */
export const GIT_ACTION_PROGRESS_PHASES = ["branch", "commit", "push", "pr"] as const;

/**
 * Git action progress event kinds.
 *
 * Represents different stages of action execution for UI feedback.
 */
export const GIT_ACTION_PROGRESS_KINDS = [
  "action_started",
  "phase_started",
  "hook_started",
  "hook_completed",
  "phase_completed",
  "action_completed",
  "action_failed",
] as const;

/**
 * Git action output streams.
 *
 * - `stdout`: Standard output
 * - `stderr`: Standard error
 */
export const GIT_ACTION_PROGRESS_STREAMS = ["stdout", "stderr"] as const;

/**
 * Pull request states.
 *
 * - `open`: PR is open and active
 * - `closed`: PR was closed without merging
 * - `merged`: PR was merged
 */
export const GIT_PR_STATES = ["open", "closed", "merged"] as const;

/**
 * Pull request thread preparation modes.
 *
 * - `local`: Prepare PR in the main workspace
 * - `worktree`: Prepare PR in an isolated worktree
 */
export const GIT_PREPARE_PR_THREAD_MODES = ["local", "worktree"] as const;
```

---

### 10. Provider Runtime Constants (`providerRuntime.constant.ts`)

**Priority**: 🟡 Medium (~25 files affected)

**Current Location**: `packages/contracts/src/providerRuntime.ts`

**Constants to Extract**:

```typescript
/**
 * Runtime event raw source identifiers.
 *
 * These identify the origin of provider runtime events for routing and processing.
 */
export const RUNTIME_EVENT_RAW_SOURCES = [
  "codex.app-server.notification",
  "codex.app-server.request",
  "codex.eventmsg",
] as const;

/**
 * Provider session states.
 *
 * Tracks the lifecycle of a provider session from startup to termination.
 */
export const RUNTIME_SESSION_STATES = ["starting", "ready", "running", "exited", "error"] as const;

/**
 * Thread states in the provider runtime.
 *
 * - `active`: Thread is currently executing
 * - `idle`: Thread is waiting for user input
 * - `archived`: Thread has been archived by user
 * - `suspended`: Thread execution is paused
 * - `error`: Thread encountered an error
 */
export const RUNTIME_THREAD_STATES = ["active", "idle", "archived", "suspended", "error"] as const;

/**
 * Turn completion states.
 *
 * - `completed`: Turn finished successfully
 * - `failed`: Turn failed with an error
 * - `interrupted`: Turn was interrupted by user
 * - `cancelled`: Turn was cancelled before completion
 */
export const RUNTIME_TURN_STATES = ["completed", "failed", "interrupted", "cancelled"] as const;

/**
 * Plan step execution statuses.
 *
 * Used for tracking progress of multi-step plans.
 */
export const RUNTIME_PLAN_STEP_STATUSES = ["pending", "inProgress", "completed"] as const;

/**
 * Item execution statuses.
 *
 * Tracks the state of individual work items (tool calls, approvals, etc.).
 */
export const RUNTIME_ITEM_STATUSES = ["inProgress", "completed", "failed", "declined"] as const;

/**
 * Content stream kinds for streaming responses.
 *
 * - `assistant_text`: Regular assistant response text
 * - `reasoning_text`: Internal reasoning/thinking
 * - `reasoning_summary_text`: Summary of reasoning
 * - `tool_use`: Tool invocation
 * - `tool_result`: Tool execution result
 * - `image_view`: Image content
 */
export const RUNTIME_CONTENT_STREAM_KINDS = [
  "assistant_text",
  "reasoning_text",
  "reasoning_summary_text",
  "tool_use",
  "tool_result",
  "image_view",
] as const;

/**
 * Tool lifecycle item types.
 *
 * Represents different types of tool-related events in the provider runtime.
 */
export const TOOL_LIFECYCLE_ITEM_TYPES = [
  "command_execution",
  "file_read",
  "file_change",
  "tool_use",
  "tool_result",
  "image_view",
] as const;

/**
 * Canonical item types for the conversation timeline.
 *
 * These represent the different types of items that can appear in a thread.
 */
export const CANONICAL_ITEM_TYPES = [
  "user_message",
  "assistant_message",
  "reasoning",
  "reasoning_summary",
  "tool_use",
  "tool_result",
  "image_view",
  "error",
  "system_message",
] as const;

/**
 * Canonical request types for user approvals and input.
 *
 * - `command_execution_approval`: Approve a command execution
 * - `file_read_approval`: Approve reading a file
 * - `file_change_approval`: Approve modifying a file
 * - `user_input`: General user input request
 * - `tool_approval`: Approve a tool invocation
 * - `other_approval`: Other approval types
 */
export const CANONICAL_REQUEST_TYPES = [
  "command_execution_approval",
  "file_read_approval",
  "file_change_approval",
  "user_input",
  "tool_approval",
  "other_approval",
] as const;
```

---

## Implementation Plan

### Phase 1: Create Constants Folder Structure (30 minutes)

**Steps**:

1. Create `packages/contracts/src/constants/` directory
2. Create 10 constant files with proper naming:
   - `provider.constant.ts`
   - `model.constant.ts`
   - `websocket.constant.ts`
   - `runtime.constant.ts`
   - `terminal.constant.ts`
   - `storage.constant.ts`
   - `settings.constant.ts`
   - `branding.constant.ts`
   - `git.constant.ts`
   - `providerRuntime.constant.ts`
3. Create `packages/contracts/src/constants/index.ts` barrel export

**Validation**:

- All files created with `.constant.ts` suffix
- Barrel export properly re-exports all constants
- No TypeScript errors in new files

---

### Phase 2: Extract and Document Constants (3-4 hours)

**For Each Constant File**:

1. **Copy constants** from source files to new constant files
2. **Add comprehensive JSDoc** with:
   - Purpose and usage explanation
   - Valid values and their meanings
   - When to use vs. when not to use
   - Examples where helpful
   - Related constants
3. **Preserve `as const` assertions** for literal type inference
4. **Export types** derived from constants where applicable
5. **Group related constants** logically

**Documentation Pattern**:

````typescript
/**
 * Brief one-line description.
 *
 * Detailed explanation of what this constant represents,
 * when it's used, and any important context.
 *
 * @example
 * ```typescript
 * import { CONSTANT_NAME } from '@bigbud/contracts/constants';
 *
 * // Usage example
 * ```
 */
export const CONSTANT_NAME = /* value */ as const;
````

**Validation**:

- All constants have JSDoc documentation
- `as const` preserved where needed
- No circular dependencies
- TypeScript compiles without errors

---

### Phase 3: Update Imports Throughout Codebase (4-6 hours)

**Priority Order**:

1. Provider constants (106 files)
2. WebSocket methods (10 files)
3. Model constants (~50 files)
4. Runtime constants (~30 files)
5. Terminal constants (~20 files)
6. Provider runtime constants (~25 files)
7. Settings constants (~15 files)
8. Git constants (~10 files)
9. Storage constants (~5 files)
10. Branding constants (~5 files)

**For Each File**:

1. **Update imports** to use new constant paths:

   ```typescript
   // Before
   import { ProviderKind } from "@bigbud/contracts";
   const provider = "codex";

   // After
   import { ProviderKind, CODEX_PROVIDER } from "@bigbud/contracts";
   const provider = CODEX_PROVIDER;
   ```

2. **Replace inline literals** with constant references:

   ```typescript
   // Before
   const providers = ["codex", "claudeAgent", "copilot", "opencode"];

   // After
   import { PROVIDER_KINDS } from "@bigbud/contracts";
   const providers = [...PROVIDER_KINDS];
   ```

3. **Update Schema.Literals()** to reference constants:

   ```typescript
   // Before
   Schema.Literals(["codex", "claudeAgent", "copilot", "opencode"]);

   // After
   import { PROVIDER_KINDS } from "@bigbud/contracts/constants";
   Schema.Literals(PROVIDER_KINDS);
   ```

**Special Cases**:

- **Test files**: May need to import constants for mocking
- **Comments and docs**: Update references to point to constant definitions
- **String templates**: Keep as-is if they're user-facing messages
- **Regex patterns**: Keep as-is if they match against user input

**Validation After Each Batch**:

- Run `bun typecheck` to catch import errors
- Run `bun lint` to ensure code style
- Run affected tests to catch runtime issues

---

### Phase 4: Update Barrel Exports (30 minutes)

**Steps**:

1. **Update `packages/contracts/src/constants/index.ts`**:

   ```typescript
   export * from "./provider.constant";
   export * from "./model.constant";
   export * from "./websocket.constant";
   export * from "./runtime.constant";
   export * from "./terminal.constant";
   export * from "./storage.constant";
   export * from "./settings.constant";
   export * from "./branding.constant";
   export * from "./git.constant";
   export * from "./providerRuntime.constant";
   ```

2. **Update `packages/contracts/src/index.ts`**:
   ```typescript
   // Add to existing exports
   export * from "./constants";
   ```

**Validation**:

- All constants accessible via `@bigbud/contracts`
- No duplicate exports
- Tree-shaking works correctly

---

### Phase 5: Validation and Testing (1 hour)

**Comprehensive Validation**:

1. **Type Checking**: `bun typecheck`
   - Zero TypeScript errors
   - All imports resolve correctly
   - Types infer correctly from constants

2. **Linting**: `bun lint`
   - Zero linting errors
   - Code style consistent

3. **Formatting**: `bun fmt`
   - All files formatted correctly

4. **Testing**: `bun run test`
   - All tests pass
   - No runtime errors
   - Mock data uses constants correctly

5. **Manual Verification**:
   - Search for remaining inline literals: `grep -r '"codex"' apps/ packages/`
   - Check Schema.Literals() usage
   - Verify no circular dependencies

**Validation Checklist**:

- [ ] `bun typecheck` passes with zero errors
- [ ] `bun lint` passes with zero errors
- [ ] `bun fmt` completes successfully
- [ ] `bun run test` passes all tests
- [ ] No inline provider string literals remain
- [ ] All Schema.Literals() reference constants
- [ ] Barrel exports work correctly
- [ ] No circular dependencies
- [ ] Documentation is comprehensive

---

### Phase 6: Documentation Updates (30 minutes)

**Update Documentation**:

1. **AGENTS.md**: Add section about constants organization
2. **Architecture docs**: Document the constants structure
3. **Contributing guide**: Explain how to add new constants
4. **This document**: Mark as "Completed" when done

**Example Addition to AGENTS.md**:

````markdown
## Constants Organization

All application constants are centralized in `packages/contracts/src/constants/`.

### Adding New Constants

1. Determine which constant file it belongs in (or create a new one)
2. Add the constant with comprehensive JSDoc documentation
3. Export from the constant file
4. Use the constant instead of inline literals throughout the codebase

### Importing Constants

```typescript
// Import from the main contracts package
import { CODEX_PROVIDER, DEFAULT_MODEL } from "@bigbud/contracts";

// Or import from specific constant files
import { CODEX_PROVIDER } from "@bigbud/contracts/constants/provider.constant";
```
````

### Guidelines

- Never use inline string literals for provider names, modes, or states
- Always import constants from `@bigbud/contracts`
- Document new constants with JSDoc
- Use `as const` for literal type inference

````

---

## Migration Guide

### For Developers

#### Before This Refactoring

```typescript
// Inline literals scattered everywhere
const provider = "codex";
const providers = ["codex", "claudeAgent", "copilot", "opencode"];

if (provider === "codex") {
  // Codex-specific logic
}

// Schema with inline literals
export const ProviderKind = Schema.Literals(["codex", "claudeAgent", "copilot", "opencode"]);
````

#### After This Refactoring

```typescript
import { CODEX_PROVIDER, PROVIDER_KINDS } from "@bigbud/contracts";

const provider = CODEX_PROVIDER;
const providers = [...PROVIDER_KINDS];

if (provider === CODEX_PROVIDER) {
  // Codex-specific logic
}

// Schema referencing constants
export const ProviderKind = Schema.Literals(PROVIDER_KINDS);
```

### Common Migration Patterns

#### Pattern 1: Replace Inline Literals

```typescript
// Before
const PROVIDER_KEYS = ["codex", "claudeAgent", "copilot", "opencode"] as const;

// After
import { PROVIDER_KINDS } from "@bigbud/contracts";
const PROVIDER_KEYS = PROVIDER_KINDS;
```

#### Pattern 2: Update Schema Definitions

```typescript
// Before
export const ProviderKind = Schema.Literals(["codex", "claudeAgent", "copilot", "opencode"]);

// After
import { PROVIDER_KINDS } from "@bigbud/contracts/constants";
export const ProviderKind = Schema.Literals(PROVIDER_KINDS);
```

#### Pattern 3: Replace String Comparisons

```typescript
// Before
if (provider === "codex") {
  // ...
}

// After
import { CODEX_PROVIDER } from "@bigbud/contracts";
if (provider === CODEX_PROVIDER) {
  // ...
}
```

#### Pattern 4: Update Object Keys

```typescript
// Before
const config = {
  codex: {
    /* ... */
  },
  claudeAgent: {
    /* ... */
  },
  copilot: {
    /* ... */
  },
  opencode: {
    /* ... */
  },
};

// After
import {
  CODEX_PROVIDER,
  CLAUDE_PROVIDER,
  COPILOT_PROVIDER,
  OPENCODE_PROVIDER,
} from "@bigbud/contracts";
const config = {
  [CODEX_PROVIDER]: {
    /* ... */
  },
  [CLAUDE_PROVIDER]: {
    /* ... */
  },
  [COPILOT_PROVIDER]: {
    /* ... */
  },
  [OPENCODE_PROVIDER]: {
    /* ... */
  },
};
```

#### Pattern 5: Update Default Values

```typescript
// Before
const DEFAULT_PROVIDER = "codex";

// After
import { DEFAULT_PROVIDER_KIND } from "@bigbud/contracts";
const DEFAULT_PROVIDER = DEFAULT_PROVIDER_KIND;
```

---

## Success Criteria

### Must Have (Blocking)

- [ ] All constants extracted to `packages/contracts/src/constants/`
- [ ] All constant files have comprehensive JSDoc documentation
- [ ] Zero TypeScript errors (`bun typecheck` passes)
- [ ] Zero linting errors (`bun lint` passes)
- [ ] All tests pass (`bun run test` passes)
- [ ] No inline string literals for provider names
- [ ] All Schema.Literals() reference constant arrays
- [ ] Barrel exports work correctly
- [ ] No circular dependencies introduced

### Should Have (Important)

- [ ] All imports updated to use new constant paths
- [ ] Documentation updated (AGENTS.md, architecture docs)
- [ ] Migration guide created for team
- [ ] Code review completed
- [ ] No performance regressions

### Nice to Have (Optional)

- [ ] ESLint rule to prevent new inline literals
- [ ] Bundle size analysis shows no significant increase
- [ ] Developer tooling updated (snippets, templates)
- [ ] Automated migration script for future constants

---

## FAQ

### Q: Why centralize constants instead of keeping them with their domain logic?

**A**: While co-location has benefits, the massive duplication (996+ occurrences of provider strings) creates a maintenance nightmare. Centralization provides:

- Single source of truth
- Easier refactoring
- Better discoverability
- Reduced bugs from typos

### Q: Won't this create a "god file" anti-pattern?

**A**: No, because we're organizing constants into 10 focused files by domain (provider, model, websocket, etc.). Each file has a clear purpose and related constants are grouped together.

### Q: What about performance? Won't importing constants everywhere slow things down?

**A**: Modern bundlers (Vite, esbuild) use tree-shaking to eliminate unused exports. Importing constants has negligible performance impact and may actually improve performance by enabling better code splitting.

### Q: Should I use constants in test files?

**A**: Yes! Using constants in tests makes them more maintainable. If a provider name changes, tests update automatically. However, you may want to create test-specific constants for mock data.

### Q: What if I need a constant that's not in the constants folder?

**A**: Add it! Follow the documentation pattern, choose the appropriate constant file (or create a new one), and submit a PR. The constants folder is meant to grow with the application.

### Q: Can I still use inline strings for user-facing messages?

**A**: Yes. This refactoring targets configuration constants, not user-facing text. String templates, error messages, and UI text can remain inline or in i18n files.

### Q: What about constants that are only used in one file?

**A**: If a constant is truly file-specific and unlikely to be reused, it can stay in that file. This refactoring targets **repeated** constants used across multiple files.

### Q: How do I handle constants that depend on environment variables?

**A**: Constants can reference `import.meta.env` or `process.env`. See `branding.constant.ts` for an example with `APP_STAGE_LABEL`.

### Q: Will this break existing code?

**A**: No. We're adding new constant exports while maintaining backward compatibility. Existing imports continue to work. We'll update them incrementally.

### Q: What's the rollback plan if something goes wrong?

**A**: Git revert to the previous commit. Since this is a pure refactoring with no logic changes, rollback is straightforward.

---

## Appendix: File Impact Analysis

### Files by Update Priority

**Critical (100+ usages)**:

- Provider constants: 106 files affected

**High (50-99 usages)**:

- Model constants: ~50 files affected

**Medium (20-49 usages)**:

- Runtime constants: ~30 files affected
- Provider runtime constants: ~25 files affected
- Terminal constants: ~20 files affected

**Low (10-19 usages)**:

- Settings constants: ~15 files affected
- WebSocket methods: 10 files affected
- Git constants: ~10 files affected

**Very Low (<10 usages)**:

- Storage constants: ~5 files affected
- Branding constants: ~5 files affected

### Total Estimated Updates

- **Files to modify**: ~280 files
- **String literals to replace**: 1,500+
- **Import statements to add**: ~400
- **Schema.Literals() to update**: ~50

---

## Conclusion

This constants refactoring initiative addresses a critical technical debt in the bigbud codebase. By centralizing 1,500+ repeated string literals into a well-organized constants folder, we'll improve maintainability, reduce bugs, and provide a better developer experience.

The refactoring is designed to be incremental, testable, and reversible. Each phase has clear validation criteria, and the entire process is estimated to take 9-12 hours of focused work.

Upon completion, adding new providers, modes, or configuration options will be trivial, and the codebase will be more resilient to typos and inconsistencies.

---

**Document Version**: 1.0  
**Last Updated**: April 6, 2026  
**Author**: bigbud Team  
**Status**: Ready for Implementation
