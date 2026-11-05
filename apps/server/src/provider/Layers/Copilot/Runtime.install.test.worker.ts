import { appendFile } from "node:fs/promises";
import Path from "node:path";

import { installCopilotRuntime } from "./Runtime.install.ts";
import { runtimeFixture } from "./Runtime.test.helpers.ts";

const root = process.argv[2];
if (!root) throw new Error("Missing test storage directory");
const fixture = runtimeFixture();
await installCopilotRuntime({
  root,
  release: fixture.release,
  fetch: async () => {
    await appendFile(Path.join(root, "downloads"), "download\n");
    return new Response(fixture.bytes);
  },
});
