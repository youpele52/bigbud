import { fileURLToPath } from "node:url";

import { createMobileDevRegistry } from "@bigbud/shared/DevMobileRegistry";
import { createDevPortCoordinator } from "@bigbud/shared/DevPortCoordinator";

import { listenMobileDevServer, parseMobileDevPort } from "./dev.listener.ts";
import { MOBILE_DEV_HELP, parseMobileDevOptions } from "./dev.options.ts";
import { mobileDevRegistryPlugin } from "./dev.registry.ts";
import { resolveMobileDevRepoRoot } from "./dev.identity.ts";

const options = parseMobileDevOptions(process.argv.slice(2));
if (options.help) {
  console.log(MOBILE_DEV_HELP);
  process.exit(0);
}
const repoRoot = await resolveMobileDevRepoRoot(
  fileURLToPath(new URL("../..", import.meta.url)),
  process.env.BIGBUD_DEV_REPO_ROOT,
);
const registry = await createMobileDevRegistry(repoRoot);
const coordinator = await createDevPortCoordinator(repoRoot);
const siblingWebPort =
  process.env.BIGBUD_DEV_WEB_PORT === undefined
    ? undefined
    : parseMobileDevPort(process.env.BIGBUD_DEV_WEB_PORT, 0);
const server = await listenMobileDevServer(
  options.port,
  siblingWebPort,
  {
    configFile: fileURLToPath(new URL("./vite.config.ts", import.meta.url)),
    ...options.config,
    plugins: [mobileDevRegistryPlugin(registry)],
  },
  coordinator,
);
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  try {
    await server.close();
  } finally {
    process.exit();
  }
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
server.printUrls();
server.bindCLIShortcuts({ print: true });
