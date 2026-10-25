import type { Scope } from "@bigbud/contracts/terminal-owner/identity";
import { encodeCanonical } from "./canonical";
import { equalBytes } from "./canonical.validation";
import { OwnerShutdownInventoryModel } from "./shutdownInventory.model";
import type { OwnerShutdownInventory } from "@bigbud/contracts/terminal-owner/shutdown";

export type OwnerOperation =
  | "commitRoot"
  | "status"
  | "pulse"
  | "issueGrant"
  | "replaceController"
  | "activateController"
  | "hostLaunch"
  | "beginQuiesce"
  | "cleanup"
  | "spawn"
  | "input"
  | "resize"
  | "close"
  | "relay"
  | "source"
  | "checkpoint"
  | "response"
  | "domainSettlement";
export interface OwnerPermissionContext {
  readonly role: number;
  readonly disposition: "candidate" | "statusOnly" | "currentMain" | "active" | "dormant";
  readonly use: number;
  readonly currentFences: boolean;
  readonly quiescing: boolean;
  readonly controllerActive: boolean;
  readonly scope?: Scope;
  readonly shutdownInventory?: OwnerShutdownInventory;
}
const ptyCaps: Partial<Record<OwnerOperation, Scope["capabilities"][number]>> = {
  input: 2,
  resize: 3,
  close: 4,
  relay: 5,
  source: 6,
  checkpoint: 7,
  response: 8,
};

/** Semantic-family matrix only; typed op/lane dispatch and admission remain deferred. */
export function ownerPermission(
  context: OwnerPermissionContext,
  operation: OwnerOperation,
  pty?: { id: Uint8Array; epoch: Uint8Array; generation: string },
): boolean {
  if (!context.currentFences) return false;
  if (context.role === 1) {
    if (context.disposition === "candidate")
      return operation === "commitRoot" || operation === "status";
    if (context.disposition === "statusOnly") return operation === "status";
    if (context.disposition !== "currentMain") return false;
    if (operation === "status" || operation === "pulse") return true;
    if (context.quiescing) return operation === "cleanup";
    return (
      context.use === 1 &&
      [
        "issueGrant",
        "replaceController",
        "activateController",
        "hostLaunch",
        "beginQuiesce",
      ].includes(operation)
    );
  }
  const scope = context.scope;
  if (!scope || scope.role !== context.role || scope.use !== context.use) return false;
  encodeCanonical("Scope", scope);
  if (context.role === 4) {
    if (!context.shutdownInventory) return false;
    try {
      const owner = new OwnerShutdownInventoryModel(context.shutdownInventory);
      owner.authorizeScope(scope);
      if (pty) {
        if (!equalBytes(pty.epoch, context.shutdownInventory.binding.ownerEpoch)) return false;
        owner.authorizePty(scope, pty.id, pty.generation);
      }
    } catch {
      return false;
    }
  }
  if (context.disposition === "dormant") return operation === "status";
  if (context.disposition !== "active") return false;
  if (operation === "status") return scope.capabilities.includes(9);
  if (context.role === 4)
    return (
      context.quiescing &&
      operation === "domainSettlement" &&
      scope.use === 3 &&
      scope.capabilities.includes(10)
    );
  if (context.quiescing) return context.role === 2 && operation === "domainSettlement";
  if (scope.use !== 1 || (context.role === 2 && !context.controllerActive)) return false;
  if (operation === "spawn")
    return context.role === 2 && scope.createBudget > 0 && scope.capabilities.includes(1);
  const cap = ptyCaps[operation];
  if (!cap || !pty || !scope.capabilities.includes(cap)) return false;
  return scope.ptys.some(
    (entry) =>
      equalBytes(entry.ptyId, pty.id) &&
      equalBytes(entry.ownerEpoch, pty.epoch) &&
      entry.terminalGeneration === pty.generation &&
      entry.capabilities.includes(cap),
  );
}
