import { createServer, type InlineConfig, type ViteDevServer } from "vite";
import type { DevPortCoordinator } from "@bigbud/shared/DevPortCoordinator";

import { isMobileDevPortAvailable } from "./dev.listener.ports.ts";
import { MobileDevPortUnavailable, mobilePortCoordinationPlugin } from "./dev.coordination.ts";

export function parseMobileDevPort(value: string | undefined, fallback: number): number {
  const port = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Mobile development port must be an integer between 1 and 65535");
  }
  return port;
}

export async function listenMobileDevServer(
  startPort: number,
  siblingWebPort: number | undefined,
  config: InlineConfig = {},
  coordinator?: DevPortCoordinator,
): Promise<ViteDevServer> {
  parseMobileDevPort(String(startPort), startPort);
  for (let port = startPort; port <= 65535; port++) {
    if (port === siblingWebPort) continue;
    if (!(await isMobileDevPortAvailable(port))) continue;
    const server = await createServer({
      ...config,
      plugins: [
        ...(config.plugins ?? []),
        ...(coordinator ? [mobilePortCoordinationPlugin(coordinator, siblingWebPort)] : []),
      ],
      server: { ...config.server, port, strictPort: true },
    });
    let addressInUse = false;
    const onError = (error: NodeJS.ErrnoException) => {
      addressInUse = error.code === "EADDRINUSE";
    };
    const httpServer = server.httpServer;
    httpServer?.on("error", onError);
    try {
      await server.listen();
      return server;
    } catch (error) {
      await server.close();
      if (!addressInUse && !(error instanceof MobileDevPortUnavailable)) throw error;
      server.config.logger.info(`Mobile development port ${port} is in use, trying another port…`);
    } finally {
      httpServer?.off("error", onError);
    }
  }
  throw new Error(`No mobile development port available between ${startPort} and 65535`);
}
