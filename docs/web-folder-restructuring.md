# Web App Folder Restructuring Plan

**Status**: Completed  
**Priority**: Medium  
**Estimated Effort**: 4-6 hours  
**Last Updated**: April 6, 2026

## Table of Contents

1. [Problem Statement](#problem-statement)
2. [Proposed Structure](#proposed-structure)
3. [Naming Conventions](#naming-conventions)
4. [File Migration Map](#file-migration-map)
5. [Implementation Plan](#implementation-plan)
6. [Testing & Validation](#testing--validation)
7. [Risks & Mitigation](#risks--mitigation)

---

## Problem Statement

### Current Issues

The `apps/web/src` directory currently contains **90+ files** in a flat structure, making it difficult to:

1. **Find related files**: Store logic, utilities, and tests are scattered
2. **Understand organization**: No clear separation of concerns
3. **Navigate codebase**: Developers must scroll through long file lists
4. **Maintain consistency**: No enforced naming conventions
5. **Scale the application**: Adding new features clutters the root directory

### Example of Current Chaos

```
apps/web/src/
├── store.ts
├── store.events.ts
├── store.helpers.ts
├── store.mappers.ts
├── store.selectors.ts
├── store.test.ts
├── store.transitions.ts
├── timestampFormat.ts
├── timestampFormat.test.ts
├── composerDraftStore.ts
├── composerDraftStore.actions.ts
├── composerDraftStore.migration.ts
├── composerDraftStore.normalization.ts
├── composerDraftStore.normalizers.ts
├── composerDraftStore.persistence.ts
├── composerDraftStore.selectors.ts
├── composerDraftStore.test.ts
├── composerDraftStore.types.ts
└── ... 70+ more files
```

**Problems**:

- 9 files related to `composerDraftStore` scattered in root
- 7 files related to main `store` scattered in root
- Utility files mixed with domain logic
- No clear grouping by feature or concern

---

## Proposed Structure

### New Folder Organization

```
apps/web/src/
├── components/           # React components (already exists)
├── routes/              # Route components (already exists)
├── hooks/               # React hooks (already exists)
├── rpc/                 # RPC client logic (already exists)
├── stores/              # State management (NEW)
│   ├── main/           # Main application store
│   ├── composer/       # Composer draft store
│   ├── terminal/       # Terminal state store
│   ├── ui/             # UI state store
│   └── thread/         # Thread selection store
├── utils/               # Utility functions (NEW)
│   ├── timestamp/      # Timestamp formatting
│   ├── markdown/       # Markdown processing
│   ├── terminal/       # Terminal utilities
│   ├── diff/           # Diff utilities
│   └── format/         # General formatting
├── logic/               # Business logic (NEW)
│   ├── session/        # Session management
│   ├── composer/       # Composer logic
│   ├── orchestration/  # Orchestration logic
│   └── recovery/       # Recovery logic
├── models/              # Data models & types (NEW)
│   ├── provider/       # Provider models
│   ├── project/        # Project models
│   └── keybindings/    # Keybinding models
├── lib/                 # Third-party integrations (NEW)
│   ├── vscode-icons/   # VSCode icon integration
│   └── editor/         # Editor integrations
├── config/              # Configuration files (NEW)
│   ├── branding/       # Branding configuration
│   ├── env/            # Environment configuration
│   └── router/         # Router configuration
└── [root files]         # Entry points only
    ├── main.tsx
    ├── index.css
    ├── vite-env.d.ts
    └── routeTree.gen.ts
```

---

## Naming Conventions

### File Naming Pattern

**Format**: `{name}.{type}.{ext}`

**Types**:

- `.store.ts` - State management (Zustand stores)
- `.utils.ts` - Utility functions
- `.logic.ts` - Business logic
- `.types.ts` - TypeScript type definitions
- `.config.ts` - Configuration
- `.test.ts` - Test files (always next to source)

### Examples

**Before** → **After**:

- `store.ts` → `stores/main/main.store.ts`
- `store.events.ts` → `stores/main/events.store.ts`
- `store.helpers.ts` → `stores/main/helpers.store.ts`
- `store.test.ts` → `stores/main/main.store.test.ts`
- `timestampFormat.ts` → `utils/timestamp/timestamp.utils.ts`
- `timestampFormat.test.ts` → `utils/timestamp/timestamp.utils.test.ts`
- `composerDraftStore.ts` → `stores/composer/composer.store.ts`
- `composerDraftStore.actions.ts` → `stores/composer/actions.store.ts`
- `session-logic.ts` → `logic/session/session.logic.ts`

### Co-location Rule

**Test files MUST be next to their source files**:

```
utils/timestamp/
├── timestamp.utils.ts
└── timestamp.utils.test.ts

stores/composer/
├── composer.store.ts
├── composer.store.test.ts
├── actions.store.ts
├── migration.store.ts
├── normalization.store.ts
├── normalizers.store.ts
├── persistence.store.ts
├── selectors.store.ts
└── types.store.ts
```

---

## File Migration Map

### 📦 **stores/** (State Management)

#### `stores/main/` - Main Application Store

- `store.ts` → `main.store.ts`
- `store.events.ts` → `events.store.ts`
- `store.helpers.ts` → `helpers.store.ts`
- `store.mappers.ts` → `mappers.store.ts`
- `store.selectors.ts` → `selectors.store.ts`
- `store.test.ts` → `main.store.test.ts`
- `store.transitions.ts` → `transitions.store.ts`
- `storeSelectors.ts` → `global-selectors.store.ts`

#### `stores/composer/` - Composer Draft Store

- `composerDraftStore.ts` → `composer.store.ts`
- `composerDraftStore.actions.ts` → `actions.store.ts`
- `composerDraftStore.migration.ts` → `migration.store.ts`
- `composerDraftStore.normalization.ts` → `normalization.store.ts`
- `composerDraftStore.normalizers.ts` → `normalizers.store.ts`
- `composerDraftStore.persistence.ts` → `persistence.store.ts`
- `composerDraftStore.selectors.ts` → `selectors.store.ts`
- `composerDraftStore.test.ts` → `composer.store.test.ts`
- `composerDraftStore.types.ts` → `types.store.ts`

#### `stores/terminal/` - Terminal State Store

- `terminalStateStore.ts` → `terminal.store.ts`
- `terminalStateStore.helpers.ts` → `helpers.store.ts`
- `terminalStateStore.test.ts` → `terminal.store.test.ts`

#### `stores/ui/` - UI State Store

- `uiStateStore.ts` → `ui.store.ts`
- `uiStateStore.test.ts` → `ui.store.test.ts`

#### `stores/thread/` - Thread Selection Store

- `threadSelectionStore.ts` → `thread.store.ts`
- `threadSelectionStore.test.ts` → `thread.store.test.ts`

---

### 🛠️ **utils/** (Utility Functions)

#### `utils/timestamp/`

- `timestampFormat.ts` → `timestamp.utils.ts`
- `timestampFormat.test.ts` → `timestamp.utils.test.ts`

#### `utils/markdown/`

- `markdown-links.ts` → `links.utils.ts`
- `markdown-links.test.ts` → `links.utils.test.ts`

#### `utils/terminal/`

- `terminal-links.ts` → `links.utils.ts`
- `terminal-links.test.ts` → `links.utils.test.ts`
- `terminalActivity.ts` → `activity.utils.ts`
- `terminalActivity.test.ts` → `activity.utils.test.ts`

#### `utils/diff/`

- `diffRouteSearch.ts` → `route-search.utils.ts`
- `diffRouteSearch.test.ts` → `route-search.utils.test.ts`

#### `utils/scroll/`

- `chat-scroll.ts` → `scroll.utils.ts`
- `chat-scroll.test.ts` → `scroll.utils.test.ts`

#### `utils/copy/`

- `copy.ts` → `copy.utils.ts`

#### `utils/context-menu/`

- `contextMenuFallback.ts` → `fallback.utils.ts`

#### `utils/worktree/`

- `worktreeCleanup.ts` → `cleanup.utils.ts`
- `worktreeCleanup.test.ts` → `cleanup.utils.test.ts`

#### `utils/history/`

- `historyBootstrap.ts` → `bootstrap.utils.ts`
- `historyBootstrap.test.ts` → `bootstrap.utils.test.ts`

---

### 🧠 **logic/** (Business Logic)

#### `logic/session/`

- `session-logic.ts` → `session.logic.ts`
- `session-logic.test.ts` → `session.logic.test.ts`
- `session-logic.worklog.ts` → `worklog.logic.ts`

#### `logic/composer/`

- `composer-logic.ts` → `composer.logic.ts`
- `composer-logic.test.ts` → `composer.logic.test.ts`
- `composer-editor-mentions.ts` → `editor-mentions.logic.ts`
- `composer-editor-mentions.test.ts` → `editor-mentions.logic.test.ts`

#### `logic/orchestration/`

- `orchestrationEventEffects.ts` → `event-effects.logic.ts`
- `orchestrationEventEffects.test.ts` → `event-effects.logic.test.ts`
- `orchestrationRecovery.ts` → `recovery.logic.ts`
- `orchestrationRecovery.test.ts` → `recovery.logic.test.ts`

#### `logic/user-input/`

- `pendingUserInput.ts` → `pending.logic.ts`
- `pendingUserInput.test.ts` → `pending.logic.test.ts`

#### `logic/proposed-plan/`

- `proposedPlan.ts` → `plan.logic.ts`
- `proposedPlan.test.ts` → `plan.logic.test.ts`

#### `logic/pull-request/`

- `pullRequestReference.ts` → `reference.logic.ts`
- `pullRequestReference.test.ts` → `reference.logic.test.ts`

#### `logic/project-scripts/`

- `projectScripts.ts` → `scripts.logic.ts`
- `projectScripts.test.ts` → `scripts.logic.test.ts`

---

### 📊 **models/** (Data Models & Types)

#### `models/provider/`

- `providerModels.ts` → `provider.models.ts`
- `modelSelection.ts` → `selection.models.ts`
- `modelSelectionHelpers.ts` → `selection-helpers.models.ts`

#### `models/types/`

- `types.ts` → `app.types.ts`

#### `models/keybindings/`

- `keybindings.ts` → `keybindings.models.ts`
- `keybindings.test.ts` → `keybindings.models.test.ts`

#### `models/editor/`

- `editorPreferences.ts` → `preferences.models.ts`

---

### 🔌 **lib/** (Third-party Integrations)

#### `lib/vscode-icons/`

- `vscode-icons.ts` → `icons.lib.ts`
- `vscode-icons.test.ts` → `icons.lib.test.ts`
- `vscode-icons-language-associations.json` → `language-associations.json`
- `vscode-icons-manifest.json` → `manifest.json`

---

### ⚙️ **config/** (Configuration)

#### `config/branding/`

- `branding.ts` → `branding.config.ts`

#### `config/env/`

- `env.ts` → `env.config.ts`

#### `config/router/`

- `router.ts` → `router.config.ts`

---

### 🌐 **rpc/** (Already Organized)

Keep existing structure:

- `rpc/serverState.test.ts`
- (other RPC files)

---

### 🔗 **Root Level** (Entry Points Only)

Keep in `apps/web/src/`:

- `main.tsx` - Application entry point
- `index.css` - Global styles
- `vite-env.d.ts` - Vite type definitions
- `routeTree.gen.ts` - Generated route tree
- `nativeApi.ts` - Native API bridge (consider moving to `lib/native-api/`)
- `wsNativeApi.ts` - WebSocket native API (consider moving to `lib/native-api/`)
- `wsNativeApi.test.ts` - Test file
- `wsRpcClient.ts` - WebSocket RPC client (consider moving to `rpc/`)
- `wsTransport.ts` - WebSocket transport (consider moving to `rpc/`)
- `wsTransport.test.ts` - Test file

---

## Implementation Plan

### Phase 1: Create Folder Structure (15 minutes)

Create all new directories:

```bash
cd apps/web/src

# Create store directories
mkdir -p stores/{main,composer,terminal,ui,thread}

# Create utils directories
mkdir -p utils/{timestamp,markdown,terminal,diff,scroll,copy,context-menu,worktree,history}

# Create logic directories
mkdir -p logic/{session,composer,orchestration,user-input,proposed-plan,pull-request,project-scripts}

# Create models directories
mkdir -p models/{provider,types,keybindings,editor}

# Create lib directories
mkdir -p lib/vscode-icons

# Create config directories
mkdir -p config/{branding,env,router}
```

---

### Phase 2: Move & Rename Store Files (1 hour)

**For each store category**:

1. Move files to new location
2. Rename according to convention
3. Update imports in moved files
4. Update imports in files that reference them

**Example: Main Store**

```bash
# Move files
mv store.ts stores/main/main.store.ts
mv store.events.ts stores/main/events.store.ts
mv store.helpers.ts stores/main/helpers.store.ts
mv store.mappers.ts stores/main/mappers.store.ts
mv store.selectors.ts stores/main/selectors.store.ts
mv store.test.ts stores/main/main.store.test.ts
mv store.transitions.ts stores/main/transitions.store.ts
mv storeSelectors.ts stores/main/global-selectors.store.ts
```

**Update imports in moved files**:

```typescript
// Before (in store.events.ts)
import { something } from "./store.helpers";

// After (in stores/main/events.store.ts)
import { something } from "./helpers.store";
```

**Update imports in other files**:

```typescript
// Before
import { useStore } from "../store";

// After
import { useStore } from "../stores/main/main.store";
```

**Create barrel export** (`stores/main/index.ts`):

```typescript
export * from "./main.store";
export * from "./events.store";
export * from "./helpers.store";
export * from "./mappers.store";
export * from "./selectors.store";
export * from "./transitions.store";
export * from "./global-selectors.store";
```

**Repeat for**:

- Composer store (9 files)
- Terminal store (3 files)
- UI store (2 files)
- Thread store (2 files)

---

### Phase 3: Move & Rename Utility Files (1 hour)

**For each utility category**:

1. Move files to new location
2. Rename according to convention
3. Update imports
4. Create barrel exports

**Example: Timestamp Utils**

```bash
mv timestampFormat.ts utils/timestamp/timestamp.utils.ts
mv timestampFormat.test.ts utils/timestamp/timestamp.utils.test.ts
```

**Create barrel export** (`utils/timestamp/index.ts`):

```typescript
export * from "./timestamp.utils";
```

**Update imports**:

```typescript
// Before
import { formatTimestamp } from "../timestampFormat";

// After
import { formatTimestamp } from "../utils/timestamp";
```

**Repeat for**:

- Markdown utils (2 files)
- Terminal utils (4 files)
- Diff utils (2 files)
- Scroll utils (2 files)
- Copy utils (1 file)
- Context menu utils (1 file)
- Worktree utils (2 files)
- History utils (2 files)

---

### Phase 4: Move & Rename Logic Files (1 hour)

**For each logic category**:

1. Move files to new location
2. Rename according to convention
3. Update imports
4. Create barrel exports

**Example: Session Logic**

```bash
mv session-logic.ts logic/session/session.logic.ts
mv session-logic.test.ts logic/session/session.logic.test.ts
mv session-logic.worklog.ts logic/session/worklog.logic.ts
```

**Create barrel export** (`logic/session/index.ts`):

```typescript
export * from "./session.logic";
export * from "./worklog.logic";
```

**Repeat for**:

- Composer logic (4 files)
- Orchestration logic (4 files)
- User input logic (2 files)
- Proposed plan logic (2 files)
- Pull request logic (2 files)
- Project scripts logic (2 files)

---

### Phase 5: Move & Rename Model Files (30 minutes)

**For each model category**:

1. Move files to new location
2. Rename according to convention
3. Update imports
4. Create barrel exports

**Example: Provider Models**

```bash
mv providerModels.ts models/provider/provider.models.ts
mv modelSelection.ts models/provider/selection.models.ts
mv modelSelectionHelpers.ts models/provider/selection-helpers.models.ts
```

**Create barrel export** (`models/provider/index.ts`):

```typescript
export * from "./provider.models";
export * from "./selection.models";
export * from "./selection-helpers.models";
```

**Repeat for**:

- Types (1 file)
- Keybindings (2 files)
- Editor (1 file)

---

### Phase 6: Move & Rename Config Files (15 minutes)

**Move configuration files**:

```bash
mv branding.ts config/branding/branding.config.ts
mv env.ts config/env/env.config.ts
mv router.ts config/router/router.config.ts
```

**Create barrel exports** for each config directory.

---

### Phase 7: Move & Rename Lib Files (15 minutes)

**Move VSCode icons integration**:

```bash
mv vscode-icons.ts lib/vscode-icons/icons.lib.ts
mv vscode-icons.test.ts lib/vscode-icons/icons.lib.test.ts
mv vscode-icons-language-associations.json lib/vscode-icons/language-associations.json
mv vscode-icons-manifest.json lib/vscode-icons/manifest.json
```

**Create barrel export** (`lib/vscode-icons/index.ts`):

```typescript
export * from "./icons.lib";
```

---

### Phase 8: Update All Import Statements (1-2 hours)

**Systematic approach**:

1. **Use TypeScript compiler** to find broken imports:

   ```bash
   bun typecheck
   ```

2. **Fix imports file by file**:
   - Start with components (most imports)
   - Then routes
   - Then hooks
   - Finally root files

3. **Update import patterns**:

```typescript
// Before
import { useStore } from "../store";
import { formatTimestamp } from "../timestampFormat";
import { sessionLogic } from "../session-logic";

// After
import { useStore } from "../stores/main";
import { formatTimestamp } from "../utils/timestamp";
import { sessionLogic } from "../logic/session";
```

4. **Use barrel exports** for cleaner imports:

```typescript
// Instead of
import { useStore } from "../stores/main/main.store";
import { storeEvents } from "../stores/main/events.store";

// Use
import { useStore, storeEvents } from "../stores/main";
```

---

### Phase 9: Create Index Files (30 minutes)

**Create barrel exports for each directory**:

**Example: `stores/index.ts`**

```typescript
// Re-export all stores
export * from "./main";
export * from "./composer";
export * from "./terminal";
export * from "./ui";
export * from "./thread";
```

**Example: `utils/index.ts`**

```typescript
// Re-export all utilities
export * from "./timestamp";
export * from "./markdown";
export * from "./terminal";
export * from "./diff";
export * from "./scroll";
export * from "./copy";
export * from "./context-menu";
export * from "./worktree";
export * from "./history";
```

**Create for**:

- `stores/index.ts`
- `utils/index.ts`
- `logic/index.ts`
- `models/index.ts`
- `lib/index.ts`
- `config/index.ts`

---

### Phase 10: Update Path Aliases (Optional) (15 minutes)

**Update `tsconfig.json` to add path aliases**:

```json
{
  "compilerOptions": {
    "paths": {
      "@/stores/*": ["./src/stores/*"],
      "@/utils/*": ["./src/utils/*"],
      "@/logic/*": ["./src/logic/*"],
      "@/models/*": ["./src/models/*"],
      "@/lib/*": ["./src/lib/*"],
      "@/config/*": ["./src/config/*"],
      "@/components/*": ["./src/components/*"],
      "@/hooks/*": ["./src/hooks/*"],
      "@/rpc/*": ["./src/rpc/*"]
    }
  }
}
```

**Update Vite config** (`vite.config.ts`):

```typescript
import { defineConfig } from "vite";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@/stores": path.resolve(__dirname, "./src/stores"),
      "@/utils": path.resolve(__dirname, "./src/utils"),
      "@/logic": path.resolve(__dirname, "./src/logic"),
      "@/models": path.resolve(__dirname, "./src/models"),
      "@/lib": path.resolve(__dirname, "./src/lib"),
      "@/config": path.resolve(__dirname, "./src/config"),
      "@/components": path.resolve(__dirname, "./src/components"),
      "@/hooks": path.resolve(__dirname, "./src/hooks"),
      "@/rpc": path.resolve(__dirname, "./src/rpc"),
    },
  },
});
```

**Then use cleaner imports**:

```typescript
// Instead of
import { useStore } from "../../stores/main";

// Use
import { useStore } from "@/stores/main";
```

---

## Testing & Validation

### Automated Validation

#### 1. Type Checking

```bash
bun typecheck
```

**Expected**: Zero TypeScript errors

---

#### 2. Linting

```bash
bun lint
```

**Expected**: Zero linting errors

---

#### 3. Test Suite

```bash
bun run test
```

**Expected**: All tests pass

---

#### 4. Build

```bash
bun run build
```

**Expected**: Successful build with no errors

---

### Manual Validation

#### 1. File Organization

**Check each directory**:

```bash
# Verify stores structure
ls -R apps/web/src/stores/

# Verify utils structure
ls -R apps/web/src/utils/

# Verify logic structure
ls -R apps/web/src/logic/

# Verify models structure
ls -R apps/web/src/models/

# Verify lib structure
ls -R apps/web/src/lib/

# Verify config structure
ls -R apps/web/src/config/
```

**Verify**:

- [ ] All files moved to correct directories
- [ ] Test files are next to source files
- [ ] Naming convention followed (`.store.ts`, `.utils.ts`, etc.)
- [ ] No orphaned files in root `src/`

---

#### 2. Import Statements

**Search for old import patterns**:

```bash
# Should return no results
grep -r "from \"../store\"" apps/web/src/
grep -r "from \"../timestampFormat\"" apps/web/src/
grep -r "from \"../session-logic\"" apps/web/src/
```

---

#### 3. Barrel Exports

**Verify barrel exports exist**:

```bash
# Check for index.ts files
find apps/web/src/stores -name "index.ts"
find apps/web/src/utils -name "index.ts"
find apps/web/src/logic -name "index.ts"
find apps/web/src/models -name "index.ts"
```

---

#### 4. Application Functionality

**Run dev server and test**:

```bash
bun run dev:web
```

**Manual tests**:

- [ ] App loads without errors
- [ ] All pages render correctly
- [ ] Store state management works
- [ ] Utilities function correctly
- [ ] No console errors
- [ ] Hot module replacement works

---

### Success Criteria

- [ ] All 90+ files moved to appropriate directories
- [ ] All files renamed according to convention
- [ ] Test files co-located with source files
- [ ] All imports updated and working
- [ ] Barrel exports created for all directories
- [ ] TypeScript compiles with zero errors
- [ ] All tests pass
- [ ] Build succeeds
- [ ] Application runs without errors
- [ ] No files remain in root `src/` except entry points

---

## Risks & Mitigation

### Risk 1: Breaking Imports

**Risk**: Moving files breaks imports across the codebase

**Mitigation**:

- Use TypeScript compiler to catch all broken imports
- Fix imports incrementally, testing after each category
- Create barrel exports to simplify import paths
- Use git to track changes and revert if needed

---

### Risk 2: Test Files Separated

**Risk**: Test files might get separated from source files

**Mitigation**:

- Strict rule: Test files MUST be in same directory as source
- Verify with script after migration
- Use naming convention to ensure pairing (e.g., `file.utils.ts` + `file.utils.test.ts`)

---

### Risk 3: Merge Conflicts

**Risk**: Large file moves create merge conflicts

**Mitigation**:

- Coordinate with team before starting
- Do migration in a dedicated branch
- Merge quickly after completion
- Communicate clearly about the restructuring

---

### Risk 4: Lost Files

**Risk**: Files might get lost during migration

**Mitigation**:

- Create backup before starting
- Use git to track all moves
- Verify file count before and after
- Use checklist to ensure all files migrated

---

### Risk 5: Build/Runtime Errors

**Risk**: Application might break at runtime despite TypeScript passing

**Mitigation**:

- Run full test suite after migration
- Test application manually
- Check for dynamic imports or require() statements
- Verify Vite config handles new structure

---

## Rollback Plan

### If Issues Arise

1. **Git Revert**:

   ```bash
   git revert <commit-hash>
   ```

2. **Restore from Backup**:

   ```bash
   git checkout backup/pre-restructure -- apps/web/src/
   ```

3. **Incremental Rollback**:
   - Revert specific directories
   - Fix issues
   - Re-apply changes

---

### Backup Strategy

**Before starting**:

```bash
# Create backup branch
git checkout -b backup/pre-restructure

# Commit current state
git add .
git commit -m "Backup before web folder restructuring"

# Create working branch
git checkout -b feature/web-folder-restructure
```

---

## Post-Restructuring Tasks

### Immediate (After Merge)

- [ ] Update team documentation
- [ ] Update contributing guidelines
- [ ] Notify team of new structure
- [ ] Update any scripts that reference old paths
- [ ] Update CI/CD if it references specific paths

---

### Short-term (Within 1 Week)

- [ ] Create architecture documentation showing new structure
- [ ] Add ESLint rules to enforce naming conventions
- [ ] Create templates for new files
- [ ] Update onboarding documentation

---

### Long-term (Future)

- [ ] Consider similar restructuring for `apps/server/src`
- [ ] Evaluate if further sub-categorization is needed
- [ ] Monitor if new files follow the structure
- [ ] Refine structure based on team feedback

---

## File Count Summary

### Before Restructuring

```
apps/web/src/ (flat)
├── 90+ files in root directory
└── components/, routes/, hooks/, rpc/ (already organized)
```

### After Restructuring

```
apps/web/src/
├── stores/ (25 files across 5 subdirectories)
├── utils/ (16 files across 9 subdirectories)
├── logic/ (18 files across 7 subdirectories)
├── models/ (7 files across 4 subdirectories)
├── lib/ (4 files in 1 subdirectory)
├── config/ (3 files across 3 subdirectories)
├── components/ (existing)
├── routes/ (existing)
├── hooks/ (existing)
├── rpc/ (existing)
└── 4 entry point files in root
```

**Total**: ~73 files reorganized into logical groups

---

## Naming Convention Reference

### Quick Reference Table

| File Type    | Extension         | Example                   |
| ------------ | ----------------- | ------------------------- |
| Store        | `.store.ts`       | `composer.store.ts`       |
| Store test   | `.store.test.ts`  | `composer.store.test.ts`  |
| Utility      | `.utils.ts`       | `timestamp.utils.ts`      |
| Utility test | `.utils.test.ts`  | `timestamp.utils.test.ts` |
| Logic        | `.logic.ts`       | `session.logic.ts`        |
| Logic test   | `.logic.test.ts`  | `session.logic.test.ts`   |
| Model        | `.models.ts`      | `provider.models.ts`      |
| Model test   | `.models.test.ts` | `provider.models.test.ts` |
| Config       | `.config.ts`      | `branding.config.ts`      |
| Library      | `.lib.ts`         | `icons.lib.ts`            |
| Library test | `.lib.test.ts`    | `icons.lib.test.ts`       |
| Types        | `.types.ts`       | `app.types.ts`            |

---

## Implementation Checklist

### Pre-Migration

- [ ] Create backup branch
- [ ] Notify team of upcoming changes
- [ ] Ensure all current PRs are merged or rebased
- [ ] Run full test suite to ensure starting point is clean

---

### Phase 1: Setup (15 min)

- [ ] Create all new directories
- [ ] Verify directory structure

---

### Phase 2: Stores (1 hour)

- [ ] Move main store files (8 files)
- [ ] Move composer store files (9 files)
- [ ] Move terminal store files (3 files)
- [ ] Move UI store files (2 files)
- [ ] Move thread store files (2 files)
- [ ] Create barrel exports for each store
- [ ] Update imports in moved files
- [ ] Test: `bun typecheck`

---

### Phase 3: Utils (1 hour)

- [ ] Move timestamp utils (2 files)
- [ ] Move markdown utils (2 files)
- [ ] Move terminal utils (4 files)
- [ ] Move diff utils (2 files)
- [ ] Move scroll utils (2 files)
- [ ] Move copy utils (1 file)
- [ ] Move context menu utils (1 file)
- [ ] Move worktree utils (2 files)
- [ ] Move history utils (2 files)
- [ ] Create barrel exports
- [ ] Test: `bun typecheck`

---

### Phase 4: Logic (1 hour)

- [ ] Move session logic (3 files)
- [ ] Move composer logic (4 files)
- [ ] Move orchestration logic (4 files)
- [ ] Move user input logic (2 files)
- [ ] Move proposed plan logic (2 files)
- [ ] Move pull request logic (2 files)
- [ ] Move project scripts logic (2 files)
- [ ] Create barrel exports
- [ ] Test: `bun typecheck`

---

### Phase 5: Models (30 min)

- [ ] Move provider models (3 files)
- [ ] Move types (1 file)
- [ ] Move keybindings (2 files)
- [ ] Move editor models (1 file)
- [ ] Create barrel exports
- [ ] Test: `bun typecheck`

---

### Phase 6: Config (15 min)

- [ ] Move branding config (1 file)
- [ ] Move env config (1 file)
- [ ] Move router config (1 file)
- [ ] Create barrel exports
- [ ] Test: `bun typecheck`

---

### Phase 7: Lib (15 min)

- [ ] Move VSCode icons (4 files)
- [ ] Create barrel exports
- [ ] Test: `bun typecheck`

---

### Phase 8: Update Imports (1-2 hours)

- [ ] Fix all TypeScript errors
- [ ] Update component imports
- [ ] Update route imports
- [ ] Update hook imports
- [ ] Update root file imports
- [ ] Test: `bun typecheck` (should pass)

---

### Phase 9: Barrel Exports (30 min)

- [ ] Create `stores/index.ts`
- [ ] Create `utils/index.ts`
- [ ] Create `logic/index.ts`
- [ ] Create `models/index.ts`
- [ ] Create `lib/index.ts`
- [ ] Create `config/index.ts`
- [ ] Test: Verify exports work

---

### Phase 10: Path Aliases (15 min - Optional)

- [ ] Update `tsconfig.json`
- [ ] Update `vite.config.ts`
- [ ] Test: Build succeeds

---

### Post-Migration

- [ ] Run full test suite: `bun run test`
- [ ] Run build: `bun run build`
- [ ] Run dev server: `bun run dev:web`
- [ ] Manual testing of key features
- [ ] Verify no files left in root src/
- [ ] Update documentation
- [ ] Create PR with detailed description
- [ ] Request team review

---

## Estimated Timeline

| Phase                   | Duration  | Cumulative      |
| ----------------------- | --------- | --------------- |
| Pre-migration           | 15 min    | 15 min          |
| Phase 1: Setup          | 15 min    | 30 min          |
| Phase 2: Stores         | 1 hour    | 1.5 hours       |
| Phase 3: Utils          | 1 hour    | 2.5 hours       |
| Phase 4: Logic          | 1 hour    | 3.5 hours       |
| Phase 5: Models         | 30 min    | 4 hours         |
| Phase 6: Config         | 15 min    | 4.25 hours      |
| Phase 7: Lib            | 15 min    | 4.5 hours       |
| Phase 8: Imports        | 1-2 hours | 5.5-6.5 hours   |
| Phase 9: Barrel Exports | 30 min    | 6-7 hours       |
| Phase 10: Path Aliases  | 15 min    | 6.25-7.25 hours |
| Testing & Validation    | 30 min    | 6.75-7.75 hours |

**Total Estimated Time**: 6-8 hours

---

**Document Version**: 1.0  
**Last Updated**: April 6, 2026  
**Author**: bigbud Team  
**Status**: Ready for Implementation
