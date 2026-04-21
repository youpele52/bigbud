# @bigbud/contracts

Shared contracts, types, and constants for the bigbud application.

## Import Patterns

This package supports **two import patterns**. Direct imports are recommended for new code.

### ✅ Recommended: Direct Imports

Import directly from source modules for explicit dependencies:

```typescript
// Constants
import { PROVIDERS } from "@bigbud/contracts/constants/provider.constant";
import { DEFAULT_MODEL } from "@bigbud/contracts/constants/model.constant";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant";

// Core types
import { ModelSelection } from "@bigbud/contracts/core/model";
import { ClientSettings } from "@bigbud/contracts/core/settings";

// Orchestration
import { ProviderKind } from "@bigbud/contracts/orchestration/provider";
import { RuntimeMode } from "@bigbud/contracts/orchestration/orchestration";

// Server
import { RpcMethod } from "@bigbud/contracts/server/rpc";

// Workspace
import { GitStatus } from "@bigbud/contracts/workspace/git";
```

**Benefits**:

- ✅ Explicit dependencies - clear which module exports what
- ✅ Better IDE support - jump-to-definition goes directly to source
- ✅ Faster builds - bundler only processes what you import
- ✅ No maintenance overhead - no barrel file to update

### Legacy: Barrel Import

The barrel export is still supported for backward compatibility:

```typescript
// Works, but not recommended for new code
import { PROVIDERS, DEFAULT_MODEL, ProviderKind } from "@bigbud/contracts";
```

**Drawbacks**:

- ❌ Unclear which module exports what
- ❌ Requires maintaining barrel export file
- ❌ Slower builds (processes entire barrel)

## Folder Structure

```
packages/contracts/src/
├── constants/       # Application constants
│   ├── provider.constant.ts
│   ├── model.constant.ts
│   ├── websocket.constant.ts
│   ├── runtime.constant.ts
│   ├── terminal.constant.ts
│   ├── settings.constant.ts
│   ├── storage.constant.ts
│   ├── git.constant.ts
│   └── providerRuntime.constant.ts
├── core/           # Core types and schemas
│   ├── baseSchemas.ts
│   ├── model.ts
│   └── settings.ts
├── orchestration/  # Orchestration types
│   ├── provider.ts
│   ├── providerRuntime.ts
│   └── orchestration.ts
├── server/         # Server-related types
│   ├── ipc.ts
│   ├── keybindings.ts
│   ├── server.ts
│   └── rpc.ts
└── workspace/      # Workspace types
    ├── terminal.ts
    ├── git.ts
    ├── editor.ts
    └── project.ts
```

## Migration Guide

When touching existing files, consider migrating from barrel to direct imports:

**Before**:

```typescript
import { PROVIDERS, ProviderKind, ModelSelection } from "@bigbud/contracts";
```

**After**:

```typescript
import { PROVIDERS } from "@bigbud/contracts/constants/provider.constant";
import { ProviderKind } from "@bigbud/contracts/orchestration/provider";
import { ModelSelection } from "@bigbud/contracts/core/model";
```

This migration is **optional** and can be done incrementally as files are modified.
