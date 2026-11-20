/**
 * Pure readiness classification for provider provisioning (WP-5C).
 *
 * Installation is decided here from what bigbud can see on the host (the resolved executable,
 * the graph closure or the managed Copilot runtime). Authentication is never re-implemented:
 * it comes from the snapshot produced by the recipe's referenced readiness check
 * (`recipe.authReadiness`), as published by the provider registry.
 */
import type { ServerProvider } from "@bigbud/contracts";
import type {
  ProviderProvisioningEntry,
  ProviderProvisioningState,
  ProviderProvisionOutcome,
} from "@bigbud/contracts/server/providerProvisioning.ts";

import type { ProviderRecipe } from "./recipe.ts";

export type ExecutableSource = NonNullable<ProviderProvisioningEntry["executableSource"]>;

export type InstallFinding =
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "missing"; readonly message: string }
  | { readonly kind: "present"; readonly path: string | null; readonly source: ExecutableSource };

export function classifyProvisioningState(
  install: InstallFinding,
  snapshot: ServerProvider | undefined,
): { readonly state: ProviderProvisioningState; readonly message: string | null } {
  if (install.kind === "unsupported") return { state: "unsupported", message: install.message };
  if (install.kind === "missing") return { state: "missing", message: install.message };
  if (snapshot === undefined) {
    return { state: "unknown", message: "No readiness result has been published yet." };
  }
  if (!snapshot.enabled) return { state: "disabled", message: snapshot.message ?? null };
  // The readiness check ran the tool and could not find or start it.
  if (!snapshot.installed) {
    return {
      state: "missing",
      message: snapshot.message ?? "The readiness check found no install.",
    };
  }
  if (snapshot.auth.status === "unauthenticated") {
    return { state: "needs-auth", message: snapshot.message ?? null };
  }
  if (snapshot.status === "ready" || snapshot.status === "warning") {
    return { state: "ready", message: snapshot.message ?? null };
  }
  return { state: "unknown", message: snapshot.message ?? null };
}

/** What the provision action reports for a state it did not change. */
export function outcomeForState(state: ProviderProvisioningState): ProviderProvisionOutcome {
  switch (state) {
    case "missing":
      return "needs-install";
    case "needs-auth":
      return "needs-auth";
    case "unsupported":
      return "unsupported";
    case "ready":
    case "disabled":
    case "unknown":
      return "available";
  }
}

export function buildProvisioningEntry(
  recipe: ProviderRecipe,
  install: InstallFinding,
  snapshot: ServerProvider | undefined,
): ProviderProvisioningEntry {
  const { state, message } = classifyProvisioningState(install, snapshot);
  return {
    provider: recipe.kind,
    displayName: recipe.displayName,
    provisionedBy: recipe.provisionedBy,
    state,
    executablePath: install.kind === "present" ? install.path : null,
    executableSource: install.kind === "present" ? install.source : null,
    authStep: recipe.authReadiness.userStep,
    authCheck: `${recipe.authReadiness.module}#${recipe.authReadiness.exportName}`,
    manualCommands: [...recipe.manual.installCommands],
    docsUrl: recipe.manual.docsUrl ?? null,
    message,
  };
}
