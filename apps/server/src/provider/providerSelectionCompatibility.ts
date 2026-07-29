import { Schema } from "effect";

import {
  PersistedModelSelection as ContractsPersistedModelSelection,
  PROVIDER_KINDS,
  TrimmedNonEmptyString,
} from "@bigbud/contracts";
import type { ModelSelection, ProviderKind } from "@bigbud/contracts";

/**
 * The provider registry is intentionally narrower than persisted data. A
 * provider can disappear from the registry without making old JSON or event
 * payloads undecodable.
 */
export const PersistedProviderKind = TrimmedNonEmptyString;
export type PersistedProviderKind = typeof PersistedProviderKind.Type;

export const PersistedModelSelection = ContractsPersistedModelSelection;
export type PersistedModelSelection = typeof PersistedModelSelection.Type;

export const ProviderSelectionDisposition = Schema.Literals(["routable", "requires-reselection"]);
export type ProviderSelectionDisposition = typeof ProviderSelectionDisposition.Type;

export type ProviderSelectionInventory = {
  readonly provider: PersistedProviderKind;
  readonly model: string;
  readonly selection: PersistedModelSelection;
  readonly disposition: ProviderSelectionDisposition;
  readonly reason: string | null;
};

export type ProviderSelectionQuarantine = ProviderSelectionInventory & {
  readonly disposition: "requires-reselection";
  readonly reason: string;
};

function asSelection(value: unknown): PersistedModelSelection | null {
  const result = Schema.decodeUnknownExit(PersistedModelSelection)(value);
  return result._tag === "Success" ? result.value : null;
}

export function currentProviderSet(
  providers: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>,
): ReadonlySet<string> {
  return providers instanceof Set ? providers : new Set(providers);
}

export function inventoryProviderSelection(input: {
  readonly selection: unknown;
  readonly currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>;
}): ProviderSelectionInventory | null {
  const selection = asSelection(input.selection);
  if (!selection) return null;

  const available = currentProviderSet(input.currentProviders);
  if (available.has(selection.provider)) {
    return {
      provider: selection.provider,
      model: selection.model,
      selection,
      disposition: "routable",
      reason: null,
    };
  }

  return {
    provider: selection.provider,
    model: selection.model,
    selection,
    disposition: "requires-reselection",
    reason: `Provider '${selection.provider}' is not available in the current provider registry.`,
  };
}

export function quarantineProviderSelection(input: {
  readonly selection: unknown;
  readonly currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>;
}): ProviderSelectionQuarantine | null {
  const inventory = inventoryProviderSelection(input);
  return inventory?.disposition === "requires-reselection"
    ? {
        ...inventory,
        disposition: "requires-reselection",
        reason: inventory.reason ?? "Provider requires reselection.",
      }
    : null;
}

/** Inventory a project/thread selection without replacing it with Codex. */
export function inventoryProjectOrThreadSelection(input: {
  readonly ownerKind: "project" | "thread";
  readonly ownerId: string;
  readonly selection: unknown;
  readonly currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>;
}): ProviderSelectionInventory | null {
  return inventoryProviderSelection(input);
}

/** Inventory a provider-session binding and its resume cursor losslessly. */
export function inventoryProviderSessionBinding(input: {
  readonly provider: string;
  readonly model?: string | null;
  readonly resumeCursor?: unknown;
  readonly currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>;
}): ProviderSelectionInventory {
  const selection: PersistedModelSelection = {
    provider: input.provider,
    model: input.model?.trim() || "unknown",
    ...(input.resumeCursor !== undefined ? { options: input.resumeCursor } : {}),
  };
  return (
    inventoryProviderSelection({
      selection,
      currentProviders: input.currentProviders,
    }) ?? {
      provider: input.provider,
      model: selection.model,
      selection,
      disposition: "requires-reselection",
      reason: `Provider '${input.provider}' has an invalid persisted selection.`,
    }
  );
}

/** Learning jobs must be resumed only after the user chooses a live provider. */
export function inventoryLearningJobSelection(input: {
  readonly provider: string;
  readonly model: string;
  readonly selection: unknown;
  readonly currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>;
}): ProviderSelectionInventory | null {
  return inventoryProviderSelection({
    selection: input.selection ?? { provider: input.provider, model: input.model },
    currentProviders: input.currentProviders,
  });
}

export function isRoutableProviderSelection(
  selection: ModelSelection | PersistedModelSelection,
  currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>,
): selection is ModelSelection {
  return currentProviderSet(currentProviders).has(selection.provider);
}

export function requiresProviderReselection(
  selection: unknown,
  currentProviders: ReadonlyArray<ProviderKind | string> | ReadonlySet<string>,
): boolean {
  return quarantineProviderSelection({ selection, currentProviders }) !== null;
}

/**
 * Replace removed-provider selections only in a validation copy. Callers can
 * validate the surrounding persisted payload without mutating its inventory.
 */
export function normalizeRemovedProviderSelectionsForValidation(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeRemovedProviderSelectionsForValidation);
  }
  if (value === null || typeof value !== "object") return value;

  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [
      key,
      normalizeRemovedProviderSelectionsForValidation(entry),
    ]),
  );
  if (
    typeof record.provider === "string" &&
    typeof record.model === "string" &&
    !PROVIDER_KINDS.includes(record.provider as ProviderKind)
  ) {
    normalized.provider = "codex";
    delete normalized.options;
    delete normalized.subProviderID;
  }
  return normalized;
}
