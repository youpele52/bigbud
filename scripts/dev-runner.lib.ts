import { homedir } from "node:os";

import {
  DEFAULT_MOBILE_WEB_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_WEB_PORT,
  devPortsForOffset,
} from "@bigbud/shared/DevPorts";
import { NetService } from "@bigbud/shared/Net";
import { Config, Data, Effect, Hash, Option, Path } from "effect";

const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;

export const DEFAULT_BIGBUD_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(homedir(), ".bigbud"),
);

/** @deprecated Use `DEFAULT_BIGBUD_HOME` */
export const DEFAULT_T3_HOME = DEFAULT_BIGBUD_HOME;

export const MODE_ARGS = {
  dev: [
    "run",
    "dev",
    "--ui=tui",
    "--filter=@bigbud/contracts",
    "--filter=@bigbud/web",
    "--filter=@bigbud/server",
  ],
  "dev:server": ["run", "dev", "--filter=@bigbud/server"],
  "dev:web": ["run", "dev", "--filter=@bigbud/web"],
  "dev:mobile-web": ["run", "dev", "--filter=@bigbud/mobile-web"],
  "dev:desktop": ["run", "dev", "--filter=@bigbud/desktop", "--filter=@bigbud/web"],
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

const aliasedOptionalIntegerConfig = (
  primary: string,
  alias: string,
): Config.Config<number | undefined> =>
  Config.all({
    primary: optionalIntegerConfig(primary),
    alias: optionalIntegerConfig(alias),
  }).pipe(Config.map(({ primary, alias }) => primary ?? alias));

const aliasedOptionalStringConfig = (
  primary: string,
  alias: string,
): Config.Config<string | undefined> =>
  Config.all({
    primary: optionalStringConfig(primary),
    alias: optionalStringConfig(alias),
  }).pipe(Config.map(({ primary, alias }) => primary ?? alias));

export const OffsetConfig = Config.all({
  portOffset: aliasedOptionalIntegerConfig("BIGBUD_PORT_OFFSET", "T3CODE_PORT_OFFSET"),
  devInstance: aliasedOptionalStringConfig("BIGBUD_DEV_INSTANCE", "T3CODE_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): { readonly offset: number; readonly source: string } {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      throw new Error(`Invalid BIGBUD_PORT_OFFSET: ${config.portOffset}`);
    }
    return {
      offset: config.portOffset,
      source: `BIGBUD_PORT_OFFSET=${config.portOffset}`,
    };
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return { offset: 0, source: "default ports" };
  }

  if (/^\d+$/.test(seed)) {
    return { offset: Number(seed), source: `numeric BIGBUD_DEV_INSTANCE=${seed}` };
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return { offset, source: `hashed BIGBUD_DEV_INSTANCE=${seed}` };
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_BIGBUD_HOME;
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
    const resolvedServerPort = port ?? devPortsForOffset(serverOffset).serverPort;
    const resolvedWebPort = devPortsForOffset(webOffset).webPort;
    const resolvedMobileWebPort = devPortsForOffset(webOffset).mobileWebPort;
    const resolvedBaseDir = yield* resolveBaseDir(t3Home);
    const isDesktopMode = mode === "dev:desktop";
    const isMobileWebMode = mode === "dev:mobile-web";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(isMobileWebMode ? resolvedMobileWebPort : resolvedWebPort),
      ELECTRON_RENDERER_PORT: String(resolvedWebPort),
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://localhost:${resolvedWebPort}`,
      MOBILE_WEB_PORT: String(resolvedMobileWebPort),
      VITE_MOBILE_WEB_URL: `http://localhost:${resolvedMobileWebPort}`,
      BIGBUD_HOME: resolvedBaseDir,
      T3CODE_HOME: resolvedBaseDir,
    };

    if (!isDesktopMode && !isMobileWebMode) {
      output.BIGBUD_PORT = String(resolvedServerPort);
      output.T3CODE_PORT = String(resolvedServerPort);
      output.VITE_WS_URL = `ws://localhost:${resolvedServerPort}`;
    } else if (isDesktopMode) {
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

    if (!isDesktopMode && !isMobileWebMode && host !== undefined) {
      output.BIGBUD_HOST = host;
      output.T3CODE_HOST = host;
    }

    if (!isDesktopMode && !isMobileWebMode && authToken !== undefined) {
      output.BIGBUD_AUTH_TOKEN = authToken;
      output.T3CODE_AUTH_TOKEN = authToken;
    } else if (!isDesktopMode && !isMobileWebMode) {
      delete output.BIGBUD_AUTH_TOKEN;
      delete output.T3CODE_AUTH_TOKEN;
    }

    if (!isDesktopMode && !isMobileWebMode && noBrowser !== undefined) {
      output.BIGBUD_NO_BROWSER = noBrowser ? "1" : "0";
      output.T3CODE_NO_BROWSER = noBrowser ? "1" : "0";
    } else if (!isDesktopMode && !isMobileWebMode) {
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
  readonly mobileWebPort: number;
} {
  return devPortsForOffset(offset);
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
  readonly requireMobileWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  requireMobileWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort, mobileWebPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;
      const mobileWebPortOutOfRange = mobileWebPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (requireMobileWebPort && mobileWebPortOutOfRange) ||
        (!requireServerPort &&
          !requireWebPort &&
          !requireMobileWebPort &&
          (serverPortOutOfRange || webPortOutOfRange || mobileWebPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) checks.push(checkPort(serverPort));
      if (requireWebPort) checks.push(checkPort(webPort));
      if (requireMobileWebPort) checks.push(checkPort(mobileWebPort));

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerError({
      message: `No available dev ports found from offset ${startOffset}. Tried server=${DEFAULT_SERVER_PORT}+n web=${DEFAULT_WEB_PORT}+n mobile=${DEFAULT_MOBILE_WEB_PORT}+n up to port ${MAX_PORT}.`,
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
        requireMobileWebPort: false,
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
        requireMobileWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    if (mode === "dev:mobile-web") {
      const mobileOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: false,
        requireMobileWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: mobileOffset, webOffset: mobileOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      requireMobileWebPort: true,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}
