import { parseArgs } from "node:util";

import { DEFAULT_MOBILE_WEB_PORT } from "@bigbud/shared/DevPorts";
import type { InlineConfig } from "vite";

import { parseMobileDevPort } from "./dev.listener.ts";

export const MOBILE_DEV_HELP = `Usage: bun run dev [--port <port>] [--host [host]] [--mode <mode>]

  --port <port>   Starting port (then MOBILE_WEB_PORT, PORT, or 5740)
  --host [host]  Listen on this host; bare --host uses 0.0.0.0
  --mode, -m     Vite mode
  --open [path]  Open the browser after startup
  --force        Force dependency optimization
  --cors         Enable CORS
  --base <path>  Vite public base path
  --config, -c   Vite configuration file
  --logLevel, -l info | warn | error | silent
  --clearScreen / --no-clearScreen  Control log clearing
  --help, -h     Show this help

Other Vite CLI options and positional arguments are not supported by this launcher.`;

export function parseMobileDevOptions(
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): { port: number; config: InlineConfig; help: boolean } {
  // Vite's host/open options accept a value or a bare flag.
  const normalized = args.map((arg, index) =>
    (arg === "--host" || arg === "--open") &&
    (args[index + 1] === undefined || args[index + 1]?.startsWith("-"))
      ? arg === "--host"
        ? "--host=0.0.0.0"
        : "--open="
      : arg,
  );
  const { values } = parseArgs({
    args: normalized,
    allowPositionals: false,
    strict: true,
    allowNegative: true,
    options: {
      port: { type: "string" },
      host: { type: "string" },
      mode: { type: "string", short: "m" },
      help: { type: "boolean", short: "h" },
      open: { type: "string" },
      force: { type: "boolean" },
      cors: { type: "boolean" },
      base: { type: "string" },
      config: { type: "string", short: "c" },
      logLevel: { type: "string", short: "l" },
      clearScreen: { type: "boolean" },
    },
  });
  for (const key of ["host", "mode"] as const) {
    if (values[key] !== undefined && values[key].trim() === "") {
      throw new Error(`--${key} requires a nonempty value`);
    }
  }
  const logLevel = values.logLevel;
  if (
    logLevel !== undefined &&
    logLevel !== "info" &&
    logLevel !== "warn" &&
    logLevel !== "error" &&
    logLevel !== "silent"
  ) {
    throw new Error("--logLevel must be info, warn, error, or silent");
  }
  const server: InlineConfig["server"] = {
    ...(values.host === undefined ? {} : { host: values.host }),
    ...(values.open === undefined ? {} : { open: values.open || true }),
    ...(values.cors === undefined ? {} : { cors: values.cors }),
  };
  return {
    port: parseMobileDevPort(
      values.port ?? env.MOBILE_WEB_PORT ?? env.PORT,
      DEFAULT_MOBILE_WEB_PORT,
    ),
    config: {
      ...(values.mode === undefined ? {} : { mode: values.mode }),
      ...(Object.keys(server).length === 0 ? {} : { server }),
      ...(values.force === undefined ? {} : { forceOptimizeDeps: values.force }),
      ...(values.base === undefined ? {} : { base: values.base }),
      ...(values.config === undefined ? {} : { configFile: values.config }),
      ...(logLevel === undefined ? {} : { logLevel }),
      ...(values.clearScreen === undefined ? {} : { clearScreen: values.clearScreen }),
    },
    help: values.help ?? false,
  };
}
