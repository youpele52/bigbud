# Runtime modes

The chat access menu offers three runtime modes. They are stored on the thread and sent with orchestration commands; see the [`RuntimeMode` contract](../../packages/contracts/src/constants/runtime.constant.ts) and the [access menu](../../apps/web/src/components/chat/common/CompactComposerControlsMenu.tsx).

- **Supervised** (`approval-required`): actions require user approval.
- **Auto-accept edits** (`auto-accept-edits`): supported file edits may be accepted automatically; other actions still require approval. The exact boundary depends on the provider and workspace/connection mode.
- **Full access** (`full-access`): gives the provider the broadest access supported by its integration. Do not assume this always maps to the same sandbox or approval settings across providers. For example, the OpenCode V2 UI explains that its shared native tools run with host-user filesystem, process, and network access—not in a bigbud sandbox—in [`AccessModeInfoBanner`](../../apps/web/src/components/chat/common/AccessModeInfoBanner.tsx).

The default runtime mode for new threads is `full-access`, as defined by `DEFAULT_RUNTIME_MODE` in the runtime contract. Provider-specific execution policy is implemented by each adapter; the runtime-mode value alone does not describe every provider's concrete permissions.
