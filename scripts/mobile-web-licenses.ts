#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { renderThirdPartyNotices } from "./build-remote-backend-graph.notices.ts";
import {
  npmLicenseInventory,
  npmNoticeEntries,
  npmProductionClosure,
} from "./mobile-web-licenses.logic.ts";

const APP = "apps/mobile-web";
const usage =
  "Usage: bun run licenses:mobile-web --output <inventory.json> " +
  "[--notices-output <THIRD_PARTY_NOTICES>]";

/** Writes the licence inventory and notices of the mobile web app's production npm dependency
 * closure, read from the installed workspace (`bun install` first). Outputs must not exist. */
export async function main(argv: ReadonlyArray<string>) {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      output: { type: "string" },
      "notices-output": { type: "string" },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help) return void console.log(usage);
  if (!values.output) throw new Error(usage);
  const workspace = resolve(import.meta.dirname, "..");
  const closure = await npmProductionClosure(workspace, APP);
  const inventory = npmLicenseInventory({
    root: "@bigbud/mobile-web",
    lockfileSha256: createHash("sha256")
      .update(await readFile(join(workspace, "bun.lock")))
      .digest("hex"),
    packages: closure.packages,
  });
  await writeFile(resolve(values.output), `${JSON.stringify(inventory, null, 2)}\n`, {
    flag: "wx",
    mode: 0o644,
  });
  if (values["notices-output"]) {
    const text = await renderThirdPartyNotices(
      "bigbud mobile assets (@bigbud/mobile-web production dependencies): third-party notices",
      npmNoticeEntries(closure),
      (path) => {
        const source = closure.sources.get(path);
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
