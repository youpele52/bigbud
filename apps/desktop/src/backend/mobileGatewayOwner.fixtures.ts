import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MobileGatewayLaunch } from "./mobileGatewaySupervisor";
import { vi } from "vitest";
const dirs: string[] = [];
export async function cleanupGatewayFixtures() {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}
export async function gatewayOwnerFixture(enabled = true) {
  const dir = await mkdtemp(join(tmpdir(), "gateway-owner-"));
  dirs.push(dir);
  const binary = join(dir, "gateway");
  await writeFile(binary, "fixture");
  await writeFile(join(dir, "index.html"), "fixture mobile");
  const serverSettingsPath = join(dir, "server-settings.json");
  await writeFile(serverSettingsPath, JSON.stringify({ mobileRemoteControl: { enabled } }));
  const { createFileServeOwnershipStore } = await import("./tailscaleRemoteAccess.ownership");
  const ownership = createFileServeOwnershipStore(join(dir, "serve.json"));
  ownership.write(3773);
  let target: number | null = 3773;
  const runServe = vi.fn(async (_bin: string, args: readonly string[]) => {
    if (args[0] === "status")
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          Self: { Online: true, DNSName: "desk.ts.net" },
        }),
        stderr: "",
      };
    if (args[1] === "status")
      return {
        stdout: JSON.stringify({
          Web: {
            "desk.ts.net:443": {
              Handlers: target === null ? {} : { "/": { Proxy: `http://127.0.0.1:${target}` } },
            },
          },
        }),
        stderr: "",
      };
    target = Number(args.at(-1)?.split(":").at(-1));
    return { stdout: "", stderr: "" };
  });
  const supervisor = {
    start: vi.fn(async (): Promise<void> => undefined),
    stop: vi.fn(async (): Promise<void> => undefined),
  };
  const createSupervisor = vi.fn((_config: MobileGatewayLaunch) => supervisor as never);
  const owner = await import("./mobileGatewayOwner");
  return {
    owner,
    setTarget: (port: number) => {
      target = port;
      ownership.write(port);
    },
    removeRoute: () => {
      target = null;
    },
    supervisor,
    createSupervisor,
    input: {
      env: { BIGBUD_MOBILE_GATEWAY_BINARY: binary, BIGBUD_MOBILE_GATEWAY_ASSETS_DIR: dir },
      serverSettingsPath,
      backendPort: 3773,
      backendHost: "127.0.0.1",
      externalOrigin: "https://desk.ts.net",
      ownership,
      createSupervisor,
      runServe,
    },
  };
}
