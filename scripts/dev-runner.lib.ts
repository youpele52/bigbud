import { homedir } from "node:os";

import { NetService } from "@bigbud/shared/Net";
import { Config, Data, Effect, Hash, Option, Path } from "effect";

const BASE_SERVER_PORT = 3773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;

export const DEFAULT_T3_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(homedir(), ".bigbud"),
);

export const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@bigbud/contracts",
    "--filter=@bigbud/web",
    "--filter=@bigbud/server",
    "--parallel",
  ],
  "dev:server": ["run", "dev", "--filter=@bigbud/server"],
  "dev:web": ["run", "dev", "--filter=@bigbud/web"],
  "dev:desktop": ["run", "dev", "--filter=@bigbud/desktop", "--filter=@bigbud/web", "--parallel"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type DevMode = keyof typeof MODE_ARGS;
export type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

export const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export class DevRunnerError extends Data.TaggedError("DevRunnerError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const optionalUrlConfig = (name: string): Config.Config<URL | undefined> =>
  Config.url(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("T3CODE_PORT_OFFSET"),
  devInstance: optionalStringConfig("T3CODE_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid T3CODE_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `T3CODE_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric T3CODE_DEV_INSTANCE=${seed}` };
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_T3_HOME;
  });
}

export interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly t3Home: string | undefined;
  readonly authToken: string | undefined;
  readonly noBrowser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  t3Home,
  authToken,
  noBrowser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const resolvedBaseDir = yield* resolveBaseDir(t3Home);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      ELECTRON_RENDERER_PORT: String(webPort),
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://localhost:${webPort}`,
      BIGBUD_HOME: resolvedBaseDir,
      T3CODE_HOME: resolvedBaseDir,
    };

    if (!isDesktopMode) {
      output.BIGBUD_PORT = String(serverPort);
      output.T3CODE_PORT = String(serverPort);
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      delete output.BIGBUD_PORT;
      delete output.T3CODE_PORT;
      delete output.VITE_WS_URL;
      delete output.BIGBUD_AUTH_TOKEN;
      delete output.T3CODE_AUTH_TOKEN;
      delete output.BIGBUD_MODE;
      delete output.T3CODE_MODE;
      delete output.BIGBUD_NO_BROWSER;
      delete output.T3CODE_NO_BROWSER;
      delete output.BIGBUD_HOST;
      delete output.T3CODE_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.BIGBUD_HOST = host;
      output.T3CODE_HOST = host;
    }

    if (!isDesktopMode && authToken !== undefined) {
      output.BIGBUD_AUTH_TOKEN = authToken;
      output.T3CODE_AUTH_TOKEN = authToken;
    } else if (!isDesktopMode) {
      delete output.BIGBUD_AUTH_TOKEN;
      delete output.T3CODE_AUTH_TOKEN;
    }

    if (!isDesktopMode && noBrowser !== undefined) {
      output.BIGBUD_NO_BROWSER = noBrowser ? "1" : "0";
      output.T3CODE_NO_BROWSER = noBrowser ? "1" : "0";
    } else if (!isDesktopMode) {
      delete output.BIGBUD_NO_BROWSER;
      delete output.T3CODE_NO_BROWSER;
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
      output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.BIGBUD_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
      delete output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.BIGBUD_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
      output.T3CODE_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.BIGBUD_LOG_WS_EVENTS;
      delete output.T3CODE_LOG_WS_EVENTS;
    }

    if (mode === "dev" || mode === "dev:server" || mode === "dev:web") {
      output.BIGBUD_MODE = "web";
      output.T3CODE_MODE = "web";
      delete output.BIGBUD_DESKTOP_WS_URL;
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      delete output.BIGBUD_DESKTOP_WS_URL;
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService;
    return yield* net.isPortAvailableOnLoopback(port);
  });

export interface FindFirstAvailableOffsetInput<R = NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) checks.push(checkPort(serverPort));
      if (requireWebPort) checks.push(checkPort(webPort));

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${BASE_SERVER_PORT}+n web=${BASE_WEB_PORT}+n up to port ${MAX_PORT}.`,
    });
  });
}

export interface ResolveModePortOffsetsInput<R = NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}
