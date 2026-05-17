import { Effect } from "effect";

import { Open } from "../utils/open";
import { ServerConfig } from "./config";

const isWildcardHost = (host: string | undefined): boolean =>
  host === "0.0.0.0" || host === "::" || host === "[::]";

const formatHostForUrl = (host: string): string =>
  host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;

export const maybeOpenBrowser = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  if (serverConfig.noBrowser) {
    return;
  }
  const { openBrowser } = yield* Open;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const target = serverConfig.devUrl?.toString() ?? bindUrl;

  yield* openBrowser(target).pipe(
    Effect.catch(() =>
      Effect.logInfo("browser auto-open unavailable", {
        hint: `Open ${target} in your browser.`,
      }),
    ),
  );
});

export const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );
