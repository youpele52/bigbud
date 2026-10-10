import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { Schema } from "effect";
import type { Endpoint } from "@opencode/client/service";
import { validateOwnedEndpoint } from "./Compatibility.ts";
import { V2SharedServiceError } from "./SharedService.errors.ts";

const Registration = Schema.Struct({
  id: Schema.String,
  version: Schema.String,
  url: Schema.String,
  pid: Schema.Number,
  password: Schema.optional(Schema.String),
});

export interface V2SharedRegistration {
  readonly id: string;
  readonly version: string;
  readonly pid: number;
  readonly endpoint: Endpoint;
}

/** Authentication may rotate; logical transport generations are not durable storage or exit proof. */
export function v2SharedGeneration(registration: V2SharedRegistration): string {
  return JSON.stringify([
    registration.id,
    registration.pid,
    registration.version,
    registration.endpoint.url,
  ]);
}

/** Match the native Promise Service registration convention; never create a profile. */
export function v2SharedRegistrationFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(
    env.XDG_STATE_HOME ?? path.join(env.HOME ?? homedir(), ".local", "state"),
    "opencode",
    "service.json",
  );
}

/** Read the native service password only for transport auth, never provider credentials. */
export async function readV2SharedRegistration(file: string): Promise<V2SharedRegistration> {
  if (!path.isAbsolute(file))
    throw new V2SharedServiceError(
      "registration",
      "OpenCode v2 service registration must use an absolute path.",
    );
  let handle;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 16_384 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      throw new Error("Invalid registration file.");
    const buffer = Buffer.alloc(16_385);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16_384) throw new Error("Registration exceeds bound.");
    const decoded = Schema.decodeUnknownSync(Registration)(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
    if (
      !decoded.id ||
      decoded.id.length > 256 ||
      !/^2\.\d+\.\d+$/.test(decoded.version) ||
      !Number.isSafeInteger(decoded.pid) ||
      decoded.pid < 1 ||
      (decoded.password !== undefined && decoded.password.length > 4096)
    )
      throw new Error("Invalid registration metadata.");
    const url = validateOwnedEndpoint(decoded.url);
    return {
      id: decoded.id,
      version: decoded.version,
      pid: decoded.pid,
      endpoint: {
        url,
        ...(decoded.password === undefined
          ? {}
          : {
              auth: { type: "basic", username: "opencode", password: decoded.password },
            }),
      },
    };
  } catch (error) {
    if (error instanceof V2SharedServiceError) throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      throw new V2SharedServiceError(
        "registration",
        "OpenCode v2 shared service is not running. Open the installed V2 TUI or run opencode service start; bigbud does not replace your service.",
      );
    throw new V2SharedServiceError(
      "registration",
      "OpenCode v2 service registration is invalid or not private to this user. Check the native service; bigbud did not modify it.",
    );
  } finally {
    await handle?.close();
  }
}

/** Rotation/replacement during discovery rejects the handshake; auth is never an identity. */
export function sameV2SharedRegistration(
  left: V2SharedRegistration,
  right: V2SharedRegistration,
): boolean {
  return (
    left.id === right.id &&
    left.pid === right.pid &&
    left.version === right.version &&
    left.endpoint.url === right.endpoint.url &&
    left.endpoint.auth?.username === right.endpoint.auth?.username &&
    left.endpoint.auth?.password === right.endpoint.auth?.password
  );
}
