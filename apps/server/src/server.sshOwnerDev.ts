import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER,
  isDevSshOwnerProfile,
} from "@bigbud/shared/DevLauncher";
import path from "node:path";
import type { ServerConfigShape } from "./startup/config.ts";
import { activateDevSshOwner } from "./ssh/sshOwnerDevMode.ts";
import { developmentGraphOverridesAllowed } from "./remote-backend/developmentOverrides.ts";

/** The Bun dev entry and Electron dev bundle are beside the checkout's server source. */
export function configureDevSshOwner(config: ServerConfigShape, entryUrl: string) {
  if (process.env.BIGBUD_SSH_OWNER !== "1" || !developmentGraphOverridesAllowed(process.env))
    return;
  if (!existsSync(new URL("../src/bin.ts", entryUrl))) {
    throw new Error("The Rust SSH owner development build must run from the source checkout.");
  }
  const profile = process.env.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
  const binary = process.env.BIGBUD_SSH_OWNER_BIN;
  if (
    config.mode === "remote" ||
    (config.host !== undefined && config.host !== "127.0.0.1") ||
    !config.devUrl ||
    !["127.0.0.1", "localhost"].includes(config.devUrl.hostname) ||
    !profile ||
    !isDevSshOwnerProfile(profile, process.platform, tmpdir()) ||
    (process.platform === "win32" &&
      !existsSync(path.join(profile, DEV_SSH_OWNER_WINDOWS_FIXTURE_MARKER))) ||
    profile !== config.baseDir ||
    config.stateDir !== path.join(profile, "dev") ||
    !binary ||
    !path.isAbsolute(binary)
  ) {
    throw new Error(
      "Rust SSH owner selection requires an isolated development profile and its platform fixture.",
    );
  }
  activateDevSshOwner();
}
