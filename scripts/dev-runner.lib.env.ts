import { devPortsForOffset } from "@bigbud/shared/DevPorts";
import { Effect, Path } from "effect";

import { DEFAULT_BIGBUD_HOME, type DevMode } from "./dev-runner.lib.ts";

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
  readonly instanceOffset?: number;
  readonly repoRoot?: string;
  readonly webReservation?: string;
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
  instanceOffset = 0,
  repoRoot,
  webReservation,
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
    // The mobile listener starts at the requested instance port and retries
    // actual bind collisions itself; preflight cannot select its final port.
    const resolvedMobileWebPort = devPortsForOffset(instanceOffset).mobileWebPort;
    const resolvedBaseDir = yield* resolveBaseDir(t3Home);
    const isDesktopMode = mode === "dev:desktop";
    const isMobileWebMode = mode === "dev:mobile-web";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(isMobileWebMode ? resolvedMobileWebPort : resolvedWebPort),
      ELECTRON_RENDERER_PORT: String(resolvedWebPort),
      VITE_DEV_SERVER_URL: devUrl?.toString() ?? `http://localhost:${resolvedWebPort}`,
      MOBILE_WEB_PORT: String(resolvedMobileWebPort),
      BIGBUD_DEV_INSTANCE_OFFSET: String(instanceOffset),
      BIGBUD_HOME: resolvedBaseDir,
      T3CODE_HOME: resolvedBaseDir,
    };
    delete output.VITE_MOBILE_WEB_URL;
    delete output.BIGBUD_DEV_WEB_PORT;
    delete output.BIGBUD_DEV_REPO_ROOT;
    delete output.BIGBUD_DEV_WEB_RESERVATION;
    if (repoRoot !== undefined) output.BIGBUD_DEV_REPO_ROOT = repoRoot;
    if (webReservation !== undefined) output.BIGBUD_DEV_WEB_RESERVATION = webReservation;
    if (mode === "dev" || mode === "dev:desktop" || mode === "dev:web") {
      output.BIGBUD_DEV_WEB_PORT = String(resolvedWebPort);
    }

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
      output.BIGBUD_REMOTE_AGENT_TRANSPORT =
        output.BIGBUD_REMOTE_AGENT_TRANSPORT?.trim() || "agent";
    }

    return output;
  });
}
