import {
  isMobileGatewayOwnerAvailable,
  assertMobileGatewayOwnerAvailable,
  waitForMobileGatewayOwnerOperations,
} from "./mobileGatewayLifecycle";
import {
  runMobileGatewayPreparation,
  waitForMobileGatewayPreparation,
  mobileGatewayPreparationFailed,
} from "./mobileGatewayPreparation";
import { randomBytes } from "node:crypto";
import * as FS from "node:fs";
import * as Path from "node:path";
import type { MobileGatewaySupervisor } from "./mobileGatewaySupervisor";
import type { attachMobileGatewayToServe as AttachMobileGatewayToServe } from "./mobileGatewayServe";
import type { ServeOwnershipStore } from "./tailscaleRemoteAccess.ownership";
import { MOBILE_GATEWAY_CREDENTIAL_ENV } from "../constants/mobileGateway";

let active: {
  supervisor: MobileGatewaySupervisor;
  credential: string;
  port: number;
  externalOrigin: string;
} | null = null;

let candidate: MobileGatewaySupervisor | null = null;
let preparing: Promise<number | null> | null = null;
let stopping = false;
let retrying: Promise<void> | null = null;
let lifecycleEpoch = 0;
const mayStart = () => !stopping && isMobileGatewayOwnerAvailable();

/** Explicit development opt-in only. Shipping/artifact discovery waits for P6. */
export function prepareDesktopMobileGateway(input: {
  readonly serverSettingsPath: string;
  readonly backendPort: number;
  readonly backendHost: string;
  readonly externalOrigin: string;
  readonly ownership: ServeOwnershipStore;
  readonly env?: NodeJS.ProcessEnv;
  readonly createSupervisor?: (
    config: ConstructorParameters<typeof MobileGatewaySupervisor>[0],
  ) => MobileGatewaySupervisor;
  readonly runServe?: Parameters<typeof AttachMobileGatewayToServe>[0]["run"];
}): Promise<number | null> {
  if (preparing) return preparing;
  if (!mayStart()) return Promise.reject(new Error("Mobile gateway owner is stopping."));
  preparing = prepare(input).finally(() => {
    preparing = null;
  });
  return preparing;
}

async function prepare(
  input: Parameters<typeof prepareDesktopMobileGateway>[0],
): Promise<number | null> {
  // A failed cleanup retains its child handle. Never replace it without confirmed exit.
  if (candidate) {
    await candidate.stop();
    candidate = null;
  }
  if (!mayStart()) throw new Error("Mobile gateway owner is stopping.");
  const env = input.env ?? process.env;
  const binary = env.BIGBUD_MOBILE_GATEWAY_BINARY;
  if (!binary) return null;
  // The prototype upstream is deliberately fixed to IPv4 loopback.
  if (!["127.0.0.1", "0.0.0.0"].includes(input.backendHost))
    throw new Error("Mobile gateway requires an IPv4 loopback-compatible backend bind.");
  // No new consent by merely discovering an installed artifact. Both local mobile
  // consent and an existing owned Serve mapping are required for boot migration.
  const settings = JSON.parse(FS.readFileSync(input.serverSettingsPath, "utf8"));
  if (settings.mobileRemoteControl?.enabled !== true || input.ownership.read() === null)
    return null;
  if (!Path.isAbsolute(binary) || !FS.existsSync(binary))
    throw new Error("Mobile gateway prototype binary is unavailable.");
  const assetsDir = env.BIGBUD_MOBILE_GATEWAY_ASSETS_DIR;
  if (
    !assetsDir ||
    !Path.isAbsolute(assetsDir) ||
    !FS.existsSync(Path.join(assetsDir, "index.html"))
  )
    throw new Error("Mobile gateway prototype assets are unavailable.");
  const origin = new URL(input.externalOrigin);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  )
    throw new Error("Mobile gateway requires a private HTTPS origin.");
  if (active) return active.port;
  const { hasDesktopServeTarget } = await import("./tailscaleRemoteAccess");
  const ownedPort = input.ownership.read();
  if (ownedPort === null || !(await hasDesktopServeTarget(ownedPort, input.runServe))) return null;
  const { resolveMobileGatewayEndpoint } = await import("./mobileGatewayEndpoint");
  const { attachMobileGatewayToServe } = await import("./mobileGatewayServe");
  const { MobileGatewaySupervisor } = await import("./mobileGatewaySupervisor");
  const port = await resolveMobileGatewayEndpoint(Path.dirname(input.serverSettingsPath), 4773);
  if (port === input.backendPort)
    throw new Error("Mobile gateway endpoint conflicts with backend.");
  const credential = randomBytes(32).toString("hex");
  const supervisor = (
    input.createSupervisor ??
    ((config) => new MobileGatewaySupervisor(config, { allowed: mayStart }))
  )({
    binary,
    assetsDir,
    port,
    backendPort: input.backendPort,
    externalOrigin: origin.origin,
    credential,
  });
  if (!mayStart()) throw new Error("Mobile gateway owner is stopping.");
  candidate = supervisor;
  await attachMobileGatewayToServe({
    port,
    ownership: input.ownership,
    start: async () => {
      await supervisor.start(mayStart);
      if (!mayStart()) throw new Error("Mobile gateway owner is stopping.");
    },
    assertCanMutate: () => {
      if (!mayStart()) throw new Error("Mobile gateway owner is stopping.");
    },
    stop: () => supervisor.stop(),
    run: input.runServe,
  });
  if (!mayStart()) {
    await supervisor.stop();
    throw new Error("Mobile gateway owner is stopping.");
  }
  active = { supervisor, credential, port, externalOrigin: origin.origin };
  candidate = null;
  return port;
}

export function desktopMobileGatewayEnvironment(): NodeJS.ProcessEnv {
  return active ? { [MOBILE_GATEWAY_CREDENTIAL_ENV]: active.credential } : {};
}
export function desktopMobileGatewayOrigin(): string | null {
  return active?.externalOrigin ?? null;
}
export function desktopMobileGatewayPort(): number | null {
  return active?.port ?? null;
}
export async function ensureDesktopMobileGateway(): Promise<void> {
  if (!mayStart()) return;
  try {
    if (active) await active.supervisor.start(mayStart);
    else await runMobileGatewayPreparation();
  } catch {
    console.error("[desktop] mobile gateway unavailable; desktop backend continues.");
  }
}

export function stopDesktopMobileGateway(): void {
  void stopDesktopMobileGatewayAndWait().catch(() =>
    console.error("[desktop] mobile gateway shutdown was not confirmed."),
  );
}
export async function stopDesktopMobileGatewayAndWait(): Promise<void> {
  stopping = true;
  lifecycleEpoch++;
  await candidate?.stop();
  await waitForMobileGatewayPreparation();
  await preparing?.catch(() => undefined);
  await active?.supervisor.stop();
  await retrying?.catch(() => undefined);
  await waitForMobileGatewayOwnerOperations();
  stopping = false;
}

export function desktopMobileGatewayStatus() {
  return (
    active?.supervisor.getStatus() ?? (mobileGatewayPreparationFailed() ? "needs-repair" : null)
  );
}
export async function retryDesktopMobileGateway(): Promise<void> {
  assertMobileGatewayOwnerAvailable();
  if (stopping || !active) return;
  if (retrying) return retrying;
  const epoch = lifecycleEpoch;
  retrying = active.supervisor
    .retry(() => mayStart() && lifecycleEpoch === epoch)
    .finally(() => {
      retrying = null;
    });
  return retrying;
}
