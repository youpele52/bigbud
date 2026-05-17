import * as FS from "node:fs";
import * as Path from "node:path";

import { protocol } from "electron";

import {
  isStaticAssetRequest,
  resolveDesktopStaticDir,
  resolveDesktopStaticPath,
} from "./env/pathResolver";

export function registerDesktopSchemeAsPrivileged(desktopScheme: string): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: desktopScheme,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // Required for navigator.mediaDevices.getUserMedia to work on the custom
        // protocol origin in production builds (otherwise Chrome treats the origin
        // as non-streaming and rejects media device requests).
        stream: true,
      },
    },
  ]);
}

export interface RegisterDesktopProtocolOptions {
  readonly desktopScheme: string;
  readonly isDevelopment: boolean;
  readonly isRegistered: boolean;
  readonly rootDir: string;
}

export function registerDesktopProtocol(options: RegisterDesktopProtocolOptions): boolean {
  if (options.isDevelopment || options.isRegistered) {
    return options.isRegistered;
  }

  const staticRoot = resolveDesktopStaticDir(options.rootDir);
  if (!staticRoot) {
    throw new Error(
      "Desktop static bundle missing. Build apps/server (with bundled client) first.",
    );
  }

  const staticRootResolved = Path.resolve(staticRoot);
  const staticRootPrefix = `${staticRootResolved}${Path.sep}`;
  const fallbackIndex = Path.join(staticRootResolved, "index.html");

  protocol.registerFileProtocol(options.desktopScheme, (request, callback) => {
    try {
      const candidate = resolveDesktopStaticPath(staticRootResolved, request.url);
      const resolvedCandidate = Path.resolve(candidate);
      const isInRoot =
        resolvedCandidate === fallbackIndex || resolvedCandidate.startsWith(staticRootPrefix);
      const isAssetRequest = isStaticAssetRequest(request.url);

      if (!isInRoot || !FS.existsSync(resolvedCandidate)) {
        if (isAssetRequest) {
          callback({ error: -6 });
          return;
        }
        callback({ path: fallbackIndex });
        return;
      }

      callback({ path: resolvedCandidate });
    } catch {
      callback({ path: fallbackIndex });
    }
  });

  return true;
}
