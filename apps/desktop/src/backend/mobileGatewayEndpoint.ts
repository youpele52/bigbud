import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { resolveDesktopBackendPort } from "./backendPort";

/** A committed endpoint never silently changes because its port is busy. */
export async function resolveMobileGatewayEndpoint(
  stateDir: string,
  startPort: number,
  selectPort: (port: number) => Promise<number> = (port) =>
    resolveDesktopBackendPort({ host: "127.0.0.1", startPort: port }),
): Promise<number> {
  const file = Path.join(stateDir, "mobile-gateway-endpoint.json");
  try {
    const record: unknown = JSON.parse(await FS.readFile(file, "utf8"));
    const port = (record as { port?: unknown })?.port;
    if (
      (record as { version?: unknown })?.version !== 1 ||
      typeof port !== "number" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535
    )
      throw new Error("Invalid mobile gateway endpoint record.");
    return port;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const port = await selectPort(startPort);
  await FS.mkdir(stateDir, { recursive: true });
  // Exclusive creation prevents concurrent owners overwriting an established endpoint.
  try {
    await FS.writeFile(file, JSON.stringify({ version: 1, port }), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return resolveMobileGatewayEndpoint(stateDir, startPort, selectPort);
  }
  return port;
}
