#!/usr/bin/env bun
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderThirdPartyNotices } from "./build-remote-backend-graph.notices.ts";
import {
  linkedCrateNoticeEntries,
  rustCrateLicenses,
  rustLicenseInventory,
  type CargoMetadata,
} from "./rust-dependency-licenses.logic.ts";

const usage =
  "Usage: bun run licenses:rust --target <triple> --output <inventory.json> " +
  "[--package bigbud-remote-agent] [--notices-output <THIRD_PARTY_NOTICES>] [--offline]";

/** Writes the license inventory of one workspace crate's dependency closure for one target,
 * using only `cargo metadata` and the crate sources cargo already fetched. Outputs must not
 * exist yet. */
export async function main(argv: ReadonlyArray<string>) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      package: { type: "string", default: "bigbud-remote-agent" },
      target: { type: "string" },
      output: { type: "string" },
      "notices-output": { type: "string" },
      offline: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return void console.log(usage);
  if (!values.target || !/^[a-z0-9_]+(?:-[a-z0-9_]+){2,3}$/.test(values.target) || !values.output)
    throw new Error(usage);
  const workspace = resolve(import.meta.dirname, "..");
  const metadata = JSON.parse(
    execFileSync(
      "cargo",
      [
        "metadata",
        "--format-version",
        "1",
        "--locked",
        "--filter-platform",
        values.target,
        ...(values.offline ? ["--offline"] : []),
      ],
      { cwd: workspace, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  ) as CargoMetadata;
  const { crates, sources } = await rustCrateLicenses(metadata, values.package);
  const inventory = rustLicenseInventory({
    root: values.package,
    target: values.target,
    cargoLockSha256: createHash("sha256")
      .update(await readFile(join(workspace, "Cargo.lock")))
      .digest("hex"),
    crates,
  });
  await writeFile(resolve(values.output), `${JSON.stringify(inventory, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  if (values["notices-output"]) {
    const text = await renderThirdPartyNotices(
      `${values.package} (${values.target}): third-party notices`,
      linkedCrateNoticeEntries(crates),
      (path) => {
        const source = sources.get(path);
        if (!source) throw new Error(`No source recorded for notice file ${path}.`);
        return readFile(source);
      },
    );
    await writeFile(resolve(values["notices-output"]), text, { flag: "wx", mode: 0o644 });
  }
  console.log(JSON.stringify(inventory.summary, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url)
  await main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
