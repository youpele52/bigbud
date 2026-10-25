import { ChildProcess } from "node:child_process";
import path from "node:path";
import {
  requireV2NativeIsolation,
  type V2NativeIsolationApproval,
} from "./SharedService.native.isolation.fixture.ts";
import { readV2SharedRegistration, v2SharedGeneration } from "./SharedService.registration.ts";

interface OwnedRetailChild {
  readonly approval: V2NativeIsolationApproval;
  readonly file: string;
  readonly root: string;
  readonly pid: number;
  readonly generation: string;
}
const children = new WeakMap<ChildProcess, OwnedRetailChild>();

/** Factory-only ticket for an actual approved child and exact registration. Structural native
 * fixture objects, env flags and reported version strings cannot mint candidate execution. */
export async function rememberV2OwnedRetailChild(
  child: ChildProcess,
  approval: V2NativeIsolationApproval,
  file: string,
  root: string,
) {
  const approved = await requireV2NativeIsolation(approval.executablePath, approval.id);
  const registration = await readV2SharedRegistration(file);
  if (
    !(child instanceof ChildProcess) ||
    child.spawnfile !== approved.executablePath ||
    child.spawnargs.join("\0") !==
      [approved.executablePath, "serve", "--service", "--hostname=127.0.0.1", "--port=0"].join(
        "\0",
      ) ||
    child.exitCode !== null ||
    child.signalCode !== null ||
    child.pid !== registration.pid ||
    registration.version !== approved.nativeVersion ||
    !root.startsWith(`${approved.fixtureRoot}${path.sep}`)
  )
    throw new Error("V2 candidate factory child/image/registration scope changed.");
  children.set(
    child,
    Object.freeze({
      approval: approved,
      file,
      root,
      pid: child.pid,
      generation: v2SharedGeneration(registration),
    }),
  );
}

export function readV2OwnedRetailChild(child: ChildProcess) {
  const owned = children.get(child);
  if (!owned || child.pid !== owned.pid || child.exitCode !== null || child.signalCode !== null)
    throw new Error("V2 candidate has no live factory-owned approved retail child ticket.");
  return owned;
}
