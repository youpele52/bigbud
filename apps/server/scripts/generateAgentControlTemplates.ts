import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGENT_CONTROL_TEMPLATE_DIR,
  renderAgentControlTemplates,
} from "../src/remote-agent/remoteAgentControl.templates.ts";

/**
 * U25: write (or with `--check`, verify) the SSH owner's agent-control templates from the
 * legacy remote-agent builders. The owner embeds these files with `include_str!`.
 */
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const directory = path.join(repository, AGENT_CONTROL_TEMPLATE_DIR);
const check = process.argv.includes("--check");
const files = renderAgentControlTemplates();
await mkdir(directory, { recursive: true });
const existing = (await readdir(directory)).filter((name) => name.endsWith(".sh"));
const stale: string[] = existing.filter((name) => !files.has(name));
for (const [name, text] of files) {
  const target = path.join(directory, name);
  const current = await readFile(target, "utf8").catch(() => null);
  if (current === text) continue;
  if (check) stale.push(name);
  else await writeFile(target, text);
}
if (check && stale.length > 0) {
  console.error(`Agent control templates are stale: ${stale.join(", ")}`);
  process.exit(1);
}
if (!check) for (const name of stale) await rm(path.join(directory, name));
console.log(`${files.size} agent control templates ${check ? "verified" : "written"}.`);
