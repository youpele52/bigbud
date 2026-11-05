import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import Path from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

it("imports and starts the lightweight SDK over external stdio without either native runtime or koffi", async () => {
  const root = await mkdtemp(Path.join(tmpdir(), "bigbud-copilot-sdk-"));
  try {
    const require = createRequire(import.meta.url);
    const sdkRoot = Path.resolve(Path.dirname(require.resolve("@github/copilot-sdk")), "../..");
    const isolated = Path.join(root, "node_modules", "@github", "copilot-sdk");
    await mkdir(isolated, { recursive: true });
    await cp(Path.join(sdkRoot, "dist"), Path.join(isolated, "dist"), { recursive: true });
    await cp(Path.join(sdkRoot, "package.json"), Path.join(isolated, "package.json"));
    const sdkRequire = createRequire(Path.join(sdkRoot, "package.json"));
    for (const dependency of ["vscode-jsonrpc", "zod"]) {
      await symlink(
        Path.dirname(sdkRequire.resolve(`${dependency}/package.json`)),
        Path.join(root, "node_modules", dependency),
      );
    }
    expect(await readdir(Path.join(root, "node_modules", "@github"))).toEqual(["copilot-sdk"]);
    const fake = Path.join(root, "fake-runtime.js");
    await writeFile(Path.join(root, "package.json"), '{"type":"module"}');
    await writeFile(
      fake,
      `
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node.js";
const connection = createMessageConnection(new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout));
connection.onRequest(() => ({ protocolVersion: 3, version: "fixture", message: "stdio works" }));
process.stdin.on("end", () => process.exit(0));
connection.listen();
`,
    );
    const smoke = Path.join(root, "smoke.mjs");
    await writeFile(
      smoke,
      `
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";
const client = new CopilotClient({ connection: RuntimeConnection.forStdio({ path: ${JSON.stringify(fake)} }) });
try {
  await client.start();
  const result = await client.ping("smoke");
  if (result.message !== "stdio works") throw new Error("External stdio ping failed");
  console.log("external-stdio-ok");
} finally {
  await client.forceStop();
}
`,
    );
    const { stdout } = await promisify(execFile)(process.execPath, [smoke], {
      cwd: root,
      timeout: 15_000,
      env: { ...process.env, NODE_PATH: "", COPILOT_CLI_PATH: "" },
    });
    expect(stdout).toContain("external-stdio-ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
