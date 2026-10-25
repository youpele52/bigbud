import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ownV2WindowsFixture } from "../apps/server/src/provider/Layers/OpencodeV2/SharedService.windows.fixture.mjs";
import {
  V2_WINDOWS_ACL_PROGRAM,
  v2WindowsPowerShellEnvironment,
} from "../apps/server/src/provider/Layers/OpencodeV2/ProfileIsolation.windows.mjs";

// Diagnostics are restricted to a disposable fixture and its ancestor ACL metadata.
if (process.platform !== "win32") throw new Error("Windows fixture diagnostics only.");
const root = await mkdtemp(path.join(tmpdir(), "bigbud-inspection-diagnostic-"));
try {
  const file = path.join(root, "registration.json");
  await writeFile(file, "fixture");
  await ownV2WindowsFixture(root);
  const helper = spawnSync(
    path.resolve("target/debug/bigbud-remote-agent.exe"),
    ["--inspect-local"],
    {
      input: `HELLO\t1\nREAD\t${Buffer.from(file).toString("hex")}\n`,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
    },
  );
  console.log(
    JSON.stringify({
      root,
      node: process.arch,
      helperStatus: helper.status,
      helperReply: helper.stdout,
      helperError: helper.stderr,
    }),
  );
  const program = spawnSync(
    path.join(process.env.SystemRoot!, "System32/WindowsPowerShell/v1.0/powershell.exe"),
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(V2_WINDOWS_ACL_PROGRAM, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ root }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      env: v2WindowsPowerShellEnvironment(),
    },
  );
  console.log(
    JSON.stringify({
      aclStatus: program.status,
      aclError: program.stderr,
      aclSnapshot: program.stdout,
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
