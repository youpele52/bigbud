import { DEFAULT_WEB_PORT } from "@bigbud/shared/DevPorts";

// Vite remains the CLI parser. Read only the port needed before starting it;
// leave every original argument in place, including repeated options.
export function webDevStartPort(args: readonly string[], env: NodeJS.ProcessEnv): number {
  let value = env.PORT ?? String(DEFAULT_WEB_PORT);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") break;
    if (arg === "--port") value = args[++index] ?? "";
    else if (arg?.startsWith("--port=")) value = arg.slice("--port=".length);
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Web development port must be an integer between 1 and 65535");
  }
  return port;
}

export function isWebDevInformationRequest(args: readonly string[]): boolean {
  const end = args.indexOf("--");
  return args
    .slice(0, end < 0 ? args.length : end)
    .some((arg) => ["--help", "-h", "--version", "-v"].includes(arg));
}

export function webDevViteArgs(args: readonly string[], port: number): string[] {
  const end = args.indexOf("--");
  const insertion = end < 0 ? args.length : end;
  // Vite uses the last duplicate option. Insert before the positional separator.
  return [
    ...args.slice(0, insertion),
    "--port",
    String(port),
    "--strictPort",
    ...args.slice(insertion),
  ];
}
