/**
 * The backend account unit as seen from the running backend (M3 WP-4D).
 *
 * Activation never starts a second launcher. It rewrites only the graph pins of the existing
 * private service config (node, entry, receipt) to a staged archive entry, then asks systemd to
 * restart the backend unit. The unit's ExecStart is the fenced Rust launcher
 * (`--backend-service run <config> backend`), which revalidates config, receipt and the whole
 * graph before Node starts. The independent Rust unit is never named, so its terminals keep
 * their processes.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

import {
  encodeLocalSupervisorServiceConfig,
  type LocalSupervisorServiceConfig,
} from "./localSupervisorService.config.ts";
import { readLocalSupervisorServiceConfig } from "./localSupervisorService.config.read.ts";
import { readLocalSupervisorServiceFile } from "./localSupervisorService.files.ts";
import type { RuntimeArchiveEntry } from "./runtimeArchive.store.ts";
import { replacePrivateFile } from "./runtimeUpdate.journal.ts";

const STAGED_RECEIPT = "artifact-receipt";
const STAGED_PINS = "activation-v1.json";

/** Graph pins recorded next to a staged entry while its original verification token exists. */
export interface StagedGraphPins {
  readonly receiptSha256: string;
  readonly nodePath: string;
  readonly nodeSha256: string;
  readonly entryPath: string;
  readonly entrySha256: string;
}

const sha256 = (raw: string) => createHash("sha256").update(raw).digest("hex");

export async function writeStagedGraphPins(
  entryRoot: string,
  receipt: StagedGraphPins & { readonly raw: string },
) {
  const { raw, ...pins } = receipt;
  await replacePrivateFile(join(entryRoot, STAGED_RECEIPT), raw, entryRoot);
  await replacePrivateFile(join(entryRoot, STAGED_PINS), `${JSON.stringify(pins)}\n`, entryRoot);
}

/** The staged receipt and pins, cross-checked against the store's own entry record. */
export async function readStagedGraphPins(entry: RuntimeArchiveEntry) {
  const entryRoot = dirname(entry.graphRoot);
  const raw = await readLocalSupervisorServiceFile(join(entryRoot, STAGED_RECEIPT), 16 << 20);
  const pins = JSON.parse(
    await readLocalSupervisorServiceFile(join(entryRoot, STAGED_PINS), 16 * 1024),
  ) as StagedGraphPins;
  if (
    pins.receiptSha256 !== sha256(raw) ||
    pins.nodeSha256 !== entry.nodeSha256 ||
    pins.entrySha256 !== entry.entrySha256 ||
    !pins.nodePath.startsWith(`${entry.graphRoot}/`) ||
    !pins.entryPath.startsWith(`${entry.graphRoot}/`)
  )
    throw new Error("The staged runtime's receipt does not match its archive entry.");
  return { raw, pins };
}

export interface RuntimeUpdateServiceUnit {
  /** Refuses unless this process runs inside the managed backend unit of this authority. */
  readonly assertManaged: () => Promise<void>;
  readonly read: () => Promise<{ readonly config: string; readonly receipt: string }>;
  /** Points the backend unit at a staged graph (receipt first, then config). */
  readonly pointAt: (receipt: string, pins: StagedGraphPins) => Promise<void>;
  /** Restores the exact previous config and receipt. */
  readonly restore: (config: string, receipt: string) => Promise<void>;
  /** Asks systemd to restart only the backend unit; returns once the job is queued. */
  readonly restart: () => Promise<void>;
}

export function makeRuntimeUpdateServiceUnit(input: {
  readonly homeDir: string;
  readonly authorityId: string;
  /** Test seam for the systemd call; defaults to execFile with a bounded timeout. */
  readonly exec?: (file: string, args: ReadonlyArray<string>) => Promise<void>;
}): RuntimeUpdateServiceUnit {
  const exec =
    input.exec ??
    (async (file: string, args: ReadonlyArray<string>) => {
      await promisify(execFile)(file, [...args], { timeout: 15_000 });
    });
  const configDir = join(input.homeDir, ".bigbud/backend-services", input.authorityId);
  const configPath = join(configDir, "config-v1");
  const receiptPath = join(configDir, STAGED_RECEIPT);
  const unitName = `bigbud-backend-${input.authorityId}.service`;
  const readConfig = () =>
    readLocalSupervisorServiceConfig({
      homeDir: input.homeDir,
      configPath,
      authorityId: input.authorityId,
    });
  const write = async (config: string, receipt: string) => {
    await replacePrivateFile(receiptPath, receipt, configDir);
    await replacePrivateFile(configPath, config, configDir);
  };
  return {
    assertManaged: async () => {
      const cgroup = await fs.readFile("/proc/self/cgroup", "utf8").catch(() => "");
      if (!cgroup.split("\n").some((line) => line.endsWith(`/${unitName}`)))
        throw new Error(
          "Runtime updates need the backend to run as its managed account service; this backend was started another way.",
        );
      await readConfig();
    },
    read: async () => ({
      config: (await readConfig()).raw,
      receipt: await readLocalSupervisorServiceFile(receiptPath, 16 << 20),
    }),
    pointAt: async (receipt, pins) => {
      const { config } = await readConfig();
      const next: LocalSupervisorServiceConfig = {
        ...config,
        node_binary: pins.nodePath,
        node_sha256: pins.nodeSha256,
        backend_entry: pins.entryPath,
        backend_sha256: pins.entrySha256,
        receipt_sha256: pins.receiptSha256,
      };
      await write(encodeLocalSupervisorServiceConfig(next), receipt);
    },
    restore: (config, receipt) => write(config, receipt),
    restart: async () => {
      await exec("/usr/bin/systemctl", [
        "--user",
        "--no-pager",
        "--no-ask-password",
        "--no-block",
        "restart",
        unitName,
      ]);
    },
  };
}
