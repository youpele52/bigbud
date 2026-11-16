import { isOwnershipHandedOff } from "./ownershipHandoff";
import { isInstalledProcessQuiescing } from "./installedProcessQuiescence";

let getIsQuitting = () => false;
const operations = new Set<Promise<unknown>>();

export function configureMobileGatewayLifecycle(isQuitting: () => boolean): void {
  getIsQuitting = isQuitting;
}

export function isMobileGatewayOwnerAvailable(): boolean {
  return !getIsQuitting() && !isOwnershipHandedOff() && !isInstalledProcessQuiescing();
}

export function assertMobileGatewayOwnerAvailable(): void {
  if (!isMobileGatewayOwnerAvailable())
    throw new Error(
      "Mobile access cannot change after this desktop has yielded or begun shutting down.",
    );
}

export async function runMobileGatewayOwnerOperation<T>(operation: () => Promise<T>): Promise<T> {
  assertMobileGatewayOwnerAvailable();
  const pending = operation();
  operations.add(pending);
  try {
    return await pending;
  } finally {
    operations.delete(pending);
  }
}

export async function waitForMobileGatewayOwnerOperations(): Promise<void> {
  while (operations.size) await Promise.allSettled(operations);
}
