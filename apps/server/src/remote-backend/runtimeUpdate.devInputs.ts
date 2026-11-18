/**
 * Owner-private development inputs for runtime updates on a managed backend (F-M3-1).
 *
 * The managed launcher clears the environment, so the laptop's development variables
 * (`BIGBUD_REMOTE_BACKEND_GRAPH_DIR`, `..._GRAPH_TRUSTED_KEYS`,
 * `BIGBUD_REMOTE_AGENT_INSTALL_SOURCE_PATH`) can never reach it. Like the mobile proof inputs, the
 * backend instead reads one owner-private file next to `config-v1`, written by
 * `bigbud backend update-inputs set`:
 *
 *   ~/.bigbud/backend-services/<authority>/runtime-update-dev-inputs-v1
 *   { "schemaVersion": 1, "graphVersionsDirectory": "/abs", "trustedKeys"?: {...},
 *     "installSourcePath"?: "/abs" }
 *
 * A `local-graph` update for version V uses the producer output directory
 * `<graphVersionsDirectory>/<V>/`. The file is read for each request (no restart needed), applies
 * only to `local-graph` updates, and is refused in release mode exactly like the laptop override
 * (`developmentGraphOverridesAllowed`). Release updates keep the GitHub release and release keys.
 */
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import * as Schema from "effect/Schema";

import { decodeBackendSetupTrust } from "../cli/cli.backend.inputs.ts";
import { developmentGraphOverridesAllowed } from "./developmentOverrides.ts";
import {
  assertLocalSupervisorServiceDirectory,
  readLocalSupervisorServiceFile,
} from "./localSupervisorService.files.ts";
import { hasLocalSupervisorServiceControls } from "./localSupervisorService.paths.ts";

export const RUNTIME_UPDATE_DEV_INPUTS_FILE = "runtime-update-dev-inputs-v1";
const MAX_BYTES = 64 * 1024;

export interface RuntimeUpdateDevInputs {
  readonly graphVersionsDirectory: string;
  readonly trustedKeys: Readonly<Record<string, string>>;
  readonly installSourcePath: string | null;
}
export type RuntimeUpdateDevInputsReport =
  | { readonly kind: "absent" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "loaded"; readonly value: RuntimeUpdateDevInputs };

const AbsolutePath = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(4096));
const InputsFile = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  graphVersionsDirectory: AbsolutePath,
  trustedKeys: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  installSourcePath: Schema.optional(AbsolutePath),
});

function absolutePath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || hasLocalSupervisorServiceControls(path))
    throw new Error("Development update input paths must be absolute and normalized.");
  return path;
}

export function runtimeUpdateDevInputsPath(homeDir: string, authorityId: string): string {
  if (!/^[a-f0-9]{32}$/.test(authorityId)) throw new Error("Malformed backend authority.");
  return join(homeDir, ".bigbud/backend-services", authorityId, RUNTIME_UPDATE_DEV_INPUTS_FILE);
}

/** Strict decode: exact fields, absolute normalized paths, pinned Ed25519 public keys only. */
export function decodeRuntimeUpdateDevInputs(text: string): RuntimeUpdateDevInputs {
  const file = Schema.decodeUnknownSync(InputsFile)(JSON.parse(text), {
    onExcessProperty: "error",
  });
  return Object.freeze({
    graphVersionsDirectory: absolutePath(file.graphVersionsDirectory),
    trustedKeys: file.trustedKeys ? decodeBackendSetupTrust(file.trustedKeys) : Object.freeze({}),
    installSourcePath: file.installSourcePath ? absolutePath(file.installSourcePath) : null,
  });
}

export function encodeRuntimeUpdateDevInputs(value: RuntimeUpdateDevInputs): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      graphVersionsDirectory: value.graphVersionsDirectory,
      ...(Object.keys(value.trustedKeys).length ? { trustedKeys: value.trustedKeys } : {}),
      ...(value.installSourcePath ? { installSourcePath: value.installSourcePath } : {}),
    },
    null,
    2,
  )}\n`;
}

/** Absent file is `absent`; release mode, an unsafe location or bad content is `refused`. */
export async function readRuntimeUpdateDevInputs(input: {
  readonly homeDir: string;
  readonly authorityId: string;
  readonly environment: NodeJS.ProcessEnv;
}): Promise<RuntimeUpdateDevInputsReport> {
  let path: string;
  try {
    path = runtimeUpdateDevInputsPath(input.homeDir, input.authorityId);
    await fs.lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") return { kind: "absent" };
    return { kind: "refused", reason: "its location is unsafe" };
  }
  if (!developmentGraphOverridesAllowed(input.environment))
    return { kind: "refused", reason: "development inputs are refused in release builds" };
  try {
    await assertLocalSupervisorServiceDirectory(dirname(path));
    const text = await readLocalSupervisorServiceFile(path, MAX_BYTES);
    return { kind: "loaded", value: decodeRuntimeUpdateDevInputs(text) };
  } catch {
    return { kind: "refused", reason: "the file is unsafe or malformed" };
  }
}
