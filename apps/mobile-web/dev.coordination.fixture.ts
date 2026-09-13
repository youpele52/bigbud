// Disposable child-process fixture; never starts the desktop app or backend.
import { createDevPortCoordinator } from "@bigbud/shared/DevPortCoordinator";
import { createMobileDevRegistry } from "@bigbud/shared/DevMobileRegistry";
import path from "node:path";
import { createServer, type ViteDevServer } from "vite";

import { reserveWebDevPort } from "../web/dev.ports.ts";
import { mobileDiscoveryPlugin } from "../web/src/dev/mobileDiscoveryPlugin.ts";
import { listenMobileDevServer } from "./dev.listener.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";

const [role, root, candidate] = process.argv.slice(2);
if (!root || !candidate) throw new Error("Missing fixture arguments");
const coordinator = await createDevPortCoordinator(root, path.join(root, "ports"));
const registry = await createMobileDevRegistry(root, "0", path.join(root, "registry"));
const config = {
  root,
  configFile: false as const,
  logLevel: "silent" as const,
  server: { host: "127.0.0.1", hmr: false as const, watch: null, strictPort: true },
  optimizeDeps: { noDiscovery: true, include: [] },
};
let server: ViteDevServer | undefined;
let release: (() => Promise<void>) | undefined;
let binding: Promise<void> | undefined;
let selected = Number(candidate);
function bound() {
  const address = server?.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture listener");
  process.send?.({ status: "bound", port: address.port });
}

process.on("message", (message) => {
  if (message === "bind" && role === "web") {
    binding = (async () => {
      server = await createServer({
        ...config,
        server: { ...config.server, port: selected },
        plugins: [mobileDiscoveryPlugin(root, registry)],
      });
      await server.listen();
      bound();
    })().catch((error: unknown) => {
      process.send?.({ status: "error", error: String(error) });
    });
  }
  if (message === "stop") {
    void (async () => {
      await binding;
      await server?.close();
      await release?.();
      process.disconnect();
    })();
  }
});

if (role === "web") {
  const lease = await reserveWebDevPort(coordinator, selected);
  selected = lease.reservation.port;
  release = lease.release;
  process.send?.({ status: "reserved", port: selected });
} else {
  server = await listenMobileDevServer(
    selected,
    undefined,
    {
      ...config,
      plugins: [mobileDevRegistryPlugin(registry)],
    },
    coordinator,
  );
  bound();
}
