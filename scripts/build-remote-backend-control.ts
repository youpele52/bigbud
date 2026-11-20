#!/usr/bin/env node
// Experimental offline control only. No runtime installation, activation or publication.
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectClosure,
  hashFile,
  isWithin,
  parsePins,
  portableEntries,
  type ControlPins,
} from "./lib/remote-backend-control/closure.ts";
import { runArchive } from "./lib/remote-backend-control/archive.ts";
import { verifyExtractedClosure } from "./lib/remote-backend-control/verify.ts";

export async function buildRemoteBackendControl(input: {
  baselineRoot: string;
  outputRoot: string;
  pins: ControlPins;
}) {
  const baseline = await realpath(input.baselineRoot);
  const pins = parsePins(input.pins);
  const output = join(
    await realpath(dirname(resolve(input.outputRoot))),
    basename(input.outputRoot),
  );
  if (isWithin(baseline, output) || isWithin(output, baseline)) {
    throw new Error("Output must be separate from protected baseline evidence.");
  }
  const { entries, installedBytes } = await collectClosure(baseline, pins);
  // Exclusive creation protects both prior evidence and concurrent recipe runs.
  await mkdir(output, { mode: 0o700 });
  const archive = join(output, "full-backend-control.tar.gz");
  const tooling = runArchive({ action: "create", entries, archive });
  const extracted = join(output, "extracted");
  runArchive({ action: "extract", entries, archive, destination: extracted });
  await verifyExtractedClosure(extracted, entries);
  // Detect input drift before claiming success, including bytes not affected by the overlay.
  const after = await collectClosure(baseline, pins);
  if (JSON.stringify(portableEntries(entries)) !== JSON.stringify(portableEntries(after.entries))) {
    throw new Error("Baseline closure changed during packaging.");
  }
  const provenance = {
    schemaVersion: 1,
    purpose: "experimental-full-backend-control",
    shippingAcceptance: false,
    linuxRuntimeSmoke: "not-run",
    licenseReview: "not-performed; package lock and license files retained",
    inputPins: pins,
    overlay: "Bullseye-built node-pty addon replaces the Bookworm addon",
    tooling,
    installedBytes,
    archive: {
      name: basename(archive),
      sizeBytes: (await stat(archive)).size,
      sha256: await hashFile(archive),
    },
    extractionVerified: true,
    entries: portableEntries(entries),
  };
  await writeFile(join(output, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return { output, archive: provenance.archive, installedBytes, entries: entries.length };
}

async function main() {
  const args = process.argv.slice(2);
  if (
    args.length !== 6 ||
    args[0] !== "--baseline" ||
    args[2] !== "--pins" ||
    args[4] !== "--output"
  ) {
    throw new Error(
      "Experimental control: --baseline <protected-root> --pins <five-SHA256-json> --output <new-directory>. Requires Python 3; never installs or runs package code.",
    );
  }
  const result = await buildRemoteBackendControl({
    baselineRoot: args[1]!,
    pins: parsePins(JSON.parse(await readFile(args[3]!, "utf8"))),
    outputRoot: args[5]!,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
