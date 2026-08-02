# Devin CLI & Antigravity CLI Integration Plan

**Date:** 2026-06-10
**Status:** Draft

---

## Recommendation

1. **Devin CLI: integrate via ACP first**
2. **Antigravity CLI: do not ship as a full first-class provider yet** (wait for ACP)
3. **Use direct CLI only for probes/version checks**, not as the main session runtime

## Rationale

This repo already has a reusable ACP substrate and a working ACP-backed provider (Cursor):

- `apps/server/src/provider/acp/AcpSessionRuntime.ts` — core ACP session runtime
- `apps/server/src/provider/Layers/Cursor/Adapter.ts` — Cursor adapter backed by ACP
- `apps/server/src/provider/acp/CursorAcpSupport.ts` — Cursor-specific ACP bootstrap

**Devin** officially exposes `devin acp` (runs an ACP server over stdio).
**Antigravity** does not appear to expose ACP yet — the public request is still open.

Building Antigravity on raw CLI would produce a stateless, degraded provider (weak streaming, awkward approvals, no resume). This conflicts with bigbud's priorities of reliability and predictable behavior under failures/load.

---

## Phase 1: Extract Generic ACP Provider Base

Stop treating ACP as "Cursor-specific". Create a reusable ACP adapter scaffold from:

- `apps/server/src/provider/Layers/Cursor/Adapter.ts`
- `apps/server/src/provider/Layers/Cursor/Adapter.startSession.ts`
- `apps/server/src/provider/acp/`

**New generic components:**

- `apps/server/src/provider/acp/AcpProviderAdapter.ts` — generic adapter implementation (`ProviderAdapterShape`) parameterized by provider kind
- `apps/server/src/provider/acp/AcpProviderSupport.ts` — spawn command builder, auth method selection, session/update mapping, model/config-option discovery
- `apps/server/src/provider/acp/AcpProviderExtension.ts` — provider-specific extension handlers

**Outcome:** Cursor keeps using it, Devin plugs into it, Antigravity can later plug into it when ACP exists.

## Phase 2: Add Devin Provider

### Contracts / Types

- `packages/contracts/src/constants/provider.constant.ts` — add `devin` to `ProviderKind`
- `packages/contracts/src/constants/model.constant.ts` — add Devin model constants
- `packages/contracts/src/core/model.ts` — add Devin to provider model unions
- `packages/contracts/src/core/settings.ts` — add Devin settings schema
- `packages/contracts/src/orchestration/orchestration.provider.ts` — add Devin to provider union types

### Server — Provider Layer

- `apps/server/src/provider/Layers/ProviderRegistry.ts` — register Devin provider
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` — register Devin adapter
- `apps/server/src/provider/Layers/Devin/Adapter.ts` — main adapter (backed by ACP generic base)
- `apps/server/src/provider/Layers/Devin/Provider.ts` — probe, status, model discovery
- `apps/server/src/provider/Layers/Devin/Provider.shared.ts` — shared constants
- `apps/server/src/provider/Layers/Devin/Provider.config.ts` — config option resolution
- `apps/server/src/provider/Layers/Devin/Provider.discovery.ts` — ACP model discovery
- `apps/server/src/provider/Layers/Devin/ProviderDevinSupport.ts` — Devin-specific ACP bootstrap

### Implementation Details

- Provider probe via `devin --version` and minimal auth/status detection
- Session runtime via `devin acp`
- Model/config discovery through ACP initialize/session config options
- Baseline support: start, prompt, cancel, permission/user-input, resume

### Web UI — Settings & Discovery

- `apps/web/src/components/settings/ProvidersSettingsSection.tsx`
- `apps/web/src/components/settings/ProvidersSettingsSection.logic.ts`
- `apps/web/src/components/settings/ProviderCard.tsx`
- `apps/web/src/components/chat/provider/ProviderModelPicker.modelList.tsx`
- `apps/web/src/components/chat/provider/TraitsPicker.logic.ts`

Keep UI minimal initially unless Devin exposes stable config options worth surfacing.

## Phase 3: Antigravity (Conditional)

### Phase A (Now)

- Add only a placeholder settings/probe layer for visibility in UI
- Do **not** make it selectable as a production provider yet

### Phase B (Later — when ACP ships)

- Implement as another ACP-backed provider using the generic base from Phase 1
- Follow same pattern as Devin

### If shipping earlier is required

Gate behind explicit `antigravityExperimental` flag:

- One-shot only
- No resume guarantee
- No mid-turn approvals
- No parity promise with other providers

---

## Implementation Order

```
Phase 1: ACP abstraction first
  → Extract generic ACP adapter from Cursor
  → Verify Cursor still works

Phase 2: Devin second
  → Contracts/types
  → Server provider layer
  → ACP-backed adapter
  → Web UI wiring
  → Tests

Phase 3: Antigravity later (when ACP is real)
  → Reuse generic ACP adapter
  → Contracts/types
  → Server provider layer
  → Web UI wiring
```

## Testing & Acceptance Gates

New tests should mirror Cursor coverage:

- Probe/status
- Start session
- Send turn
- Permission flow
- User input flow
- Resume/cancel behavior
- Settings resolution/fallback ordering

**Required checks before completion:**

- `bun fmt`
- `bun lint`
- `bun typecheck`

---

## Key Files to Touch

### Contracts

| File                                                             | Change                                  |
| ---------------------------------------------------------------- | --------------------------------------- |
| `packages/contracts/src/constants/provider.constant.ts`          | Add Devin/Antigravity to `ProviderKind` |
| `packages/contracts/src/constants/model.constant.ts`             | Add models                              |
| `packages/contracts/src/core/model.ts`                           | Union types                             |
| `packages/contracts/src/core/settings.ts`                        | Settings schemas                        |
| `packages/contracts/src/orchestration/orchestration.provider.ts` | Provider union types                    |

### Server — Provider Runtime

| File                                                         | Change                          |
| ------------------------------------------------------------ | ------------------------------- |
| `apps/server/src/provider/acp/AcpProviderAdapter.ts`         | **New** — generic ACP adapter   |
| `apps/server/src/provider/acp/AcpProviderSupport.ts`         | **New** — generic support utils |
| `apps/server/src/provider/Layers/Devin/Adapter.ts`           | **New** — Devin adapter         |
| `apps/server/src/provider/Layers/Devin/Provider.ts`          | **New** — Devin provider        |
| `apps/server/src/provider/Layers/Devin/*.ts`                 | **New** — Devin support files   |
| `apps/server/src/provider/Layers/ProviderRegistry.ts`        | Register Devin                  |
| `apps/server/src/provider/Layers/ProviderAdapterRegistry.ts` | Register Devin adapter          |

### Web — UI

| File                                                                      | Change               |
| ------------------------------------------------------------------------- | -------------------- |
| `apps/web/src/components/settings/ProvidersSettingsSection.tsx`           | Add Devin card       |
| `apps/web/src/components/settings/ProvidersSettingsSection.logic.ts`      | Devin settings logic |
| `apps/web/src/components/chat/provider/ProviderModelPicker.modelList.tsx` | Devin models         |
| `apps/web/src/components/chat/provider/TraitsPicker.logic.ts`             | Devin traits         |
