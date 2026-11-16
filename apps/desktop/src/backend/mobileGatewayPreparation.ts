import { MOBILE_GATEWAY_POLICY } from "../constants/mobileGateway";

/** Retain opt-in across failed starts, including a candidate losing the stable port. */
let prepare: (() => Promise<void>) | null = null;
let pending: Promise<void> | null = null;
let attempts: number[] = [];
let failed = false;

export function configureMobileGatewayPreparation(operation: () => Promise<void>): void {
  prepare = operation;
  attempts = [];
  failed = false;
}

export function mobileGatewayPreparationFailed(): boolean {
  return failed;
}

export async function runMobileGatewayPreparation(explicitRetry = false): Promise<void> {
  if (!prepare) return;
  if (pending) return pending;
  const now = Date.now();
  attempts = explicitRetry
    ? []
    : attempts.filter((time) => now - time < MOBILE_GATEWAY_POLICY.crashWindowMs);
  if (attempts.length >= MOBILE_GATEWAY_POLICY.maxCrashRestarts) {
    failed = true;
    throw new Error("Mobile gateway preparation needs an explicit retry.");
  }
  attempts.push(now);
  pending = prepare()
    .then(() => {
      failed = false;
    })
    .catch((error: unknown) => {
      failed = true;
      throw error;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}

export async function waitForMobileGatewayPreparation(): Promise<void> {
  await pending?.catch(() => undefined);
}
