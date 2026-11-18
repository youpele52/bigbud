import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import { LOCAL_SERVICE_UNIT_NAME } from "./localSupervisorService.references.unit.ts";
import { USER_SYSTEMCTL, USER_SYSTEMD_BUS_PREAMBLE } from "./userSystemdBus.ts";

export interface LocalServiceUnitObservation {
  readonly name: string;
  readonly fragmentPath: string;
}
const MAX_UNITS = 128;
const BUS = `${USER_SYSTEMD_BUS_PREAMBLE}exec ${USER_SYSTEMCTL} `;

/** Loaded definitions and on-disk names are both required; no unavailable-manager empty fallback. */
export async function inspectLocalSupervisorServiceUnits(
  control: LocalSupervisorControl,
): Promise<ReadonlyArray<LocalServiceUnitObservation>> {
  const run = async (command: string) =>
    (
      await control.run(control.targetId, BUS + command, {
        timeoutMs: 10_000,
        maxBufferBytes: 1024 * 1024,
      })
    ).stdout;
  const names = new Set<string>();
  for (const operation of ["list-units --all --plain", "list-unit-files"]) {
    const output = await run(
      `${operation} --no-legend --full 'bigbud-rust-*.service' 'bigbud-backend-*.service'`,
    );
    for (const line of output.split("\n").filter((value) => value.trim())) {
      const name = line.trim().split(/\s+/)[0]!;
      if (!LOCAL_SERVICE_UNIT_NAME.test(name))
        throw new Error("Unknown account service unit inventory.");
      names.add(name);
      if (names.size > MAX_UNITS)
        throw new Error("Account service unit inventory exceeds its bound.");
    }
  }
  if (names.size === 0) return [];
  // Names were strictly validated above; no caller path, credential or shell fragment is interpolated.
  const output = await run(
    `show ${[...names].toSorted().join(" ")} --property=Id,LoadState,NeedDaemonReload,FragmentPath`,
  );
  const result: LocalServiceUnitObservation[] = [];
  const seen = new Set<string>();
  for (const block of output.trim().split(/\n\n+/)) {
    const values = new Map<string, string>();
    for (const line of block.split("\n")) {
      const split = line.indexOf("=");
      const key = line.slice(0, split);
      if (
        split < 1 ||
        !["Id", "LoadState", "NeedDaemonReload", "FragmentPath"].includes(key) ||
        values.has(key)
      )
        throw new Error("Malformed loaded service unit metadata.");
      values.set(key, line.slice(split + 1));
    }
    const name = values.get("Id");
    const fragmentPath = values.get("FragmentPath");
    if (
      !name ||
      !names.has(name) ||
      seen.has(name) ||
      !fragmentPath ||
      values.size !== 4 ||
      values.get("LoadState") !== "loaded" ||
      values.get("NeedDaemonReload") !== "no"
    )
      throw new Error("Unknown, changed or unresolved loaded service unit metadata.");
    seen.add(name);
    result.push({ name, fragmentPath });
  }
  if (seen.size !== names.size) throw new Error("Loaded account service inventory is incomplete.");
  return result;
}
