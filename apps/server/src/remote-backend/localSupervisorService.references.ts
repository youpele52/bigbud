import * as fs from "node:fs/promises";
import { join } from "node:path";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { decodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import {
  assertLocalSupervisorServiceDirectory as directory,
  readLocalSupervisorServiceFile as read,
} from "./localSupervisorService.files.ts";
import {
  inspectLocalSupervisorServiceUnits,
  type LocalServiceUnitObservation,
} from "./localSupervisorService.references.manager.ts";
import {
  LOCAL_SERVICE_UNIT_NAME,
  localSupervisorServiceUnitReference,
} from "./localSupervisorService.references.unit.ts";
import {
  parseRemoteAgentRegistry,
  type RemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";

async function entries(path: string, maximum: number): Promise<ReadonlyArray<string>> {
  const result: string[] = [];
  const opened = await fs.opendir(path);
  for await (const entry of opened) {
    result.push(entry.name);
    if (result.length > maximum)
      throw new Error("Service reference directory exceeds its bounded inventory.");
  }
  return result;
}
async function optionalDirectory(path: string, modes?: ReadonlyArray<number>): Promise<boolean> {
  try {
    await directory(path, modes);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
function buildForBinary(
  registry: RemoteAgentRegistry,
  root: string,
  binaryPath: string,
  sha256?: string,
  statePath?: string,
): string {
  const builds = registry.builds.filter(
    (build) =>
      build.runtime.origin === "managed" &&
      build.runtime.binaryPath === binaryPath &&
      build.runtime.binaryPath.startsWith(`${root}/bin/`) &&
      build.runtime.statePath.startsWith(`${root}/runtimes/`) &&
      (sha256 === undefined || build.runtime.sha256 === sha256) &&
      (statePath === undefined || build.runtime.statePath === statePath),
  );
  if (builds.length !== 1 || !builds[0]!.authenticated)
    throw new Error("Service reference does not match a uniquely authenticated managed build.");
  return builds[0]!.id;
}

/** Service references are pruning exclusions, never fabricated PTY/connection pins. */
export function makeLocalSupervisorServiceReferences(input: {
  readonly control: LocalSupervisorControl;
  readonly referencedBuildIds: (target: string) => Promise<ReadonlySet<string>>;
  /** Read-only test seam; production always observes the actual account manager. */
  readonly inspectUnits?: () => Promise<ReadonlyArray<LocalServiceUnitObservation>>;
}) {
  const { control } = input;
  return async (target: string): Promise<ReadonlySet<string>> => {
    if (target !== control.targetId)
      throw new Error("Service references belong to another authority.");
    await directory(control.homeDir, [0o700, 0o750, 0o755]);
    await directory(join(control.homeDir, ".bigbud"), [0o700, 0o755]);
    await directory(control.root);
    const registry = parseRemoteAgentRegistry(
      JSON.stringify(await (await control.openControl(target)).registry.read()),
    );
    const references = new Set(await input.referencedBuildIds(target));
    const configRoot = join(control.homeDir, ".bigbud/backend-services");
    const authorities = new Set<string>();
    if (await optionalDirectory(configRoot)) {
      for (const authority of await entries(configRoot, 64)) {
        if (!/^[a-f0-9]{32}$/.test(authority))
          throw new Error("Unknown service reference namespace.");
        const root = join(configRoot, authority);
        await directory(root);
        for (const name of await entries(root, 16)) {
          if (!["config-v1", "client-token", "artifact-receipt"].includes(name))
            throw new Error(
              "Unknown or unfinished service config publication; preserve all references.",
            );
        }
        const config = decodeLocalSupervisorServiceConfig(
          await read(join(root, "config-v1"), 32 * 1024),
        );
        if (config.authority !== authority || config.home !== control.homeDir)
          throw new Error("Service config belongs to another account or authority.");
        references.add(
          buildForBinary(
            registry,
            control.root,
            config.rust_binary,
            config.rust_sha256,
            config.rust_state,
          ),
        );
        authorities.add(authority);
      }
    }
    const unitRoot = join(control.homeDir, ".config/systemd/user");
    const staged = new Set<string>();
    const parents = [
      join(control.homeDir, ".config"),
      join(control.homeDir, ".config/systemd"),
      unitRoot,
    ];
    for (const parent of parents) {
      if (!(await optionalDirectory(parent, [0o700, 0o750, 0o755]))) break;
      if (parent === unitRoot) {
        for (const name of await entries(unitRoot, 1024)) {
          if (name.startsWith(".bigbud-rust-") || name.startsWith(".bigbud-backend-"))
            throw new Error("Unfinished service unit publication; preserve its launcher.");
          if (!name.startsWith("bigbud-rust-") && !name.startsWith("bigbud-backend-")) continue;
          if (!LOCAL_SERVICE_UNIT_NAME.test(name))
            throw new Error("Unknown staged service unit name.");
          staged.add(name);
        }
      }
    }
    const loaded = await (input.inspectUnits?.() ?? inspectLocalSupervisorServiceUnits(control));
    if (loaded.length > 128) throw new Error("Loaded service reference inventory is oversized.");
    const observed = new Set<string>();
    for (const unit of loaded) {
      if (
        !LOCAL_SERVICE_UNIT_NAME.test(unit.name) ||
        observed.has(unit.name) ||
        unit.fragmentPath !== join(unitRoot, unit.name)
      )
        throw new Error("Loaded service selects an unknown or nonprivate unit definition.");
      observed.add(unit.name);
      staged.add(unit.name);
    }
    if (staged.size > 128) throw new Error("Service reference unit budget exceeded.");
    for (const name of staged) {
      const unit = localSupervisorServiceUnitReference(
        await read(join(unitRoot, name), 64 * 1024),
        name,
        control.homeDir,
      );
      if (!authorities.has(unit.authority))
        throw new Error("Service unit configuration is missing; preserve its launcher.");
      references.add(buildForBinary(registry, control.root, unit.binaryPath));
    }
    return references;
  };
}
